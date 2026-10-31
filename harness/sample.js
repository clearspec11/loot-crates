// Sample pools and a box for the harness and screenshots. Names are SRD
// magic items; art paths are Foundry core icons, which the harness shows when
// it is served with FOUNDRY_URL (the cards fall back to initials otherwise).
const ICONS = {
  "Potion of Healing": "icons/consumables/potions/potion-tube-corked-red.webp",
  "Spell Scroll (Cantrip)": "icons/sundries/scrolls/scroll-bound-sealed-red.webp",
  "Cloak of Billowing": "icons/equipment/back/cloak-collared-red.webp",
  "Moon-Touched Sword": "icons/weapons/swords/sword-guard-blue.webp",
  "Candle of the Deep": "icons/sundries/lights/candle-unlit-white.webp",
  "Pole of Collapsing": "icons/weapons/staves/staff-simple.webp",
  "Bag of Holding": "icons/containers/bags/pack-engraved-leather-tan.webp",
  "Boots of Elvenkind": "icons/equipment/feet/boots-pointed-cloth-green.webp",
  "Cloak of Protection": "icons/equipment/back/cloak-heavy-fur-blue.webp",
  "Wand of Magic Missiles": "icons/weapons/wands/wand-gem-blue.webp",
  "Goggles of Night": "icons/equipment/head/goggles-leather-blue.webp",
  "Immovable Rod": "icons/commodities/tech/pipe-lead-closed.webp",
  "Flame Tongue": "icons/weapons/swords/sword-broad-red.webp",
  "Ring of Spell Storing": "icons/equipment/finger/ring-cabochon-silver-gold-red.webp",
  "Boots of Speed": "icons/equipment/feet/boots-leather-green.webp",
  "Cloak of Displacement": "icons/equipment/back/cloak-brown-accent-brown-layered-collared-fur.webp",
  "Wand of Fireballs": "icons/weapons/wands/wand-carved-fire.webp",
  "Staff of Power": "icons/weapons/staves/staff-ornate-banded-purple.webp",
  "Ring of Regeneration": "icons/equipment/finger/ring-faceted-gold-purple.webp",
  "Oathbow": "icons/weapons/bows/longbow-recurve-leather-red.webp",
  "Holy Avenger": "icons/weapons/swords/greatsword-guard-gem-blue.webp",
  "Vorpal Sword": "icons/weapons/swords/scimitar-guard-gold.webp",
  "Ring of Three Wishes": "icons/equipment/finger/ring-cabochon-gold-purple.webp",
  "Brindle's Lantern": "icons/sundries/lights/lantern-steel.webp",
  "Thornwick Blade": "icons/weapons/swords/greatsword-guard.webp",
  "Crown of the Pie King": "icons/commodities/gems/gem-rough-cushion-purple-pink.webp"
};
const item = (name, rarity, weight = 1) => ({ uuid: `sample.${name.replace(/\W+/g, "-").toLowerCase()}`, name, img: ICONS[name] ? `/${ICONS[name]}` : "", rarity, weight });

export const POOLS = {
  core: {
    id: "core", name: "Core magic items", pools: [],
    entries: [
      item("Potion of Healing", "common", 3), item("Spell Scroll (Cantrip)", "common", 2), item("Cloak of Billowing", "common"),
      item("Moon-Touched Sword", "common"), item("Candle of the Deep", "common"), item("Pole of Collapsing", "common"),
      item("Bag of Holding", "uncommon"), item("Boots of Elvenkind", "uncommon"), item("Cloak of Protection", "uncommon"),
      item("Wand of Magic Missiles", "uncommon"), item("Goggles of Night", "uncommon"), item("Immovable Rod", "uncommon"),
      item("Flame Tongue", "rare"), item("Ring of Spell Storing", "rare"), item("Boots of Speed", "rare"),
      item("Cloak of Displacement", "rare"), item("Wand of Fireballs", "rare"),
      item("Staff of Power", "veryRare"), item("Ring of Regeneration", "veryRare"), item("Oathbow", "veryRare"),
      item("Holy Avenger", "legendary"), item("Vorpal Sword", "legendary"), item("Ring of Three Wishes", "legendary"),
    ],
  },
  homebrew: {
    id: "homebrew", name: "Leigh's homebrew", pools: [],
    entries: [item("Brindle's Lantern", "rare"), item("Thornwick Blade", "uncommon"), item("Crown of the Pie King", "legendary")],
  },
};

