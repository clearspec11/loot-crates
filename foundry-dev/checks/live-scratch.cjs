// Live check: the scratch itself (scratch.js mountScratch, foil.js) at a
// real table, with the branch's code on both ends: the buyer scratches the
// ticket by hand with real pointer strokes, the GM's window scratches
// itself, and Watch again replays it.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/checks/live-scratch.cjs [--shot out.png] [--before out.png]
//
// --shot saves the player's screen once the card has landed; --before
// saves it with the ticket just opened, every panel under its painted
// foil (the stamp and the lattice), before the first stroke.
//
// Env: PLAYER (default Player2, must own Crate Tester).
//
// Two headless clients, the Gamemaster and the player, each running the
// branch's socket, redraw, shop and chat-card hooks (the installed
// module's sealChatCard and watchAgain taken off first, so a card is
// sealed and replayed by the branch alone). The GM seeds a one-ticket
// scratch ticket (1 gp, lucky numbers 4 x 3 with the bonus spot, its one
// prize 1 gp, so the card is a win whose total is known). Then, as people
// do:
//
//   1. The player opens the shop on Crate Tester, with the module's sound
//      on, and presses the ticket's Buy. The reveal opens with the ticket
//      under its foil, theirs to scratch (the coin, Reveal all).
//   2. The player scratches with the mouse: for each panel, the button
//      down, strokes back and forth across it, the button up (Playwright's
//      page.mouse, real pointer events), until the panel opens; the coin
//      shows under the pointer while pressed. Every panel and the bonus
//      spot. While any panel is shut, the window hasn't landed and the
//      player's chat card is sealed ("Opening…", no total). Once the last
//      opens, the window lands with "Won 1 gp" and the card shows "1 gp".
//   3. Meanwhile the GM's window opened by itself and its coin scratched
//      the card panel by panel (some open while others are shut, the coin
//      up), and landed within 10 s of opening, with no tools to scratch.
//   4. The player presses Watch again on the chat card: a replay window
//      opens and scratches itself (no tools, no pointer), and lands.
//
// Restored in a finally: the ticket refunded (the purse back), the game
// deleted (it is new this run), the sound setting and the shop's open
// state put back. One purchase a run. Needs "Crate Tester" in "Loot Crates
// Test".
/* global game, Hooks, foundry, __lc */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const shot = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : null;
const beforeShot = process.argv.includes("--before") ? process.argv[process.argv.indexOf("--before") + 1] : null;
const STAMP = Date.now().toString(36);
const NAME = `Live scratch ${STAMP}`;

async function join(browser, user) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const logs = [];
  page.on("console", m => { const t = m.text(); if (t.includes("loot-crates") || m.type() === "error") logs.push(t); });
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
    // The chat card's seal and Watch again, the branch's alone: the
    // installed build's would add its own button first, which can't play a
    // scratch snapshot.
    const { sealChatCard, watchAgain, preSealItem } = await import(base + "scripts/foundry/reveal.js");
    for (const h of [...(Hooks.events?.renderChatMessageHTML ?? [])]) if (h.fn?.name === "sealChatCard" || h.fn?.name === "watchAgain") Hooks.off("renderChatMessageHTML", h.id);
    Hooks.on("renderChatMessageHTML", sealChatCard);
    Hooks.on("renderChatMessageHTML", watchAgain);
    for (const h of [...(Hooks.events?.createItem ?? [])]) if (h.fn?.name === "preSealItem") Hooks.off("createItem", h.id);
    Hooks.on("createItem", preSealItem);
  }, MODULE_BASE);
  return { page, logs };
}

const HELPERS = `
  globalThis.__lc = globalThis.__lc ?? {};
  __lc.wait = ms => new Promise(r => setTimeout(r, ms));
  __lc.until = async (fn, ms = 15000) => { for (let t = 0; t < ms && !fn(); t += 50) await __lc.wait(50); return fn(); };
  __lc.reveals = () => [...document.querySelectorAll(".application.lc-reveal")];
  __lc.closeReveals = () => { for (const a of [...foundry.applications.instances.values()]) if (a.element?.classList.contains("lc-reveal")) a.close(); };
`;

