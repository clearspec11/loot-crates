/*
  World-scoped storage for pools, boxes, the pull log and per-actor state,
  behind Foundry's settings. Everything here is GM-only to write; the socket
  handler is the one place that writes on a player's behalf.

  Pools hold references (UUIDs), never copies, so an item edited at its source
  is what gets granted. A reference whose source is gone resolves to null; the
  sweep below flags its entry `missing: true`, which takes it out of the roll,
  the odds and the strip (odds.js flattenPool), and warns the GM. The pool
  editor checks the sources again on every render (checkSources) and shows
  each entry as missing or renamed, with Remove, Update and Relink.
*/
import { MODULE_ID, SETTINGS } from "./config.js";
import { normalizeRarity, flattenPool, markEntriesMissing, rawRarityOf, sourceRarityOf, curateEntries } from "./odds.js";
import { dayKeyOf } from "./clock.js";
import { pruneRounds } from "./round.js";

const uid = () => (globalThis.foundry?.utils?.randomID?.(10)) ?? Math.random().toString(36).slice(2, 12);

/*
  Every client hears when one of the world settings changes (Foundry calls a
  setting's onChange on each client after the GM's write lands), so open
  windows can redraw: a player's shop when the GM closes it or a crate sells
  out, the GM's Pull log when a pull or a late cancel writes a row. The one
  listener is set by main.js (redraw.js), so this file imports no UI; it is
  told the setting's key.
*/
let storeListener = null;
export function setStoreListener(fn) { storeListener = fn; }
function storeChanged(key) {
  try { storeListener?.(key); } catch (err) { console.error(`loot-crates | redrawing after ${key} changed failed`, err); }
}
export const WORLD_KEYS = [SETTINGS.POOLS, SETTINGS.BOXES, SETTINGS.LOG, SETTINGS.STATE, SETTINGS.SHOP_OPEN, SETTINGS.ROUNDS];

export function registerSettings() {
  const world = (key, type, def) => game.settings.register(MODULE_ID, key, { scope: "world", config: false, type, default: def, onChange: () => storeChanged(key) });
  world(SETTINGS.POOLS, Object, {});
  world(SETTINGS.BOXES, Object, {});
  world(SETTINGS.LOG, Array, []);
  world(SETTINGS.STATE, Object, {});
  world(SETTINGS.SHOP_OPEN, Boolean, true);
  world(SETTINGS.ROUNDS, Object, {});
  game.settings.register(MODULE_ID, SETTINGS.SOUND, {
    name: "Crate sounds",
    hint: "Play the tick, slow-down and reveal sounds when a crate opens.",
    scope: "client", config: true, type: Boolean, default: true,
  });
}

/*
  The rarity fields every compendium index read here asks for, also added to
  the fields Foundry indexes for every Item pack (dnd5e does the same with
  its own at init). Foundry v14's getIndex reuses a pack's index only when
  the fields asked for are a subset of the last fetch's, and replaces that
  set rather than merging it, so two callers asking for different lists (the
  pool editor, the pre-pull sweep, dnd5e's compendium browser) each throw
  the other's index away and refetch the whole pack, seconds each time.
  With both fields registered, the index Foundry builds at load already has
  them and every read here is a cache hit. system.rarities is dnd5e 6's;
  system.rarity is what packs built before its migration (dnd5e.items among
  them) and dnd5e 5 still store.
*/
export const RARITY_FIELDS = ["system.rarities", "system.rarity"];
export const INDEX_FIELDS = [...RARITY_FIELDS, "img", "folder"];

export function registerIndexFields() {
  const fields = globalThis.CONFIG?.Item?.compendiumIndexFields;
  if (!Array.isArray(fields)) return;
  for (const f of RARITY_FIELDS) if (!fields.includes(f)) fields.push(f);
}

// Every GM-side write path (a pull from socket.js, a refund from refund.js)
// runs through this one queue, one task at a time. Each of those is a
// read-modify-write of the purse, the stock and the log across awaits, so two
// of them in flight together would both read the same purse and one write
// would be lost: a refund landing during a pull on the same actor handed the
// item over for free. A task's failure doesn't block the next one.
let tail = Promise.resolve();
export function enqueueWrite(task) {
  const run = tail.catch(() => {}).then(task);
  tail = run;
  return run;
}

const get = key => foundry.utils.deepClone(game.settings.get(MODULE_ID, key));
const set = (key, value) => game.settings.set(MODULE_ID, key, value);