/*
  The world the editors' harness states draw on (views/editors.js): the
  two sample pools plus eight more, as a GM has after a few sessions, so
  the pool picker folds the ones a game doesn't use under "Add a pool"
  with its search (poolpicker.js).
*/
const more = (id, name, entries) => ({ id, name, pools: [], entries });
export const EDITOR_POOLS = {
  ...POOLS,
  potions: more("potions", "Potions and scrolls", [item("Potion of Healing", "common", 4), item("Spell Scroll (Cantrip)", "common", 2)]),
  trinkets: more("trinkets", "Wondrous trinkets", [item("Cloak of Billowing", "common"), item("Candle of the Deep", "common"), item("Goggles of Night", "uncommon")]),
  arms: more("arms", "Arms and armour", [item("Moon-Touched Sword", "common"), item("Flame Tongue", "rare"), item("Oathbow", "veryRare")]),
  hoard: more("hoard", "Dragon's hoard", [item("Staff of Power", "veryRare"), item("Holy Avenger", "legendary"), item("Ring of Three Wishes", "legendary")]),
  goblin: more("goblin", "Goblin's purse", [item("Bag of Holding", "uncommon"), item("Immovable Rod", "uncommon")]),
  sea: more("sea", "Sea chest", [item("Cloak of Protection", "uncommon"), item("Boots of Speed", "rare")]),
  temple: more("temple", "Temple offerings", [item("Ring of Regeneration", "veryRare")]),
  fence: more("fence", "Thieves' guild fence", [item("Boots of Elvenkind", "uncommon"), item("Wand of Magic Missiles", "uncommon"), item("Ring of Spell Storing", "rare")]),
};

/*
  A crate made from a roll table (newgame.js crateFromTable): "Goblin's
  Pockets", its items copied into a pool of their own at the table's
  weights (a nested table of trinkets flattened into it), drawn at the
  table's own odds, its text results ("lint and a button") counted as
  nothing on a quarter of pulls. The Flame Tongue is 1 in 100 of the items.
*/
export const TABLE_POOL = {
  id: "pockets", name: "Goblin's Pockets", pools: [],
  entries: [
    item("Flame Tongue", "rare", 1), item("Potion of Healing", "common", 40), item("Spell Scroll (Cantrip)", "common", 20),
    item("Candle of the Deep", "common", 15), item("Pole of Collapsing", "common", 10), item("Bag of Holding", "uncommon", 8),
    item("Boots of Elvenkind", "uncommon", 6),
  ],
};
export const TABLE_CRATE = {
  id: "pockets-crate", name: "Goblin's Pockets", price: 5, pools: [{ id: "pockets", share: 1 }],
  weights: { common: 60, uncommon: 26, rare: 10, veryRare: 3, legendary: 1, artifact: 0 },
  rules: { oddsMode: "weight", missChance: 0.25 },
  fromTable: { uuid: "RollTable.pockets", name: "Goblin's Pockets", items: 7, flattened: 1, textChance: 0.25 },
};
// What a drop of that table on a pool found (store.js entriesFromDrop):
// the seven items, one nested table flattened, two text results and a
// spell skipped, one item already in the pool.
export const TABLE_PLAN = {
  label: "Goblin's Pockets", kind: "RollTable", uuid: "RollTable.pockets",
  entries: TABLE_POOL.entries.slice(1),
  skipped: { duplicates: 1, notLoot: { spell: 1 }, notItems: 0, text: 2, tooDeep: 0 },
  flattened: 1, textWeight: 33, textChance: 0.25,
};

export const BOX = {
  id: "adventurer", name: "Adventurer's Crate", price: 150,
  pools: [{ id: "core", share: 4 }, { id: "homebrew", share: 1 }],
  weights: { common: 55, uncommon: 28, rare: 12, veryRare: 4, legendary: 1 },
  rules: { pity: { after: 8, minRarity: "rare" }, noDuplicates: false, stock: null },
};

