// A real player purchase, timed, with the branch's code on both ends.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/headless/player-pull.cjs [--shot out.png]
//
// Env: PLAYER (default Player2, must own a character with coins), BOX (crate
// name, default "Live UI crate").
//
// Two headless clients: the Gamemaster (when that seat is free) and the
// player. In each, the installed Loot Crates' socket listener is removed and
// the branch's is registered from MODULE_BASE, so the pull runs the working
// copy, never the installed copy and never both (two listeners on one GM
// client would charge twice). If a person holds the Gamemaster seat, their
// client (running the installed module) does the pull and the result says so:
// timings then describe the installed code, not the branch.
//
// COUNT=n (1 to 3, default 1) buys n crates in a row in the same session;
// the first is the first purchase after a fresh GM page load, and the GM runs
// the branch's load-time sweep of every pool (main.js ready) just before it,
// so a pull that waits on that sweep shows. The GM's per-step timings
// (socket.js stepTimer, a console.debug line) are in gmTimings.
//
// Headless Chromium draws Foundry's canvas with SwiftShader (software), and
// on this VM every frame takes 0.5 to 1.4 s, so each await on either client
// waits that long behind it: a measure of the VM, not of the module (a GPU
// draws the same scene in milliseconds). Both clients' canvas ticker is
// paused unless CANVAS=on, which keeps it running to see the worst case.
//
// HIDE_GM=1 forces the headless GM page's document hidden (visibilityState
// and a visibilitychange event) before the purchase, as a GM with their
// Foundry tab in the background: the chat card must still reach the table
// (chatMs, from the click to the player's client seeing the ChatMessage), the
// GM's own reveal lands at once, and no toast fires on the GM unless the pull
// was slow (gmToasts lists every notification the GM's page raised).
//
// GM_LOG=1 opens the branch's manager on the headless GM's Pull log before
// the purchase and reports gmLog.rowMs: from the player's click to the new
// row standing in the GM's .lc-table (written by the GM's own pull, drawn by
// the settings' onChange; redraw.js), which must be within 2 s.
//
// CLOSE_SHOP=1 buys nothing: with the player's shop open, the GM clicks the
// manager's shop toggle (Shop open -> Shop closed) and closeShop reports how
// long the player's crate took to show it (Buy aria-disabled, the header
// notice naming the closed shop), within 2 s, then opens the shop again the
// same way and reports the Buy back on.
//
// focus follows the keyboard: the Buy is focused before it is pressed, and
// focusAfterCharge records where focus is once the GM's charge reached this
// client (updateActor re-renders the shop): it must still be that Buy (the
// shop keeps its nodes) or the reveal's Close. focusAtLanding and
// focusAfterClose: Close on landing, then back on the Buy when it closes.
//
// REPLAY=1, after the purchase: on the player's client, clicks "Watch
// again" on the new chat card in the chat log (a real mouse click; the chat
// tab is clicked open first if needed) and reports the replay: its window
// title ("Replay: ..."), the item and rarity it lands on against the card's
// result, no gold line and no Open item, that a second click brings the same
// window forward rather than opening another, and that the chat message
// count, the Pull log's rows, the character's purse and items are unchanged.
// Close is then clicked and focus must return to the Watch again button.
//
// chatRenders lists each rendering of the pull's chat card on the player's
// client and whether it was sealed (head and "Opening…", reveal.js
// sealChatCard): a card rendered while that client's spin plays must be, and
// chatSealedAfterLanding must be 0.
//
// Prints JSON: who did the pull, the purse before and
// after, the item granted, and timings from the click: reveal broadcast
// received, strip landed; plus the GM's `loot-crates |` console lines.
/* global game, foundry, Hooks, ui -- used inside page.evaluate, which runs in the Foundry page */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const BOX = process.env.BOX || "Live UI crate";
const CANVAS = process.env.CANVAS === "on";
const HIDE_GM = process.env.HIDE_GM === "1";
const COUNT = Math.min(3, Math.max(1, Number(process.env.COUNT) || 1));
const GM_LOG = process.env.GM_LOG === "1";
const CLOSE_SHOP = process.env.CLOSE_SHOP === "1";
const REPLAY = process.env.REPLAY === "1";
const shot = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : null;

