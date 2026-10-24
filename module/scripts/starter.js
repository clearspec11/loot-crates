/*
  The starter crates: one press on the manager's "Add starter crates" fills
  an empty world with a small set that shows every game working, built
  from the dnd5e system's own item compendiums.

  Four pools, filled when the GM presses from the packs the installed
  system lists (starterPackPlan), by item type, subtype and rarity
  (STARTER_POOLS, pickEntries); they hold UUID references like any pool,
  so no item text ships with the module. Then one of every game drawing
  from them (STARTER_GAMES): three crates at rising prices, a Wishing Well,
  Dragon's Teeth, a Deck of Many Things with the five placeholder cards a
  New deck has (nothing of a published deck's text), a roulette wheel on
  the default pockets and an auction whose lot is the sealed hoard chest.

  Every game is added off the shelf (shelf.js), so nothing reaches a
  player until the GM has looked it over and put it out from its row. The
  records are ordinary: each is a New's draft (newgame.js newDraft) with
  its price, odds and pools set, edited, copied and deleted like any other.

  A second press finds what is already there by name (starterPresent) and
  asks before adding the set again: the games come in as copies
  ("Adventurer's cache (copy)", newgame.js copyName) and draw from the
  starter pools already in the world, which are used as they are.

  No Foundry globals: the builder (starterbuild.js) reads the packs and
  their indexes and passes the rows, the ids and what the world holds.
*/
import { RARITIES } from "./config.js";
import { normalizeRarity, rawRarityOf } from "./odds.js";
import { newDraft, copyName } from "./newgame.js";
import { shelfRules } from "./shelf.js";
import { lotFromCrate } from "./auction.js";

/*
  The packs the pools are filled from, by their name in the system's
  manifest: the 2014 SRD items, and on dnd5e 6 (or 5 with the 2024 rules)
  the 2024 equipment as well. The world's dnd5e rules version decides which
  comes first, and each pool is filled from the first pack that has
  anything for it (pickEntries), so a table on the 2024 rules gets the
  2024 potions, not both editions' under two names (cc-dev: 756 entries
  from both, 432 this way), and the 2014 +1 weapons only because the 2024
  pack has none. A pack the system doesn't list is skipped
  without a word when it is optional (dnd5e 5 has no equipment24); one it
  lists that the world can't open is named in the status line.
*/
export const STARTER_PACKS = [
  { name: "items", label: "Items (SRD)", rules: "legacy", optional: false },
  { name: "equipment24", label: "Equipment (2024)", rules: "modern", optional: true },
];

/*
  Which pack ids to read, in order, and a sentence for each that is
  missing. `system` is the system's id, `listed` the pack names its
  manifest lists, `loaded(id)` whether the world has that pack, `rules`
  dnd5e's rulesVersion ("modern" or "legacy").
*/
export function starterPackPlan({ system = "dnd5e", listed = [], loaded = () => true, rules = "modern" } = {}) {
  const names = new Set(listed);
  const notes = [];
  if (system !== "dnd5e") return { packs: [], notes: [`Starter crates are built from the dnd5e system's item compendiums, and this world runs ${system || "another system"}.`] };
  const order = [...STARTER_PACKS].sort((a, b) => (a.rules === rules ? -1 : b.rules === rules ? 1 : 0));
  const packs = [];
  for (const p of order) {
    const id = `${system}.${p.name}`;
    if (!names.has(p.name) && p.optional) continue;
    if (!names.has(p.name) || !loaded(id)) { notes.push(`The ${p.label} compendium (${id}) isn't in this world, so its items were left out.`); continue; }
    packs.push(id);
  }
  if (!packs.length) notes.push("No dnd5e item compendium could be read.");
  return { packs, notes };
}

const PHYSICAL = ["weapon", "equipment", "consumable", "tool", "loot", "container"];
const UP_FROM = r => RARITIES.slice(RARITIES.indexOf(r));

