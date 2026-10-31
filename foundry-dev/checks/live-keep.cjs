// Live check: Buy to keep (boxcard.js cardShell, shop.js, socket.js doKeep,
// pull.js performKeep, tickets.js keepTicket), at a real table with the
// branch's code on both ends.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/checks/live-keep.cjs [--shot out.png]
//   (or: npm run live -- live-keep)
//
// Env: PLAYER (default Player2, must own Crate Tester), PACK (default
// dnd5e.items, where the pool's one item comes from).
//
// Two headless clients, the Gamemaster and the player, each running the
// branch's socket, redraw and dnd5e.preUseActivity hook (as live-ticket.cjs
// does). Then, as people do:
//
//   0. The GM seeds "Live ticket pool" (one item from PACK, common) and a
//      crate drawing from it at 5 gp, opens the shop if it was closed, and
//      tops Crate Tester's gold up if it is low.
//   1. The player opens the shop on Crate Tester and presses the crate's
//      Buy to keep (the real button, by the mouse). The purse drops by
//      5 gp, a kept ticket to the crate (quantity 1, paid 5) is in the pack,
//      the shop's notice says where it went, no reveal opens, the row reads
//      "(5 gp, kept)" and the chat line names the ticket.
//   2. The player presses Buy to keep again: the same item, quantity 2, the
//      purse 10 gp down in all.
//   3. The GM refunds the newest row from the Pull log (Refund, Yes): the
//      quantity is 1 and 5 gp is back in the purse.
//
// Restored in a finally: every row this run made refunded (the kept tickets
// leave the pack with them), any ticket left for the crate deleted, the
// crate deleted, the purse as it was, the shop's open state as it was.
// The pool stays seeded. Needs "Crate Tester" in "Loot Crates Test".
/* global game, Hooks, foundry, fromUuid, __lc */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const PACK = process.env.PACK || "dnd5e.items";
const POOL = "Live ticket pool";
const shot = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : null;
const STAMP = Date.now().toString(36);
const CRATE = `Live keep crate ${STAMP}`;

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
  await page.evaluate(async base => (await import(base + "scripts/core/i18n.js")).loadStrings(), MODULE_BASE);
  // The branch's code in place of the installed module's, as main.js wires it.
  await page.evaluate(async base => {
    globalThis.canvas?.app?.ticker?.stop();
    for (const sheet of [...document.styleSheets]) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (let i = rules.length - 1; i >= 0; i--) if (rules[i] instanceof CSSImportRule && /modules\/loot-crates\//.test(rules[i].href)) sheet.deleteRule(i);
    }
    for (const l of document.querySelectorAll('link[rel="stylesheet"][href*="modules/loot-crates/"]')) l.disabled = true;
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
    const { refreshShop } = await import(base + "scripts/foundry/shop.js");
    const { refreshManager } = await import(base + "scripts/foundry/manager.js");
    const redraw = storeRedraw({ refreshShop, refreshManager });
    store.setStoreListener(redraw);
    for (const key of store.WORLD_KEYS) {
      const cfg = game.settings.settings.get(`loot-crates.${key}`);
      if (cfg && !String(cfg.onChange ?? "").includes("storeChanged")) cfg.onChange = () => redraw(key);
    }
    // A ticket's Use: the branch's hook, and no other copy of it (a
    // newer installed build registers its own, which would ask twice).
    for (const h of [...(Hooks.events?.["dnd5e.preUseActivity"] ?? [])]) if (/ticketOf|requestRedeem|redeem/.test(String(h.fn))) Hooks.off("dnd5e.preUseActivity", h.fn);
    const { ticketUseHook } = await import(base + "scripts/foundry/tickets.js");
    Hooks.on("dnd5e.preUseActivity", ticketUseHook(socket.requestRedeem));
  }, MODULE_BASE);
  return { page, logs };
}

const HELPERS = `
  globalThis.__lc = globalThis.__lc ?? {};
  __lc.wait = ms => new Promise(r => setTimeout(r, ms));
  __lc.until = async (fn, ms = 15000) => { for (let t = 0; t < ms && !fn(); t += 50) await __lc.wait(50); return fn(); };
  __lc.click = el => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
`;

