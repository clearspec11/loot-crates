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
    // What main.js does for chat: a pull's card stays sealed while it spins here.
    const { sealChatCard } = await import(base + "scripts/reveal.js");
    Hooks.on("renderChatMessageHTML", sealChatCard);
    // What main.js's ready hook does on the active GM.
    if (readySweep && socket.isActiveGM()) store.sweepAllPools();
  }, [MODULE_BASE, readySweep, CANVAS]);
  return { page, logs };
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
        if (buy.disabled) throw new Error(`${box} can't be bought: ${card.querySelector(".lc-box__why")?.textContent}`);
        const seen = new Set([...document.querySelectorAll(".lc-reveal")]);
        const labels = [];
        const t0 = performance.now();
        buy.click();
        let revealAt = null, landedAt = null, rv = null;
        for (let i = 0; i < 400 && landedAt == null; i++) {
          await new Promise(r => setTimeout(r, 50));
          const label = app.element.querySelector(`.lc-box__buy[data-box="${card.querySelector(".lc-box__buy").dataset.box}"]`)?.textContent.trim();
          if (label && labels.at(-1)?.text !== label) labels.push({ text: label, ms: Math.round(performance.now() - t0) });
          rv ??= [...document.querySelectorAll(".lc-reveal")].find(el => !seen.has(el)) ?? null;
          if (rv && revealAt == null) revealAt = performance.now() - t0;
          if (rv?.querySelector(".lc-card--landed")) landedAt = performance.now() - t0;
        }
        await new Promise(r => setTimeout(r, 1200));
        const chatAt = cards.find(t => t >= t0);
        const shown = renders.filter(r => r.ms >= t0).map(r => ({ ms: Math.round(r.ms - t0), sealed: r.sealed }));
        purchases.push({
          ms: { revealReceived: revealAt && Math.round(revealAt), landed: landedAt && Math.round(landedAt), chat: chatAt != null ? Math.round(chatAt - t0) : null },
          chatRenders: shown,
          chatSealedAfterLanding: document.querySelectorAll(".lc-chat--sealed").length,
          buyLabels: labels,
          result: rv?.querySelector(".lc-reveal__result")?.innerText,
        });
      }
      const granted = actor.items.filter(i => (i.flags?.["loot-crates"]?.at ?? 0) > Date.now() - 120000).map(i => i.name);
      return { actor: actor.name, before, after: actor.system.currency, granted, purchases };
    }, { base: MODULE_BASE, box: BOX, count: COUNT });
    Object.assign(out, result);
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
    out.gmLog = (gm?.logs ?? []).filter(l => !l.includes("timings"));
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