/*
  The four pools: what each takes from the packs. `types` are dnd5e item
  types; `subtypes` (by type) the system.type.value an item must have,
  read from the index when it carries one, else `guess` (by type) is
  matched against the name; `named` must match the item's name; `rarities`
  are dnd5e's keys, and an item with no rarity set is never taken (a
  mundane rope is not loot from a crate).
*/
export const STARTER_POOLS = [
  { key: "potions", name: "Potions and scrolls", types: ["consumable"], subtypes: { consumable: ["potion", "scroll"] }, guess: { consumable: /potion|scroll|elixir|philter|\boil\b/i }, rarities: ["common", "uncommon"] },
  { key: "trinkets", name: "Wondrous trinkets", types: ["equipment"], subtypes: { equipment: ["wondrous", "trinket", "ring", "clothing"] }, guess: { equipment: /^(?!.*\b(armor|armour|shield|mail|plate|leather|hide)\b)/i }, rarities: ["uncommon", "rare"] },
  { key: "arms", name: "Arms and armour", types: ["weapon", "equipment"], subtypes: { equipment: ["light", "medium", "heavy", "shield"] }, guess: { equipment: /\b(armor|armour|shield|mail|plate|leather|hide)\b/i }, named: /(^|\s)\+[12](\s|$)/, rarities: ["uncommon", "rare"] },
  { key: "hoard", name: "Dragon's hoard", types: PHYSICAL, rarities: UP_FROM("rare") },
];

// Whether one index row goes into the pool `spec`.
export function takesRow(spec, row) {
  if (!row || !spec.types.includes(row.type)) return false;
  const raw = rawRarityOf(row.system);
  if (!raw) return false;
  if (!spec.rarities.includes(normalizeRarity(raw))) return false;
  if (spec.named && !spec.named.test(row.name ?? "")) return false;
  const subs = spec.subtypes?.[row.type];
  if (subs) {
    const sub = row.system?.type?.value;
    if (sub) return subs.includes(sub);
    const guess = spec.guess?.[row.type];
    return guess ? guess.test(row.name ?? "") : true;
  }
  return true;
}

// A pool entry from an index row, as store.js entryFromItem makes one.
export function entryOfRow(packId, row) {
  const sourceRarity = rawRarityOf(row.system) ?? "";
  return { uuid: row.uuid ?? `Compendium.${packId}.Item.${row._id}`, name: row.name, img: row.img, rarity: normalizeRarity(sourceRarity), sourceRarity, weight: 1 };
}

/*
  The entries of one pool from the packs' rows: `packs` is [{ id, rows }]
  in the plan's order, and the pool is filled from the first pack with
  anything for it; a later pack only fills a pool the earlier ones have
  nothing for. A name a pack repeats goes in once.
*/
export function pickEntries(spec, packs = []) {
  for (const { id, rows } of packs) {
    const seen = new Set();
    const out = [];
    for (const row of rows ?? []) {
      if (!takesRow(spec, row)) continue;
      const key = String(row.name ?? "").trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entryOfRow(id, row));
    }
    if (out.length) return out;
  }
  return [];
}

const weights = (w = {}) => Object.fromEntries(RARITIES.map(r => [r, w[r] ?? 0]));

