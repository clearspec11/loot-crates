/*
  The pull itself, with no Foundry in it, so Vitest can prove the maths.

  A Pool: { id, name, entries: [Entry], pools: [childPoolId] }
  An Entry: { uuid, name, img, rarity, sourceRarity, rarityOverride?, weight, missing? }
    sourceRarity  the source's raw rarity as added (rawRarityOf), "" when it
                  had none
    rarity        normalizeRarity(sourceRarity), kept for entries added before
                  sourceRarity existed
    rarityOverride  a dnd5e rarity key the GM chose, or absent; it wins
    weight        0 means the entry never drops
  A Box:  { id, name, price, pools: [{ id, share }], weights: { rarity: n },
            rules: { pity: { after, minRarity }, noDuplicates, stock,
                     oddsMode?, missChance? } }

  draw() picks the rarity first (box weights, limited to rarities the box's
  pools actually hold), then a pool among those holding that rarity (by share),
  then an entry inside it (by weight). Rarity odds are therefore exactly what the
  box editor shows, whatever the pools' sizes.

  A crate with rules.oddsMode "weight" (one made from a roll table) skips the
  rarity step: a pool by its share, then an entry by its weight, so an item
  that was 1 in 100 on the table stays 1 in 100. Pity and no-duplicates
  still apply: what the buyer owns is out, and a due pity keeps only the
  entries at its rarity or better. A record without oddsMode draws by
  rarity, as every record before it did. rules.missChance (a table's text
  results counted as nothing) is the share of pulls that give no item,
  rolled before the item (rollMiss) and never on a pull whose pity is due.

  An entry flagged `missing: true` (its source is gone; store.js sets the flag
  on the GM client) is invisible to everything here: it is never drawn, never
  counted in the odds and never used as a strip filler or tease, because all of
  those read entries through flattenPool. The odds shown are the odds granted.
  The same goes for an entry weighing 0, and flattenPool hands everything
  else its effective rarity (the GM's override, else the source's), so the
  roll, the odds and the strip all follow the pool editor.
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

/*
  An item's own rarity as dnd5e stores it, read the same way from a loaded
  document's system data and from a compendium index row. dnd5e 6 keeps a
  set, system.rarities (system.rarity is a getter returning its first
  member, so a Set or an index row's Array gives that same first member);
  dnd5e 5 and packs that predate dnd5e 6's migration keep the string
  system.rarity. Returns the raw value ("" when the item has none) or null
  when neither is there, which means unknown, not common: an index row
  fetched without the rarity fields.
*/
export function rawRarityOf(system) {
  const set = system?.rarities;
  if (Array.isArray(set) || set instanceof Set) {
    for (const r of set) return String(r ?? "");
    return "";
  }
  const legacy = system?.rarity;
  return legacy == null ? null : String(legacy);
}

// The rarity an entry is drawn at: the GM's override, else its source's.
export function effectiveRarity(entry) {
  if (RARITIES.includes(entry?.rarityOverride)) return entry.rarityOverride;
  return normalizeRarity(entry?.sourceRarity ?? entry?.rarity);
}

// The rarity its source gave it, which is what a source check compares.
export const sourceRarityOf = entry => normalizeRarity(entry?.sourceRarity ?? entry?.rarity);

// Its source had no rarity at all and the GM hasn't picked one.
export const rarityUnset = entry => entry?.sourceRarity === "" && !RARITIES.includes(entry?.rarityOverride);

// A whole number, 0 or more; a missing weight is 1.
export function entryWeight(entry) {
  if (entry?.weight == null) return 1;
  return Math.max(0, Math.floor(Number(entry.weight)) || 0);
}

// Every entry a pool can produce, including nested pools, with cycles ignored,
// each with its effective rarity. Entries flagged missing or weighing 0 are
// left out unless `includeMissing` (the liveness sweep needs every entry, to
// notice a source that came back).
export function flattenPool(poolId, pools, seen = new Set(), { includeMissing = false } = {}) {
  if (seen.has(poolId)) return [];
  seen.add(poolId);
  const pool = pools[poolId];
  if (!pool) return [];
  const own = (pool.entries ?? [])
    .filter(e => includeMissing || (!e.missing && entryWeight(e) > 0))
    .map(e => ({ ...e, rarity: effectiveRarity(e), weight: entryWeight(e), poolId }));
  const nested = (pool.pools ?? []).flatMap(childId => flattenPool(childId, pools, seen, { includeMissing }));
  return own.concat(nested);
}

