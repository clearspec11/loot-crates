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

export const BOXES = [
  BOX,
  { id: "common", name: "Pauper's Box", price: 25, pools: [{ id: "core", share: 1 }], weights: { common: 85, uncommon: 15, rare: 0, veryRare: 0, legendary: 0 }, rules: {} },
  { id: "royal", name: "Royal Vault", price: 1200, pools: [{ id: "core", share: 1 }, { id: "homebrew", share: 1 }], weights: { common: 0, uncommon: 20, rare: 45, veryRare: 28, legendary: 7 }, rules: { stock: 3 } },
  // Its only pool is gone: the shop shows it empty with Buy off.
  { id: "empty", name: "Collector's Crate", price: 60, pools: [{ id: "gone", share: 1 }], weights: {}, rules: {} },
  WELL,
  DICE,
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