async function join(browser, user, { readySweep = false } = {}) {
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
  // The branch's socket in place of the installed one.
  await page.evaluate(async ([base, readySweep, canvasOn]) => {
    if (!canvasOn) globalThis.canvas?.app?.ticker?.stop();
    game.socket.off("module.loot-crates");
    const store = await import(base + "scripts/store.js");
    try { store.registerSettings(); } catch { /* the installed module registered them */ }
    try { store.registerIndexFields?.(); } catch { /* already in CONFIG */ }
    const socket = await import(base + "scripts/socket.js");
    socket.registerSocket();
    // What main.js's init does: open windows redraw as the world settings
    // change. If the installed module registered the settings first and
    // Foundry kept its entries, point their onChange at the branch's too.
    const { storeRedraw } = await import(base + "scripts/redraw.js");
    const { refreshShop } = await import(base + "scripts/shop.js");
    const { refreshManager } = await import(base + "scripts/manager.js");
    const redraw = storeRedraw({ refreshShop, refreshManager });
    store.setStoreListener(redraw);
    for (const key of store.WORLD_KEYS) {
      const cfg = game.settings.settings.get(`loot-crates.${key}`);
      if (cfg && !String(cfg.onChange ?? "").includes("storeChanged")) cfg.onChange = () => redraw(key);
    }
    // What main.js does for chat: a pull's card stays sealed while it spins here.
    // And "Watch again" on a pull's card.
    const { sealChatCard, watchAgain } = await import(base + "scripts/reveal.js");
    Hooks.on("renderChatMessageHTML", sealChatCard);
    Hooks.on("renderChatMessageHTML", watchAgain);
    // What main.js's ready hook does on the active GM.
    if (readySweep && socket.isActiveGM()) store.sweepAllPools();
  }, [MODULE_BASE, readySweep, CANVAS]);
  return { page, logs };
}

/*
  The GM closes the shop from the manager's toggle while the player's shop is
  open; the player's crate must show it within 2 s without a press. Then the
  GM opens it again (always, even when the check fails).
*/
async function closeShopCheck(player, gm) {
  await player.evaluate(async ({ base, box }) => {
    const { openShop } = await import(base + "scripts/shop.js");
    const app = openShop();
    await new Promise(r => setTimeout(r, 1500));
    globalThis.__lcShop = () => {
      const card = [...app.element.querySelectorAll(".lc-box")].find(c => c.querySelector(".lc-box__name")?.textContent.trim() === box);
      const buy = card?.querySelector(".lc-box__buy");
      return { off: buy?.getAttribute("aria-disabled") === "true", notice: app.element.querySelector(".lc-shop__notice")?.textContent.trim() ?? "" };
    };
  }, { base: MODULE_BASE, box: BOX });
  const before = await player.evaluate(() => globalThis.__lcShop());
  if (before.off) throw new Error(`${BOX} can't be bought before the check: ${before.notice}`);
  await gm.evaluate(async base => {
    const { openManager } = await import(base + "scripts/manager.js");
    const app = openManager();
    await app.render({ force: true });
    await new Promise(r => setTimeout(r, 500));
    globalThis.__lcToggle = () => {
      const t = app.element.querySelector(".lc-shop-toggle");
      const at = Date.now();
      t.click();
      return { at, was: t.textContent.trim() };
    };
  }, MODULE_BASE);
  const until = (want, since) => player.evaluate(async ({ want, since }) => {
    for (let i = 0; i < 250; i++) {
      const s = globalThis.__lcShop();
      if (s.off === want) return { ...s, ms: Date.now() - since };
      await new Promise(r => setTimeout(r, 20));
    }
    return { ...globalThis.__lcShop(), ms: null };
  }, { want, since });
  const closed = await gm.evaluate(() => globalThis.__lcToggle());
  const closedSeen = await until(true, closed.at);
  // Open it again however the first half went.
  let openedSeen = null;
  const isOpen = () => gm.evaluate(() => game.settings.get("loot-crates", "shopOpen"));
  if (!(await isOpen())) {
    const opened = await gm.evaluate(() => globalThis.__lcToggle());
    openedSeen = await until(false, opened.at);
  }
  const ok = closed.was === "Shop open" && closedSeen.ms != null && closedSeen.ms <= 2000 && /closed/i.test(closedSeen.notice)
    && openedSeen?.ms != null && openedSeen.ms <= 2000 && (await isOpen());
  return { before, toggled: closed.was, closed: closedSeen, reopened: openedSeen, shopOpenAtEnd: await isOpen(), ok };
}