// A copy of `pools` with `missing` set (or cleared) on the entries of `poolId`
// whose uuid is in `uuids`. The other pools are shared, not copied.
export function markEntriesMissing(pools, poolId, uuids, flag = true) {
  const pool = pools[poolId];
  if (!pool) return pools;
  const hit = new Set(uuids);
  const entries = (pool.entries ?? []).map(e => {
    if (!hit.has(e.uuid)) return e;
    const { missing: _drop, ...rest } = e;
    return flag ? { ...rest, missing: true } : rest;
  });
  return { ...pools, [poolId]: { ...pool, entries } };
}

/*
  How a pool entry compares with its source now. `source` is null when the
  source is gone, else { name, img, rarity } as read from the pack index or the
  world; a null rarity is unknown and not compared. "renamed" means the name
  or the source's rarity changed since the entry was added, so the GM sees
  "Wand of Sparks" becoming "Wand of Sparking" instead of a silent miss. The
  rarity compared is the one the source gave the entry, never the GM's
  override: overriding is curation, not drift.
*/
export function sourceStatus(entry, source) {
  if (!source) return "missing";
  if (source.name !== entry.name) return "renamed";
  if (source.rarity != null && normalizeRarity(source.rarity) !== sourceRarityOf(entry)) return "renamed";
  return "ok";
}

/*
  The pool editor's per-entry curation, applied to `entries` (a pool's own
  list) for the uuids given: `change.rarityOverride` a rarity key sets it,
  null (or the source's own rarity) clears it; `change.weight` becomes a
  whole number, 0 or more; `change.sourceRarity` fills in the source's raw
  rarity on an older entry that never stored it. Returns a new list; other
  entries are shared.
*/
export function curateEntries(entries, uuids, change = {}) {
  const hit = new Set(uuids);
  return (entries ?? []).map(e => {
    if (!hit.has(e.uuid)) return e;
    const next = { ...e };
    // An entry added before sourceRarity existed learns it from a check.
    if (typeof change.sourceRarity === "string" && next.sourceRarity == null) next.sourceRarity = change.sourceRarity;
    if ("rarityOverride" in change) {
      const r = change.rarityOverride;
      // Picking the source's own rarity clears the override, unless the
      // source has none: then "common" is a real choice, not the default.
      // Read `next`, not `e`: an older entry learns sourceRarity "" in this
      // same change, and its Common must stick.
      if (RARITIES.includes(r) && (r !== sourceRarityOf(next) || next.sourceRarity === "")) next.rarityOverride = r;
      else delete next.rarityOverride;
    }
    if ("weight" in change) next.weight = entryWeight({ weight: change.weight });
    return next;
  });
}

// A copy of `pools` whose `missing` flags follow `sources` (uuid -> source or
// null, from store.js checkSources) instead of the last sweep, for views that
// have just checked. Entries with no answer in `sources` keep their flag.
export function withSources(pools, sources) {
  const out = {};
  for (const [id, pool] of Object.entries(pools)) {
    out[id] = { ...pool, entries: (pool.entries ?? []).map(e => {
      if (!sources.has(e.uuid)) return e;
      const { missing: _drop, ...rest } = e;
      return sources.get(e.uuid) ? rest : { ...rest, missing: true };
    }) };
  }
  return out;
}

// How a crate draws: "rarity" (absent, and every record before this) or
// "weight" (entry weight alone, the roll table's own odds).
export const ODDS_MODES = ["rarity", "weight"];
export const oddsModeOf = box => (box?.rules?.oddsMode === "weight" ? "weight" : "rarity");

