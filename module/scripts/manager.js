/*
  The GM's workbench: pools (what can drop), boxes (what's for sale), and the
  pull log (who got what, with Refund). Reached from Game Settings, or
  game.modules.get("loot-crates").api.openManager().

  Deliberately plain for v0.1: lists with Add, Edit (a form dialog), Delete,
  a drop target on each pool for items dragged from anywhere, and a bulk
  "Add from compendium" filter.
*/
import { RARITIES, RARITY_LABEL, DEFAULT_WEIGHTS, DEFAULT_PRICE_GP } from "./config.js";
import { getPools, getBoxes, getLog, savePool, deletePool, saveBox, deleteBox, entryFromItem, entriesFromCompendium, updateLog, isShopOpen, setShopOpen } from "./store.js";
import { oddsTable, normalizeRarity } from "./odds.js";
import { formatPrice } from "./currency.js";
import { refreshShop } from "./shop.js";

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
      bulkAdd: CrateManager.#bulkAdd, removeEntry: CrateManager.#removeEntry,
      addBox: CrateManager.#addBox, editBox: CrateManager.#editBox, deleteBox: CrateManager.#deleteBox,
      refund: CrateManager.#refund, toggleShop: CrateManager.#toggleShop,
    },
  };

  tab = "pools";

  static #tab(_e, t) { this.tab = t.dataset.tab; this.render(); }

  static async #addPool() { await savePool({ name: "New pool" }); this.render(); }

  static async #editPool(_e, t) {
    const pool = getPools()[t.dataset.pool];
    const data = await promptForm("Edit pool", `<label>Name <input name="name" value="${esc(pool.name)}"></label>`);
    if (data) { await savePool({ ...pool, name: data.name || pool.name }); this.render(); }
  }

  static async #deletePool(_e, t) {
    const pool = getPools()[t.dataset.pool];
    if (await DialogV2.confirm({ window: { title: "Delete pool" }, content: `<p>Delete <strong>${esc(pool.name)}</strong>? Boxes that use it keep their other pools.</p>` })) {
      await deletePool(pool.id); this.render(); refreshShop();
    }
  }

  static async #removeEntry(_e, t) {
    const pool = getPools()[t.dataset.pool];
    pool.entries = pool.entries.filter(e => e.uuid !== t.dataset.uuid);
    await savePool(pool); this.render();
  }

  static async #bulkAdd(_e, t) {
    const pool = getPools()[t.dataset.pool];
    const packs = game.packs.filter(p => p.documentName === "Item");
    const types = Object.keys(CONFIG.Item.typeLabels ?? {}).filter(k => k !== "base");
    const data = await promptForm("Add from compendium", `
      <label>Compendium <select name="pack">${packs.map(p => `<option value="${esc(p.collection)}">${esc(p.metadata.label)} (${esc(p.collection)})</option>`).join("")}</select></label>
      <label>Types <select name="types" multiple size="5">${types.map(k => `<option value="${esc(k)}" ${["weapon", "equipment", "consumable", "tool"].includes(k) ? "selected" : ""}>${esc(game.i18n.localize(CONFIG.Item.typeLabels[k]))}</option>`).join("")}</select></label>
      <label>Rarities <select name="rarities" multiple size="6">${RARITIES.map(r => `<option value="${r}" ${r === "common" ? "" : "selected"}>${RARITY_LABEL[r]}</option>`).join("")}</select></label>
      <label>Name contains <input name="name" placeholder="wand"></label>`);
    if (!data) return;
    const found = await entriesFromCompendium(data.pack, { types: data.types, rarities: data.rarities, name: data.name });
    const known = new Set(pool.entries.map(e => e.uuid));
    const fresh = found.filter(e => !known.has(e.uuid));
    pool.entries.push(...fresh);
    await savePool(pool);
    ui.notifications.info(`Added ${fresh.length} item${fresh.length === 1 ? "" : "s"} to ${pool.name}.`);
    this.render();
  }

  static async #addBox() { await saveBox({ name: "New box", price: DEFAULT_PRICE_GP, weights: { ...DEFAULT_WEIGHTS } }); this.render(); refreshShop(); }

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
    const next = {
      ...box,
      name: data.name || box.name,
      price: Math.max(0, Number(data.price) || 0),
      pools: pools.filter(p => data[`pool.${p.id}`]).map(p => ({ id: p.id, share: Math.max(0, Number(data[`share.${p.id}`]) || 0) })),
      weights: Object.fromEntries(RARITIES.map(r => [r, Math.max(0, Number(data[`w.${r}`]) || 0)])),
      rules: {
        pity: data.pityRarity ? { minRarity: data.pityRarity, after: Math.max(1, Number(data.pityAfter) || 1) } : null,
        noDuplicates: !!data.noDuplicates,
        stock: data.stock === "" || data.stock == null ? null : Math.max(0, Number(data.stock) || 0),
      },
    };
    await saveBox(next); this.render(); refreshShop();
  }

  static async #deleteBox(_e, t) {
    const box = getBoxes()[t.dataset.box];
    if (await DialogV2.confirm({ window: { title: "Delete box" }, content: `<p>Delete <strong>${esc(box.name)}</strong>?</p>` })) {
      await deleteBox(box.id); this.render(); refreshShop();
    }
  }

  static async #refund(_e, t) {
    const row = getLog().find(r => r.id === t.dataset.row);
    const actor = game.actors.get(row?.actorId);
    if (!row || !actor) return ui.notifications.warn("That character is gone.");
    const item = row.itemId ? actor.items.get(row.itemId) : null;
    const ok = await DialogV2.confirm({ window: { title: "Refund" }, content: `<p>Return ${esc(formatPrice(row.price))} to ${esc(actor.name)}${item ? ` and remove <strong>${esc(item.name)}</strong>` : " (the item is already gone)"}?</p>` });
    if (!ok) return;
    const purse = foundry.utils.deepClone(actor.system.currency);
    purse.gp = (purse.gp ?? 0) + row.price;
    await actor.update({ "system.currency": purse });
    if (item) await item.delete();
    await updateLog(row.id, { refunded: Date.now() });
    this.render();
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
      <section class="lc-tab">${this[`_${this.tab}`]()}</section>`;
    root.querySelectorAll("[data-drop-pool]").forEach(el => {
      el.addEventListener("dragover", e => { e.preventDefault(); el.classList.add("lc-drop--over"); });
      el.addEventListener("dragleave", () => el.classList.remove("lc-drop--over"));
      el.addEventListener("drop", e => this.#onDrop(e, el.dataset.dropPool));
    });
    return root;
  }

  async #onDrop(event, poolId) {
    event.preventDefault();
    let data;
    try { data = dragData(event); } catch { return; }
    if (data?.type !== "Item" || !data.uuid) return ui.notifications.warn("Drop an item.");
    const item = await fromUuid(data.uuid);
    if (!item) return;
    const pool = getPools()[poolId];
    if (pool.entries.some(e => e.uuid === item.uuid)) return ui.notifications.info(`${item.name} is already in ${pool.name}.`);
    pool.entries.push(entryFromItem(item));
    await savePool(pool);
    this.render();
  }

  _pools() {
    const pools = Object.values(getPools());
    return `
      <div class="lc-toolbar"><button type="button" data-action="addPool"><i class="fas fa-plus"></i> New pool</button></div>
      ${pools.length ? pools.map(p => `
        <article class="lc-pool" data-drop-pool="${esc(p.id)}">
          <header>
            <strong>${esc(p.name)}</strong>
            <span class="lc-pool__count">${p.entries.length} item${p.entries.length === 1 ? "" : "s"}${p.entries.length ? " · " + rarityCounts(p.entries) : ""}</span>
            <span class="lc-tabs__spacer"></span>
            <button type="button" data-action="bulkAdd" data-pool="${esc(p.id)}" title="Add every item in a compendium that matches a filter"><i class="fas fa-book"></i> Add from compendium</button>
            <button type="button" data-action="editPool" data-pool="${esc(p.id)}"><i class="fas fa-pen"></i></button>
            <button type="button" data-action="deletePool" data-pool="${esc(p.id)}"><i class="fas fa-trash"></i></button>
          </header>
          <p class="lc-pool__hint">Drag items here from a compendium or the Items sidebar.</p>
          <ul class="lc-entries">${p.entries.map(e => `<li class="lc-entry lc-rarity-${normalizeRarity(e.rarity)}"><img src="${esc(e.img)}" alt=""><span>${esc(e.name)}</span><em>${RARITY_LABEL[normalizeRarity(e.rarity)]}</em><button type="button" data-action="removeEntry" data-pool="${esc(p.id)}" data-uuid="${esc(e.uuid)}" title="Remove">&times;</button></li>`).join("")}</ul>
        </article>`).join("") : `<p class="lc-empty">No pools. A pool is the set of items a box can give out.</p>`}`;
  }

  _boxes() {
    const boxes = Object.values(getBoxes());
    const pools = getPools();
    return `
      <div class="lc-toolbar"><button type="button" data-action="addBox"><i class="fas fa-plus"></i> New box</button></div>
      ${boxes.length ? `<table class="lc-table"><thead><tr><th>Box</th><th>Price</th><th>Pools</th><th>Odds</th><th>Rules</th><th></th></tr></thead><tbody>
        ${boxes.map(b => `<tr>
          <td>${esc(b.name)}</td><td>${esc(formatPrice(b.price))}</td>
          <td>${(b.pools ?? []).map(r => esc(pools[r.id]?.name ?? "missing")).join(", ") || "<em>none</em>"}</td>
          <td class="lc-odds">${oddsTable(b, pools).map(o => `<span class="lc-odd lc-rarity-${o.rarity}" title="${RARITY_LABEL[o.rarity]}">${Math.round(o.chance * 100)}%</span>`).join("") || "<em>empty</em>"}</td>
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
