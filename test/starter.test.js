/*
  The starter crates (starter.js, starterbuild.js): the packs the pools are
  read from and a sentence for one that is missing; the pools picked from
  an index by type, subtype and rarity; the games, each a valid record of
  its kind that its editor and its preview accept, priced and weighted
  within the editors' bounds, every one off the shelf, the deck holding
  only the placeholder cards; a second press adding copies that draw from
  the pools already there; and the builder against a stubbed world, which
  writes each setting once.
*/
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { STARTER_PACKS, STARTER_POOLS, STARTER_GAMES, STARTER_GAME_NAMES, STARTER_POOL_NAMES, starterPackPlan, takesRow, pickEntries, buildStarter, starterPresent, hasStarter, starterNotice, starterAgainText, starterCallHTML, STARTER_LABEL } from "../module/scripts/views/starter.js";
import { addStarterSet } from "../module/scripts/foundry/starterbuild.js";
import { registerSettings } from "../module/scripts/foundry/store.js";
import { NEW_DEFAULTS, addedNotice } from "../module/scripts/views/newgame.js";
import { onShelf } from "../module/scripts/core/shelf.js";
import { kindOf } from "../module/scripts/games/kinds.js";
import { RARITIES } from "../module/scripts/core/config.js";
import { draftBox, boxPreview } from "../module/scripts/views/boxcard.js";
import { draftWell, wellPreview } from "../module/scripts/games/well.js";
import { draftDice, dicePreview } from "../module/scripts/games/dicegame.js";
import { draftDeck, deckPreview, DECK_DEFAULTS, cardsOf } from "../module/scripts/games/deck.js";
import { draftRoulette, roulettePreview, ROULETTE_DEFAULTS, maxStakeOf } from "../module/scripts/games/roulette.js";
import { draftAuction, auctionPreview, lotOf, openingOf, incrementOf, houseOf, MAX_HOUSE, MIN_GAVEL_SEC } from "../module/scripts/games/auction.js";
import { formatPrice, parsePrice } from "../module/scripts/core/currency.js";
import { stockOf } from "../module/scripts/core/limits.js";

const row = (_id, name, type, rarity, sub, extra = {}) => ({ _id, name, type, img: `icons/${_id}.webp`, system: { rarity, ...(sub ? { type: { value: sub } } : {}) }, ...extra });

// One pack's worth of every kind of row a pool must take or leave.
const ITEMS = [
  row("p1", "Potion of Healing", "consumable", "common", "potion"),
  row("p2", "Potion of Greater Healing", "consumable", "uncommon", "potion"),
  row("p3", "Spell Scroll (1st Level)", "consumable", "common", "scroll"),
  row("p4", "Potion of Supreme Healing", "consumable", "veryRare", "potion"),
  row("p5", "Antitoxin", "consumable", "", "potion"),
  row("p6", "Wand of Web", "consumable", "uncommon", "wand"),
  row("p7", "Arrow +1", "consumable", "uncommon", "ammo"),
  row("t1", "Cloak of Protection", "equipment", "uncommon", "wondrous"),
  row("t2", "Ring of Protection", "equipment", "rare", "ring"),
  row("t3", "Ring of Three Wishes", "equipment", "legendary", "ring"),
  row("t4", "Shield +1", "equipment", "uncommon", "shield"),
  row("a1", "Longsword +1", "weapon", "uncommon", "martialM"),
  row("a2", "+2 Warhammer", "weapon", "rare", "martialM"),
  row("a3", "Longsword +3", "weapon", "veryRare", "martialM"),
  row("a4", "Breastplate +2", "equipment", "rare", "medium"),
  row("a5", "Flame Tongue", "weapon", "rare", "martialM"),
  row("a6", "Longsword", "weapon", "", "martialM"),
  row("h1", "Staff of Power", "weapon", "veryRare", "simpleM"),
  row("h2", "Cloak of Invisibility", "equipment", "legendary", "wondrous"),
  row("h3", "Fireball", "spell", "", null),
  row("h4", "Rope, Hempen (50 feet)", "loot", "", null),
];
const spec = key => STARTER_POOLS.find(p => p.key === key);
const namesOf = entries => entries.map(e => e.name);