// The share of pulls that find nothing, 0 up to MAX_MISS (a crate that
// never gives anything is not a crate).
export const MAX_MISS = 0.99;
export function missChanceOf(box) {
  const c = Number(box?.rules?.missChance);
  return Number.isFinite(c) && c > 0 ? Math.min(MAX_MISS, c) : 0;
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

/*
  The odds a buyer sees: { rows: [{ rarity, chance, label }], top, pity? }.
  Read from drawPlan, the same plan draw() rolls on, so for a buyer's
  `state` (per actor and box: { sinceRare, owned }) the shown odds are that
  buyer's: under noDuplicates what they own is out, and once their pity is
  due only the guaranteed rarities show. Unlike oddsTable it drops rarities
  the box weighs at 0 (they can never land), and when every rarity left
  weighs 0 it shows them at equal chance, which is what draw() does. Labels
  are whole percents that sum to 100 (largest remainder, so 62.5/37.5 reads
  63/37, not 63/38), and never read "0%" or "100%" for a chance that isn't:
  under 1% is "<1%", over 99% is ">99%". `top` is the best rarity the box
  can actually drop, null when none.
  `nothingNew: true` when the box holds items but this buyer owns every one
  of them under noDuplicates (rows is then empty). `pity: { due, left,
  minRarity }` when the box has a pity rule this buyer can reach: `left` is
  the pulls up to and including the guaranteed one (1 when it is due).
*/
export function shopOdds(box, pools, state = {}) {
  const plan = drawPlan(box, pools, state);
  if (!plan) {
    const out = { rows: [], top: null };
    if (box.rules?.noDuplicates && state.owned?.length && drawPlan(box, pools, {})) out.nothingNew = true;
    return out;
  }
  const rows = plan.candidates.map(rarity => ({ rarity, weight: plan.weightOf(rarity) })).filter(row => row.weight > 0);
  const total = rows.reduce((n, row) => n + row.weight, 0);
  // A pull that finds nothing takes its share off the top; the labels of
  // the rows and the nothing together sum to 100.
  const miss = plan.miss;
  const keep = 1 - miss;
  const chances = rows.map(row => keep * row.weight / total);
  const pcts = wholePercents(miss > 0 ? [...chances, miss] : chances);
  const out = {
    rows: rows.map((row, i) => ({ rarity: row.rarity, chance: chances[i], label: chanceLabel(chances[i], pcts[i]) })),
    top: rows[rows.length - 1].rarity,
  };
  if (miss > 0) out.nothing = { chance: miss, label: chanceLabel(miss, pcts[pcts.length - 1]) };
  if (plan.mode === "weight") {
    // Each item's own chance, merged when an item sits in two pools, best
    // find first: what the shop names. `pct` is its whole percent, so a
    // card that names a few can say what the rest add up to.
    out.mode = "weight";
    const items = plan.items.map(({ entry, chance }) => ({ uuid: entry.uuid, name: entry.name, img: entry.img, rarity: entry.rarity, chance: keep * chance }));
    const ipcts = wholePercents(miss > 0 ? [...items.map(it => it.chance), miss] : items.map(it => it.chance));
    out.items = items
      .map((it, i) => ({ ...it, pct: ipcts[i], label: chanceLabel(it.chance, ipcts[i]) }))
      .sort((a, b) => rarityRank(b.rarity) - rarityRank(a.rarity) || a.chance - b.chance || String(a.name).localeCompare(String(b.name)));
    if (miss > 0) out.nothing = { chance: miss, pct: ipcts[ipcts.length - 1], label: chanceLabel(miss, ipcts[ipcts.length - 1]) };
  }
  const pity = box.rules?.pity;
  // Only a floor this buyer can reach: past it draw() falls back to the
  // best rarity left, and "Legendary or better" would be a promise it breaks.
  if (pity?.after && pity.minRarity && plan.available.some(r => rarityRank(r) >= rarityRank(pity.minRarity))) {
    const since = Math.max(0, Number(state.sinceRare) || 0);
    const due = since >= pity.after;
    out.pity = { due, left: due ? 1 : pity.after - since + 1, minRarity: normalizeRarity(pity.minRarity) };
  }
  return out;
}

// Whole percents for chances summing to 1, adding up to exactly 100.
export function wholePercents(chances) {
  const raw = chances.map(c => c * 100);
  const out = raw.map(Math.floor);
  let left = Math.round(raw.reduce((n, x) => n + x, 0)) - out.reduce((n, x) => n + x, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) { if (left <= 0) break; out[i]++; left--; }
  return out;
}

export function chanceLabel(chance, pct = Math.round(chance * 100)) {
  if (chance <= 0) return "0%";
  if (chance < 0.01) return "<1%";
  if (pct >= 100 && chance < 1) return ">99%";
  return `${Math.max(1, pct)}%`;
}

function pityFloor(box, state) {
  const pity = box.rules?.pity;
  if (!pity?.after || !pity.minRarity) return -1;
  return (state?.sinceRare ?? 0) >= pity.after ? rarityRank(pity.minRarity) : -1;
}

/*
  What one pull from `box` can land on for one buyer: the noDuplicates and
  pity rules applied to their `state`. draw() rolls on it and shopOdds()
  shows it, so the odds next to Buy and the roll can't drift apart. Returns
  null when nothing is left to give, else { perPool: [{ share, entries }],
  available: [rarity] (what is left, low to high), candidates: [rarity]
  (what this pull can land on), weightOf(rarity), pityApplied, mode, miss }.
  When every candidate weighs 0 (a box whose weights exclude what it holds),
  weightOf treats them as equal rather than giving nothing. In weight mode
  `items` is each entry's chance ([{ entry, chance }], by uuid) and
  weightOf(rarity) the sum of its items' chances, so the rarity ribbon, the
  strip's tease and the reveal read the same odds the roll uses. `miss` is
  the share of pulls that find nothing (0 when pity is due).
*/
function drawPlan(box, pools, state = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...(box.weights ?? {}) };
  const owned = new Set(box.rules?.noDuplicates ? state.owned ?? [] : []);
  const floor = pityFloor(box, state);

  const perPool = (box.pools ?? [])
    .map(ref => ({ share: ref.share ?? 1, entries: flattenPool(ref.id, pools).filter(e => !owned.has(e.uuid)) }))
    .filter(p => p.entries.length);
  if (!perPool.length) return null;

  const held = new Set(perPool.flatMap(p => p.entries.map(e => e.rarity)));
  const available = RARITIES.filter(r => held.has(r));
  let candidates = available.filter(r => rarityRank(r) >= floor);
  // Pity asked for more than the box holds: fall back to its best rarity.
  if (!candidates.length) candidates = [available[available.length - 1]];
  const pityApplied = floor >= 0 && candidates.every(r => rarityRank(r) >= floor);

  const mode = oddsModeOf(box);
  // A due pity is an item at its floor, never a miss.
  const miss = floor >= 0 ? 0 : missChanceOf(box);
  if (mode === "weight") {
    const items = entryChances(weightHolders(perPool, candidates));
    const byRarity = new Map();
    for (const { entry, chance } of items) byRarity.set(entry.rarity, (byRarity.get(entry.rarity) ?? 0) + chance);
    return { perPool, available, candidates, weightOf: r => byRarity.get(r) ?? 0, pityApplied, mode, items, miss };
  }
  const weightOf = r => Math.max(0, Number(weights[r]) || 0);
  const weighed = candidates.some(r => weightOf(r) > 0);
  return { perPool, available, candidates, weightOf: weighed ? weightOf : () => 1, pityApplied, mode, miss };
}

