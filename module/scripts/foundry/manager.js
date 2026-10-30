/*
  The GM's workbench: pools (what can drop), boxes (what's for sale), and the
  pull log (who got what, with Refund). Reached from the Items sidebar's
  "Manage crates", the shop's own "Manage crates" (route.js), Game Settings,
  or game.modules.get("loot-crates").api.openManager(). Its nav's "View
  shop" opens the shop beside it.

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
  A pool another client creates, renames or edits redraws the open tab
  (refreshManager); this window's own edits, drawn in place, don't.

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
  per deck, its gold or its text; Reshuffle puts every drawn card back), or
  a scratch ticket (scratch.js: the price, lucky numbers or match 3, the
  grid, the bonus spot, the roll's size and its prize list, with the
  roll's odds read out live; Print a new roll starts the next roll).
  Every New opens its kind's editor on an unsaved draft (newgame.js):
  nothing is written until "Add to shelf", so Cancel leaves no empty row
  and a player's shelf never shows a half-built game. The Save then
  switches to the Boxes tab, focuses the new row's Edit and says in the
  tab's status line where the game went ("Gilded Crate is on the shelf
  at 250 gp.", or that the shop is closed). A pool's bar has "New crate
  from this pool", a crate named for the pool that draws from it alone.
  Copy on a game's row opens the same editor on an unsaved copy of that
  game (newgame.js copyOf): every setting, none of its history, named
  "<name> (copy)" (then "(copy 2)" and on) for the GM to rename and reprice.
  Make a ticket on a pulled game's row makes one ticket for it, an item in
  the Items folder "Loot Crates tickets" (tickets.js).
  The Pull log folds a character's
  misses at one game for one day (a well's throws, a crate's "Nothing")
  into one line ("5 throws, nothing") whose Refund gives the newest back,
  and "Hide misses" leaves only the plays that gave something; a row that
  paid coins out says what it paid, and a refund the purse can't cover is
  refused naming the shortfall (refund.js shortMessage) instead of taking
  the purse below zero.
*/
import { RARITIES, RARITY_LABEL, DEFAULT_WEIGHTS, SETTINGS } from "../core/config.js";
import { draftBox, oddsRules, boxPreview, boxPreviewHTML, oddsSummary, quietAnnouncer, refundRulesLine } from "../views/boxcard.js";
import { kindOf, PullError } from "../games/kinds.js";
import { liveRoundOf, heldBy } from "../core/round.js";
import { WELL_DEFAULTS, stakeCoins, stakeGp, draftWell, wellPreview, wellPreviewHTML, wellSummary, noClockNote } from "../games/well.js";
import { DICE_DEFAULTS, FORMULAS, draftDice, dicePreview, dicePreviewHTML, diceSummary } from "../games/dicegame.js";
import { CARD_KINDS, CARD_KIND_HINT, cardsOf, streakMinutesOf, deckRiseFieldsHTML, deckOdds, draftDeck, deckPreview, deckPreviewHTML, deckSummary } from "../games/deck.js";
import { ROULETTE_DEFAULTS, BET_TYPES, BET_TYPE_LABEL, pocketsOf, coloursOf, draftRoulette, roulettePreview, roulettePreviewHTML, rouletteSummary, payoutOf, maxStakeOf, maxBetsOf, windowMsOf, itemOnRarity } from "../games/roulette.js";
import { scratchFieldsHTML, wireScratchEditor, draftScratch, scratchPreview, scratchPreviewHTML, scratchSummary, rollState, nextRoll, rollName, ticketsLeftText, poolRarities } from "../games/scratch.js";
import { fillFieldsHTML, wireFill } from "../games/scratchplan.js";
import { MAX_HOUSE, MIN_GAVEL_SEC, HOUSE_TICK_MS, lotOf, lotFromEntry, lotFromCrate, incrementOf, reserveOf, gavelMsOf, houseOf, draftAuction, auctionPreview, auctionPreviewHTML, auctionSummary } from "../games/auction.js";
import { newDraft, crateFromPool, crateFromTable, copyOf, editorTitle, addLabel, addedNotice, deleteTitle, deleteGameText, deletedNotice } from "../views/newgame.js";
import { boxesTabHTML } from "../views/boxestable.js";
import { logTableHTML, logRarityNote, logPayoutNote, logStakeNote, logLateNote } from "../views/logtable.js";
// The log's notes stay reachable here for the checks that import them from the manager.
export { logRarityNote, logPayoutNote, logStakeNote, logLateNote };
// The table window (tablewindow.js), loaded when a wheel's round is opened
// from here: it is Foundry's, and the editors' tests run this file without it.
const openTableFor = boxId => import("./tablewindow.js").then(m => m.openTableFor(boxId));
// A round called off before its game is deleted (table.js), loaded the same way.
const cancelTableRound = roundId => import("./table.js").then(m => m.cancelRound(roundId));
// The shop, opened from the nav's "View shop"; loaded when pressed, as the
// table is (shop.js reaches back here for its own "Manage crates").
const openShopWindow = () => import("./shop.js").then(m => m.openShop());
import { getRounds, getPools, getBoxes, getLog, dayMode, newId, createPool, updatePool, removePool, createBox, updateBox, removeBox, entryFromItem, entriesFromDrop, addEntries, packHasLoot, LOOT_TYPES, isLootType, isShopOpen, setShopOpen, checkSources, sweepPools, removeEntry, patchEntry } from "./store.js";
import { flattenPool, withSources, entryWeight, curateEntries, oddsModeOf } from "../core/odds.js";
import { SKIPPED_NOUN, describeSkipped, dropPreviewHTML, savedNotice, PAGE_ROWS, defaultView, poolRows, sortRows, filterRows, pageRows, nextRows, poolCount, poolSummary, poolBody, chipsHTML, unsetButton, footHTML, entryRow, entryParts, pinRecent, dropNotice, poolUsers, usersText, deleteImpact, removeImpact, deletePoolText, removeEntryText } from "../views/poolview.js";
import { formatPrice, parsePrice, unreadablePrice } from "../core/currency.js";
import { managerNavHTML, MANAGER_TABS, directoryMenuEntry } from "../views/route.js";
import { describeRefund, refundPull } from "./refund.js";
import { postRefundCard } from "./chat.js";
import { makeTicket } from "./tickets.js";
import { changeCount } from "../core/redraw.js";
import { limitsFieldset, perCharacterFromForm, restocked, stockAfterRefund, stockField, stockFromForm } from "../core/limits.js";
import { byRest } from "../core/clock.js";
import { onShelf, shelfRules, shelfFieldHTML, shelfNotice, savedOffNotice, addedOffNotice } from "../core/shelf.js";
import { unplayableReason } from "../views/playable.js";
import { okGate, snapshotOf, wireShelf as wireShelfBox, wireStock, discardTitle, discardHTML, discardLabels, freeTitle, freeHTML, freeLabels } from "../views/editorguard.js";
import { guardDialog } from "./editordialog.js";
import { starterPresent, hasStarter, starterAgainText, starterNotice, starterCallHTML, STARTER_LABEL } from "../views/starter.js";
import { addStarterSet } from "./starterbuild.js";
import { poolsFieldset, poolPicks, syncShares, pityRow, stakeRow, betRangeRow, dragonRow, CARD_FIELDS, renumberCards, oddsModeFieldset, tableNoteHTML, nothingRow } from "../views/editorfields.js";
import { t, listAnd } from "../core/i18n.js";

const { ApplicationV2, DialogV2 } = foundry.applications.api;
// Every editor's dialog: DialogV2 that asks before it throws a changed form away (editordialog.js).
const EditorDialog = guardDialog(DialogV2);
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
// How this world tells a day (store.js dayMode), for the editors' notes
// beside the well's cap and a limit per day.
const dayOpts = () => { const day = dayMode(); return { day, hasClock: day != null }; };
const dragData = event => (foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor).getDragEventData(event);

