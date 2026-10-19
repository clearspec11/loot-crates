// Sample pools and a box for the harness and screenshots. Names are SRD
// magic items; no art, so the cards show initials.
const item = (name, rarity, weight = 1) => ({ uuid: `sample.${name.replace(/\W+/g, "-").toLowerCase()}`, name, img: "", rarity, weight });

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

export const BOXES = [
  BOX,
  { id: "common", name: "Pauper's Box", price: 25, pools: [{ id: "core", share: 1 }], weights: { common: 85, uncommon: 15, rare: 0, veryRare: 0, legendary: 0 }, rules: {} },
  { id: "royal", name: "Royal Vault", price: 1200, pools: [{ id: "core", share: 1 }, { id: "homebrew", share: 1 }], weights: { common: 0, uncommon: 20, rare: 45, veryRare: 28, legendary: 7 }, rules: { stock: 3 } },
  // Its only pool is gone: the shop shows it empty with Buy off.
  { id: "empty", name: "Collector's Crate", price: 60, pools: [{ id: "gone", share: 1 }], weights: {}, rules: {} },
];