// Weight mode's pools: each with only the entries this pull can land on.
function weightHolders(perPool, candidates) {
  const allowed = new Set(candidates);
  return perPool.map(p => ({ share: p.share, entries: p.entries.filter(e => allowed.has(e.rarity)) })).filter(p => p.entries.length);
}

/*
  Each entry's chance in weight mode, as draw() rolls it: a pool by its
  share (all shares 0: the first pool, as weightedPick falls back), then an
  entry by its weight within that pool. An item in two pools adds up.
*/
function entryChances(holders) {
  const shareOf = p => Math.max(0, Number(p.share) || 0);
  const shares = holders.reduce((n, p) => n + shareOf(p), 0);
  const out = new Map();
  holders.forEach((p, i) => {
    const pool = shares > 0 ? shareOf(p) / shares : (i === 0 ? 1 : 0);
    if (pool <= 0) return;
    const total = p.entries.reduce((n, e) => n + e.weight, 0);
    for (const e of p.entries) {
      const chance = pool * e.weight / total;
      const had = out.get(e.uuid);
      if (had) had.chance += chance;
      else out.set(e.uuid, { entry: e, chance });
    }
  });
  return [...out.values()].filter(x => x.chance > 0);
}

/*
  Returns { entry, rarity, poolId, pity } or null when the box has nothing to
  give (every entry excluded, or no pools). `state` is per actor and box:
  { sinceRare, owned: [uuid] }.
*/
export function draw({ box, pools, rng = Math.random, state = {} }) {
  const plan = drawPlan(box, pools, state);
  if (!plan) return null;
  if (plan.mode === "weight") {
    const holders = weightHolders(plan.perPool, plan.candidates);
    const pool = weightedPick(holders, p => p.share, rng) ?? holders[0];
    const entry = pool && weightedPick(pool.entries, e => e.weight, rng);
    if (!entry) return null;
    return { entry, rarity: entry.rarity, poolId: entry.poolId, pity: plan.pityApplied };
  }
  const rarity = weightedPick(plan.candidates, plan.weightOf, rng);
  const holders = plan.perPool.filter(p => p.entries.some(e => e.rarity === rarity));
  const pool = weightedPick(holders, p => p.share, rng) ?? holders[0];
  const entry = weightedPick(pool.entries.filter(e => e.rarity === rarity), e => e.weight, rng);
  if (!entry) return null;
  return { entry, rarity, poolId: entry.poolId, pity: plan.pityApplied };
}

