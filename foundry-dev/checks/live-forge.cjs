// Live check: who sent it (socket.js). A player's client can write anything
// into a request, so the GM must take the sender from Foundry, never from
// the message. Three clients, each running the branch's socket code:
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/checks/live-forge.cjs
//   (or: npm run live -- live-forge)
//
// Env: VICTIM (default Player2, must own Crate Tester), FORGER (default
// Player3, must not own it), PACK (default dnd5e.items).
//
//   0. The GM seeds "Live ticket pool" and a crate drawing from it at 5 gp,
//      opens the shop if it was closed, and tops Crate Tester's gold up.
//   1. The forger emits a pull on the module's socket that names the
//      victim as its sender and Crate Tester as the buyer (the old way a
//      request travelled).
//   2. If the branch registers its query (CONFIG.queries
//      "loot-crates.request"), the forger sends the same pull that way too,
//      still naming the victim in the body.
//   3. The forger listens on the module socket while the victim presses
//      the crate's real Buy; whatever request it overhears, it calls off
//      as the victim (a cancel naming the victim), and when the reveal goes
//      out it calls that request off again, by the query when there is one.
//
// Reported: what the GM did with each forged request (charged or not, the
// rows it wrote, its console), whether the forger heard the victim's
// request, whether the victim's purchase went through once and whether a
// forged cancel marked it. ok means every forged request was refused with
// nothing charged and the real purchase stood, unmarked.
//
// Restored in a finally: every row this run made refunded (the items leave
// Crate Tester with them), the crate deleted, the purse and the shop's open
// state as they were. The pool stays seeded. Needs "Crate Tester" in
// "Loot Crates Test", owned by VICTIM and not by FORGER.
/* global game, foundry, fromUuid, CONFIG, __lc */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const VICTIM = process.env.VICTIM || process.env.PLAYER || "Player2";
const FORGER = process.env.FORGER || "Player3";
const PACK = process.env.PACK || "dnd5e.items";
const POOL = "Live ticket pool";
const STAMP = Date.now().toString(36);
const CRATE = `Live forge crate ${STAMP}`;
const QUERY = "loot-crates.request";

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
  }, MODULE_BASE);
  return { page, logs };
}

const HELPERS = `
  globalThis.__lc = globalThis.__lc ?? {};
  __lc.wait = ms => new Promise(r => setTimeout(r, ms));
  __lc.until = async (fn, ms = 15000) => { for (let t = 0; t < ms && !fn(); t += 50) await __lc.wait(50); return fn(); };
`;

// Crate Tester's purse in copper and the crate's rows, as the GM sees them.
const ledger = (page, boxId) => page.evaluate(async ({ base, boxId }) => {
  const { toCopper } = await import(base + "scripts/core/currency.js");
  const store = await import(base + "scripts/foundry/store.js");
  const actor = game.actors.find(a => a.name === "Crate Tester" && a.folder?.name === "Loot Crates Test");
  return { purseCp: toCopper(actor.system.currency), rows: store.getLog().filter(r => r.boxId === boxId).map(r => ({ id: r.id, userId: r.userId, refunded: !!r.refunded, lateCancel: !!r.lateCancel })) };
}, { base: MODULE_BASE, boxId });