// The Wishing Well (well.js): a silver a throw, almost always nothing, a
// coin back now and then, rarely something from Leigh's homebrew; three
// throws a day for each character.
export const WELL = {
  id: "well", kind: "well", name: "Wishing Well", price: 0.1,
  pools: [{ id: "homebrew", share: 1 }],
  weights: { common: 0, uncommon: 60, rare: 30, veryRare: 0, legendary: 10 },
  odds: { nothing: 90, coin: 8, item: 2 },
  rules: { cap: 3 },
};
// Tam's buys of the Pauper's Box (its limit per character is two), newest first.
export const limitBuys = n => Array.from({ length: n }, (_, i) => ({ id: `buy${i}`, kind: "crate", boxId: "common", boxName: "Pauper's Box", actorId: "tam", actorName: "Tam Thornwick", day: "y1d1", at: Date.UTC(2026, 9, 20, 9, 30 - i), price: 25, payoutCp: 0, name: "Rope" }));
// Tam's throws at it today (the harness's day is "y1d1"), newest first.
export const wellThrows = n => Array.from({ length: n }, (_, i) => ({ id: `throw${i}`, kind: "well", outcome: "nothing", boxId: WELL.id, boxName: WELL.name, actorId: "tam", actorName: "Tam Thornwick", day: "y1d1", at: Date.UTC(2026, 9, 20, 10, 30 - i), price: WELL.price, payoutCp: 0, name: "Nothing" }));

// Dragon's Teeth (dicegame.js): 10 gp to roll 3d6 over the dragon's 12,
// paying three times the stake; a perfect 18 also wins something from
// Leigh's homebrew.
export const DICE = {
  id: "dice", kind: "dice", name: "Dragon's Teeth", price: 10,
  pools: [{ id: "homebrew", share: 1 }],
  weights: { common: 0, uncommon: 60, rare: 30, veryRare: 0, legendary: 10 },
  dice: { formula: "3d6", target: 12, multiplier: 3 },
  rules: { prize: true },
};
// The faces each harness outcome shows: a win, a loss, a perfect roll.
export const DICE_FACES = { win: [4, 6, 5], lose: [2, 3, 4], prize: [6, 6, 6] };

// The Deck of Many Things (deck.js): 10 gp a draw, half again for each
// draw in a row; an item card from Leigh's homebrew, a windfall, a ruin,
// an omen the GM plays out (once per deck) and a blank.
export const DECK = {
  id: "deck", kind: "deck", name: "The Thornwick Deck", price: 10,
  pools: [{ id: "homebrew", share: 1 }],
  weights: { common: 0, uncommon: 60, rare: 30, veryRare: 0, legendary: 10 },
  deck: { step: 1.5, shuffledAt: 0, cards: [
    { id: "fortune", label: "Fortune", kind: "item", weight: 2 },
    { id: "windfall", label: "Windfall", kind: "coins", weight: 2, gp: 50 },
    { id: "ruin", label: "Ruin", kind: "loss", weight: 2, gp: 20 },
    { id: "omen", label: "Omen", kind: "effect", weight: 1, once: true, text: "The next long rest is interrupted. The GM says by what." },
    { id: "blank", label: "A blank card", kind: "blank", weight: 3 },
  ] },
  rules: {},
};
// Tam's draws at it in a row (the harness's now is Date.now()), newest first.
export const deckDraws = (n, now = Date.now()) => Array.from({ length: n }, (_, i) => ({ id: `draw${i}`, kind: "deck", boxId: DECK.id, boxName: DECK.name, actorId: "tam", actorName: "Tam Thornwick", cardId: "blank", card: "A blank card", cardKind: "blank", at: now - 20000 * (i + 1), price: DECK.price, payoutCp: 0, name: "A blank card" }));