/*
  The games, cheapest first. Each names the pools it draws from by key,
  with their shares, and what it changes on its kind's New:
    Adventurer's cache   50 gp, mostly common and uncommon potions with a
                         chance of a +1 weapon
    Arcane coffer        250 gp, uncommon and rare trinkets and arms, a
                         rare or better guaranteed after 5 pulls
    Dragon's hoard chest 1,000 gp, rare and up, a legendary or better
                         guaranteed after 10 pulls, 3 in stock
    Wishing Well         1 sp a throw, three a day, potions when it pays
    Dragon's Teeth       10 gp on 3d6 over 12, paying three times the
                         stake, a trinket on a perfect 18
    Deck of Many Things  10 gp a draw, half again for each draw in a row,
                         the five placeholder cards, trinkets for Fortune
    Tavern roulette      the default twelve pockets, 5 gp to 50 gp a bet
    Hoard chest auction  the sealed hoard chest, bids from 300 gp by 25 gp,
                         one house bidder up to 600 gp
*/
export const STARTER_GAMES = [
  { key: "cache", kind: "crate", name: "Adventurer's cache", price: 50, pools: [["potions", 2], ["arms", 1]], weights: { common: 55, uncommon: 40, rare: 5 } },
  { key: "coffer", kind: "crate", name: "Arcane coffer", price: 250, pools: [["trinkets", 2], ["arms", 1]], weights: { uncommon: 65, rare: 35 }, rules: { pity: { minRarity: "rare", after: 5 } } },
  { key: "chest", kind: "crate", name: "Dragon's hoard chest", price: 1000, pools: [["hoard", 1]], weights: { rare: 60, veryRare: 30, legendary: 10 }, rules: { pity: { minRarity: "legendary", after: 10 }, stock: 3, stockMax: 3 } },
  { key: "well", kind: "well", name: "Wishing Well", pools: [["potions", 1]], weights: { common: 80, uncommon: 20 } },
  { key: "dice", kind: "dice", name: "Dragon's Teeth", pools: [["trinkets", 1]], weights: { uncommon: 70, rare: 30 }, rules: { prize: true } },
  { key: "deck", kind: "deck", name: "Deck of Many Things", pools: [["trinkets", 1]], weights: { uncommon: 60, rare: 35, veryRare: 5 } },
  { key: "wheel", kind: "roulette", name: "Tavern roulette" },
  { key: "auction", kind: "auction", name: "Hoard chest auction", price: 300, lot: "chest", auction: { increment: 25, reserve: 0, gavelSec: 20, house: { count: 1, budget: 600, chance: 25 } } },
];

export const STARTER_POOL_NAMES = STARTER_POOLS.map(p => p.name);
export const STARTER_GAME_NAMES = STARTER_GAMES.map(g => g.name);

// What of the set the world already has, by name: { pools: { key: id },
// games: [names] }.
export function starterPresent(pools = {}, boxes = {}) {
  const byName = new Map();
  for (const p of Object.values(pools ?? {})) if (!byName.has(p?.name)) byName.set(p?.name, p.id);
  const have = new Set(Object.values(boxes ?? {}).map(b => b?.name));
  return {
    pools: Object.fromEntries(STARTER_POOLS.filter(p => byName.has(p.name)).map(p => [p.key, byName.get(p.name)])),
    games: STARTER_GAME_NAMES.filter(n => have.has(n)),
  };
}
export const hasStarter = present => !!(present && (present.games.length || Object.keys(present.pools).length));

/*
  The records to write. `entries` is the picked entries by pool key (only
  for the pools to create), `reuse` the starter pools already in the world
  by key (their ids), `id()` a new id each call, `names` the games' names
  already taken (a taken name gets " (copy)", copyName). A pool with no
  entries is not made, and the games leave it out of their pools. Returns
  { pools: [new pool records], games: [records], empty: [pool names] }.
*/
export function buildStarter({ entries = {}, reuse = {}, id = () => Math.random().toString(36).slice(2, 12), names = [] } = {}) {
  const poolIds = { ...reuse };
  const pools = [];
  const empty = [];
  for (const spec of STARTER_POOLS) {
    if (poolIds[spec.key]) continue;
    const list = entries[spec.key] ?? [];
    if (!list.length) { empty.push(spec.name); continue; }
    const pool = { id: id(), name: spec.name, entries: list.map(e => ({ ...e })), pools: [] };
    pools.push(pool);
    poolIds[spec.key] = pool.id;
  }
  const taken = new Set(names);
  const nameOf = name => {
    const out = taken.has(name) ? copyName(name, [...taken]) : name;
    taken.add(out);
    return out;
  };
  const games = [];
  const byKey = {};
  for (const g of STARTER_GAMES) {
    const draft = newDraft(g.kind, { id: id() });
    const refs = (g.pools ?? []).filter(([key]) => poolIds[key]).map(([key, share]) => ({ id: poolIds[key], share }));
    const game = {
      ...draft,
      name: nameOf(g.name),
      ...(g.price != null ? { price: g.price } : {}),
      pools: refs,
      weights: g.weights ? weights(g.weights) : draft.weights,
      rules: shelfRules({ ...draft.rules, ...(g.rules ?? {}) }, false),
    };
    if (g.auction) game.auction = { ...draft.auction, ...structuredClone(g.auction), lot: g.lot && byKey[g.lot] ? lotFromCrate(byKey[g.lot]) : null };
    byKey[g.key] = game;
    games.push(game);
  }
  return { pools, games, empty };
}