/*
  Watch again, driven as a person does: click the button on the newest pull
  card in the chat log, watch the replay land, click it again, click Close.
*/
async function replayCheck(page) {
  const facts = () => page.evaluate(async base => {
    const { getLog } = await import(base + "scripts/store.js");
    const actor = game.actors.find(a => a.isOwner && a.type === "character");
    const msg = game.messages.contents.filter(m => m.flags?.["loot-crates"]?.logId).at(-1);
    return {
      messages: game.messages.size, logRows: getLog().length,
      purse: JSON.stringify(actor.system.currency), items: actor.items.size,
      messageId: msg?.id ?? null, stored: msg?.flags["loot-crates"].replay?.result ?? null,
      replayBytes: msg?.flags["loot-crates"].replay ? JSON.stringify(msg.flags["loot-crates"].replay).length : 0,
      windows: document.querySelectorAll(".lc-reveal").length,
    };
  }, MODULE_BASE);
  const before = await facts();
  if (!before.messageId || !before.stored) return { ok: false, error: "the newest pull card has no replay snapshot", before };
  const btn = page.locator(`#chat .chat-log [data-message-id="${before.messageId}"] .lc-chat__replay`);
  if (!(await btn.isVisible())) await page.locator('#sidebar [data-tab="chat"]').first().click().catch(() => {});
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  await page.waitForSelector(".application.lc-reveal .lc-card--landed", { timeout: 15000 });
  const seen = await page.evaluate(() => {
    const el = [...document.querySelectorAll(".application.lc-reveal")].find(a => /^Replay:/.test(a.querySelector(".window-title")?.textContent.trim() ?? ""));
    if (!el) return null;
    const shown = n => !!n && !n.hidden && n.getBoundingClientRect().height > 0;
    const landed = el.querySelector(".lc-card--landed");
    return {
      id: el.id, title: el.querySelector(".window-title").textContent.trim(),
      landedName: landed?.querySelector(".lc-card__name")?.textContent, landedRarity: landed?.dataset.rarity,
      result: el.querySelector(".lc-reveal__result")?.innerText ?? "",
      gold: /\d [gsc]p left/.test(el.querySelector(".lc-reveal__result")?.innerText ?? ""),
      openItem: shown(el.querySelector(".lc-reveal__open")),
      button: el.querySelector(".lc-reveal__close")?.textContent.trim(),
    };
  });
  // A second press: the same window, brought forward.
  await btn.click();
  await page.waitForTimeout(600);
  const replayWindows = await page.evaluate(() => [...document.querySelectorAll(".application.lc-reveal")].filter(a => /^Replay:/.test(a.querySelector(".window-title")?.textContent.trim() ?? "")).length);
  await page.waitForTimeout(800);
  const after = await facts();
  // Close as a person would; focus should be back on Watch again.
  await page.locator(`#${seen?.id} .lc-reveal__close`).click();
  await page.waitForTimeout(800);
  const focusBack = await page.evaluate(id => document.activeElement?.matches?.(`[data-message-id="${id}"] .lc-chat__replay`) ?? false, before.messageId);
  const unchanged = ["messages", "logRows", "purse", "items"].every(k => before[k] === after[k]);
  const ok = !!seen && /^Replay: .+ opens .+/.test(seen.title) && seen.landedName === before.stored.name && seen.landedRarity === before.stored.rarity
    && !seen.gold && !seen.openItem && seen.button === "Close" && replayWindows === 1 && unchanged;
  return { ok, seen, stored: before.stored, replayBytes: before.replayBytes, replayWindows, unchanged, before, after, focusBack };
}

