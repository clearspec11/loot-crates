// Live check: the manager's edits keep what changed while their dialog was
// open, and a missing entry can be relinked without dragging.
//
// 1. Opens the box editor on a test box with stock 5, takes one from stock
//    the way a pull does (through the write queue) while the dialog is open,
//    changes the price and saves: the stock stays 4.
// 2. Opens the rename dialog on a test pool holding a dead entry, sweeps the
//    pool while the dialog is open (flags the entry missing), renames and
//    saves: the flag stays.
// 3. Clicks the dead row's Relink button, types a live UUID and saves: the
//    entry points at the new item with its weight kept.
//
//   FOUNDRY_URL=http://192.168.0.57:30000 MODULE_BASE=http://192.168.0.190:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/headless/run.cjs foundry-dev/checks/live-edits.js
//
// Never deletes anything and makes no purchase. Writes the module's own
// settings only (one pool, one box).
const store = await import(MODULE_BASE + "scripts/store.js");
try { store.registerSettings(); } catch (e) { if (!/already registered/i.test(String(e))) throw e; }
store.registerIndexFields();
if (!document.querySelector("link[data-loot-crates]")) {
  const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: MODULE_BASE + "styles/module.css" });
  link.dataset.lootCrates = "1";
  document.head.appendChild(link);
}
const { openManager } = await import(MODULE_BASE + "scripts/manager.js");
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { for (let t = 0; t < ms && !fn(); t += 100) await wait(100); return fn(); };
const dialog = () => [...document.querySelectorAll(".lc-dialog")].at(-1);
const save = () => dialog().querySelector('[data-action="ok"]').click();

const DEAD = "Compendium.dnd5e.items.Item.deadbeef00000003";
const [live] = await store.entriesFromCompendium("dnd5e.items", { types: ["weapon"], rarities: ["uncommon"] });
const pool = await store.savePool({ id: "live-edits", name: "Live edits check", pools: [],
  entries: [{ uuid: DEAD, name: "Lost Lantern", img: "", rarity: "rare", weight: 4 }] });
const box = await store.saveBox({ id: "live-edits-box", name: "Live Edits Crate", price: 50, pools: [{ id: pool.id, share: 1 }], weights: { rare: 1 }, rules: { stock: 5 } });

const app = openManager();
// ---- 1. box editor vs a pull's stock change ----
app.tab = "boxes"; app.render({ force: true });
await until(() => app.element?.querySelector(`[data-action="editBox"][data-box="${box.id}"]`));
app.element.querySelector(`[data-action="editBox"][data-box="${box.id}"]`).click();
await until(() => dialog()?.querySelector('input[name="price"]'));
await store.enqueueWrite(() => store.saveBox({ ...store.getBoxes()[box.id], rules: { ...store.getBoxes()[box.id].rules, stock: 4 } }));
dialog().querySelector('input[name="price"]').value = "75";
save();
await until(() => store.getBoxes()[box.id].price === 75);
const boxAfter = store.getBoxes()[box.id];
const boxOk = boxAfter.price === 75 && boxAfter.rules.stock === 4;

// ---- 2. rename vs a sweep's missing flag ----
app.tab = "pools"; app.render();
await until(() => app.element?.querySelector(`[data-action="editPool"][data-pool="${pool.id}"]`));
// Clear any flag the editor's own render set, so the sweep below is the change.
await store.enqueueWrite(() => store.markMissing(pool.id, [DEAD], false));
app.element.querySelector(`[data-action="editPool"][data-pool="${pool.id}"]`).click();
await until(() => dialog()?.querySelector('input[name="name"]'));
await store.enqueueWrite(() => store.refreshMissing([pool.id]));
const flaggedDuringDialog = store.getPools()[pool.id].entries[0].missing === true;
dialog().querySelector('input[name="name"]').value = "Live edits check (renamed)";
save();
await until(() => store.getPools()[pool.id].name.endsWith("(renamed)"));
const poolAfter = store.getPools()[pool.id];
const renameOk = flaggedDuringDialog && poolAfter.name === "Live edits check (renamed)" && poolAfter.entries[0].missing === true;

// ---- 3. Relink by keyboard ----
await until(() => app.element?.querySelector(`[data-action="relinkEntry"][data-uuid="${CSS.escape(DEAD)}"]`));
const relinkButton = app.element.querySelector(`[data-action="relinkEntry"][data-uuid="${CSS.escape(DEAD)}"]`);
const relinkLabel = relinkButton.getAttribute("aria-label");
relinkButton.focus();
relinkButton.click();
await until(() => dialog()?.querySelector('input[name="uuid"]'));
dialog().querySelector('input[name="uuid"]').value = live.uuid;
save();
await until(() => store.getPools()[pool.id].entries.some(e => e.uuid === live.uuid));
const relinked = store.getPools()[pool.id].entries.find(e => e.uuid === live.uuid);
const relinkOk = !!relinked && relinked.weight === 4 && !relinked.missing && !store.getPools()[pool.id].entries.some(e => e.uuid === DEAD);
await app.close({ animate: false });

return {
  ok: boxOk && renameOk && relinkOk, boxOk, renameOk, relinkOk,
  box: { price: boxAfter.price, stock: boxAfter.rules.stock },
  pool: { name: poolAfter.name, flaggedDuringDialog, missingAfterRename: poolAfter.entries[0].missing ?? false },
  relink: { label: relinkLabel, to: live.name, entry: relinked && { uuid: relinked.uuid, name: relinked.name, weight: relinked.weight } },
};