// The in-game day's key from the world's clock (clock.js), for anything
// counted per day; null in a world with no clock.
export const todayKey = () => dayKeyOf(globalThis.game?.time ?? null);

export const getPools = () => get(SETTINGS.POOLS);
export const getBoxes = () => get(SETTINGS.BOXES);
export const getLog = () => get(SETTINGS.LOG);
export const isShopOpen = () => game.settings.get(MODULE_ID, SETTINGS.SHOP_OPEN);
export const setShopOpen = open => set(SETTINGS.SHOP_OPEN, !!open);

export async function savePool(pool) {
  const pools = getPools();
  const id = pool.id ?? uid();
  pools[id] = { name: "New pool", entries: [], pools: [], ...pool, id };
  await set(SETTINGS.POOLS, pools);
  return pools[id];
}

export async function deletePool(id) {
  const pools = getPools();
  delete pools[id];
  for (const p of Object.values(pools)) p.pools = (p.pools ?? []).filter(c => c !== id);
  await set(SETTINGS.POOLS, pools);
  const boxes = getBoxes();
  for (const b of Object.values(boxes)) b.pools = (b.pools ?? []).filter(ref => ref.id !== id);
  await set(SETTINGS.BOXES, boxes);
}

export async function saveBox(box) {
  const boxes = getBoxes();
  const id = box.id ?? uid();
  boxes[id] = { name: "New box", price: 100, pools: [], weights: {}, rules: {}, ...box, id };
  await set(SETTINGS.BOXES, boxes);
  return boxes[id];
}

export async function deleteBox(id) {
  const boxes = getBoxes();
  delete boxes[id];
  await set(SETTINGS.BOXES, boxes);
}

/*
  The manager's pool and box edits. Each runs in the shared write queue and
  applies only what the GM changed to the setting as it is now, not to the
  copy read when the dialog opened: a pull can lower a box's stock, a sweep
  can flag an entry missing and a drop can add hundreds of entries while a
  dialog is open, and writing that stale copy back would undo them.
  `edit(fresh)` returns the new box from the current one; updatePool takes
  either a patch or such a function (the per-entry rarity and weight edits
  use one, so they change only the entries the GM touched).
*/
export const createPool = pool => enqueueWrite(() => savePool(pool));
export const removePool = id => enqueueWrite(() => deletePool(id));
export const createBox = box => enqueueWrite(() => saveBox(box));
export const removeBox = id => enqueueWrite(() => deleteBox(id));
export function updatePool(id, patch) {
  return enqueueWrite(async () => {
    const pools = getPools();
    if (!pools[id]) return null;
    const next = typeof patch === "function" ? patch(pools[id]) : { ...pools[id], ...patch };
    pools[id] = { ...next, id };
    await set(SETTINGS.POOLS, pools);
    return pools[id];
  });
}
export function updateBox(id, edit) {
  return enqueueWrite(async () => {
    const boxes = getBoxes();
    if (!boxes[id]) return null;
    boxes[id] = { ...edit(boxes[id]), id };
    await set(SETTINGS.BOXES, boxes);
    return boxes[id];
  });
}

export function getActorState(actorId, boxId) {
  return get(SETTINGS.STATE)[`${actorId}.${boxId}`] ?? {};
}

export async function setActorState(actorId, boxId, state) {
  const all = get(SETTINGS.STATE);
  all[`${actorId}.${boxId}`] = state;
  await set(SETTINGS.STATE, all);
}

// Returns the new row's id, which the pull's chat card keeps (flags logId)
// so a refund can find the card that announced it.
// `entry.id` may be set beforehand (newId): a pull's reveal carries the row's
// id before the row is written.
export const newId = uid;
export async function appendLog({ id = uid(), ...entry }) {
  const log = getLog();
  log.unshift({ id, at: Date.now(), ...entry });
  await set(SETTINGS.LOG, log.slice(0, 500));
  return id;
}

export async function updateLog(id, patch) {
  const log = getLog();
  const row = log.find(r => r.id === id);
  if (row) Object.assign(row, patch);
  await set(SETTINGS.LOG, log);
}

// Several rows in one write (a table round's resolve): Map or entries of id -> patch.
export async function updateLogRows(patches) {
  const by = new Map(patches);
  if (!by.size) return;
  const log = getLog();
  for (const row of log) if (by.has(row.id)) Object.assign(row, by.get(row.id));
  await set(SETTINGS.LOG, log);
}