/*
  Whether this pull finds nothing (rules.missChance), rolled before the item.
  It takes a number from `rng` only for a box that can miss, so every other
  box rolls exactly as it did. Never on a pull whose pity is due, nor on a
  box with nothing left to give (draw() then says so).
*/
export function rollMiss({ box, pools, rng = Math.random, state = {} }) {
  const plan = drawPlan(box, pools, state);
  return !!plan && plan.miss > 0 && rng() < plan.miss;
}

// The state after a pull that found nothing: one more pull toward pity,
// nothing owned.
export function missState(state = {}) {
  return { sinceRare: (state.sinceRare ?? 0) + 1, owned: [...(state.owned ?? [])], pulls: (state.pulls ?? 0) + 1 };
}

// Whether a pull of `rarity` from `box` resets the buyer's pity count.
export function resetsPity(box, rarity) {
  const pity = box?.rules?.pity;
  return !!pity?.minRarity && rarityRank(rarity) >= rarityRank(pity.minRarity);
}

// The state after a pull, for the pity counter and duplicate rule.
export function nextState(box, state = {}, result) {
  return {
    sinceRare: resetsPity(box, result.rarity) ? 0 : (state.sinceRare ?? 0) + 1,
    owned: [...new Set([...(state.owned ?? []), result.entry.uuid])],
    pulls: (state.pulls ?? 0) + 1,
  };
}

const at = r => r.at ?? 0;

/*
  The buyer's state as if the pull in `row` never happened, for a refund.
  `state` is their current { sinceRare, owned, pulls } for row's actor and
  box; `log` is the pull log (rows carry `at`; `row` may already be marked
  refunded in it). Only the actor+box's other unrefunded rows count.
  - owned loses row.uuid unless another unrefunded row granted it too. A
    row that says the item wasn't owned before it (`before.hadItem`
    false) only counts later rows: an earlier grant had already left the
    record (a GM reset the state, or its write failed) or it would have
    been owned.
  - pulls goes down by one.
  - sinceRare (rows since the change carry `before.sinceRare` and
    `resetPity`): a row that counted toward it takes its 1 back; a row that
    reset it gives back the count it wiped, on top of what came after it.
    A later unrefunded reset already cleared everything before it, so then
    sinceRare stays.
  - A row from before the change (no `before`) keeps sinceRare as it is.
*/
export function undoPull(state = {}, row, log = []) {
  const mine = log.filter(r => r.id !== row.id && r.actorId === row.actorId && r.boxId === row.boxId);
  const live = mine.filter(r => !r.refunded);
  const fresh = row.before?.hadItem === false;
  const owned = (state.owned ?? []).filter(u => u !== row.uuid || live.some(r => r.uuid === u && (!fresh || at(r) > at(row))));
  const out = { ...state, owned, pulls: Math.max(0, (state.pulls ?? 0) - 1) };
  if (!row.before) return out;

  const since = state.sinceRare ?? 0;
  if (live.some(r => at(r) > at(row) && r.resetPity)) return out;
  if (!row.resetPity) return { ...out, sinceRare: Math.max(0, since - 1) };
  return { ...out, sinceRare: wiped(row, mine) + since };
}

/*
  The count a resetting row wiped, as it stands now: its before.sinceRare,
  less the pulls in that count refunded since (this row, a later reset,
  kept their own refund from taking their 1 back), plus the count the reset
  before it wiped if that reset was refunded since too (same reason).
  "The reset before it" is the nearest one still standing when this row was
  pulled; before.sinceRare counted from there.
*/
function wiped(row, mine) {
  const prev = mine
    .filter(m => m.resetPity && m.before && at(m) < at(row) && !(m.refunded && m.refunded < at(row)))
    .reduce((a, m) => (!a || at(m) > at(a) ? m : a), null);
  const from = prev ? at(prev) : -Infinity;
  const masked = mine.filter(e => e.resetPity === false && at(e) > from && at(e) < at(row) && e.refunded > at(row)).length;
  const own = Math.max(0, (row.before.sinceRare ?? 0) - masked);
  return own + (prev?.refunded ? wiped(prev, mine) : 0);
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
