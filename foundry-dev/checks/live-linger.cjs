// Live check: finished game windows close by themselves (linger.js,
// VIB-206), at a real table with the branch's code on both ends.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/checks/live-linger.cjs [--shot out.png]
//
// Env: PLAYER (default Player2, must own Crate Tester), BOX (default "Live
// UI crate"). One purchase per run.
//
// Two headless clients, the Gamemaster and the player, each with the
// installed module's socket listener and chat-card hooks (the seal and
// Watch again) swapped for the branch's from MODULE_BASE, and the branch's
// stylesheet, as player-pull.cjs and live-well.cjs do. Then, as a person
// does:
//
//   1. The player sets "Close finished game windows" to "After 10 seconds"
//      in Game Settings: the sidebar's Settings tab, Game Settings, the
//      Loot Crates tab, the select, Save Changes.
//   2. The player opens the shop, clicks the crate's real Buy and moves the
//      pointer off to a corner. The reveal lands; the line reads "Closes
//      in 10 s" with Keep open, and the window closes by itself about 10 s
//      after the landing (closeMs, measured in the page from the frame the
//      card landed to the frame the window left: 9.5 to 11.5 s). Focus goes
//      back to the Buy, as a Close sends it.
//   3. The player clicks the new chat card's Watch again. The replay window
//      lands; the pointer is moved over it at once and held there past the
//      10 s: it stays open, its line reading "Paused, N s left". The
//      pointer leaves, and the window closes after the time it had left
//      when the pointer arrived (leaveToCloseMs, against expectMs: within
//      1.5 s of it, so about 10 s).
//   4. Watch again once more, and Keep open is clicked: the line goes, and
//      the window is still open 15 s after the pointer leaves. It is then
//      closed with its Close.
//
// Everything is put back in a finally: the purchase is refunded on the GM
// (refund.js, the Pull log's own path; the item this run granted goes with
// it), and the player's setting returns to what it was. Dice So Nice stays
// on. Needs "Crate Tester" in "Loot Crates Test" and "Live UI crate" (live-ui.js).
/* global game, Hooks -- used inside page.evaluate, which runs in the Foundry page */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const BOX = process.env.BOX || "Live UI crate";
const DELAY_S = 10;
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
    // The branch's settings: the installed release has no "Close finished
    // game windows", and registering again keeps the world's values.
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
    // The installed module's seal and Watch again would open its own
    // replay window, which has no countdown: the branch's in their place.
    for (const h of [...(Hooks.events?.renderChatMessageHTML ?? [])]) if (["sealChatCard", "watchAgain"].includes(h.fn?.name)) Hooks.off("renderChatMessageHTML", h.id);
    const { sealChatCard, watchAgain, preSealItem } = await import(base + "scripts/foundry/reveal.js");
    Hooks.on("renderChatMessageHTML", sealChatCard);
    Hooks.on("renderChatMessageHTML", watchAgain);
    for (const h of [...(Hooks.events?.createItem ?? [])]) if (h.fn?.name === "preSealItem") Hooks.off("createItem", h.id);
    Hooks.on("createItem", preSealItem);
    // Every reveal window this page shows: when its card landed and when
    // it left the page, read every 20 ms.
    globalThis.__lcWins = new Map();
    setInterval(() => {
      const now = Date.now();
      const here = new Set(document.querySelectorAll(".application.lc-reveal"));
      for (const el of here) {
        const w = globalThis.__lcWins.get(el.id) ?? globalThis.__lcWins.set(el.id, { id: el.id, title: el.querySelector(".window-title")?.textContent.trim() ?? "", el, seenAt: now, landedAt: null, goneAt: null }).get(el.id);
        if (w.el !== el) Object.assign(w, { el, seenAt: now, landedAt: null, goneAt: null });
        if (w.landedAt == null && el.querySelector(".lc-card--landed")) w.landedAt = now;
      }
      for (const w of globalThis.__lcWins.values()) if (w.goneAt == null && !here.has(w.el)) w.goneAt = now;
    }, 20);
  }, MODULE_BASE);
  return { page, logs };
}

// The windows as the page has seen them, by id.
const wins = page => page.evaluate(() => Object.fromEntries([...globalThis.__lcWins.values()].map(w => [w.id, { title: w.title, seenAt: w.seenAt, landedAt: w.landedAt, goneAt: w.goneAt }])));
const line = (page, id) => page.evaluate(id => {
  const el = document.getElementById(id);
  return el ? { open: true, text: el.querySelector(".lc-linger__text")?.textContent ?? null, keep: el.querySelector(".lc-linger__keep")?.textContent ?? null } : { open: false, text: null, keep: null };
}, id);
// A reveal window that opened at or after `since` (the page's clock) and
// whose card has landed. A replay's window keeps its id from one Watch
// again to the next, so the window is told by when it appeared.
const pageNow = page => page.evaluate(() => Date.now());
async function nextLanded(page, since, { timeout = 30000 } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const now = await wins(page);
    const fresh = Object.entries(now).find(([, w]) => w.seenAt >= since && w.landedAt != null && w.goneAt == null);
    if (fresh) return { id: fresh[0], ...fresh[1] };
    if (Date.now() > until) throw new Error("no reveal window landed");
    await page.waitForTimeout(100);
  }
}
async function waitGone(page, id, ms) {
  const until = Date.now() + ms;
  for (;;) {
    const w = (await wins(page))[id];
    if (w?.goneAt != null) return w;
    if (Date.now() > until) return w ?? null;
    await page.waitForTimeout(100);
  }
}
const corner = page => page.mouse.move(6, 600);

