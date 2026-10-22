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
  focus goes to the first one's rarity select, and the status line names it
  ("Flame Tongue added to Core magic items, Rare, at the top."). Only the
  status line: it stays put and is read out once, where a toast as well made
  screen readers say the same sentence twice. Toasts are for drops that
  didn't go in. A single item already in the pool is pinned the same way.
  The pin is view state only and goes at the next drop or when the manager
  closes.

  Each pool's header names the boxes that draw from it ("In Adventurer's
  Crate, Royal Crate" or "Not in any box"). Delete pool's confirm names
  them, and apart from them the boxes it would leave with nothing inside;
  Remove asks first only when the item is the last one some box can drop.

  The box editor shows the chances a player will see (the shop's ribbon and
  pills) for the form as it stands, redrawn on every keystroke, tick and
  untick, and says when the box would drop nothing (liveOdds below).

  The Boxes tab holds every game the shop sells: a crate, a Wishing Well
  (well.js) with its own editor (the stake in cp, sp or gp, the three
  outcomes' weights, the cap per in-game day), a Dragon's Teeth dice
  game (dicegame.js: the stake, 2d6 or 3d6 over the dragon's number, the
  multiplier, the perfect-roll prize), or a Deck of Many Things (deck.js:
  the first draw's price, how much each draw in a row multiplies it, and
  the cards as rows the GM writes: a name, what it does, its weight, once
  per deck, its gold or its text; Reshuffle puts every drawn card back).
  The Pull log folds a character's
  misses at a well for one day into one line ("5 throws, nothing") whose
  Refund gives the newest throw back, and "Hide misses" leaves only the
  throws that gave something; a row that paid coins out says what it paid,
  and a refund the purse can't cover is refused naming the shortfall
  (refund.js shortMessage) instead of taking the purse below zero.
*/
import { RARITIES, RARITY_LABEL, DEFAULT_WEIGHTS, DEFAULT_PRICE_GP, SETTINGS } from "./config.js";
import { oddsPills, oddsRibbon, draftBox, boxPreview, boxPreviewHTML, oddsSummary, quietAnnouncer, refundRulesLine } from "./boxcard.js";
import { kindOf } from "./kinds.js";
import { WELL_DEFAULTS, wellOdds, wellOddsHTML, wellRulesText, stakeCoins, stakeGp, draftWell, wellPreview, wellPreviewHTML, wellSummary, collapseMisses, throwsText, noClockNote } from "./well.js";
import { DICE_DEFAULTS, FORMULAS, diceOdds, diceOddsHTML, diceRulesText, draftDice, dicePreview, dicePreviewHTML, diceSummary } from "./dicegame.js";
import { DECK_DEFAULTS, CARD_KINDS, CARD_KIND_LABEL, CARD_KIND_HINT, cardsOf, stepOf, deckOdds, deckOddsHTML, deckRulesText, draftDeck, deckPreview, deckPreviewHTML, deckSummary } from "./deck.js";

// A box's odds in the Boxes table: its ribbon over its named pills.
const oddsCell = rows => rows.length ? `${oddsRibbon(rows)}<div class="lc-odds">${oddsPills(rows)}</div>` : "<em>empty</em>";
import { groupRounds, roundLine, stakeNote } from "./round.js";
import { getRounds, getPools, getBoxes, getLog, todayKey, createPool, updatePool, removePool, createBox, updateBox, removeBox, entryFromItem, entriesFromDrop, addEntries, packHasLoot, LOOT_TYPES, isLootType, isShopOpen, setShopOpen, checkSources, sweepPools, removeEntry, patchEntry } from "./store.js";
import { shopOdds, normalizeRarity, flattenPool, withSources, entryWeight, curateEntries } from "./odds.js";
import { PAGE_ROWS, FALLBACK_IMG, defaultView, poolRows, sortRows, filterRows, pageRows, nextRows, poolCount, poolSummary, poolBody, chipsHTML, unsetButton, footHTML, entryRow, entryParts, pinRecent, dropNotice, poolUsers, usersText, deleteImpact, removeImpact, deletePoolText, removeEntryText } from "./poolview.js";
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
      addBox: CrateManager.#addBox, addWell: CrateManager.#addWell, addDice: CrateManager.#addDice, addDeck: CrateManager.#addDeck, editBox: CrateManager.#editBox, deleteBox: CrateManager.#deleteBox, reshuffle: CrateManager.#reshuffle,
      refund: CrateManager.#refund, toggleShop: CrateManager.#toggleShop, toggleMisses: CrateManager.#toggleMisses,
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
    them, focus the first, and say so in the status line (not a toast too:
    one announcement). Any earlier pin, on any pool, goes.
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
  }

  /*
    Each drawn pool's "In X, Y" line, worked out again from the stored boxes
    and pools after another client changed them (refreshManager). Only a line
    whose text differs is written, in place, so paging, a typed search, focus
    and scroll stay put, and a pull that only counts down a box's stock
    writes nothing. Returns how many lines changed.
  */
  patchUsers() {
    const lines = this.element?.querySelectorAll(".lc-pool__summary .lc-pool__users") ?? [];
    if (!lines.length) return 0;
    const pools = getPools();
    const boxes = getBoxes();
    let changed = 0;
    for (const line of lines) {
      const id = line.closest(".lc-pool__details")?.dataset.pool;
      if (!id || !pools[id]) continue;
      const text = usersText(poolUsers(id, pools, boxes).map(b => b.name));
      if (line.textContent === text) continue;
      line.textContent = text;
      changed++;
    }
    return changed;
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

  // The pools as the last source check found them, so a box's "nothing
  // inside" is judged on what the shop will draw, not on a stale flag.
  #livePools() {
    const pools = getPools();
    return this.#sources ? withSources(pools, this.#sources) : pools;
  }

  // The confirm names the boxes that draw from the pool, and apart from
  // them the ones it would leave with nothing inside.
  static async #deletePool(_e, t) {
    const pool = getPools()[t.dataset.pool];
    if (!pool) return this.render();
    const content = deletePoolText(pool, deleteImpact(pool.id, this.#livePools(), getBoxes()), esc);
    if (await DialogV2.confirm({ window: { title: "Delete pool" }, content })) {
      await removePool(pool.id); this.render();
    }
  }

  // Removed at once, unless it is the last item some box can drop: then a
  // confirm names those boxes first.
  static async #removeEntry(_e, t) {
    const { pool: poolId, uuid } = t.dataset;
    const list = t.closest(".lc-entries");
    const at = list ? [...list.children].findIndex(li => li.dataset.entry === uuid) : -1;
    const pools = this.#livePools();
    const emptied = pools[poolId] ? removeImpact(poolId, uuid, pools, getBoxes()) : [];
    if (emptied.length) {
      const row = this.#rowsOf(pools[poolId]).find(r => r.e.uuid === uuid);
      const content = removeEntryText(row?.name ?? uuid, pools[poolId], emptied, esc);
      if (!await DialogV2.confirm({ window: { title: "Remove item" }, content })) return t.focus?.();
    }
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

  // A well: a silver a throw, almost always nothing, three throws a day.
  static async #addWell() {
    await createBox({ kind: "well", name: "New well", price: WELL_DEFAULTS.price, weights: { ...DEFAULT_WEIGHTS }, odds: { ...WELL_DEFAULTS.odds }, rules: { cap: WELL_DEFAULTS.cap } });
    this.render();
  }

  // Dragon's Teeth: 10 gp a bet, 3d6 to beat 12, pays three times the stake.
  static async #addDice() {
    await createBox({ kind: "dice", name: "New dice game", price: DICE_DEFAULTS.price, weights: { ...DEFAULT_WEIGHTS }, dice: { formula: DICE_DEFAULTS.formula, target: DICE_DEFAULTS.target, multiplier: DICE_DEFAULTS.multiplier }, rules: { prize: false } });
    this.render();
  }

  // A deck: 10 gp a draw, half again for each draw in a row, five
  // placeholder cards for the GM to rename (nothing published ships).
  static async #addDeck() {
    await createBox({ kind: "deck", name: "New deck", price: DECK_DEFAULTS.price, weights: { ...DEFAULT_WEIGHTS }, deck: { step: DECK_DEFAULTS.step, shuffledAt: 0, cards: DECK_DEFAULTS.cards.map(c => ({ ...c })) }, rules: {} });
    this.render();
  }

  // Every once card drawn goes back in: the mark the drawn count is read
  // from (deck.js drawnIds) moves to now. The log keeps its rows.
  static async #reshuffle(_e, t) {
    const box = getBoxes()[t.dataset.box];
    if (!box) return this.render();
    const drawn = deckOdds(box, getPools(), getLog()).drawn;
    const ok = await DialogV2.confirm({ window: { title: "Reshuffle" }, content: `<p>Reshuffle <strong>${esc(box.name)}</strong>? ${drawn ? `${drawn} drawn card${drawn === 1 ? " goes" : "s go"} back into the deck.` : "No card is drawn; every card is already in the deck."}</p>` });
    if (!ok) return t.focus?.();
    const saved = await updateBox(box.id, fresh => ({ ...fresh, deck: { ...(fresh.deck ?? {}), shuffledAt: Date.now() } }));
    if (saved) ui.notifications.info(`${box.name} reshuffled: every card is back in the deck.`);
    this.render();
  }

  static async #editBox(_e, t) {
    const box = getBoxes()[t.dataset.box];
    if (!box) return this.render();
    if (kindOf(box) === "well") return CrateManager.#editWell.call(this, box);
    if (kindOf(box) === "dice") return CrateManager.#editDice.call(this, box);
    if (kindOf(box) === "deck") return CrateManager.#editDeck.call(this, box);
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

  /*
    The well's editor: the stake as an amount of one coin (a copper or a
    silver, not "0.1 gp"), the pools and rarity weights the rare find draws
    on, the three outcomes' weights with the shop's own pills as a live
    preview, and the rules: pity, no duplicates and the cap per in-game
    day. Nothing is written until Save.
  */
  static async #editWell(box) {
    const pools = Object.values(getPools());
    const poolIds = pools.map(p => p.id);
    const shares = Object.fromEntries((box.pools ?? []).map(p => [p.id, p.share ?? 1]));
    const stake = stakeCoins(box.price);
    const odds = { ...WELL_DEFAULTS.odds, ...(box.odds ?? {}) };
    const data = await promptForm("Edit well", `
      <label>Name <input name="name" value="${esc(box.name)}"></label>
      <label class="lc-row lc-form__stake">Stake <input name="stake" type="number" min="0" step="1" value="${esc(stake.amount)}"> <select name="coin" aria-label="Coin">${["cp", "sp", "gp"].map(c => `<option value="${c}"${c === stake.coin ? " selected" : ""}>${c}</option>`).join("")}</select></label>
      <fieldset><legend>Outcomes, by weight</legend>
        ${[["nothing", "Nothing"], ["coin", "Coin back"], ["item", "An item from the pools"]].map(([k, l]) => `<label class="lc-row">${l} <input name="o.${k}" type="number" min="0" step="1" value="${esc(odds[k])}"></label>`).join("")}
      </fieldset>
      <fieldset><legend>Pools the item comes from, and their share</legend>
        ${pools.map(p => `<label class="lc-row"><input type="checkbox" name="pool.${esc(p.id)}" ${p.id in shares ? "checked" : ""}> ${esc(p.name)} <input name="share.${esc(p.id)}" type="number" min="0" step="1" value="${esc(shares[p.id] ?? 1)}" title="Share"></label>`).join("") || "<p>No pools yet.</p>"}
      </fieldset>
      <fieldset class="lc-form__weights"><legend>The item's rarity weights</legend>
        ${RARITIES.map(r => `<label class="lc-row">${RARITY_LABEL[r]} <input name="w.${r}" type="number" min="0" step="1" value="${esc(box.weights?.[r] ?? DEFAULT_WEIGHTS[r])}"><span class="lc-form__hint" data-held="${r}"></span></label>`).join("")}
      </fieldset>
      <div class="lc-form__odds" role="group" aria-labelledby="lc-odds-${esc(box.id)}">
        <div class="lc-form__label" id="lc-odds-${esc(box.id)}">Chances a player sees</div>
        <div class="lc-form__preview"></div>
        <p class="lc-sr-only" role="status" aria-live="polite"></p>
      </div>
      <fieldset><legend>Rules</legend>
        <label class="lc-row">Each character may throw <input name="cap" type="number" min="0" step="1" value="${box.rules?.cap ?? ""}"> times a day (blank for no limit; the day is the world's calendar)</label>
        ${noClockNote({ hasClock: todayKey() != null, cap: box.rules?.cap })}
        <label class="lc-row">Pity: guarantee <select name="pityRarity"><option value="">off</option>${RARITIES.map(r => `<option value="${r}" ${box.rules?.pity?.minRarity === r ? "selected" : ""}>${RARITY_LABEL[r]} or better</option>`).join("")}</select> after <input name="pityAfter" type="number" min="1" step="1" value="${esc(box.rules?.pity?.after ?? 10)}"> throws</label>
        <label class="lc-row"><input type="checkbox" name="noDuplicates" ${box.rules?.noDuplicates ? "checked" : ""}> No duplicates per character</label>
      </fieldset>`, {
      onForm: form => liveOdds(form, box, poolIds, (draft, live) => {
        const preview = wellPreview(draft, live);
        return { html: wellPreviewHTML(preview, esc), summary: wellSummary(preview), held: heldRarities(draft, live) };
      }, draftWell),
      position: { width: 460 },
    });
    if (!data) return;
    const draft = draftWell(box, data, poolIds);
    const saved = await updateBox(box.id, fresh => ({
      ...fresh,
      kind: "well",
      name: data.name || fresh.name,
      price: stakeGp(data.stake, data.coin),
      pools: draft.pools.filter(ref => ref.id in getPools()),
      weights: draft.weights,
      odds: draft.odds,
      rules: {
        ...fresh.rules,
        cap: data.cap === "" || data.cap == null ? null : Math.max(0, Math.floor(Number(data.cap) || 0)),
        pity: data.pityRarity ? { minRarity: data.pityRarity, after: Math.max(1, Number(data.pityAfter) || 1) } : null,
        noDuplicates: !!data.noDuplicates,
      },
    }));
    if (!saved) ui.notifications.warn(`${box.name} was deleted while you were editing it.`);
    this.render();
  }

  /*
    The dice game's editor: the stake as an amount of one coin, the dice
    (2d6 or 3d6), the dragon's number and the multiplier, with the shop's
    own win and lose pills and the payout as a live preview; then the
    perfect-roll prize, its pools and rarity weights. The preview warns
    when the dragon can't be beaten (the shop refuses such a game). Nothing
    is written until Save.
  */
  static async #editDice(box) {
    const pools = Object.values(getPools());
    const poolIds = pools.map(p => p.id);
    const shares = Object.fromEntries((box.pools ?? []).map(p => [p.id, p.share ?? 1]));
    const stake = stakeCoins(box.price);
    const dice = { ...DICE_DEFAULTS, ...(box.dice ?? {}) };
    const data = await promptForm("Edit dice game", `
      <label>Name <input name="name" value="${esc(box.name)}"></label>
      <label class="lc-row lc-form__stake">Stake <input name="stake" type="number" min="0" step="1" value="${esc(stake.amount)}"> <select name="coin" aria-label="Coin">${["cp", "sp", "gp"].map(c => `<option value="${c}"${c === stake.coin ? " selected" : ""}>${c}</option>`).join("")}</select></label>
      <fieldset><legend>Beat the dragon</legend>
        <label class="lc-row">Roll <select name="formula">${FORMULAS.map(f => `<option value="${f}"${f === dice.formula ? " selected" : ""}>${f}</option>`).join("")}</select> over the dragon's <input name="target" type="number" min="0" step="1" value="${esc(dice.target)}"></label>
        <label class="lc-row">A win pays <input name="multiplier" type="number" min="0" step="0.5" value="${esc(dice.multiplier)}"> times the stake</label>
        <p class="lc-form__hint">A total equal to the dragon's number loses.</p>
      </fieldset>
      <div class="lc-form__odds" role="group" aria-labelledby="lc-odds-${esc(box.id)}">
        <div class="lc-form__label" id="lc-odds-${esc(box.id)}">Chances a player sees</div>
        <div class="lc-form__preview"></div>
        <p class="lc-sr-only" role="status" aria-live="polite"></p>
      </div>
      <fieldset><legend>Prize</legend>
        <label class="lc-row"><input type="checkbox" name="prize" ${box.rules?.prize ? "checked" : ""}> A perfect roll (every die on its top face) also wins an item from the pools below</label>
      </fieldset>
      <fieldset><legend>Pools the prize comes from, and their share</legend>
        ${pools.map(p => `<label class="lc-row"><input type="checkbox" name="pool.${esc(p.id)}" ${p.id in shares ? "checked" : ""}> ${esc(p.name)} <input name="share.${esc(p.id)}" type="number" min="0" step="1" value="${esc(shares[p.id] ?? 1)}" title="Share"></label>`).join("") || "<p>No pools yet.</p>"}
      </fieldset>
      <fieldset class="lc-form__weights"><legend>The prize's rarity weights</legend>
        ${RARITIES.map(r => `<label class="lc-row">${RARITY_LABEL[r]} <input name="w.${r}" type="number" min="0" step="1" value="${esc(box.weights?.[r] ?? DEFAULT_WEIGHTS[r])}"><span class="lc-form__hint" data-held="${r}"></span></label>`).join("")}
      </fieldset>`, {
      onForm: form => liveOdds(form, box, poolIds, (draft, live) => {
        const preview = dicePreview(draft, live);
        return { html: dicePreviewHTML(preview, esc), summary: diceSummary(preview), held: heldRarities(draft, live) };
      }, draftDice),
      position: { width: 460 },
    });
    if (!data) return;
    const draft = draftDice(box, data, poolIds);
    const saved = await updateBox(box.id, fresh => ({
      ...fresh,
      kind: "dice",
      name: data.name || fresh.name,
      price: stakeGp(data.stake, data.coin),
      pools: draft.pools.filter(ref => ref.id in getPools()),
      weights: draft.weights,
      dice: draft.dice,
      rules: { ...fresh.rules, prize: draft.rules.prize },
    }));
    if (!saved) ui.notifications.warn(`${box.name} was deleted while you were editing it.`);
    this.render();
  }

  /*
    The deck's editor: the first draw's price, the step each draw in a row
    multiplies it by, then the cards as rows (name, what it does, weight,
    once, the gold for coins and loss, the text for an effect) with Add card
    and a remove on each, the pools and rarity weights the item cards draw
    on, and the shop's own pills as a live preview with the cards left.
    Nothing is written until Save.
  */
  static async #editDeck(box) {
    const pools = Object.values(getPools());
    const poolIds = pools.map(p => p.id);
    const shares = Object.fromEntries((box.pools ?? []).map(p => [p.id, p.share ?? 1]));
    const data = await promptForm("Edit deck", `
      <label>Name <input name="name" value="${esc(box.name)}"></label>
      <label>First draw (gp) <input name="price" type="number" min="0" step="1" value="${esc(box.price)}"></label>
      <label class="lc-row">Each draw in a row costs <input name="step" type="number" min="1" step="0.1" value="${esc(stepOf(box))}"> times the last</label>
      <p class="lc-form__hint">A draw within two minutes of the last counts as in a row; the price comes back down after that, and a refund takes a step back.</p>
      <fieldset class="lc-cards"><legend>Cards</legend>
        <div class="lc-cards__head" aria-hidden="true"><span>Card</span><span>Does</span><span>Gold</span><span>Weight</span><span>Once</span><span></span></div>
        <div class="lc-cards__rows">${cardsOf(box).map(c => cardRow(c)).join("")}</div>
        <div class="lc-cards__foot"><button type="button" class="lc-cards__add"><i class="fas fa-plus"></i> Add card</button></div>
        <p class="lc-form__hint">A card marked once leaves the deck when drawn, until you reshuffle. Gold is what a coins card pays or a loss card takes; an effect card's text is posted to chat for you to play out. Weight 0 never draws.</p>
      </fieldset>
      <fieldset><legend>Pools the item cards draw from, and their share</legend>
        ${pools.map(p => `<label class="lc-row"><input type="checkbox" name="pool.${esc(p.id)}" ${p.id in shares ? "checked" : ""}> ${esc(p.name)} <input name="share.${esc(p.id)}" type="number" min="0" step="1" value="${esc(shares[p.id] ?? 1)}" title="Share"></label>`).join("") || "<p>No pools yet.</p>"}
      </fieldset>
      <fieldset class="lc-form__weights"><legend>The item's rarity weights</legend>
        ${RARITIES.map(r => `<label class="lc-row">${RARITY_LABEL[r]} <input name="w.${r}" type="number" min="0" step="1" value="${esc(box.weights?.[r] ?? DEFAULT_WEIGHTS[r])}"><span class="lc-form__hint" data-held="${r}"></span></label>`).join("")}
      </fieldset>
      <div class="lc-form__odds" role="group" aria-labelledby="lc-odds-${esc(box.id)}">
        <div class="lc-form__label" id="lc-odds-${esc(box.id)}">Chances a player sees</div>
        <div class="lc-form__preview"></div>
        <p class="lc-sr-only" role="status" aria-live="polite"></p>
      </div>`, {
      onForm: form => {
        const paint = liveOdds(form, box, poolIds, (draft, live) => {
          const preview = deckPreview(draft, live, getLog());
          return { html: deckPreviewHTML(preview, esc), summary: deckSummary(preview), held: heldRarities(draft, live) };
        }, draftDeck);
        const rows = form.querySelector(".lc-cards__rows");
        // Add card: a blank row at the foot, its name focused. Remove: the
        // row goes and focus moves to the next row's name, else Add card.
        form.querySelector(".lc-cards__add")?.addEventListener("click", () => {
          rows.insertAdjacentHTML("beforeend", cardRow({ id: foundry.utils.randomID(8), label: "", kind: "blank", weight: 1, once: false, gp: 0, text: "" }));
          rows.lastElementChild.querySelector(".lc-card-row__label").focus();
          paint();
        });
        form.addEventListener("click", e => {
          const btn = e.target.closest?.(".lc-card-row__remove");
          if (!btn) return;
          const row = btn.closest(".lc-card-row");
          const next = row.nextElementSibling ?? row.previousElementSibling;
          row.remove();
          (next?.querySelector(".lc-card-row__label") ?? form.querySelector(".lc-cards__add"))?.focus();
          paint();
        });
        // What the card does decides which fields it shows (module.css).
        form.addEventListener("change", e => {
          const sel = e.target.closest?.(".lc-card-row__kind");
          if (sel) sel.closest(".lc-card-row").dataset.kind = sel.value;
        });
      },
      position: { width: 560 },
    });
    if (!data) return;
    const draft = draftDeck(box, data, poolIds);
    const saved = await updateBox(box.id, fresh => ({
      ...fresh,
      kind: "deck",
      name: data.name || fresh.name,
      price: draft.price,
      pools: draft.pools.filter(ref => ref.id in getPools()),
      weights: draft.weights,
      deck: { ...(fresh.deck ?? {}), step: draft.deck.step, cards: draft.deck.cards },
    }));
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
    // Winnings the character has spent can't come back: the confirm's
    // place is taken by the sentence naming the shortfall, and nothing is
    // written. Focus returns to the row's Refund, which still stands.
    if (plan.status === "short") {
      await DialogV2.prompt({ window: { title: "Refund" }, content: `<p>${esc(plan.message)}</p>`, ok: { label: "Close" }, rejectClose: false });
      return t.focus?.();
    }
    if (plan.status !== "ready") return ui.notifications.warn(plan.message);
    const { row, actor, item, box } = plan;
    // A game that paid coins out gives the stake back less the payout; one
    // that paid more than the stake takes the difference back; a coin that
    // already came back (a well's coin return) moves nothing.
    const coins = plan.coins ?? Math.round(row.price * 100);
    const moneyLine = coins > 0 ? `Return <strong>${esc(formatPrice(coins / 100))}</strong> to ${esc(actor.name)}`
      : coins < 0 ? `Take <strong>${esc(formatPrice(-coins / 100))}</strong> back from ${esc(actor.name)}`
      : `${esc(actor.name)}'s coin already came back, so no coins move`;
    const itemLine = item
      ? ` and remove <strong>${esc(item.name)}</strong> from their inventory`
      : row.itemId ? ` (<strong>${esc(row.name)}</strong> is no longer in their inventory, so nothing is removed)` : "";
    const stockLine = box?.rules?.stock != null ? ` ${esc(box.name)} goes back to ${box.rules.stock + 1} in stock.` : "";
    // A throw that gave no item still counted toward the pity (row.before).
    const rules = box && (row.uuid || row.before) ? refundRulesLine({ actorName: actor.name, itemName: row.name, box, ...plan.state }) : "";
    const rulesLine = rules ? ` ${esc(rules)}` : "";
    const ok = await DialogV2.confirm({
      window: { title: "Refund" },
      content: `<p>${moneyLine}${itemLine}?${stockLine}${rulesLine}</p><p>A pull can only be refunded once.</p>`,
    });
    if (!ok) return;
    // The Refund button is gone after the render; land on the row's status.
    this.#focusRow = row.id;
    const done = await refundPull(row.id);
    if (done.status === "refunded") {
      const what = done.removedItem ? ` and ${done.removedItem} removed` : "";
      ui.notifications.info(coins === 0 ? `${row.boxName} refunded for ${actor.name}; no coins moved${what}.` : `${coins > 0 ? `${formatPrice(coins / 100)} returned to` : `${formatPrice(-coins / 100)} taken back from`} ${actor.name}${what}.`);
      await postRefundCard({ row, actor, removedItem: done.removedItem });
    } else if (done.status === "already") {
      ui.notifications.info("That pull was already refunded.");
    } else {
      ui.notifications.warn(done.message);
    }
    this.render();
  }

  static async #toggleShop() { await setShopOpen(!isShopOpen()); this.render(); }

  // The Pull log without the throws that gave nothing (view state only).
  hideMisses = false;
  static #toggleMisses() { this.hideMisses = !this.hideMisses; this.render(); }

  // redraw.js's change count when this render read the settings.
  seen = -1;

  async _renderHTML() {
    this.seen = changeCount();
    const root = document.createElement("div");
    root.className = "lc-manager__body";
    const tabs = [["pools", "Pools"], ["boxes", "Boxes"], ["log", "Pull log"]];
    root.innerHTML = `
      <nav class="lc-tabs">
        <div class="lc-tabs__list" role="tablist" aria-label="Loot Crates sections">${tabs.map(([k, l]) => `<button type="button" role="tab" id="lc-manager-tab-${k}" aria-controls="lc-manager-panel" aria-selected="${k === this.tab}" tabindex="${k === this.tab ? 0 : -1}" data-action="switchTab" data-tab="${k}" class="${k === this.tab ? "active" : ""}">${l}</button>`).join("")}</div>
        <span class="lc-tabs__spacer"></span>
        <button type="button" data-action="toggleShop" class="lc-shop-toggle" data-open="${isShopOpen()}" aria-pressed="${isShopOpen()}" title="${isShopOpen() ? "Players can buy now. Click to close the shop." : "Players can't buy now. Click to open the shop."}">${isShopOpen() ? "Shop open" : "Shop closed"}</button>
      </nav>
      <section class="lc-tab" role="tabpanel" id="lc-manager-panel" aria-labelledby="lc-manager-tab-${this.tab}">${await this[`_${this.tab}`]()}</section>`;
    // The tabs as one stop in the tab order, arrows between them (the ARIA
    // tabs pattern a screen reader announces). Focus moves first, so the
    // render keeps it on the tab it lands on.
    root.querySelector("[role=tablist]")?.addEventListener("keydown", e => {
      const next = tabAfter(tabs.map(([k]) => k), this.tab, e.key);
      if (!next) return;
      e.preventDefault();
      root.querySelector(`[role=tab][data-tab="${next}"]`)?.focus();
      if (next !== this.tab) { this.tab = next; this.render(); }
    });
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
    const stored = getPools();
    const pools = Object.values(stored);
    const boxes = getBoxes();
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
            ${poolSummary(p, rows, esc, poolUsers(p.id, stored, boxes).map(b => b.name))}
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
    // A well's row: its name tagged, its three outcomes as the shop shows
    // them, its cap and pity in throws. A dice game's: win and lose, the
    // dragon's number, the payout and the prize.
    // A deck's row: the kinds of card still in it, its cards and how many
    // are drawn, and Reshuffle beside Edit.
    const log = getLog();
    const well = b => kindOf(b) === "well";
    const dice = b => kindOf(b) === "dice";
    const deck = b => kindOf(b) === "deck";
    const tag = b => (well(b) ? ` <span class="lc-kind">Well</span>` : dice(b) ? ` <span class="lc-kind">Dice</span>` : deck(b) ? ` <span class="lc-kind">Deck</span>` : "");
    const odds = b => (well(b) ? wellOddsHTML(wellOdds(b, pools)) || "<em>dry</em>" : dice(b) ? diceOddsHTML(diceOdds(b, pools)) || "<em>unbeatable</em>" : deck(b) ? deckOddsHTML(deckOdds(b, pools, log)) || "<em>empty</em>" : oddsCell(shopOdds(b, pools).rows));
    const rules = b => (well(b) ? esc(wellRulesText(b)) : dice(b) ? esc(diceRulesText(b)) : deck(b) ? esc(deckRulesText(b, log)) : [b.rules?.pity ? esc(`${RARITY_LABEL[b.rules.pity.minRarity] ?? b.rules.pity.minRarity} or better after ${b.rules.pity.after} pulls`) : "", b.rules?.noDuplicates ? "no dupes" : "", b.rules?.stock != null ? `${b.rules.stock} left` : ""].filter(Boolean).join(", "));
    const extra = b => (deck(b) ? `<button type="button" data-action="reshuffle" data-box="${esc(b.id)}" aria-label="Reshuffle ${esc(b.name)}">Reshuffle</button> ` : "");
    return `
      <div class="lc-toolbar"><button type="button" data-action="addBox"><i class="fas fa-plus"></i> New box</button><button type="button" data-action="addWell"><i class="fas fa-plus"></i> New well</button><button type="button" data-action="addDice"><i class="fas fa-plus"></i> New dice game</button><button type="button" data-action="addDeck"><i class="fas fa-plus"></i> New deck</button></div>
      ${boxes.length ? `<table class="lc-table"><thead><tr><th>Box</th><th>Price</th><th>Pools</th><th>Odds</th><th>Rules</th><th></th></tr></thead><tbody>
        ${boxes.map(b => `<tr>
          <td>${esc(b.name)}${tag(b)}</td><td>${esc(formatPrice(b.price))}</td>
          <td>${(b.pools ?? []).map(r => esc(pools[r.id]?.name ?? "missing")).join(", ") || "<em>none</em>"}</td>
          <td>${odds(b)}</td>
          <td>${rules(b)}</td>
          <td>${extra(b)}<button type="button" data-action="editBox" data-box="${esc(b.id)}" aria-label="Edit ${esc(b.name)}" data-tooltip="Edit"><i class="fas fa-pen" inert></i></button> <button type="button" data-action="deleteBox" data-box="${esc(b.id)}" aria-label="Delete ${esc(b.name)}" data-tooltip="Delete"><i class="fas fa-trash" inert></i></button></td>
        </tr>`).join("")}</tbody></table>` : `<p class="lc-empty">No boxes. A box prices a pull from one or more pools.</p>`}`;
  }

  /*
    The log newest first, a well's misses folded per character and day
    (well.js collapseMisses): one line for "5 throws, nothing" whose Refund
    gives the newest of them back, so the log stays readable at a table that
    throws a lot and every throw is still refundable. "Hide misses" leaves
    only the pulls that gave something (the throws stay in the setting).
  */
  _log() {
    const log = getLog();
    if (!log.length) return `<p class="lc-empty">No pulls yet.</p>`;
    const items = groupRounds(collapseMisses(log), getRounds());
    const misses = items.filter(x => x.group).reduce((n, g) => n + g.rows.length, 0);
    const shown = this.hideMisses ? items.filter(x => !x.group) : items;
    const status = (id, at) => `<span class="lc-log__status" tabindex="-1" data-row="${esc(id)}">refunded ${esc(refundTime(at))}</span>`;
    const row = r => `<tr class="${r.refunded ? "lc-row--refunded" : r.lateCancel ? "lc-row--late" : ""}">
        <td>${new Date(r.at).toLocaleString()}</td><td>${esc(r.actorName)}</td><td>${esc(r.boxName)} (${esc(formatPrice(r.price))})</td>
        <td class="lc-rarity-${esc(r.rarity ?? r.swatch ?? (r.win ? "coin" : "none"))}"><span class="lc-dot"></span>${r.refunded ? `<s>${esc(r.name)}</s>` : esc(r.name)}${r.pity ? " · pity" : ""}${logRarityNote(r)}${logPayoutNote(r)}${logStakeNote(r)}${logLateNote(r)}</td>
        <td>${r.refunded ? status(r.id, r.refunded) : `<button type="button" data-action="refund" data-row="${esc(r.id)}">Refund</button>`}</td>
      </tr>`;
    const group = g => {
      const n = g.rows.length;
      const newest = g.rows[0];
      return `<tr class="lc-row--group${g.refunded ? " lc-row--refunded" : ""}">
        <td>${new Date(newest.at).toLocaleString()}</td><td>${esc(g.actorName)}</td><td>${esc(g.boxName)} (${esc(formatPrice(g.price))})</td>
        <td class="lc-rarity-none"><span class="lc-dot"></span>${g.refunded ? `<s>${esc(throwsText(n))}</s>` : esc(throwsText(n))}</td>
        <td>${g.refunded ? status(newest.id, newest.refunded) : `<button type="button" data-action="refund" data-row="${esc(newest.id)}" aria-label="${n === 1 ? "Refund the throw" : `Refund one of ${n} throws`}">${n === 1 ? "Refund" : "Refund one"}</button>`}</td>
      </tr>`;
    };
    // A table round: its header where its newest stake was, its stakes under it.
    const round = g => `<tr class="lc-row--group">
        <td>${new Date(g.at).toLocaleString()}</td><td>Round</td><td>${esc(g.boxName)} (${esc(formatPrice(g.staked))} staked)</td>
        <td class="lc-rarity-none"><span class="lc-dot"></span>${esc(roundLine(g))}</td><td></td>
      </tr>${g.rows.map(row).join("")}`;
    const toolbar = misses ? `<div class="lc-toolbar"><button type="button" data-action="toggleMisses" aria-pressed="${this.hideMisses}">${this.hideMisses ? "Show misses" : "Hide misses"}</button><span class="lc-pool__hint">${this.hideMisses ? `${misses} throw${misses === 1 ? "" : "s"} that gave nothing hidden` : `${misses} throw${misses === 1 ? "" : "s"} that gave nothing, folded by day`}</span></div>` : "";
    return `${toolbar}${shown.length ? `<table class="lc-table"><thead><tr><th>When</th><th>Who</th><th>Box</th><th>Got</th><th></th></tr></thead><tbody>
      ${shown.map(x => (x.round ? round(x) : x.group ? group(x) : row(x.row))).join("")}</tbody></table>` : `<p class="lc-empty">Only misses so far; show them with the button above.</p>`}`;
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
    // The Pools tab read the boxes before awaiting the source check, and a
    // box saved elsewhere in that wait was patched into the page this one
    // replaces (refreshManager), so bring the "In X, Y" lines up to date.
    if (this.tab === "pools") this.patchUsers();
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

// The tab an arrow, Home or End key moves to from `current`, wrapping; null
// for any other key.
export function tabAfter(keys, current, key) {
  const i = Math.max(0, keys.indexOf(current));
  const at = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: keys.length - 1 }[key];
  return at == null ? null : keys[(at + keys.length) % keys.length];
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

// "Rolled 4, 6, 5 · won 30 gp" under a row of a game that paid coins out
// (the dice), or "took 20 gp" under one that took coins beyond the stake
// (the deck's bane): what a refund gives or takes back is on the row, not
// only in the confirm. A row from before payouts (payoutCp 0 or absent)
// says nothing; a deck's row names its card's kind.
export function logPayoutNote(row) {
  const cp = Math.round(Number(row?.payoutCp) || 0);
  const faces = Array.isArray(row?.faces) && row.faces.length ? `Rolled ${row.faces.join(", ")}` : "";
  const card = row?.cardKind && row.cardKind !== "item" ? `${CARD_KIND_LABEL[row.cardKind] ?? row.cardKind} card` : "";
  const won = cp > 0 ? `won ${formatPrice(cp / 100)}` : cp < 0 ? `took ${formatPrice(-cp / 100)}` : "";
  const text = [faces, card, won].filter(Boolean).join(" · ");
  return text ? `<small class="lc-log__rarity">${esc(text)}</small>` : "";
}

// A table stake still waiting on its spin, or one turned back (round.js stakeNote).
export function logStakeNote(row) {
  const text = stakeNote(row);
  return text ? `<small class="lc-log__rarity">${esc(text)}</small>` : "";
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

// One card of the deck editor (deck.js draftDeck reads these names): the
// row's data-kind decides which of the gold and text fields show.
function cardRow(c) {
  const id = esc(c.id);
  return `<div class="lc-card-row" data-card="${id}" data-kind="${esc(c.kind)}">
      <input type="hidden" name="cards" value="${id}">
      <input class="lc-card-row__label" name="c.${id}.label" value="${esc(c.label)}" placeholder="Card name" aria-label="Card name">
      <select class="lc-card-row__kind" name="c.${id}.kind" aria-label="What the card does">${CARD_KINDS.map(k => `<option value="${k}"${k === c.kind ? " selected" : ""}>${esc(CARD_KIND_HINT[k])}</option>`).join("")}</select>
      <input class="lc-card-row__gp" name="c.${id}.gp" type="number" min="0" step="1" value="${esc(c.gp ?? 0)}" aria-label="Gold pieces" placeholder="gp">
      <input class="lc-card-row__weight" name="c.${id}.weight" type="number" min="0" step="1" value="${esc(c.weight ?? 1)}" aria-label="Weight">
      <label class="lc-card-row__once"><input type="checkbox" name="c.${id}.once"${c.once ? " checked" : ""} aria-label="Once per deck"></label>
      <button type="button" class="lc-card-row__remove" aria-label="Remove ${esc(c.label || "this card")}" data-tooltip="Remove"><i class="fas fa-xmark" inert></i></button>
      <input class="lc-card-row__text" name="c.${id}.text" value="${esc(c.text ?? "")}" placeholder="What happens (posted to chat for you to play out)" aria-label="Effect text">
    </div>`;
}

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
function liveOdds(form, box, poolIds, previewOf = cratePreview, draftOf = draftBox) {
  const out = form.querySelector(".lc-form__preview");
  const status = form.querySelector(".lc-form__odds [role=status]");
  let shown = null;
  let announce = null;
  const paint = () => {
    const draft = draftOf(box, readForm(form), poolIds);
    const preview = previewOf(draft, getPools());
    if (preview.html !== shown) { out.innerHTML = preview.html; shown = preview.html; }
    // The picture follows every keystroke; a screen reader hears one line,
    // once the GM stops typing (the opening odds go unsaid).
    if (!announce) announce = quietAnnouncer(text => { if (status) status.textContent = text; }, { last: preview.summary });
    else announce(preview.summary);
    for (const el of form.querySelectorAll("[data-held]")) {
      el.textContent = draft.pools.length && !preview.held.has(el.dataset.held) ? "none in these pools" : "";
    }
  };
  form.addEventListener("input", paint);
  form.addEventListener("change", paint);
  paint();
  // For an editor whose rows come and go (the deck's cards), which fire no input.
  return paint;
}

// The crate editor's preview: the shop's ribbon and pills, one line for a
// screen reader, and the rarities the ticked pools hold.
function cratePreview(draft, pools) {
  const preview = boxPreview(draft, pools);
  return { html: boxPreviewHTML(preview, esc), summary: oddsSummary(preview), held: preview.held };
}

// The rarities a draft's ticked pools can drop (for the weights' notes).
function heldRarities(draft, pools) {
  const held = new Set();
  for (const ref of draft.pools ?? []) for (const e of flattenPool(ref.id, pools)) held.add(e.rarity);
  return held;
}

/*
  Whether the manager's open tab shows a changed world setting, so a pull, a
  late cancel or another GM's edit redraws it (redraw.js). The shop toggle is
  in the nav, so every tab shows it. The pools tab redraws itself after its
  own edits (#repaint), and a full render of up to 50 rows per pool on every
  sweep flag would undo its paging, so a pools change redraws only the Boxes
  tab, whose odds read the pools. On the Pools tab a boxes or pools change
  patches only the pools' "In X, Y" lines, and only those that differ
  (CrateManager.patchUsers). The pity state shows nowhere here (each
  buyer's shop shows their own).
*/
export function managerShows(tab, key) {
  if (key === SETTINGS.SHOP_OPEN) return true;
  if (key === SETTINGS.LOG || key === SETTINGS.ROUNDS) return tab === "log";
  if (key === SETTINGS.BOXES || key === SETTINGS.POOLS) return tab === "boxes";
  return false;
}

// What a pool's users line reads: the boxes' pool lists, and pools nested in pools.
const USERS_KEYS = [SETTINGS.BOXES, SETTINGS.POOLS];

// One render for any number of changed keys; focus and a typed search are
// kept across it (_replaceHTML). `upTo` is redraw.js's count at the batch's
// last change: a render that started after it already shows the batch (a GM
// action renders once its own write is heard), so it isn't drawn twice.
export function refreshManager(keys, upTo = Infinity) {
  if (!manager?.rendered) return;
  if (manager.seen >= upTo) return;
  const list = typeof keys === "string" ? [keys] : [...keys];
  if (list.some(k => managerShows(manager.tab, k))) manager.render();
  else if (manager.tab === "pools" && list.some(k => USERS_KEYS.includes(k))) manager.patchUsers();
}

let manager = null;
export function openManager() {
  manager ??= new CrateManager();
  manager.render({ force: true });
  return manager;
}
