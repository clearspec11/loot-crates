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
  // How long a finished game window stays open on this client (linger.js).
  LINGER: "closeFinished",
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

/*
  What an item of each rarity is nominally worth in gp, for placing it
  among a scratch roll's prize sizes when Fill the prize list builds one
  (scratchplan.js): the low end of each band in the 2014 Dungeon Master's
  Guide's magic item prices (common 50-100 gp, uncommon 101-500, rare
  501-5,000, very rare 5,001-50,000, legendary 50,001 and up; an artifact
  is priceless there, so it is put with legendary). An item at that
  value can stand in for that much of a prize: "Uncommon item + 25 gp" is
  a 125 gp prize. It is a yardstick only; nothing is bought or sold at it.
*/
export const ITEM_VALUE = { common: 50, uncommon: 100, rare: 500, veryRare: 5000, legendary: 50000, artifact: 50000 };

// Odds of a pull landing on each rarity, before the box narrows them.
export const DEFAULT_WEIGHTS = { common: 60, uncommon: 26, rare: 10, veryRare: 3, legendary: 1, artifact: 0 };

export const DEFAULT_PRICE_GP = 100;