// The table rounds (round.js), by id. Written only inside the write queue.
export const getRounds = () => get(SETTINGS.ROUNDS) ?? {};
export async function saveRound(round) {
  await saveRounds([round]);
  return round;
}
export async function saveRounds(list) {
  const rounds = getRounds();
  for (const round of list) rounds[round.id] = round;
  await set(SETTINGS.ROUNDS, pruneRounds(rounds));
}

// A pool entry from an Item document or a compendium index row. The
// source's rarity is kept as it was ("" when unset) so the pool editor can
// tell "no rarity set" from a real Common; `rarity` is its dnd5e key.
export function entryFromItem(item, uuid = item.uuid) {
  const sourceRarity = rawRarityOf(item.system) ?? "";
  return {
    uuid,
    name: item.name,
    img: item.img,
    rarity: normalizeRarity(sourceRarity),
    sourceRarity,
    weight: 1,
  };
}

/*
  Item types that can sit in an inventory as loot (dnd5e's physical types).
  Spells, features, classes, subclasses, backgrounds, species and facilities
  are documents a GM can drag but never something a crate should hand out.
*/
export const LOOT_TYPES = ["weapon", "equipment", "consumable", "tool", "loot", "container"];
const LOOT = new Set(LOOT_TYPES);
export const isLootType = type => LOOT.has(type);

const compendiumUuid = (packId, row) => row.uuid ?? `Compendium.${packId}.Item.${row._id}`;
const entryFromRow = (packId, row) => entryFromItem(row, compendiumUuid(packId, row));

/*
  A pack's index with INDEX_FIELDS, fetched at most once at a time. When
  Foundry has already indexed every field it is configured for and those
  include ours (registerIndexFields ran at init), pack.index is used as it
  is; otherwise one getIndex with the one field list, shared by every caller
  that asks while it is in flight.
*/
const fetching = new WeakMap();
const indexReady = (pack, fields = INDEX_FIELDS) => {
  const have = pack.indexFields;
  return !!(pack.indexed && have?.has && fields.every(f => have.has(f)));
};
// `extra` fields (the starter crates' item subtype) are asked for on top
// of ours, a superset, so the next plain read is still a cache hit.
function loadIndex(pack, extra = []) {
  const fields = extra.length ? [...INDEX_FIELDS, ...extra] : INDEX_FIELDS;
  if (indexReady(pack, fields)) return Promise.resolve(pack.index);
  let run = fetching.get(pack);
  if (!run) {
    run = pack.getIndex({ fields }).finally(() => fetching.delete(pack));
    fetching.set(pack, run);
  }
  return run;
}

/*
  A pack's index rows, each physical item's row sure to carry its rarity.
  Foundry re-indexes a document it has loaded (a pull, the spin, an opened
  sheet) with only the fields of the last index fetch, so a row indexed
  without our fields (a fetch before registerIndexFields ran) has neither
  rarity field. Read as is, that item would go into a pool as common and a
  rarity filter would skip it. Only those rows are read from their documents
  (cached once loaded); a row whose rarity is "" or an empty set is known.
*/
async function indexWithRarity(pack, extra = []) {
  const index = await loadIndex(pack, extra);
  const lost = [...index].filter(r => isLootType(r.type) && rawRarityOf(r.system) === null);
  if (!lost.length) return index;
  const docs = await pack.getDocuments({ _id__in: lost.map(r => r._id) });
  const rarity = new Map(docs.map(d => [d.id, rawRarityOf(d.system) ?? ""]));
  const fixed = new Map(lost.map(r => [r._id, { ...r, system: { ...r.system, rarity: rarity.get(r._id) } }]));
  return [...index].map(r => fixed.get(r._id) ?? r);
}

// A pack's index rows with their rarity and `extra` fields, for the
// starter crates' builder (starterbuild.js).
export const indexRows = async (pack, extra = []) => [...await indexWithRarity(pack, extra)];

/*
  Adds new pools and games in one queued task (the starter crates): one
  write of each setting, read fresh, so nothing written meanwhile is lost
  and every client redraws once. Returns what was written.
*/
export function addRecords({ pools = [], boxes = [] } = {}) {
  return enqueueWrite(async () => {
    if (pools.length) {
      const all = getPools();
      for (const p of pools) all[p.id] = { entries: [], pools: [], ...p };
      await set(SETTINGS.POOLS, all);
    }
    if (boxes.length) {
      const all = getBoxes();
      for (const b of boxes) all[b.id] = b;
      await set(SETTINGS.BOXES, all);
    }
    return { pools, boxes };
  });
}