// Crate Tester as the GM sees it: the purse in copper and its kept tickets
// to the crate ({ id, qty, paid }).
const readActor = (page, boxId) => page.evaluate(async ({ base, boxId }) => {
  const { toCopper } = await import(base + "scripts/core/currency.js");
  const actor = game.actors.find(a => a.name === "Crate Tester" && a.folder?.name === "Loot Crates Test");
  const tickets = actor.items.filter(i => i.flags?.["loot-crates"]?.ticket?.boxId === boxId).map(i => ({ id: i.id, qty: i.system.quantity, paid: i.flags["loot-crates"].ticket.paid, kept: !!i.flags["loot-crates"].ticket.kept, type: i.type }));
  return { purseCp: toCopper(actor.system.currency), tickets };
}, { base: MODULE_BASE, boxId });

const untilActor = async (page, boxId, pred, ms = 10000) => {
  const t0 = Date.now();
  let a = await readActor(page, boxId);
  while (!pred(a) && Date.now() - t0 < ms) { await page.waitForTimeout(100); a = await readActor(page, boxId); }
  return { ...a, ms: pred(a) ? Date.now() - t0 : null };
};

const logRows = (page, boxId) => page.evaluate(async ({ base, boxId }) => (await import(base + "scripts/foundry/store.js")).getLog().filter(r => r.boxId === boxId).map(r => ({ id: r.id, price: r.price, itemId: r.itemId ?? null, refunded: !!r.refunded, keep: r.keep ?? null })), { base: MODULE_BASE, boxId });