// The Wheel of Fate (roulette.js): twelve pockets in Evocation red and
// Abjuration black across four rarity bands, 5 gp to 50 gp a bet, three
// bets a character, a 45-second window; a winning bet on a rarity band
// also draws an item of that rarity from Leigh's homebrew.
export const ROULETTE = {
  id: "wheel", kind: "roulette", name: "Wheel of Fate", price: 5,
  pools: [{ id: "homebrew", share: 1 }],
  weights: {},
  roulette: {
    colours: ["Evocation red", "Abjuration black"],
    pockets: [
      { colour: 0, rarity: "common" }, { colour: 1, rarity: "uncommon" }, { colour: 0, rarity: "common" }, { colour: 1, rarity: "uncommon" },
      { colour: 1, rarity: "rare" }, { colour: 0, rarity: "common" }, { colour: 0, rarity: "uncommon" }, { colour: 1, rarity: "common" },
      { colour: 0, rarity: "legendary" }, { colour: 1, rarity: "uncommon" }, { colour: 1, rarity: "common" }, { colour: 0, rarity: "rare" },
    ],
    payouts: { colour: 2, parity: 2, number: 12, rarity: 3 },
    itemOnRarity: true, maxStake: 50, maxBets: 3, windowSec: 45,
  },
  rules: {},
};
// The round the harness's wheel is in: open with its clock 42 s out.
export const rouletteRound = (now = Date.now(), { status = "open", closesAt = now + 42000 } = {}) => ({ id: "R1", boxId: ROULETTE.id, kind: "roulette", status, opensAt: now - 3000, closesAt });
// Three characters' bets on it, newest first: Tam on red and on 7, Orla
// on Rare and on even, Bo on black.
const WHEEL_BETS = [
  ["bo", "Bo Marrow", { type: "colour", pick: 1 }, "Abjuration black", 10],
  ["orla", "Orla Vane", { type: "parity", pick: "even" }, "Even", 5],
  ["orla", "Orla Vane", { type: "rarity", pick: "rare" }, "Rare", 5],
  ["tam", "Tam Thornwick", { type: "number", pick: 7 }, "7", 5],
  ["tam", "Tam Thornwick", { type: "colour", pick: 0 }, "Evocation red", 20],
];
export const wheelStakes = (now = Date.now(), n = WHEEL_BETS.length) => WHEEL_BETS.slice(0, n).map(([actorId, actorName, bet, label, price], i) => ({
  id: `bet${i}`, kind: "roulette", boxId: ROULETTE.id, boxName: ROULETTE.name, actorId, actorName, userId: actorId, itemId: null,
  price, payoutCp: 0, status: "open", roundId: "R1", at: now - 1000 * (i + 1),
  stake: { label, type: bet.type, pick: bet.pick, swatch: bet.type === "rarity" ? bet.pick : "coin", stake: price }, name: label,
}));

// The Auction (auction.js): The Midnight Lot sells a Flame Tongue, bids
// opening at 20 gp and rising by 5 gp, a 40 gp reserve, a 20-second gavel
// and two house bidders up to 60 gp; The Sealed Lot sells the Adventurer's
// Crate unopened, opened for the winner at the hammer.
const flame = item("Flame Tongue", "rare");
export const AUCTION = {
  id: "auction", kind: "auction", name: "The Midnight Lot", price: 20, pools: [], weights: {},
  auction: { lot: { type: "item", uuid: flame.uuid, name: flame.name, img: flame.img, rarity: "rare" }, increment: 5, reserve: 40, gavelSec: 20, house: { count: 2, budget: 60, chance: 25 } },
  rules: {},
};
export const AUCTION_CRATE = { ...AUCTION, id: "auction-crate", name: "The Sealed Lot", auction: { ...AUCTION.auction, lot: { type: "crate", boxId: "adventurer", name: "Adventurer's Crate" }, reserve: 0 } };
// The auction's round: open, its gavel 14 s from falling.
export const auctionRound = (now = Date.now(), { status = "open", closesAt = now + 14000, boxId = AUCTION.id } = {}) => ({ id: "A1", boxId, kind: "auction", status, opensAt: now - 40000, closesAt });
// Its bids, newest first: Tam's 20 opened, Bo's 25 and Orla's 35 beat it,
// House bidder 1's 40 beat Orla's; with `tamLast`, Tam's 45 is on top.
const AUCTION_BIDS = [["tam", "Tam Thornwick", 20], ["bo", "Bo Marrow", 25], ["orla", "Orla Vane", 35], [null, "House bidder 1", 40, 1]];
export function auctionBids(now = Date.now(), { tamLast = false, boxId = AUCTION.id, boxName = AUCTION.name } = {}) {
  const list = tamLast ? [...AUCTION_BIDS, ["tam", "Tam Thornwick", 45]] : AUCTION_BIDS;
  return list.map(([actorId, actorName, amount, house], i) => ({
    id: `bid${i}`, kind: "auction", boxId, boxName, actorId, actorName, userId: actorId, itemId: null,
    price: house ? 0 : amount, payoutCp: 0, roundId: "A1", at: now - 4000 * (list.length - i), stake: { label: `Bid ${amount} gp`, amount, ...(house ? { house } : {}) }, name: `Bid ${amount} gp`,
    ...(house ? { house: true } : {}),
    ...(i === list.length - 1 ? { status: "open" } : { status: "refunded", refunded: now - 4000 * (list.length - i - 1), refundReason: "outbid" }),
  })).reverse();
}

