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

  Each live entry's rarity and weight are edited in place: a select of
  dnd5e's rarities (the source's own marked "from source"; picking it drops
  the override) and a whole-number weight (0 never drops). An entry whose
  source has no rarity says so instead of passing as Common, and a pool with
  any offers "Set rarity for unset items". An edit saves through updatePool
  in the write queue and updates only its row and its pool's census, so
  focus stays where the GM is typing.

  A big pool is a craft table (poolview.js draws it): each pool is a
  <details> whose summary keeps the census in view while collapsed, and one
  of more than 60 entries starts collapsed. An open pool draws 50 rows at a
  time with "Show 50 more", a name search, and the census as filter chips.
  Each pool's open state, search, chip and rows shown live on this window
  (#view) and survive a re-render; a search, a chip, Show more, Update,
  Remove, Relink and the bulk rarity redraw only that pool and keep focus
  near where it was. One status line in the toolbar speaks for them all.

  A drop says where it went: the new rows are pinned at the top of their
  pool (opened, and its chip and search cleared if they would hide one),
  focus goes to the first one's rarity select, and the status line and a
  toast name it ("Flame Tongue added to Core magic items, Rare, at the
  top."). A single item already in the pool is pinned the same way. The pin
  is view state only and goes at the next drop or when the manager closes.

  The box editor shows the chances a player will see (the shop's ribbon and
  pills) for the form as it stands, redrawn on every keystroke, tick and
  untick, and says when the box would drop nothing (liveOdds below).
*/
import { RARITIES, RARITY_LABEL, DEFAULT_WEIGHTS, DEFAULT_PRICE_GP, SETTINGS } from "./config.js";
import { oddsPills, oddsRibbon, draftBox, boxPreview, boxPreviewHTML, oddsSummary, quietAnnouncer } from "./boxcard.js";

// A box's odds in the Boxes table: its ribbon over its named pills.
const oddsCell = rows => rows.length ? `${oddsRibbon(rows)}<div class="lc-odds">${oddsPills(rows)}</div>` : "<em>empty</em>";
import { getPools, getBoxes, getLog, createPool, updatePool, removePool, createBox, updateBox, removeBox, entryFromItem, entriesFromDrop, addEntries, packHasLoot, LOOT_TYPES, isLootType, isShopOpen, setShopOpen, checkSources, sweepPools, removeEntry, patchEntry } from "./store.js";
import { shopOdds, normalizeRarity, flattenPool, withSources, entryWeight, curateEntries } from "./odds.js";
import { PAGE_ROWS, FALLBACK_IMG, defaultView, poolRows, sortRows, filterRows, pageRows, nextRows, poolCount, poolSummary, poolBody, chipsHTML, unsetButton, footHTML, entryRow, entryParts, pinRecent, dropNotice } from "./poolview.js";
import { formatPrice } from "./currency.js";
import { describeRefund, refundPull } from "./refund.js";
import { postRefundCard } from "./chat.js";
import { refundTime } from "./chatcard.js";
import { changeCount } from "./redraw.js";

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
      // Not "tab": ApplicationV2 sends that action to its own changeTab,
      // which throws without a data-group (test/actions.test.js).
      switchTab: CrateManager.#switchTab,
      addPool: CrateManager.#addPool, editPool: CrateManager.#editPool, deletePool: CrateManager.#deletePool,
      bulkAdd: CrateManager.#bulkAdd, setUnsetRarity: CrateManager.#setUnsetRarity, removeEntry: CrateManager.#removeEntry, updateEntry: CrateManager.#updateEntry, relinkEntry: CrateManager.#relinkEntry,
      addBox: CrateManager.#addBox, editBox: CrateManager.#editBox, deleteBox: CrateManager.#deleteBox,
      refund: CrateManager.#refund, toggleShop: CrateManager.#toggleShop,
      filterChip: CrateManager.#filterChip, showMore: CrateManager.#showMore,
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
    const run = checkSources(entries);
    const got = await Promise.race([run, new Promise(r => setTimeout(() => r(null), 400))]);
    if (got) { this.checking = false; return (this.#sources = got); }
    this.checking = true;
    run.then(found => { this.#sources = found; this.checking = false; if (this.rendered) this.render(); })
      .catch(err => { this.checking = false; console.error(`loot-crates | checking pool sources failed`, err); });
    return this.#sources ?? new Map(entries.map(e => [e.uuid, e.missing ? null : { name: e.name, img: e.img, rarity: null }]));
  }

  static #switchTab(_e, t) { this.tab = t.dataset.tab; this.render(); }

  // Each pool's view: open, name search, filter chip, rows shown.
  #view = new Map();
  #viewOf(pool) {
    let v = this.#view.get(pool.id);
    if (!v) this.#view.set(pool.id, (v = defaultView(pool)));
    return v;
  }
  #rowsOf(pool) { return sortRows(poolRows(pool, e => this.#srcOf(e)), this.#viewOf(pool).recent); }
  #poolEl(poolId) { return this.element?.querySelector(`.lc-pool[data-drop-pool="${CSS.escape(poolId)}"]`) ?? null; }
  #announce(text) {
    const el = this.element?.querySelector(".lc-manager__status");
    if (el) el.textContent = text;
  }

  // An open pool's whole body, drawn again from the stored pool, with focus
  // put back near where it was: on the row `uuid`, else the row now at
  // index `at` (or the one before it), else the pool's search or summary.
  // Falls back to a full render when the pool isn't on screen.
  #repaint(poolId, { uuid = null, at = null, scroll = false } = {}) {
    const el = this.#poolEl(poolId);
    const pool = getPools()[poolId];
    if (!el || !pool) return this.render();
    this.#fillBody(el, pool);
    const list = el.querySelector(".lc-entries");
    const li = (uuid && list?.querySelector(`[data-entry="${CSS.escape(uuid)}"]`))
      || (at != null && (list?.children[at] ?? list?.children[at - 1]));
    const target = li?.querySelector("select, input, button") ?? el.querySelector(".lc-pool__search") ?? el.querySelector("summary");
    target?.focus(scroll ? { preventScroll: true } : undefined);
    if (scroll) (li || target)?.scrollIntoView?.({ block: "nearest" });
  }

  /*
    Show what a drop put in (or found already in) a pool: pin `uuids` at the
    top of its first page, open it, clear a chip or search that would hide
    them, focus the first, and say so in the status line and a toast. Any
    earlier pin, on any pool, goes.
  */
  #pinDrop(poolId, uuids, { label = "", added = uuids.length, duplicate = false } = {}) {
    const pool = getPools()[poolId];
    if (!pool || !uuids.length) return this.render();
    for (const [id, v] of this.#view) {
      if (id === poolId || !v.recent?.length) continue;
      v.recent = [];
      const el = this.#poolEl(id);
      const other = getPools()[id];
      if (el && other) this.#fillBody(el, other);
    }
    const { view, cleared } = pinRecent(this.#viewOf(pool), poolRows(pool, e => this.#srcOf(e)), uuids);
    this.#view.set(poolId, view);
    const rows = this.#rowsOf(pool).filter(r => r.recent);
    const text = dropNotice({ pool, rows, label, added, duplicate, cleared });
    const details = this.#poolEl(poolId)?.querySelector(".lc-pool__details");
    if (details) details.open = true;
    this.#repaint(poolId, { uuid: view.recent[0], scroll: true });
    this.#announce(text);
    ui.notifications.info(text);
  }

  // Closing the manager lets go of every pin.
  async _onClose(options) {
    for (const v of this.#view.values()) v.recent = [];
    return super._onClose?.(options);
  }

  #fillBody(el, pool) {
    const rows = this.#rowsOf(pool);
    el.querySelector(".lc-pool__count").innerHTML = poolCount(pool, rows);
    const details = el.querySelector(".lc-pool__details");
    const body = el.querySelector(".lc-pool__body");
    if (!details?.open) { body?.replaceChildren(); return; }
    body.innerHTML = poolBody(pool, rows, this.#viewOf(pool), esc);
    this.#wireRelinks(body);
  }

  // The chips again (their counts follow edits), focus kept on the pressed one.
  #paintChips(el, pool, rows) {
    const box = el.querySelector(".lc-pool__chips");
    if (!box) return;
    const had = box.contains(document.activeElement) ? document.activeElement.dataset.chip : null;
    box.innerHTML = chipsHTML(pool, rows, this.#viewOf(pool), esc);
    if (had) box.querySelector(`[data-chip="${CSS.escape(had)}"]`)?.focus();
  }

  // A search or chip changed: redraw this pool's rows from the first page.
  #refilter(poolId) {
    const el = this.#poolEl(poolId);
    const pool = getPools()[poolId];
    const list = el?.querySelector(".lc-entries");
    if (!pool || !list) return this.render();
    const rows = this.#rowsOf(pool);
    const view = this.#viewOf(pool);
    view.shown = PAGE_ROWS;
    this.#paintChips(el, pool, rows);
    const matched = filterRows(rows, view);
    const page = pageRows(matched, view.shown);
    list.innerHTML = page.rows.map(r => entryRow(pool.id, r, esc)).join("");
    this.#wireRelinks(list);
    el.querySelector(".lc-pool__foot").innerHTML = footHTML(pool, rows, matched, page, esc);
    el.querySelector(".lc-pool__unset").innerHTML = unsetButton(pool, matched, view, esc);
    const narrowed = view.q.trim() || view.chip;
    this.#announce(narrowed ? `${matched.length} of ${rows.length} items in ${pool.name} match.` : `Filter cleared in ${pool.name}.`);
  }

  static #filterChip(_e, t) {
    const pool = getPools()[t.dataset.pool];
    if (!pool) return this.render();
    const view = this.#viewOf(pool);
    view.chip = view.chip === t.dataset.chip ? null : t.dataset.chip;
    this.#refilter(pool.id);
  }

  // The next 50 matching rows, appended; focus goes to the first new one.
  static #showMore(_e, t) {
    const el = this.#poolEl(t.dataset.pool);
    const pool = getPools()[t.dataset.pool];
    const list = el?.querySelector(".lc-entries");
    if (!pool || !list) return this.render();
    const view = this.#viewOf(pool);
    const rows = this.#rowsOf(pool);
    const matched = filterRows(rows, view);
    const page = nextRows(matched, [...list.children].map(li => li.dataset.entry));
    const before = list.childElementCount;
    list.insertAdjacentHTML("beforeend", page.rows.map(r => entryRow(pool.id, r, esc)).join(""));
    this.#wireRelinks(list);
    view.shown = list.childElementCount;
    el.querySelector(".lc-pool__foot").innerHTML = footHTML(pool, rows, matched, page, esc);
    list.children[before]?.querySelector("select, input, button")?.focus();
    this.#announce(`Showing ${list.childElementCount} of ${matched.length} in ${pool.name}.`);
  }

  // A pool opened or closed: draw its body, or drop it.
  #onToggle(details) {
    const pool = getPools()[details.dataset.pool];
    if (!pool) return;
    this.#viewOf(pool).open = details.open;
    const body = details.querySelector(".lc-pool__body");
    if (details.open === !!body.childElementCount) return;
    this.#fillBody(details.closest(".lc-pool"), pool);
  }

  // Dropping an item on a missing row relinks it; wired once per row.
  #wired = new WeakSet();
  #wireRelinks(scope) {
    scope.querySelectorAll("[data-relink]").forEach(el => {
      if (this.#wired.has(el)) return;
      this.#wired.add(el);
      el.addEventListener("dragover", e => { e.preventDefault(); e.stopPropagation(); el.classList.add("lc-drop--over"); });
      el.addEventListener("dragleave", () => el.classList.remove("lc-drop--over"));
      el.addEventListener("drop", e => { e.stopPropagation(); this.#onRelink(e, el.dataset.pool, el.dataset.relink); });
    });
  }

  static async #addPool() { await createPool({ name: "New pool" }); this.render(); }

  static async #editPool(_e, t) {
    const pool = getPools()[t.dataset.pool];
    const data = await promptForm("Edit pool", `<label>Name <input name="name" value="${esc(pool.name)}"></label>`);
    if (data) { await updatePool(pool.id, { name: data.name || pool.name }); this.render(); }
  }

  static async #deletePool(_e, t) {
    const pool = getPools()[t.dataset.pool];
    if (await DialogV2.confirm({ window: { title: "Delete pool" }, content: `<p>Delete <strong>${esc(pool.name)}</strong>? Boxes that use it keep their other pools.</p>` })) {
      await removePool(pool.id); this.render();
    }
  }

  static async #removeEntry(_e, t) {
    const { pool: poolId, uuid } = t.dataset;
    const list = t.closest(".lc-entries");
    const at = list ? [...list.children].findIndex(li => li.dataset.entry === uuid) : -1;
    await removeEntry(poolId, uuid);
    this.#repaint(poolId, { at: at < 0 ? null : at });
  }

  // Renamed at the source: take its current name, image and rarity.
  static async #updateEntry(_e, t) {
    const src = (await checkSources([{ uuid: t.dataset.uuid }])).get(t.dataset.uuid);
    if (src === undefined) return ui.notifications.warn("Couldn't read that item's compendium just now; try again.");
    if (!src) { ui.notifications.warn("That item's source is gone; drop an item on the row to relink it."); return this.render(); }
    await patchEntry(t.dataset.pool, t.dataset.uuid, { name: src.name, img: src.img, rarity: src.rarity, sourceRarity: src.rawRarity ?? undefined });
    this.#sources?.set(t.dataset.uuid, src);
    this.#repaint(t.dataset.pool, { uuid: t.dataset.uuid });
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

  // One rarity for every entry in the pool whose source has none, of those
  // the pool's search and chip let through.
  static async #setUnsetRarity(_e, t) {
    const poolId = t.dataset.pool;
    const pool = getPools()[poolId];
    if (!pool) return this.render();
    const view = this.#viewOf(pool);
    const unset = filterRows(this.#rowsOf(pool), view).filter(r => r.unset).map(r => r.e.uuid);
    if (!unset.length) return this.#repaint(poolId);
    const n = unset.length;
    const matching = view.q.trim() || view.chip ? " matching the search and filter" : "";
    const data = await promptForm(`Set rarity in ${pool.name}`, `
      <p>${n} item${n === 1 ? "" : "s"}${matching} ${n === 1 ? "has" : "have"} no rarity at the source and draw${n === 1 ? "s" : ""} as Common until you pick one.</p>
      <label>Rarity <select name="rarity">${RARITIES.map(r => `<option value="${r}">${RARITY_LABEL[r]}</option>`).join("")}</select></label>
      <p class="lc-form__hint">The granted item carries this rarity. Each item's rarity can still be changed on its own row.</p>`);
    if (!RARITIES.includes(data?.rarity)) return;
    const saved = await updatePool(poolId, fresh => ({ ...fresh, entries: curateEntries(fresh.entries, unset, { sourceRarity: "", rarityOverride: data.rarity }) }));
    if (saved) ui.notifications.info(`${n} item${n === 1 ? "" : "s"} in ${pool.name} set to ${RARITY_LABEL[data.rarity]}.`);
    this.#repaint(poolId);
  }

  // A rarity or weight changed on a row: save just that, then update the row
  // and its pool's header in place (a full render would drop focus).
  async #onCurate(el) {
    const { pool: poolId, uuid } = el.dataset;
    const change = {};
    if (el.dataset.curate === "weight") {
      const n = Number(el.value);
      if (el.value.trim() === "" || !Number.isFinite(n)) { el.value = el.defaultValue; return; }
      change.weight = Math.max(0, Math.floor(n));
      el.value = change.weight;
    } else {
      change.rarityOverride = RARITIES.includes(el.value) ? el.value : null;
    }
    if (el.dataset.sourceRarity != null) change.sourceRarity = el.dataset.sourceRarity;
    const saved = await updatePool(poolId, fresh => ({ ...fresh, entries: curateEntries(fresh.entries, [uuid], change) }));
    const entry = saved?.entries?.find(x => x.uuid === uuid);
    const row = el.closest(".lc-entry");
    const poolEl = el.closest(".lc-pool");
    if (!entry || !row || !poolEl) { this.render(); return; }
    // The row stays where it is even if it no longer matches the chip, so
    // focus stays on it; the census and chips catch up.
    const src = this.#srcOf(entry);
    const fresh = entryParts(sortRows(poolRows({ entries: [entry] }, () => src), this.#viewOf(saved).recent)[0], esc);
    row.className = fresh.className;
    row.querySelector(".lc-entry__text")?.replaceWith(htmlNode(fresh.text));
    if (el.dataset.curate === "weight") el.defaultValue = String(entryWeight(entry));
    const rows = this.#rowsOf(saved);
    const view = this.#viewOf(saved);
    poolEl.querySelector(".lc-pool__count").innerHTML = poolCount(saved, rows);
    this.#paintChips(poolEl, saved, rows);
    const unsetEl = poolEl.querySelector(".lc-pool__unset");
    if (unsetEl) unsetEl.innerHTML = unsetButton(saved, filterRows(rows, view), view, esc);
  }

  // What the editor knows of an entry's source: the last check, else its
  // stored flag (a check that couldn't answer).
  #srcOf(e) {
    const sources = this.#sources;
    if (sources?.has(e.uuid)) return sources.get(e.uuid);
    return e.missing ? null : { name: e.name, img: e.img, rarity: null, rawRarity: null };
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
    const had = new Set((getPools()[poolId]?.entries ?? []).map(e => e.uuid));
    const added = await addEntries(poolId, plan.entries);
    if (!added) { ui.notifications.info(`Nothing new to add to ${pool.name} from ${plan.label}.`); this.render(); return false; }
    this.#pinDrop(poolId, plan.entries.map(e => e.uuid).filter(u => !had.has(u)), { label: plan.label, added });
    return true;
  }

  static async #addBox() { await createBox({ name: "New box", price: DEFAULT_PRICE_GP, weights: { ...DEFAULT_WEIGHTS } }); this.render(); }

  static async #editBox(_e, t) {
    const box = getBoxes()[t.dataset.box];
    const pools = Object.values(getPools());
    const poolIds = pools.map(p => p.id);
    const shares = Object.fromEntries((box.pools ?? []).map(p => [p.id, p.share ?? 1]));
    const data = await promptForm("Edit box", `
      <label>Name <input name="name" value="${esc(box.name)}"></label>
      <label>Price (gp) <input name="price" type="number" min="0" step="1" value="${esc(box.price)}"></label>
      <fieldset><legend>Pools and their share of pulls</legend>
        ${pools.map(p => `<label class="lc-row"><input type="checkbox" name="pool.${esc(p.id)}" ${p.id in shares ? "checked" : ""}> ${esc(p.name)} <input name="share.${esc(p.id)}" type="number" min="0" step="1" value="${esc(shares[p.id] ?? 1)}" title="Share"></label>`).join("") || "<p>No pools yet.</p>"}
      </fieldset>
      <fieldset class="lc-form__weights"><legend>Rarity weights</legend>
        ${RARITIES.map(r => `<label class="lc-row">${RARITY_LABEL[r]} <input name="w.${r}" type="number" min="0" step="1" value="${esc(box.weights?.[r] ?? DEFAULT_WEIGHTS[r])}"><span class="lc-form__hint" data-held="${r}"></span></label>`).join("")}
      </fieldset>
      <div class="lc-form__odds" role="group" aria-labelledby="lc-odds-${esc(box.id)}">
        <div class="lc-form__label" id="lc-odds-${esc(box.id)}">Chances a player sees</div>
        <div class="lc-form__preview"></div>
        <p class="lc-sr-only" role="status" aria-live="polite"></p>
      </div>
      <fieldset><legend>Rules</legend>
        <label class="lc-row">Pity: guarantee <select name="pityRarity"><option value="">off</option>${RARITIES.map(r => `<option value="${r}" ${box.rules?.pity?.minRarity === r ? "selected" : ""}>${RARITY_LABEL[r]} or better</option>`).join("")}</select> after <input name="pityAfter" type="number" min="1" step="1" value="${esc(box.rules?.pity?.after ?? 10)}"> pulls</label>
        <label class="lc-row"><input type="checkbox" name="noDuplicates" ${box.rules?.noDuplicates ? "checked" : ""}> No duplicates per character</label>
        <label class="lc-row">Stock (blank for unlimited) <input name="stock" type="number" min="0" step="1" value="${box.rules?.stock ?? ""}"></label>
      </fieldset>`, { onForm: form => liveOdds(form, box, poolIds), position: { width: 460 } });
    if (!data) return;
    // Stock moves while the dialog is open (each pull takes one, a refund
    // puts one back), so the form's stock only wins if the GM changed it.
    const shownStock = box.rules?.stock ?? null;
    const formStock = data.stock === "" || data.stock == null ? null : Math.max(0, Number(data.stock) || 0);
    const draft = draftBox(box, data, poolIds);
    const saved = await updateBox(box.id, fresh => {
      const live = getPools();
      return {
        ...fresh,
        name: data.name || fresh.name,
        price: Math.max(0, Number(data.price) || 0),
        pools: draft.pools.filter(ref => ref.id in live),
        weights: draft.weights,
        rules: {
          ...fresh.rules,
          pity: data.pityRarity ? { minRarity: data.pityRarity, after: Math.max(1, Number(data.pityAfter) || 1) } : null,
          noDuplicates: !!data.noDuplicates,
          stock: formStock === shownStock ? (fresh.rules?.stock ?? null) : formStock,
        },
      };
    });
    if (!saved) ui.notifications.warn(`${box.name} was deleted while you were editing it.`);
    this.render();
  }

  static async #deleteBox(_e, t) {
    const box = getBoxes()[t.dataset.box];
    if (await DialogV2.confirm({ window: { title: "Delete box" }, content: `<p>Delete <strong>${esc(box.name)}</strong>?</p>` })) {
      await removeBox(box.id); this.render();
    }
  }

  static async #refund(_e, t) {
    const plan = describeRefund(t.dataset.row);
    if (plan.status === "already") { ui.notifications.info("That pull was already refunded."); this.#focusRow = t.dataset.row; return this.render(); }
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
    // The Refund button is gone after the render; land on the row's status.
    this.#focusRow = row.id;
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
    this.render();
  }

  static async #toggleShop() { await setShopOpen(!isShopOpen()); this.render(); }

  // redraw.js's change count when this render read the settings.
  seen = -1;

  async _renderHTML() {
    this.seen = changeCount();
    const root = document.createElement("div");
    root.className = "lc-manager__body";
    const tabs = [["pools", "Pools"], ["boxes", "Boxes"], ["log", "Pull log"]];
    root.innerHTML = `
      <nav class="lc-tabs">
        <div class="lc-tabs__list" role="tablist" aria-label="Loot Crates sections">${tabs.map(([k, l]) => `<button type="button" role="tab" id="lc-manager-tab-${k}" aria-controls="lc-manager-panel" aria-selected="${k === this.tab}" data-action="switchTab" data-tab="${k}" class="${k === this.tab ? "active" : ""}">${l}</button>`).join("")}</div>
        <span class="lc-tabs__spacer"></span>
        <button type="button" data-action="toggleShop" class="lc-shop-toggle" data-open="${isShopOpen()}" aria-pressed="${isShopOpen()}" title="${isShopOpen() ? "Players can buy now. Click to close the shop." : "Players can't buy now. Click to open the shop."}">${isShopOpen() ? "Shop open" : "Shop closed"}</button>
      </nav>
      <section class="lc-tab" role="tabpanel" id="lc-manager-panel" aria-labelledby="lc-manager-tab-${this.tab}">${await this[`_${this.tab}`]()}</section>`;
    root.querySelectorAll("[data-drop-pool]").forEach(el => {
      el.addEventListener("dragover", e => { e.preventDefault(); el.classList.add("lc-drop--over"); });
      el.addEventListener("dragleave", () => el.classList.remove("lc-drop--over"));
      el.addEventListener("drop", e => { el.classList.remove("lc-drop--over"); this.#onDrop(e, el.dataset.dropPool); });
    });
    root.addEventListener("change", e => {
      const el = e.target.closest?.("[data-curate]");
      if (el) this.#onCurate(el).catch(err => { console.error(`loot-crates | saving that entry failed`, err); this.render(); });
    });
    this.#wireRelinks(root);
    root.querySelectorAll(".lc-pool__details").forEach(d => d.addEventListener("toggle", () => this.#onToggle(d)));
    // The typed text goes into the view at once, so a full render that lands
    // before the debounce (a late source check) redraws it instead of
    // dropping it; only the redraw of the rows waits.
    root.addEventListener("input", e => {
      const el = e.target.closest?.(".lc-pool__search");
      if (!el) return;
      const pool = getPools()[el.dataset.pool];
      if (pool) this.#viewOf(pool).q = el.value;
      clearTimeout(this.#searchTimer);
      this.#searchTimer = setTimeout(() => {
        const live = this.#poolEl(el.dataset.pool)?.querySelector(".lc-pool__search");
        if (live && getPools()[el.dataset.pool]) this.#refilter(el.dataset.pool);
      }, SEARCH_DELAY_MS);
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
      if (plan.skipped.duplicates) {
        if (pool.entries.some(e => e.uuid === data.uuid)) return this.#pinDrop(poolId, [data.uuid], { duplicate: true });
        return ui.notifications.info(`${plan.label} is already in ${pool.name}.`);
      }
      const type = Object.keys(plan.skipped.notLoot)[0];
      return ui.notifications.warn(`${plan.label} is a ${SKIPPED_NAMES[type]?.[0] ?? type}, not loot. A pool takes weapons, equipment, consumables, tools, loot and containers.`);
    }
    if (await addEntries(poolId, plan.entries)) this.#pinDrop(poolId, plan.entries.map(e => e.uuid));
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
    const { name, img, rarity, sourceRarity } = entryFromItem(item);
    const done = await patchEntry(poolId, uuid, { uuid: item.uuid, name, img, rarity, sourceRarity });
    if (!done) ui.notifications.info(`${item.name} is already in ${getPools()[poolId]?.name ?? "that pool"}; remove the missing entry instead.`);
    this.#repaint(poolId, { uuid: done ? item.uuid : uuid });
  }

  async _pools() {
    const pools = Object.values(getPools());
    const sources = await this.#checkedSources(pools.flatMap(p => p.entries ?? []));
    // The editor just looked: if a flag the shop reads is stale, sweep now.
    const stale = !this.checking && pools.some(p => p.entries.some(e => sources.has(e.uuid) && !!e.missing !== !sources.get(e.uuid)));
    if (stale) {
      sweepPools(pools.map(p => p.id))
        .catch(err => console.error(`loot-crates | checking pools for missing items failed`, err));
    }
    // One status line for the whole tab: the source check, then what a
    // search, a chip or Show more did.
    return `
      <div class="lc-toolbar"><button type="button" data-action="addPool"><i class="fas fa-plus"></i> New pool</button><span class="lc-pool__hint lc-manager__status" role="status">${this.checking ? "Checking each item against its source…" : ""}</span></div>
      ${pools.length ? pools.map(p => {
        const rows = this.#rowsOf(p);
        const view = this.#viewOf(p);
        return `
        <article class="lc-pool" data-drop-pool="${esc(p.id)}">
          <details class="lc-pool__details" data-pool="${esc(p.id)}"${view.open ? " open" : ""}>
            ${poolSummary(p, rows, esc)}
            <div class="lc-pool__body">${view.open ? poolBody(p, rows, view, esc) : ""}</div>
          </details>
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
          <td>${oddsCell(shopOdds(b, pools).rows)}</td>
          <td>${[b.rules?.pity ? esc(`${RARITY_LABEL[b.rules.pity.minRarity] ?? b.rules.pity.minRarity} or better after ${b.rules.pity.after} pulls`) : "", b.rules?.noDuplicates ? "no dupes" : "", b.rules?.stock != null ? `${b.rules.stock} left` : ""].filter(Boolean).join(", ")}</td>
          <td><button type="button" data-action="editBox" data-box="${esc(b.id)}" aria-label="Edit ${esc(b.name)}" data-tooltip="Edit"><i class="fas fa-pen" inert></i></button> <button type="button" data-action="deleteBox" data-box="${esc(b.id)}" aria-label="Delete ${esc(b.name)}" data-tooltip="Delete"><i class="fas fa-trash" inert></i></button></td>
        </tr>`).join("")}</tbody></table>` : `<p class="lc-empty">No boxes. A box prices a pull from one or more pools.</p>`}`;
  }

  _log() {
    const log = getLog();
    if (!log.length) return `<p class="lc-empty">No pulls yet.</p>`;
    return `<table class="lc-table"><thead><tr><th>When</th><th>Who</th><th>Box</th><th>Got</th><th></th></tr></thead><tbody>
      ${log.map(r => `<tr class="${r.refunded ? "lc-row--refunded" : r.lateCancel ? "lc-row--late" : ""}">
        <td>${new Date(r.at).toLocaleString()}</td><td>${esc(r.actorName)}</td><td>${esc(r.boxName)} (${esc(formatPrice(r.price))})</td>
        <td class="lc-rarity-${esc(r.rarity)}"><span class="lc-dot"></span>${r.refunded ? `<s>${esc(r.name)}</s>` : esc(r.name)}${r.pity ? " · pity" : ""}${logRarityNote(r)}${logLateNote(r)}</td>
        <td>${r.refunded ? `<span class="lc-log__status" tabindex="-1" data-row="${esc(r.id)}">refunded ${esc(refundTime(r.refunded))}</span>` : `<button type="button" data-action="refund" data-row="${esc(r.id)}">Refund</button>`}</td>
      </tr>`).join("")}</tbody></table>`;
  }

  #searchTimer = null;
  #focusRow = null;

  // A full render (a source check landing late, a rename, a refund) keeps
  // focus on the same control when it is drawn again, and the caret in a
  // search, instead of sending a keyboard or screen-reader user to the top.
  _replaceHTML(result, content) {
    const active = content.contains(document.activeElement) ? document.activeElement : null;
    const key = active ? focusKey(active) : null;
    const caret = active?.matches?.("input[type=search]") ? [active.selectionStart, active.selectionEnd] : null;
    content.replaceChildren(result);
    // After a refund, focus whatever now stands for that log row: its
    // "refunded <date>" status, or its Refund button if the refund failed.
    const row = this.#focusRow;
    this.#focusRow = null;
    const rowEl = row && content.querySelector(`.lc-table [data-row="${CSS.escape(row)}"]`);
    if (rowEl) return rowEl.focus();
    if (!key) return;
    const again = content.querySelector(key.selector) ?? (key.pool && content.querySelector(`.lc-pool__details[data-pool="${CSS.escape(key.pool)}"] > summary`));
    if (!again) return;
    again.focus();
    if (caret && again.setSelectionRange) try { again.setSelectionRange(...caret); } catch { /* not a text input */ }
  }
}

// A selector that finds the same control in a fresh render: its tag, its
// search class, and whichever of the data attributes that identify it are set.
const FOCUS_ATTRS = ["action", "curate", "pool", "uuid", "chip", "tab", "box", "row"];
function focusKey(el) {
  if (el.matches("summary")) {
    const pool = el.closest(".lc-pool__details")?.dataset.pool;
    return pool ? { selector: `.lc-pool__details[data-pool="${CSS.escape(pool)}"] > summary`, pool } : null;
  }
  const attrs = FOCUS_ATTRS.filter(a => el.dataset[a] != null).map(a => `[data-${a}="${CSS.escape(el.dataset[a])}"]`);
  const search = el.classList.contains("lc-pool__search") ? ".lc-pool__search" : "";
  if (!attrs.length && !search) return null;
  return { selector: `${el.tagName.toLowerCase()}${search}${attrs.join("")}`, pool: el.dataset.pool ?? el.closest(".lc-pool__details")?.dataset.pool ?? null };
}

// "Legendary, set by GM (source Uncommon)" under a log row whose rarity the GM
// set over its source's. Rows from before this was recorded carry nothing.
const rarityName = r => RARITY_LABEL[normalizeRarity(r)] ?? String(r);
export function logRarityNote(row) {
  if (!Array.isArray(row?.sourceRarity)) return "";
  const from = row.sourceRarity.length ? `source ${row.sourceRarity.map(rarityName).join(" or ")}` : "source had none";
  return `<small class="lc-log__rarity">${esc(`${rarityName(row.rarity)}, set by GM (${from})`)}</small>`;
}

// A pull its buyer called off after the charge (socket.js lateCancel): the
// sale stood, and the GM's notice sent them here to refund it if wanted.
export function logLateNote(row) {
  if (!row?.lateCancel || row.refunded) return "";
  return `<small class="lc-log__late">Called off by the buyer after the charge. Refund it if the table agrees.</small>`;
}

const PREVIEW_ROWS = 50;
const SEARCH_DELAY_MS = 150;

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

const htmlNode = html => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };

// A small form in a DialogV2; resolves to the form's values or null.
// A form's values as the editors read them: each named field's value (a list
// for repeats and multi-selects), each checkbox as true or false.
function readForm(form) {
  const out = {};
  for (const [k, v] of new FormData(form).entries()) {
    if (k in out) out[k] = [].concat(out[k], v);
    else out[k] = v;
  }
  for (const sel of form.querySelectorAll("select[multiple]")) out[sel.name] = [...sel.selectedOptions].map(o => o.value);
  for (const cb of form.querySelectorAll("input[type=checkbox]")) out[cb.name] = cb.checked;
  return out;
}

// `onForm(form)` runs once, with the dialog's <form>, when it is first on screen.
async function promptForm(title, fieldsHtml, { onForm, position } = {}) {
  return DialogV2.wait({
    window: { title },
    classes: ["loot-crates", "lc-dialog"],
    ...(position ? { position } : {}),
    // DialogV2 wraps the content in its own <form>, and a nested <form> is
    // dropped by the parser, so the editor's fields sit in a div.
    content: `<div class="lc-form">${fieldsHtml}</div>`,
    buttons: [
      { action: "ok", label: "Save", default: true, callback: (_e, button) => readForm(button.form ?? button.closest("dialog")?.querySelector("form")) },
      { action: "cancel", label: "Cancel", callback: () => null },
    ],
    rejectClose: false,
    render: onForm ? (_e, dialog) => {
      const form = dialog.element?.querySelector(".lc-form")?.closest("form");
      if (!form || form.dataset.lcReady) return;
      form.dataset.lcReady = "1";
      onForm(form);
    } : undefined,
  });
}

/*
  The box editor's odds, live: on every input and change, the draft box the
  form would save (boxcard.js draftBox) is drawn with the shop's own ribbon
  and pills against the stored pools (so missing and 0-weight entries are
  left out, as the shop leaves them out), and each weight whose rarity the
  ticked pools don't hold says so. Nothing is written until Save.
*/
function liveOdds(form, box, poolIds) {
  const out = form.querySelector(".lc-form__preview");
  const status = form.querySelector(".lc-form__odds [role=status]");
  let shown = null;
  let announce = null;
  const paint = () => {
    const draft = draftBox(box, readForm(form), poolIds);
    const preview = boxPreview(draft, getPools());
    const html = boxPreviewHTML(preview, esc);
    if (html !== shown) { out.innerHTML = html; shown = html; }
    // The picture follows every keystroke; a screen reader hears one line,
    // once the GM stops typing (the opening odds go unsaid).
    const summary = oddsSummary(preview);
    if (!announce) announce = quietAnnouncer(text => { if (status) status.textContent = text; }, { last: summary });
    else announce(summary);
    for (const el of form.querySelectorAll("[data-held]")) {
      el.textContent = draft.pools.length && !preview.held.has(el.dataset.held) ? "none in these pools" : "";
    }
  };
  form.addEventListener("input", paint);
  form.addEventListener("change", paint);
  paint();
}

/*
  Whether the manager's open tab shows a changed world setting, so a pull, a
  late cancel or another GM's edit redraws it (redraw.js). The shop toggle is
  in the nav, so every tab shows it. The pools tab redraws itself after its
  own edits (#repaint), and a full render of up to 50 rows per pool on every
  sweep flag would undo its paging, so a pools change redraws only the Boxes
  tab, whose odds read the pools. The pity state shows nowhere here (each
  buyer's shop shows their own).
*/
export function managerShows(tab, key) {
  if (key === SETTINGS.SHOP_OPEN) return true;
  if (key === SETTINGS.LOG) return tab === "log";
  if (key === SETTINGS.BOXES || key === SETTINGS.POOLS) return tab === "boxes";
  return false;
}

// One render for any number of changed keys; focus and a typed search are
// kept across it (_replaceHTML). `upTo` is redraw.js's count at the batch's
// last change: a render that started after it already shows the batch (a GM
// action renders once its own write is heard), so it isn't drawn twice.
export function refreshManager(keys, upTo = Infinity) {
  if (!manager?.rendered) return;
  if (manager.seen >= upTo) return;
  const list = typeof keys === "string" ? [keys] : [...keys];
  if (list.some(k => managerShows(manager.tab, k))) manager.render();
}

let manager = null;
export function openManager() {
  manager ??= new CrateManager();
  manager.render({ force: true });
  return manager;
}