(async () => {
  const browser = await chromium.launch();
  const out = { victim: VICTIM, forger: FORGER };
  let gm = null, vi = null, fo = null;
  let boxId = null;
  try {
    vi = await join(browser, VICTIM);
    if (!vi) throw new Error(`${VICTIM} is not free to join`);
    fo = await join(browser, FORGER);
    if (!fo) throw new Error(`${FORGER} is not free to join`);
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");

    // 0. The pool, the crate, the shop open and the gold.
    out.seed = await gm.page.evaluate(async ({ base, pack: packId, poolName, crate, victim, forger }) => {
      const store = await import(base + "scripts/foundry/store.js");
      const actor = game.actors.find(a => a.name === "Crate Tester" && a.folder?.name === "Loot Crates Test");
      if (!actor) throw new Error("no Crate Tester in Loot Crates Test");
      const v = game.users.getName(victim), f = game.users.getName(forger);
      if (!actor.testUserPermission(v, "OWNER")) throw new Error(`${victim} doesn't own Crate Tester`);
      if (actor.testUserPermission(f, "OWNER")) throw new Error(`${forger} owns Crate Tester; pick a FORGER who doesn't`);
      if ((actor.system.currency.gp ?? 0) < 20) await actor.update({ "system.currency.gp": 1000 });
      const pack = game.packs.get(packId);
      const index = await pack.getIndex({ fields: ["system.rarity", "type"] });
      const hit = index.find(e => store.isLootType(e.type) && e.type !== "consumable");
      const entry = store.entryFromItem(await fromUuid(hit.uuid), hit.uuid);
      const old = Object.values(store.getPools()).find(p => p.name === poolName);
      const pool = await store.savePool({ ...(old ? { id: old.id } : {}), name: poolName, entries: [{ ...entry, rarity: "common" }], pools: [] });
      const c = await store.saveBox({ name: crate, price: 5, pools: [{ id: pool.id, share: 1 }], weights: { common: 1 }, rules: {} });
      const shopWasOpen = store.isShopOpen();
      if (!shopWasOpen) await store.setShopOpen(true);
      return { crateId: c.id, actorId: actor.id, victimId: v.id, forgerId: f.id, shopWasOpen, purse: foundry.utils.deepClone(actor.system.currency), queryOnGM: typeof CONFIG.queries?.["loot-crates.request"] === "function" };
    }, { base: MODULE_BASE, pack: PACK, poolName: POOL, crate: CRATE, victim: VICTIM, forger: FORGER });
    boxId = out.seed.crateId;
    const { actorId, victimId } = out.seed;
    out.mode = out.seed.queryOnGM ? "query" : "socket only";
    const start = await ledger(gm.page, boxId);
    const gmLogsAt = () => gm.logs.length;

    // 1. A forged pull on the module socket, naming the victim.
    let mark = gmLogsAt();
    await fo.page.evaluate(({ boxId, actorId, victimId }) => {
      game.socket.emit("module.loot-crates", { type: "pull", requestId: "forgeSocket" + Date.now().toString(36), boxId, actorId, userId: victimId, price: 5 });
    }, { boxId, actorId, victimId });
    await gm.page.waitForTimeout(4000);
    let now = await ledger(gm.page, boxId);
    out.forgedSocket = { chargedCp: start.purseCp - now.purseCp, rows: now.rows.length - start.rows.length, gm: gm.logs.slice(mark).filter(l => !l.includes("timings")) };
    let base = now;

    // 2. The same, by the query, still naming the victim in the body.
    if (out.seed.queryOnGM) {
      mark = gmLogsAt();
      const answer = await fo.page.evaluate(async ({ boxId, actorId, victimId, name }) => {
        try { return { value: await game.users.activeGM.query(name, { type: "pull", requestId: "forgeQuery" + Date.now().toString(36), boxId, actorId, userId: victimId, price: 5 }, { timeout: 10000 }) }; } catch (e) { return { error: e.message }; }
      }, { boxId, actorId, victimId, name: QUERY });
      await gm.page.waitForTimeout(2500);
      now = await ledger(gm.page, boxId);
      out.forgedQuery = { answer, chargedCp: base.purseCp - now.purseCp, rows: now.rows.length - base.rows.length, gm: gm.logs.slice(mark).filter(l => !l.includes("timings")) };
      base = now;
    }

    // 3. The forger overhears and calls off; the victim presses Buy.
    await fo.page.evaluate(({ victimId, helpers, name }) => {
      (0, eval)(helpers);
      __lc.heard = [];
      __lc.cancels = [];
      const callOff = requestId => {
        game.socket.emit("module.loot-crates", { type: "cancel", requestId, userId: victimId });
        __lc.cancels.push({ requestId, via: "socket" });
        if (typeof CONFIG.queries?.[name] === "function") {
          game.users.activeGM.query(name, { type: "cancel", requestId, userId: victimId }, { timeout: 10000 })
            .then(v => __lc.cancels.push({ requestId, via: "query", value: v ?? null }), e => __lc.cancels.push({ requestId, via: "query", error: e.message }));
        }
      };
      game.socket.on("module.loot-crates", msg => {
        if (msg?.userId !== victimId) return;
        __lc.heard.push({ type: msg.type, requestId: msg.requestId });
        if (msg.type === "pull" || msg.type === "reveal") callOff(msg.requestId);
      });
    }, { victimId, helpers: HELPERS, name: QUERY });
    mark = gmLogsAt();
    await vi.page.evaluate(async ({ base, helpers }) => {
      (0, eval)(helpers);
      const { openShop } = await import(base + "scripts/foundry/shop.js");
      const actor = game.actors.find(a => a.isOwner && a.name === "Crate Tester");
      __lc.shop = openShop();
      await __lc.until(() => __lc.shop.element?.querySelector(".lc-box"), 8000);
      const pick = __lc.shop.element.querySelector(".lc-shop__actor");
      if (pick && pick.value !== actor.id) { pick.value = actor.id; pick.dispatchEvent(new Event("change")); await __lc.wait(800); }
    }, { base: MODULE_BASE, helpers: HELPERS });
    const buy = vi.page.locator(`.lc-shop .lc-box__buy[data-box="${boxId}"]`);
    await buy.waitFor({ timeout: 10000 });
    await buy.click();
    for (let t0 = Date.now(); Date.now() - t0 < 15000; await gm.page.waitForTimeout(200)) {
      now = await ledger(gm.page, boxId);
      if (now.rows.length > base.rows.length) break;
    }
    await gm.page.waitForTimeout(3000);
    now = await ledger(gm.page, boxId);
    const fresh = now.rows.slice(0, Math.max(0, now.rows.length - base.rows.length));
    out.realBuy = {
      chargedCp: base.purseCp - now.purseCp,
      rows: fresh,
      heard: await fo.page.evaluate(() => __lc.heard),
      cancels: await fo.page.evaluate(() => __lc.cancels),
      reveals: await vi.page.evaluate(() => document.querySelectorAll(".application.lc-reveal").length),
      gm: gm.logs.slice(mark).filter(l => !l.includes("timings")),
      victim: vi.logs.filter(l => !l.includes("timings")),
    };

    out.checks = {
      socketRefused: out.forgedSocket.chargedCp === 0 && out.forgedSocket.rows === 0,
      queryRefused: !out.seed.queryOnGM ? null : out.forgedQuery.chargedCp === 0 && out.forgedQuery.rows === 0 && !!out.forgedQuery.answer?.error,
      gmTold: !out.seed.queryOnGM ? null : [...out.forgedSocket.gm, ...out.forgedQuery.gm].some(l => /refused/i.test(l)),
      notOverheard: !out.realBuy.heard.some(h => h.type === "pull"),
      realBuyStood: out.realBuy.chargedCp === 500 && fresh.length === 1 && fresh[0].userId === victimId,
      notMarked: fresh.every(r => !r.lateCancel),
    };
    out.ok = Object.values(out.checks).every(v => v === true);
  } catch (err) {
    out.error = String(err?.stack || err);
    out.ok = false;
  } finally {
    try {
      out.restored = gm && boxId ? await gm.page.evaluate(async ({ base, boxId, purse, shopWasOpen }) => {
        const store = await import(base + "scripts/foundry/store.js");
        const { refundPull } = await import(base + "scripts/foundry/refund.js");
        const { toCopper } = await import(base + "scripts/core/currency.js");
        const refunded = [];
        for (const r of store.getLog().filter(x => x.boxId === boxId && !x.refunded)) refunded.push((await refundPull(r.id)).status);
        const actor = game.actors.find(a => a.name === "Crate Tester" && a.folder?.name === "Loot Crates Test");
        const purseOk = toCopper(actor.system.currency) === toCopper(purse);
        if (!purseOk) await actor.update({ "system.currency": purse });
        await store.removeBox(boxId);
        if (!shopWasOpen) await store.setShopOpen(false);
        return { refunded, purseOk, gone: !store.getBoxes()[boxId], shop: store.isShopOpen() === shopWasOpen };
      }, { base: MODULE_BASE, boxId, purse: out.seed?.purse, shopWasOpen: out.seed?.shopWasOpen }) : null;
    } catch (err) { out.restored = { error: String(err) }; out.ok = false; }
    if (out.restored && (out.restored.error || !out.restored.gone || !out.restored.shop || out.restored.refunded.some(s => s !== "refunded"))) out.ok = false;
    for (const c of [vi, fo]) {
      try { await c?.page.evaluate(() => { for (const a of [...foundry.applications.instances.values()]) if (/loot-crates/.test(a.id)) a.close(); }); } catch { /* closing */ }
    }
    console.log(JSON.stringify(out, null, 1));
    if (!out.ok) process.exitCode = 1;
    await browser.close();
  }
})();