describe("the packs the pools are read from", () => {
  const listed = ["items", "spells", "equipment24", "monsters"];
  it("reads both on dnd5e 6, the table's rules version first", () => {
    expect(starterPackPlan({ listed, rules: "modern" })).toEqual({ packs: ["dnd5e.equipment24", "dnd5e.items"], notes: [] });
    expect(starterPackPlan({ listed, rules: "legacy" })).toEqual({ packs: ["dnd5e.items", "dnd5e.equipment24"], notes: [] });
  });

  it("reads the SRD items alone on a system that lists no 2024 equipment, without a word", () => {
    expect(starterPackPlan({ listed: ["items", "spells"] })).toEqual({ packs: ["dnd5e.items"], notes: [] });
  });

  it("names a pack the system lists that the world can't open, in a sentence, and reads the rest", () => {
    const plan = starterPackPlan({ listed, loaded: id => id !== "dnd5e.items" });
    expect(plan.packs).toEqual(["dnd5e.equipment24"]);
    expect(plan.notes).toEqual(["The Items (SRD) compendium (dnd5e.items) isn't in this world, so its items were left out."]);
  });

  it("names the SRD items when the system doesn't list them, and says when nothing at all can be read", () => {
    const plan = starterPackPlan({ listed: ["spells"] });
    expect(plan.packs).toEqual([]);
    expect(plan.notes).toEqual(["The Items (SRD) compendium (dnd5e.items) isn't in this world, so its items were left out.", "No dnd5e item compendium could be read."]);
  });

  it("refuses another system with a sentence", () => {
    const plan = starterPackPlan({ system: "pf2e", listed: ["items"] });
    expect(plan.packs).toEqual([]);
    expect(plan.notes[0]).toMatch(/dnd5e system's item compendiums, and this world runs pf2e\.$/);
  });

  it("knows each pack by its name in the manifest, never an item id", () => {
    expect(STARTER_PACKS.map(p => p.name)).toEqual(["items", "equipment24"]);
  });
});

describe("the pools picked from an index", () => {
  const packs = [{ id: "dnd5e.items", rows: ITEMS }];

  it("Potions and scrolls: common and uncommon potions and scrolls, nothing mundane, no wand or ammunition", () => {
    expect(namesOf(pickEntries(spec("potions"), packs))).toEqual(["Potion of Healing", "Potion of Greater Healing", "Spell Scroll (1st Level)"]);
  });

  it("Wondrous trinkets: uncommon and rare worn wonders and rings, not armour", () => {
    expect(namesOf(pickEntries(spec("trinkets"), packs))).toEqual(["Cloak of Protection", "Ring of Protection"]);
  });

  it("Arms and armour: +1 and +2 weapons and armour, whichever side the bonus is written", () => {
    expect(namesOf(pickEntries(spec("arms"), packs))).toEqual(["Shield +1", "Longsword +1", "+2 Warhammer", "Breastplate +2"]);
  });

  it("Dragon's hoard: every physical item rare and up, no spell", () => {
    expect(namesOf(pickEntries(spec("hoard"), packs))).toEqual(["Potion of Supreme Healing", "Ring of Protection", "Ring of Three Wishes", "+2 Warhammer", "Longsword +3", "Breastplate +2", "Flame Tongue", "Staff of Power", "Cloak of Invisibility"]);
  });

  it("makes each entry a compendium reference with its source rarity, as a dropped item's", () => {
    const [first] = pickEntries(spec("potions"), packs);
    expect(first).toEqual({ uuid: "Compendium.dnd5e.items.Item.p1", name: "Potion of Healing", img: "icons/p1.webp", rarity: "common", sourceRarity: "common", weight: 1 });
    const own = pickEntries(spec("potions"), [{ id: "x.y", rows: [row("q", "Potion of Healing", "consumable", "common", "potion", { uuid: "Compendium.x.y.Item.q" })] }]);
    expect(own[0].uuid).toBe("Compendium.x.y.Item.q");
  });

  it("reads dnd5e 6's rarity set as well as the legacy string", () => {
    const r = { _id: "n", name: "Potion of Heroism", type: "consumable", system: { rarities: ["uncommon"], type: { value: "potion" } } };
    expect(takesRow(spec("potions"), r)).toBe(true);
    expect(takesRow(spec("potions"), { ...r, system: { rarities: [], type: { value: "potion" } } })).toBe(false);
  });

  it("guesses from the name when the index carries no subtype", () => {
    const bare = (name, type, rarity) => ({ _id: name, name, type, system: { rarity } });
    expect(takesRow(spec("potions"), bare("Elixir of Health", "consumable", "rare"))).toBe(false);
    expect(takesRow(spec("potions"), bare("Potion of Climbing", "consumable", "common"))).toBe(true);
    expect(takesRow(spec("potions"), bare("Bead of Nourishment", "consumable", "common"))).toBe(false);
    expect(takesRow(spec("arms"), bare("Plate Armor +1", "equipment", "rare"))).toBe(true);
    expect(takesRow(spec("arms"), bare("Rod of the Pact Keeper +1", "equipment", "uncommon"))).toBe(false);
    expect(takesRow(spec("trinkets"), bare("Bracers of Archery", "equipment", "uncommon"))).toBe(true);
    expect(takesRow(spec("trinkets"), bare("Elven Chain Mail", "equipment", "rare"))).toBe(false);
  });

  it("fills a pool from the first pack with anything for it, a later one only when it has none", () => {
    const modern = { id: "dnd5e.equipment24", rows: [row("m1", "Potion of Healing", "consumable", "common", "potion"), row("m2", "Potion of Healing (Greater)", "consumable", "uncommon", "potion"), row("m3", "Potion of Healing", "consumable", "common", "potion")] };
    const got = pickEntries(spec("potions"), [modern, ...packs]);
    expect(got.map(e => e.uuid)).toEqual(["Compendium.dnd5e.equipment24.Item.m1", "Compendium.dnd5e.equipment24.Item.m2"]);
    // The 2024 pack has no +1 weapons: the arms come from the SRD items.
    expect(namesOf(pickEntries(spec("arms"), [modern, ...packs]))).toEqual(["Shield +1", "Longsword +1", "+2 Warhammer", "Breastplate +2"]);
    expect(pickEntries(spec("arms"), [modern])).toEqual([]);
  });
});

// The set as one press builds it from ITEMS.
function built(over = {}) {
  let n = 0;
  const entries = Object.fromEntries(STARTER_POOLS.map(p => [p.key, pickEntries(p, [{ id: "dnd5e.items", rows: ITEMS }])]));
  return buildStarter({ entries, id: () => `id${++n}`, ...over });
}
const poolMap = set => Object.fromEntries(set.pools.map(p => [p.id, p]));

// What each kind's editor form holds for a record, so its draft function
// can read the record back as Save would.
function formOf(game, poolIds) {
  const v = { price: formatPrice(game.price) };
  for (const id of poolIds) { const ref = game.pools.find(r => r.id === id); if (ref) v[`pool.${id}`] = true; v[`share.${id}`] = String(ref?.share ?? 1); }
  for (const r of RARITIES) v[`w.${r}`] = String(game.weights[r]);
  return v;
}

describe("the games", () => {
  const set = built();
  const pools = poolMap(set);
  const poolIds = Object.keys(pools);

  it("are one of every kind, named as the starter set names them, the three crates at rising prices", () => {
    expect(set.games.map(g => g.name)).toEqual(STARTER_GAME_NAMES);
    expect(set.games.map(kindOf)).toEqual(["crate", "crate", "crate", "well", "dice", "deck", "roulette", "auction"]);
    expect(new Set(set.games.map(kindOf))).toEqual(new Set(Object.keys(NEW_DEFAULTS)));
    const crates = set.games.filter(g => kindOf(g) === "crate").map(g => g.price);
    expect(crates).toEqual([50, 250, 1000]);
  });

  it("are every one added off the shelf, and the status line says so", () => {
    for (const g of set.games) {
      expect(onShelf(g)).toBe(false);
      expect(addedNotice(g)).toMatch(/added off the shelf\. Players can't see it/);
    }
  });

  it("keep every field their kind's New has, under ids of their own", () => {
    for (const g of set.games) for (const key of Object.keys(NEW_DEFAULTS[kindOf(g)]())) expect(g).toHaveProperty(key);
    expect(new Set(set.games.map(g => g.id)).size).toBe(set.games.length);
  });

  it("draw only from the starter pools, each of which has items", () => {
    expect(set.pools.map(p => p.name)).toEqual(STARTER_POOL_NAMES);
    for (const p of set.pools) expect(p.entries.length).toBeGreaterThan(0);
    for (const g of set.games) for (const ref of g.pools) expect(pools[ref.id]).toBeTruthy();
  });

  it("are priced as each editor reads a price, and weighted 0 or more", () => {
    for (const g of set.games) {
      expect(g.price).toBeGreaterThan(0);
      expect(parsePrice(formatPrice(g.price))).toBe(g.price);
      expect(Object.keys(g.weights).sort()).toEqual([...RARITIES].sort());
      for (const r of RARITIES) expect(g.weights[r]).toBeGreaterThanOrEqual(0);
    }
  });

  it("read back unchanged through each editor's draft, as Save would store them", () => {
    for (const g of set.games) {
      const v = formOf(g, poolIds);
      const draft = {
        crate: () => draftBox(g, v, poolIds),
        well: () => draftWell(g, { ...v, "o.nothing": g.odds.nothing, "o.coin": g.odds.coin, "o.item": g.odds.item }, poolIds),
        dice: () => draftDice(g, { ...v, formula: g.dice.formula, target: g.dice.target, multiplier: g.dice.multiplier, prize: g.rules.prize }, poolIds),
        deck: () => draftDeck(g, { ...v, step: g.deck.step, cards: cardsOf(g).map(c => c.id), ...Object.fromEntries(cardsOf(g).flatMap(c => [[`c.${c.id}.label`, c.label], [`c.${c.id}.kind`, c.kind], [`c.${c.id}.weight`, c.weight], [`c.${c.id}.once`, c.once], [`c.${c.id}.gp`, c.gp], [`c.${c.id}.text`, c.text]])) }, poolIds),
        roulette: () => draftRoulette(g, { ...v }, poolIds),
        auction: () => draftAuction(g, { price: g.price, increment: g.auction.increment, reserve: g.auction.reserve, gavelSec: g.auction.gavelSec, houseCount: g.auction.house.count, houseBudget: g.auction.house.budget, houseChance: g.auction.house.chance }),
      }[kindOf(g)]();
      expect(draft.pools).toEqual(g.pools);
      expect(draft.price).toBe(g.price);
      if (kindOf(g) !== "auction") expect(draft.weights).toEqual(g.weights);
      if (g.deck) expect(draft.deck.cards).toEqual(cardsOf(g));
      if (g.auction) expect(draft.auction).toEqual(g.auction);
    }
  });

  it("each pass its editor's preview with nothing to warn about", () => {
    for (const g of set.games) {
      const preview = {
        crate: () => boxPreview(g, pools),
        well: () => wellPreview(g, pools),
        dice: () => dicePreview(g, pools),
        deck: () => deckPreview(g, pools, []),
        roulette: () => roulettePreview(g, pools),
        auction: () => auctionPreview(g),
      }[kindOf(g)]();
      expect([g.name, preview.note]).toEqual([g.name, ""]);
    }
  });

  it("crates: a pity rarity the crate can roll, and the hoard chest's stock full", () => {
    for (const g of set.games.filter(x => kindOf(x) === "crate" && x.rules.pity)) {
      const from = RARITIES.indexOf(g.rules.pity.minRarity);
      expect(RARITIES.slice(from).some(r => g.weights[r] > 0)).toBe(true);
      expect(g.rules.pity.after).toBeGreaterThanOrEqual(1);
    }
    expect(stockOf(set.games.find(g => g.name === "Dragon's hoard chest"))).toEqual({ left: 3, max: 3 });
  });

  it("the deck holds the five placeholder cards and no other text", () => {
    const deck = set.games.find(g => kindOf(g) === "deck");
    expect(deck.deck.cards).toEqual(DECK_DEFAULTS.cards);
    expect(deck.deck.cards).toHaveLength(5);
    const texts = deck.deck.cards.map(c => c.text).filter(Boolean);
    expect(texts).toEqual(["Something is set in motion. The GM says what."]);
    expect(deck.deck.cards.map(c => c.label)).toEqual(["Fortune", "Windfall", "Ruin", "Omen", "A blank card"]);
  });

  it("the wheel turns on the default pockets, its bets within its own range", () => {
    const wheel = set.games.find(g => kindOf(g) === "roulette");
    expect(wheel.roulette.pockets).toEqual(ROULETTE_DEFAULTS.pockets);
    expect(wheel.price).toBeLessThanOrEqual(maxStakeOf(wheel));
  });

  it("the auction sells the sealed hoard chest, with a house that can afford to raise", () => {
    const auction = set.games.find(g => kindOf(g) === "auction");
    const chest = set.games.find(g => g.name === "Dragon's hoard chest");
    expect(lotOf(auction)).toEqual({ type: "crate", boxId: chest.id, name: chest.name, img: "", rarity: "none" });
    const house = houseOf(auction);
    expect(house.count).toBeLessThanOrEqual(MAX_HOUSE);
    expect(house.budget).toBeGreaterThan(openingOf(auction) + incrementOf(auction));
    expect(auction.auction.gavelSec).toBeGreaterThanOrEqual(MIN_GAVEL_SEC);
  });

  it("leaves out a pool the compendiums had nothing for, and the games drop it", () => {
    let n = 0;
    const entries = Object.fromEntries(STARTER_POOLS.map(p => [p.key, p.key === "arms" ? [] : pickEntries(p, [{ id: "dnd5e.items", rows: ITEMS }])]));
    const thin = buildStarter({ entries, id: () => `t${++n}` });
    expect(thin.empty).toEqual(["Arms and armour"]);
    expect(thin.pools.map(p => p.name)).not.toContain("Arms and armour");
    const cache = thin.games.find(g => g.name === "Adventurer's cache");
    expect(cache.pools).toHaveLength(1);
    expect(starterNotice({ ...thin })).toMatch(/Arms and armour found nothing in the compendiums, so it was left out\./);
  });
});

describe("a second press", () => {
  it("finds the set by name and says what is here", () => {
    const set = built();
    const present = starterPresent(poolMap(set), Object.fromEntries(set.games.map(g => [g.id, g])));
    expect(hasStarter(present)).toBe(true);
    expect(present.games).toEqual(STARTER_GAME_NAMES);
    expect(Object.keys(present.pools)).toEqual(["potions", "trinkets", "arms", "hoard"]);
    expect(starterAgainText(present)).toMatch(/^The starter set is already here: Adventurer's cache, .* and Hoard chest auction and the pools Potions and scrolls, Wondrous trinkets, Arms and armour and Dragon's hoard\. Add it again\? Its games come in as copies, off the shelf/);
    expect(hasStarter(starterPresent({}, {}))).toBe(false);
  });

  it("adds the games as copies drawing from the pools already there, making no pool", () => {
    const first = built();
    const present = starterPresent(poolMap(first), Object.fromEntries(first.games.map(g => [g.id, g])));
    const again = built({ reuse: present.pools, names: first.games.map(g => g.name), id: (() => { let n = 100; return () => `id${++n}`; })() });
    expect(again.pools).toEqual([]);
    expect(again.games.map(g => g.name)).toEqual(STARTER_GAME_NAMES.map(n => `${n} (copy)`));
    const ids = new Set(Object.values(present.pools));
    for (const g of again.games) for (const ref of g.pools) expect(ids.has(ref.id)).toBe(true);
    const auction = again.games.find(g => kindOf(g) === "auction");
    expect(auction.auction.lot.boxId).toBe(again.games.find(g => g.name === "Dragon's hoard chest (copy)").id);
    expect(again.games.every(g => !onShelf(g))).toBe(true);
    expect(starterNotice({ ...again, reused: 4 })).toBe("Added 8 starter games as copies, all off the shelf, drawing from the starter pools already here. Players can't see them yet: look each one over, then press On the shelf on its row.");
  });
});

describe("the words", () => {
  it("the status line names what came in and how to put it out", () => {
    const set = built();
    expect(starterNotice(set)).toBe("Added 4 starter pools and 8 starter games, all off the shelf. Players can't see them yet: look each one over, then press On the shelf on its row.");
    expect(starterNotice({ games: [], notes: ["No dnd5e item compendium could be read."] })).toBe("No dnd5e item compendium could be read. Nothing was added.");
  });

  it("the empty tabs offer the set through one action, not a New's", () => {
    for (const where of ["pools", "boxes"]) {
      const html = starterCallHTML(where);
      expect(html).toContain(`data-action="starterCrates"`);
      expect(html).toContain(STARTER_LABEL);
      expect(html).toMatch(/added off the shelf/);
    }
    expect(starterCallHTML("pools")).toMatch(/^<div class="lc-starter"[\s\S]*No pools yet\./);
    expect(starterCallHTML("boxes")).toMatch(/No games yet\./);
  });

  it("every game in the set is described in STARTER_GAMES", () => {
    expect(STARTER_GAMES.map(g => g.key)).toEqual(["cache", "coffer", "chest", "well", "dice", "deck", "wheel", "auction"]);
  });
});

/* ---------- The builder, against a stubbed world ---------- */

class Collection extends Map { *[Symbol.iterator]() { yield* this.values(); } }
function pack(collection, rows) {
  const index = new Collection(rows.map(r => [r._id, { ...r, uuid: `Compendium.${collection}.Item.${r._id}` }]));
  return { collection, documentName: "Item", index, getIndex: vi.fn(async () => index), getDocuments: vi.fn(async () => []) };
}

let settings, writes;
function world({ listed = ["items", "equipment24"], packs = {}, rules = "modern" } = {}) {
  settings = new Map();
  writes = [];
  vi.stubGlobal("foundry", { utils: { deepClone: v => structuredClone(v) } });
  vi.stubGlobal("game", {
    system: { id: "dnd5e", packs: new Set(listed.map(name => ({ name }))) },
    packs: new Map(Object.entries(packs)),
    settings: {
      register: (_m, key, cfg) => settings.set(key, cfg.default),
      get: (m, key) => (m === "dnd5e" && key === "rulesVersion" ? rules : settings.get(key)),
      set: async (_m, key, v) => { writes.push(key); settings.set(key, v); },
    },
  });
  registerSettings();
}
beforeEach(() => world());
afterEach(() => vi.unstubAllGlobals());

describe("addStarterSet", () => {
  const modern = [row("m1", "Potion of Healing", "consumable", "common", "potion"), row("m2", "Bag of Tricks", "equipment", "uncommon", "wondrous")];

  it("fills every pool from the packs' indexes and writes the pools and the games once each, off the shelf", async () => {
    const items = pack("dnd5e.items", ITEMS), eq = pack("dnd5e.equipment24", modern);
    world({ packs: { "dnd5e.items": items, "dnd5e.equipment24": eq } });
    const report = await addStarterSet();
    expect(writes).toEqual(["pools", "boxes"]);
    const pools = Object.values(settings.get("pools"));
    expect(pools.map(p => p.name)).toEqual(STARTER_POOL_NAMES);
    for (const p of pools) expect(p.entries.length).toBeGreaterThan(0);
    // The 2024 potions alone under the modern rules; the trinkets too. The
    // arms and the hoard, which the 2024 rows here have none of, from the SRD.
    const uuids = name => pools.find(p => p.name === name).entries.map(e => e.uuid.split(".").slice(1, 3).join("."));
    expect(new Set(uuids("Potions and scrolls"))).toEqual(new Set(["dnd5e.equipment24"]));
    expect(new Set(uuids("Wondrous trinkets"))).toEqual(new Set(["dnd5e.equipment24"]));
    expect(new Set(uuids("Arms and armour"))).toEqual(new Set(["dnd5e.items"]));
    expect(new Set(uuids("Dragon's hoard"))).toEqual(new Set(["dnd5e.items"]));
    const games = Object.values(settings.get("boxes"));
    expect(games.map(g => g.name)).toEqual(STARTER_GAME_NAMES);
    expect(games.every(g => !onShelf(g))).toBe(true);
    expect(report.notes).toEqual([]);
    expect(report.games).toHaveLength(8);
    // The index is read with the item subtype on top of the rarity fields.
    expect(items.getIndex).toHaveBeenCalledWith({ fields: expect.arrayContaining(["system.rarity", "system.rarities", "system.type.value"]) });
  });

  it("reports a pack the system lists that the world doesn't have, and builds from the rest", async () => {
    world({ packs: { "dnd5e.items": pack("dnd5e.items", ITEMS) } });
    const report = await addStarterSet();
    expect(report.notes).toEqual(["The Equipment (2024) compendium (dnd5e.equipment24) isn't in this world, so its items were left out."]);
    expect(starterNotice(report)).toMatch(/all off the shelf\. .* The Equipment \(2024\) compendium \(dnd5e\.equipment24\) isn't in this world, so its items were left out\.$/);
    expect(Object.values(settings.get("pools"))).toHaveLength(4);
  });

  it("writes nothing when no pack can be read, and says so", async () => {
    world({ listed: ["items"], packs: {} });
    const report = await addStarterSet();
    expect(writes).toEqual([]);
    expect(starterNotice(report)).toBe("The Items (SRD) compendium (dnd5e.items) isn't in this world, so its items were left out. No dnd5e item compendium could be read. Nothing was added.");
  });

  it("names a pack whose index fails, and builds from the one that read", async () => {
    const broken = pack("dnd5e.equipment24", modern);
    broken.getIndex = vi.fn(async () => { throw new Error("socket closed"); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    world({ packs: { "dnd5e.items": pack("dnd5e.items", ITEMS), "dnd5e.equipment24": broken } });
    const report = await addStarterSet();
    expect(report.notes).toEqual(["The dnd5e.equipment24 compendium couldn't be read, so its items were left out."]);
    expect(report.games).toHaveLength(8);
  });

  it("a second time, adds copies drawing from the pools already there without reading a pack", async () => {
    const items = pack("dnd5e.items", ITEMS);
    world({ listed: ["items"], packs: { "dnd5e.items": items } });
    await addStarterSet();
    const poolIds = Object.keys(settings.get("pools"));
    items.getIndex.mockClear();
    const report = await addStarterSet();
    expect(items.getIndex).not.toHaveBeenCalled();
    expect(Object.keys(settings.get("pools"))).toEqual(poolIds);
    expect(report.games.map(g => g.name)).toEqual(STARTER_GAME_NAMES.map(n => `${n} (copy)`));
    expect(Object.values(settings.get("boxes"))).toHaveLength(16);
    expect(report.reused).toBe(4);
  });
});