// 1. Game Settings, as a person sets it. Returns what it was.
async function setDelay(page, seconds) {
  await page.locator('#sidebar [data-tab="settings"]').first().click();
  await page.waitForTimeout(600);
  await page.locator('#settings button[data-app="configure"]').first().click();
  const app = page.locator("#settings-config");
  await app.waitFor({ timeout: 15000 });
  await app.locator('[data-tab="loot-crates"]').first().click();
  await page.waitForTimeout(300);
  const select = app.locator('select[name="loot-crates.closeFinished"]');
  const label = (await select.evaluate(el => el.closest(".form-group")?.querySelector("label")?.textContent.trim() ?? ""));
  const options = await select.evaluate(el => [...el.options].map(o => o.textContent.trim()));
  await select.selectOption(String(seconds));
  await app.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(800);
  return { label, options, now: await page.evaluate(() => game.settings.get("loot-crates", "closeFinished")) };
}

(async () => {
  const browser = await chromium.launch();
  const out = { player: PLAYER, box: BOX, gm: null };
  let gm = null, pl = null, oldDelay = null, rowId = null;
  try {
    pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");
    out.gm = "headless Gamemaster running the branch";
    out.seed = await gm.page.evaluate(async ({ base, box }) => {
      const store = await import(base + "scripts/foundry/store.js");
      const folder = game.folders.find(f => f.type === "Actor" && f.name === "Loot Crates Test");
      const actor = game.actors.find(a => a.name === "Crate Tester" && a.folder?.id === folder?.id);
      if (!actor) throw new Error("no Crate Tester in Loot Crates Test");
      const crate = Object.values(store.getBoxes()).find(b => b.name === box);
      if (!crate) throw new Error(`no ${box}: run live-ui.js first`);
      if ((actor.system.currency.gp ?? 0) < (crate.price ?? 0) + 5) await actor.update({ "system.currency.gp": 1000 });
      return { actorId: actor.id, boxId: crate.id, price: crate.price, gp: actor.system.currency.gp, dsn: !!game.modules.get("dice-so-nice")?.active };
    }, { base: MODULE_BASE, box: BOX });
    const page = pl.page;
    oldDelay = await page.evaluate(() => game.settings.get("loot-crates", "closeFinished"));

    // 1. The setting, through Game Settings.
    out.setting = { before: oldDelay, ...(await setDelay(page, DELAY_S)) };
    if (out.setting.now !== DELAY_S) throw new Error(`the setting reads ${out.setting.now} after Save Changes`);
    // Save Changes closes Game Settings; if it is still up, its own close.
    if (await page.locator("#settings-config").isVisible().catch(() => false)) await page.locator('#settings-config header [data-action="close"]').first().click().catch(() => {});

    // 2. One purchase through the shop's real Buy.
    await page.evaluate(async base => {
      const { openShop } = await import(base + "scripts/foundry/shop.js");
      openShop();
    }, MODULE_BASE);
    await page.waitForSelector(".application.lc-shop .lc-box", { timeout: 15000 });
    await page.waitForTimeout(1200);
    const actorId = out.seed.actorId;
    const pick = page.locator(".application.lc-shop .lc-shop__actor");
    if (await pick.count()) await pick.selectOption(actorId).catch(() => {});
    await page.waitForTimeout(600);
    const buy = page.locator(`.application.lc-shop .lc-box__buy[data-box="${out.seed.boxId}"]`);
    if (await buy.getAttribute("aria-disabled") === "true") throw new Error(`${BOX} can't be bought: ${await page.locator(`.application.lc-shop .lc-box[data-box="${out.seed.boxId}"] .lc-box__why`).textContent().catch(() => "")}`);
    const logBefore = await page.evaluate(async base => (await import(base + "scripts/foundry/store.js")).getLog().map(r => r.id), MODULE_BASE);
    const before = await pageNow(page);
    await buy.click();
    await corner(page);
    const pulled = await nextLanded(page, before);
    await page.waitForTimeout(300);
    const atLanding = await line(page, pulled.id);
    const focusAtLanding = await page.evaluate(() => document.activeElement?.matches?.(".lc-reveal__close") ? "Close" : document.activeElement?.className ?? "none");
    rowId = await page.evaluate(async ({ base, logBefore }) => (await import(base + "scripts/foundry/store.js")).getLog().find(r => !logBefore.includes(r.id))?.id ?? null, { base: MODULE_BASE, logBefore });
    const gone = await waitGone(page, pulled.id, (DELAY_S + 8) * 1000);
    await page.waitForTimeout(300);
    const focusAfterClose = await page.evaluate(id => document.activeElement?.matches?.(`.lc-box__buy[data-box="${id}"]`) ? "Buy" : document.activeElement?.className || document.activeElement?.tagName || "none", out.seed.boxId);
    const closeMs = gone?.goneAt != null ? gone.goneAt - gone.landedAt : null;
    out.purchase = { window: pulled.id, line: atLanding, focusAtLanding, closeMs, focusAfterClose, rowId, ok: atLanding.text === `Closes in ${DELAY_S} s` && atLanding.keep === "Keep open" && closeMs != null && closeMs >= DELAY_S * 1000 - 500 && closeMs <= DELAY_S * 1000 + 1500 && focusAfterClose === "Buy" };

    // 3. Watch again on the chat card; the pointer over the replay holds it.
    const msgId = await page.evaluate(id => game.messages.contents.filter(m => m.flags?.["loot-crates"]?.logId === id).at(-1)?.id ?? null, rowId);
    if (!msgId) throw new Error("no chat card for the purchase");
    const again = page.locator(`#chat .chat-log [data-message-id="${msgId}"] .lc-chat__replay`);
    if (!(await again.isVisible().catch(() => false))) {
      await page.locator('#sidebar [data-tab="chat"]').first().click().catch(() => {});
      await page.waitForTimeout(600);
    }
    await again.scrollIntoViewIfNeeded();
    const before2 = await pageNow(page);
    await again.click();
    const replay = await nextLanded(page, before2);
    const box = await page.locator(`#${replay.id}`).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 30);
    const overAt = await page.evaluate(() => Date.now());
    const expectMs = Math.max(0, DELAY_S * 1000 - (overAt - replay.landedAt));
    await page.waitForTimeout(DELAY_S * 1000 + 2500);
    const held = await line(page, replay.id);
    await corner(page);
    const leftAt = await page.evaluate(() => Date.now());
    const gone2 = await waitGone(page, replay.id, (DELAY_S + 8) * 1000);
    const leaveToCloseMs = gone2?.goneAt != null ? gone2.goneAt - leftAt : null;
    out.replay = { window: replay.id, title: replay.title, pointerOverAfterLandingMs: overAt - replay.landedAt, heldPastDelay: held, expectMs, leaveToCloseMs, ok: /^Replay: /.test(replay.title) && held.open && /^Paused, \d+ s left$/.test(held.text ?? "") && leaveToCloseMs != null && Math.abs(leaveToCloseMs - expectMs) <= 1500 };

    // 4. Watch again once more, and Keep open.
    await page.waitForTimeout(500);
    if (!(await again.isVisible().catch(() => false))) {
      await page.locator('#sidebar [data-tab="chat"]').first().click().catch(() => {});
      await page.waitForTimeout(600);
    }
    const before3 = await pageNow(page);
    await again.click();
    const kept = await nextLanded(page, before3);
    await page.locator(`#${kept.id} .lc-linger__keep`).click();
    await page.waitForTimeout(200);
    const afterKeep = await line(page, kept.id);
    await corner(page);
    await page.waitForTimeout(DELAY_S * 1000 + 5000);
    const still = await line(page, kept.id);
    if (shot) await page.screenshot({ path: shot });
    if (still.open) await page.locator(`#${kept.id} .lc-reveal__close`).click().catch(() => {});
    out.keep = { window: kept.id, afterKeep, stillOpenAfterMs: DELAY_S * 1000 + 5000, still, ok: afterKeep.open && afterKeep.text == null && still.open };

    out.ok = out.purchase.ok && out.replay.ok && out.keep.ok;
    if (!out.ok) process.exitCode = 1;
  } catch (err) {
    out.error = String(err?.stack || err);
    process.exitCode = 1;
  } finally {
    out.restore = {};
    try {
      if (gm && rowId) {
        out.restore.refund = await gm.page.evaluate(async ({ base, rowId }) => {
          const { refundPull } = await import(base + "scripts/foundry/refund.js");
          const store = await import(base + "scripts/foundry/store.js");
          if (store.getLog().find(r => r.id === rowId)?.refunded) return "already refunded";
          await refundPull(rowId);
          return store.getLog().find(r => r.id === rowId)?.refunded ? "refunded" : "not refunded";
        }, { base: MODULE_BASE, rowId });
      }
    } catch (err) { out.restore.refundError = String(err?.message || err); process.exitCode = 1; }
    try {
      if (pl && oldDelay != null) {
        out.restore.setting = await pl.page.evaluate(async v => { await game.settings.set("loot-crates", "closeFinished", v); return game.settings.get("loot-crates", "closeFinished"); }, oldDelay);
      }
    } catch (err) { out.restore.settingError = String(err?.message || err); }
    out.playerLog = pl?.logs.filter(l => /error|fail/i.test(l)) ?? [];
    out.gmLog = gm?.logs.filter(l => /error|fail/i.test(l)) ?? [];
    console.log(JSON.stringify(out, null, 1));
    await browser.close();
  }
})();
