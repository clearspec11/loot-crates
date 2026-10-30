// Live check: the editors in the order a GM plans a game, and short (views/editors.js, poolpicker.js), with the branch's code on the GM's client.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/checks/live-editor-order.cjs [--shot out.png]
//   (or: npm run live -- live-editor-order)
//
// One headless Gamemaster running the branch's code (as live-new-game.cjs
// does). Everything is pressed and typed as a GM does it:
//
//   0. Each New on the Boxes tab is opened and its content's height read
//      at 1440x900 (the dialog's scroll box), then Cancel: nothing written.
//   1. On the Pools tab, "New crate from this pool" on Live UI pool: the
//      dialog's first pool row is Live UI pool, ticked, the world's other
//      pools folded under "Add a pool (N more)", the price focused after
//      the pools and the odds. Type "9 gp" and press Add to shelf: one
//      box, drawing from that pool alone.
//   2. New scratch ticket: the pools sit right above the prizes and Fill.
//      Click "Add a pool", type "Live UI" in its search, tick Live UI pool
//      (the only match), open Fill the prize list (its Fill and Shuffle
//      clear of the pinned readout) and press Fill, Yes to the confirm:
//      the first new prize row has focus and is in view above the readout.
//      Cancel, then Discard: nothing written.
//   3. New auction: type part of an item's name from Live UI pool in the
//      lot search and press Enter: that item is the lot and the line under
//      the list says so; the list shows only matches, under their pools.
//      Cancel, then Discard: nothing written.
//
// Deleted in a finally: only the box this run added; every dialog closed.
// No purchase. Needs "Live UI pool" (live-ui.js).
/* global game, Hooks, foundry, __lc */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
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
  }, MODULE_BASE);
  return { page, logs };
}

const HELPERS = `
  globalThis.__lc = globalThis.__lc ?? {};
  __lc.wait = ms => new Promise(r => setTimeout(r, ms));
  __lc.until = async (fn, ms = 15000) => { for (let t = 0; t < ms && !fn(); t += 50) await __lc.wait(50); return fn(); };
  __lc.click = el => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
  __lc.dialog = () => [...document.querySelectorAll(".application.lc-dialog")].pop() ?? null;
  // A rect inside the dialog's scroll box and above its pinned readout.
  __lc.inView = el => {
    const d = __lc.dialog(); const box = d?.querySelector(".dialog-content")?.getBoundingClientRect(); const r = el?.getBoundingClientRect();
    const odds = d?.querySelector(".lc-form__odds")?.getBoundingClientRect();
    if (!box || !r || !r.height) return false;
    const floor = odds && odds.top < box.bottom && odds.bottom > box.top ? Math.min(box.bottom, odds.top) : box.bottom;
    return r.top >= box.top - 1 && r.bottom <= floor + 1;
  };
`;