/*
  Bulk source: every item in a compendium that passes the filter.
  filter: { types: ["weapon", "equipment"], rarities: ["uncommon"], name: "wand" }
*/
export async function entriesFromCompendium(packId, filter = {}) {
  return (await compendiumEntries(packId, filter)).map(({ type: _type, ...e }) => e);
}

// The same, each entry carrying its item type so a drop can count what it skips.
async function compendiumEntries(packId, filter = {}) {
  const pack = game.packs.get(packId);
  if (!pack || pack.documentName !== "Item") return [];
  const index = await indexWithRarity(pack);
  const types = new Set(filter.types ?? []);
  const rarities = new Set((filter.rarities ?? []).map(normalizeRarity));
  const needle = (filter.name ?? "").trim().toLowerCase();
  const out = [];
  for (const row of index) {
    if (types.size && !types.has(row.type)) continue;
    const rarity = normalizeRarity(rawRarityOf(row.system));
    if (rarities.size && !rarities.has(rarity)) continue;
    if (needle && !row.name.toLowerCase().includes(needle)) continue;
    out.push({ ...entryFromRow(packId, row), type: row.type });
  }
  return out;
}

// Whether a compendium is a pack of loot: at least half its items are
// physical. Reads the index Foundry loads at startup, so the compendium picker
// can leave out packs of spells and class features. "Any physical item" isn't
// enough: dnd5e's spell and feature packs each carry a stray weapon (a
// conjured blade, an unarmed strike) and monster features are mostly bites.
export function packHasLoot(pack) {
  if (pack?.documentName !== "Item") return false;
  let loot = 0, all = 0;
  for (const row of pack.index ?? []) { all++; if (isLootType(row.type)) loot++; }
  return loot > 0 && loot * 2 >= all;
}

/*
  What a drop on a pool would add, before anything is written:
    { label, entries, skipped: { duplicates, notLoot: { spell: 3, ... }, notItems } }
  `data` is Foundry's drag data:
    Item        { type: "Item", uuid }                    one item
    Folder      { type: "Folder", uuid }                  an Items folder (world or
                inside a compendium) with all its subfolders, or a sidebar folder
                of compendiums (every Item pack in it)
    Compendium  { type: "Compendium", collection }         a whole pack (the bulk
                filter passes `filter` too, as for entriesFromCompendium)
    RollTable   { type: "RollTable", uuid }               the table's Item results,
                each result's weight as the entry's weight; a result that
                rolls another table brings that table's items, their weights
                multiplied through (flattenTable); text results are counted
                in `text` (their share of the table in textChance), results
                pointing at other documents in notItems, tables nested too
                deep or rolling a table above them in tooDeep, nested tables with
                no results in emptyTables
  Anything that isn't a physical item type is left out and counted by type;
  so are entries whose uuid is in `known` (already in the pool) or repeats
  within the drop (a table's repeats add their weights together).
  A table's drop also says how many nested tables it flattened
  (`flattened`) and what share of the table its text results are
  (`textChance`: their weight against theirs and the items' that go in),
  which "Make a crate" can count as a pull that finds nothing.
  Returns null for drag data this can't use.
*/
export async function entriesFromDrop(data, { known = [] } = {}) {
  const found = await collectDrop(data);
  if (!found) return null;
  const have = new Set(known);
  const skipped = { duplicates: 0, notLoot: {}, notItems: found.notItems ?? 0, text: found.text ?? 0, tooDeep: found.tooDeep ?? 0, emptyTables: found.emptyTables ?? 0 };
  const byUuid = new Map();
  for (const { type, ...entry } of found.entries) {
    if (type && !isLootType(type)) { skipped.notLoot[type] = (skipped.notLoot[type] ?? 0) + 1; continue; }
    if (have.has(entry.uuid)) { skipped.duplicates++; continue; }
    const seen = byUuid.get(entry.uuid);
    if (seen) { if (found.sumWeights) seen.weight += entry.weight; continue; }
    byUuid.set(entry.uuid, entry);
  }
  const entries = [...byUuid.values()];
  const plan = { label: found.label, kind: data.type, entries, skipped };
  if (data.type === "RollTable") {
    const items = entries.reduce((n, e) => n + e.weight, 0);
    const text = found.textWeight ?? 0;
    Object.assign(plan, { uuid: found.uuid ?? data.uuid, flattened: found.flattened ?? 0, textWeight: text, textChance: text > 0 && items > 0 ? text / (text + items) : 0 });
  }
  return plan;
}

