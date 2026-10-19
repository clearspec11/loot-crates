/*
  The pull itself, with no Foundry in it, so Vitest can prove the maths.

  A Pool: { id, name, entries: [{ uuid, name, img, rarity, weight }], pools: [childPoolId] }
  A Box:  { id, name, price, pools: [{ id, share }], weights: { rarity: n },
            rules: { pity: { after, minRarity }, noDuplicates, stock } }

  draw() picks the rarity first (box weights, limited to rarities the box's
  pools actually hold), then a pool among those holding that rarity (by share),
  then an entry inside it (by weight). Rarity odds are therefore exactly what the
  box editor shows, whatever the pools' sizes.
*/
import { RARITIES, DEFAULT_WEIGHTS } from "./config.js";

const RARITY_ALIASES = {
  "": "common", common: "common", uncommon: "uncommon", rare: "rare",
  veryrare: "veryRare", "very rare": "veryRare", "very-rare": "veryRare", very_rare: "veryRare",
  legendary: "legendary", artifact: "artifact",
};

export function normalizeRarity(value) {
  const key = String(value ?? "").trim();
  return RARITY_ALIASES[key] ?? RARITY_ALIASES[key.toLowerCase()] ?? "common";
}

export function rarityRank(rarity) {
  return RARITIES.indexOf(normalizeRarity(rarity));
}

export function weightedPick(items, weightOf, rng) {
  let total = 0;
  for (const item of items) total += Math.max(0, Number(weightOf(item)) || 0);
  if (total <= 0) return null;
  let r = rng() * total;
  for (const item of items) {
    const w = Math.max(0, Number(weightOf(item)) || 0);
    if (w <= 0) continue;
    if (r < w) return item;
    r -= w;
  }
  return items[items.length - 1] ?? null;
}

// Every entry a pool can produce, including nested pools, with cycles ignored.
export function flattenPool(poolId, pools, seen = new Set()) {
  if (seen.has(poolId)) return [];
  seen.add(poolId);
  const pool = pools[poolId];
  if (!pool) return [];
  const own = (pool.entries ?? []).map(e => ({ ...e, rarity: normalizeRarity(e.rarity), weight: e.weight ?? 1, poolId }));
  const nested = (pool.pools ?? []).flatMap(childId => flattenPool(childId, pools, seen));
  return own.concat(nested);
}

// The rarities a box can land on and the chance of each, as the editor shows.
export function oddsTable(box, pools) {
  const weights = { ...DEFAULT_WEIGHTS, ...(box.weights ?? {}) };
  const available = new Set();
  for (const ref of box.pools ?? []) for (const e of flattenPool(ref.id, pools)) available.add(e.rarity);
  const rows = RARITIES.filter(r => available.has(r)).map(r => ({ rarity: r, weight: Math.max(0, Number(weights[r]) || 0) }));
  const total = rows.reduce((n, row) => n + row.weight, 0);
  return rows.map(row => ({ rarity: row.rarity, chance: total > 0 ? row.weight / total : 0 }));
}

function pityFloor(box, state) {
  const pity = box.rules?.pity;
  if (!pity?.after || !pity.minRarity) return -1;
  return (state?.sinceRare ?? 0) >= pity.after ? rarityRank(pity.minRarity) : -1;
}

/*
  Returns { entry, rarity, poolId, pity } or null when the box has nothing to
  give (every entry excluded, or no pools). `state` is per actor and box:
  { sinceRare, owned: [uuid] }.
*/
export function draw({ box, pools, rng = Math.random, state = {} }) {
  const weights = { ...DEFAULT_WEIGHTS, ...(box.weights ?? {}) };
  const owned = new Set(box.rules?.noDuplicates ? state.owned ?? [] : []);
  const floor = pityFloor(box, state);

  const perPool = (box.pools ?? [])
    .map(ref => ({ share: ref.share ?? 1, entries: flattenPool(ref.id, pools).filter(e => !owned.has(e.uuid)) }))
    .filter(p => p.entries.length);
  if (!perPool.length) return null;

  const available = new Set(perPool.flatMap(p => p.entries.map(e => e.rarity)));
  let candidates = RARITIES.filter(r => available.has(r) && rarityRank(r) >= floor);
  // Pity asked for more than the box holds: fall back to its best rarity.
  if (!candidates.length) candidates = [RARITIES.filter(r => available.has(r)).pop()];
  const pityApplied = floor >= 0 && candidates.every(r => rarityRank(r) >= floor);

  let rarity = weightedPick(candidates, r => weights[r], rng);
  // Every candidate weighs zero (a box whose weights exclude what it holds):
  // treat them as equal rather than giving nothing.
  if (!rarity) rarity = weightedPick(candidates, () => 1, rng);

  const holders = perPool.filter(p => p.entries.some(e => e.rarity === rarity));
  const pool = weightedPick(holders, p => p.share, rng) ?? holders[0];
  const entry = weightedPick(pool.entries.filter(e => e.rarity === rarity), e => e.weight, rng);
  if (!entry) return null;
  return { entry, rarity, poolId: entry.poolId, pity: pityApplied };
}

// The state after a pull, for the pity counter and duplicate rule.
export function nextState(box, state = {}, result) {
  const pity = box.rules?.pity;
  const hitFloor = pity?.minRarity && rarityRank(result.rarity) >= rarityRank(pity.minRarity);
  return {
    sinceRare: hitFloor ? 0 : (state.sinceRare ?? 0) + 1,
    owned: [...new Set([...(state.owned ?? []), result.entry.uuid])],
    pulls: (state.pulls ?? 0) + 1,
  };
}

// A seeded generator for tests and screenshots (mulberry32).
export function seededRng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
