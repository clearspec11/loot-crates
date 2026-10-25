// Live check: stock limits (limits.js) at a real table, with the branch's
// code on both ends.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/checks/live-limits.cjs [--shot out.png]
//
// Env: PLAYER (default Player2, must own Crate Tester), BOX (the crate's
// name, default "Live limit crate").
//
// Two headless clients, the Gamemaster and the player, each running the
// branch's socket code (as live-well.cjs does). The GM seeds a 1 gp crate
// "Live limit crate" drawing from "Live UI pool" with a stock of 3 of 3 and
// a limit of one per character (one more than any unrefunded buy Crate
// Tester has from an earlier run that died, so the limit is always one
// away), and notes the purse, the log and the record. Then, as a person does:
//
//   1. The player opens the shop on Crate Tester: the card reads "3 of 3
//      left" and "You can buy 1 more" with Buy on. The player presses Buy
//      once and closes the reveal when it lands. The card must read "2 of 3
//      left", its reason "Limit reached: 1 of 1 for Crate Tester" and its Buy
//      aria-disabled, described by that reason.
//   2. A stale shop's Buy (the pull sent anyway, through the shop's own
//      requestPull) is refused by the GM with the same sentence: "Live
//      limit crate: limit reached, ... Nothing was charged.", purse, items
//      and log unchanged.
//   3. The GM opens the manager's Boxes tab by clicking it, reads the row's
//      rules cell ("2 of 3 left, 1 per character"), presses the crate's Edit,
//      reads the Limits group ("2 of 3 left"), presses Restock (the line
//      reads "3 of 3 left once you save" and nothing is stored yet: the
//      stock is still 2 of 3), then Save, which stores 3 of 3. The player's
//      card must read "3 of 3 left" within 2 s.
//   4. The GM opens the Pull log by its tab and presses the row's Refund and
//      Yes: the confirm says the crate goes back to 3 in stock (never past
//      the GM's 3), the purse comes back, and within 2 s the player's card
//      has its Buy on again with "You can buy 1 more".
//
// Restored in a finally: the crate's record as it was (left seeded when new
// this run). One real 1 gp purchase, refunded; nothing is deleted. Needs
// "Crate Tester" in "Loot Crates Test" and "Live UI pool" (live-ui.js).
/* global game, Hooks */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const BOX = process.env.BOX || "Live limit crate";
const shot = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : null;

async function join(browser, user) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const logs = [];
  page.on("console", m => { const t = m.text(); if (t.includes("loot-crates")) logs.push(t); });
  page.on("pageerror", e => logs.push("pageerror: " + e.message));
  await page.goto(FOUNDRY + "/join", { waitUntil: "networkidle" });
  const free = await page.$eval("select[name=userId]", (s, u) => [...s.options].some(o => o.textContent.trim() === u && !o.disabled), user);
  if (!free) { await page.context().close(); return null; }
  await page.selectOption("select[name=userId]", { label: user });
  await page.click("button[name=join], button[type=submit]");
  await page.waitForURL(/\/game/, { timeout: 30000 });
  await page.waitForFunction(() => window.game?.ready, null, { timeout: 120000 });
  // What main.js does first: the branch's words, from its own lang/en.json
  // (the installed release may have no language file, or older words).
  await page.evaluate(async base => (await import(base + "scripts/core/i18n.js")).loadStrings(), MODULE_BASE);
  // The branch's code in place of the installed module's, as main.js wires it.
  await page.evaluate(async base => {
    globalThis.canvas?.app?.ticker?.stop();
    if (!document.querySelector("link[data-lc-branch]")) {
      const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: base + "styles/module.css" });
      link.dataset.lcBranch = "1";
      document.head.append(link);
      await new Promise(r => { link.onload = r; link.onerror = r; });
    }
    game.socket.off("module.loot-crates");
    const store = await import(base + "scripts/foundry/store.js");
    try { store.registerSettings(); } catch { /* the installed module registered them */ }
    try { store.registerIndexFields?.(); } catch { /* already in CONFIG */ }
    const socket = await import(base + "scripts/foundry/socket.js");
    socket.registerSocket();
    const { storeRedraw } = await import(base + "scripts/core/redraw.js");
    const { refreshShop, registerShopHooks } = await import(base + "scripts/foundry/shop.js");
    const { refreshManager } = await import(base + "scripts/foundry/manager.js");
    const redraw = storeRedraw({ refreshShop, refreshManager });
    store.setStoreListener(redraw);
    for (const key of store.WORLD_KEYS) {
      const cfg = game.settings.settings.get(`loot-crates.${key}`);
      if (cfg && !String(cfg.onChange ?? "").includes("storeChanged")) cfg.onChange = () => redraw(key);
    }
    registerShopHooks?.(Hooks);
    const { sealChatCard, watchAgain, preSealItem } = await import(base + "scripts/foundry/reveal.js");
    Hooks.on("renderChatMessageHTML", sealChatCard);
    Hooks.on("renderChatMessageHTML", watchAgain);
    for (const h of [...(Hooks.events?.createItem ?? [])]) if (h.fn?.name === "preSealItem") Hooks.off("createItem", h.id);
    Hooks.on("createItem", preSealItem);
  }, MODULE_BASE);
  return { page, logs };
}