async function collectDrop(data) {
  switch (data?.type) {
    case "Item": {
      const item = data.uuid ? await resolveEntry(data) : null;
      if (!item) return null;
      return { label: item.name, entries: [{ ...entryFromItem(item), type: item.type }] };
    }
    case "Compendium": {
      const pack = game.packs.get(data.collection ?? data.id);
      if (pack?.documentName !== "Item") return null;
      return { label: pack.metadata?.label ?? pack.collection, entries: await compendiumEntries(pack.collection, data.filter) };
    }
    case "Folder": {
      const folder = data.uuid ? await resolveEntry(data) : null;
      if (!folder) return null;
      if (folder.type === "Compendium") {
        const ids = new Set([folder.id, ...folder.getSubfolders(true).map(f => f.id)]);
        const packs = game.packs.filter(p => p.documentName === "Item" && ids.has(p.folder?.id ?? p.folder));
        const entries = [];
        for (const p of packs) entries.push(...await compendiumEntries(p.collection));
        return { label: folder.name, entries };
      }
      if (folder.type !== "Item") return null;
      const folders = [folder, ...folder.getSubfolders(true)];
      if (folder.pack) {
        const ids = new Set(folders.map(f => f.id));
        const pack = game.packs.get(folder.pack);
        const index = pack ? await indexWithRarity(pack) : null;
        const rows = [...(index ?? [])].filter(r => ids.has(r.folder?.id ?? r.folder));
        return { label: folder.name, entries: rows.map(r => ({ ...entryFromRow(folder.pack, r), type: r.type })) };
      }
      return { label: folder.name, entries: folders.flatMap(f => f.contents ?? []).map(item => ({ ...entryFromItem(item), type: item.type })) };
    }
    case "RollTable": {
      const table = data.uuid ? await resolveEntry(data) : null;
      if (!table) return null;
      const flat = await flattenTable(table, { load: uuid => resolveEntry({ uuid }) });
      const entries = flat.items.map(({ item, weight }) => ({ ...entryFromItem(item), weight, type: item.type }));
      return { label: table.name, uuid: table.uuid, entries, notItems: flat.notItems, text: flat.text, textWeight: flat.textWeight, tooDeep: flat.tooDeep, emptyTables: flat.empty, flattened: flat.flattened, sumWeights: true };
    }
    default: return null;
  }
}

// v12-style results name their document by collection and id.
function tableResultUuid(r) {
  const c = r.documentCollection;
  return c.includes(".") ? `Compendium.${c}.Item.${r.documentId}` : `${c}.${r.documentId}`;
}

// How deep a table's nested tables are followed: the table itself is the
// first level, so a chain of five tables comes in whole.
export const TABLE_DEPTH = 5;

// A result's weight as the table rolls it; a weight of 0 still counts as 1,
// so its item is never left with nothing drawable.
const resultWeight = r => Math.max(1, Number(r?.weight) || 1);

/*
  A roll table's items, nested tables flattened: a result that rolls
  another table brings that table's results in, each weighted by the
  parent result's weight times its own share of its table (its weight over
  that table's total), down to TABLE_DEPTH levels. A table already on the
  way down (a loop) or past the depth is skipped and counted in tooDeep;
  one with no results is skipped and counted in `empty`.
  Weights stay whole numbers, scaled together so their ratios are exact
  (integerWeights); a table with nothing nested keeps its own weights.
  `load(uuid)` resolves a result's document (fromUuid). Returns { items: [{
  item, weight }], text, textWeight, notItems, tooDeep, flattened, empty }.
*/
export async function flattenTable(root, { load, maxDepth = TABLE_DEPTH } = {}) {
  const items = [];
  const text = [];
  let notItems = 0, tooDeep = 0, flattened = 0, empty = 0;
  // `num` over `den` is a result's weight in the root table's units; den is
  // the product of the nested tables' totals on the way down (the root's
  // results keep their own weights, so its total never divides).
  const walk = async (table, num, den, depth, path) => {
    const results = [...(table?.results ?? [])];
    const total = depth > 1 ? results.reduce((n, r) => n + resultWeight(r), 0) : 1;
    if (!total) return;
    for (const r of results) {
      const n = num * resultWeight(r), d = den * total;
      const uuid = r.type === "text" ? null : r.documentUuid ?? (r.documentCollection && r.documentId ? tableResultUuid(r) : null);
      if (!uuid) { text.push([n, d]); continue; }
      const doc = await load(uuid);
      if (doc?.documentName === "RollTable") {
        if (depth >= maxDepth || path.includes(doc.uuid)) { tooDeep++; continue; }
        // A nested table with no results brings nothing in: skipped, not flattened.
        if (!(doc.results?.size ?? doc.results?.length ?? [...(doc.results ?? [])].length)) { empty++; continue; }
        flattened++;
        await walk(doc, n, d, depth + 1, [...path, doc.uuid]);
      } else if (doc?.documentName === "Item") items.push({ item: doc, n, d });
      else notItems++;
    }
  };
  await walk(root, 1, 1, 1, [root?.uuid]);
  const ints = integerWeights([...items.map(i => [i.n, i.d]), ...text]);
  return {
    items: items.map((i, k) => ({ item: i.item, weight: ints[k] })),
    text: text.length,
    textWeight: ints.slice(items.length).reduce((n, w) => n + w, 0),
    notItems, tooDeep, flattened, empty,
  };
}