(async () => {
  const browser = await chromium.launch();
  const out = { player: PLAYER };
  let gm = null, pl = null;
  let boxId = null, before = null;
  try {
    pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");

    // 0. The pool, the crate, the shop open and the gold.
    out.seed = await gm.page.evaluate(async ({ base, pack: packId, poolName, crate }) => {
      const store = await import(base + "scripts/foundry/store.js");
      const { toCopper } = await import(base + "scripts/core/currency.js");
      const folder = game.folders.find(f => f.type === "Actor" && f.name === "Loot Crates Test");
      const actor = game.actors.find(a => a.name === "Crate Tester" && a.folder?.id === folder?.id);
      if (!actor) throw new Error("no Crate Tester in Loot Crates Test");
      if ((actor.system.currency.gp ?? 0) < 20) await actor.update({ "system.currency.gp": 1000 });
      const pack = game.packs.get(packId);
      if (!pack) throw new Error(`no ${packId} compendium in this world`);
      const index = await pack.getIndex({ fields: ["system.rarity", "type"] });
      const hit = index.find(e => store.isLootType(e.type) && e.type !== "consumable");
      if (!hit) throw new Error(`${packId} holds no loot-type item`);
      const entry = store.entryFromItem(await fromUuid(hit.uuid), hit.uuid);
      const old = Object.values(store.getPools()).find(p => p.name === poolName);
      const pool = await store.savePool({ ...(old ? { id: old.id } : {}), name: poolName, entries: [{ ...entry, rarity: "common" }], pools: [] });
      const c = await store.saveBox({ name: crate, price: 5, pools: [{ id: pool.id, share: 1 }], weights: { common: 1 }, rules: {} });
      const shopWasOpen = store.isShopOpen();
      if (!shopWasOpen) await store.setShopOpen(true);
      return { crateId: c.id, shopWasOpen, purse: foundry.utils.deepClone(actor.system.currency), purseCp: toCopper(actor.system.currency) };
    }, { base: MODULE_BASE, pack: PACK, poolName: POOL, crate: CRATE });
    boxId = out.seed.crateId;
    before = await readActor(gm.page, boxId);

    // 1. The player's shop on Crate Tester, and its Buy to keep.
    await pl.page.evaluate(async ({ base, helpers }) => {
      (0, eval)(helpers);
      const { openShop } = await import(base + "scripts/foundry/shop.js");
      const actor = game.actors.find(a => a.isOwner && a.name === "Crate Tester");
      __lc.shop = openShop();
      await __lc.until(() => __lc.shop.element?.querySelector(".lc-box"), 8000);
      const pick = __lc.shop.element.querySelector(".lc-shop__actor");
      if (pick && pick.value !== actor.id) { pick.value = actor.id; pick.dispatchEvent(new Event("change")); await __lc.wait(800); }
    }, { base: MODULE_BASE, helpers: HELPERS });
    const keepBtn = pl.page.locator(`#loot-crates-shop .lc-box__keep[data-keep="${boxId}"]`);
    await keepBtn.waitFor({ timeout: 10000 });
    out.button = await keepBtn.evaluate(b => ({ text: b.textContent.replace(/\s+/g, " ").trim(), off: b.getAttribute("aria-disabled"), price: b.dataset.price, under: b.previousElementSibling?.classList.contains("lc-box__buy") ?? false }));
    const chatN = await gm.page.evaluate(() => game.messages.contents.length);
    await keepBtn.click();
    const first = await untilActor(gm.page, boxId, a => a.tickets.length === 1 && a.tickets[0].qty === 1 && a.purseCp === before.purseCp - 500, 15000);
    await pl.page.waitForFunction(() => /ticket is in/.test(document.querySelector("#loot-crates-shop .lc-shop__notice")?.textContent ?? ""), null, { timeout: 8000 }).catch(() => {});
    out.first = { ...first, notice: await pl.page.evaluate(() => document.querySelector("#loot-crates-shop .lc-shop__notice")?.textContent ?? null), reveals: await pl.page.evaluate(() => document.querySelectorAll(".application.lc-reveal").length) };
    await gm.page.waitForFunction(n => game.messages.contents.length > n, chatN, { timeout: 5000 }).catch(() => {});
    out.chat = await gm.page.evaluate(n => game.messages.contents.slice(n).map(m => m.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()), chatN);
    if (shot) await pl.page.screenshot({ path: shot });

    // 2. Again: the same stack, two now.
    await pl.page.waitForFunction(id => document.querySelector(`#loot-crates-shop .lc-box__keep[data-keep="${id}"]`)?.getAttribute("aria-disabled") !== "true", boxId, { timeout: 8000 });
    await keepBtn.click();
    out.second = await untilActor(gm.page, boxId, a => a.tickets.length === 1 && a.tickets[0].qty === 2 && a.purseCp === before.purseCp - 1000, 15000);
    // The row is written just after the ticket (in the same queued task).
    for (let t0 = Date.now(); Date.now() - t0 < 8000; await gm.page.waitForTimeout(100)) if ((out.rows = await logRows(gm.page, boxId)).length >= 2) break;

    // 3. The GM refunds the newest row from the Pull log: Refund, Yes.
    out.refund = await gm.page.evaluate(async ({ base, helpers, rowId }) => {
      (0, eval)(helpers);
      const store = await import(base + "scripts/foundry/store.js");
      const { openManager } = await import(base + "scripts/foundry/manager.js");
      __lc.app = openManager();
      await __lc.until(() => __lc.app.element?.querySelector('.lc-tabs [data-tab="log"]'));
      __lc.click(__lc.app.element.querySelector('.lc-tabs [data-tab="log"]'));
      const btn = () => __lc.app.element?.querySelector(`button[data-action=refund][data-row="${rowId}"]`);
      if (!await __lc.until(() => __lc.app.tab === "log" && btn(), 8000)) throw new Error("the Pull log has no Refund for the kept row");
      const cell = btn().closest("tr")?.querySelector('td[data-label="Game"]')?.textContent.trim() ?? null;
      __lc.click(btn());
      const dialog = () => [...document.querySelectorAll(".application.dialog")].pop();
      const yes = () => [...(dialog()?.querySelectorAll("button") ?? [])].find(b => /yes/i.test(b.dataset.action ?? b.textContent));
      await __lc.until(() => yes());
      const ask = dialog()?.querySelector(".window-content")?.textContent.replace(/\s+/g, " ").trim() ?? null;
      const chatN = game.messages.contents.length;
      __lc.click(yes());
      await __lc.until(() => store.getLog().find(r => r.id === rowId)?.refunded, 8000);
      await __lc.until(() => game.messages.contents.length > chatN, 5000);
      const card = game.messages.contents.slice(chatN).map(m => m.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).join(" | ");
      return { cell, ask, card, refunded: !!store.getLog().find(r => r.id === rowId)?.refunded };
    }, { base: MODULE_BASE, helpers: HELPERS, rowId: out.rows[0]?.id });
    out.afterRefund = await untilActor(gm.page, boxId, a => a.tickets[0]?.qty === 1 && a.purseCp === before.purseCp - 500, 10000);

    const t1 = out.first.tickets[0];
    out.checks = {
      button: out.button.text === `${CRATE}: Buy to keep, 5 gp, a ticket for your pack to use later` && out.button.off == null && out.button.price === "5" && out.button.under,
      charged: out.first.ms != null && out.first.purseCp === before.purseCp - 500,
      inPack: !!t1 && t1.type === "consumable" && t1.kept && t1.paid === 5 && t1.qty === 1,
      notice: (out.first.notice ?? "").startsWith(`A ${CRATE} ticket is in Crate Tester's pack (1 now).`),
      noReveal: out.first.reveals === 0,
      chatLine: out.chat.some(c => c.includes(`Crate Tester bought a ${CRATE} ticket to keep 5 gp`)),
      stacked: out.second.ms != null && out.second.tickets.length === 1 && out.second.tickets[0].id === t1?.id && out.second.tickets[0].qty === 2,
      rows: out.rows.length === 2 && out.rows.every(r => r.price === 5 && r.itemId == null && r.keep?.itemId === t1?.id && r.keep?.paid === 5),
      refunded: out.refund.refunded && out.refund.cell === `${CRATE} (5 gp, kept)` && /Return 5 gp to Crate Tester and take one .+ ticket out of their pack\?/.test(out.refund.ask ?? "") && /One .+ ticket was taken out of their pack\. 5 gp went back into their purse\./.test(out.refund.card ?? ""),
      afterRefund: out.afterRefund.ms != null && out.afterRefund.tickets[0]?.qty === 1 && out.afterRefund.purseCp === before.purseCp - 500,
    };
    out.ok = Object.values(out.checks).every(Boolean);
    out.gmConsole = gm.logs.filter(l => !l.includes("timings"));
    out.playerLog = pl.logs.filter(l => !l.includes("timings"));
  } catch (err) {
    out.error = String(err?.stack || err);
    out.ok = false;
  } finally {
    // Every row refunded (each takes its kept ticket back), any ticket left
    // deleted, the crate deleted, the purse and the shop as they were.
    try {
      out.restored = gm && boxId ? await gm.page.evaluate(async ({ base, boxId, purse, shopWasOpen }) => {
        const store = await import(base + "scripts/foundry/store.js");
        const { refundPull } = await import(base + "scripts/foundry/refund.js");
        const { toCopper } = await import(base + "scripts/core/currency.js");
        const refunded = [];
        for (const r of store.getLog().filter(x => x.boxId === boxId && !x.refunded)) refunded.push((await refundPull(r.id)).status);
        const actor = game.actors.find(a => a.name === "Crate Tester" && a.folder?.name === "Loot Crates Test");
        const tickets = actor.items.filter(i => i.flags?.["loot-crates"]?.ticket?.boxId === boxId).map(i => i.id);
        if (tickets.length) await actor.deleteEmbeddedDocuments("Item", tickets);
        const purseOk = toCopper(actor.system.currency) === toCopper(purse);
        if (!purseOk) await actor.update({ "system.currency": purse });
        await store.removeBox(boxId);
        if (!shopWasOpen) await store.setShopOpen(false);
        try { await globalThis.__lc?.app?.close(); } catch { /* closed */ }
        return { refunded, tickets: tickets.length, purseOk, gone: !store.getBoxes()[boxId], shop: store.isShopOpen() === shopWasOpen };
      }, { base: MODULE_BASE, boxId, purse: out.seed?.purse, shopWasOpen: out.seed?.shopWasOpen }) : null;
    } catch (err) { out.restored = { error: String(err) }; out.ok = false; }
    if (out.restored && (out.restored.error || !out.restored.gone || !out.restored.shop || out.restored.tickets || out.restored.refunded.some(s => s !== "refunded"))) out.ok = false;
    try { await pl?.page.evaluate(() => { for (const a of [...foundry.applications.instances.values()]) if (/loot-crates/.test(a.id)) a.close(); }); } catch { /* closing */ }
    console.log(JSON.stringify(out, null, 1));
    if (!out.ok) process.exitCode = 1;
    await browser.close();
  }
})();
