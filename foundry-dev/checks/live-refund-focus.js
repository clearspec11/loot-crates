// Live check: refund a pull from the manager's Pull log the way a GM does
// (focus the Refund button, press it, confirm the dialog) and report where
// keyboard focus lands after the re-render: it must be inside the log table,
// on that row's "refunded <date>" status, not the page body. Also reports the
// purse after the refund, which must be whole, consolidated coins.
//
//   FOUNDRY_URL=http://<foundry>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/run.cjs foundry-dev/checks/live-refund-focus.js
//
// One real pull on Crate Tester (folder "Loot Crates Test"); the refund deletes
// only the item this run granted. Writes the module's own settings (one box,
// one log row) and posts one refund chat card; it deletes no message.
if (!document.querySelector("link[data-loot-crates]")) {
  const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: MODULE_BASE + "styles/module.css" });
  link.dataset.lootCrates = "1";
  document.head.appendChild(link);
}
const { performPull } = await import(MODULE_BASE + "scripts/foundry/pull.js");
const store = await import(MODULE_BASE + "scripts/foundry/store.js");
const { toCopper, isWholeCoins } = await import(MODULE_BASE + "scripts/core/currency.js");
const { seededRng } = await import(MODULE_BASE + "scripts/core/odds.js");
const { openManager } = await import(MODULE_BASE + "scripts/foundry/manager.js");

try { store.registerSettings(); } catch (e) { if (!/already registered/i.test(String(e))) throw e; }
store.registerIndexFields();
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { for (let t = 0; t < ms && !fn(); t += 50) await wait(50); return fn(); };

const folder = game.folders.find(f => f.type === "Actor" && f.name === "Loot Crates Test");
const actor = folder && game.actors.find(a => a.name === "Crate Tester" && a.folder?.id === folder.id);
if (!actor) throw new Error("Crate Tester not found in the Loot Crates Test folder");
if (actor.system.currency.gp < 50) await actor.update({ "system.currency.gp": 500 });

const entries = await store.entriesFromCompendium("dnd5e.items", { types: ["weapon", "equipment", "consumable"], rarities: ["uncommon", "rare"] });
const pools = { "live-refund": { id: "live-refund", name: "Live refund check", entries, pools: [] } };
const box = await store.saveBox({ id: "live-refund-box", name: "Live Refund Crate", price: 12.5, pools: [{ id: "live-refund", share: 1 }], weights: { uncommon: 80, rare: 20 }, rules: { stock: 3 } });

const before = foundry.utils.deepClone(actor.system.currency);
const out = await performPull({ box, pools, actor, state: {}, rng: seededRng(Date.now() % 100000) });
const afterPull = foundry.utils.deepClone(actor.system.currency);
await store.saveBox({ ...box, rules: { ...box.rules, stock: box.rules.stock - 1 } });
await store.appendLog({ boxId: box.id, boxName: box.name, actorId: actor.id, actorName: actor.name, userId: game.user.id, itemId: out.itemId, name: out.result.name, uuid: out.result.uuid, rarity: out.result.rarity, price: box.price, pity: out.result.pity });
const rowId = store.getLog()[0].id;

// Reach the log as a GM does, by pressing its tab (live-tabs.js).
const app = openManager();
for (let t = 0; t < 100 && !app.element?.querySelector('.lc-tabs [data-tab="log"]'); t++) await wait(50);
app.element.querySelector('.lc-tabs [data-tab="log"]').dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
const reachedByClick = await until(() => app.tab === "log" && app.element?.querySelector('.lc-tabs [data-tab="log"]')?.getAttribute("aria-selected") === "true", 5000);
if (!reachedByClick) throw new Error("pressing the Pull log tab did not open the log");
const button = () => app.element?.querySelector(`button[data-action="refund"][data-row="${CSS.escape(rowId)}"]`);
try {
  await until(() => button());
  button().focus();
  const focusedBefore = document.activeElement === button();
  button().click();
  const yes = () => [...document.querySelectorAll(".application.dialog button")].find(b => /yes/i.test(b.dataset.action ?? b.textContent));
  await until(() => yes());
  yes().click();
  await until(() => app.element?.querySelector(`.lc-log__status[data-row="${CSS.escape(rowId)}"]`));
  await wait(300);
  const active = document.activeElement;
  const afterRefund = foundry.utils.deepClone(actor.system.currency);
  const focus = {
    tag: active?.tagName, className: active?.className, text: active?.textContent?.trim(),
    inLogTable: !!active?.closest?.(".lc-table") && app.element.contains(active),
    sameRow: active?.dataset?.row === rowId,
    isBody: active === document.body,
  };
  return {
    ok: reachedByClick && focusedBefore && focus.inLogTable && focus.sameRow && isWholeCoins(afterRefund) && afterRefund.sp < 10 && afterRefund.cp < 10 && toCopper(afterRefund) === toCopper(before),
    granted: out.result.name,
    purse: { before, afterPull, afterRefund },
    wholeCoins: isWholeCoins(afterRefund),
    consolidated: afterRefund.sp < 10 && afterRefund.cp < 10,
    conserved: toCopper(afterRefund) === toCopper(before),
    grantedStillThere: !!actor.items.get(out.itemId),
    reachedByClick, focusedBefore, focus,
  };
} finally {
  await app.close();
}