const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
const MAX_SCALE = 1e6;

/*
  Whole-number weights for [numerator, denominator] pairs, in one scale so
  every ratio holds: each times the least common multiple of the
  denominators, then divided by what they all share. Weights that are
  whole already come back as they are. Past MAX_SCALE (deep tables with
  awkward totals) they are rounded on a scale of a million instead, never
  below 1.
*/
export function integerWeights(pairs) {
  let lcm = 1;
  for (const [, d] of pairs) { lcm = lcm / gcd(lcm, d) * d; if (!(lcm <= MAX_SCALE)) break; }
  if (lcm === 1) return pairs.map(([n]) => n);
  if (lcm <= MAX_SCALE) {
    const ints = pairs.map(([n, d]) => n * (lcm / d));
    const g = ints.reduce((a, w) => gcd(a, w), 0) || 1;
    return ints.map(w => w / g);
  }
  const values = pairs.map(([n, d]) => n / d);
  const total = values.reduce((a, v) => a + v, 0);
  return values.map(v => Math.max(1, Math.round(v / total * MAX_SCALE)));
}

/*
  Adds entries to a pool through the shared write queue, reading the pool
  fresh so an entry added meanwhile isn't added twice. Returns how many went in.
*/
export function addEntries(poolId, entries) {
  return enqueueWrite(async () => {
    const pools = getPools();
    const pool = pools[poolId];
    if (!pool) return 0;
    const have = new Set((pool.entries ?? []).map(e => e.uuid));
    const fresh = entries.filter(e => !have.has(e.uuid)).map(({ type: _type, ...e }) => e);
    if (!fresh.length) return 0;
    pool.entries = [...(pool.entries ?? []), ...fresh];
    await set(SETTINGS.POOLS, pools);
    return fresh.length;
  });
}

export async function resolveEntry(entry) {
  try { return await fromUuid(entry.uuid); } catch { return null; }
}

