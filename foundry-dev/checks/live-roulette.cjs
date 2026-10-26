// Live check: Roulette, the Wheel of Fate (roulette.js) on the shared table
// window (tablewindow.js) at a real table, with the branch's code on both ends.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/checks/live-roulette.cjs [--shot out.png]
//
// Env: PLAYER (default Player2, must own Crate Tester), WHEEL (the game's
// name, default "Live wheel"), HIDE_GM=0 (the GM's tab visible; hidden by
// default, as the acceptance asks).
//
// Two headless clients, the Gamemaster and the player, each with the
// installed module's socket listener removed and the branch's registered
// from MODULE_BASE (as player-pull.cjs does), the table window included.
// The GM seeds "Live wheel" (twelve default pockets, 1 gp to 10 gp a bet,
// three bets a character, open until the GM spins, no item on a rarity so
// the inventory is left alone) and notes the purse, the log and the chat.
// Then, as people do:
//
//   1. The player opens the shop on Crate Tester: the wheel's card reads
//      "Place a bet" off with "No round open yet". The GM opens the Boxes
//      tab and presses the wheel's "Open a round": a round opens, the table
//      window opens on both clients, and the player's card turns on within
//      2 s ("Bets are open until the GM spins").
//   2. The player places two bets through the window's real form (a colour
//      at 1 gp, a number at 2 gp): each drops a chip on the rail on both
//      clients, the purse drops by 3 gp, two open rows are in the log.
//   3. The GM presses Spin in their window. Every animation frame to the
//      player's landing (.lc-table__stage--landed) is watched: the round's
//      chat card must render sealed ("Opening…", its block hidden) until
//      then, and no verdict ("The ball lands") may show in the chat log
//      before it. Both clients must land on the same pocket, the verdict
//      must sit in the player's live region with Close focused, and the
//      purse must change by exactly the net of the two rows.
//   4. The GM refunds one settled bet from the Pull log (its tab, Refund,
//      Yes): the purse follows by that row's stake less its payout, and the
//      player's rail drops that chip within 2 s.
//      While the wheel turns on the player, their open shop card must read
//      "Still spinning" (Place a bet off, "The wheel is turning") within
//      0.5 s of the spin starting, never "No round open yet" until landing.
//   5. A second round with a clock (CLOCK_SEC, default 50). The player's
//      page is reloaded after it opened (a late joiner who never heard the
//      "open"): the shop card's "Bets close in" line must tick within 2 s,
//      and its Place a bet opens the round's window, where the player places
//      one bet. The clock runs out; the GM moves the round's close back by
//      twice its clock (instead of waiting) and the load-time recovery
//      leaves it (round.js ROUND_GRACE_MS). The GM moves it back past the
//      grace, and with no reload the GM's stale timer (table.js watchStale,
//      re-armed on the rounds' change as main.js wires it) refunds the bet
//      within 3 s, with the GM's notice, and the player's window says the
//      round was called off.
//
// Restored in a finally: the wheel's record as it was (or left seeded when
// new this run). Nothing is deleted; the settled rows stand, as every
// live purchase does. Needs "Crate Tester" in "Loot Crates Test".
/* global game, foundry, Hooks, ui -- used inside page.evaluate, which runs in the Foundry page */
const { chromium } = require("playwright");
const { keepWindowsOpen } = require("./lib/linger.cjs");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const WHEEL = process.env.WHEEL || "Live wheel";
const HIDE_GM = process.env.HIDE_GM !== "0";
// The second round's clock: long enough for the late joiner's reload and bet.
const CLOCK_SEC = Number(process.env.CLOCK_SEC) || 50;
const shot = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : null;

const wait = ms => new Promise(r => setTimeout(r, ms));

// The branch's code in place of the installed module's, as main.js wires it.
async function wire(page) {
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
    const { refreshTables } = await import(base + "scripts/foundry/tablewindow.js");
    const redraw = storeRedraw({ refreshShop, refreshManager, refreshTables });
    // As main.js: a change to the rounds moves the GM's stale timer.
    const table = await import(base + "scripts/foundry/table.js");
    store.setStoreListener(key => { redraw(key); if (key === "tableRounds") table.watchStale(); });
    table.watchStale();
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
}

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
  await wire(page);
  return { page, logs };
}

const hideTab = page => page.evaluate(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
  document.dispatchEvent(new Event("visibilitychange"));
  return document.visibilityState;
});