// The GM's side: seed the crate, note what is to be restored.
async function seed(gm) {
  return gm.evaluate(async ({ base, name }) => {
    const store = await import(base + "scripts/foundry/store.js");
    const { boughtBy } = await import(base + "scripts/core/limits.js");
    const folder = game.folders.find(f => f.type === "Actor" && f.name === "Loot Crates Test");
    const actor = game.actors.find(a => a.name === "Crate Tester" && a.folder?.id === folder?.id);
    if (!actor) throw new Error("no Crate Tester in Loot Crates Test: run live-pull.js first");
    if ((actor.system.currency.gp ?? 0) < 5) await actor.update({ "system.currency.gp": 1000 });
    const pool = Object.values(store.getPools()).find(p => p.name === "Live UI pool");
    if (!pool) throw new Error("no Live UI pool: run live-ui.js first");
    const old = Object.values(store.getBoxes()).find(b => b.name === name) ?? null;
    const already = old ? boughtBy(store.getLog(), { boxId: old.id, actorId: actor.id }) : 0;
    const box = await store.createBox({
      ...(old ? { id: old.id } : {}), name, price: 1, pools: [{ id: pool.id, share: 1 }],
      weights: { common: 1, uncommon: 1, rare: 1, veryRare: 1, legendary: 1 },
      rules: { pity: null, noDuplicates: false, stock: 3, stockMax: 3, perCharacter: { max: already + 1, per: "ever" } },
    });
    const { toCopper } = await import(base + "scripts/core/currency.js");
    return { actorId: actor.id, boxId: box.id, old, max: already + 1, purseCp: toCopper(actor.system.currency), items: actor.items.filter(i => !i.flags?.dnd5e?.cachedFor).length, logIds: store.getLog().map(r => r.id) };
  }, { base: MODULE_BASE, name: BOX });
}

async function restore(gm, before) {
  if (!gm || !before) return null;
  return gm.evaluate(async ({ base, before, name }) => {
    const out = {};
    try {
      const store = await import(base + "scripts/foundry/store.js");
      if (before.old) { await store.createBox(before.old); out.box = "restored"; }
      else out.box = Object.values(store.getBoxes()).some(b => b.name === name) ? "left seeded (new this run)" : "none";
      const { toCopper } = await import(base + "scripts/core/currency.js");
      out.purseCp = toCopper(game.actors.get(before.actorId).system.currency);
    } catch (err) { out.error = String(err?.stack || err); }
    return out;
  }, { base: MODULE_BASE, before, name: BOX });
}

