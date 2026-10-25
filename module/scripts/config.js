import { words } from "./i18n.js";

export const MODULE_ID = "loot-crates";
export const SOCKET = `module.${MODULE_ID}`;

export const SETTINGS = {
  POOLS: "pools",
  BOXES: "boxes",
  LOG: "pullLog",
  STATE: "actorState",
  SHOP_OPEN: "shopOpen",
  // The table rounds (round.js): one betting window per round, by id.
  ROUNDS: "tableRounds",
  SOUND: "sound",
  // The GM's welcome (welcome.js): the last version a GM saw, and Don't
  // show again.
  WELCOME: "welcome",
};

// dnd5e's rarity keys (item.system.rarity), lowest to highest.
export const RARITIES = ["common", "uncommon", "rare", "veryRare", "legendary", "artifact"];

export const RARITY_LABEL = words({
  common: "LOOTCRATES.Rarity.Common",
  uncommon: "LOOTCRATES.Rarity.Uncommon",
  rare: "LOOTCRATES.Rarity.Rare",
  veryRare: "LOOTCRATES.Rarity.VeryRare",
  legendary: "LOOTCRATES.Rarity.Legendary",
  artifact: "LOOTCRATES.Rarity.Artifact",
});

// Short names for the shop's odds pills, so six of them fit a phone-width card.
export const RARITY_SHORT = words({
  common: "LOOTCRATES.RarityShort.Common",
  uncommon: "LOOTCRATES.RarityShort.Uncommon",
  rare: "LOOTCRATES.RarityShort.Rare",
  veryRare: "LOOTCRATES.RarityShort.VeryRare",
  legendary: "LOOTCRATES.RarityShort.Legendary",
  artifact: "LOOTCRATES.RarityShort.Artifact",
});

// Odds of a pull landing on each rarity, before the box narrows them.
export const DEFAULT_WEIGHTS = { common: 60, uncommon: 26, rare: 10, veryRare: 3, legendary: 1, artifact: 0 };

export const DEFAULT_PRICE_GP = 100;
