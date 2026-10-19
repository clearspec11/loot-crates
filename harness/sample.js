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
  { id: "compendium", name: "dnd5e items (filtered)", pools: [], entries: bulk("compendium", 130).map(withIcon) },
  { id: "everything", name: "Every dnd5e item", pools: [], entries: bulk("everything", 200).map(withIcon) },
];
// What a source check found: one source gone, one renamed; the rest match.
export const MANAGER_SOURCES = new Map([
  ["sample.compendium.7", null],
  ["sample.compendium.8", { name: "Cloak of the Elves", img: "", rarity: "uncommon", rawRarity: "uncommon" }],
]);
