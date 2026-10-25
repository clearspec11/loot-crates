// Live check: a refund puts the buyer's pity count and no-duplicates record
// back. With the branch's socket and redraw listener in place of the
// installed module's (as live-shop-pity.js does), it presses Buy once on
// "Live pity crate" (1 gp) in Crate Tester's shop, closes the reveal when it
// lands, opens the manager's Pull log by clicking its tab, presses the new
// row's Refund and Yes in the dialog. Then Crate Tester's actorState for that
// box must equal what it was before the pull, and the open shop card's pills
// and pity line must equal the card before the pull within 1 s of the state
// write. It also reports the dialog's text (the pity / "can drop again"
// sentence), the purse and that the granted item is gone.
//
//   FOUNDRY_URL=http://<foundry>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/headless/run.cjs foundry-dev/checks/live-refund-pity.js
//
// Sets no state: it buys from whatever Crate Tester's state for the box is
// (after live-shop-pity.js, pity due, so the pull is the guaranteed rarity
// and the refund gives back the count it wiped). One real 1 gp purchase,
// refunded; the refund deletes only the item this run granted. Writes the
// module's own settings (log row, state, the pool and box if missing) and
// posts the pull's and the refund's chat cards; it deletes no message.
// Needs "Crate Tester" in "Loot Crates Test" and "Live pity crate"
// (live-shop-pity.js makes it).
if (!document.querySelector("link[data-loot-crates]")) {
  const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: MODULE_BASE + "styles/module.css" });
  link.dataset.lootCrates = "1";
  document.head.appendChild(link);
}
globalThis.canvas?.app?.ticker?.stop();
game.socket.off("module.loot-crates");
const store = await import(MODULE_BASE + "scripts/foundry/store.js");
try { store.registerSettings(); } catch { /* the installed module registered them */ }
try { store.registerIndexFields(); } catch { /* already in CONFIG */ }
const socket = await import(MODULE_BASE + "scripts/foundry/socket.js");
socket.registerSocket();
const { storeRedraw } = await import(MODULE_BASE + "scripts/core/redraw.js");
const { openShop, refreshShop } = await import(MODULE_BASE + "scripts/foundry/shop.js");
const { openManager, refreshManager } = await import(MODULE_BASE + "scripts/foundry/manager.js");
const { shopOdds } = await import(MODULE_BASE + "scripts/core/odds.js");
const { RARITY_SHORT } = await import(MODULE_BASE + "scripts/core/config.js");
const { toCopper } = await import(MODULE_BASE + "scripts/core/currency.js");
const redraw = storeRedraw({ refreshShop, refreshManager });
store.setStoreListener(redraw);
for (const key of store.WORLD_KEYS) {
  const cfg = game.settings.settings.get(`loot-crates.${key}`);
  if (cfg && !String(cfg.onChange ?? "").includes("storeChanged")) cfg.onChange = () => redraw(key);
}
if (!socket.isActiveGM()) throw new Error("this page is not the active GM");

const folder = game.folders.find(f => f.type === "Actor" && f.name === "Loot Crates Test");
const actor = game.actors.find(a => a.name === "Crate Tester" && a.folder?.id === folder?.id);
if (!actor) throw new Error("no Crate Tester in Loot Crates Test: run live-pull.js first");
if ((actor.system.currency.gp ?? 0) < 5) await actor.update({ "system.currency.gp": 1000 });
const box = Object.values(store.getBoxes()).find(b => b.name === "Live pity crate");
if (!box) throw new Error("no Live pity crate: run live-shop-pity.js first");

const wait = ms => new Promise(r => setTimeout(r, ms));
const frame = () => new Promise(r => requestAnimationFrame(r));
const until = async (fn, ms = 20000) => { for (let t = 0; t < ms && !fn(); t += 50) await wait(50); return fn(); };
const click = el => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const shop = openShop();
shop.actorId = actor.id;
await shop.render({ force: true });
await until(() => shop.element?.querySelector(`.lc-box[data-box="${CSS.escape(box.id)}"] .lc-box__buy`));
const card = () => shop.element?.querySelector(`.lc-box[data-box="${CSS.escape(box.id)}"]`);
const read = () => ({
  pills: [...(card()?.querySelectorAll(".lc-odd") ?? [])].map(p => p.textContent.trim()),
  pity: card()?.querySelector(".lc-box__pity")?.textContent.trim() ?? null,
});
const problems = [];

// Before: the state and the card as the buyer sees them.
const before = structuredClone(store.getActorState(actor.id, box.id));
const cardBefore = read();
const wantPills = state => shopOdds(box, store.getPools(), state).rows.map(r => `${RARITY_SHORT[r.rarity]} ${r.label}`);
if (!same(cardBefore.pills, wantPills(before))) problems.push(`card before ${cardBefore.pills} != shopOdds ${wantPills(before)}`);
const purseBefore = toCopper(actor.system.currency);
const knownRows = new Set(store.getLog().map(r => r.id));