// The GM's side: seed the wheel, settle any round left over, note what is to be restored.
async function seed(gm, windowSec = 0) {
  return gm.evaluate(async ({ base, name, windowSec }) => {
    const store = await import(base + "scripts/foundry/store.js");
    const { toCopper } = await import(base + "scripts/core/currency.js");
    const { ROULETTE_DEFAULTS } = await import(base + "scripts/games/roulette.js");
    const { liveRoundOf } = await import(base + "scripts/core/round.js");
    const { resolveRound } = await import(base + "scripts/foundry/table.js");
    const folder = game.folders.find(f => f.type === "Actor" && f.name === "Loot Crates Test");
    const actor = game.actors.find(a => a.name === "Crate Tester" && a.folder?.id === folder?.id);
    if (!actor) throw new Error("no Crate Tester in Loot Crates Test: run live-pull.js first");
    if ((actor.system.currency.gp ?? 0) < 60) await actor.update({ "system.currency.gp": 1000 });
    const old = Object.values(store.getBoxes()).find(b => b.name === name) ?? null;
    const wheel = await store.saveBox({
      ...(old ? { id: old.id } : {}), kind: "roulette", name, price: 1, pools: [], weights: {},
      roulette: { colours: ["Red", "Black"], pockets: ROULETTE_DEFAULTS.pockets.map(p => ({ ...p })), payouts: { ...ROULETTE_DEFAULTS.payouts }, itemOnRarity: false, maxStake: 10, maxBets: 3, windowSec },
      rules: {},
    });
    // A round left open by an earlier run is spun now, so this one starts clean.
    const leftover = liveRoundOf(store.getRounds(), wheel.id);
    if (leftover) await resolveRound(leftover.id);
    return {
      actorId: actor.id, wheelId: wheel.id, old, leftover: !!leftover,
      purseCp: toCopper(actor.system.currency), items: actor.items.size,
      logIds: store.getLog().map(r => r.id), messages: game.messages.size,
    };
  }, { base: MODULE_BASE, name: WHEEL, windowSec });
}

async function restore(gm, before) {
  if (!gm || !before) return null;
  return gm.evaluate(async ({ base, before, name }) => {
    const out = {};
    try {
      const store = await import(base + "scripts/foundry/store.js");
      if (before.old) { await store.saveBox(before.old); out.wheel = "restored"; }
      else { const w = Object.values(store.getBoxes()).find(b => b.name === name); out.wheel = w ? "left seeded (new this run)" : "none"; }
    } catch (err) { out.error = String(err?.stack || err); }
    return out;
  }, { base: MODULE_BASE, before, name: WHEEL });
}


// What a client's table window shows.
const readTable = page => page.evaluate(() => {
  const win = [...document.querySelectorAll(".application.lc-table")].at(-1);
  if (!win) return null;
  const result = win.querySelector(".lc-table__result");
  return {
    title: win.querySelector(".window-title")?.textContent.trim() ?? null,
    state: win.querySelector(".lc-table__state")?.textContent.trim() ?? null,
    count: win.querySelector(".lc-table__count")?.textContent.trim() ?? null,
    chips: win.querySelectorAll(".lc-rail .lc-token").length,
    mine: win.querySelectorAll(".lc-token--mine").length,
    listed: [...win.querySelectorAll(".lc-table__list li")].map(li => li.textContent),
    form: !!win.querySelector(".lc-table__form"),
    spin: win.querySelector(".lc-table__spin")?.textContent.trim() ?? null,
    button: win.querySelector(".lc-reveal__close")?.textContent.trim() ?? null,
    landed: !!win.querySelector(".lc-table__stage--landed"),
    pocket: win.querySelector(".lc-table__stage")?.dataset.pocket ?? null,
    result: result?.innerText.replace(/\s+/g, " ").trim() ?? null,
    liveRegion: !!result?.closest("[aria-live]"),
    focusOnClose: document.activeElement?.matches?.(".lc-reveal__close") ?? false,
    won: [...win.querySelectorAll(".lc-spot--won")].map(s => s.dataset.spot).sort(),
  };
});

