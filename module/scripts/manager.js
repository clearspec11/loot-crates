/*
  The GM's workbench: pools (what can drop), boxes (what's for sale), and the
  pull log (who got what, with Refund). Reached from Game Settings, or
  game.modules.get("loot-crates").api.openManager().

  Deliberately plain for v0.1: lists with Add, Edit (a form dialog), Delete,
  a drop target on each pool, and a bulk "Add from compendium" filter.

  A pool takes a dropped item at once. A dropped Items folder, compendium or
  roll table, and the bulk filter, first show a preview (store.js
  entriesFromDrop): how many items, by rarity, what was skipped (already in
  the pool, spells and other non-loot), the first names; nothing is written
  until Add.

  Every render checks each entry against its source (store.js checkSources).
  An entry whose source is gone is struck through with "Source missing" and
  takes a dropped item to relink it (same weight); one whose source changed
  name or rarity shows "was <old name>" with Update. Both sort to the top of
  their pool, and the Boxes tab's odds leave the missing ones out.
*/
import { RARITIES, RARITY_LABEL, DEFAULT_WEIGHTS, DEFAULT_PRICE_GP } from "./config.js";
import { oddsPills } from "./boxcard.js";
import { getPools, getBoxes, getLog, createPool, updatePool, removePool, createBox, updateBox, removeBox, entryFromItem, entriesFromDrop, addEntries, packHasLoot, LOOT_TYPES, isLootType, isShopOpen, setShopOpen, enqueueWrite, checkSources, refreshMissing, removeEntry, patchEntry } from "./store.js";
import { shopOdds, normalizeRarity, flattenPool, sourceStatus, withSources } from "./odds.js";
import { formatPrice } from "./currency.js";
import { refreshShop } from "./shop.js";
import { describeRefund, refundPull } from "./refund.js";
import { postRefundCard } from "./chat.js";

const { ApplicationV2, DialogV2 } = foundry.applications.api;
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
const dragData = event => (foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor).getDragEventData(event);