(async () => {
  const browser = await chromium.launch();
  const out = { gm: null, player: PLAYER, box: BOX, canvas: CANVAS ? "running (software)" : "paused" };
  try {
    // The player first, so the GM's page load (and its load-time sweep) is
    // as fresh as it can be when the first crate is bought.
    const pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    const gm = await join(browser, "Gamemaster", { readySweep: true });
    out.gm = gm ? "headless Gamemaster running the branch" : "a person's Gamemaster client running the installed module";
    if (HIDE_GM) {
      if (!gm) throw new Error("HIDE_GM needs the headless Gamemaster");
      out.gmHidden = await gm.page.evaluate(() => {
        globalThis.__lcToasts = [];
        for (const kind of ["info", "warn", "error"]) {
          const orig = ui.notifications[kind].bind(ui.notifications);
          ui.notifications[kind] = (msg, opts) => { globalThis.__lcToasts.push({ kind, msg: String(msg), permanent: !!opts?.permanent }); return orig(msg, opts); };
        }
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
        document.dispatchEvent(new Event("visibilitychange"));
        return document.visibilityState;
      });
    }
    if (CLOSE_SHOP) {
      if (!gm) throw new Error("CLOSE_SHOP needs the headless Gamemaster");
      out.closeShop = await closeShopCheck(pl.page, gm.page);
      console.log(JSON.stringify(out, null, 1));
      if (!out.closeShop.ok) process.exitCode = 1;
      return;
    }
    if (GM_LOG) {
      if (!gm) throw new Error("GM_LOG needs the headless Gamemaster");
      await gm.page.evaluate(async base => {
        const { openManager } = await import(base + "scripts/manager.js");
        const app = openManager();
        app.tab = "log";
        await app.render({ force: true });
        await new Promise(r => setTimeout(r, 500));
        const rows = () => app.element?.querySelectorAll(".lc-table tbody tr").length ?? 0;
        const first = () => app.element?.querySelector(".lc-table tbody tr")?.innerText ?? null;
        globalThis.__lcLog = { before: rows(), firstBefore: first(), at: null, renders: 0 };
        const watch = setInterval(() => {
          if (globalThis.__lcLog.at == null && rows() > globalThis.__lcLog.before) {
            globalThis.__lcLog.at = Date.now();
            globalThis.__lcLog.firstAfter = first();
            globalThis.__lcLog.tab = app.tab;
          }
        }, 20);
        setTimeout(() => clearInterval(watch), 60000);
      }, MODULE_BASE);
    }
    const result = await pl.page.evaluate(async ({ base, box, count }) => {
      const { openShop } = await import(base + "scripts/shop.js");
      const actor = game.actors.find(a => a.isOwner && a.type === "character");
      if (!actor) throw new Error(`${game.user.name} owns no character`);
      const before = foundry.utils.deepClone(actor.system.currency);
      const app = openShop();
      await new Promise(r => setTimeout(r, 1500));
      const pick = app.element.querySelector(".lc-shop__actor");
      if (pick && pick.value !== actor.id) { pick.value = actor.id; pick.dispatchEvent(new Event("change")); await new Promise(r => setTimeout(r, 800)); }
      const purchases = [];
      // When the table's client sees each Loot Crates chat card.
      const cards = [];
      Hooks.on("createChatMessage", m => { if (m.flags?.["loot-crates"] && !m.flags["loot-crates"].refunded) cards.push(performance.now()); });
      // Whether each rendering of a card showed its item (it should not
      // while this client's spin plays).
      const renders = [];
      Hooks.on("renderChatMessageHTML", (m, html) => {
        if (!m.flags?.["loot-crates"]?.logId) return;
        const card = html.querySelector(".lc-chat");
        renders.push({ ms: performance.now(), sealed: !!card?.classList.contains("lc-chat--sealed") });
      });
      for (let n = 0; n < count; n++) {
        const card = [...app.element.querySelectorAll(".lc-box")].find(c => c.querySelector(".lc-box__name")?.textContent.trim() === box);
        if (!card) throw new Error(`no crate named ${box}`);
        const buy = card.querySelector(".lc-box__buy");
        if (buy.getAttribute("aria-disabled") === "true") throw new Error(`${box} can't be bought: ${card.querySelector(".lc-box__why")?.textContent}`);
        const seen = new Set([...document.querySelectorAll(".lc-reveal")]);
        const labels = [];
        const where = () => {
          const el = document.activeElement;
          if (el === buy) return "Buy";
          if (el?.matches?.(".lc-reveal__close")) return "reveal Close";
          return el ? `${el.tagName}${el.className ? "." + String(el.className).split(" ")[0] : ""}` : "none";
        };
        let charged = null;
        const onCharge = Hooks.on("updateActor", (a, change) => {
          if (a === actor && change.system?.currency) setTimeout(() => { charged ??= where(); }, 100);
        });
        buy.focus();
        const t0 = performance.now();
        const clickedAt = Date.now();
        buy.click();
        let revealAt = null, landedAt = null, rv = null;
        const stillBuy = () => app.element.querySelector(`.lc-box__buy[data-box="${buy.dataset.box}"]`) === buy;
        for (let i = 0; i < 400 && landedAt == null; i++) {
          await new Promise(r => setTimeout(r, 50));
          const label = app.element.querySelector(`.lc-box__buy[data-box="${card.querySelector(".lc-box__buy").dataset.box}"]`)?.textContent.trim();
          if (label && labels.at(-1)?.text !== label) labels.push({ text: label, ms: Math.round(performance.now() - t0) });
          rv ??= [...document.querySelectorAll(".lc-reveal")].find(el => !seen.has(el)) ?? null;
          if (rv && revealAt == null) revealAt = performance.now() - t0;
          if (rv?.querySelector(".lc-card--landed")) landedAt = performance.now() - t0;
        }
        await new Promise(r => setTimeout(r, 1200));
        Hooks.off("updateActor", onCharge);
        const focusAtLanding = where();
        const sameBuyNode = stillBuy();
        // Close the reveal as the buyer would, and see where focus goes.
        const revealApp = [...foundry.applications.instances.values()].find(a => a.element === rv);
        if (revealApp) { await revealApp.close(); await new Promise(r => setTimeout(r, 400)); }
        const focusAfterClose = where();
        const chatAt = cards.find(t => t >= t0);
        const shown = renders.filter(r => r.ms >= t0).map(r => ({ ms: Math.round(r.ms - t0), sealed: r.sealed }));
        purchases.push({
          clickedAt,
          ms: { revealReceived: revealAt && Math.round(revealAt), landed: landedAt && Math.round(landedAt), chat: chatAt != null ? Math.round(chatAt - t0) : null },
          chatRenders: shown,
          chatSealedAfterLanding: document.querySelectorAll(".lc-chat--sealed").length,
          buyLabels: labels,
          focus: { afterCharge: charged, atLanding: focusAtLanding, afterClose: focusAfterClose, sameBuyNode, ok: ["Buy", "reveal Close"].includes(charged) && focusAtLanding === "reveal Close" && focusAfterClose === "Buy" && sameBuyNode },
          result: rv?.querySelector(".lc-reveal__result")?.innerText,
        });
      }
      const granted = actor.items.filter(i => (i.flags?.["loot-crates"]?.at ?? 0) > Date.now() - 120000).map(i => i.name);
      return { actor: actor.name, before, after: actor.system.currency, granted, purchases };
    }, { base: MODULE_BASE, box: BOX, count: COUNT });
    Object.assign(out, result);
    if (REPLAY) out.replay = await replayCheck(pl.page);
    if (GM_LOG) {
      const seen = await gm.page.evaluate(() => globalThis.__lcLog);
      const rowMs = seen.at != null ? seen.at - out.purchases[0].clickedAt : null;
      out.gmLog = { ...seen, rowMs, ok: rowMs != null && rowMs <= 2000 };
    }
    if (shot) await pl.page.screenshot({ path: shot });
    if (HIDE_GM) {
      out.gmSide = await gm.page.evaluate(() => {
        const rv = [...document.querySelectorAll(".lc-reveal")].at(-1);
        return {
          visibilityState: document.visibilityState,
          revealLanded: !!rv?.querySelector(".lc-card--landed"),
          revealButton: rv?.querySelector(".lc-reveal__close")?.textContent.trim() ?? null,
          toasts: globalThis.__lcToasts,
        };
      });
    }
    out.gmTimings = (gm?.logs ?? []).filter(l => l.includes("timings"));
    out.gmConsole = (gm?.logs ?? []).filter(l => !l.includes("timings"));
    out.playerLog = pl.logs;
    console.log(JSON.stringify(out, null, 1));
  } catch (err) {
    out.error = String(err?.stack || err);
    console.log(JSON.stringify(out, null, 1));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