// A bet through the window's real form: the type and pick chosen, the stake typed, the button pressed.
async function placeBet(page, { type, pick, stake }) {
  return page.evaluate(async ({ type, pick, stake }) => {
    const win = [...document.querySelectorAll(".application.lc-table")].at(-1);
    const form = win?.querySelector(".lc-table__form");
    if (!form) throw new Error("no bet form in the player's table window");
    const until = async (fn, ms = 10000) => { for (let t = 0; t < ms && !fn(); t += 50) await new Promise(r => setTimeout(r, 50)); return fn(); };
    const typeEl = form.querySelector(".lc-table__type");
    typeEl.value = type;
    typeEl.dispatchEvent(new Event("change", { bubbles: true }));
    const pickEl = form.querySelector(".lc-table__pick");
    pickEl.value = String(pick);
    pickEl.dispatchEvent(new Event("change", { bubbles: true }));
    const stakeEl = form.querySelector(".lc-table__stake");
    stakeEl.value = String(stake);
    stakeEl.dispatchEvent(new Event("input", { bubbles: true }));
    const chipsBefore = win.querySelectorAll(".lc-rail .lc-token").length;
    const btn = form.querySelector(".lc-table__bet");
    btn.focus();
    const t0 = performance.now();
    btn.click();
    const placing = await until(() => btn.textContent.trim() === "Placing…", 2000) ? "Placing…" : btn.textContent.trim();
    const landed = await until(() => win.querySelectorAll(".lc-rail .lc-token").length > chipsBefore, 15000);
    const ms = Math.round(performance.now() - t0);
    await until(() => btn.textContent.trim() === "Place a bet", 5000);
    return { placing, landed, ms, chips: win.querySelectorAll(".lc-rail .lc-token").length, why: form.querySelector(".lc-table__why")?.textContent ?? "", focusOnButton: document.activeElement === btn, live: win.querySelector(".lc-table__live")?.textContent ?? "" };
  }, { type, pick, stake });
}

