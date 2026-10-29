// Live check: a scratch ticket's printed roll (scratch.js, VIB-188) at a
// real table, with the branch's code on both ends: made in the editor,
// bought through the real Buy until it is sold out, a ticket back on a
// refund, and a new roll printed from the Boxes row.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/checks/live-scratch-roll.cjs [--shot out.png]
//
// Env: PLAYER (default Player2, must own Crate Tester).
//
// Two headless clients, the Gamemaster and the player, each running the
// branch's socket, redraw and shop code (as live-new-game.cjs does). Then,
// as people do:
//
//   1. The GM clicks "New scratch ticket" on the Boxes tab, types a name and
//      "1 gp", prints 3 tickets, removes prize rows with their remove
//      buttons until one is left, makes it 1 ticket of 1 gp coins, unticks
//      the bonus spot and presses Add to shelf. One record: a roll of 3,
//      one 1 gp prize line ({ count: 1, parts: [{ gp: 1 }] }); the readout
//      said "1 in 3 tickets wins ...".
//   2. The player's open shop shows its card, "3 of 3 tickets left"; the
//      player presses its Buy three times (each ticket opened with its
//      Reveal all, the window closed). The card then reads "Roll 1 is sold out" with "Sold out"
//      under an off Buy; 3 gp were charged and 1 gp paid back.
//   3. A fourth press of the Buy sends nothing (its reason is on the
//      card); a fourth pull sent through the public request path, as a
//      shop drawn a moment earlier would, is refused by the GM with "...
//      is sold out. Ask the GM to print a new roll." and charges nothing.
//   4. The GM refunds one of the tickets from the Pull log (Refund, Yes):
//      the player's card reads "1 of 3 tickets left" with its Buy on.
//   5. The GM presses Print a new roll on the row and Yes: the record is
//      on roll 2, the status line says so, and the player's card reads
//      "3 of 3 tickets left".
//
// Restored in a finally: every ticket this run bought is refunded and the
// game it made is deleted (only that one); the shop's open state put back.
// Needs "Crate Tester" in "Loot Crates Test".
/* global game, Hooks, foundry, __lc */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const shot = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : null;
const STAMP = Date.now().toString(36);
const NAME = `Live scratch ${STAMP}`;

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
  // What main.js does first: the branch's words, from its own lang/en.json.
  await page.evaluate(async base => (await import(base + "scripts/core/i18n.js")).loadStrings(), MODULE_BASE);
  // The branch's code in place of the installed module's, as main.js wires it.
  await page.evaluate(async base => {
    globalThis.canvas?.app?.ticker?.stop();
    // The installed build's stylesheet goes (Foundry imports each module's
    // into a style element): its prize row hid a gold field by the row's
    // choice, which a row of prize lines (scratch.js) no longer has.
    for (const sheet of [...document.styleSheets]) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (let i = rules.length - 1; i >= 0; i--) if (rules[i] instanceof CSSImportRule && /modules\/loot-crates\//.test(rules[i].href)) sheet.deleteRule(i);
    }
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
  }, MODULE_BASE);
  return { page, logs };
}

const HELPERS = `
  globalThis.__lc = globalThis.__lc ?? {};
  __lc.wait = ms => new Promise(r => setTimeout(r, ms));
  __lc.until = async (fn, ms = 15000) => { for (let t = 0; t < ms && !fn(); t += 50) await __lc.wait(50); return fn(); };
  __lc.click = el => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
  __lc.dialog = () => [...document.querySelectorAll(".application.lc-dialog")].pop() ?? null;
  __lc.status = () => __lc.app?.element?.querySelector(".lc-manager__status")?.textContent ?? null;
  __lc.closeReveals = () => { for (const a of [...foundry.applications.instances.values()]) if (a.element?.classList.contains("lc-reveal")) a.close(); };
`;

