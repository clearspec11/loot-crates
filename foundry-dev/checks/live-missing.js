// Live check: a pool entry whose source is gone is never drawn. Saves a test
// pool of real uncommon/rare items from dnd5e's compendium plus one entry at
// the box's top rarity (legendary) pointing at a UUID that doesn't exist,
// then buys one crate through the GM's own socket path (requestPull, which
// sweeps the box before rolling). Reports the odds before and after, the
// purse before and after (charged once), and that the pool setting now flags
// the dead entry `missing: true`.
//
//   FOUNDRY_URL=http://192.168.0.57:30000 MODULE_BASE=http://192.168.0.190:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/headless/run.cjs foundry-dev/checks/live-missing.js
//
// Never deletes anything. Writes the module's own settings (one pool, one
// box, one log row); each run adds one item to the test actor and posts one
// chat card.
const store = await import(MODULE_BASE + "scripts/store.js");
const { registerSocket, requestPull } = await import(MODULE_BASE + "scripts/socket.js");
const { oddsTable } = await import(MODULE_BASE + "scripts/odds.js");
const { toCopper } = await import(MODULE_BASE + "scripts/currency.js");

try { store.registerSettings(); } catch (e) { if (!/already registered/i.test(String(e))) throw e; }
try { registerSocket(); } catch { /* registered on an earlier run of the same page */ }

const FOLDER = "Loot Crates Test";
let folder = game.folders.find(f => f.type === "Actor" && f.name === FOLDER);
folder ??= await Folder.create({ name: FOLDER, type: "Actor" });
const name = "Crate Tester";
let actor = game.actors.find(a => a.name === name && a.folder?.id === folder.id);
actor ??= await Actor.create({ name, type: "character", folder: folder.id, system: { currency: { pp: 0, gp: 500, ep: 0, sp: 0, cp: 0 } } });
if (actor.system.currency.gp < 50) await actor.update({ "system.currency.gp": 500 });

const DEAD = "Compendium.dnd5e.items.Item.deadbeefdeadbeef";
const live = await store.entriesFromCompendium("dnd5e.items", { types: ["weapon", "equipment", "consumable"], rarities: ["uncommon", "rare"] });
if (!live.length) throw new Error("no uncommon/rare items in dnd5e.items");
const pool = await store.savePool({ id: "live-missing", name: "Live missing check", pools: [],
  entries: [...live.slice(0, 30), { uuid: DEAD, name: "Ghost Blade", img: "", rarity: "legendary", weight: 1 }] });
const box = await store.saveBox({ id: "live-missing-box", name: "Live Missing Crate", price: 50, pools: [{ id: pool.id, share: 1 }], weights: { uncommon: 50, rare: 30, legendary: 20 }, rules: {} });

const odds = () => oddsTable(box, store.getPools()).map(o => `${o.rarity} ${Math.round(o.chance * 100)}%`);
const oddsBefore = odds();

const wasOpen = store.isShopOpen();
if (!wasOpen) await store.setShopOpen(true);
let charges = 0;
const hook = Hooks.on("updateActor", (a, change) => { if (a.id === actor.id && change.system?.currency) charges++; });
const before = foundry.utils.deepClone(actor.system.currency);
const itemsBefore = actor.items.size;
let reveal = null, error = null;
try {
  reveal = await requestPull({ boxId: box.id, actorId: actor.id });
} catch (err) {
  error = String(err?.message ?? err);
} finally {
  Hooks.off("updateActor", hook);
  if (!wasOpen) await store.setShopOpen(false);
}
const after = foundry.utils.deepClone(actor.system.currency);
const deadEntry = store.getPools()[pool.id].entries.find(e => e.uuid === DEAD);

return {
  ok: !!reveal && !error && charges === 1 && toCopper(before) - toCopper(after) === 5000 && deadEntry?.missing === true && !odds().some(o => o.startsWith("legendary")),
  oddsBefore, oddsAfter: odds(),
  result: reveal?.result ?? null, error,
  stripHasDead: !!reveal?.strip.cards.some(c => c.uuid === DEAD),
  before, after, spentGp: (toCopper(before) - toCopper(after)) / 100, charges,
  itemsBefore, itemsAfter: actor.items.size,
  deadEntry,
};