// The player's card for the crate, read as a person sees it.
const READ_CARD = `globalThis.__lcRead = () => {
  const card = document.querySelector('#loot-crates-shop .lc-box[data-box="' + globalThis.__lcBox + '"]');
  const buy = card?.querySelector(".lc-box__buy");
  const why = card?.querySelector(".lc-box__why");
  return {
    stock: card?.querySelector(".lc-box__stock")?.textContent.trim() ?? "",
    limit: card?.querySelector(".lc-box__limit")?.textContent.trim() ?? "",
    why: why?.textContent.trim() ?? "",
    off: buy?.getAttribute("aria-disabled") === "true",
    describedBy: buy?.getAttribute("aria-describedby") ?? "",
    whyId: why?.id ?? "",
  };
};`;

const untilCard = (pl, pred, since) => pl.evaluate(async ({ pred, since }) => {
  const test = new Function("c", `return (${pred})(c)`);
  for (let i = 0; i < 250; i++) {
    const c = globalThis.__lcRead();
    if (test(c)) return { ...c, ms: Date.now() - since };
    await new Promise(r => setTimeout(r, 20));
  }
  return { ...globalThis.__lcRead(), ms: null };
}, { pred: String(pred), since });

(async () => {
  const browser = await chromium.launch();
  const out = { player: PLAYER, box: BOX, gm: null };
  let gm = null, before = null;
  try {
    const pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");
    out.gm = "headless Gamemaster running the branch";
    before = await seed(gm.page);
    out.before = { purseCp: before.purseCp, items: before.items, max: before.max, rows: before.logIds.length };

    // 1. One purchase through the shop's Buy.
    out.buy = await pl.page.evaluate(async ({ base, boxId, read }) => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const until = async (fn, ms = 15000) => { for (let t = 0; t < ms && !fn(); t += 50) await wait(50); return fn(); };
      const click = el => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
      globalThis.__lcBox = boxId;
      (0, eval)(read);
      const { openShop } = await import(base + "scripts/foundry/shop.js");
      const actor = game.actors.find(a => a.isOwner && a.type === "character" && a.name === "Crate Tester");
      if (!actor) throw new Error(`${game.user.name} doesn't own Crate Tester`);
      const app = openShop();
      await until(() => app.element?.querySelector(`.lc-box[data-box="${boxId}"]`));
      const pick = app.element.querySelector(".lc-shop__actor");
      if (pick && pick.value !== actor.id) { pick.value = actor.id; pick.dispatchEvent(new Event("change")); await wait(800); }
      const start = globalThis.__lcRead();
      const buy = () => app.element.querySelector(`.lc-box[data-box="${boxId}"] .lc-box__buy`);
      buy().focus();
      click(buy());
      const closeBtn = () => [...document.querySelectorAll(".lc-reveal")].pop()?.querySelector('[data-action="dismiss"]');
      const landed = await until(() => closeBtn(), 20000);
      if (landed) { await wait(700); click(closeBtn()); }
      await until(() => globalThis.__lcRead().off, 5000);
      await wait(300);
      return { start, landed: !!landed, after: globalThis.__lcRead() };
    }, { base: MODULE_BASE, boxId: before.boxId, read: READ_CARD });

    // 2. A stale shop's Buy, sent anyway: the GM refuses it with the sentence.
    out.stale = await pl.page.evaluate(async ({ base, boxId }) => {
      const { requestPull } = await import(base + "scripts/foundry/socket.js");
      const actor = game.actors.find(a => a.isOwner && a.name === "Crate Tester");
      try { await requestPull({ boxId, actorId: actor.id, price: 1 }); return { refused: false }; }
      catch (err) { return { refused: true, message: err.message }; }
    }, { base: MODULE_BASE, boxId: before.boxId });
    out.afterStale = await gm.page.evaluate(async ({ base, before }) => {
      const store = await import(base + "scripts/foundry/store.js");
      const { toCopper } = await import(base + "scripts/core/currency.js");
      const actor = game.actors.get(before.actorId);
      const rows = store.getLog().filter(r => !before.logIds.includes(r.id));
      return { purseCp: toCopper(actor.system.currency), items: actor.items.filter(i => !i.flags?.dnd5e?.cachedFor).length, rows: rows.map(r => ({ id: r.id, boxId: r.boxId, price: r.price, itemId: r.itemId })), rules: store.getBoxes()[before.boxId]?.rules };
    }, { base: MODULE_BASE, before });

    // 3. The GM's Boxes tab, Edit, Restock, Save.
    out.restock = await gm.page.evaluate(async ({ base, before }) => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const until = async (fn, ms = 15000) => { for (let t = 0; t < ms && !fn(); t += 50) await wait(50); return fn(); };
      const click = el => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
      const store = await import(base + "scripts/foundry/store.js");
      const { openManager } = await import(base + "scripts/foundry/manager.js");
      const app = openManager();
      await until(() => app.element?.querySelector('.lc-tabs [data-tab="boxes"]'));
      click(app.element.querySelector('.lc-tabs [data-tab="boxes"]'));
      const edit = () => app.element?.querySelector(`button[data-action="editBox"][data-box="${before.boxId}"]`);
      if (!await until(() => app.tab === "boxes" && edit(), 8000)) throw new Error("no Edit for the crate on the Boxes tab");
      const rulesCell = edit().closest("tr").children[4].textContent.trim();
      click(edit());
      const dialog = () => [...document.querySelectorAll(".application.dialog")].find(d => d.querySelector(".lc-limits"));
      if (!await until(() => dialog()?.querySelector("[data-restock]"))) throw new Error("the box editor has no Restock");
      const group = dialog().querySelector(".lc-limits");
      const legend = group.querySelector("legend")?.textContent.trim();
      const leftBefore = group.querySelector(".lc-limits__left").textContent.trim();
      const stockField = group.querySelector('input[name="stock"]').value;
      const limitField = { max: group.querySelector('input[name="limitMax"]').value, per: group.querySelector('select[name="limitPer"]').value };
      const btn = group.querySelector("[data-restock]");
      const offBefore = btn.getAttribute("aria-disabled") === "true";
      btn.focus();
      const at = Date.now();
      click(btn);
      await until(() => /once you save$/.test(group.querySelector(".lc-limits__left").textContent));
      const leftAfter = group.querySelector(".lc-limits__left").textContent.trim();
      const stored = structuredClone(store.getBoxes()[before.boxId].rules);
      const focusKept = document.activeElement === btn;
      const offAfter = btn.getAttribute("aria-disabled") === "true";
      click(dialog().querySelector('button[data-action="ok"]'));
      await until(() => !dialog(), 5000);
      await wait(500);
      const saved = structuredClone(store.getBoxes()[before.boxId].rules);
      const rulesAfter = app.element?.querySelector(`button[data-action="editBox"][data-box="${before.boxId}"]`)?.closest("tr").children[4].textContent.trim();
      await app.close();
      return { at, rulesCell, legend, leftBefore, stockField, limitField, offBefore, leftAfter, stored, focusKept, offAfter, saved, rulesAfter };
    }, { base: MODULE_BASE, before });
    out.cardAfterRestock = await untilCard(pl.page, c => c.stock === "3 of 3 left", out.restock.at);

    // 4. The GM refunds the purchase from the Pull log.
    const rowId = out.afterStale.rows.find(r => r.boxId === before.boxId)?.id;
    out.refund = await gm.page.evaluate(async ({ base, before, rowId }) => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const until = async (fn, ms = 15000) => { for (let t = 0; t < ms && !fn(); t += 50) await wait(50); return fn(); };
      const click = el => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
      const store = await import(base + "scripts/foundry/store.js");
      const { toCopper } = await import(base + "scripts/core/currency.js");
      const { openManager } = await import(base + "scripts/foundry/manager.js");
      const actor = game.actors.get(before.actorId);
      const app = openManager();
      await until(() => app.element?.querySelector('.lc-tabs [data-tab="log"]'));
      click(app.element.querySelector('.lc-tabs [data-tab="log"]'));
      const refundBtn = () => app.element?.querySelector(`button[data-action="refund"][data-row="${CSS.escape(rowId)}"]`);
      if (!await until(() => app.tab === "log" && refundBtn(), 8000)) throw new Error("no Refund for the purchase in the Pull log");
      refundBtn().focus();
      click(refundBtn());
      const dialog = () => [...document.querySelectorAll(".application.dialog")].pop();
      const yes = () => [...(dialog()?.querySelectorAll("button") ?? [])].find(b => /yes/i.test(b.dataset.action ?? b.textContent));
      await until(() => yes());
      const dialogText = dialog()?.querySelector(".window-content")?.textContent.replace(/\s+/g, " ").trim() ?? null;
      const at = Date.now();
      click(yes());
      await until(() => store.getLog().find(r => r.id === rowId)?.refunded);
      await wait(500);
      await app.close();
      return { at, dialogText, purseCp: toCopper(actor.system.currency), items: actor.items.filter(i => !i.flags?.dnd5e?.cachedFor).length, rules: structuredClone(store.getBoxes()[before.boxId].rules) };
    }, { base: MODULE_BASE, before, rowId });
    out.cardAfterRefund = await untilCard(pl.page, c => !c.off && c.limit !== "", out.refund.at);
    if (shot) await pl.page.screenshot({ path: shot });

    const b = out.buy, r = out.restock;
    const sentence = `${BOX}: limit reached, ${before.max} of ${before.max} for Crate Tester. Nothing was charged.`;
    out.checks = {
      cardBefore: b.start.stock === "3 of 3 left" && b.start.limit === "You can buy 1 more" && !b.start.off && b.start.why === "",
      bought: b.landed && out.afterStale.rows.length === 1 && out.afterStale.purseCp === before.purseCp - 100 && out.afterStale.items === before.items + 1,
      cardAtLimit: b.after.stock === "2 of 3 left" && b.after.why === `Limit reached: ${before.max} of ${before.max} for Crate Tester` && b.after.off && b.after.describedBy.split(" ").includes(b.after.whyId) && b.after.limit === "",
      staleRefused: out.stale.refused && out.stale.message === sentence && out.afterStale.rows.length === 1 && out.afterStale.rules?.stock === 2,
      boxesRow: r.rulesCell === `2 of 3 left, ${before.max} per character`,
      limitsGroup: r.legend === "Limits" && r.leftBefore === "2 of 3 left" && r.stockField === "3" && r.limitField.max === String(before.max) && r.limitField.per === "ever" && !r.offBefore,
      restock: r.leftAfter === "3 of 3 left once you save" && r.stored.stock === 2 && r.stored.stockMax === 3 && r.saved.stock === 3 && r.saved.stockMax === 3 && r.focusKept && r.offAfter,
      saveKeepsIt: r.saved.stock === 3 && r.saved.stockMax === 3 && r.saved.perCharacter?.max === before.max && r.rulesAfter === `3 of 3 left, ${before.max} per character`,
      cardAfterRestock: out.cardAfterRestock.ms != null && out.cardAfterRestock.ms <= 2000 && out.cardAfterRestock.off,
      refund: /Return <?1 gp/.test(out.refund.dialogText ?? "") && /goes back to 3 in stock/.test(out.refund.dialogText ?? "") && out.refund.purseCp === before.purseCp && out.refund.items === before.items && out.refund.rules.stock === 3,
      buyBack: out.cardAfterRefund.ms != null && out.cardAfterRefund.ms <= 2000 && !out.cardAfterRefund.off && out.cardAfterRefund.limit === "You can buy 1 more" && out.cardAfterRefund.why === "" && out.cardAfterRefund.stock === "3 of 3 left",
    };
    out.ok = Object.values(out.checks).every(Boolean);
    out.gmConsole = gm.logs.filter(l => !l.includes("timings"));
    out.playerLog = pl.logs;
  } catch (err) {
    out.error = String(err?.stack || err);
    out.ok = false;
  } finally {
    try { out.restored = await restore(gm?.page, before); } catch (err) { out.restored = { error: String(err) }; }
    console.log(JSON.stringify(out, null, 1));
    if (!out.ok) process.exitCode = 1;
    await browser.close();
  }
})();