// The player's card for the game, read from the shop as it stands.
const readCard = (pl, boxId) => pl.evaluate(async ({ base, boxId }) => {
  const { getLog } = await import(base + "scripts/foundry/store.js");
  const { toCopper } = await import(base + "scripts/core/currency.js");
  const actor = game.actors.find(a => a.isOwner && a.type === "character" && a.name === "Crate Tester");
  const card = document.querySelector(`#loot-crates-shop .lc-box[data-box="${boxId}"]`);
  const buy = card?.querySelector(".lc-box__buy");
  return {
    shown: !!card, stock: card?.querySelector(".lc-box__stock")?.textContent.trim() ?? null, why: card?.querySelector(".lc-box__why")?.textContent.trim() ?? "",
    buy: buy?.textContent.replace(/\s+/g, " ").trim() ?? null, off: buy?.getAttribute("aria-disabled") === "true",
    rows: getLog().filter(r => r.boxId === boxId).length, purseCp: toCopper(actor.system.currency),
  };
}, { base: MODULE_BASE, boxId });

const untilCard = async (pl, boxId, pred, ms = 5000) => {
  const t0 = Date.now();
  let c = await readCard(pl, boxId);
  while (!pred(c) && Date.now() - t0 < ms) { await pl.waitForTimeout(100); c = await readCard(pl, boxId); }
  return { ...c, ms: pred(c) ? Date.now() - t0 : null };
};