// The GM's Spin, watched on the player: frames to the landing, the chat renders.
async function spinAndWatch(gm, pl, roundId, wheelId) {
  const watching = pl.evaluate(async ({ roundId, wheelId }) => {
    const win = [...document.querySelectorAll(".application.lc-table")].at(-1);
    // The player's open shop card for the wheel, every frame of the spin:
    // it must say the wheel is turning (reveal.js boxHeld), not "No round
    // open yet", until this client lands.
    const shopCard = () => [...foundry.applications.instances.values()].find(a => a.options?.id === "loot-crates-shop")?.element?.querySelector(`.lc-box[data-box="${wheelId}"]`) ?? null;
    const readCard = () => { const c = shopCard(); return c ? { why: c.querySelector(".lc-box__why")?.textContent.trim() ?? "", round: c.querySelector(".lc-box__round")?.textContent.trim() ?? "", off: c.querySelector(".lc-box__buy")?.getAttribute("aria-disabled") === "true" } : null; };
    const cardStates = [];
    let spinStart = null;
    const renders = [];
    const t0 = performance.now();
    const hookId = Hooks.on("renderChatMessageHTML", (m, html) => {
      if (m.flags?.["loot-crates"]?.logId !== roundId) return;
      renders.push({ ms: Math.round(performance.now() - t0), sealed: !!html.querySelector(".lc-chat--sealed"), itemShown: (html.querySelector(".lc-chat__item")?.getClientRects().length ?? 0) > 0, opening: /Opening…/.test(html.textContent) });
    });
    let frames = 0, leakFrames = 0, spinningFrames = 0, landedMs = null, done = false;
    const frame = () => {
      if (done) return;
      if (win.querySelector(".lc-table__stage--landed")) { landedMs ??= Math.round(performance.now() - t0); done = true; return; }
      frames++;
      if (win.querySelector(".lc-table__stage--spinning")) {
        spinningFrames++;
        spinStart ??= performance.now();
        const c = readCard();
        const last = cardStates.at(-1);
        if (c && (!last || last.why !== c.why || last.round !== c.round || last.off !== c.off)) cardStates.push({ ms: Math.round(performance.now() - spinStart), ...c });
      }
      // This round's card alone: earlier rounds' cards stand in the log.
      const mine = [...document.querySelectorAll("#chat-log .message, #chat .message")].filter(el => game.messages.get(el.dataset.messageId)?.flags?.["loot-crates"]?.logId === roundId);
      if (mine.some(el => [...el.querySelectorAll(".lc-chat__name")].some(n => /lands on/.test(n.textContent) && n.getClientRects().length))) leakFrames++;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    for (let i = 0; i < 600 && landedMs == null; i++) await new Promise(r => setTimeout(r, 50));
    done = true;
    await new Promise(r => setTimeout(r, 1200));
    Hooks.off("renderChatMessageHTML", hookId);
    return { frames, spinningFrames, leakFrames, landedMs, renders, cardStates, cardAfterLanding: readCard() };
  }, { roundId, wheelId });
  await wait(300);
  const pressed = await gm.evaluate(async () => {
    const win = [...document.querySelectorAll(".application.lc-table")].at(-1);
    const btn = win?.querySelector(".lc-table__spin");
    if (!btn) throw new Error("no Spin in the GM's table window");
    btn.focus();
    btn.click();
    await new Promise(r => setTimeout(r, 200));
    return btn.textContent.trim();
  });
  const watched = await watching;
  return { pressed, ...watched };
}

// The GM refunds a row from the Pull log, as a person does: the tab, Refund, Yes.
async function refundFromLog(gm, rowId) {
  return gm.evaluate(async ({ base, rowId }) => {
    const { openManager } = await import(base + "scripts/foundry/manager.js");
    const store = await import(base + "scripts/foundry/store.js");
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const until = async (fn, ms = 15000) => { for (let t = 0; t < ms && !fn(); t += 50) await wait(50); return fn(); };
    const click = el => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
    const app = openManager();
    await until(() => app.element?.querySelector('.lc-tabs [data-tab="log"]'));
    click(app.element.querySelector('.lc-tabs [data-tab="log"]'));
    const btn = () => app.element?.querySelector(`button[data-action=refund][data-row="${rowId}"]`);
    if (!await until(() => app.tab === "log" && btn(), 8000)) throw new Error("the Pull log has no Refund for the row");
    const rowText = btn().closest("tr")?.innerText.replace(/\s+/g, " ").trim() ?? null;
    btn().focus();
    click(btn());
    const dialog = () => [...document.querySelectorAll(".application.dialog")].pop();
    const yes = () => [...(dialog()?.querySelectorAll("button") ?? [])].find(b => /yes/i.test(b.dataset.action ?? b.textContent));
    await until(() => yes());
    const dialogText = dialog()?.querySelector(".window-content")?.textContent.replace(/\s+/g, " ").trim() ?? null;
    const at = Date.now();
    click(yes());
    await until(() => store.getLog().find(r => r.id === rowId)?.refunded, 8000);
    await wait(800);
    const rowAfter = app.element?.querySelector(`[data-row="${rowId}"]`)?.closest("tr")?.innerText.replace(/\s+/g, " ").trim() ?? null;
    await app.close();
    return { at, rowText, dialogText, refunded: store.getLog().find(r => r.id === rowId)?.refunded ?? null, rowAfter };
  }, { base: MODULE_BASE, rowId });
}

const purseOf = (gm, actorId) => gm.evaluate(async ({ base, actorId }) => {
  const { toCopper } = await import(base + "scripts/core/currency.js");
  const actor = game.actors.get(actorId);
  return { purseCp: toCopper(actor.system.currency), items: actor.items.size };
}, { base: MODULE_BASE, actorId });

const freshRows = (gm, before) => gm.evaluate(async ({ base, before }) => {
  const store = await import(base + "scripts/foundry/store.js");
  return store.getLog().filter(r => !before.logIds.includes(r.id)).sort((a, b) => a.at - b.at).map(r => ({ id: r.id, name: r.name, price: r.price, payoutCp: r.payoutCp, status: r.status, roundId: r.roundId, refunded: r.refunded ?? null, refundReason: r.refundReason ?? null, itemId: r.itemId }));
}, { base: MODULE_BASE, before });

(async () => {
  const browser = await chromium.launch();
  const out = { player: PLAYER, wheel: WHEEL, gm: null, hideGm: HIDE_GM };
  let gm = null, before = null;
  const linger = keepWindowsOpen();
  try {
    const pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");
    out.gm = "headless Gamemaster running the branch";
    // This check reads its windows after they land: they stay open for the run (lib/linger.cjs).
    await linger.hold(pl.page, PLAYER);
    await linger.hold(gm.page, "Gamemaster");
    before = await seed(gm.page, 0);
    out.before = { purseCp: before.purseCp, items: before.items, rows: before.logIds.length, messages: before.messages, leftover: before.leftover };
    if (HIDE_GM) out.gmHidden = await hideTab(gm.page);

    // 1. The shop on Crate Tester, with no round open; the GM opens one from the Boxes tab.
    out.shopBefore = await pl.page.evaluate(async ({ base, wheelId }) => {
      const { openShop } = await import(base + "scripts/foundry/shop.js");
      const actor = game.actors.find(a => a.isOwner && a.type === "character");
      if (!actor) throw new Error(`${game.user.name} owns no character`);
      const app = openShop();
      await new Promise(r => setTimeout(r, 1500));
      const pick = app.element.querySelector(".lc-shop__actor");
      if (pick && pick.value !== actor.id) { pick.value = actor.id; pick.dispatchEvent(new Event("change")); await new Promise(r => setTimeout(r, 800)); }
      const card = app.element.querySelector(`.lc-box[data-box="${wheelId}"]`);
      return { found: !!card, buy: card?.querySelector(".lc-box__buy")?.textContent.trim() ?? null, off: card?.querySelector(".lc-box__buy")?.getAttribute("aria-disabled") === "true", why: card?.querySelector(".lc-box__why")?.textContent.trim() ?? "", round: card?.querySelector(".lc-box__round")?.textContent.trim() ?? "", pills: [...(card?.querySelectorAll(".lc-odd") ?? [])].map(p => p.textContent.trim()) };
    }, { base: MODULE_BASE, wheelId: before.wheelId });
    out.open = await gm.page.evaluate(async ({ base, wheelId }) => {
      const { openManager } = await import(base + "scripts/foundry/manager.js");
      const store = await import(base + "scripts/foundry/store.js");
      const { liveRoundOf } = await import(base + "scripts/core/round.js");
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const until = async (fn, ms = 15000) => { for (let t = 0; t < ms && !fn(); t += 50) await wait(50); return fn(); };
      const click = el => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
      const app = openManager();
      await until(() => app.element?.querySelector('.lc-tabs [data-tab="boxes"]'));
      click(app.element.querySelector('.lc-tabs [data-tab="boxes"]'));
      const btn = () => app.element?.querySelector(`button[data-action=openTable][data-box="${wheelId}"]`);
      if (!await until(() => app.tab === "boxes" && btn(), 8000)) throw new Error("the Boxes tab has no Open a round for the wheel");
      const label = btn().textContent.trim();
      const t0 = Date.now();
      click(btn());
      const round = await until(() => liveRoundOf(store.getRounds(), wheelId), 10000);
      await until(() => document.querySelector(".application.lc-table"), 10000);
      await wait(600);
      const after = app.element?.querySelector(`button[data-action=openTable][data-box="${wheelId}"]`)?.textContent.trim() ?? null;
      await app.close();
      return { label, after, roundId: round?.id ?? null, ms: Date.now() - t0, gmWindow: !!document.querySelector(".application.lc-table") };
    }, { base: MODULE_BASE, wheelId: before.wheelId });
    out.cardAfterOpen = await pl.page.evaluate(async id => {
      const read = () => { const app = [...foundry.applications.instances.values()].find(a => a.options?.id === "loot-crates-shop"); const card = app?.element?.querySelector(`.lc-box[data-box="${id}"]`); return card ? { buy: card.querySelector(".lc-box__buy")?.textContent.trim(), off: card.querySelector(".lc-box__buy")?.getAttribute("aria-disabled") === "true", round: card.querySelector(".lc-box__round")?.textContent.trim() ?? "" } : null; };
      const t0 = Date.now();
      for (let i = 0; i < 100; i++) { const c = read(); if (c && !c.off) return { ...c, ms: Date.now() - t0 }; await new Promise(r => setTimeout(r, 50)); }
      return { ...read(), ms: null };
    }, before.wheelId);
    await pl.page.waitForFunction(() => document.querySelector(".application.lc-table .lc-table__form"), null, { timeout: 10000 }).catch(() => {});
    out.playerTableOpen = await readTable(pl.page);

    // 2. Two bets through the real form.
    out.bet1 = await placeBet(pl.page, { type: "colour", pick: 0, stake: 1 });
    out.bet2 = await placeBet(pl.page, { type: "number", pick: 7, stake: 2 });
    await wait(800);
    out.playerTableBets = await readTable(pl.page);
    out.gmTableBets = await readTable(gm.page);
    out.afterBets = await purseOf(gm.page, before.actorId);
    out.rowsOpen = await freshRows(gm.page, before);

    // 3. The GM spins.
    out.spin = await spinAndWatch(gm.page, pl.page, out.open.roundId, before.wheelId);
    out.playerLanded = await readTable(pl.page);
    out.gmLanded = await readTable(gm.page);
    out.afterSpin = await purseOf(gm.page, before.actorId);
    out.rowsSettled = await freshRows(gm.page, before);
    out.chat = await gm.page.evaluate(async ({ before, roundId }) => {
      const fresh = game.messages.contents.filter(m => m.flags?.["loot-crates"]?.logId === roundId);
      return { messages: game.messages.size - before.messages, roundCards: fresh.length, hasRoll: fresh.some(m => (m.rolls?.length ?? 0) > 0), text: fresh.at(-1)?.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() ?? null };
    }, { before, roundId: out.open.roundId });
    if (shot) await pl.page.screenshot({ path: shot });

    // 4. The GM refunds the second bet (the number) from the Pull log.
    const second = out.rowsSettled.find(r => r.name === "7");
    if (!second) throw new Error("no settled row for the number bet");
    out.refund = await refundFromLog(gm.page, second.id);
    out.afterRefund = await purseOf(gm.page, before.actorId);
    out.railAfterRefund = await pl.page.evaluate(async since => {
      const win = [...document.querySelectorAll(".application.lc-table")].at(-1);
      for (let i = 0; i < 150; i++) {
        const chips = win?.querySelectorAll(".lc-rail .lc-token").length ?? -1;
        if (chips === 1) return { chips, ms: Date.now() - since };
        await new Promise(r => setTimeout(r, 20));
      }
      return { chips: win?.querySelectorAll(".lc-rail .lc-token").length ?? -1, ms: null };
    }, out.refund.at);
    await pl.page.evaluate(async () => {
      for (const app of [...foundry.applications.instances.values()].filter(a => a.options?.classes?.includes("lc-table"))) await app.close();
    });

    // 5. A second round on a clock. The player reloads after it opened (a
    // late joiner who never heard the "open"): the shop card's countdown
    // must tick within 2 s, and its Place a bet opens the round's window.
    before.old2 = await gm.page.evaluate(async ({ base, wheelId, windowSec }) => {
      const store = await import(base + "scripts/foundry/store.js");
      const box = store.getBoxes()[wheelId];
      await store.saveBox({ ...box, roulette: { ...box.roulette, windowSec } });
      return true;
    }, { base: MODULE_BASE, wheelId: before.wheelId, windowSec: CLOCK_SEC });
    out.open2 = await gm.page.evaluate(async ({ base, wheelId }) => {
      const { openManager } = await import(base + "scripts/foundry/manager.js");
      const store = await import(base + "scripts/foundry/store.js");
      const { liveRoundOf } = await import(base + "scripts/core/round.js");
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const until = async (fn, ms = 15000) => { for (let t = 0; t < ms && !fn(); t += 50) await wait(50); return fn(); };
      const click = el => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
      const app = openManager();
      await until(() => app.element?.querySelector('.lc-tabs [data-tab="boxes"]'));
      click(app.element.querySelector('.lc-tabs [data-tab="boxes"]'));
      const btn = () => app.element?.querySelector(`button[data-action=openTable][data-box="${wheelId}"]`);
      await until(() => app.tab === "boxes" && btn(), 8000);
      click(btn());
      const round = await until(() => liveRoundOf(store.getRounds(), wheelId), 10000);
      await app.close();
      return { roundId: round?.id ?? null, closesAt: round?.closesAt ?? null, clock: round ? round.closesAt - round.opensAt : null };
    }, { base: MODULE_BASE, wheelId: before.wheelId });
    await pl.page.reload({ waitUntil: "networkidle" });
    await pl.page.waitForFunction(() => window.game?.ready, null, { timeout: 120000 });
    // What main.js does first: the branch's words, from its own lang/en.json
    // (the installed release may have no language file, or older words).
    await pl.page.evaluate(async base => (await import(base + "scripts/core/i18n.js")).loadStrings(), MODULE_BASE);
    await wire(pl.page);
    out.lateJoiner = await pl.page.evaluate(async ({ base, wheelId }) => {
      const { openShop } = await import(base + "scripts/foundry/shop.js");
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const actor = game.actors.find(a => a.isOwner && a.type === "character");
      const app = openShop();
      const card = () => app.element?.querySelector(`.lc-box[data-box="${wheelId}"]`);
      for (let i = 0; i < 100 && !card(); i++) await wait(50);
      const pick = app.element?.querySelector(".lc-shop__actor");
      if (pick && pick.value !== actor?.id) { pick.value = actor.id; pick.dispatchEvent(new Event("change")); await wait(600); }
      const line = () => card()?.querySelector(".lc-box__round")?.textContent.trim() ?? "";
      const first = line();
      const t0 = performance.now();
      let moved = null, ms = null;
      for (let i = 0; i < 60; i++) {
        await wait(50);
        if (line() !== first) { moved = line(); ms = Math.round(performance.now() - t0); break; }
      }
      // Place a bet on the card, as the player would, opens the round's window.
      const buy = card()?.querySelector(".lc-box__buy");
      const off = buy?.getAttribute("aria-disabled") === "true";
      buy?.focus();
      buy?.click();
      for (let i = 0; i < 100 && !document.querySelector(".application.lc-table .lc-table__form"); i++) await wait(50);
      return { first, moved, ms, countdown: !!card()?.querySelector("[data-lc-countdown]"), off, window: !!document.querySelector(".application.lc-table .lc-table__form") };
    }, { base: MODULE_BASE, wheelId: before.wheelId });
    out.playerTable2 = await readTable(pl.page);
    out.bet3 = await placeBet(pl.page, { type: "parity", pick: "odd", stake: 1 });
    out.afterBet3 = await purseOf(gm.page, before.actorId);
    // The clock runs out (the player's form goes).
    await pl.page.waitForFunction(() => !document.querySelector(".application.lc-table .lc-table__form"), null, { timeout: (CLOCK_SEC + 15) * 1000 }).catch(() => {});
    out.playerTableClosed = await readTable(pl.page);
    // The grace window (round.js ROUND_GRACE_MS): the GM moves the round's
    // close back by twice its clock (stale under the old rule of one clock
    // length) instead of waiting; the load-time recovery leaves it alone.
    const moveClose = (ms) => gm.page.evaluate(async ({ base, roundId, ms }) => {
      const store = await import(base + "scripts/foundry/store.js");
      const { staleAt, ROUND_GRACE_MS } = await import(base + "scripts/core/round.js");
      const closedAt = Date.now() - (ms ?? ROUND_GRACE_MS + 1000);
      await store.enqueueWrite(() => store.saveRound({ ...store.getRounds()[roundId], closedAt }));
      const round = store.getRounds()[roundId];
      return { closedAt, staleAt: staleAt(round), now: Date.now(), grace: ROUND_GRACE_MS };
    }, { base: MODULE_BASE, roundId: out.open2.roundId, ms });
    out.inGrace = await moveClose(CLOCK_SEC * 2000);
    out.recoveredInGrace = await gm.page.evaluate(async ({ base, roundId }) => {
      const { recoverRounds } = await import(base + "scripts/foundry/table.js");
      const store = await import(base + "scripts/foundry/store.js");
      const out = await recoverRounds();
      const row = store.getLog().find(r => r.roundId === roundId);
      return { ...out, round: store.getRounds()[roundId]?.status ?? null, row: row && { status: row.status, refunded: !!row.refunded } };
    }, { base: MODULE_BASE, roundId: out.open2.roundId });
    // Past the grace: with no reload, the GM's stale timer refunds it.
    await gm.page.evaluate(() => {
      globalThis.__lcSaid = [];
      const warn = ui.notifications.warn.bind(ui.notifications);
      ui.notifications.warn = (msg, ...rest) => { globalThis.__lcSaid.push(String(msg)); return warn(msg, ...rest); };
    });
    out.pastGrace = await moveClose(null);
    out.recovered = await gm.page.evaluate(async ({ base, roundId, since }) => {
      const store = await import(base + "scripts/foundry/store.js");
      const rowOf = () => store.getLog().find(r => r.roundId === roundId);
      let ms = null;
      for (let i = 0; i < 250; i++) {
        if (rowOf()?.refunded) { ms = Date.now() - since; break; }
        await new Promise(r => setTimeout(r, 20));
      }
      await new Promise(r => setTimeout(r, 300));
      const row = rowOf();
      return { ms, notice: [...globalThis.__lcSaid], round: store.getRounds()[roundId]?.status ?? null, voided: !!store.getRounds()[roundId]?.voided, row: row && { status: row.status, refunded: !!row.refunded, refundReason: row.refundReason ?? null }, reloaded: false };
    }, { base: MODULE_BASE, roundId: out.open2.roundId, since: out.pastGrace.now });
    out.afterRecover = await purseOf(gm.page, before.actorId);
    // The player's window follows the rounds setting within the redraw's delay.
    await pl.page.waitForFunction(() => document.querySelector('.application.lc-table .lc-table__state[data-state="void"]'), null, { timeout: 5000 }).catch(() => {});
    out.playerTableVoid = await readTable(pl.page);

    const r1 = out.rowsSettled.find(r => r.name === "Red"), r2 = out.rowsSettled.find(r => r.name === "7");
    const net = r => Math.round(r.price * 100) - Math.round(r.payoutCp || 0);
    const stillAt = out.spin.cardStates.find(c => c.why === "Still spinning") ?? null;
    const sealedUntilLanding = out.spin.renders.filter(x => x.ms < out.spin.landedMs).every(x => x.sealed && !x.itemShown && x.opening) && out.spin.renders.length > 0;
    out.checks = {
      cardOffWithNoRound: out.shopBefore.found && out.shopBefore.buy === `${WHEEL}: Place a bet` && out.shopBefore.off && out.shopBefore.why === "No round open yet" && out.shopBefore.pills.join(", ") === "Common 42%, Uncommon 33%, Rare 17%, Legendary 8%",
      gmOpenedFromBoxes: out.open.label === "Open a round" && out.open.after === "Go to the table" && !!out.open.roundId && out.open.gmWindow,
      cardOnWithin2s: out.cardAfterOpen.ms != null && out.cardAfterOpen.ms <= 2000 && !out.cardAfterOpen.off && out.cardAfterOpen.round === "Bets are open until the GM spins",
      playerWindowOpened: !!out.playerTableOpen?.form && out.playerTableOpen.title === `The wheel at ${WHEEL}` && out.playerTableOpen.count === "No bets yet" && !out.playerTableOpen.spin,
      twoBetsPlaced: out.bet1.landed && out.bet2.landed && out.bet1.placing === "Placing…" && out.bet1.chips === 1 && out.bet2.chips === 2 && !out.bet1.why && !out.bet2.why && out.bet1.focusOnButton && /bets 1 gp on Red/.test(out.bet1.live),
      chipsOnBothClients: out.playerTableBets?.chips === 2 && out.playerTableBets.mine === 2 && out.gmTableBets?.chips === 2 && out.playerTableBets.count === "2 bets" && out.gmTableBets.spin === "Spin",
      purseDroppedByStakes: out.afterBets.purseCp === before.purseCp - 300 && out.rowsOpen.length === 2 && out.rowsOpen.every(r => r.status === "open"),
      spunAndLandedTogether: out.spin.landedMs != null && out.spin.landedMs <= 8000 && out.spin.spinningFrames > 10 && out.playerLanded?.landed && out.gmLanded?.landed && out.playerLanded.pocket === out.gmLanded.pocket && /^\d+$/.test(out.playerLanded.pocket ?? ""),
      verdictInLiveRegion: /^The ball lands on \d+, (red|black), /.test(out.playerLanded?.result ?? "") && out.playerLanded.liveRegion && out.playerLanded.focusOnClose && out.playerLanded.button === "Close" && out.playerLanded.state === "Settled",
      noVerdictInChatBeforeLanding: out.spin.leakFrames === 0 && sealedUntilLanding && out.chat.roundCards === 1 && !out.chat.hasRoll && /The ball lands on/.test(out.chat.text ?? ""),
      purseChangedByNet: !!r1 && !!r2 && out.afterSpin.purseCp === before.purseCp - net(r1) - net(r2) && out.afterSpin.items === before.items && out.rowsSettled.every(r => r.status === "settled"),
      refundFollowed: out.refund.refunded != null && out.afterRefund.purseCp === out.afterSpin.purseCp + net(r2) && /Crate Tester/.test(out.refund.dialogText ?? "") && /refunded/.test(out.refund.rowAfter ?? ""),
      railDroppedChip: out.railAfterRefund.ms != null && out.railAfterRefund.ms <= 2000 && out.railAfterRefund.chips === 1,
      stillSpinningOnCard: !!stillAt && stillAt.ms <= 500 && stillAt.off && stillAt.round === "The wheel is turning" && !out.spin.cardStates.slice(out.spin.cardStates.indexOf(stillAt)).some(c => c.why === "No round open yet") && out.spin.cardAfterLanding?.why === "No round open yet",
      lateJoinerCountdownMoves: /^Bets close in 0:\d\d$/.test(out.lateJoiner.first) && /^Bets close in 0:\d\d$/.test(out.lateJoiner.moved ?? "") && out.lateJoiner.ms != null && out.lateJoiner.ms <= 2000 && !out.lateJoiner.off && out.lateJoiner.window,
      secondRoundOnClock: out.open2.clock === CLOCK_SEC * 1000 && /^Bets close in \d:\d\d$/.test(out.playerTable2?.state ?? "") && out.bet3.landed && out.afterBet3.purseCp === out.afterRefund.purseCp - 100,
      formGoneWhenClosed: out.playerTableClosed && !out.playerTableClosed.form && /Bets are closed/.test(out.playerTableClosed.state ?? ""),
      keptInGrace: out.inGrace.staleAt === out.inGrace.closedAt + out.inGrace.grace && out.recoveredInGrace.refunded === 0 && out.recoveredInGrace.voided === 0 && out.recoveredInGrace.round !== "resolved" && out.recoveredInGrace.row?.status === "open",
      staleBetRefundedWithoutReload: out.recovered.ms != null && out.recovered.ms <= 3000 && !out.recovered.reloaded && out.recovered.round === "resolved" && out.recovered.voided && out.recovered.row?.status === "refunded" && out.recovered.row.refundReason === "stale" && out.recovered.notice.some(s => /1 open stake from a round that never spun was refunded/.test(s)) && out.afterRecover.purseCp === out.afterRefund.purseCp,
      gmHiddenLandedAtOnce: !HIDE_GM || (out.gmLanded?.landed && out.gmLanded.button === "Close"),
      calledOffOnPlayer: /called off; every stake came back/.test(out.playerTableVoid?.state ?? "") && out.playerTableVoid.chips === 0 && !out.playerTableVoid.form,
    };
    out.ok = Object.values(out.checks).every(Boolean);
    out.gmConsole = gm.logs.filter(l => !l.includes("timings"));
    out.playerLog = pl.logs;
  } catch (err) {
    out.error = String(err?.stack || err);
    out.ok = false;
  } finally {
    try { out.restored = await restore(gm?.page, before); } catch (err) { out.restored = { error: String(err) }; }
    out.closeFinished = await linger.restore();
    console.log(JSON.stringify(out, null, 1));
    if (!out.ok) process.exitCode = 1;
    await browser.close();
  }
})();