/*
  What each entry's source looks like now, as a Map uuid -> { name, img,
  rarity, rawRarity } (both null when unknown; rawRarity is the source's own
  value, "" when it has none) or null when the source is gone; a
  uuid that couldn't be checked (its pack's index failed) has no answer.
  Cheap enough to run before every pull and on every render of the pool
  editor: a compendium reference is read from the pack's index with the one
  field list every reader here shares (loadIndex), so the sweep and the
  editor never evict each other's index; a world item from game.items; only
  other kinds of reference fall back to fromUuid. Rarity is read through
  rawRarityOf, so a dnd5e 6 rarities set and a legacy string both count.

  `cachedOnly` (the sweep before a pull) answers only from indexes already
  in memory: Foundry doesn't index a pack until something asks, and the
  first fetch of dnd5e.items' index took 0.4 s on a quiet client and 18 s on
  a busy one, all of it before the buyer's roll. Its entries go unanswered
  (flags kept); the roll resolves the drawn entry itself, and the load
  sweep, which does fetch, flags the rest.
*/
const UNCHECKED = Symbol("unchecked");
export async function checkSources(entries, { cachedOnly = false } = {}) {
  const out = new Map();
  const indexes = new Map();
  const packIndex = packId => {
    if (!indexes.has(packId)) {
      const pack = globalThis.game?.packs?.get(packId);
      if (pack && cachedOnly && !indexReady(pack)) {
        indexes.set(packId, Promise.resolve(UNCHECKED));
        return indexes.get(packId);
      }
      // No such pack (its module is off): its entries are gone. A pack whose
      // index failed to load: no answer, so a dropped connection can't flag
      // every entry in it missing and warn the GM about all of them.
      indexes.set(packId, pack ? loadIndex(pack).catch(err => {
        console.warn(`loot-crates | could not read the index of ${packId}; its pool entries were not checked`, err);
        return UNCHECKED;
      }) : Promise.resolve(null));
    }
    return indexes.get(packId);
  };
  for (const uuid of new Set(entries.map(e => e.uuid))) {
    const parts = String(uuid ?? "").split(".");
    let doc;
    if (parts[0] === "Compendium" && parts.length === 5 && parts[3] === "Item") {
      const index = await packIndex(`${parts[1]}.${parts[2]}`);
      if (index === UNCHECKED) continue;
      doc = index?.get(parts[4]);
    } else if (parts[0] === "Item" && parts.length === 2 && globalThis.game?.items) {
      doc = game.items.get(parts[1]);
    } else {
      doc = await resolveEntry({ uuid });
    }
    // A row indexed without the rarity fields (see indexWithRarity) carries
    // neither, so its rarity is unknown, not common.
    const raw = doc ? rawRarityOf(doc.system) : null;
    out.set(uuid, doc ? { name: doc.name, img: doc.img, rarity: raw == null ? null : normalizeRarity(raw), rawRarity: raw } : null);
  }
  return out;
}

// Which of these entries' sources are gone, as a Set of uuids (an entry
// that couldn't be checked is not in it).
export async function findMissing(entries) {
  const sources = await checkSources(entries);
  return new Set([...sources].filter(([, src]) => !src).map(([uuid]) => uuid));
}

// Sets (or clears) `missing` on the entries of one pool, read fresh so a
// write in between is never lost. GM only, through enqueueWrite.
export async function markMissing(poolId, uuids, flag = true) {
  const pools = getPools();
  if (!pools[poolId] || !uuids.length) return pools;
  const next = markEntriesMissing(pools, poolId, uuids, flag);
  await set(SETTINGS.POOLS, next);
  return next;
}

/*
  Checks every entry the given pools can produce (missing ones included, so a
  source that came back is noticed), flags the dead ones and clears the flag
  on revived ones. An entry added before sourceRarity was stored learns its
  source's raw rarity in the same write, when the source still has the
  rarity the entry was added at (else the editor shows the change), so an
  older entry whose source has none reads "No rarity set" after a sweep. A
  stored sourceRarity is never touched. Returns the entries newly found
  missing, each with its pool's name, for reportMissing. GM only, through
  enqueueWrite.

  It is two halves: checking the sources (reads only, and on a cold client
  seconds of compendium reads) and applying what was found to the pools as
  they are when it writes. refreshMissing runs both inside the caller's
  queued task; sweepPools checks outside the queue and queues only the write,
  so a purchase arriving while a big sweep checks is not held behind it.
*/
export async function refreshMissing(poolIds, { cachedOnly = false } = {}) {
  return applySweep(poolIds, await checkPools(poolIds, { cachedOnly }));
}

export async function sweepPools(poolIds) {
  const sources = await checkPools(poolIds);
  return sources ? enqueueWrite(() => applySweep(poolIds, sources)) : [];
}

function poolEntries(poolIds, pools) {
  const entries = [];
  const seen = new Set();
  for (const id of new Set(poolIds)) entries.push(...flattenPool(id, pools, seen, { includeMissing: true }));
  return { entries, seen };
}

async function checkPools(poolIds, opts) {
  const { entries } = poolEntries(poolIds, getPools());
  return entries.length ? checkSources(entries, opts) : null;
}