(async () => {
  const browser = await chromium.launch();
  const out = { created: [] };
  let gm = null;
  try {
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");
    const page = gm.page;
    out.before = await page.evaluate(async ({ base, helpers }) => {
      (0, eval)(helpers);
      const store = await import(base + "scripts/foundry/store.js");
      const pool = Object.values(store.getPools()).find(p => p.name === "Live UI pool");
      if (!pool) throw new Error("no Live UI pool: run live-ui.js first");
      const item = (pool.entries ?? []).find(e => !e.missing && e.name);
      const { openManager } = await import(base + "scripts/foundry/manager.js");
      __lc.app = openManager();
      await __lc.until(() => __lc.app.element?.querySelector('.lc-tabs [data-tab="boxes"]'));
      __lc.click(__lc.app.element.querySelector('.lc-tabs [data-tab="boxes"]'));
      await __lc.until(() => __lc.app.tab === "boxes" && __lc.app.element.querySelector('[data-action="addScratch"]'), 8000);
      return { boxIds: Object.keys(store.getBoxes()), poolId: pool.id, pools: Object.keys(store.getPools()).length, item: item?.name ?? null, shopOpen: store.isShopOpen() };
    }, { base: MODULE_BASE, helpers: HELPERS });
    const dlg = () => page.locator(".application.lc-dialog").last();
    const discard = async () => {
      await dlg().locator('button[data-action="cancel"]').click();
      const q = page.locator(".application.dialog:not(.lc-dialog)").filter({ hasText: "Discard changes?" }).last();
      if (await q.waitFor({ timeout: 2500 }).then(() => true).catch(() => false)) await q.locator('button[data-action="yes"]').click();
      await page.waitForFunction(() => !__lc.dialog(), null, { timeout: 5000 });
    };
    const boxes = () => page.evaluate(async base => Object.keys((await import(base + "scripts/foundry/store.js")).getBoxes()).length, MODULE_BASE);

    // 0. Every New's height at 1440x900, closed again with nothing typed.
    out.heights = {};
    for (const [kind, action] of [["crate", "addBox"], ["scratch", "addScratch"], ["well", "addWell"], ["dice", "addDice"], ["deck", "addDeck"], ["wheel", "addWheel"], ["auction", "addAuction"]]) {
      await page.locator(`#loot-crates-manager [data-action="${action}"]`).click();
      await dlg().locator('input[name="name"]').waitFor({ timeout: 8000 });
      await page.waitForTimeout(400);
      out.heights[kind] = await page.evaluate(() => { const c = __lc.dialog().querySelector(".dialog-content"); return { content: c.scrollHeight, view: c.clientHeight, width: Math.round(__lc.dialog().getBoundingClientRect().width) }; });
      await discard();
    }
    out.wroteNothing = (await boxes()) === out.before.boxIds.length;

    // 1. New crate from this pool, on the Pools tab.
    out.fromPool = await page.evaluate(async ({ poolId }) => {
      __lc.click(__lc.app.element.querySelector('.lc-tabs [data-tab="pools"]'));
      await __lc.until(() => __lc.app.tab === "pools" && __lc.app.element.querySelector(`.lc-pool__details[data-pool="${poolId}"]`), 8000);
      const details = __lc.app.element.querySelector(`.lc-pool__details[data-pool="${poolId}"]`);
      if (!details.open) { __lc.click(details.querySelector("summary")); await __lc.until(() => details.open, 3000); }
      await __lc.until(() => __lc.app.element.querySelector(`[data-action="crateFromPool"][data-pool="${poolId}"]`), 3000);
      return true;
    }, { poolId: out.before.poolId });
    await page.locator(`#loot-crates-manager [data-action="crateFromPool"][data-pool="${out.before.poolId}"]`).click();
    await dlg().locator('input[name="price"]').waitFor({ timeout: 8000 });
    await page.waitForTimeout(400);
    out.fromPool = await page.evaluate(({ poolId }) => {
      const d = __lc.dialog();
      const first = d.querySelector(".lc-pool-pick");
      const order = [...d.querySelectorAll("[data-section]")].map(el => el.dataset.section);
      const c = d.querySelector(".dialog-content");
      return {
        firstPool: first?.querySelector('input[type="checkbox"]')?.name, firstTicked: !!first?.querySelector('input[type="checkbox"]')?.checked,
        mix: first?.querySelector(".lc-pool-pick__mix")?.textContent ?? null,
        fold: d.querySelector("[data-picker-add]")?.textContent.trim() ?? null,
        foldClosed: !d.querySelector(".lc-pool-picker__more")?.open,
        ticked: [...d.querySelectorAll('input[name^="pool."]')].filter(i => i.checked).map(i => i.name.slice(5)),
        priceFocused: document.activeElement === d.querySelector('input[name="price"]'),
        order, poolsBeforePrice: order.indexOf("pools") < order.indexOf("price"),
        height: { content: c.scrollHeight, view: c.clientHeight }, poolId,
      };
    }, { poolId: out.before.poolId });
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("9 gp");
    await dlg().locator('button[data-action="ok"]').click();
    out.fromPool.saved = await page.evaluate(async ({ base, known }) => {
      const store = await import(base + "scripts/foundry/store.js");
      const fresh = () => Object.values(store.getBoxes()).filter(b => !known.includes(b.id));
      await __lc.until(() => fresh().length && !__lc.dialog(), 8000);
      return fresh().map(b => ({ id: b.id, name: b.name, price: b.price, pools: b.pools }));
    }, { base: MODULE_BASE, known: out.before.boxIds });
    out.created.push(...out.fromPool.saved.map(b => b.id));

    // 2. New scratch ticket: a pool ticked right above Fill, Fill, the new rows in view.
    await page.evaluate(async () => {
      __lc.click(__lc.app.element.querySelector('.lc-tabs [data-tab="boxes"]'));
      await __lc.until(() => __lc.app.tab === "boxes" && __lc.app.element.querySelector('[data-action="addScratch"]'), 8000);
    });
    await page.locator('#loot-crates-manager [data-action="addScratch"]').click();
    await dlg().locator('input[name="name"]').waitFor({ timeout: 8000 });
    await page.waitForTimeout(300);
    out.scratch = { layout: await page.evaluate(() => {
      const d = __lc.dialog();
      const pools = d.querySelector('[data-section="pools"]');
      return { next: pools?.nextElementSibling?.dataset.section ?? null, fillNext: pools?.nextElementSibling?.querySelector(".lc-fill") != null };
    }) };
    await dlg().locator(".lc-pool-picker__add").click();
    await dlg().locator(".lc-pool-picker__search").waitFor({ state: "visible", timeout: 3000 });
    out.scratch.searchFocused = await page.waitForFunction(() => document.activeElement?.classList.contains("lc-pool-picker__search"), null, { timeout: 2000 }).then(() => true).catch(() => false);
    await page.keyboard.type("Live UI");
    await page.waitForTimeout(200);
    out.scratch.matches = await page.evaluate(() => [...__lc.dialog().querySelectorAll(".lc-pool-picker__rest .lc-pool-pick")].filter(r => r.checkVisibility()).map(r => r.dataset.poolName));
    out.scratch.count = (await dlg().locator(".lc-pool-picker__count").textContent()).trim();
    await dlg().locator(`input[name="pool.${out.before.poolId}"]`).check();
    await dlg().locator(".lc-fill__toggle").click();
    await page.waitForTimeout(300);
    out.scratch.fillButtons = await page.evaluate(() => ({ fill: __lc.inView(__lc.dialog().querySelector(".lc-fill__fill")), shuffle: __lc.inView(__lc.dialog().querySelector(".lc-fill__shuffle")) }));
    await dlg().locator(".lc-fill__fill").click();
    const confirm = page.locator(".application.dialog").filter({ hasText: "Replace the" }).last();
    if (await confirm.waitFor({ timeout: 4000 }).then(() => true).catch(() => false)) await confirm.locator('button[data-action="yes"]').click();
    await page.waitForFunction(() => /prizes filled in/.test(__lc.dialog()?.querySelector(".lc-fill__said")?.textContent ?? ""), null, { timeout: 8000 });
    await page.waitForTimeout(300);
    out.scratch.filled = await page.evaluate(() => {
      const d = __lc.dialog();
      const first = d.querySelector(".lc-prizes__rows .lc-prize-row");
      return { rows: d.querySelectorAll(".lc-prizes__rows .lc-prize-row").length, firstFocused: first?.contains(document.activeElement) ?? false, firstInView: __lc.inView(first), saidInView: __lc.inView(d.querySelector(".lc-fill__said")) };
    });
    if (shot) await page.screenshot({ path: shot });
    await discard();

    // 3. New auction: a lot found by typing in the search.
    await page.locator('#loot-crates-manager [data-action="addAuction"]').click();
    await dlg().locator(".lc-auction-lot__search").waitFor({ timeout: 8000 });
    const word = (out.before.item ?? "").split(/\s+/).find(w => w.length >= 4) ?? out.before.item ?? "";
    await dlg().locator(".lc-auction-lot__search").click();
    await page.keyboard.type(word);
    await page.waitForTimeout(300);
    out.auction = await page.evaluate(() => {
      const d = __lc.dialog();
      const pick = d.querySelector(".lc-auction-lot__pick");
      const shown = [...pick.querySelectorAll("optgroup option")].filter(o => !o.hidden && !o.parentNode.hidden);
      return { word: d.querySelector(".lc-auction-lot__search").value, shown: shown.length, all: pick.querySelectorAll("optgroup option").length, groups: [...pick.querySelectorAll("optgroup")].filter(g => !g.hidden).map(g => g.label), count: d.querySelector(".lc-auction-lot__count")?.textContent };
    });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    out.auction.picked = await page.evaluate(() => {
      const d = __lc.dialog();
      const pick = d.querySelector(".lc-auction-lot__pick");
      return { value: pick.value, text: pick.selectedOptions[0]?.textContent ?? null, said: d.querySelector("[data-lot-said]")?.textContent ?? null, open: !!d, preview: d.querySelector(".lc-form__preview")?.textContent.trim().slice(0, 80) };
    });
    await discard();
    out.wroteNothingAfter = (await boxes()) === out.before.boxIds.length + out.created.length;

    const f = out.fromPool, s = out.scratch, a = out.auction;
    out.checks = {
      fromPoolFirst: f.firstPool === `pool.${out.before.poolId}` && f.firstTicked && JSON.stringify(f.ticked) === JSON.stringify([out.before.poolId]) && /\d+ (common|uncommon|rare|very rare|legendary|artifact)/.test(f.mix ?? ""),
      fromPoolFolded: f.foldClosed && f.fold === `Add a pool (${out.before.pools - 1} more)` && f.poolsBeforePrice && f.priceFocused,
      fromPoolAdded: f.saved.length === 1 && f.saved[0].price === 9 && JSON.stringify(f.saved[0].pools) === JSON.stringify([{ id: out.before.poolId, share: 1 }]),
      scratchPoolsAboveFill: s.layout.next === "prizes" && s.layout.fillNext && s.searchFocused && s.matches.length >= 1 && s.matches.includes("live ui pool"),
      fillClearOfReadout: s.fillButtons.fill && s.fillButtons.shuffle,
      filledInView: s.filled.rows >= 3 && s.filled.firstFocused && s.filled.firstInView,
      lotSearched: a.shown >= 1 && a.shown < a.all && a.word.length > 0 && new RegExp(a.word, "i").test(a.picked.text ?? "") && a.picked.value.startsWith("item:") && /is the lot\.$/.test(a.picked.said ?? ""),
      nothingElseWritten: out.wroteNothing && out.wroteNothingAfter,
    };
    out.ok = Object.values(out.checks).every(Boolean);
    out.gmConsole = gm.logs;
  } catch (err) {
    out.error = String(err?.stack || err);
    out.ok = false;
  } finally {
    try {
      out.deleted = gm ? await gm.page.evaluate(async ({ base, ids }) => {
        const store = await import(base + "scripts/foundry/store.js");
        const gone = [];
        for (const id of ids) if (store.getBoxes()[id]) { await store.removeBox(id); gone.push(id); }
        // An editor left open by a failure closes without its question (as Save does).
        for (const a of [...foundry.applications.instances.values()]) if (a.element?.classList.contains("lc-dialog") || (a.element?.classList.contains("dialog") && /Discard|Replace/.test(a.element.textContent))) { try { await a.close({ submitted: true }); } catch { /* closed */ } }
        try { await globalThis.__lc?.app?.close(); } catch { /* closed */ }
        return gone;
      }, { base: MODULE_BASE, ids: out.created }) : [];
    } catch (err) { out.deleted = { error: String(err) }; out.ok = false; }
    console.log(JSON.stringify(out, null, 1));
    if (!out.ok) process.exitCode = 1;
    await browser.close();
  }
})();