// The player's newest pull card in the chat log, as it reads now.
const readChat = (page, logIds) => page.evaluate(ids => {
  const li = [...document.querySelectorAll("#chat .chat-log [data-message-id], #chat-log [data-message-id], .chat-log [data-message-id]")].filter(el => ids.includes(game.messages.get(el.dataset.messageId)?.flags?.["loot-crates"]?.logId)).pop();
  const card = li?.querySelector(".lc-chat");
  if (!card) return { shown: false };
  const visible = el => !!el && el.getBoundingClientRect().height > 0 && getComputedStyle(el).display !== "none";
  return {
    shown: true, sealed: card.classList.contains("lc-chat--sealed"), opening: card.querySelector(".lc-chat__sealed")?.textContent.trim() ?? null,
    name: visible(card.querySelector(".lc-chat__name")) ? card.querySelector(".lc-chat__name").textContent.trim() : null,
    line: visible(card.querySelector(".lc-chat__rarity")) ? card.querySelector(".lc-chat__rarity").textContent.trim() : null,
    replay: visible(card.querySelector(".lc-chat__replay")),
  };
}, logIds);

(async () => {
  const browser = await chromium.launch();
  const out = { player: PLAYER, name: NAME };
  let gm = null, pl = null, boxId = null, before = null, soundWas = null;
  try {
    pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");

    // The GM seeds a one-ticket roll whose one prize is 1 gp.
    before = await gm.page.evaluate(async ({ base, name, helpers }) => {
      (0, eval)(helpers);
      const store = await import(base + "scripts/foundry/store.js");
      const folder = game.folders.find(f => f.type === "Actor" && f.name === "Loot Crates Test");
      const actor = game.actors.find(a => a.name === "Crate Tester" && a.folder?.id === folder?.id);
      if (!actor) throw new Error("no Crate Tester in Loot Crates Test");
      if ((actor.system.currency.gp ?? 0) < 20) await actor.update({ "system.currency.gp": 1000 });
      const open = store.isShopOpen();
      if (!open) await store.setShopOpen(true);
      const box = await store.saveBox({
        kind: "scratch", name, price: 1, pools: [], weights: {}, layout: "lucky", grid: { cols: 4, rows: 3 }, bonus: { on: true, gp: 1 },
        roll: { id: 1, size: 1, prizes: [{ count: 1, gp: 1 }] }, rules: {},
      });
      return { boxId: box.id, actorId: actor.id, shopOpen: open, logIds: store.getLog().map(r => r.id) };
    }, { base: MODULE_BASE, name: NAME, helpers: HELPERS });
    boxId = before.boxId;

    // The GM's window, watched from the moment it opens: the coin and the
    // panels as the sweep runs, and when it lands.
    const gmWatch = gm.page.evaluate(async () => {
      const seen = new Set(__lc.reveals());
      let rv = null;
      await __lc.until(() => (rv = __lc.reveals().find(el => !seen.has(el) && el.querySelector(".lc-scratch__ticket"))), 60000);
      if (!rv) return { opened: false };
      const t0 = performance.now();
      const ticket = rv.querySelector(".lc-scratch__ticket");
      const n = ticket.querySelectorAll("[data-panel]").length;
      const samples = [];
      let landedMs = null;
      for (let i = 0; i < 300 && landedMs == null; i++) {
        await __lc.wait(50);
        const open = ticket.querySelectorAll(".lc-scratch__panel--open").length;
        const coin = ticket.querySelector(".lc-scratch__coin")?.classList.contains("lc-scratch__coin--on") ?? false;
        if (i % 4 === 0) samples.push({ ms: Math.round(performance.now() - t0), open, coin });
        if (rv.querySelector(".lc-scratch--landed")) landedMs = Math.round(performance.now() - t0);
      }
      return {
        opened: true, panels: n, landedMs, samples,
        buyer: !!ticket.dataset.buyer, tools: !!rv.querySelector(".lc-scratch__tools"),
        midway: samples.some(s => s.open > 0 && s.open < n && s.coin),
        result: rv.querySelector(".lc-reveal__result")?.innerText.replace(/\s+/g, " ").trim() ?? null,
      };
    });

    // 1. The player's shop on Crate Tester, the sound on; the real Buy.
    soundWas = await pl.page.evaluate(async ({ base, helpers }) => {
      (0, eval)(helpers);
      const was = game.settings.get("loot-crates", "sound");
      if (!was) await game.settings.set("loot-crates", "sound", true);
      const { openShop } = await import(base + "scripts/foundry/shop.js");
      const actor = game.actors.find(a => a.isOwner && a.type === "character" && a.name === "Crate Tester");
      if (!actor) throw new Error(`${game.user.name} doesn't own Crate Tester`);
      const app = openShop();
      await __lc.until(() => app.element?.querySelector(".lc-shop__body"), 8000);
      const pick = app.element.querySelector(".lc-shop__actor");
      if (pick && pick.value !== actor.id) { pick.value = actor.id; pick.dispatchEvent(new Event("change")); await __lc.wait(800); }
      return was;
    }, { base: MODULE_BASE, helpers: HELPERS });
    const purseCp = () => pl.page.evaluate(async base => (await import(base + "scripts/core/currency.js")).toCopper(game.actors.find(a => a.isOwner && a.name === "Crate Tester").system.currency), MODULE_BASE);
    out.purseBefore = await purseCp();
    const buy = pl.page.locator(`#loot-crates-shop .lc-box__buy[data-box="${boxId}"]`);
    await buy.waitFor({ timeout: 8000 });
    const t0 = Date.now();
    await buy.click();
    const reveal = pl.page.locator(".application.lc-reveal").filter({ has: pl.page.locator(".lc-scratch__ticket") }).last();
    await reveal.locator(".lc-scratch__ticket .lc-scratch__foil--painted").first().waitFor({ timeout: 15000 });
    out.revealMs = Date.now() - t0;
    out.opened = await reveal.evaluate(rv => ({
      buyer: rv.querySelector(".lc-scratch__ticket")?.dataset.buyer === "1",
      panels: rv.querySelectorAll(".lc-scratch__ticket [data-panel]").length,
      revealAll: rv.querySelector(".lc-scratch__all")?.textContent.trim() ?? null,
      covered: [...rv.querySelectorAll("[data-panel]")].every(p => /covered/.test(p.getAttribute("aria-label") ?? "") && !p.classList.contains("lc-scratch__panel--win")),
      head: rv.querySelector(".lc-reveal__head")?.innerText.replace(/\s+/g, " ").trim() ?? null,
    }));
    const logIds = await gm.page.evaluate(async ({ base, boxId }) => (await import(base + "scripts/foundry/store.js")).getLog().filter(r => r.boxId === boxId).map(r => r.id), { base: MODULE_BASE, boxId });
    await pl.page.waitForFunction(ids => game.messages.contents.some(m => ids.includes(m.flags?.["loot-crates"]?.logId)), logIds, { timeout: 10000 }).catch(() => {});
    out.chatWhileCovered = await readChat(pl.page, logIds);
    if (beforeShot) { await pl.page.waitForTimeout(400); await pl.page.screenshot({ path: beforeShot }); }

    // 2. Scratch every panel with the mouse: down, strokes, up.
    out.strokes = [];
    const count = out.opened.panels;
    for (let i = 0; i < count; i++) {
      const panel = reveal.locator(`.lc-scratch__ticket [data-panel]`).nth(i);
      await panel.scrollIntoViewIfNeeded();
      let tries = 0, opened = false, coinSeen = false, cursor = null;
      while (!opened && tries < 4) {
        tries++;
        const r = await panel.boundingBox();
        const rows = Math.max(2, Math.ceil(r.height / 20));
        const y0 = r.y + r.height / (2 * rows);
        await pl.page.mouse.move(r.x + 3, y0);
        if (cursor == null) cursor = await panel.evaluate(p => getComputedStyle(p.querySelector(".lc-scratch__foil")).cursor);
        await pl.page.mouse.down();
        for (let k = 0; k < rows; k++) {
          const y = r.y + r.height * ((k + 0.5) / rows);
          const x = k % 2 ? r.x + 3 : r.x + r.width - 3;
          await pl.page.mouse.move(x, y, { steps: Math.max(4, Math.round(r.width / 12)) });
          if (!coinSeen) coinSeen = await reveal.evaluate(rv => rv.querySelector(".lc-scratch__coin")?.classList.contains("lc-scratch__coin--down") ?? false);
        }
        await pl.page.mouse.up();
        opened = await panel.evaluate(p => new Promise(res => {
          const t = performance.now();
          const look = () => (p.classList.contains("lc-scratch__panel--open") ? res(true) : performance.now() - t > 1200 ? res(false) : requestAnimationFrame(look));
          look();
        }));
      }
      const landed = await reveal.evaluate(rv => !!rv.querySelector(".lc-scratch--landed"));
      const chat = i === count - 2 ? await readChat(pl.page, logIds) : null;
      out.strokes.push({ i, tries, opened, coinSeen, cursor, landed, ...(chat ? { chat } : {}) });
      if (!opened) break;
    }
    await reveal.locator(".lc-scratch--landed").waitFor({ timeout: 5000 }).catch(() => {});
    await pl.page.waitForTimeout(600);
    out.landed = await reveal.evaluate(rv => ({
      landed: !!rv.querySelector(".lc-scratch--landed"),
      result: rv.querySelector(".lc-reveal__result")?.innerText.replace(/\s+/g, " ").trim() ?? null,
      lit: rv.querySelectorAll(".lc-scratch__panel--win").length,
      tools: !!rv.querySelector(".lc-scratch__tools"),
      close: rv.querySelector(".lc-reveal__close")?.textContent.trim() ?? null,
    }));
    if (shot) await pl.page.screenshot({ path: shot });
    out.chatLanded = await readChat(pl.page, logIds);
    out.purseAfter = await purseCp();

    // 3. The GM's window scratched itself.
    out.gm = await gmWatch;
    const { samples, ...gmRest } = out.gm;
    out.gm = { ...gmRest, samples: samples?.filter((_, k) => k % 3 === 0) };

    // 4. Watch again from the chat card: the real button.
    await pl.page.evaluate(() => __lc.closeReveals());
    await pl.page.waitForTimeout(500);
    // The chat tab, as a player opens it (the sidebar starts collapsed), then
    // the card's button in the chat log.
    await pl.page.locator('#sidebar-tabs [data-tab="chat"]').first().click();
    await pl.page.waitForTimeout(600);
    const replayBtn = pl.page.locator("#chat .lc-chat__replay").last();
    await replayBtn.scrollIntoViewIfNeeded().catch(() => {});
    const r0 = Date.now();
    await replayBtn.click();
    const replay = pl.page.locator(".application.lc-reveal").filter({ has: pl.page.locator(".lc-scratch__ticket") }).last();
    await replay.waitFor({ timeout: 8000 });
    out.replay = await replay.evaluate(rv => ({
      title: rv.querySelector(".window-title")?.textContent.trim() ?? null,
      buyer: !!rv.querySelector(".lc-scratch__ticket")?.dataset.buyer,
      tools: !!rv.querySelector(".lc-scratch__tools"),
    }));
    await replay.locator(".lc-scratch--landed").waitFor({ timeout: 12000 }).catch(() => {});
    out.replay.landedMs = (await replay.evaluate(rv => !!rv.querySelector(".lc-scratch--landed"))) ? Date.now() - r0 : null;
    out.replay.result = await replay.evaluate(rv => rv.querySelector(".lc-reveal__result")?.innerText.replace(/\s+/g, " ").trim() ?? null);

    const strokes = out.strokes;
    out.checks = {
      buyersCard: out.opened.buyer && out.opened.panels === 13 && out.opened.revealAll === "Reveal all" && out.opened.covered && out.opened.head === `Crate Tester scratches ${NAME} 1 gp`,
      revealSoon: out.revealMs <= 5000,
      sealedWhileCovered: out.chatWhileCovered.shown && out.chatWhileCovered.sealed && out.chatWhileCovered.name == null,
      scratchedByHand: strokes.length === 13 && strokes.every(s => s.opened && s.cursor === "none") && strokes.some(s => s.coinSeen),
      notLandedEarly: strokes.slice(0, -1).every(s => !s.landed) && strokes.at(-2)?.chat?.sealed === true,
      landed: out.landed.landed && /^Won 1 gp/.test(out.landed.result ?? "") && out.landed.lit >= 1 && !out.landed.tools && out.landed.close === "Close",
      chatOpened: out.chatLanded.shown && !out.chatLanded.sealed && out.chatLanded.name === "1 gp",
      paid: out.purseAfter === out.purseBefore,
      gmScratchedItself: out.gm.opened && !out.gm.buyer && !out.gm.tools && out.gm.panels === 13 && out.gm.midway && out.gm.landedMs != null && out.gm.landedMs <= 10000,
      watchAgain: /Replay/.test(out.replay.title ?? "") && !out.replay.buyer && !out.replay.tools && out.replay.landedMs != null && /^Won 1 gp/.test(out.replay.result ?? ""),
    };
    out.ok = Object.values(out.checks).every(Boolean);
  } catch (err) {
    out.error = String(err?.stack || err);
    out.ok = false;
  } finally {
    // The ticket refunded, the game deleted, the sound and the shop as they were.
    try {
      out.restored = gm && boxId ? await gm.page.evaluate(async ({ base, boxId, shopOpen }) => {
        const store = await import(base + "scripts/foundry/store.js");
        const { refundPull } = await import(base + "scripts/foundry/refund.js");
        const refunded = [];
        for (const r of store.getLog().filter(x => x.boxId === boxId && !x.refunded)) { const res = await refundPull(r.id); refunded.push(res.status); }
        await store.removeBox(boxId);
        if (!shopOpen) await store.setShopOpen(false);
        __lc.closeReveals?.();
        return { refunded, gone: !store.getBoxes()[boxId], open: store.isShopOpen() };
      }, { base: MODULE_BASE, boxId, shopOpen: before?.shopOpen ?? true }) : null;
    } catch (err) { out.restored = { error: String(err) }; out.ok = false; }
    if (out.restored && (out.restored.error || !out.restored.gone || out.restored.refunded.length !== 1 || out.restored.refunded.some(s => s !== "refunded"))) out.ok = false;
    try {
      if (pl) {
        out.restored = { ...(out.restored ?? {}), sound: await pl.page.evaluate(async was => { if (was === false) await game.settings.set("loot-crates", "sound", false); return game.settings.get("loot-crates", "sound"); }, soundWas) };
        await pl.page.evaluate(() => { for (const a of [...foundry.applications.instances.values()]) if (/loot-crates/.test(a.id) || a.element?.classList.contains("lc-reveal")) a.close(); });
      }
    } catch { /* closing */ }
    out.gmConsole = gm?.logs.filter(l => !l.includes("timings")) ?? [];
    out.playerLog = pl?.logs ?? [];
    console.log(JSON.stringify(out, null, 1));
    if (!out.ok) process.exitCode = 1;
    await browser.close();
  }
})();