(async () => {
  const browser = await chromium.launch();
  const out = { player: PLAYER, name: NAME };
  let gm = null, pl = null, boxId = null, shopOpen = true;
  try {
    pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");

    shopOpen = await gm.page.evaluate(async base => {
      const store = await import(base + "scripts/foundry/store.js");
      const folder = game.folders.find(f => f.type === "Actor" && f.name === "Loot Crates Test");
      const actor = game.actors.find(a => a.name === "Crate Tester" && a.folder?.id === folder?.id);
      if (!actor) throw new Error("no Crate Tester in Loot Crates Test");
      if ((actor.system.currency.gp ?? 0) < 20) await actor.update({ "system.currency.gp": 1000 });
      const open = store.isShopOpen();
      if (!open) await store.setShopOpen(true);
      return open;
    }, MODULE_BASE);

    // The player's shop, open on Crate Tester.
    await pl.page.evaluate(async ({ base, helpers }) => {
      (0, eval)(helpers);
      const { openShop } = await import(base + "scripts/foundry/shop.js");
      const actor = game.actors.find(a => a.isOwner && a.type === "character" && a.name === "Crate Tester");
      if (!actor) throw new Error(`${game.user.name} doesn't own Crate Tester`);
      const app = openShop();
      await __lc.until(() => app.element?.querySelector(".lc-shop__body"), 8000);
      const pick = app.element.querySelector(".lc-shop__actor");
      if (pick && pick.value !== actor.id) { pick.value = actor.id; pick.dispatchEvent(new Event("change")); await __lc.wait(800); }
    }, { base: MODULE_BASE, helpers: HELPERS });

    // 1. New scratch ticket in the editor, as a GM fills it in.
    await gm.page.evaluate(async ({ base, helpers }) => {
      (0, eval)(helpers);
      const { openManager } = await import(base + "scripts/foundry/manager.js");
      __lc.app = openManager();
      await __lc.until(() => __lc.app.element?.querySelector('.lc-tabs [data-tab="boxes"]'));
      __lc.click(__lc.app.element.querySelector('.lc-tabs [data-tab="boxes"]'));
      await __lc.until(() => __lc.app.tab === "boxes" && __lc.app.element.querySelector('[data-action="addScratch"]'), 8000);
    }, { base: MODULE_BASE, helpers: HELPERS });
    await gm.page.locator('#loot-crates-manager [data-action="addScratch"]').click();
    const dlg = gm.page.locator(".application.lc-dialog").last();
    await dlg.locator('input[name="name"]').waitFor({ timeout: 8000 });
    await dlg.locator('input[name="name"]').fill(NAME);
    await dlg.locator('input[name="price"]').fill("1 gp");
    await dlg.locator('input[name="size"]').fill("3");
    while (await dlg.locator(".lc-prize-row").count() > 1) await dlg.locator(".lc-prize-row__remove").first().click();
    const row = dlg.locator(".lc-prize-row").first();
    await row.locator(".lc-prize-row__what").selectOption("gp");
    await row.locator(".lc-prize-row__count").fill("1");
    await row.locator(".lc-prize-row__gp").fill("1");
    await dlg.locator('input[name="bonusOn"]').uncheck();
    out.readout = (await dlg.locator(".lc-scratch-form__readout").textContent()).trim();
    const known = await gm.page.evaluate(() => Object.keys(game.settings.get("loot-crates", "boxes")));
    await dlg.locator('button[data-action="ok"]').click();
    out.made = await gm.page.evaluate(async ({ base, known }) => {
      const store = await import(base + "scripts/foundry/store.js");
      const fresh = () => Object.values(store.getBoxes()).filter(b => !known.includes(b.id));
      await __lc.until(() => fresh().length && !__lc.dialog(), 8000);
      await __lc.until(() => __lc.status(), 3000);
      const b = fresh()[0];
      return b ? { id: b.id, kind: b.kind, name: b.name, price: b.price, layout: b.layout, bonus: b.bonus, roll: b.roll, status: __lc.status() } : null;
    }, { base: MODULE_BASE, known });
    boxId = out.made?.id ?? null;
    if (!boxId) throw new Error("no scratch ticket was added");

    // 2. Three Buys through the real button.
    out.start = await untilCard(pl.page, boxId, c => c.shown && c.stock === "3 of 3 tickets left");
    out.buys = [];
    const STOCKS = ["2 of 3 tickets left", "1 of 3 tickets left", "Roll 1 is sold out"];
    for (let i = 0; i < 3; i++) {
      const before = await untilCard(pl.page, boxId, c => !c.off, 5000);
      await pl.page.locator(`#loot-crates-shop .lc-box__buy[data-box="${boxId}"]`).click();
      // The ticket is the buyer's to scratch (live-scratch rubs it by hand);
      // here the real Reveal all opens it. The shop holds the roll's counts
      // from before the draw until the card is open, so the stock is read
      // once the window has landed.
      await pl.page.locator(".application.lc-reveal .lc-scratch__all").last().click({ timeout: 15000 });
      await pl.page.waitForSelector(".application.lc-reveal .lc-scratch--landed", { timeout: 15000 }).catch(() => {});
      const after = await untilCard(pl.page, boxId, c => c.rows === before.rows + 1 && c.stock === STOCKS[i], 15000);
      const reveal = await pl.page.evaluate(() => {
        const rv = [...document.querySelectorAll(".application.lc-reveal")].pop();
        return { panels: rv?.querySelectorAll(".lc-scratch__panel").length ?? 0, result: rv?.querySelector(".lc-reveal__result")?.innerText.replace(/\s+/g, " ").trim() ?? null };
      });
      out.buys.push({ stock: after.stock, rows: after.rows, reveal });
      if (i === 2 && shot) await pl.page.screenshot({ path: shot });
      await pl.page.evaluate(() => __lc.closeReveals());
      await gm.page.evaluate(() => __lc.closeReveals());
    }
    out.soldOut = await untilCard(pl.page, boxId, c => c.off && c.why === "Sold out");
    out.log = await gm.page.evaluate(async ({ base, boxId }) => (await import(base + "scripts/foundry/store.js")).getLog().filter(r => r.boxId === boxId).map(r => ({ id: r.id, tier: r.tier, rollId: r.rollId, price: r.price, payoutCp: r.payoutCp, refunded: !!r.refunded })), { base: MODULE_BASE, boxId });

    // 3. A fourth press does nothing; a fourth request is refused by the GM.
    // The Buy is aria-disabled (it keeps focus), so the mouse still lands on it.
    await pl.page.locator(`#loot-crates-shop .lc-box__buy[data-box="${boxId}"]`).click({ force: true });
    await pl.page.waitForTimeout(1500);
    out.fourthPress = await readCard(pl.page, boxId);
    out.fourthRequest = await pl.page.evaluate(async ({ base, boxId }) => {
      const { requestPull } = await import(base + "scripts/foundry/socket.js");
      const actor = game.actors.find(a => a.isOwner && a.type === "character" && a.name === "Crate Tester");
      try { await requestPull({ boxId, actorId: actor.id, price: 1 }); return { refused: null }; } catch (err) { return { refused: err.message }; }
    }, { base: MODULE_BASE, boxId });
    await pl.page.waitForTimeout(800);
    out.afterFourth = await readCard(pl.page, boxId);

    // 4. The GM refunds one ticket from the Pull log: Refund, Yes.
    const refundId = out.log.find(r => r.tier === "dud")?.id ?? out.log[0]?.id;
    out.refund = await gm.page.evaluate(async ({ base, rowId }) => {
      const store = await import(base + "scripts/foundry/store.js");
      __lc.click(__lc.app.element.querySelector('.lc-tabs [data-tab="log"]'));
      const btn = () => __lc.app.element?.querySelector(`button[data-action=refund][data-row="${rowId}"]`);
      if (!await __lc.until(() => __lc.app.tab === "log" && btn(), 8000)) throw new Error("the Pull log has no Refund for the ticket");
      __lc.click(btn());
      const dialog = () => [...document.querySelectorAll(".application.dialog")].pop();
      const yes = () => [...(dialog()?.querySelectorAll("button") ?? [])].find(b => /yes/i.test(b.dataset.action ?? b.textContent));
      await __lc.until(() => yes());
      __lc.click(yes());
      await __lc.until(() => store.getLog().find(r => r.id === rowId)?.refunded, 8000);
      return { refunded: !!store.getLog().find(r => r.id === rowId)?.refunded };
    }, { base: MODULE_BASE, rowId: refundId });
    out.afterRefund = await untilCard(pl.page, boxId, c => !c.off && c.stock === "1 of 3 tickets left");

    // 5. Print a new roll from the Boxes row: Yes.
    out.print = await gm.page.evaluate(async ({ base, boxId }) => {
      const store = await import(base + "scripts/foundry/store.js");
      __lc.click(__lc.app.element.querySelector('.lc-tabs [data-tab="boxes"]'));
      const btn = () => __lc.app.element?.querySelector(`button[data-action="printRoll"][data-box="${boxId}"]`);
      if (!await __lc.until(() => __lc.app.tab === "boxes" && btn(), 8000)) throw new Error("no Print a new roll on the row");
      const label = btn().getAttribute("aria-label");
      __lc.click(btn());
      const dialog = () => [...document.querySelectorAll(".application.dialog")].pop();
      const yes = () => [...(dialog()?.querySelectorAll("button") ?? [])].find(b => /yes/i.test(b.dataset.action ?? b.textContent));
      await __lc.until(() => yes());
      const ask = dialog()?.querySelector(".window-content")?.textContent.replace(/\s+/g, " ").trim() ?? null;
      __lc.click(yes());
      await __lc.until(() => store.getBoxes()[boxId]?.roll?.id === 2, 8000);
      await __lc.until(() => /Roll 2 is printed/.test(__lc.status() ?? ""), 3000);
      return { label, ask, roll: store.getBoxes()[boxId]?.roll?.id, status: __lc.status() };
    }, { base: MODULE_BASE, boxId });
    out.afterPrint = await untilCard(pl.page, boxId, c => !c.off && c.stock === "3 of 3 tickets left");

    const coins = out.log.reduce((n, r) => n + (r.payoutCp || 0), 0);
    out.checks = {
      readout: out.readout === "1 in 3 tickets wins, the top prize (1 gp) 1 in 3, all prizes 1 gp or more",
      made: out.made.kind === "scratch" && out.made.price === 1 && out.made.layout === "lucky" && out.made.bonus?.on === false && out.made.roll?.id === 1 && out.made.roll?.size === 3 && JSON.stringify(out.made.roll?.prizes) === JSON.stringify([{ count: 1, parts: [{ gp: 1 }] }]) && out.made.status === `${NAME} is on the shelf at 1 gp.`,
      shopCard: out.start.ms != null && !out.start.off && out.start.buy === `${NAME}: Buy a ticket for 1 gp`,
      threeBuys: out.buys.map(b => b.stock).join("|") === "2 of 3 tickets left|1 of 3 tickets left|Roll 1 is sold out" && out.buys.every(b => b.reveal.panels >= 12),
      roll: out.log.length === 3 && out.log.every(r => r.rollId === 1 && r.price === 1) && out.log.filter(r => r.tier === "gp.1").length === 1 && out.log.filter(r => r.tier === "dud").length === 2 && coins === 100,
      charged: out.start.purseCp - out.soldOut.purseCp === 300 - coins,
      soldOut: out.soldOut.ms != null && out.soldOut.off && out.soldOut.why === "Sold out" && out.soldOut.stock === "Roll 1 is sold out",
      fourthPress: out.fourthPress.rows === 3 && out.fourthPress.purseCp === out.soldOut.purseCp && out.fourthPress.off,
      fourthRefused: out.fourthRequest.refused === `${NAME} is sold out. Ask the GM to print a new roll.` && out.afterFourth.rows === 3 && out.afterFourth.purseCp === out.soldOut.purseCp,
      refundBack: out.refund.refunded && out.afterRefund.ms != null && !out.afterRefund.off && out.afterRefund.purseCp === out.soldOut.purseCp + 100,
      printed: out.print.label === `Print a new roll of ${NAME}` && /Roll 1 still has 1 of 3 tickets left/.test(out.print.ask ?? "") && out.print.roll === 2 && out.print.status === `${NAME}: Roll 2 is printed, 3 tickets on sale.` && out.afterPrint.ms != null,
    };
    out.ok = Object.values(out.checks).every(Boolean);
    out.gmConsole = gm.logs.filter(l => !l.includes("timings"));
    out.playerLog = pl.logs;
  } catch (err) {
    out.error = String(err?.stack || err);
    out.ok = false;
  } finally {
    // Every ticket this run bought refunded, the game it made deleted, the shop as it was.
    try {
      out.restored = gm && boxId ? await gm.page.evaluate(async ({ base, boxId, shopOpen }) => {
        const store = await import(base + "scripts/foundry/store.js");
        const { refundPull } = await import(base + "scripts/foundry/refund.js");
        const refunded = [];
        for (const r of store.getLog().filter(x => x.boxId === boxId && !x.refunded)) { const res = await refundPull(r.id); refunded.push(res.status); }
        await store.removeBox(boxId);
        if (!shopOpen) await store.setShopOpen(false);
        try { await globalThis.__lc?.app?.close(); } catch { /* closed */ }
        __lc.closeReveals?.();
        return { refunded, gone: !store.getBoxes()[boxId], open: store.isShopOpen() };
      }, { base: MODULE_BASE, boxId, shopOpen }) : null;
    } catch (err) { out.restored = { error: String(err) }; out.ok = false; }
    if (out.restored && (out.restored.error || !out.restored.gone || out.restored.refunded.some(s => s !== "refunded"))) out.ok = false;
    try { await pl?.page.evaluate(() => { for (const a of [...foundry.applications.instances.values()]) if (/loot-crates/.test(a.id) || a.element?.classList.contains("lc-reveal")) a.close(); }); } catch { /* closing */ }
    console.log(JSON.stringify(out, null, 1));
    if (!out.ok) process.exitCode = 1;
    await browser.close();
  }
})();
