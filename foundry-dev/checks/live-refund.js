// Live check: one real pull at a fractional price, then a refund, in the dev
// world with the branch's scripts and no module installed. Reports the purse
// before the pull, after the pull and after the refund (which must equal
// before in copper and be whole coins), that the granted item is gone, that
// the box's stock went back up, and that a second refund changes nothing.
//
//   FOUNDRY_URL=http://192.168.0.57:30000 MODULE_BASE=http://192.168.0.190:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/headless/run.cjs foundry-dev/checks/live-refund.js
//
// Deletes only the item this run granted (by its loot-crates flag). Writes the
// module's own settings (one box, one log row).
const { performPull } = await import(MODULE_BASE + "scripts/pull.js");
const store = await import(MODULE_BASE + "scripts/store.js");
const { refundPull, describeRefund } = await import(MODULE_BASE + "scripts/refund.js");
const { toCopper, isWholeCoins } = await import(MODULE_BASE + "scripts/currency.js");
const { seededRng } = await import(MODULE_BASE + "scripts/odds.js");

try { store.registerSettings(); } catch (e) { if (!/already registered/i.test(String(e))) throw e; }

const FOLDER = "Loot Crates Test";
let folder = game.folders.find(f => f.type === "Actor" && f.name === FOLDER);
folder ??= await Folder.create({ name: FOLDER, type: "Actor" });
const name = "Crate Tester";
let actor = game.actors.find(a => a.name === name && a.folder?.id === folder.id);
actor ??= await Actor.create({ name, type: "character", folder: folder.id, system: { currency: { pp: 0, gp: 500, ep: 0, sp: 0, cp: 0 } } });
if (actor.system.currency.gp < 50) await actor.update({ "system.currency.gp": 500 });

const packId = game.packs.find(p => p.collection === "dnd5e.items" || (p.documentName === "Item" && /items/i.test(p.collection)))?.collection;
const entries = await store.entriesFromCompendium(packId, { types: ["weapon", "equipment", "consumable"], rarities: ["uncommon", "rare"] });
if (!entries.length) throw new Error(`no uncommon/rare items in ${packId}`);

const pools = { "live-refund": { id: "live-refund", name: "Live refund check", entries, pools: [] } };
const box = await store.saveBox({ id: "live-refund-box", name: "Live Refund Crate", price: 12.5, pools: [{ id: "live-refund", share: 1 }], weights: { uncommon: 80, rare: 20 }, rules: { stock: 3 } });

const before = foundry.utils.deepClone(actor.system.currency);
const itemsBefore = actor.items.size;
const out = await performPull({ box, pools, actor, state: {}, rng: seededRng(Date.now() % 100000) });
const afterPull = foundry.utils.deepClone(actor.system.currency);
// What socket.js's doPull does after performPull: decrement stock, write the log row.
await store.saveBox({ ...box, rules: { ...box.rules, stock: box.rules.stock - 1 } });
await store.appendLog({ boxId: box.id, boxName: box.name, actorId: actor.id, actorName: actor.name, userId: game.user.id, itemId: out.itemId, name: out.result.name, uuid: out.result.uuid, rarity: out.result.rarity, price: box.price, pity: out.result.pity });
const rowId = store.getLog()[0].id;
const stockAfterPull = store.getBoxes()[box.id].rules.stock;

const plan = describeRefund(rowId);
const planned = { status: plan.status, item: plan.item?.name ?? null, flag: plan.item?.flags?.["loot-crates"] ?? null };
const first = await refundPull(rowId);
const afterRefund = foundry.utils.deepClone(actor.system.currency);
const itemsAfterRefund = actor.items.size;
const stockAfterRefund = store.getBoxes()[box.id].rules.stock;

const second = await refundPull(rowId);
const afterSecond = foundry.utils.deepClone(actor.system.currency);

return {
  pack: packId, poolSize: entries.length, price: box.price,
  purse: { before, afterPull, afterRefund, afterSecond },
  copper: { before: toCopper(before), afterPull: toCopper(afterPull), afterRefund: toCopper(afterRefund), afterSecond: toCopper(afterSecond) },
  wholeCoinsAfterRefund: isWholeCoins(afterRefund),
  conserved: toCopper(afterRefund) === toCopper(before) && toCopper(afterPull) === toCopper(before) - 1250,
  items: { before: itemsBefore, afterPull: actor.items.size + (first.removedItem ? 1 : 0), afterRefund: itemsAfterRefund, grantedStillThere: !!actor.items.get(out.itemId) },
  stock: { seeded: 3, afterPull: stockAfterPull, afterRefund: stockAfterRefund },
  granted: out.result.name, planned,
  first: { status: first.status, removedItem: first.removedItem, stock: first.stock },
  second: { status: second.status },
  secondChangedNothing: toCopper(afterSecond) === toCopper(afterRefund) && actor.items.size === itemsAfterRefund && store.getBoxes()[box.id].rules.stock === stockAfterRefund,
  logRow: (({ refunded, name, price }) => ({ refunded: !!refunded, name, price }))(store.getLog().find(r => r.id === rowId)),
};