export class CrateManager extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "loot-crates-manager",
    classes: ["loot-crates", "lc-manager"],
    // The window's title is its own getter, in the module's words.
    window: { title: "LOOTCRATES.Manager.Title", resizable: true },
    position: { width: 760, height: 620 },
    actions: {
      // Not "tab": ApplicationV2 sends that action to its own changeTab,
      // which throws without a data-group (test/actions.test.js).
      switchTab: CrateManager.#switchTab,
      addPool: CrateManager.#addPool, editPool: CrateManager.#editPool, deletePool: CrateManager.#deletePool,
      bulkAdd: CrateManager.#bulkAdd, setUnsetRarity: CrateManager.#setUnsetRarity, removeEntry: CrateManager.#removeEntry, updateEntry: CrateManager.#updateEntry, relinkEntry: CrateManager.#relinkEntry,
      addBox: CrateManager.#addBox, addWell: CrateManager.#addWell, addDice: CrateManager.#addDice, addDeck: CrateManager.#addDeck, addWheel: CrateManager.#addWheel, addAuction: CrateManager.#addAuction, addScratch: CrateManager.#addScratch, crateFromPool: CrateManager.#crateFromPool,
      editBox: CrateManager.#editBox, toggleShelf: CrateManager.#toggleShelf, copyBox: CrateManager.#copyBox, makeTicket: CrateManager.#makeTicket, deleteBox: CrateManager.#deleteBox, reshuffle: CrateManager.#reshuffle, printRoll: CrateManager.#printRoll, openTable: CrateManager.#openTable,
      refund: CrateManager.#refund, toggleShop: CrateManager.#toggleShop, openShop: CrateManager.#openShop, toggleMisses: CrateManager.#toggleMisses,
      filterChip: CrateManager.#filterChip, showMore: CrateManager.#showMore,
      starterCrates: CrateManager.#starterCrates,
    },
  };

  get title() { return t("LOOTCRATES.Manager.Title"); }

  tab = "boxes";

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

  static #switchTab(_e, target) { this.tab = target.dataset.tab; this.render(); }

  // Each pool's view: open, name search, filter chip, rows shown.
  #view = new Map();
  #viewOf(pool) {
    let v = this.#view.get(pool.id);
    if (!v) this.#view.set(pool.id, (v = defaultView(pool)));
    return v;
  }
  #rowsOf(pool) { return sortRows(poolRows(pool, e => this.#srcOf(e)), this.#viewOf(pool).recent); }

  /*
    Each pool as this tab last drew it, so a pools change another client
    made (a second GM's edit, starter crates added elsewhere) redraws the tab
    while this window's own edits, already drawn in place, don't
    (refreshManager). `head` is the record without its entries, drawn only by
    a full render (the summary's name); `body` is its entries, drawn again
    by #fillBody, or one row at a time by #onCurate.
  */
  #drawn = new Map();
  #drewPool(pool) { this.#drawn.set(pool.id, { head: headKey(pool), body: bodyKey(pool) }); }
  #drewBody(pool) {
    const d = pool && this.#drawn.get(pool.id);
    if (d) d.body = bodyKey(pool);
  }
  #bodyDrawn(poolId) {
    const d = this.#drawn.get(poolId);
    const pool = getPools()[poolId];
    return !!d && !!pool && d.body === bodyKey(pool);
  }
  // Whether the Pools tab shows every stored pool as it is now.
  showsPools(pools = getPools()) {
    const ids = Object.keys(pools ?? {});
    if (ids.length !== this.#drawn.size) return false;
    return ids.every(id => {
      const d = this.#drawn.get(id);
      return !!d && d.head === headKey(pools[id]) && d.body === bodyKey(pools[id]);
    });
  }
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

  // Closing the manager lets go of every pin, and of the new row's mark.
  async _onClose(options) {
    for (const v of this.#view.values()) v.recent = [];
    this.#recentBox = null;
    return super._onClose?.(options);
  }

  #fillBody(el, pool) {
    this.#drewBody(pool);
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
    this.#announce(narrowed ? t("LOOTCRATES.Manager.FilterMatch", { count: matched.length, all: rows.length, pool: pool.name }) : t("LOOTCRATES.Manager.FilterCleared", { pool: pool.name }));
  }

  static #filterChip(_e, target) {
    const pool = getPools()[target.dataset.pool];
    if (!pool) return this.render();
    const view = this.#viewOf(pool);
    view.chip = view.chip === target.dataset.chip ? null : target.dataset.chip;
    this.#refilter(pool.id);
  }

  // The next 50 matching rows, appended; focus goes to the first new one.
  static #showMore(_e, target) {
    const el = this.#poolEl(target.dataset.pool);
    const pool = getPools()[target.dataset.pool];
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
    this.#announce(t("LOOTCRATES.Manager.ShowingIn", { shown: list.childElementCount, count: matched.length, pool: pool.name }));
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

  static async #addPool() { await createPool({ name: t("LOOTCRATES.Pools.NewPool") }); this.render(); }

  static async #editPool(_e, target) {
    const pool = getPools()[target.dataset.pool];
    const data = await promptForm(t("LOOTCRATES.Manager.EditPool"), `<label>${t("LOOTCRATES.Manager.Name")} <input name="name" value="${esc(pool.name)}"></label>`, { guard: { name: pool.name } });
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
  static async #deletePool(_e, target) {
    const pool = getPools()[target.dataset.pool];
    if (!pool) return this.render();
    const content = deletePoolText(pool, deleteImpact(pool.id, this.#livePools(), getBoxes()), esc);
    if (await DialogV2.confirm({ window: { title: t("LOOTCRATES.Manager.DeletePool") }, content })) {
      await removePool(pool.id); this.render();
    }
  }

  // Removed at once, unless it is the last item some box can drop: then a
  // confirm names those boxes first.
  static async #removeEntry(_e, target) {
    const { pool: poolId, uuid } = target.dataset;
    const list = target.closest(".lc-entries");
    const at = list ? [...list.children].findIndex(li => li.dataset.entry === uuid) : -1;
    const pools = this.#livePools();
    const emptied = pools[poolId] ? removeImpact(poolId, uuid, pools, getBoxes()) : [];
    if (emptied.length) {
      const row = this.#rowsOf(pools[poolId]).find(r => r.e.uuid === uuid);
      const content = removeEntryText(row?.name ?? uuid, pools[poolId], emptied, esc);
      if (!await DialogV2.confirm({ window: { title: t("LOOTCRATES.Manager.RemoveItem") }, content })) return target.focus?.();
    }
    await removeEntry(poolId, uuid);
    this.#repaint(poolId, { at: at < 0 ? null : at });
  }

  // Renamed at the source: take its current name, image and rarity.
  static async #updateEntry(_e, target) {
    const src = (await checkSources([{ uuid: target.dataset.uuid }])).get(target.dataset.uuid);
    if (src === undefined) return ui.notifications.warn(t("LOOTCRATES.Manager.CompendiumBusy"));
    if (!src) { ui.notifications.warn(t("LOOTCRATES.Manager.SourceGone")); return this.render(); }
    await patchEntry(target.dataset.pool, target.dataset.uuid, { name: src.name, img: src.img, rarity: src.rarity, sourceRarity: src.rawRarity ?? undefined });
    this.#sources?.set(target.dataset.uuid, src);
    this.#repaint(target.dataset.pool, { uuid: target.dataset.uuid });
  }

  // Relink without dragging (keyboard, screen reader, touch): paste the
  // UUID of the item that replaces a missing source.
  static async #relinkEntry(_e, target) {
    const entry = getPools()[target.dataset.pool]?.entries?.find(e => e.uuid === target.dataset.uuid);
    if (!entry) return this.render();
    const data = await promptForm(t("LOOTCRATES.Pools.RelinkLabel", { name: entry.name }), `
      <p>${t("LOOTCRATES.Manager.RelinkLead", { name: `<strong>${esc(entry.name)}</strong>` })}</p>
      <label>${t("LOOTCRATES.Manager.ItemUuid")} <input name="uuid" required placeholder="Compendium.dnd5e.items.Item.…" autocomplete="off"></label>
      <p class="lc-form__hint">${t("LOOTCRATES.Manager.RelinkHint")}</p>`);
    if (data?.uuid) await this.#relink(target.dataset.pool, target.dataset.uuid, String(data.uuid).trim());
  }

  // One rarity for every entry in the pool whose source has none, of those
  // the pool's search and chip let through.
  static async #setUnsetRarity(_e, target) {
    const poolId = target.dataset.pool;
    const pool = getPools()[poolId];
    if (!pool) return this.render();
    const view = this.#viewOf(pool);
    const unset = filterRows(this.#rowsOf(pool), view).filter(r => r.unset).map(r => r.e.uuid);
    if (!unset.length) return this.#repaint(poolId);
    const n = unset.length;
    const matching = !!(view.q.trim() || view.chip);
    const lead = target(n === 1 ? (matching ? "LOOTCRATES.Manager.UnsetOneMatching" : "LOOTCRATES.Manager.UnsetOne") : (matching ? "LOOTCRATES.Manager.UnsetManyMatching" : "LOOTCRATES.Manager.UnsetMany"), { count: n });
    const data = await promptForm(t("LOOTCRATES.Manager.SetRarityIn", { pool: pool.name }), `
      <p>${lead}</p>
      <label>${t("LOOTCRATES.Roulette.Rarity")} <select name="rarity">${RARITIES.map(r => `<option value="${r}">${RARITY_LABEL[r]}</option>`).join("")}</select></label>
      <p class="lc-form__hint">${t("LOOTCRATES.Manager.SetRarityHint")}</p>`);
    if (!RARITIES.includes(data?.rarity)) return;
    const saved = await updatePool(poolId, fresh => ({ ...fresh, entries: curateEntries(fresh.entries, unset, { sourceRarity: "", rarityOverride: data.rarity }) }));
    if (saved) ui.notifications.info(target(n === 1 ? "LOOTCRATES.Manager.SetToOne" : "LOOTCRATES.Manager.SetToMany", { count: n, pool: pool.name, rarity: RARITY_LABEL[data.rarity] }));
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
    // The pool is drawn as stored once this row is, unless something else
    // changed meanwhile (another client's edit, a render that replaced the
    // row): then the batch that follows redraws the tab (refreshManager).
    const before = changeCount();
    const synced = this.#bodyDrawn(poolId);
    const saved = await updatePool(poolId, fresh => ({ ...fresh, entries: curateEntries(fresh.entries, [uuid], change) }));
    const entry = saved?.entries?.find(x => x.uuid === uuid);
    const row = el.closest(".lc-entry");
    const poolEl = el.closest(".lc-pool");
    if (!entry || !row || !poolEl) { this.render(); return; }
    if (synced && el.isConnected !== false && changeCount() - before <= 1) this.#drewBody(getPools()[poolId]);
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
    // Said in the tab's status line, as a Boxes row's price is.
    const what = el.dataset.curate === "weight" ? t("LOOTCRATES.Pools.WeightN", { weight: entryWeight(entry) }) : RARITY_LABEL[change.rarityOverride] ?? el.selectedOptions?.[0]?.textContent?.trim() ?? t("LOOTCRATES.Manager.RarityFromSource");
    this.#announce(savedNotice(entry.name, what));
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
  static async #bulkAdd(_e, target) {
    const pool = getPools()[target.dataset.pool];
    const packs = game.packs.filter(packHasLoot);
    if (!packs.length) return ui.notifications.warn(t("LOOTCRATES.Manager.NoLootPacks"));
    const types = LOOT_TYPES.filter(k => k in (CONFIG.Item.typeLabels ?? {}));
    const data = await promptForm(t("LOOTCRATES.Pools.BulkAdd"), `
      <label>${t("LOOTCRATES.Manager.Compendium")} <select name="pack">${packs.map(p => `<option value="${esc(p.collection)}">${esc(p.metadata.label)} (${esc(p.collection)})</option>`).join("")}</select></label>
      <label>${t("LOOTCRATES.Manager.Types")} <select name="types" multiple size="5">${types.map(k => `<option value="${esc(k)}" ${["weapon", "equipment", "consumable", "tool"].includes(k) ? "selected" : ""}>${esc(game.i18n.localize(CONFIG.Item.typeLabels[k]))}</option>`).join("")}</select></label>
      <label>${t("LOOTCRATES.Manager.Rarities")} <select name="rarities" multiple size="6">${RARITIES.map(r => `<option value="${r}" ${r === "common" ? "" : "selected"}>${RARITY_LABEL[r]}</option>`).join("")}</select></label>
      <label>${t("LOOTCRATES.Manager.NameContains")} <input name="name" placeholder="${t("LOOTCRATES.Manager.NameContainsPlaceholder")}"></label>`);
    if (!data) return;
    const filter = { types: data.types, rarities: data.rarities, name: data.name };
    const plan = await entriesFromDrop({ type: "Compendium", collection: data.pack, filter }, { known: pool.entries.map(e => e.uuid) });
    if (plan) await this.#previewAdd(pool.id, plan);
  }

  // The preview before a folder, compendium, table or filter goes in.
  async #previewAdd(poolId, plan) {
    const pool = getPools()[poolId];
    const n = plan.entries.length;
    const skipped = describeSkipped(plan.skipped, { flattened: plan.flattened ?? 0 });
    if (!n) {
      ui.notifications.info(skipped.length ? t("LOOTCRATES.Manager.NothingToAddWhy", { pool: pool.name, label: plan.label, why: skipped.join(t("LOOTCRATES.Common.ListSemicolon")) }) : t("LOOTCRATES.Manager.NothingToAdd", { pool: pool.name, label: plan.label }));
      return false;
    }
    const items = t(n === 1 ? "LOOTCRATES.Editor.ItemsOne" : "LOOTCRATES.Editor.ItemsMany", { count: n });
    const action = await DialogV2.wait({
      window: { title: t("LOOTCRATES.Manager.AddTo", { pool: pool.name }) },
      classes: ["loot-crates", "lc-dialog"],
      position: { width: 460 },
      content: dropPreviewHTML(plan, pool.name, esc),
      buttons: [
        { action: "add", label: t("LOOTCRATES.Manager.AddItems", { items }), icon: "fas fa-plus", default: true },
        { action: "cancel", label: t("LOOTCRATES.Common.Cancel") },
      ],
      rejectClose: false,
    });
    if (action !== "add") return false;
    const had = new Set((getPools()[poolId]?.entries ?? []).map(e => e.uuid));
    const added = await addEntries(poolId, plan.entries);
    if (!added) { ui.notifications.info(t("LOOTCRATES.Manager.NothingNewToAdd", { pool: pool.name, label: plan.label })); this.render(); return false; }
    this.#pinDrop(poolId, plan.entries.map(e => e.uuid).filter(u => !had.has(u)), { label: plan.label, added });
    return true;
  }

  /*
    Every New opens its kind's editor on an unsaved draft (newgame.js):
    nothing is written, and nothing reaches a player's shelf, until the
    dialog's "Add to shelf". Cancel, Escape and closing it leave the shelf
    as it was, so there is never an empty "New box" row to go back and
    delete, or a nameless dice game taking stakes while the GM looks for
    its row.
  */
  // With one pool in the world, a new crate draws from it already ticked.
  static #addBox() {
    const pools = Object.values(getPools());
    const only = pools.length === 1 ? { pools: [{ id: pools[0].id, share: 1 }] } : {};
    return this.#openEditor(newDraft("crate", { id: newId(), ...only }), { isNew: true });
  }
  static #addWell() { return this.#openEditor(newDraft("well", { id: newId() }), { isNew: true }); }
  static #addDice() { return this.#openEditor(newDraft("dice", { id: newId() }), { isNew: true }); }
  static #addDeck() { return this.#openEditor(newDraft("deck", { id: newId() }), { isNew: true }); }
  static #addWheel() { return this.#openEditor(newDraft("roulette", { id: newId() }), { isNew: true }); }
  static #addAuction() { return this.#openEditor(newDraft("auction", { id: newId() }), { isNew: true }); }
  static #addScratch() { return this.#openEditor(newDraft("scratch", { id: newId() }), { isNew: true }); }

  // "New crate from this pool" on a pool's bar: the crate's editor on a
  // draft named for the pool and drawing only from it, the price focused,
  // so a first crate is one dialog away from a pool with items in it.
  static #crateFromPool(_e, target) {
    const pool = getPools()[target.dataset.pool];
    if (!pool) return this.render();
    return this.#openEditor(crateFromPool(pool, newId()), { isNew: true, focus: "price" });
  }

  /*
    "Make a crate" from a roll table: the sidebar's menu on a table
    (makeCrateFromTable below) or a table dropped on the Boxes tab. The
    table's items go into a new pool named for it, through the write queue
    (store.js entriesFromDrop: nested tables flattened, weights multiplied
    through), and the crate's editor opens on an unsaved draft drawing from
    that pool at the table's own odds, the price focused (newgame.js
    crateFromTable). The GM prices it and presses Add to shelf. Cancel takes
    the pool away again, unless something has come to use it meanwhile.
    The table is copied, not linked: the editor says so.
  */
  async makeCrateFromTable(uuid) {
    let plan = null;
    try { plan = uuid ? await entriesFromDrop({ type: "RollTable", uuid }) : null; } catch (err) { console.error(`loot-crates | reading roll table ${uuid} failed`, err); }
    if (!plan || plan.kind !== "RollTable") return ui.notifications.warn(t("LOOTCRATES.Manager.TableUnreadable"));
    if (!plan.entries.length) {
      const why = describeSkipped(plan.skipped, { flattened: plan.flattened });
      return ui.notifications.warn(why.length ? t("LOOTCRATES.Manager.TableNoItemWhy", { name: plan.label, why: why.join(t("LOOTCRATES.Common.ListSemicolon")) }) : t("LOOTCRATES.Manager.TableNoItem", { name: plan.label }));
    }
    const pool = await createPool({ name: plan.label });
    await addEntries(pool.id, plan.entries);
    this.tab = "boxes";
    await this.render({ force: true });
    const saved = await this.#openEditor(crateFromTable(plan, pool.id, newId()), { isNew: true, focus: "price" });
    if (saved) return true;
    const users = poolUsers(pool.id, getPools(), getBoxes());
    if (!users.length && !Object.values(getPools()).some(p => (p.pools ?? []).includes(pool.id))) await removePool(pool.id);
    this.render();
    return false;
  }

  // A drop on the Boxes tab: a roll table becomes a crate (above).
  async #onBoxesDrop(event) {
    event.preventDefault();
    let data;
    try { data = dragData(event); } catch { return; }
    if (data?.type !== "RollTable" || !data.uuid) return ui.notifications.info(t("LOOTCRATES.Manager.DropTable"));
    return this.makeCrateFromTable(data.uuid);
  }

  // The editor for a record's kind, on the record or on a new draft.
  #openEditor(box, opts = {}) {
    const editor = { well: CrateManager.#editWell, dice: CrateManager.#editDice, deck: CrateManager.#editDeck, roulette: CrateManager.#editWheel, auction: CrateManager.#editAuction, scratch: CrateManager.#editScratch }[kindOf(box)] ?? CrateManager.#editCrate;
    return editor.call(this, box, { isNew: false, focus: null, ...opts });
  }

  /*
    An editor's Save. A new game is created once, from its draft as the
    form left it, and the GM is shown where it went: the Boxes tab, its
    row's Edit focused and scrolled into view (_replaceHTML), the status
    line saying it is on the shelf, that the shop is closed, or that it
    was added off the shelf. An edit is applied to the record as it is now
    (store.js updateBox); only an edit can find its record deleted
    meanwhile. Every editor's "On the shelf" box (`data.onShelf`, shelf.js)
    is written here, over whatever the kind's own rules say. A game that
    can't be played as saved (playable.js, judged on the record as it is
    written, with the pools as they are now) is written off the shelf
    whatever the box says, and the status line says why: a new one, or an
    edit that takes a game off the shelf.
  */
  async #saveEditor(box, isNew, kindBuild, data) {
    let why = "";
    const build = fresh => {
      const out = kindBuild(fresh);
      why = unplayableReason(out, getPools());
      return { ...out, rules: shelfRules(out.rules ?? {}, !!data.onShelf && !why) };
    };
    if (!isNew) {
      const was = onShelf(getBoxes()[box.id] ?? box);
      const saved = await updateBox(box.id, build);
      if (!saved) ui.notifications.warn(t("LOOTCRATES.Manager.DeletedWhileEditing", { name: box.name }));
      await this.render();
      if (saved && why && was) this.#announce(savedOffNotice(saved, why));
      return;
    }
    const saved = await createBox(build(box));
    this.tab = "boxes";
    this.#focusBox = this.#recentBox = saved.id;
    await this.render();
    this.#announce(why ? addedOffNotice(saved, why) : addedNotice(saved, { shopOpen: isShopOpen() }));
  }

  /*
    "Add starter crates" (starter.js, starterbuild.js): on the empty Pools
    and Boxes tabs, and on the Boxes toolbar after. The four pools are
    filled from dnd5e's compendiums and the games written in one queued
    task, every one off the shelf; then the Boxes tab shows them, the
    first game's Edit focused, and its status line says what came in and
    how to put a game out. With the set (or part of it) already here, a
    confirm says so and offers to add the games again as copies drawing
    from the pools already here; Cancel writes nothing. Reading the packs
    can take seconds on a cold client, so the button is off meanwhile and
    a second press is ignored.
  */
  #starting = false;
  static #starterCrates(_e, target) { return this.addStarterCrates(target); }
  async addStarterCrates(button = null) {
    if (this.#starting) return null;
    const present = starterPresent(getPools(), getBoxes());
    if (hasStarter(present)) {
      const ok = await DialogV2.confirm({
        window: { title: STARTER_LABEL },
        content: `<p>${esc(starterAgainText(present))}</p>`,
        yes: { label: t("LOOTCRATES.Manager.AddCopies"), default: false },
        no: { label: t("LOOTCRATES.Common.Cancel"), default: true },
      });
      if (!ok) { button?.focus?.(); return null; }
    }
    this.#starting = true;
    const busy = [...(this.element?.querySelectorAll('[data-action="starterCrates"]') ?? [])];
    for (const b of busy) b.setAttribute("aria-disabled", "true");
    this.#announce(t("LOOTCRATES.Manager.ReadingStarter"));
    let report;
    try {
      report = await addStarterSet();
    } catch (err) {
      console.error("loot-crates | adding the starter crates failed", err);
      report = { games: [], notes: [t("LOOTCRATES.Manager.StarterFailed")] };
    } finally {
      this.#starting = false;
      for (const b of busy) b.removeAttribute("aria-disabled");
    }
    if (report.games.length) {
      this.tab = "boxes";
      this.#focusBox = report.games[0].id;
      this.#recentBox = null;
    }
    await this.render({ force: true });
    this.#announce(starterNotice(report));
    return report;
  }

  // The table's round from the Boxes tab: opened (or brought forward) as
  // the shop card does it (tablewindow.js).
  static async #openTable(_e, target) {
    try { await openTableFor(target.dataset.box); } catch (err) { ui.notifications.warn(err.message); }
    this.render();
  }

  // Every once card drawn goes back in: the mark the drawn count is read
  // from (deck.js drawnIds) moves to now. The log keeps its rows.
  static async #reshuffle(_e, target) {
    const box = getBoxes()[target.dataset.box];
    if (!box) return this.render();
    const drawn = deckOdds(box, getPools(), getLog()).drawn;
    const ok = await DialogV2.confirm({ window: { title: t("LOOTCRATES.Boxes.Reshuffle") }, content: `<p>${t("LOOTCRATES.Manager.ReshuffleAsk", { name: `<strong>${esc(box.name)}</strong>` })} ${drawn ? target(drawn === 1 ? "LOOTCRATES.Manager.ReshuffleOne" : "LOOTCRATES.Manager.ReshuffleMany", { count: drawn }) : t("LOOTCRATES.Manager.ReshuffleNone")}</p>` });
    if (!ok) return target.focus?.();
    const saved = await updateBox(box.id, fresh => ({ ...fresh, deck: { ...(fresh.deck ?? {}), shuffledAt: Date.now() } }));
    if (saved) ui.notifications.info(t("LOOTCRATES.Manager.Reshuffled", { name: box.name }));
    this.render();
  }

  /*
    Print a new roll of a scratch ticket: the next roll id, the same prize
    list, every ticket on sale again; the old roll's rows stay in the log,
    counted against the old roll. A roll that still has tickets asks
    first, naming them; a sold-out one is printed at once. The Boxes
    tab's status line says so.
  */
  static async #printRoll(_e, target) {
    const box = getBoxes()[target.dataset.box];
    if (!box) return this.render();
    const st = rollState(box, getLog());
    if (!st.soldOut) {
      const ok = await DialogV2.confirm({ window: { title: t("LOOTCRATES.Boxes.PrintRoll") }, content: `<p>${t("LOOTCRATES.Manager.PrintRollAsk", { name: `<strong>${esc(box.name)}</strong>`, roll: esc(rollName(st.id)), left: esc(ticketsLeftText(st.left, st.size)) })}</p>` });
      if (!ok) return target.focus?.();
    }
    const saved = await updateBox(box.id, fresh => ({ ...fresh, roll: nextRoll(fresh) }));
    await this.render();
    if (saved) {
      const now = rollState(saved, getLog());
      this.#announce(t("LOOTCRATES.Manager.RollPrinted", { name: saved.name, roll: rollName(now.id), size: now.size }));
    }
  }

  static #editBox(_e, target) {
    const box = getBoxes()[target.dataset.box];
    if (!box) return this.render();
    return this.#openEditor(box);
  }

  // Copy on a row: the kind's editor on an unsaved copy of the game
  // (newgame.js copyOf), titled "Copy box" with the name focused for the
  // GM to rename; Add to shelf creates it as any New does, and Cancel
  // writes nothing.
  static #copyBox(_e, target) {
    const box = getBoxes()[target.dataset.box];
    if (!box) return this.render();
    return this.#openEditor(copyOf(box, { id: newId(), now: Date.now(), names: Object.values(getBoxes()).map(b => b.name) }), { isNew: true, copy: true });
  }

  /*
    Make a ticket on a pulled game's row: one ticket for that game as a
    world Item in the Items folder "Loot Crates tickets" (tickets.js), for
    the GM to drag to a sheet, a loot sheet, a merchant or a pool. The
    tab's status line says where it went; focus stays on the button, so a
    second press makes a second ticket.
  */
  static async #makeTicket(_e, target) {
    const box = getBoxes()[target.dataset.box];
    if (!box) return this.render();
    try {
      const { item, folder } = await makeTicket(box);
      this.#announce(t("LOOTCRATES.Manager.TicketMade", { name: item.name, folder: folder?.name ?? t("LOOTCRATES.Ticket.Folder") }));
      return item;
    } catch (err) {
      console.error(`loot-crates | making a ticket for ${box.name} failed`, err);
      this.#announce(t("LOOTCRATES.Manager.TicketFailed", { name: box.name }));
      return null;
    }
  }

  // The crate's editor; on a new draft nothing is written until Save.
  static async #editCrate(box, opts) {
    const { isNew } = opts;
    const pools = Object.values(getPools());
    const poolIds = pools.map(p => p.id);
    const data = await promptForm(editorTitle(box, isNew, opts.copy), `
      <label>${t("LOOTCRATES.Manager.Name")} <input name="name" value="${esc(box.name)}"${autofocus("name", opts)}></label>
      ${priceFieldHTML(t("LOOTCRATES.Boxes.ColPrice"), box, opts)}
      ${tableNoteHTML(box, { esc })}
      ${poolsFieldset(t("LOOTCRATES.Manager.PoolsShare"), pools, box.pools, { esc })}
      ${oddsModeFieldset(box, { esc })}
      <fieldset class="lc-form__weights"${oddsModeOf(box) === "weight" ? " hidden" : ""}><legend>${t("LOOTCRATES.Manager.RarityWeights")}</legend>
        ${RARITIES.map(r => `<label class="lc-row">${RARITY_LABEL[r]} <input name="w.${r}" type="number" min="0" step="1" value="${esc(box.weights?.[r] ?? DEFAULT_WEIGHTS[r])}"><span class="lc-form__hint" data-held="${r}"></span></label>`).join("")}
      </fieldset>
      ${nothingRow(box, { esc })}
      <div class="lc-form__odds" role="group" aria-labelledby="lc-odds-${esc(box.id)}">
        <div class="lc-form__label" id="lc-odds-${esc(box.id)}">${t("LOOTCRATES.Manager.ChancesSeen")}</div>
        <div class="lc-form__preview"></div>
        <p class="lc-sr-only" role="status" aria-live="polite"></p>
      </div>
      <fieldset><legend>${t("LOOTCRATES.Boxes.ColRules")}</legend>
        ${pityRow(box.rules?.pity, { noun: "pulls", esc })}
        <label class="lc-row"><input type="checkbox" name="noDuplicates" ${box.rules?.noDuplicates ? "checked" : ""}> ${t("LOOTCRATES.Manager.NoDuplicates")}</label>
      </fieldset>
      ${limitsFieldset(box, { draft: isNew, ...dayOpts(), esc })}
      ${shelfFieldHTML(box, opts)}`, {
      // Restock fills the stored record at Save; a draft has none to fill.
      onForm: form => { const shelf = wireShelf(form, isNew); wirePrice(form); wireStock(form, box); liveOdds(form, box, poolIds, cratePreview, draftBox, shelf); },
      position: { width: 460 },
      okLabel: saveLabel(isNew),
      guard: editorGuardOf(box, isNew, { free: true }),
    });
    if (!data) return false;
    // Stock moves while the dialog is open (each pull takes one, a refund
    // puts one back), so the form's number only changes it if the GM
    // changed that number (limits.js stockFromForm); a Restock pressed in
    // the dialog then fills it to the number Save leaves.
    const shownStock = stockField(box);
    const draft = draftBox(box, data, poolIds);
    await this.#saveEditor(box, isNew, fresh => {
      const live = getPools();
      return {
        ...fresh,
        name: data.name || fresh.name,
        price: parsePrice(data.price) ?? Math.max(0, Number(fresh.price) || 0),
        pools: draft.pools.filter(ref => ref.id in live),
        weights: draft.weights,
        rules: {
          // The odds choice and "Count text results as nothing" (boxcard.js oddsRules).
          ...oddsRules(fresh.rules ?? {}, data, fresh.fromTable ?? box.fromTable),
          pity: data.pityRarity ? { minRarity: data.pityRarity, after: Math.max(1, Number(data.pityAfter) || 1) } : null,
          noDuplicates: !!data.noDuplicates,
          ...(data.restock === "1" ? restocked : s => s)(stockFromForm(fresh.rules ?? {}, { shown: shownStock, value: data.stock })),
          perCharacter: perCharacterFromForm(data),
        },
      };
    }, data);
    return true;
  }

  /*
    The well's editor: the stake as an amount of one coin (a copper or a
    silver, not "0.1 gp"), the pools and rarity weights the rare find draws
    on, the three outcomes' weights with the shop's own pills as a live
    preview, and the rules: pity, no duplicates and the cap per in-game
    day. Nothing is written until Save.
  */
  static async #editWell(box, opts) {
    const { isNew } = opts;
    const pools = Object.values(getPools());
    const poolIds = pools.map(p => p.id);
    const stake = stakeCoins(box.price);
    const odds = { ...WELL_DEFAULTS.odds, ...(box.odds ?? {}) };
    const data = await promptForm(editorTitle(box, isNew, opts.copy), `
      <label>${t("LOOTCRATES.Manager.Name")} <input name="name" value="${esc(box.name)}"${autofocus("name", opts)}></label>
      ${stakeRow(stake, esc)}
      <fieldset><legend>${t("LOOTCRATES.Manager.Outcomes")}</legend>
        ${[["nothing", t("LOOTCRATES.Odds.Nothing")], ["coin", t("LOOTCRATES.Well.CoinBack")], ["item", t("LOOTCRATES.Deck.HintItem")]].map(([k, l]) => `<label class="lc-row">${l} <input name="o.${k}" type="number" min="0" step="1" value="${esc(odds[k])}"></label>`).join("")}
      </fieldset>
      ${poolsFieldset(t("LOOTCRATES.Manager.PoolsItem"), pools, box.pools, { esc })}
      <fieldset class="lc-form__weights"><legend>${t("LOOTCRATES.Manager.ItemRarityWeights")}</legend>
        ${RARITIES.map(r => `<label class="lc-row">${RARITY_LABEL[r]} <input name="w.${r}" type="number" min="0" step="1" value="${esc(box.weights?.[r] ?? DEFAULT_WEIGHTS[r])}"><span class="lc-form__hint" data-held="${r}"></span></label>`).join("")}
      </fieldset>
      <div class="lc-form__odds" role="group" aria-labelledby="lc-odds-${esc(box.id)}">
        <div class="lc-form__label" id="lc-odds-${esc(box.id)}">${t("LOOTCRATES.Manager.ChancesSeen")}</div>
        <div class="lc-form__preview"></div>
        <p class="lc-sr-only" role="status" aria-live="polite"></p>
      </div>
      <fieldset><legend>${t("LOOTCRATES.Boxes.ColRules")}</legend>
        <label class="lc-row">${t(byRest(dayMode()) ? "LOOTCRATES.Manager.WellCap" : "LOOTCRATES.Manager.WellCapDay", { input: `<input name="cap" type="number" min="0" step="1" value="${box.rules?.cap ?? ""}">` })}</label>
        ${noClockNote({ ...dayOpts(), cap: box.rules?.cap })}
        ${pityRow(box.rules?.pity, { noun: "throws", esc })}
        <label class="lc-row"><input type="checkbox" name="noDuplicates" ${box.rules?.noDuplicates ? "checked" : ""}> ${t("LOOTCRATES.Manager.NoDuplicates")}</label>
      </fieldset>
      ${shelfFieldHTML(box, opts)}`, {
      onForm: form => {
        const shelf = wireShelf(form, isNew);
        liveOdds(form, box, poolIds, (draft, live) => {
          const preview = wellPreview(draft, live);
          return { html: wellPreviewHTML(preview, esc), summary: wellSummary(preview), held: heldRarities(draft, live) };
        }, draftWell, shelf);
      },
      position: { width: 460 },
      okLabel: saveLabel(isNew),
      guard: editorGuardOf(box, isNew),
    });
    if (!data) return;
    const draft = draftWell(box, data, poolIds);
    return this.#saveEditor(box, isNew, fresh => ({
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
    }), data);
  }

  /*
    The dice game's editor: the stake as an amount of one coin, the dice
    (2d6 or 3d6), the dragon's number and the multiplier, with the shop's
    own win and lose pills and the payout as a live preview; then the
    perfect-roll prize, its pools and rarity weights. The preview warns
    when the dragon can't be beaten (the shop refuses such a game). Nothing
    is written until Save.
  */
  static async #editDice(box, opts) {
    const { isNew } = opts;
    const pools = Object.values(getPools());
    const poolIds = pools.map(p => p.id);
    const stake = stakeCoins(box.price);
    const dice = { ...DICE_DEFAULTS, ...(box.dice ?? {}) };
    const data = await promptForm(editorTitle(box, isNew, opts.copy), `
      <label>${t("LOOTCRATES.Manager.Name")} <input name="name" value="${esc(box.name)}"${autofocus("name", opts)}></label>
      ${stakeRow(stake, esc)}
      <fieldset><legend>${t("LOOTCRATES.Manager.BeatDragon")}</legend>
        ${dragonRow(FORMULAS, dice, esc)}
        <label class="lc-row">${t("LOOTCRATES.Manager.WinPays", { input: `<input name="multiplier" type="number" min="0" step="0.5" value="${esc(dice.multiplier)}">` })}</label>
        <p class="lc-form__hint">${t("LOOTCRATES.Manager.TieLoses")}</p>
      </fieldset>
      <div class="lc-form__odds" role="group" aria-labelledby="lc-odds-${esc(box.id)}">
        <div class="lc-form__label" id="lc-odds-${esc(box.id)}">${t("LOOTCRATES.Manager.ChancesSeen")}</div>
        <div class="lc-form__preview"></div>
        <p class="lc-sr-only" role="status" aria-live="polite"></p>
      </div>
      <fieldset><legend>${t("LOOTCRATES.Manager.Prize")}</legend>
        <label class="lc-row"><input type="checkbox" name="prize" ${box.rules?.prize ? "checked" : ""}> ${t("LOOTCRATES.Manager.PrizeField")}</label>
      </fieldset>
      ${poolsFieldset(t("LOOTCRATES.Manager.PoolsPrize"), pools, box.pools, { esc })}
      <fieldset class="lc-form__weights"><legend>${t("LOOTCRATES.Manager.PrizeRarityWeights")}</legend>
        ${RARITIES.map(r => `<label class="lc-row">${RARITY_LABEL[r]} <input name="w.${r}" type="number" min="0" step="1" value="${esc(box.weights?.[r] ?? DEFAULT_WEIGHTS[r])}"><span class="lc-form__hint" data-held="${r}"></span></label>`).join("")}
      </fieldset>
      ${limitsFieldset(box, { stock: false, draft: isNew, ...dayOpts(), esc })}
      ${shelfFieldHTML(box, opts)}`, {
      onForm: form => {
        const shelf = wireShelf(form, isNew);
        liveOdds(form, box, poolIds, (draft, live) => {
          const preview = dicePreview(draft, live);
          return { html: dicePreviewHTML(preview, esc), summary: diceSummary(preview), held: heldRarities(draft, live) };
        }, draftDice, shelf);
      },
      position: { width: 460 },
      okLabel: saveLabel(isNew),
      guard: editorGuardOf(box, isNew),
    });
    if (!data) return;
    const draft = draftDice(box, data, poolIds);
    return this.#saveEditor(box, isNew, fresh => ({
      ...fresh,
      kind: "dice",
      name: data.name || fresh.name,
      price: stakeGp(data.stake, data.coin),
      pools: draft.pools.filter(ref => ref.id in getPools()),
      weights: draft.weights,
      dice: draft.dice,
      rules: { ...fresh.rules, prize: draft.rules.prize, perCharacter: perCharacterFromForm(data) },
    }), data);
  }

  /*
    The deck's editor: the first draw's price, the step each draw in a row
    multiplies it by and the minutes within which draws count as in a row
    (deck.js deckRiseFieldsHTML; blank or 0 for none), then the cards as
    rows (name, what it does, weight, once, the gold for coins and loss,
    the text for an effect) with Add card and a remove on each, the pools and rarity weights the item cards draw
    on, and the shop's own pills as a live preview with the cards left.
    Nothing is written until Save.
  */
  static async #editDeck(box, opts) {
    const { isNew } = opts;
    const pools = Object.values(getPools());
    const poolIds = pools.map(p => p.id);
    const data = await promptForm(editorTitle(box, isNew, opts.copy), `
      <label>${t("LOOTCRATES.Manager.Name")} <input name="name" value="${esc(box.name)}"${autofocus("name", opts)}></label>
      ${priceFieldHTML(t("LOOTCRATES.Manager.FirstDraw"), box, opts)}
      ${deckRiseFieldsHTML(box, esc)}
      <fieldset class="lc-cards"><legend>${t("LOOTCRATES.Manager.Cards")}</legend>
        <div class="lc-cards__head" aria-hidden="true"><span>${t("LOOTCRATES.Manager.CardHead")}</span><span>${t("LOOTCRATES.Manager.DoesHead")}</span><span>${t("LOOTCRATES.Manager.GoldHead")}</span><span>${t("LOOTCRATES.Manager.WeightHead")}</span><span>${t("LOOTCRATES.Manager.OnceHead")}</span><span></span></div>
        <div class="lc-cards__rows">${cardsOf(box).map((c, i) => cardRow(c, i + 1)).join("")}</div>
        <div class="lc-cards__foot"><button type="button" class="lc-cards__add"><i class="fas fa-plus"></i> ${t("LOOTCRATES.Manager.AddCard")}</button></div>
        <p class="lc-form__hint">${t("LOOTCRATES.Manager.CardsHint")}</p>
      </fieldset>
      ${poolsFieldset(t("LOOTCRATES.Manager.PoolsCards"), pools, box.pools, { esc })}
      <fieldset class="lc-form__weights"><legend>${t("LOOTCRATES.Manager.ItemRarityWeights")}</legend>
        ${RARITIES.map(r => `<label class="lc-row">${RARITY_LABEL[r]} <input name="w.${r}" type="number" min="0" step="1" value="${esc(box.weights?.[r] ?? DEFAULT_WEIGHTS[r])}"><span class="lc-form__hint" data-held="${r}"></span></label>`).join("")}
      </fieldset>
      <div class="lc-form__odds" role="group" aria-labelledby="lc-odds-${esc(box.id)}">
        <div class="lc-form__label" id="lc-odds-${esc(box.id)}">${t("LOOTCRATES.Manager.ChancesSeen")}</div>
        <div class="lc-form__preview"></div>
        <p class="lc-sr-only" role="status" aria-live="polite"></p>
      </div>
      ${limitsFieldset(box, { stock: false, draft: isNew, ...dayOpts(), esc })}
      ${shelfFieldHTML(box, opts)}`, {
      onForm: form => {
        const shelf = wireShelf(form, isNew);
        wirePrice(form);
        const paint = liveOdds(form, box, poolIds, (draft, live) => {
          const preview = deckPreview(draft, live, getLog());
          return { html: deckPreviewHTML(preview, esc), summary: deckSummary(preview), held: heldRarities(draft, live) };
        }, draftDeck, shelf);
        const rows = form.querySelector(".lc-cards__rows");
        // Add card: a blank row at the foot, its name focused. Remove: the
        // row goes and focus moves to the next row's name, else Add card.
        form.querySelector(".lc-cards__add")?.addEventListener("click", () => {
          rows.insertAdjacentHTML("beforeend", cardRow({ id: foundry.utils.randomID(8), label: "", kind: "blank", weight: 1, once: false, gp: 0, text: "" }, rows.childElementCount + 1));
          rows.lastElementChild.querySelector(".lc-card-row__label").focus();
          paint();
        });
        form.addEventListener("click", e => {
          const btn = e.target.closest?.(".lc-card-row__remove");
          if (!btn) return;
          const row = btn.closest(".lc-card-row");
          const next = row.nextElementSibling ?? row.previousElementSibling;
          row.remove();
          renumberCards(rows);
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
      okLabel: saveLabel(isNew),
      guard: editorGuardOf(box, isNew, { free: true }),
    });
    if (!data) return;
    const draft = draftDeck(box, data, poolIds);
    return this.#saveEditor(box, isNew, fresh => ({
      ...fresh,
      kind: "deck",
      name: data.name || fresh.name,
      price: draft.price,
      pools: draft.pools.filter(ref => ref.id in getPools()),
      weights: draft.weights,
      deck: { ...(fresh.deck ?? {}), step: draft.deck.step, streakMinutes: draft.deck.streakMinutes ?? streakMinutesOf(fresh), cards: draft.deck.cards },
      rules: { ...(fresh.rules ?? {}), perCharacter: perCharacterFromForm(data) },
    }), data);
  }

  /*
    The scratch ticket's editor (scratch.js): the price of a ticket, the
    layout (lucky numbers or match 3) and its grid, the bonus spot, the
    roll's size, whether players see what is left in it, Fill the prize
    list (scratchplan.js: a prize list built from a few numbers, written
    into the rows after a confirm when they hold the GM's own), and its
    prize list as rows of count x prize line (one or more parts: coins, an item
    at a rarity from the pools, the bonus spot's gem), with Add prize, Add
    a part and a remove on each; the readout beside it says the odds of
    the roll as printed and what would keep a ticket from being sold, and
    Save stays off while a line can't be shown on the card (scratch.js
    scratchPreview refused); then the pools the item prizes draw from.
    Saving keeps the roll's id: Print a new roll on the Boxes tab starts
    a fresh one. Nothing is written until Save.
  */
  static async #editScratch(box, opts) {
    const { isNew } = opts;
    const pools = Object.values(getPools());
    const poolIds = pools.map(p => p.id);
    const sold = isNew ? 0 : rollState(box, getLog()).sold;
    const data = await promptForm(editorTitle(box, isNew, opts.copy), `
      <label>${t("LOOTCRATES.Manager.Name")} <input name="name" value="${esc(box.name)}"${autofocus("name", opts)}></label>
      ${priceFieldHTML(t("LOOTCRATES.Scratch.PriceField"), box, opts)}
      ${scratchFieldsHTML(box, { esc, sold, fill: fillFieldsHTML(box, { esc }) })}
      <div class="lc-form__odds" role="group" aria-labelledby="lc-odds-${esc(box.id)}">
        <div class="lc-form__label" id="lc-odds-${esc(box.id)}">${t("LOOTCRATES.Scratch.ReadoutLabel")}</div>
        <div class="lc-form__preview"></div>
        <p class="lc-sr-only" role="status" aria-live="polite"></p>
      </div>
      ${poolsFieldset(t("LOOTCRATES.Scratch.PoolsField"), pools, box.pools, { esc })}
      ${limitsFieldset(box, { stock: false, draft: isNew, ...dayOpts(), esc })}
      ${shelfFieldHTML(box, opts)}`, {
      onForm: form => {
        const shelf = wireShelf(form, isNew);
        wirePrice(form);
        const gate = okGate(form);
        const paint = liveOdds(form, box, poolIds, (draft, live) => {
          const preview = scratchPreview(draft, live);
          // Off while a line can't be shown (the price has its own say, wirePrice).
          gate.set("lines", preview.refused);
          return { html: scratchPreviewHTML(preview, esc), summary: scratchSummary(preview), held: preview.held };
        }, draftScratch, shelf);
        wireScratchEditor(form, { newId: () => foundry.utils.randomID(8), paint });
        // Fill the prize list: combinations use only rarities the ticked pools hold.
        wireFill(form, {
          read: () => readForm(form),
          items: values => poolRarities(draftScratch(box, values, poolIds), getPools()),
          newId: () => foundry.utils.randomID(8),
          confirm: text => DialogV2.confirm({ window: { title: t("LOOTCRATES.Scratch.FillToggle") }, content: `<p>${esc(text)}</p>`, rejectClose: false }),
        });
      },
      position: { width: 520 },
      okLabel: saveLabel(isNew),
      guard: editorGuardOf(box, isNew, { free: true }),
    });
    if (!data) return;
    const draft = draftScratch(box, data, poolIds);
    return this.#saveEditor(box, isNew, fresh => ({
      ...fresh,
      kind: "scratch",
      name: data.name || fresh.name,
      price: draft.price,
      pools: draft.pools.filter(ref => ref.id in getPools()),
      weights: draft.weights,
      layout: draft.layout,
      grid: draft.grid,
      bonus: draft.bonus,
      theme: draft.theme,
      showLeft: draft.showLeft,
      // The roll as it is now (Print a new roll may have moved it on while
      // the dialog was open), with the GM's size and prizes.
      roll: { ...(fresh.roll ?? {}), size: draft.roll.size, prizes: draft.roll.prizes },
      rules: { ...(fresh.rules ?? {}), perCharacter: perCharacterFromForm(data) },
    }), data);
  }

  /*
    The wheel's editor (roulette.js): the least and most a bet can be, the
    bets a character gets a round and the betting window; the two colours'
    names; the pockets as rows (their number is their place on the wheel,
    each in one colour and one rarity) with Add pocket and a remove on
    each; what each bet type pays; the item on a rarity band and the pools
    it draws from; the shop's own odds as a live preview. Nothing is
    written until Save.
  */
  static async #editWheel(box, opts) {
    const { isNew } = opts;
    const pools = Object.values(getPools());
    const poolIds = pools.map(p => p.id);
    const colours = coloursOf(box);
    const data = await promptForm(editorTitle(box, isNew, opts.copy), `
      <label>${t("LOOTCRATES.Manager.Name")} <input name="name" value="${esc(box.name)}"${autofocus("name", opts)}></label>
      <fieldset><legend>${t("LOOTCRATES.Manager.Bets")}</legend>
        ${betRangeRow(box.price, maxStakeOf(box), esc)}
        <label class="lc-row">${t("LOOTCRATES.Manager.MaxBets", { input: `<input name="maxBets" type="number" min="0" step="1" value="${esc(maxBetsOf(box))}">` })}</label>
        <label class="lc-row">${t("LOOTCRATES.Manager.Window", { input: `<input name="windowSec" type="number" min="0" step="5" value="${esc(windowMsOf(box) / 1000)}">` })}</label>
      </fieldset>
      <fieldset class="lc-pockets"><legend>${t("LOOTCRATES.Manager.Pockets")}</legend>
        <div class="lc-row lc-pockets__colours"><label>${t("LOOTCRATES.Manager.FirstColour")} <input name="colourA" class="lc-pockets__colour" data-colour="0" value="${esc(colours[0])}"></label><label>${t("LOOTCRATES.Manager.SecondColour")} <input name="colourB" class="lc-pockets__colour" data-colour="1" value="${esc(colours[1])}"></label></div>
        <div class="lc-pockets__rows">${pocketsOf(box).map(p => pocketRow(p, colours)).join("")}</div>
        <div class="lc-cards__foot"><button type="button" class="lc-pockets__add"><i class="fas fa-plus"></i> ${t("LOOTCRATES.Manager.AddPocket")}</button></div>
        <p class="lc-form__hint">${t("LOOTCRATES.Manager.PocketsHint")}</p>
      </fieldset>
      <fieldset><legend>${t("LOOTCRATES.Manager.Payouts")}</legend>
        ${BET_TYPES.map(target => `<label class="lc-row">${esc(BET_TYPE_LABEL[target])} <input name="pay.${target}" type="number" min="0" step="0.5" value="${esc(payoutOf(box, target))}">×</label>`).join("")}
      </fieldset>
      <fieldset><legend>${t("LOOTCRATES.Manager.ItemOnRarity")}</legend>
        <label class="lc-row"><input type="checkbox" name="itemOnRarity" ${itemOnRarity(box) ? "checked" : ""}> ${t("LOOTCRATES.Manager.ItemOnRarityField")}</label>
        ${poolPicks(pools, box.pools, { share: false, esc })}
      </fieldset>
      <div class="lc-form__odds" role="group" aria-labelledby="lc-odds-${esc(box.id)}">
        <div class="lc-form__label" id="lc-odds-${esc(box.id)}">${t("LOOTCRATES.Manager.ChancesSeen")}</div>
        <div class="lc-form__preview"></div>
        <p class="lc-sr-only" role="status" aria-live="polite"></p>
      </div>
      ${shelfFieldHTML(box, opts)}`, {
      onForm: form => {
        const shelf = wireShelf(form, isNew);
        const paint = liveOdds(form, box, poolIds, (draft, live) => {
          const preview = roulettePreview(draft, live);
          return { html: roulettePreviewHTML(preview, esc), summary: rouletteSummary(preview), held: new Set() };
        }, draftRoulette, shelf);
        const rows = form.querySelector(".lc-pockets__rows");
        const names = () => [0, 1].map(i => form.querySelector(`.lc-pockets__colour[data-colour="${i}"]`)?.value.trim() || ROULETTE_DEFAULTS.colours[i]);
        const renumber = () => { [...rows.children].forEach((row, i) => { row.querySelector(".lc-pocket-row__n").textContent = String(i + 1); }); };
        form.querySelector(".lc-pockets__add")?.addEventListener("click", () => {
          const n = rows.childElementCount;
          rows.insertAdjacentHTML("beforeend", pocketRow({ n: n + 1, colour: n % 2, rarity: "common" }, names()));
          rows.lastElementChild.querySelector("select").focus();
          paint();
        });
        form.addEventListener("click", e => {
          const btn = e.target.closest?.(".lc-pocket-row__remove");
          if (!btn) return;
          const row = btn.closest(".lc-pocket-row");
          const next = row.nextElementSibling ?? row.previousElementSibling;
          row.remove();
          renumber();
          (next?.querySelector("select") ?? form.querySelector(".lc-pockets__add"))?.focus();
          paint();
        });
        // The colour selects follow the names as they are typed.
        form.addEventListener("input", e => {
          if (!e.target.matches?.(".lc-pockets__colour")) return;
          const [a, b] = names();
          for (const opt of form.querySelectorAll(".lc-pocket-row__colour option")) opt.textContent = opt.value === "1" ? b : a;
        });
      },
      position: { width: 520 },
      okLabel: saveLabel(isNew),
      guard: editorGuardOf(box, isNew),
    });
    if (!data) return;
    const draft = draftRoulette(box, data, poolIds);
    return this.#saveEditor(box, isNew, fresh => ({
      ...fresh,
      kind: "roulette",
      name: data.name || fresh.name,
      price: draft.price,
      pools: draft.pools.filter(ref => ref.id in getPools()),
      roulette: draft.roulette,
    }), data);
  }

  /*
    The auction's editor (auction.js): the lot, picked from the GM's crates
    (sold sealed, opened for the winner at the hammer) or the items in the
    pools, or dropped onto the editor from the Items sidebar or a
    compendium; the opening bid, the least raise, the reserve (players see
    only whether it is met) and the gavel; the house bidders; what the
    table will see as a live preview. Nothing is written until Save.
  */
  static async #editAuction(box, opts) {
    const { isNew } = opts;
    const choices = auctionLotChoices(box);
    const house = houseOf(box);
    const data = await promptForm(editorTitle(box, isNew, opts.copy), `
      <label>${t("LOOTCRATES.Manager.Name")} <input name="name" value="${esc(box.name)}"${autofocus("name", opts)}></label>
      <fieldset class="lc-auction-lot"><legend>${t("LOOTCRATES.Auction.TheLotLegend")}</legend>
        <label class="lc-field">${t("LOOTCRATES.Auction.WhatIsSold")} <select name="lot" class="lc-auction-lot__pick">${lotOptionsHTML(choices, lotKey(lotOf(box)))}</select></label>
        <div class="lc-auction-lot__drop" data-lot-drop>${t("LOOTCRATES.Auction.DropLot")}</div>
        <p class="lc-form__hint" data-lot-said role="status"></p>
      </fieldset>
      <fieldset><legend>${t("LOOTCRATES.Auction.WordsList")}</legend>
        ${priceFieldHTML(t("LOOTCRATES.Auction.OpeningBidLine"), box, opts)}
        <div class="lc-row lc-row--wrap">${t("LOOTCRATES.Auction.IncrementField", { input: `<input name="increment" type="number" min="0" step="any" value="${esc(incrementOf(box))}" aria-label="${t("LOOTCRATES.Auction.IncrementLabel")}">` })}</div>
        <div class="lc-row lc-row--wrap">${t("LOOTCRATES.Auction.ReserveField", { input: `<input name="reserve" type="number" min="0" step="any" value="${esc(reserveOf(box))}" aria-label="${t("LOOTCRATES.Auction.ReserveLabel")}">` })}</div>
        <div class="lc-row lc-row--wrap">${t("LOOTCRATES.Auction.GavelField", { input: `<input name="gavelSec" type="number" min="${MIN_GAVEL_SEC}" step="1" value="${esc(gavelMsOf(box) / 1000)}" aria-label="${t("LOOTCRATES.Auction.GavelLabel")}">` })}</div>
        <p class="lc-form__hint">${t("LOOTCRATES.Auction.BidsHint")}</p>
      </fieldset>
      <fieldset><legend>${t("LOOTCRATES.Auction.HouseLegend")}</legend>
        <div class="lc-row lc-row--wrap">${t("LOOTCRATES.Auction.HouseField", {
          count: `<input name="houseCount" type="number" min="0" max="${MAX_HOUSE}" step="1" value="${esc(house.count)}" aria-label="${t("LOOTCRATES.Auction.HouseCountLabel")}">`,
          budget: `<input name="houseBudget" type="number" min="0" step="any" value="${esc(house.budget)}" aria-label="${t("LOOTCRATES.Auction.HouseBudgetLabel")}">`,
          chance: `<input name="houseChance" type="number" min="0" max="100" step="1" value="${esc(house.chance)}" aria-label="${t("LOOTCRATES.Auction.HouseChanceLabel")}">`,
          every: HOUSE_TICK_MS / 1000,
        })}</div>
        <p class="lc-form__hint">${t("LOOTCRATES.Auction.HouseHint")}</p>
      </fieldset>
      <div class="lc-form__odds" role="group" aria-labelledby="lc-odds-${esc(box.id)}">
        <div class="lc-form__label" id="lc-odds-${esc(box.id)}">${t("LOOTCRATES.Auction.TableSees")}</div>
        <div class="lc-form__preview"></div>
        <p class="lc-sr-only" role="status" aria-live="polite"></p>
      </div>
      ${shelfFieldHTML(box, opts)}`, {
      onForm: form => {
        const shelf = wireShelf(form, isNew);
        wirePrice(form);
        const paint = liveOdds(form, box, [], draft => {
          const preview = auctionPreview(draft);
          return { html: auctionPreviewHTML(preview, esc), summary: auctionSummary(preview), held: new Set() };
        }, (game, values) => draftAuction({ ...game, price: parsePrice(values.price) ?? game.price }, { ...values, price: parsePrice(values.price) ?? game.price }, key => choices.get(key)), shelf);
        // An item dropped on the editor becomes the lot (and a choice of its own).
        const zone = form.querySelector("[data-lot-drop]");
        const said = form.querySelector("[data-lot-said]");
        const pick = form.querySelector(".lc-auction-lot__pick");
        zone?.addEventListener("dragover", e => { e.preventDefault(); zone.classList.add("lc-auction-lot__drop--over"); });
        zone?.addEventListener("dragleave", () => zone.classList.remove("lc-auction-lot__drop--over"));
        zone?.addEventListener("drop", async e => {
          e.preventDefault();
          zone.classList.remove("lc-auction-lot__drop--over");
          let drop;
          try { drop = dragData(e); } catch { drop = null; }
          const item = drop?.type === "Item" && drop.uuid ? await fromUuid(drop.uuid).catch(() => null) : null;
          if (!item || !isLootType(item.type)) { if (said) said.textContent = t("LOOTCRATES.Auction.DropItemOnly"); return; }
          const lot = lotFromEntry(entryFromItem(item, drop.uuid));
          const key = lotKey(lot);
          choices.set(key, lot);
          if (!pick.querySelector(`option[value="${CSS.escape(key)}"]`)) {
            let group = pick.querySelector("optgroup[data-dropped]");
            if (!group) { pick.insertAdjacentHTML("beforeend", `<optgroup label="${t("LOOTCRATES.Auction.DroppedHere")}" data-dropped></optgroup>`); group = pick.querySelector("optgroup[data-dropped]"); }
            group.insertAdjacentHTML("beforeend", `<option value="${esc(key)}">${esc(lot.name)}</option>`);
          }
          pick.value = key;
          if (said) said.textContent = t("LOOTCRATES.Auction.IsTheLot", { name: lot.name });
          paint();
        });
      },
      position: { width: 540 },
      okLabel: saveLabel(isNew),
      guard: editorGuardOf(box, isNew),
    });
    if (!data) return;
    const price = parsePrice(data.price) ?? box.price;
    const draft = draftAuction({ ...box, price }, { ...data, price }, key => choices.get(key));
    return this.#saveEditor(box, isNew, fresh => ({
      ...fresh,
      kind: "auction",
      name: data.name || fresh.name,
      price: draft.price,
      pools: [],
      auction: draft.auction,
    }), data);
  }

  /*
    Delete, confirmed in the kind's own word. A table game's round not yet
    settled is called off first (table.js cancelRound: every open stake
    refunded), then the game goes, so no stake is left in escrow with no
    Spin and no Call it off; the confirm names what the round holds and the
    status line says the refund once. A call-off that fails deletes nothing.
  */
  static async #deleteBox(_e, target) {
    const box = getBoxes()[target.dataset.box];
    if (!box) return this.render();
    const round = liveRoundOf(getRounds(), box.id);
    const content = deleteGameText(box, round ? heldBy(getLog(), round.id) : null, esc);
    if (!await DialogV2.confirm({ window: { title: deleteTitle(box) }, content })) return target.focus?.();
    let cancelled = null;
    if (round) {
      try {
        cancelled = await cancelTableRound(round.id);
      } catch (err) {
        if (!(err instanceof PullError)) console.error(`loot-crates | calling off the round at ${box.name} failed; the game is kept`, err);
        ui.notifications.warn(err instanceof PullError ? t("LOOTCRATES.Manager.NotDeleted", { why: err.message, name: box.name }) : t("LOOTCRATES.Manager.NotDeletedRound", { name: box.name }));
        return target.focus?.();
      }
    }
    await removeBox(box.id);
    await this.render();
    this.#announce(deletedNotice(box, cancelled));
  }

  static async #refund(_e, target) {
    const plan = describeRefund(target.dataset.row);
    if (plan.status === "already") { ui.notifications.info(t("LOOTCRATES.Refund.Already")); this.#focusRow = target.dataset.row; return this.render(); }
    // Winnings the character has spent can't come back: the confirm's
    // place is taken by the sentence naming the shortfall, and nothing is
    // written. Focus returns to the row's Refund, which still stands.
    if (plan.status === "short") {
      await DialogV2.prompt({ window: { title: t("LOOTCRATES.Log.Refund") }, content: `<p>${esc(plan.message)}</p>`, ok: { label: t("LOOTCRATES.Common.Close") }, rejectClose: false });
      return target.focus?.();
    }
    if (plan.status !== "ready") return ui.notifications.warn(plan.message);
    const { row, actor, box } = plan;
    // Every item the play granted: the ones still there are removed, each
    // one already gone is named (refund.js grantedItems).
    const items = plan.items ?? (plan.item ? [plan.item] : []);
    const gone = plan.gone ?? [];
    // A game that paid coins out gives the stake back less the payout; one
    // that paid more than the stake takes the difference back; a coin that
    // already came back (a well's coin return) moves nothing.
    const coins = plan.coins ?? Math.round(row.price * 100);
    const coinsText = coins > 0 ? t("LOOTCRATES.Refund.Return", { price: `<strong>${esc(formatPrice(coins / 100))}</strong>`, name: esc(actor.name) })
      : coins < 0 ? t("LOOTCRATES.Refund.TakeBack", { price: `<strong>${esc(formatPrice(-coins / 100))}</strong>`, name: esc(actor.name) })
      : t("LOOTCRATES.Refund.CoinBack", { name: esc(actor.name) });
    // A play made with a ticket gives the ticket back, and coins only for
    // what it won (refund.js).
    const ticketArgs = { name: esc(actor.name), box: `<strong>${esc(row.boxName)}</strong>`, price: `<strong>${esc(formatPrice(Math.abs(coins) / 100))}</strong>` };
    const money = !row.redeem ? coinsText
      : coins > 0 ? t("LOOTCRATES.Refund.TicketReturn", ticketArgs)
      : coins < 0 ? t("LOOTCRATES.Refund.TicketTakeBack", ticketArgs)
      : t("LOOTCRATES.Refund.TicketBack", ticketArgs);
    const strong = names => listAnd(names.map(n => `<strong>${esc(n)}</strong>`));
    // A Buy to keep: one kept ticket comes out of the pack, its price back.
    const keptBox = `<strong>${esc(row.boxName)}</strong>`;
    const ask = row.keep ? (coins ? t("LOOTCRATES.Keep.RefundAsk", { money: coinsText, box: keptBox }) : t("LOOTCRATES.Keep.RefundAskFree", { name: esc(actor.name), box: keptBox }))
      : items.length && gone.length ? t("LOOTCRATES.Refund.AskRemoveSomeGone", { money, item: strong(items.map(i => i.name)), gone: strong(gone) })
      : items.length ? t("LOOTCRATES.Refund.AskRemove", { money, item: strong(items.map(i => i.name)) })
      : gone.length > 1 ? t("LOOTCRATES.Refund.AskGoneSeveral", { money, items: strong(gone) })
      : gone.length ? t("LOOTCRATES.Refund.AskGone", { money, item: strong(gone) }) : t("LOOTCRATES.Refund.Ask", { money });
    const stockBack = row.roundId || row.redeem ? null : stockAfterRefund(box);
    const stockLine = stockBack != null ? ` ${t("LOOTCRATES.Refund.StockBack", { name: esc(box.name), count: stockBack })}` : "";
    // A throw that gave no item still counted toward the pity (row.before).
    const rules = box && (row.uuid || row.before) ? refundRulesLine({ actorName: actor.name, itemName: row.name, box, ...plan.state }) : "";
    const rulesLine = rules ? ` ${esc(rules)}` : "";
    const ok = await DialogV2.confirm({
      window: { title: t("LOOTCRATES.Log.Refund") },
      content: `<p>${ask}${stockLine}${rulesLine}</p><p>${t("LOOTCRATES.Refund.Once")}</p>`,
    });
    if (!ok) return;
    // The Refund button is gone after the render; land on the row's status.
    this.#focusRow = row.id;
    const done = await refundPull(row.id);
    if (done.status === "refunded") {
      const keys = row.keep ? ["LOOTCRATES.Keep.RefundDone", "LOOTCRATES.Keep.RefundDone"]
        : row.redeem ? ["LOOTCRATES.Refund.DoneTicket", "LOOTCRATES.Refund.DoneTicketRemoved"]
        : coins === 0 ? ["LOOTCRATES.Refund.DoneNoCoins", "LOOTCRATES.Refund.DoneNoCoinsRemoved"]
        : coins > 0 ? ["LOOTCRATES.Refund.DoneReturned", "LOOTCRATES.Refund.DoneReturnedRemoved"]
        : ["LOOTCRATES.Refund.DoneTaken", "LOOTCRATES.Refund.DoneTakenRemoved"];
      ui.notifications.info(t(keys[done.removedItem ? 1 : 0], { box: row.boxName, name: actor.name, price: formatPrice(Math.abs(coins) / 100), item: done.removedItem }));
      await postRefundCard({ row, actor, removedItem: done.removedItem, removedItems: done.removedItems, goneItems: done.goneItems, ticketBack: done.ticketBack });
    } else if (done.status === "already") {
      ui.notifications.info(t("LOOTCRATES.Refund.Already"));
    } else {
      ui.notifications.warn(done.message);
    }
    this.render();
  }

  static async #toggleShop() { await setShopOpen(!isShopOpen()); this.render(); }

  // "View shop": the shop window as it stands (one window, brought forward
  // if open). It opens or closes nothing for the players; the toggle does.
  static async #openShop() {
    try { await openShopWindow(); } catch (err) { console.error("loot-crates | opening the shop failed", err); }
  }

  /*
    A price typed into a Boxes row (boxestable.js priceInputHTML), saved on
    change (Enter, Tab, or leaving the field) as a pool row's weight is:
    read with currency.js parsePrice, written through the write queue onto
    the record as it is then (only the price: a pull's stock or pity
    written meanwhile stays), and shown back as the shop will say it. The
    tab is drawn once the write is heard (so the redraw that follows it has
    nothing new and keeps the line), then the status line says it saved
    (poolview.js savedNotice). One that can't be read, or a wheel's lowest
    bet over its highest, puts the field back and says why there instead.
  */
  async #onPrice(el) {
    const id = el.dataset.boxPrice;
    const box = getBoxes()[id];
    if (!box) return this.render();
    const typed = el.value;
    const price = parsePrice(typed);
    const back = text => { el.value = formatPrice(box.price); this.#announce(text); };
    if (price == null) return back(unreadablePrice(typed));
    const overMax = record => kindOf(record) === "roulette" && maxStakeOf(record) != null && price > maxStakeOf(record);
    if (overMax(box)) return back(wheelOverMax(box));
    if (price === Number(box.price)) { el.value = formatPrice(price); return; }
    let refused = null;
    const saved = await updateBox(id, fresh => {
      if (overMax(fresh)) { refused = fresh; return fresh; }
      return { ...fresh, price };
    });
    if (!saved) return this.render();
    if (refused) { el.value = formatPrice(saved.price); return this.#announce(wheelOverMax(refused)); }
    // The field may have been redrawn by the write's own render meanwhile.
    const live = el.isConnected === false ? null : el;
    if (live && live.value === typed) live.value = formatPrice(saved.price);
    if (live) live.defaultValue = formatPrice(saved.price);
    await this.render();
    this.#announce(savedNotice(saved.name, formatPrice(saved.price)));
  }

  /*
    A row's On the shelf toggle (shelf.js): one click puts a game out for
    the players, or takes it back, through the write queue like any edit;
    every open shop redraws from the write (redraw.js). Focus stays on the
    toggle (focusKey: its action and data-box) and the status line says
    what the players can see now.
  */
  static async #toggleShelf(_e, target) {
    const saved = await updateBox(target.dataset.box, fresh => ({ ...fresh, rules: shelfRules(fresh.rules ?? {}, !onShelf(fresh)) }));
    await this.render();
    if (saved) this.#announce(shelfNotice(saved));
  }

  // The Pull log without the throws that gave nothing (view state only).
  hideMisses = false;
  static #toggleMisses() { this.hideMisses = !this.hideMisses; this.render(); }

  // redraw.js's change count when this render read the settings.
  seen = -1;

  async _renderHTML() {
    this.seen = changeCount();
    const root = document.createElement("div");
    root.className = "lc-manager__body";
    const tabs = MANAGER_TABS;
    root.innerHTML = `
      ${managerNavHTML({ tab: this.tab, shopOpen: isShopOpen() })}
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
    // The Boxes tab takes a roll table and makes a crate of it.
    const boxesDrop = this.tab === "boxes" ? root.querySelector(".lc-tab") : null;
    if (boxesDrop) {
      boxesDrop.addEventListener("dragover", e => { e.preventDefault(); boxesDrop.classList.add("lc-drop--over"); });
      boxesDrop.addEventListener("dragleave", e => { if (!boxesDrop.contains(e.relatedTarget)) boxesDrop.classList.remove("lc-drop--over"); });
      boxesDrop.addEventListener("drop", e => { boxesDrop.classList.remove("lc-drop--over"); this.#onBoxesDrop(e); });
    }
    root.querySelectorAll("[data-drop-pool]").forEach(el => {
      el.addEventListener("dragover", e => { e.preventDefault(); el.classList.add("lc-drop--over"); });
      el.addEventListener("dragleave", () => el.classList.remove("lc-drop--over"));
      el.addEventListener("drop", e => { el.classList.remove("lc-drop--over"); this.#onDrop(e, el.dataset.dropPool); });
    });
    root.addEventListener("change", e => {
      const el = e.target.closest?.("[data-curate]");
      if (el) this.#onCurate(el).catch(err => { console.error(`loot-crates | saving that entry failed`, err); this.render(); });
      const price = e.target.closest?.("[data-box-price]");
      if (price) this.#onPrice(price).catch(err => { console.error(`loot-crates | saving that price failed`, err); this.render(); });
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
    if (!plan) return ui.notifications.warn(t("LOOTCRATES.Manager.DropWhat"));
    if (data.type !== "Item") return this.#previewAdd(poolId, plan);
    if (!plan.entries.length) {
      if (plan.skipped.duplicates) {
        if (pool.entries.some(e => e.uuid === data.uuid)) return this.#pinDrop(poolId, [data.uuid], { duplicate: true });
        return ui.notifications.info(t("LOOTCRATES.Manager.AlreadyIn", { name: plan.label, pool: pool.name }));
      }
      const type = Object.keys(plan.skipped.notLoot)[0];
      return ui.notifications.warn(t("LOOTCRATES.Manager.NotLootType", { name: plan.label, type: SKIPPED_NOUN[type] ?? type }));
    }
    if (await addEntries(poolId, plan.entries)) this.#pinDrop(poolId, plan.entries.map(e => e.uuid));
  }

  // An item dropped on a missing row replaces its source; the weight stays.
  async #onRelink(event, poolId, uuid) {
    event.preventDefault();
    let data;
    try { data = dragData(event); } catch { return; }
    if (data?.type !== "Item" || !data.uuid) return ui.notifications.warn(t("LOOTCRATES.Manager.DropToRelink"));
    return this.#relink(poolId, uuid, data.uuid);
  }

  async #relink(poolId, uuid, newUuid) {
    let item = null;
    try { item = await fromUuid(newUuid); } catch { /* reported below */ }
    if (item?.documentName !== "Item") return ui.notifications.warn(t("LOOTCRATES.Manager.NoSuchUuid", { uuid: newUuid }));
    if (!isLootType(item.type)) return ui.notifications.warn(t("LOOTCRATES.Manager.NotLoot", { name: item.name }));
    const { name, img, rarity, sourceRarity } = entryFromItem(item);
    const done = await patchEntry(poolId, uuid, { uuid: item.uuid, name, img, rarity, sourceRarity });
    if (!done) ui.notifications.info(t("LOOTCRATES.Manager.RelinkDuplicate", { name: item.name, pool: getPools()[poolId]?.name ?? t("LOOTCRATES.Manager.ThatPool") }));
    this.#repaint(poolId, { uuid: done ? item.uuid : uuid });
  }

  async _pools() {
    const stored = getPools();
    const pools = Object.values(stored);
    this.#drawn.clear();
    for (const p of pools) this.#drewPool(p);
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
      <div class="lc-toolbar"><button type="button" data-action="addPool"><i class="fas fa-plus"></i> ${t("LOOTCRATES.Pools.NewPool")}</button><span class="lc-pool__hint lc-manager__status" role="status">${this.checking ? t("LOOTCRATES.Manager.Checking") : ""}</span></div>
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
      }).join("") : starterCallHTML("pools", esc)}`;
  }

  // The Boxes tab (boxestable.js): every New, the tab's status line, and
  // one row per game, its odds as of now, not as of the last pull's sweep.
  // The status line is written after the render (#saveEditor), so a screen
  // reader hears it as a change; a line drawn with the tab would be silent.
  async _boxes() {
    const boxes = Object.values(getBoxes());
    const stored = getPools();
    const entries = Object.keys(stored).flatMap(id => flattenPool(id, stored, new Set(), { includeMissing: true }));
    const pools = withSources(stored, await this.#checkedSources(entries));
    return boxesTabHTML({ boxes, pools, log: getLog(), rounds: getRounds(), recent: this.#recentBox, esc });
  }

  // The Pull log (logtable.js): newest first, every game's misses folded per
  // character and day, a table round's stakes under its line, "Hide misses".
  _log() {
    return logTableHTML({ log: getLog(), rounds: getRounds(), hideMisses: this.hideMisses, esc });
  }

  #searchTimer = null;
  #focusRow = null;
  // The game a New just added: its row's Edit takes focus at the next
  // render (once), and the row keeps its mark until the next New or close.
  #focusBox = null;
  #recentBox = null;

  // A full render (a source check landing late, a rename, a refund) keeps
  // focus on the same control when it is drawn again, and the caret in a
  // search, instead of sending a keyboard or screen-reader user to the top.
  _replaceHTML(result, content) {
    const active = content.contains(document.activeElement) ? document.activeElement : null;
    const key = active ? focusKey(active) : null;
    const typed = active?.matches?.("input[data-box-price]") || active?.matches?.('input[data-curate="weight"]');
    const caret = active?.matches?.('input[type="search"]') || typed ? [active.selectionStart, active.selectionEnd] : null;
    // A price or a weight being typed into (not yet saved: no change yet)
    // when another write redraws the tab keeps what was typed.
    const typing = typed && active.value !== active.defaultValue ? active.value : null;
    // The same tab drawn again (another client's edit, a pull's row) keeps
    // where the GM had scrolled to; a focused control still scrolls into
    // view below. A tab switch starts at the top.
    const was = content.querySelector(".lc-tab");
    const scrollTop = was?.getAttribute("aria-labelledby") === `lc-manager-tab-${this.tab}` ? was.scrollTop : 0;
    content.replaceChildren(result);
    if (scrollTop > 0) { const tab = result.querySelector(".lc-tab"); if (tab) tab.scrollTop = scrollTop; }
    // The Pools tab read the boxes before awaiting the source check, and a
    // box saved elsewhere in that wait was patched into the page this one
    // replaces (refreshManager), so bring the "In X, Y" lines up to date.
    if (this.tab === "pools") this.patchUsers();
    // After a New, the row the game landed on: its Edit focused (the next
    // thing a GM does to a new game) and the row scrolled into view, so
    // the thing just made is the thing on screen, not the foot of a table.
    const boxId = this.#focusBox;
    this.#focusBox = null;
    const edit = boxId && content.querySelector(`.lc-table [data-action="editBox"][data-box="${CSS.escape(boxId)}"]`);
    if (edit) { edit.focus({ preventScroll: true }); edit.closest("tr")?.scrollIntoView?.({ block: "nearest" }); return; }
    // After a refund, focus whatever now stands for that log row: its
    // "refunded <date>" status, or its Refund button if the refund failed.
    const row = this.#focusRow;
    this.#focusRow = null;
    const rowEl = row && content.querySelector(`.lc-table [data-row="${CSS.escape(row)}"]`);
    if (rowEl) return rowEl.focus();
    if (!key) return;
    const again = content.querySelector(key.selector) ?? (key.pool && content.querySelector(`.lc-pool__details[data-pool="${CSS.escape(key.pool)}"] > summary`));
    if (!again) return;
    if (typing != null) again.value = typing;
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
const FOCUS_ATTRS = ["action", "curate", "pool", "uuid", "chip", "tab", "box", "row", "boxPrice"];
const dataAttr = key => `data-${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`;
function focusKey(el) {
  if (el.matches("summary")) {
    const pool = el.closest(".lc-pool__details")?.dataset.pool;
    return pool ? { selector: `.lc-pool__details[data-pool="${CSS.escape(pool)}"] > summary`, pool } : null;
  }
  const attrs = FOCUS_ATTRS.filter(a => el.dataset[a] != null).map(a => `[${dataAttr(a)}="${CSS.escape(el.dataset[a])}"]`);
  const search = el.classList.contains("lc-pool__search") ? ".lc-pool__search" : "";
  if (!attrs.length && !search) return null;
  return { selector: `${el.tagName.toLowerCase()}${search}${attrs.join("")}`, pool: el.dataset.pool ?? el.closest(".lc-pool__details")?.dataset.pool ?? null };
}

const SEARCH_DELAY_MS = 150;

const htmlNode = html => { const target = document.createElement("template"); target.innerHTML = html.trim(); return target.content.firstElementChild; };

// One card of the deck editor (deck.js draftDeck reads these names): the
// row's data-kind decides which of the gold and text fields show. Its
// fields are named for the card's place in the deck, `n` (editorfields.js).
function cardRow(c, n) {
  const id = esc(c.id);
  const name = key => CARD_FIELDS[key](n);
  return `<div class="lc-card-row" data-card="${id}" data-kind="${esc(c.kind)}">
      <input type="hidden" name="cards" value="${id}">
      <input class="lc-card-row__label" name="c.${id}.label" value="${esc(c.label)}" placeholder="${t("LOOTCRATES.Manager.CardNamePlaceholder")}" aria-label="${name("label")}">
      <select class="lc-card-row__kind" name="c.${id}.kind" aria-label="${name("kind")}">${CARD_KINDS.map(k => `<option value="${k}"${k === c.kind ? " selected" : ""}>${esc(CARD_KIND_HINT[k])}</option>`).join("")}</select>
      <input class="lc-card-row__gp" name="c.${id}.gp" type="number" min="0" step="1" value="${esc(c.gp ?? 0)}" aria-label="${name("gp")}" placeholder="${t("LOOTCRATES.Manager.GpPlaceholder")}">
      <input class="lc-card-row__weight" name="c.${id}.weight" type="number" min="0" step="1" value="${esc(c.weight ?? 1)}" aria-label="${name("weight")}">
      <label class="lc-card-row__once"><input type="checkbox" name="c.${id}.once"${c.once ? " checked" : ""} aria-label="${name("once")}"></label>
      <button type="button" class="lc-card-row__remove" aria-label="${t("LOOTCRATES.Pools.RemoveLabel", { name: esc(c.label || t("LOOTCRATES.Manager.ThisCard")) })}" data-tooltip="${t("LOOTCRATES.Pools.Remove")}"><i class="fas fa-xmark" inert></i></button>
      <input class="lc-card-row__text" name="c.${id}.text" value="${esc(c.text ?? "")}" placeholder="${t("LOOTCRATES.Manager.EffectPlaceholder")}" aria-label="${name("text")}">
    </div>`;
}

/*
  The auction editor's lots, by their choice's value: every crate (sold
  sealed), every item in the pools (once each, a missing one left out),
  and the record's own lot when it is neither (an item dropped earlier).
*/
const lotKey = lot => (!lot ? "" : lot.type === "crate" ? `crate:${lot.boxId}` : `item:${lot.uuid}`);
function auctionLotChoices(box) {
  const out = new Map();
  for (const b of Object.values(getBoxes())) if (kindOf(b) === "crate") out.set(lotKey(lotFromCrate(b)), lotFromCrate(b));
  const pools = getPools();
  for (const p of Object.values(pools)) {
    for (const e of flattenPool(p.id, pools)) {
      const lot = lotFromEntry(e);
      if (!out.has(lotKey(lot))) out.set(lotKey(lot), { ...lot, pool: p.name });
    }
  }
  const own = lotOf(box);
  if (own && !out.has(lotKey(own))) out.set(lotKey(own), { ...own, dropped: true });
  return out;
}
function lotOptionsHTML(choices, picked = "") {
  const all = [...choices.entries()];
  const group = (label, list, attr = "") => (list.length ? `<optgroup label="${esc(label)}"${attr}>${list.map(([k, l]) => `<option value="${esc(k)}"${k === picked ? " selected" : ""}>${esc(l.type === "crate" ? l.name : `${l.name}${l.rarity && l.rarity !== "none" ? `, ${RARITY_LABEL[l.rarity] ?? l.rarity}` : ""}${l.pool ? ` (${l.pool})` : ""}`)}</option>`).join("")}</optgroup>` : "");
  return `<option value=""${picked ? "" : " selected"}>${t("LOOTCRATES.Auction.PickLot")}</option>`
    + group(t("LOOTCRATES.Auction.SealedCrates"), all.filter(([, l]) => l.type === "crate"))
    + group(t("LOOTCRATES.Auction.PoolItems"), all.filter(([, l]) => l.type === "item" && !l.dropped))
    + group(t("LOOTCRATES.Auction.DroppedHere"), all.filter(([, l]) => l.dropped), " data-dropped");
}

// One pocket of the wheel editor (roulette.js draftRoulette reads these
// names): its place on the wheel, its colour (named as the GM names them)
// and its rarity.
function pocketRow(p, colours) {
  const id = esc(foundry.utils.randomID(8));
  return `<div class="lc-pocket-row lc-rarity-${esc(p.rarity)}" data-pocket="${id}">
      <input type="hidden" name="pockets" value="${id}">
      <span class="lc-pocket-row__n">${esc(p.n)}</span>
      <select class="lc-pocket-row__colour" name="p.${id}.colour" aria-label="${t("LOOTCRATES.Manager.PocketColour", { n: esc(p.n) })}">${[0, 1].map(c => `<option value="${c}"${c === p.colour ? " selected" : ""}>${esc(colours[c])}</option>`).join("")}</select>
      <select class="lc-pocket-row__rarity" name="p.${id}.rarity" aria-label="${t("LOOTCRATES.Manager.PocketRarity", { n: esc(p.n) })}">${RARITIES.map(r => `<option value="${r}"${r === p.rarity ? " selected" : ""}>${RARITY_LABEL[r]}</option>`).join("")}</select>
      <button type="button" class="lc-pocket-row__remove" aria-label="${t("LOOTCRATES.Manager.RemovePocket", { n: esc(p.n) })}" data-tooltip="${t("LOOTCRATES.Pools.Remove")}"><i class="fas fa-xmark" inert></i></button>
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
  for (const cb of form.querySelectorAll('input[type="checkbox"]')) out[cb.name] = cb.checked;
  return out;
}

// A new game's dialog opens with its name focused (naming it is the first
// job), or the price when the name came from a pool; an edit's opens on
// Save as every DialogV2 does. `autofocus` is read by the <dialog>'s
// show(), the first in tree order winning over the default button's.
const autofocus = (field, { isNew = false, focus = null } = {}) => (isNew && (focus ?? "name") === field ? " autofocus" : "");

/*
  The crate's price and the deck's first draw, typed as the Boxes row and
  the shop say them ("12 gp 5 sp", "5 sp", or a bare number of gold), read
  with currency.js parsePrice. While the field can't be read, the line
  under it says so and the default button is off (wirePrice); once it can,
  leaving the field writes it back the way the shop will show it.
*/
function priceFieldHTML(label, box, opts) {
  const why = `lc-price-why-${esc(box.id)}`;
  return `<label class="lc-form__price">${label} <input name="price" type="text" data-price-field value="${esc(formatPrice(box.price))}" placeholder="${t("LOOTCRATES.Manager.PricePlaceholder")}" autocomplete="off" spellcheck="false" aria-describedby="${why}"${autofocus("price", opts)}></label>
      <p class="lc-form__hint lc-form__hint--warn" id="${why}" data-price-why aria-live="polite"></p>`;
}
function wirePrice(form) {
  const input = form.querySelector("input[data-price-field]");
  if (!input) return;
  const why = form.querySelector("[data-price-why]");
  const gate = okGate(form);
  const check = () => {
    const text = parsePrice(input.value) == null ? unreadablePrice(input.value) : "";
    input.setCustomValidity?.(text);
    input.setAttribute("aria-invalid", text ? "true" : "false");
    if (why && why.textContent !== text) why.textContent = text;
    gate.set("price", !!text);
    return !text;
  };
  input.addEventListener("input", check);
  input.addEventListener("change", () => { if (check()) input.value = formatPrice(parsePrice(input.value)); });
}

// The wheel's lowest bet can't go over its highest (the Boxes row's price).
const wheelOverMax = box => t("LOOTCRATES.Manager.WheelOverMax", { name: box.name, price: formatPrice(maxStakeOf(box)) });

// The default button: "Add to shelf" (or "Add" while the shop is closed)
// puts a new game where players buy; an edit's reads Save.
const saveLabel = isNew => (isNew ? addLabel(isShopOpen()) : t("LOOTCRATES.Common.Save"));

// The On the shelf box and the words on the default button
// (editorguard.js wireShelf): "Add to shelf" while ticked (and the shop
// open), "Add" once unticked, Save for an edit, and "Save off the shelf"
// with the box off and the reason under it while the game can't be played
// (playable.js; liveOdds passes the verdict on every change).
const wireShelf = (form, isNew) => wireShelfBox(form, { isNew, shopOpen: isShopOpen() });

/*
  An editor's guard (editordialog.js): the form as it opened, so Cancel,
  X and Escape ask "Discard your changes to <name>?" (Keep editing the
  default; focus goes back where it was) only once it differs; the name
  is the game's, or for a new one what the GM typed. With `free`, a price
  of 0 asks "Free to play?" once at Save (an edit of a game already free
  doesn't ask); Set a price goes back to the price, selected.
*/
function editorGuardOf(box, isNew, { free = false } = {}) {
  return { name: form => (isNew ? form.querySelector('input[name="name"]')?.value.trim() : "") || box.name, free: free && (isNew || Number(box.price) !== 0) };
}
function guardFor(form, { name, free = false }) {
  const { dirty } = snapshotOf(() => readForm(form));
  const nameNow = () => (typeof name === "function" ? name(form) : name) || t("LOOTCRATES.Shelf.TheGame");
  let freeOk = !free;
  return {
    dirty,
    discard: async () => {
      const back = document.activeElement;
      const words = discardLabels();
      const yes = await DialogV2.confirm({
        window: { title: discardTitle() },
        content: discardHTML(nameNow(), esc),
        yes: { label: words.yes, icon: "fa-solid fa-trash" },
        no: { label: words.no, icon: "fa-solid fa-pen", default: true },
        rejectClose: false,
      });
      if (!yes && back && form.contains(back)) back.focus?.();
      return !!yes;
    },
    beforeSave: async () => {
      const input = form.querySelector("input[data-price-field]");
      if (freeOk || !input || parsePrice(input.value) !== 0) return true;
      const words = freeLabels();
      const yes = await DialogV2.confirm({
        window: { title: freeTitle() },
        content: freeHTML(nameNow(), esc),
        yes: { label: words.yes, icon: "fa-solid fa-check" },
        no: { label: words.no, icon: "fa-solid fa-coins", default: true },
        rejectClose: false,
      });
      if (yes) { freeOk = true; return true; }
      input.focus?.();
      input.select?.();
      return false;
    },
  };
}

// `onForm(form)` runs once, with the dialog's <form>, when it is first on
// screen; `okLabel` is the default button's words (Save unless said);
// `guard` ({ name, free }, guardFor) asks before a changed form is thrown
// away, from the form as onForm left it.
async function promptForm(title, fieldsHtml, { onForm, position, okLabel = t("LOOTCRATES.Common.Save"), guard = null } = {}) {
  const result = await EditorDialog.wait({
    window: { title },
    classes: ["loot-crates", "lc-dialog"],
    ...(position ? { position } : {}),
    // DialogV2 wraps the content in its own <form>, and a nested <form> is
    // dropped by the parser, so the editor's fields sit in a div.
    content: `<div class="lc-form">${fieldsHtml}</div>`,
    buttons: [
      { action: "ok", label: okLabel, default: true, callback: (_e, button) => readForm(button.form ?? button.closest("dialog")?.querySelector("form")) },
      { action: "cancel", label: t("LOOTCRATES.Common.Cancel"), callback: () => null },
    ],
    rejectClose: false,
    render: onForm || guard ? (_e, dialog) => {
      const form = dialog.element?.querySelector(".lc-form")?.closest("form");
      if (!form || form.dataset.lcReady) return;
      form.dataset.lcReady = "1";
      onForm?.(form);
      if (guard) dialog.lcGuard = guardFor(form, guard);
    } : undefined,
  });
  // DialogV2 resolves a button whose callback gives nothing to its action
  // name, so Cancel arrives as the string "cancel", not null (closing the
  // dialog gives null). Only the form's values are a Save; anything else
  // writes nothing. Before this a Cancel reached the editors' save path
  // as a string, which built a record with no fields from it.
  return result && typeof result === "object" ? result : null;
}

/*
  The box editor's odds, live: on every input and change, the draft box the
  form would save (boxcard.js draftBox) is drawn with the shop's own ribbon
  and pills against the stored pools (so missing and 0-weight entries are
  left out, as the shop leaves them out), and each weight whose rarity the
  ticked pools don't hold says so. Nothing is written until Save. `shelf`
  (wireShelf) hears whether the draft can be played (playable.js), so the
  On the shelf box and the default button follow it.
*/
function liveOdds(form, box, poolIds, previewOf = cratePreview, draftOf = draftBox, shelf = null) {
  const out = form.querySelector(".lc-form__preview");
  const status = form.querySelector(".lc-form__odds [role=status]");
  let shown = null;
  let announce = null;
  const paint = () => {
    syncShares(form);
    const draft = draftOf(box, readForm(form), poolIds);
    const preview = previewOf(draft, getPools());
    shelf?.(unplayableReason(draft, getPools()));
    if (preview.html !== shown) { out.innerHTML = preview.html; shown = preview.html; }
    // The picture follows every keystroke; a screen reader hears one line,
    // once the GM stops typing (the opening odds go unsaid).
    if (!announce) announce = quietAnnouncer(text => { if (status) status.textContent = text; }, { last: preview.summary });
    else announce(preview.summary);
    for (const el of form.querySelectorAll("[data-held]")) {
      el.textContent = draft.pools.length && !preview.held.has(el.dataset.held) ? t("LOOTCRATES.Manager.NoneInPools") : "";
    }
    // Drawing by the table's odds, the rarity weights do nothing: they go
    // (still in the form, so Save keeps them for a switch back).
    const weights = form.querySelector(".lc-form__weights");
    if (weights && form.querySelector('input[name="oddsMode"]')) weights.hidden = oddsModeOf(draft) === "weight";
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
  in the nav, so every tab shows it. A pools change shows on the Boxes tab,
  whose odds read the pools, and on the Pools tab, where refreshManager
  leaves out a change the tab already drew in place (its own edits:
  CrateManager.showsPools), so another client's pool, rename or entry edit
  is drawn there and then. A full render keeps each pool's open state,
  search, chip and rows shown (#view), focus and a typed search, price or
  weight (_replaceHTML). On the Pools tab a boxes change patches only the
  pools' "In X, Y" lines, and only those that differ
  (CrateManager.patchUsers). The pity state shows nowhere here (each
  buyer's shop shows their own). The log shows on the Boxes tab too while
  a deck or a scratch ticket is on it: a deck's row reads its cards drawn
  and its odds from the log (deck.js deckOdds), a scratch ticket's its
  roll's tickets and prizes left (scratch.js rollState), so a play or a
  refund redraws it there and then.
  The rounds show there too while a wheel is on it: its row's button reads
  "Open a round" or "Go to the table" from them (round.js liveRoundOf), so
  a round opened or spun from the table window changes it there and then.
*/
export function managerShows(tab, key, boxes = {}) {
  if (key === SETTINGS.SHOP_OPEN) return true;
  const has = kind => Object.values(boxes ?? {}).some(b => kindOf(b) === kind);
  if (key === SETTINGS.LOG) return tab === "log" || (tab === "boxes" && (has("deck") || has("scratch")));
  if (key === SETTINGS.ROUNDS) return tab === "log" || (tab === "boxes" && (has("roulette") || has("auction")));
  if (key === SETTINGS.POOLS) return tab === "boxes" || tab === "pools";
  if (key === SETTINGS.BOXES) return tab === "boxes";
  return false;
}

// A pool as the Pools tab draws it, in two parts (CrateManager.showsPools).
const headKey = pool => JSON.stringify({ ...pool, entries: undefined });
const bodyKey = pool => JSON.stringify(pool?.entries ?? []);

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
  const boxes = manager.tab === "boxes" && (list.includes(SETTINGS.LOG) || list.includes(SETTINGS.ROUNDS)) ? getBoxes() : {};
  // The Pools tab draws its own edits in place: a pools change it already shows isn't drawn again.
  const drawn = manager.tab === "pools" && list.includes(SETTINGS.POOLS) && manager.showsPools();
  if (list.some(k => managerShows(manager.tab, k, boxes) && !(drawn && k === SETTINGS.POOLS))) manager.render();
  else if (manager.tab === "pools" && list.some(k => USERS_KEYS.includes(k))) manager.patchUsers();
}

let manager = null;
export function openManager() {
  manager ??= new CrateManager();
  manager.render({ force: true });
  return manager;
}

// "Make a crate" from the sidebar's menu on a roll table: the manager opens
// on its Boxes tab and runs CrateManager#makeCrateFromTable.
export function makeCrateFromTable(uuid) {
  manager ??= new CrateManager();
  return manager.makeCrateFromTable(uuid);
}

// "Add starter crates" from outside the manager (the module API, the GM's
// welcome): the manager opens on its Boxes tab and presses it.
export async function addStarterCrates() {
  manager ??= new CrateManager();
  if (!manager.rendered) { manager.tab = "boxes"; await manager.render({ force: true }); }
  return manager.addStarterCrates();
}

/*
  The Roll Tables sidebar's menu entry (main.js, Foundry's
  get<Document>ContextOptions hook for a RollTable entry), for a GM only,
  in the shape both v13 and v14 read (route.js directoryMenuEntry).
*/
export function makeCrateMenuEntry() {
  return directoryMenuEntry({
    label: t("LOOTCRATES.Manager.MakeCrate"),
    icon: '<i class="fa-solid fa-box-open"></i>',
    visible: () => !!game.user?.isGM,
    run: id => {
      const table = game.tables?.get(id);
      if (table) makeCrateFromTable(table.uuid).catch(err => console.error("loot-crates | making a crate from a roll table failed", err));
    },
  });
}
