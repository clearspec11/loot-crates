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
// One purchase per run. Prints JSON: who did the pull, the purse before and
// after, the item granted, and timings from the click: reveal broadcast
// received, strip landed; plus the GM's `loot-crates |` console lines.
/* global game, foundry -- used inside page.evaluate, which runs in the Foundry page */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const BOX = process.env.BOX || "Live UI crate";
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
  // The branch's socket in place of the installed one.
  await page.evaluate(async base => {
    game.socket.off("module.loot-crates");
    const store = await import(base + "scripts/store.js");
    try { store.registerSettings(); } catch { /* the installed module registered them */ }
    try { store.registerIndexFields?.(); } catch { /* already in CONFIG */ }
    (await import(base + "scripts/socket.js")).registerSocket();
  }, MODULE_BASE);
  return { page, logs };
}

(async () => {
  const browser = await chromium.launch();
  const out = { gm: null, player: PLAYER, box: BOX };
  try {
    const gm = await join(browser, "Gamemaster");
    out.gm = gm ? "headless Gamemaster running the branch" : "a person's Gamemaster client running the installed module";
    const pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    const result = await pl.page.evaluate(async ({ base, box }) => {
      const { openShop } = await import(base + "scripts/shop.js");
      const actor = game.actors.find(a => a.isOwner && a.type === "character");
      if (!actor) throw new Error(`${game.user.name} owns no character`);
      const before = foundry.utils.deepClone(actor.system.currency);
      const app = openShop();
      await new Promise(r => setTimeout(r, 1500));
      const pick = app.element.querySelector(".lc-shop__actor");
      if (pick && pick.value !== actor.id) { pick.value = actor.id; pick.dispatchEvent(new Event("change")); await new Promise(r => setTimeout(r, 800)); }
      const card = [...app.element.querySelectorAll(".lc-box")].find(c => c.querySelector(".lc-box__name")?.textContent.trim() === box);
      if (!card) throw new Error(`no crate named ${box}`);
      const buy = card.querySelector(".lc-box__buy");
      if (buy.disabled) throw new Error(`${box} can't be bought: ${card.querySelector(".lc-box__why")?.textContent}`);
      const t0 = performance.now();
      buy.click();
      let revealAt = null, landedAt = null;
      for (let i = 0; i < 240 && landedAt == null; i++) {
        await new Promise(r => setTimeout(r, 125));
        const rv = document.querySelector(".lc-reveal");
        if (rv && revealAt == null) revealAt = performance.now() - t0;
        if (rv?.querySelector(".lc-card--landed")) landedAt = performance.now() - t0;
      }
      await new Promise(r => setTimeout(r, 1200));
      const granted = actor.items.filter(i => (i.flags?.["loot-crates"]?.at ?? 0) > Date.now() - 60000).map(i => i.name);
      return {
        actor: actor.name, before, after: actor.system.currency, granted,
        ms: { revealReceived: revealAt && Math.round(revealAt), landed: landedAt && Math.round(landedAt) },
        result: document.querySelector(".lc-reveal .lc-reveal__result")?.innerText,
      };
    }, { base: MODULE_BASE, box: BOX });
    Object.assign(out, result);
    if (shot) await pl.page.screenshot({ path: shot });
    out.gmLog = gm?.logs ?? [];
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
