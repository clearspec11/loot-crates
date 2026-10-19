// Live check: one real pull in the dev world, with the branch's scripts and
// no module installed. Builds a pool from dnd5e's items compendium, makes a
// test actor with 500 gp in the "Loot Crates Test" folder, performs the pull
// as the GM, and reports the purse before and after plus the granted item.
//
//   FOUNDRY_URL=http://192.168.0.57:30000 MODULE_BASE=http://192.168.0.190:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/headless/run.cjs foundry-dev/checks/live-pull.js
//
// Never deletes anything. Each run adds one item to the test actor.
const { performPull } = await import(MODULE_BASE + "scripts/pull.js");
const { entriesFromCompendium } = await import(MODULE_BASE + "scripts/store.js");
const { seededRng } = await import(MODULE_BASE + "scripts/odds.js");

const FOLDER = "Loot Crates Test";
let folder = game.folders.find(f => f.type === "Actor" && f.name === FOLDER);
folder ??= await Folder.create({ name: FOLDER, type: "Actor" });

const name = "Crate Tester";
let actor = game.actors.find(a => a.name === name && a.folder?.id === folder.id);
actor ??= await Actor.create({ name, type: "character", folder: folder.id, system: { currency: { pp: 0, gp: 500, ep: 0, sp: 0, cp: 0 } } });
if (actor.system.currency.gp < 50) await actor.update({ "system.currency.gp": 500 });

const packId = game.packs.find(p => p.collection === "dnd5e.items" || (p.documentName === "Item" && /items/i.test(p.collection)))?.collection;
const entries = await entriesFromCompendium(packId, { types: ["weapon", "equipment", "consumable"], rarities: ["uncommon", "rare"] });
if (!entries.length) throw new Error(`no uncommon/rare items in ${packId}`);

const pools = { live: { id: "live", name: "Live check", entries, pools: [] } };
const box = { id: "live-box", name: "Live Check Crate", price: 50, pools: [{ id: "live", share: 1 }], weights: { uncommon: 80, rare: 20 }, rules: {} };

const before = foundry.utils.deepClone(actor.system.currency);
const itemsBefore = actor.items.size;
const out = await performPull({ box, pools, actor, state: {}, rng: seededRng(Date.now() % 100000) });
const after = actor.system.currency;
const granted = actor.items.get(out.itemId);

return {
  pack: packId, poolSize: entries.length,
  before, after, spentGp: (before.gp - after.gp),
  granted: granted ? { name: granted.name, type: granted.type, rarity: granted.system.rarity, flags: granted.flags["loot-crates"] } : null,
  itemsBefore, itemsAfter: actor.items.size,
  result: out.result, stripLength: out.strip.cards.length, landIndex: out.strip.landIndex, nearMiss: out.strip.nearMiss,
};
