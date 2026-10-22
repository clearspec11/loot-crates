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
};

// dnd5e's rarity keys (item.system.rarity), lowest to highest.
export const RARITIES = ["common", "uncommon", "rare", "veryRare", "legendary", "artifact"];

export const RARITY_LABEL = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  veryRare: "Very rare",
  legendary: "Legendary",
  artifact: "Artifact",
};

// Short names for the shop's odds pills, so six of them fit a phone-width card.
export const RARITY_SHORT = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  veryRare: "V. rare",
  legendary: "Legendary",
  artifact: "Artifact",
};

// Odds of a pull landing on each rarity, before the box narrows them.
export const DEFAULT_WEIGHTS = { common: 60, uncommon: 26, rare: 10, veryRare: 3, legendary: 1, artifact: 0 };

export const DEFAULT_PRICE_GP = 100;