export class CrateManager extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "loot-crates-manager",
    classes: ["loot-crates", "lc-manager"],
    window: { title: "Loot Crates", resizable: true },
    position: { width: 760, height: 620 },
    actions: {
      tab: CrateManager.#tab,
      addPool: CrateManager.#addPool, editPool: CrateManager.#editPool, deletePool: CrateManager.#deletePool,
      bulkAdd: CrateManager.#bulkAdd, removeEntry: CrateManager.#removeEntry, updateEntry: CrateManager.#updateEntry, relinkEntry: CrateManager.#relinkEntry,
      addBox: CrateManager.#addBox, editBox: CrateManager.#editBox, deleteBox: CrateManager.#deleteBox,
      refund: CrateManager.#refund, toggleShop: CrateManager.#toggleShop,
    },
  };

  tab = "pools";

  // The last finished source check, so a render never waits long on a cold
  // compendium index (a first getIndex can take seconds): after a short wait
  // it shows what it has (or the stored missing flags) and renders again
  // when the check lands.
  #sources = null;
  checking = false;
  async #checkedSources(entries) {
    const run = checkSources(entries, { rarity: true });
    const got = await Promise.race([run, new Promise(r => setTimeout(() => r(null), 400))]);
    if (got) { this.checking = false; return (this.#sources = got); }
    this.checking = true;
    run.then(found => { this.#sources = found; this.checking = false; if (this.rendered) this.render(); })
      .catch(err => { this.checking = false; console.error(`loot-crates | checking pool sources failed`, err); });
    return this.#sources ?? new Map(entries.map(e => [e.uuid, e.missing ? null : { name: e.name, img: e.img, rarity: null }]));
  }

  static #tab(_e, t) { this.tab = t.dataset.tab; this.render(); }

  static async #addPool() { await createPool({ name: "New pool" }); this.render(); }

  static async #editPool(_e, t) {
    const pool = getPools()[t.dataset.pool];
    const data = await promptForm("Edit pool", `<label>Name <input name="name" value="${esc(pool.name)}"></label>`);
    if (data) { await updatePool(pool.id, { name: data.name || pool.name }); this.render(); refreshShop(); }
  }

  static async #deletePool(_e, t) {
    const pool = getPools()[t.dataset.pool];
    if (await DialogV2.confirm({ window: { title: "Delete pool" }, content: `<p>Delete <strong>${esc(pool.name)}</strong>? Boxes that use it keep their other pools.</p>` })) {
      await removePool(pool.id); this.render(); refreshShop();
    }
  }

  static async #removeEntry(_e, t) {
    await removeEntry(t.dataset.pool, t.dataset.uuid);
    this.render(); refreshShop();
  }

  // Renamed at the source: take its current name, image and rarity.
  static async #updateEntry(_e, t) {
    const src = (await checkSources([{ uuid: t.dataset.uuid }], { rarity: true })).get(t.dataset.uuid);
    if (src === undefined) return ui.notifications.warn("Couldn't read that item's compendium just now; try again.");
    if (!src) { ui.notifications.warn("That item's source is gone; drop an item on the row to relink it."); return this.render(); }
    await patchEntry(t.dataset.pool, t.dataset.uuid, { name: src.name, img: src.img, rarity: src.rarity });
    this.render(); refreshShop();
  }

  // Relink without dragging (keyboard, screen reader, touch): paste the
  // UUID of the item that replaces a missing source.
  static async #relinkEntry(_e, t) {
    const entry = getPools()[t.dataset.pool]?.entries?.find(e => e.uuid === t.dataset.uuid);
    if (!entry) return this.render();
    const data = await promptForm(`Relink ${entry.name}`, `
      <p>The source of <strong>${esc(entry.name)}</strong> is gone. Paste the UUID of the item that replaces it; its weight stays.</p>
      <label>Item UUID <input name="uuid" required placeholder="Compendium.dnd5e.items.Item.…" autocomplete="off"></label>
      <p class="lc-form__hint">Copy it from an item sheet's ID button, or drag the item onto the row instead.</p>`);
    if (data?.uuid) await this.#relink(t.dataset.pool, t.dataset.uuid, String(data.uuid).trim());
  }

  // Only packs and types that can hold loot are offered: a pool should never
  // fill up with spells or class features.
  static async #bulkAdd(_e, t) {
    const pool = getPools()[t.dataset.pool];
    const packs = game.packs.filter(packHasLoot);
    if (!packs.length) return ui.notifications.warn("No compendium holds weapons, equipment, consumables, tools, loot or containers.");
    const types = LOOT_TYPES.filter(k => k in (CONFIG.Item.typeLabels ?? {}));
    const data = await promptForm("Add from compendium", `
      <label>Compendium <select name="pack">${packs.map(p => `<option value="${esc(p.collection)}">${esc(p.metadata.label)} (${esc(p.collection)})</option>`).join("")}</select></label>
      <label>Types <select name="types" multiple size="5">${types.map(k => `<option value="${esc(k)}" ${["weapon", "equipment", "consumable", "tool"].includes(k) ? "selected" : ""}>${esc(game.i18n.localize(CONFIG.Item.typeLabels[k]))}</option>`).join("")}</select></label>
      <label>Rarities <select name="rarities" multiple size="6">${RARITIES.map(r => `<option value="${r}" ${r === "common" ? "" : "selected"}>${RARITY_LABEL[r]}</option>`).join("")}</select></label>
      <label>Name contains <input name="name" placeholder="wand"></label>`);
    if (!data) return;
    const filter = { types: data.types, rarities: data.rarities, name: data.name };
    const plan = await entriesFromDrop({ type: "Compendium", collection: data.pack, filter }, { known: pool.entries.map(e => e.uuid) });
    if (plan) await this.#previewAdd(pool.id, plan);
  }

  // The preview before a folder, compendium, table or filter goes in.
  async #previewAdd(poolId, plan) {
    const pool = getPools()[poolId];
    const n = plan.entries.length;
    const skipped = describeSkipped(plan.skipped);
    if (!n) {
      ui.notifications.info(`Nothing to add to ${pool.name} from ${plan.label}${skipped.length ? `: ${skipped.join("; ")}` : ""}.`);
      return false;
    }
    const counts = {};
    for (const e of plan.entries) counts[normalizeRarity(e.rarity)] = (counts[normalizeRarity(e.rarity)] ?? 0) + 1;
    const shown = plan.entries.slice(0, PREVIEW_ROWS);
    const items = `${n} item${n === 1 ? "" : "s"}`;
    const action = await DialogV2.wait({
      window: { title: `Add to ${pool.name}` },
      classes: ["loot-crates", "lc-dialog"],
      position: { width: 460 },
      content: `<div class="lc-preview">
        <p class="lc-preview__lead">Add <strong>${items}</strong> from <strong>${esc(plan.label)}</strong> to <strong>${esc(pool.name)}</strong>.</p>
        <p class="lc-preview__rarities" aria-label="By rarity">${RARITIES.filter(r => counts[r]).map(r => `<span class="lc-odd lc-rarity-${r}">${counts[r]} ${RARITY_LABEL[r].toLowerCase()}</span>`).join("")}</p>
        ${skipped.length ? `<ul class="lc-preview__skipped">${skipped.map(line => `<li>${esc(line)}</li>`).join("")}</ul>` : ""}
        <ul class="lc-preview__list">${shown.map(e => `<li class="lc-entry lc-rarity-${normalizeRarity(e.rarity)}"><img src="${esc(e.img || FALLBACK_IMG)}" alt=""><span class="lc-entry__name">${esc(e.name)}</span>${e.weight > 1 ? `<small class="lc-preview__weight">weight ${esc(e.weight)}</small>` : ""}<em>${RARITY_LABEL[normalizeRarity(e.rarity)]}</em></li>`).join("")}</ul>
        ${n > shown.length ? `<p class="lc-preview__more">and ${n - shown.length} more</p>` : ""}
      </div>`,
      buttons: [
        { action: "add", label: `Add ${items}`, icon: "fas fa-plus", default: true },
        { action: "cancel", label: "Cancel" },
      ],
      rejectClose: false,
    });
    if (action !== "add") return false;
    const added = await addEntries(poolId, plan.entries);
    ui.notifications.info(`Added ${added} item${added === 1 ? "" : "s"} from ${plan.label} to ${pool.name}.`);
    this.render(); refreshShop();
    return true;
  }

  static async #addBox() { await createBox({ name: "New box", price: DEFAULT_PRICE_GP, weights: { ...DEFAULT_WEIGHTS } }); this.render(); refreshShop(); }

  static async #editBox(_e, t) {
    const box = getBoxes()[t.dataset.box];
    const pools = Object.values(getPools());
    const shares = Object.fromEntries((box.pools ?? []).map(p => [p.id, p.share ?? 1]));
    const data = await promptForm("Edit box", `
      <label>Name <input name="name" value="${esc(box.name)}"></label>
      <label>Price (gp) <input name="price" type="number" min="0" step="1" value="${esc(box.price)}"></label>
      <fieldset><legend>Pools and their share of pulls</legend>
        ${pools.map(p => `<label class="lc-row"><input type="checkbox" name="pool.${esc(p.id)}" ${p.id in shares ? "checked" : ""}> ${esc(p.name)} <input name="share.${esc(p.id)}" type="number" min="0" step="1" value="${esc(shares[p.id] ?? 1)}" title="Share"></label>`).join("") || "<p>No pools yet.</p>"}
      </fieldset>
      <fieldset><legend>Rarity weights</legend>
        ${RARITIES.map(r => `<label class="lc-row">${RARITY_LABEL[r]} <input name="w.${r}" type="number" min="0" step="1" value="${esc(box.weights?.[r] ?? DEFAULT_WEIGHTS[r])}"></label>`).join("")}
      </fieldset>
      <fieldset><legend>Rules</legend>
        <label class="lc-row">Pity: guarantee <select name="pityRarity"><option value="">off</option>${RARITIES.map(r => `<option value="${r}" ${box.rules?.pity?.minRarity === r ? "selected" : ""}>${RARITY_LABEL[r]} or better</option>`).join("")}</select> after <input name="pityAfter" type="number" min="1" step="1" value="${esc(box.rules?.pity?.after ?? 10)}"> pulls</label>
        <label class="lc-row"><input type="checkbox" name="noDuplicates" ${box.rules?.noDuplicates ? "checked" : ""}> No duplicates per character</label>
        <label class="lc-row">Stock (blank for unlimited) <input name="stock" type="number" min="0" step="1" value="${box.rules?.stock ?? ""}"></label>
      </fieldset>`);
    if (!data) return;
    // Stock moves while the dialog is open (each pull takes one, a refund
    // puts one back), so the form's stock only wins if the GM changed it.
    const shownStock = box.rules?.stock ?? null;
    const formStock = data.stock === "" || data.stock == null ? null : Math.max(0, Number(data.stock) || 0);
    const chosen = pools.filter(p => data[`pool.${p.id}`]).map(p => ({ id: p.id, share: Math.max(0, Number(data[`share.${p.id}`]) || 0) }));
    const saved = await updateBox(box.id, fresh => {
      const live = getPools();
      return {
        ...fresh,
        name: data.name || fresh.name,
        price: Math.max(0, Number(data.price) || 0),
        pools: chosen.filter(ref => ref.id in live),
        weights: Object.fromEntries(RARITIES.map(r => [r, Math.max(0, Number(data[`w.${r}`]) || 0)])),
        rules: {
          ...fresh.rules,
          pity: data.pityRarity ? { minRarity: data.pityRarity, after: Math.max(1, Number(data.pityAfter) || 1) } : null,
          noDuplicates: !!data.noDuplicates,
          stock: formStock === shownStock ? (fresh.rules?.stock ?? null) : formStock,
        },
      };
    });
    if (!saved) ui.notifications.warn(`${box.name} was deleted while you were editing it.`);
    this.render(); refreshShop();
  }

  static async #deleteBox(_e, t) {
    const box = getBoxes()[t.dataset.box];
    if (await DialogV2.confirm({ window: { title: "Delete box" }, content: `<p>Delete <strong>${esc(box.name)}</strong>?</p>` })) {
      await removeBox(box.id); this.render(); refreshShop();
    }
  }

  static async #refund(_e, t) {
    const plan = describeRefund(t.dataset.row);
    if (plan.status === "already") { ui.notifications.info("That pull was already refunded."); return this.render(); }
    if (plan.status !== "ready") return ui.notifications.warn(plan.message);
    const { row, actor, item, box } = plan;
    const itemLine = item
      ? `and remove <strong>${esc(item.name)}</strong> from their inventory`
      : `(<strong>${esc(row.name)}</strong> is no longer in their inventory, so nothing is removed)`;
    const stockLine = box?.rules?.stock != null ? ` ${esc(box.name)} goes back to ${box.rules.stock + 1} in stock.` : "";
    const ok = await DialogV2.confirm({
      window: { title: "Refund" },
      content: `<p>Return <strong>${esc(formatPrice(row.price))}</strong> to ${esc(actor.name)} ${itemLine}?${stockLine}</p><p>A pull can only be refunded once.</p>`,
    });
    if (!ok) return;
    const done = await refundPull(row.id);
    if (done.status === "refunded") {
      const what = done.removedItem ? ` and ${done.removedItem} removed` : "";
      ui.notifications.info(`${formatPrice(row.price)} returned to ${actor.name}${what}.`);
      await postRefundCard({ row, actor, removedItem: done.removedItem });
    } else if (done.status === "already") {
      ui.notifications.info("That pull was already refunded.");
    } else {
      ui.notifications.warn(done.message);
    }
    this.render(); refreshShop();
  }

  static async #toggleShop() { await setShopOpen(!isShopOpen()); this.render(); refreshShop(); }

  async _renderHTML() {
    const root = document.createElement("div");
    root.className = "lc-manager__body";
    const tabs = [["pools", "Pools"], ["boxes", "Boxes"], ["log", "Pull log"]];
    root.innerHTML = `
      <nav class="lc-tabs">${tabs.map(([k, l]) => `<button type="button" data-action="tab" data-tab="${k}" class="${k === this.tab ? "active" : ""}">${l}</button>`).join("")}
        <span class="lc-tabs__spacer"></span>
        <button type="button" data-action="toggleShop" class="lc-shop-toggle">${isShopOpen() ? "Shop is open" : "Shop is closed"}</button>
      </nav>
      <section class="lc-tab">${await this[`_${this.tab}`]()}</section>`;
    root.querySelectorAll("[data-drop-pool]").forEach(el => {
      el.addEventListener("dragover", e => { e.preventDefault(); el.classList.add("lc-drop--over"); });
      el.addEventListener("dragleave", () => el.classList.remove("lc-drop--over"));
      el.addEventListener("drop", e => { el.classList.remove("lc-drop--over"); this.#onDrop(e, el.dataset.dropPool); });
    });
    root.querySelectorAll("[data-relink]").forEach(el => {
      el.addEventListener("dragover", e => { e.preventDefault(); e.stopPropagation(); el.classList.add("lc-drop--over"); });
      el.addEventListener("dragleave", () => el.classList.remove("lc-drop--over"));
      el.addEventListener("drop", e => { e.stopPropagation(); this.#onRelink(e, el.dataset.pool, el.dataset.relink); });
    });
    return root;
  }

  // One item goes straight in; a folder, compendium or roll table is
  // previewed first.
  async #onDrop(event, poolId) {
    event.preventDefault();
    let data;
    try { data = dragData(event); } catch { return; }
    const pool = getPools()[poolId];
    if (!pool) return;
    const plan = await entriesFromDrop(data, { known: pool.entries.map(e => e.uuid) });
    if (!plan) return ui.notifications.warn("Drop an item, an Items folder, an item compendium or a roll table.");
    if (data.type !== "Item") return this.#previewAdd(poolId, plan);
    if (!plan.entries.length) {
      if (plan.skipped.duplicates) return ui.notifications.info(`${plan.label} is already in ${pool.name}.`);
      const type = Object.keys(plan.skipped.notLoot)[0];
      return ui.notifications.warn(`${plan.label} is a ${SKIPPED_NAMES[type]?.[0] ?? type}, not loot. A pool takes weapons, equipment, consumables, tools, loot and containers.`);
    }
    if (await addEntries(poolId, plan.entries)) { this.render(); refreshShop(); }
  }

  // An item dropped on a missing row replaces its source; the weight stays.
  async #onRelink(event, poolId, uuid) {
    event.preventDefault();
    let data;
    try { data = dragData(event); } catch { return; }
    if (data?.type !== "Item" || !data.uuid) return ui.notifications.warn("Drop an item to relink this entry.");
    return this.#relink(poolId, uuid, data.uuid);
  }

  async #relink(poolId, uuid, newUuid) {
    let item = null;
    try { item = await fromUuid(newUuid); } catch { /* reported below */ }
    if (item?.documentName !== "Item") return ui.notifications.warn(`No item has the UUID ${newUuid}.`);
    if (!isLootType(item.type)) return ui.notifications.warn(`${item.name} is not loot. A pool takes weapons, equipment, consumables, tools, loot and containers.`);
    const { name, img, rarity } = entryFromItem(item);
    const done = await patchEntry(poolId, uuid, { uuid: item.uuid, name, img, rarity });
    if (!done) ui.notifications.info(`${item.name} is already in ${getPools()[poolId]?.name ?? "that pool"}; remove the missing entry instead.`);
    this.render(); refreshShop();
  }

  async _pools() {
    const pools = Object.values(getPools());
    const sources = await this.#checkedSources(pools.flatMap(p => p.entries ?? []));
    // The editor just looked: if a flag the shop reads is stale, sweep now.
    const stale = !this.checking && pools.some(p => p.entries.some(e => sources.has(e.uuid) && !!e.missing !== !sources.get(e.uuid)));
    if (stale) {
      enqueueWrite(() => refreshMissing(pools.map(p => p.id)))
        .then(() => refreshShop())
        .catch(err => console.error(`loot-crates | checking pools for missing items failed`, err));
    }
    return `
      <div class="lc-toolbar"><button type="button" data-action="addPool"><i class="fas fa-plus"></i> New pool</button>${this.checking ? `<span class="lc-pool__hint" role="status">Checking each item against its source…</span>` : ""}</div>
      ${pools.length ? pools.map(p => {
        // An entry the check couldn't answer for shows its stored flag.
        const srcOf = e => (sources.has(e.uuid) ? sources.get(e.uuid) : e.missing ? null : { name: e.name, img: e.img, rarity: null });
        const rows = p.entries.map(e => ({ e, src: srcOf(e), status: sourceStatus(e, srcOf(e)) }));
        const order = { missing: 0, renamed: 1, ok: 2 };
        rows.sort((a, b) => order[a.status] - order[b.status]);
        const missing = rows.filter(r => r.status === "missing").length;
        const renamed = rows.filter(r => r.status === "renamed").length;
        const live = rows.filter(r => r.status !== "missing").map(r => r.e);
        const problems = [missing && `${missing} missing`, renamed && `${renamed} renamed`].filter(Boolean).join(", ");
        return `
        <article class="lc-pool" data-drop-pool="${esc(p.id)}">
          <header>
            <strong>${esc(p.name)}</strong>
            <span class="lc-pool__count">${p.entries.length} item${p.entries.length === 1 ? "" : "s"}${live.length ? " · " + rarityCounts(live) : ""}${problems ? ` · <span class="lc-pool__problems">${problems}</span>` : ""}</span>
            <span class="lc-tabs__spacer"></span>
            <button type="button" data-action="bulkAdd" data-pool="${esc(p.id)}" title="Add every item in a compendium that matches a filter"><i class="fas fa-book"></i> Add from compendium</button>
            <button type="button" data-action="editPool" data-pool="${esc(p.id)}" aria-label="Rename ${esc(p.name)}"><i class="fas fa-pen"></i></button>
            <button type="button" data-action="deletePool" data-pool="${esc(p.id)}" aria-label="Delete ${esc(p.name)}"><i class="fas fa-trash"></i></button>
          </header>
          <p class="lc-pool__hint">Drop items, an Items folder, a compendium or a roll table here.${missing ? " Drop an item on a missing row to relink it." : ""}</p>
          <ul class="lc-entries">${rows.map(r => entryRow(p.id, r)).join("")}</ul>
        </article>`;
      }).join("") : `<p class="lc-empty">No pools. A pool is the set of items a box can give out.</p>`}`;
  }

  async _boxes() {
    const boxes = Object.values(getBoxes());
    const stored = getPools();
    // The odds as of now, not as of the last pull's sweep.
    const entries = Object.keys(stored).flatMap(id => flattenPool(id, stored, new Set(), { includeMissing: true }));
    const pools = withSources(stored, await this.#checkedSources(entries));
    return `
      <div class="lc-toolbar"><button type="button" data-action="addBox"><i class="fas fa-plus"></i> New box</button></div>
      ${boxes.length ? `<table class="lc-table"><thead><tr><th>Box</th><th>Price</th><th>Pools</th><th>Odds</th><th>Rules</th><th></th></tr></thead><tbody>
        ${boxes.map(b => `<tr>
          <td>${esc(b.name)}</td><td>${esc(formatPrice(b.price))}</td>
          <td>${(b.pools ?? []).map(r => esc(pools[r.id]?.name ?? "missing")).join(", ") || "<em>none</em>"}</td>
          <td class="lc-odds">${oddsPills(shopOdds(b, pools).rows) || "<em>empty</em>"}</td>
          <td>${[b.rules?.pity ? `pity ${b.rules.pity.after}` : "", b.rules?.noDuplicates ? "no dupes" : "", b.rules?.stock != null ? `${b.rules.stock} left` : ""].filter(Boolean).join(", ")}</td>
          <td><button type="button" data-action="editBox" data-box="${esc(b.id)}"><i class="fas fa-pen"></i></button> <button type="button" data-action="deleteBox" data-box="${esc(b.id)}"><i class="fas fa-trash"></i></button></td>
        </tr>`).join("")}</tbody></table>` : `<p class="lc-empty">No boxes. A box prices a pull from one or more pools.</p>`}`;
  }

  _log() {
    const log = getLog();
    if (!log.length) return `<p class="lc-empty">No pulls yet.</p>`;
    return `<table class="lc-table"><thead><tr><th>When</th><th>Who</th><th>Box</th><th>Got</th><th></th></tr></thead><tbody>
      ${log.map(r => `<tr class="${r.refunded ? "lc-row--refunded" : ""}">
        <td>${new Date(r.at).toLocaleString()}</td><td>${esc(r.actorName)}</td><td>${esc(r.boxName)} (${esc(formatPrice(r.price))})</td>
        <td class="lc-rarity-${esc(r.rarity)}"><span class="lc-dot"></span>${esc(r.name)}${r.pity ? " · pity" : ""}</td>
        <td>${r.refunded ? "refunded" : `<button type="button" data-action="refund" data-row="${esc(r.id)}">Refund</button>`}</td>
      </tr>`).join("")}</tbody></table>`;
  }

  _replaceHTML(result, content) { content.replaceChildren(result); }
}

const FALLBACK_IMG = "icons/svg/item-bag.svg";
const PREVIEW_ROWS = 50;

const SKIPPED_NAMES = { spell: ["spell", "spells"], feat: ["feature", "features"], class: ["class", "classes"], subclass: ["subclass", "subclasses"], background: ["background", "backgrounds"], race: ["species", "species"], facility: ["facility", "facilities"] };
// "14 already in this pool, skipped", "3 spells and 2 features skipped (not loot)".
function describeSkipped({ duplicates = 0, notLoot = {}, notItems = 0 } = {}) {
  const lines = [];
  if (duplicates) lines.push(`${duplicates} already in this pool, skipped`);
  const kinds = Object.entries(notLoot).map(([type, n]) => `${n} ${(SKIPPED_NAMES[type] ?? [type, `${type}s`])[n === 1 ? 0 : 1]}`);
  if (kinds.length) lines.push(`${kinds.join(", ")} skipped, not loot`);
  if (notItems) lines.push(`${notItems} table result${notItems === 1 ? "" : "s"} that ${notItems === 1 ? "isn't an item" : "aren't items"}, skipped`);
  return lines;
}

// One pool entry. `status` is "ok", "renamed" (the source's name or rarity
// changed since it was added) or "missing" (the source is gone).
// The rarity shown is the entry's own, since that is what the box draws it at.
function entryRow(poolId, { e, src, status }) {
  const rarity = normalizeRarity(e.rarity);
  const name = status === "renamed" ? src.name : e.name;
  const ids = `data-pool="${esc(poolId)}" data-uuid="${esc(e.uuid)}"`;
  const remove = `<button type="button" class="lc-entry__remove" data-action="removeEntry" ${ids} aria-label="Remove ${esc(name)}" title="Remove">&times;</button>`;
  if (status === "missing") {
    return `<li class="lc-entry lc-entry--missing lc-rarity-${rarity}" data-pool="${esc(poolId)}" data-relink="${esc(e.uuid)}" title="Drop an item here to relink it">
      <img src="${esc(e.img || FALLBACK_IMG)}" alt="">
      <span class="lc-entry__text"><span class="lc-entry__name">${esc(e.name)}</span><small class="lc-entry__status">Source missing, not drawn. Drop an item here to relink.</small></span>
      <button type="button" class="lc-entry__update" data-action="relinkEntry" ${ids} aria-label="Relink ${esc(e.name)}">Relink</button>
      ${remove}</li>`;
  }
  if (status === "renamed") {
    const was = [src.name !== e.name ? `was ${e.name}` : "", src.rarity != null && normalizeRarity(src.rarity) !== rarity ? `now ${RARITY_LABEL[normalizeRarity(src.rarity)]} at the source` : ""].filter(Boolean).join(" · ");
    return `<li class="lc-entry lc-entry--renamed lc-rarity-${rarity}">
      <img src="${esc(src.img || e.img || FALLBACK_IMG)}" alt="">
      <span class="lc-entry__text"><span class="lc-entry__name">${esc(name)}</span><small class="lc-entry__status">${esc(was)}</small></span>
      <em>${RARITY_LABEL[rarity]}</em>
      <button type="button" class="lc-entry__update" data-action="updateEntry" ${ids} aria-label="Update ${esc(e.name)} to ${esc(name)}">Update</button>
      ${remove}</li>`;
  }
  return `<li class="lc-entry lc-rarity-${rarity}"><img src="${esc(e.img || FALLBACK_IMG)}" alt=""><span class="lc-entry__name">${esc(name)}</span><em>${RARITY_LABEL[rarity]}</em>${remove}</li>`;
}

function rarityCounts(entries) {
  const n = {};
  for (const e of entries) n[normalizeRarity(e.rarity)] = (n[normalizeRarity(e.rarity)] ?? 0) + 1;
  return RARITIES.filter(r => n[r]).map(r => `${n[r]} ${RARITY_LABEL[r].toLowerCase()}`).join(", ");
}

// A small form in a DialogV2; resolves to the form's values or null.
async function promptForm(title, fieldsHtml) {
  return DialogV2.wait({
    window: { title },
    classes: ["loot-crates", "lc-dialog"],
    content: `<form class="lc-form">${fieldsHtml}</form>`,
    buttons: [
      { action: "ok", label: "Save", default: true, callback: (_e, button) => {
        const form = button.form ?? button.closest("dialog")?.querySelector("form");
        const fd = new FormData(form);
        const out = {};
        for (const [k, v] of fd.entries()) {
          if (k in out) out[k] = [].concat(out[k], v);
          else out[k] = v;
        }
        for (const sel of form.querySelectorAll("select[multiple]")) out[sel.name] = [...sel.selectedOptions].map(o => o.value);
        for (const cb of form.querySelectorAll("input[type=checkbox]")) out[cb.name] = cb.checked;
        return out;
      } },
      { action: "cancel", label: "Cancel", callback: () => null },
    ],
    rejectClose: false,
  });
}

let manager = null;
export function openManager() {
  manager ??= new CrateManager();
  manager.render({ force: true });
  return manager;
}
