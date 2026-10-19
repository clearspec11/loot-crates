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
import { normalizeRarity, flattenPool, markEntriesMissing } from "./odds.js";

const uid = () => (globalThis.foundry?.utils?.randomID?.(10)) ?? Math.random().toString(36).slice(2, 12);

export function registerSettings() {
  const world = (key, type, def) => game.settings.register(MODULE_ID, key, { scope: "world", config: false, type, default: def });
  world(SETTINGS.POOLS, Object, {});
  world(SETTINGS.BOXES, Object, {});
  world(SETTINGS.LOG, Array, []);
  world(SETTINGS.STATE, Object, {});
  world(SETTINGS.SHOP_OPEN, Boolean, true);
  game.settings.register(MODULE_ID, SETTINGS.SOUND, {
    name: "Crate sounds",
    hint: "Play the tick, slow-down and reveal sounds when a crate opens.",
    scope: "client", config: true, type: Boolean, default: true,
  });
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

export async function appendLog(entry) {
  const log = getLog();
  log.unshift({ id: uid(), at: Date.now(), ...entry });
  await set(SETTINGS.LOG, log.slice(0, 500));
}

export async function updateLog(id, patch) {
  const log = getLog();
  const row = log.find(r => r.id === id);
  if (row) Object.assign(row, patch);
  await set(SETTINGS.LOG, log);
}

// A pool entry from an Item document or a compendium index row. The
// source's rarity is kept as it was ("" when unset) so the pool editor can
// tell "no rarity set" from a real Common; `rarity` is its dnd5e key.
export function entryFromItem(item, uuid = item.uuid) {
  const sourceRarity = String(item.system?.rarity ?? "");
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

const INDEX_FIELDS = ["system.rarity", "img", "folder"];
const compendiumUuid = (packId, row) => row.uuid ?? `Compendium.${packId}.Item.${row._id}`;
const entryFromRow = (packId, row) => entryFromItem(row, compendiumUuid(packId, row));

/*
  A pack's index rows, each physical item's row sure to carry system.rarity.
  Foundry only keeps the fields in pack.indexFields when it re-indexes a
  document it has loaded (a pull, the spin, an opened sheet), and dnd5e's
  list has no rarity, so such a row drops `system.rarity` and asking
  getIndex for the field again returns the same cached row. Read as is, that
  item would go into a pool as common and a rarity filter would skip it.
  The rows that lost it are read from their documents (cached once loaded).
*/
async function indexWithRarity(pack) {
  const index = await pack.getIndex({ fields: INDEX_FIELDS });
  const lost = [...index].filter(r => isLootType(r.type) && r.system?.rarity === undefined);
  if (!lost.length) return index;
  const docs = await pack.getDocuments({ _id__in: lost.map(r => r._id) });
  const rarity = new Map(docs.map(d => [d.id, d.system?.rarity]));
  const fixed = new Map(lost.map(r => [r._id, { ...r, system: { ...r.system, rarity: rarity.get(r._id) } }]));
  return [...index].map(r => fixed.get(r._id) ?? r);
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
    const rarity = normalizeRarity(row.system?.rarity);
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
                each result's weight as the entry's weight; text results and
                results pointing at other documents are counted in notItems
  Anything that isn't a physical item type is left out and counted by type;
  so are entries whose uuid is in `known` (already in the pool) or repeats
  within the drop (a table's repeats add their weights together).
  Returns null for drag data this can't use.
*/
export async function entriesFromDrop(data, { known = [] } = {}) {
  const found = await collectDrop(data);
  if (!found) return null;
  const have = new Set(known);
  const skipped = { duplicates: 0, notLoot: {}, notItems: found.notItems ?? 0 };
  const byUuid = new Map();
  for (const { type, ...entry } of found.entries) {
    if (type && !isLootType(type)) { skipped.notLoot[type] = (skipped.notLoot[type] ?? 0) + 1; continue; }
    if (have.has(entry.uuid)) { skipped.duplicates++; continue; }
    const seen = byUuid.get(entry.uuid);
    if (seen) { if (found.sumWeights) seen.weight += entry.weight; continue; }
    byUuid.set(entry.uuid, entry);
  }
  return { label: found.label, kind: data.type, entries: [...byUuid.values()], skipped };
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
      const entries = [];
      let notItems = 0;
      for (const r of table.results ?? []) {
        const uuid = r.documentUuid ?? (r.documentCollection && r.documentId ? tableResultUuid(r) : null);
        const item = uuid && r.type !== "text" ? await resolveEntry({ uuid }) : null;
        if (item?.documentName !== "Item") { notItems++; continue; }
        entries.push({ ...entryFromItem(item), weight: Math.max(1, Number(r.weight) || 1), type: item.type });
      }
      return { label: table.name, entries, notItems, sumWeights: true };
    }
    default: return null;
  }
}

// v12-style results name their document by collection and id.
function tableResultUuid(r) {
  const c = r.documentCollection;
  return c.includes(".") ? `Compendium.${c}.Item.${r.documentId}` : `${c}.${r.documentId}`;
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
  editor: a compendium reference is read
  from the pack's index (Foundry caches it after the first load), a world item
  from game.items; only other kinds of reference fall back to fromUuid.
  `rarity: true` asks the pack index for rarities too (the pool editor wants
  them to spot a changed rarity; the pre-pull sweep only needs liveness, and
  the extra field costs a fetch of the whole index the first time).
*/
const UNCHECKED = Symbol("unchecked");
export async function checkSources(entries, { rarity: withRarity = false } = {}) {
  const out = new Map();
  const indexes = new Map();
  const packIndex = packId => {
    if (!indexes.has(packId)) {
      const pack = globalThis.game?.packs?.get(packId);
      const opts = withRarity ? { fields: ["system.rarity"] } : undefined;
      // No such pack (its module is off): its entries are gone. A pack whose
      // index failed to load: no answer, so a dropped connection can't flag
      // every entry in it missing and warn the GM about all of them.
      indexes.set(packId, pack ? pack.getIndex(opts).catch(err => {
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
    // A pack's index row loses `system` once its document has been loaded
    // (Foundry swaps in a slimmer row), so a rarity it doesn't carry is
    // unknown, not common.
    const rarity = doc?.system?.rarity;
    out.set(uuid, doc ? { name: doc.name, img: doc.img, rarity: rarity == null ? null : normalizeRarity(rarity), rawRarity: rarity == null ? null : String(rarity) } : null);
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
  on revived ones. Returns the entries newly found missing, each with its
  pool's name, for reportMissing.
*/
export async function refreshMissing(poolIds) {
  const pools = getPools();
  const entries = [];
  const seen = new Set();
  for (const id of new Set(poolIds)) entries.push(...flattenPool(id, pools, seen, { includeMissing: true }));
  if (!entries.length) return [];
  const sources = await checkSources(entries);
  const found = [];
  const changes = new Map();
  for (const e of entries) {
    if (!sources.has(e.uuid)) continue; // not checked: keep its flag
    const isDead = !sources.get(e.uuid);
    if (isDead === !!e.missing) continue;
    const c = changes.get(e.poolId) ?? { dead: [], revived: [] };
    (isDead ? c.dead : c.revived).push(e.uuid);
    changes.set(e.poolId, c);
    if (isDead) found.push({ poolId: e.poolId, poolName: pools[e.poolId]?.name ?? e.poolId, uuid: e.uuid, name: e.name });
  }
  for (const [poolId, c] of changes) {
    if (c.dead.length) await markMissing(poolId, c.dead, true);
    if (c.revived.length) {
      await markMissing(poolId, c.revived, false);
      console.info(`loot-crates | ${c.revived.length} entr${c.revived.length === 1 ? "y" : "ies"} in pool ${pools[poolId]?.name ?? poolId} have their source back`);
    }
  }
  return found;
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