// Scratch tickets (scratch.js): the Fortune Ticket, the approved mockup's,
// 5 gp, lucky numbers on a 4 x 3 grid with a 25 gp bonus spot, roll 1 of
// 100 drawing its Rare from the core pool; and the Market Scratchie, 1 gp,
// match 3 on a 3 x 2 grid, a roll of 20, printed in Fey market green.
export const SCRATCH = {
  id: "fortune", kind: "scratch", name: "Fortune Ticket", price: 5, pools: [{ id: "core", share: 1 }], weights: {},
  layout: "lucky", grid: { cols: 4, rows: 3 }, bonus: { on: true, gp: 25 }, theme: "hoard",
  roll: { id: 1, size: 100, prizes: [{ count: 1, item: { rarity: "rare" } }, { count: 2, gp: 100 }, { count: 5, gp: 25 }, { count: 12, gp: 10 }, { count: 20, gp: 5 }, { count: 3, bonus: true }] },
  rules: {},
};
export const SCRATCH_MATCH3 = {
  id: "market", kind: "scratch", name: "Market Scratchie", price: 1, pools: [{ id: "core", share: 1 }], weights: {},
  layout: "match3", grid: { cols: 3, rows: 2 }, bonus: { on: false, gp: 0 }, theme: "fey",
  roll: { id: 2, size: 20, prizes: [{ count: 1, item: { rarity: "uncommon" } }, { count: 4, gp: 5 }, { count: 5, gp: 1 }] },
  rules: {},
};
// The tickets sold from each, newest first: 43 of the Fortune Ticket's
// (both 100 gp prizes gone), and every one of the Market Scratchie's roll 2.
const sold = (game, tiers, actors = ["tam", "orla", "bo"]) => tiers.map((tier, i) => ({
  id: `${game.id}${i}`, kind: "scratch", boxId: game.id, boxName: game.name, actorId: actors[i % actors.length], actorName: actors[i % actors.length],
  rollId: game.roll.id, tier, at: Date.UTC(2026, 9, 28, 9, 0, i), price: game.price, payoutCp: 0, name: tier,
}));
const repeat = (pairs) => pairs.flatMap(([tier, n]) => Array(n).fill(tier));
export const scratchTickets = () => [
  ...sold(SCRATCH, repeat([["gp.100", 2], ["gp.25", 1], ["gp.10", 4], ["gp.5", 6], ["bonus", 1], ["dud", 29]])),
  ...sold(SCRATCH_MATCH3, repeat([["item.uncommon", 1], ["gp.5", 4], ["gp.1", 5], ["dud", 10]])),
];

