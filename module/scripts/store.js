/*
  World-scoped storage for pools, boxes, the pull log and per-actor state,
  behind Foundry's settings. Everything here is GM-only to write; the socket
  handler is the one place that writes on a player's behalf.

  Pools hold references (UUIDs), never copies, so an item edited at its source
  is what gets granted. A reference whose source is gone resolves to null and
  the editors show it as missing.
*/
import { MODULE_ID, SETTINGS } from "./config.js";
import { normalizeRarity } from "./odds.js";

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