const list = names => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/*
  The Boxes tab's status line once the set is in: what was added, that
  players can't see it yet, and how to put a game out; then anything left
  out (a missing pack, a pool the compendiums had nothing for). The games
  are named by the rows right under it, each dimmed and tagged off the
  shelf, so the line counts them rather than listing eight names.
*/
export function starterNotice({ pools = [], games = [], reused = 0, notes = [], empty = [] } = {}) {
  const out = [];
  if (!games.length) return [...notes, "Nothing was added."].join(" ");
  const parts = [pools.length ? count(pools.length, "starter pool", "starter pools") : "", count(games.length, "starter game", "starter games")].filter(Boolean);
  out.push(`Added ${list(parts)}${reused ? " as copies" : ""}, all off the shelf${reused ? ", drawing from the starter pools already here" : ""}.`);
  out.push("Players can't see them yet: look each one over, then press On the shelf on its row.");
  if (empty.length) out.push(`${list(empty)} found nothing in the compendiums, so ${empty.length === 1 ? "it was" : "they were"} left out.`);
  return [...out, ...notes].join(" ");
}

// The confirm on a second press: what is here and what Add copies does.
export function starterAgainText(present) {
  const games = present?.games ?? [];
  const pools = STARTER_POOLS.filter(p => present?.pools?.[p.key]).map(p => p.name);
  const here = [games.length ? list(games) : "", pools.length ? `the ${pools.length === 1 ? "pool" : "pools"} ${list(pools)}` : ""].filter(Boolean);
  return `The starter set is already here: ${list(here)}. Add it again? Its games come in as copies, off the shelf, drawing from the starter pools already here; nothing you have is changed.`;
}

/*
  The call to action on an empty tab: a line saying what the tab holds,
  then the offer, with the button that makes it. `where` is "pools" or
  "boxes"; the manager's action is starterCrates (not "add…", the New
  buttons' prefix).
*/
export const STARTER_LABEL = "Add starter crates";
export const STARTER_OFFER = "Or start from a ready set: four pools filled from the dnd5e compendiums, three crates at rising prices and one of every other game, added off the shelf so you can look them over before players see them.";
const EMPTY_LINE = {
  pools: "No pools yet. A pool is the set of items a box can give out: press New pool, then drag items, a folder, a compendium or a roll table onto it.",
  boxes: "No games yet. A box prices a pull from one or more pools: press a New button above, or drop a roll table here.",
};
export function starterCallHTML(where = "boxes", esc = s => String(s ?? "")) {
  return `<div class="lc-starter" role="group" aria-labelledby="lc-starter-offer-${esc(where)}">
        <p class="lc-empty">${esc(EMPTY_LINE[where] ?? EMPTY_LINE.boxes)}</p>
        <div class="lc-starter__card">
          <p class="lc-starter__offer" id="lc-starter-offer-${esc(where)}">${esc(STARTER_OFFER)}</p>
          <button type="button" class="lc-starter__add" data-action="starterCrates"><i class="fas fa-box-open" inert></i> ${STARTER_LABEL}</button>
        </div>
      </div>`;
}