// The Pull log's sample (logtable.js), newest first:// The Pull log's sample (logtable.js), newest first: Orla's Royal Vault
// pull refunded a moment later; Tam's pity pull whose rarity the GM set
// over the source's; Bo's Pauper's Box sale called off after the charge; a
// dice win with its faces and payout; a deck draw that took coins (the
// bane); the wheel's settled round with its five stakes under it (Tam's
// two won, 30 gp back on 7 and 40 gp on red); then, days ago, Tam's five
// throws at the well that gave nothing and her Pauper's Box buy.
export const sampleLog = (now = Date.now()) => [
  { id: "p1", kind: "crate", boxId: "royal", boxName: "Royal Vault", actorId: "orla", actorName: "Orla Vane", at: now - 60000, price: 1200, payoutCp: 0, name: "Staff of Power", rarity: "veryRare", refunded: now - 30000 },
  { id: "p2", kind: "crate", boxId: BOX.id, boxName: BOX.name, actorId: "tam", actorName: "Tam Thornwick", at: now - 120000, price: BOX.price, payoutCp: 0, name: "Cloak of Elvenkind", rarity: "rare", pity: true, sourceRarity: ["uncommon"] },
  { id: "p3", kind: "crate", boxId: "common", boxName: "Pauper's Box", actorId: "bo", actorName: "Bo Marrow", at: now - 180000, price: 25, payoutCp: 0, name: "Club", rarity: "common", lateCancel: 1 },
  { id: "d1", kind: "dice", boxId: DICE.id, boxName: DICE.name, actorId: "tam", actorName: "Tam Thornwick", at: now - 240000, price: DICE.price, payoutCp: 3000, win: true, faces: DICE_FACES.win, name: "Beat the dragon" },
  { id: "k1", kind: "deck", boxId: DECK.id, boxName: DECK.name, actorId: "orla", actorName: "Orla Vane", at: now - 300000, price: DECK.price, payoutCp: -2000, cardId: "flames", card: "The Flames", cardKind: "loss", swatch: "bane", name: "The Flames" },
  ...wheelStakes(now - 400000).map(s => ({ ...s, status: "settled", payoutCp: s.actorId === "tam" ? (s.stake.type === "number" ? 3000 : 4000) : 0 })),
  ...wellThrows(5),
  ...limitBuys(1),
];

export const BOXES = [
  BOX,
  // Two to a character (limits.js): Tam has one (limitBuys), so the card says one more.
  { id: "common", name: "Pauper's Box", price: 25, pools: [{ id: "core", share: 1 }], weights: { common: 85, uncommon: 15, rare: 0, veryRare: 0, legendary: 0 }, rules: { perCharacter: { max: 2, per: "ever" } } },
  // Three left of the ten the GM stocked.
  { id: "royal", name: "Royal Vault", price: 1200, pools: [{ id: "core", share: 1 }, { id: "homebrew", share: 1 }], weights: { common: 0, uncommon: 20, rare: 45, veryRare: 28, legendary: 7 }, rules: { stock: 3, stockMax: 10 } },
  // Its only pool is gone: the shop shows it empty with Buy off.
  { id: "empty", name: "Collector's Crate", price: 60, pools: [{ id: "gone", share: 1 }], weights: {}, rules: {} },
  WELL,
  DICE,
  DECK,
  ROULETTE,
];

