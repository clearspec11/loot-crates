/*
  World-scoped storage for pools, boxes, the pull log and per-actor state,
  behind Foundry's settings. Everything here is GM-only to write; the socket
  handler is the one place that writes on a player's behalf.

  Pools hold references (UUIDs), never copies, so an item edited at its source
  is what gets granted. A reference whose source is gone resolves to null; the
  sweep below flags its entry `missing: true`, which takes it out of the roll,
  the odds and the strip (odds.js flattenPool), and warns the GM.
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

// A pool entry from an Item document or a compendium index row.
export function entryFromItem(item, uuid = item.uuid) {
  return {
    uuid,
    name: item.name,
    img: item.img,
    rarity: normalizeRarity(item.system?.rarity),
    weight: 1,
  };
}

/*
  Bulk source: every item in a compendium that passes the filter.
  filter: { types: ["weapon", "equipment"], rarities: ["uncommon"], name: "wand" }
*/
export async function entriesFromCompendium(packId, filter = {}) {
  const pack = game.packs.get(packId);
  if (!pack || pack.documentName !== "Item") return [];
  const index = await pack.getIndex({ fields: ["system.rarity", "system.type.value", "img"] });
  const types = new Set(filter.types ?? []);
  const rarities = new Set((filter.rarities ?? []).map(normalizeRarity));
  const needle = (filter.name ?? "").trim().toLowerCase();
  const out = [];
  for (const row of index) {
    if (types.size && !types.has(row.type)) continue;
    const rarity = normalizeRarity(row.system?.rarity);
    if (rarities.size && !rarities.has(rarity)) continue;
    if (needle && !row.name.toLowerCase().includes(needle)) continue;
    out.push({ uuid: row.uuid ?? `Compendium.${packId}.Item.${row._id}`, name: row.name, img: row.img, rarity, weight: 1 });
  }
  return out;
}

export async function resolveEntry(entry) {
  try { return await fromUuid(entry.uuid); } catch { return null; }
}

/*
  Which of these entries' sources are gone, as a Set of uuids. Cheap enough to
  run before every pull: a compendium reference is checked against the pack's
  index (Foundry caches it after the first load), a world item against
  game.items; only other kinds of reference fall back to fromUuid.
*/
export async function findMissing(entries) {
  const missing = new Set();
  const indexes = new Map();
  const packIndex = packId => {
    if (!indexes.has(packId)) {
      const pack = globalThis.game?.packs?.get(packId);
      indexes.set(packId, pack ? pack.getIndex().catch(() => null) : Promise.resolve(null));
    }
    return indexes.get(packId);
  };
  for (const uuid of new Set(entries.map(e => e.uuid))) {
    const parts = String(uuid ?? "").split(".");
    let live;
    if (parts[0] === "Compendium" && parts.length === 5 && parts[3] === "Item") {
      const index = await packIndex(`${parts[1]}.${parts[2]}`);
      live = !!index?.has(parts[4]);
    } else if (parts[0] === "Item" && parts.length === 2 && globalThis.game?.items) {
      live = game.items.has(parts[1]);
    } else {
      live = !!(await resolveEntry({ uuid }));
    }
    if (!live) missing.add(uuid);
  }
  return missing;
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
  const dead = await findMissing(entries);
  const found = [];
  const changes = new Map();
  for (const e of entries) {
    const isDead = dead.has(e.uuid);
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