// Applies a check to the pools as they are now: an entry added since the
// check has no answer and keeps its flag, one removed since is skipped.
async function applySweep(poolIds, sources) {
  if (!sources) return [];
  const pools = getPools();
  const { entries, seen } = poolEntries(poolIds, pools);
  // flattenPool replaces `rarity` with the effective one; learning compares
  // the entry as stored.
  const stored = new Map();
  for (const id of seen) for (const e of pools[id]?.entries ?? []) stored.set(`${id}\n${e.uuid}`, e);
  const found = [];
  const changes = new Map();
  const changeOf = poolId => {
    if (!changes.has(poolId)) changes.set(poolId, { dead: [], revived: [], learn: new Map() });
    return changes.get(poolId);
  };
  for (const e of entries) {
    if (!sources.has(e.uuid)) continue; // not checked: keep its flag
    const src = sources.get(e.uuid);
    const isDead = !src;
    if (isDead !== !!e.missing) {
      const c = changeOf(e.poolId);
      (isDead ? c.dead : c.revived).push(e.uuid);
      if (isDead) found.push({ poolId: e.poolId, poolName: pools[e.poolId]?.name ?? e.poolId, uuid: e.uuid, name: e.name });
    }
    const own = stored.get(`${e.poolId}\n${e.uuid}`);
    if (src && own && own.sourceRarity == null && src.rawRarity != null && normalizeRarity(src.rawRarity) === sourceRarityOf(own)) {
      const learn = changeOf(e.poolId).learn;
      learn.set(src.rawRarity, [...(learn.get(src.rawRarity) ?? []), e.uuid]);
    }
  }
  if (!changes.size) return found;
  let next = pools;
  for (const [poolId, c] of changes) {
    if (c.dead.length) next = markEntriesMissing(next, poolId, c.dead, true);
    if (c.revived.length) {
      next = markEntriesMissing(next, poolId, c.revived, false);
      console.info(`loot-crates | ${c.revived.length} entr${c.revived.length === 1 ? "y" : "ies"} in pool ${pools[poolId]?.name ?? poolId} have their source back`);
    }
    for (const [raw, uuids] of c.learn) {
      if (next[poolId]) next = { ...next, [poolId]: { ...next[poolId], entries: curateEntries(next[poolId].entries, uuids, { sourceRarity: raw }) } };
    }
  }
  await set(SETTINGS.POOLS, next);
  return found;
}

// The GM's sweep of every pool at load, so the shop's odds are honest before
// anyone buys (main.js ready hook). Checked outside the write queue: the
// first purchase after a page load used to wait behind the whole check.
export function sweepAllPools() {
  const t0 = performance.now();
  return sweepPools(Object.keys(getPools()))
    .then(found => {
      console.debug(`loot-crates | load sweep timings (ms): total ${Math.round(performance.now() - t0)}`);
      reportMissing(found);
    })
    .catch(err => console.error(`loot-crates | checking pools for missing items failed`, err));
}

// Tells the GM, once per sweep, which entries were taken out of the roll.
export function reportMissing(found) {
  if (!found?.length) return;
  for (const f of found) console.warn(`loot-crates | ${f.name} (${f.uuid}) in pool ${f.poolName} has no source; it won't be drawn until it is fixed or removed`);
  const list = found.map(f => `${f.name} in ${f.poolName}`).join(", ");
  globalThis.ui?.notifications?.warn(`Loot Crates: ${list} ${found.length === 1 ? "is" : "are"} missing ${found.length === 1 ? "its source and is" : "their sources and are"} no longer drawn. Fix or remove ${found.length === 1 ? "it" : "them"} in the pool editor.`);
}

/*
  The pool editor's per-entry fixes. Each reads the pools fresh inside the
  shared write queue, so a pull's sweep writing the same setting can't undo
  them or be undone by them.
*/
export function removeEntry(poolId, uuid) {
  return enqueueWrite(async () => {
    const pools = getPools();
    const pool = pools[poolId];
    if (!pool) return null;
    pool.entries = (pool.entries ?? []).filter(e => e.uuid !== uuid);
    await set(SETTINGS.POOLS, pools);
    return pool;
  });
}

// Update: copy the source's current name, image and rarity into the entry.
// Relink: point the entry at another item (`patch.uuid`), keeping its weight.
// Either way the entry is live again, so its missing flag goes. A GM's rarity
// override stays: it is curation of this slot, not a copy of the source.
export function patchEntry(poolId, uuid, patch) {
  return enqueueWrite(async () => {
    const pools = getPools();
    const pool = pools[poolId];
    const entry = pool?.entries?.find(e => e.uuid === uuid);
    if (!entry) return null;
    if (patch.uuid && patch.uuid !== uuid && pool.entries.some(e => e.uuid === patch.uuid)) return null;
    delete entry.missing;
    Object.assign(entry, patch, { rarity: normalizeRarity(patch.sourceRarity ?? patch.rarity ?? entry.rarity) });
    if (patch.sourceRarity == null && patch.rarity != null) delete entry.sourceRarity;
    await set(SETTINGS.POOLS, pools);
    return entry;
  });
}