// One purchase through the shop's Buy.
click(card().querySelector(".lc-box__buy"));
const newRow = () => store.getLog().find(r => !knownRows.has(r.id) && r.boxId === box.id && r.actorId === actor.id);
if (!await until(() => newRow() && (store.getActorState(actor.id, box.id).pulls ?? 0) !== (before.pulls ?? 0))) throw new Error("the pull's log row and state were never written");
const row = newRow();
const afterPull = structuredClone(store.getActorState(actor.id, box.id));
await until(() => !same(read(), cardBefore), 3000);
const cardAfterPull = read();
// Close the reveal the way the buyer does, once it has landed.
const closeBtn = () => [...document.querySelectorAll(".lc-reveal")].pop()?.querySelector('[data-action="dismiss"]');
if (await until(() => closeBtn())) { await wait(700); click(closeBtn()); }
const itemId = row.itemId;
const granted = !!actor.items.get(itemId);

// The Pull log, reached by its tab, then Refund and Yes.
const app = openManager();
await until(() => app.element?.querySelector('.lc-tabs [data-tab="log"]'));
click(app.element.querySelector('.lc-tabs [data-tab="log"]'));
if (!await until(() => app.tab === "log" && app.element?.querySelector('.lc-tabs [data-tab="log"]')?.getAttribute("aria-selected") === "true", 5000)) throw new Error("pressing the Pull log tab did not open the log");
const refundBtn = () => app.element?.querySelector(`button[data-action="refund"][data-row="${CSS.escape(row.id)}"]`);
let dialogText = null, stateMs = null, cardMs = null;
try {
  if (!await until(() => refundBtn())) throw new Error("no Refund button for the new row");
  refundBtn().focus();
  click(refundBtn());
  const dialog = () => [...document.querySelectorAll(".application.dialog")].pop();
  const yes = () => [...(dialog()?.querySelectorAll("button") ?? [])].find(b => /yes/i.test(b.dataset.action ?? b.textContent));
  await until(() => yes());
  dialogText = dialog()?.querySelector(".window-content")?.textContent.replace(/\s+/g, " ").trim() ?? null;
  const t0 = performance.now();
  click(yes());
  const deadline = t0 + 15000;
  while (performance.now() < deadline) {
    await frame();
    if (stateMs == null && same(store.getActorState(actor.id, box.id), before)) stateMs = performance.now() - t0;
    if (stateMs != null && same(read(), cardBefore)) { cardMs = performance.now() - t0; break; }
  }
  await until(() => app.element?.querySelector(`.lc-log__status[data-row="${CSS.escape(row.id)}"]`), 5000);
} finally {
  await app.close();
}

const afterRefund = store.getActorState(actor.id, box.id);
const cardAfterRefund = read();
if (stateMs == null) problems.push(`state after refund ${JSON.stringify(afterRefund)} != before ${JSON.stringify(before)}`);
if (cardMs == null) problems.push(`card after refund ${JSON.stringify(cardAfterRefund)} != before ${JSON.stringify(cardBefore)}`);
else if (cardMs - stateMs > 1000) problems.push(`card redrew ${Math.round(cardMs - stateMs)} ms after the state write (> 1 s)`);
if (!row.before || typeof row.resetPity !== "boolean") problems.push(`log row lacks before/resetPity: ${JSON.stringify({ before: row.before, resetPity: row.resetPity })}`);
if (box.rules?.pity && !/pity count (goes back to|stays at) \d+ of \d+ pulls/.test(dialogText ?? "")) problems.push(`dialog has no pity sentence: "${dialogText}"`);
if (box.rules?.noDuplicates && !dialogText?.includes(`${row.name} can drop for ${actor.name} again`)) problems.push(`dialog doesn't say ${row.name} can drop again: "${dialogText}"`);
if (toCopper(actor.system.currency) !== purseBefore) problems.push("purse not back to where it was");
if (actor.items.get(itemId)) problems.push("the granted item is still on the sheet");
await shop.close();

return {
  ok: !problems.length,
  problems,
  pulled: { name: row.name, rarity: row.rarity, before: row.before, resetPity: row.resetPity, granted },
  state: { before, afterPull, afterRefund },
  card: { before: cardBefore, afterPull: cardAfterPull, afterRefund: cardAfterRefund },
  dialogText,
  timings: { stateWrittenMs: stateMs && Math.round(stateMs), cardRedrawnMs: cardMs && Math.round(cardMs), redrawAfterWriteMs: cardMs && stateMs && Math.round(cardMs - stateMs) },
};