// The pool editor's sample: the core pool, a 130-entry pool built from a
// compendium (a third of it with no rarity at the source, one source gone,
// one renamed, two never drop) and a 200-entry pool that starts collapsed.
const MUNDANE = ["Longsword", "Club", "Shield", "Rope, Hempen", "Lantern, Hooded", "Wand", "Crowbar", "Backpack", "Dagger", "Spyglass"];
const MAGIC = [["Wand of Magic Detection", "uncommon"], ["Wand of Web", "uncommon"], ["Cloak of Elvenkind", "uncommon"], ["Wand of Fireballs", "rare"], ["Staff of Power", "veryRare"]];
// Foundry's item icons aren't here; a plain square stands in.
const ICON = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22"><rect width="22" height="22" rx="4" fill="#23272e"/><rect x="6" y="6" width="10" height="10" rx="2" fill="#8b929d"/></svg>');
const withIcon = e => ({ ...e, img: ICON });
const bulk = (prefix, n) => Array.from({ length: n }, (_, i) => {
  if (i % 3 === 0) { const name = MUNDANE[(i / 3) % MUNDANE.length]; return { uuid: `sample.${prefix}.${i}`, name: `${name} ${i}`, img: "", rarity: "common", sourceRarity: "", weight: 1 }; }
  const [name, rarity] = MAGIC[i % MAGIC.length];
  return { uuid: `sample.${prefix}.${i}`, name: `${name} ${i}`, img: "", rarity, sourceRarity: rarity, weight: i % 41 === 0 ? 0 : 1 };
});
export const MANAGER_POOLS = [
  { ...POOLS.core, entries: POOLS.core.entries.map(withIcon) },
  { id: "compendium", name: "dnd5e items (filtered)", pools: ["core"], entries: bulk("compendium", 130).map(withIcon) },
  { id: "everything", name: "Every dnd5e item", pools: [], entries: bulk("everything", 200).map(withIcon) },
];
// The boxes the pool editor's headers name: the core pool is in all four
// (one through the compendium pool, nested), so the line runs long and
// shows "and 1 more"; the compendium pool is in one; the big one in none.
export const MANAGER_BOXES = [
  ...BOXES.slice(0, 3),
  { id: "hoard", name: "Dragon's Hoard Chest", price: 900, pools: [{ id: "compendium", share: 1 }], weights: {}, rules: {} },
];
// What a source check found: one source gone, one renamed; the rest match.
export const MANAGER_SOURCES = new Map([
  ["sample.compendium.7", null],
  ["sample.compendium.8", { name: "Cloak of the Elves", img: "", rarity: "uncommon", rawRarity: "uncommon" }],
]);

/*
  A stand-in for the dnd5e packs' indexes, for the starter crates
  (starter.js): rows as Foundry's index carries them (type, the subtype
  dnd5e keeps in system.type.value, the rarity), a few of each pool's
  kind and some that no pool takes (a mundane rope, a spell). Names only;
  no item text.
*/
const row = (_id, name, type, rarity, sub) => ({ _id, name, type, img: ICON, system: { rarity, ...(sub ? { type: { value: sub } } : {}) } });
export const STARTER_INDEX = [{ id: "dnd5e.items", rows: [
  row("p1", "Potion of Healing", "consumable", "common", "potion"), row("p2", "Potion of Climbing", "consumable", "common", "potion"),
  row("p3", "Potion of Greater Healing", "consumable", "uncommon", "potion"), row("p4", "Spell Scroll (1st Level)", "consumable", "common", "scroll"),
  row("p5", "Spell Scroll (2nd Level)", "consumable", "uncommon", "scroll"), row("p6", "Oil of Slipperiness", "consumable", "uncommon", "potion"),
  row("t1", "Cloak of Protection", "equipment", "uncommon", "wondrous"), row("t2", "Boots of Elvenkind", "equipment", "uncommon", "wondrous"),
  row("t3", "Ring of Protection", "equipment", "rare", "ring"), row("t4", "Amulet of Health", "equipment", "rare", "wondrous"),
  row("t5", "Gloves of Thievery", "equipment", "uncommon", "wondrous"),
  row("a1", "Longsword +1", "weapon", "uncommon", "martialM"), row("a2", "Shortbow +1", "weapon", "uncommon", "simpleR"),
  row("a3", "Shield +1", "equipment", "uncommon", "shield"), row("a4", "Breastplate +2", "equipment", "rare", "medium"),
  row("a5", "Warhammer +2", "weapon", "rare", "martialM"),
  row("h1", "Flame Tongue", "weapon", "rare", "martialM"), row("h2", "Staff of Power", "weapon", "veryRare", "simpleM"),
  row("h3", "Cloak of Invisibility", "equipment", "legendary", "wondrous"), row("h4", "Holy Avenger", "weapon", "legendary", "martialM"),
  row("h5", "Belt of Frost Giant Strength", "equipment", "veryRare", "wondrous"), row("h6", "Ring of Three Wishes", "equipment", "legendary", "ring"),
  row("m1", "Rope, Hempen (50 feet)", "loot", "", null), row("m2", "Fireball", "spell", "", null),
] }];
