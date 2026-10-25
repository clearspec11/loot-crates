// Live check: Dragon's Teeth (dicegame.js) at a real table, with the
// branch's code on both ends.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/headless/live-dice.cjs [--shot out.png]
//
// Env: PLAYER (default Player2, must own Crate Tester), GAME (the game's
// name, default "Live dice"), HIDE_GM=1 (the GM's tab in the background),
// WATCHER=<user> (a third seat that joins with its tab hidden; default: the
// first free seat besides the two, none if there isn't one), MANUAL=1 (the
// GM's d6 fulfillment set to manual entry for the run, put back after),
// SHORT=1 (the winnings are spent before the refund, so the refund must be
// refused naming the shortfall and change nothing; then the purse is put
// back and the refund made).
//
// Three headless clients at most: the Gamemaster, the player and the
// watcher, each with the installed module's socket listener removed and
// the branch's registered from MODULE_BASE (as player-pull.cjs does). The
// GM seeds "Live dice" (10 gp to roll 3d6 over the dragon's 3, so all but
// 1, 1, 1 win; pays 3x, no prize) and notes the purse, the log and the
// chat. Then, as a person does:
//
//   1. The player opens the shop, picks Crate Tester and presses Bet once.
//      Every animation frame from the click to the landing (.lc-dice--
//      landed) is watched for the verdict or the total showing anywhere in
//      the chat log (a leak; must be 0 frames), and every rendering of the
//      pull's chat card is noted with whether it was sealed. The dice
//      themselves are watched too: a settled die's foot must keep the
//      vault's line until the stage tells the total (lc-dice--told; 0
//      frames otherwise), and take the win's colour from then; with Dice So
//      Nice active (it stays on: real tables use it) the stage waits on the
//      3D roll and tells the total a frame before it lands, and the run
//      reports the path it took (bet.path, "3D" or "2D"). The reveal's
//      faces, total, result (in a live region), focus (on Close) and
//      Watch again (none) are read; the GM's reveal (and the watcher's,
//      landed at once in its hidden tab) must show the same faces. The
//      newest chat message must carry no Roll, and the purse must change
//      by exactly payout - stake. MANUAL=1 also watches the GM's page for
//      a manual-roll prompt (none may appear) and wants the reveal within
//      2.5 s of the click.
//   2. SHORT=1: the GM spends the winnings (the purse set below what the
//      refund would take back), opens the Pull log by its tab and presses
//      the new row's Refund: the dialog must name the shortfall ("has
//      spent ... Nothing was refunded"), its Close must leave the row
//      unrefunded and the purse and chat unchanged; the purse is then put
//      back.
//   3. The GM opens the Pull log by its tab, presses Refund on the new row
//      and Yes: the confirm names what moves ("Take 20 gp back" on a win,
//      "Return 10 gp" on a loss), the purse returns to its start value,
//      the row reads refunded and the card in chat is marked refunded on
//      the player's client.
//
// Restored in a finally: the GM's dice configuration (MANUAL), the purse
// (SHORT, if the check died mid-way), and the game's record. One real
// purchase, refunded; nothing is deleted. Needs "Crate Tester" in "Loot
// Crates Test" (live-pull.js makes it).
/* global game, foundry, Hooks, ui -- used inside page.evaluate, which runs in the Foundry page */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const GAME = process.env.GAME || "Live dice";
const HIDE_GM = process.env.HIDE_GM === "1";
const MANUAL = process.env.MANUAL === "1";
const SHORT = process.env.SHORT === "1";
const WATCHER = process.env.WATCHER ?? "";
const shot = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : null;

async function freeSeats(browser) {
  const page = await (await browser.newContext()).newPage();
  await page.goto(FOUNDRY + "/join", { waitUntil: "networkidle" });
  const seats = await page.$$eval("select[name=userId] option", os => os.filter(o => !o.disabled && o.value).map(o => o.textContent.trim()));
  await page.context().close();
  return seats;
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
  await page.evaluate(async base => (await import(base + "scripts/i18n.js")).loadStrings(), MODULE_BASE);
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
    const store = await import(base + "scripts/store.js");
    try { store.registerSettings(); } catch { /* the installed module registered them */ }
    try { store.registerIndexFields?.(); } catch { /* already in CONFIG */ }
    const socket = await import(base + "scripts/socket.js");
    socket.registerSocket();
    const { storeRedraw } = await import(base + "scripts/redraw.js");
    const { refreshShop, registerShopHooks } = await import(base + "scripts/shop.js");
    const { refreshManager } = await import(base + "scripts/manager.js");
    const redraw = storeRedraw({ refreshShop, refreshManager });
    store.setStoreListener(redraw);
    for (const key of store.WORLD_KEYS) {
      const cfg = game.settings.settings.get(`loot-crates.${key}`);
      if (cfg && !String(cfg.onChange ?? "").includes("storeChanged")) cfg.onChange = () => redraw(key);
    }
    registerShopHooks?.(Hooks);
    const { sealChatCard, watchAgain, preSealItem } = await import(base + "scripts/reveal.js");
    Hooks.on("renderChatMessageHTML", sealChatCard);
    Hooks.on("renderChatMessageHTML", watchAgain);
    for (const h of [...(Hooks.events?.createItem ?? [])]) if (h.fn?.name === "preSealItem") Hooks.off("createItem", h.id);
    Hooks.on("createItem", preSealItem);
  }, MODULE_BASE);
  return { page, logs };
}

const hide = page => page.evaluate(() => {
  globalThis.__lcToasts = [];
  for (const kind of ["info", "warn", "error"]) {
    const orig = ui.notifications[kind].bind(ui.notifications);
    ui.notifications[kind] = (msg, opts) => { globalThis.__lcToasts.push({ kind, msg: String(msg) }); return orig(msg, opts); };
  }
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
  document.dispatchEvent(new Event("visibilitychange"));
  return document.visibilityState;
});

// The GM's side: seed the game, note what is to be restored.
async function seed(gm) {
  return gm.evaluate(async ({ base, name, manual }) => {
    const store = await import(base + "scripts/store.js");
    const { toCopper } = await import(base + "scripts/currency.js");
    const folder = game.folders.find(f => f.type === "Actor" && f.name === "Loot Crates Test");
    const actor = game.actors.find(a => a.name === "Crate Tester" && a.folder?.id === folder?.id);
    if (!actor) throw new Error("no Crate Tester in Loot Crates Test: run live-pull.js first");
    if ((actor.system.currency.gp ?? 0) < 50) await actor.update({ "system.currency.gp": 1000 });
    const old = Object.values(store.getBoxes()).find(b => b.name === name) ?? null;
    const gameRecord = await store.saveBox({
      ...(old ? { id: old.id } : {}), kind: "dice", name, price: 10, pools: [], weights: {},
      dice: { formula: "3d6", target: 3, multiplier: 3 }, rules: { prize: false, stock: null },
    });
    const diceConfig = foundry.utils.deepClone(game.settings.get("core", "diceConfiguration") ?? {});
    let manualSet = null;
    if (manual) {
      await game.settings.set("core", "diceConfiguration", { ...diceConfig, d6: "manual" });
      manualSet = game.settings.get("core", "diceConfiguration");
    }
    return {
      actorId: actor.id, gameId: gameRecord.id, old, diceConfig, manualSet,
      purse: foundry.utils.deepClone(actor.system.currency), purseCp: toCopper(actor.system.currency),
      logIds: store.getLog().map(r => r.id), messages: game.messages.size, items: actor.items.size,
    };
  }, { base: MODULE_BASE, name: GAME, manual: MANUAL });
}

async function restore(gm, before, state) {
  if (!gm || !before) return null;
  return gm.evaluate(async ({ base, before, name, state }) => {
    const out = {};
    try {
      if (before.manualSet) { await game.settings.set("core", "diceConfiguration", before.diceConfig); out.diceConfig = "restored"; }
      const actor = game.actors.get(before.actorId);
      if (state?.spentPurse && actor && JSON.stringify(actor.system.currency) === JSON.stringify(state.spentPurse)) {
        await actor.update({ "system.currency": state.wonPurse });
        out.purse = "put back after the spend";
      }
      const store = await import(base + "scripts/store.js");
      if (before.old) { await store.saveBox(before.old); out.game = "restored"; }
      else { const g = Object.values(store.getBoxes()).find(b => b.name === name); out.game = g ? "left seeded (new this run)" : "none"; }
    } catch (err) { out.error = String(err?.stack || err); }
    return out;
  }, { base: MODULE_BASE, before, name: GAME, state });
}

// What a client's newest reveal shows: the faces, the total, the result.
const readReveal = page => page.evaluate(() => {
  const rv = [...document.querySelectorAll(".application.lc-reveal")].at(-1);
  if (!rv) return null;
  const result = rv.querySelector(".lc-reveal__result");
  return {
    faces: [...rv.querySelectorAll(".lc-dice__tray .lc-dice__face")].map(f => f.textContent.trim()),
    total: rv.querySelector(".lc-dice__total")?.textContent.trim() ?? "",
    landed: !!rv.querySelector(".lc-dice--landed"),
    outcome: rv.querySelector(".lc-dice")?.dataset.outcome ?? null,
    head: rv.querySelector(".lc-reveal__head")?.innerText.replace(/\s+/g, " ").trim() ?? null,
    result: result?.innerText.replace(/\s+/g, " ").trim() ?? null,
    liveRegion: !!result?.closest("[aria-live]"),
    button: rv.querySelector(".lc-reveal__close")?.textContent.trim() ?? null,
    watchAgain: !!(rv.querySelector(".lc-reveal__watch") && !rv.querySelector(".lc-reveal__watch").hidden),
  };
});

// The GM refunds the newest row from the Pull log, as a person does: the
// tab, Refund, then the dialog's button named by `press` (Yes, or Close
// for a refused refund). Returns the dialog's text and what followed.
async function refundFromLog(gm, { rowId, press }) {
  return gm.evaluate(async ({ base, rowId, press }) => {
    const { openManager } = await import(base + "scripts/manager.js");
    const store = await import(base + "scripts/store.js");
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const until = async (fn, ms = 15000) => { for (let t = 0; t < ms && !fn(); t += 50) await wait(50); return fn(); };
    const click = el => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
    const app = openManager();
    await until(() => app.element?.querySelector('.lc-tabs [data-tab="log"]'));
    click(app.element.querySelector('.lc-tabs [data-tab="log"]'));
    const btn = () => app.element?.querySelector(`button[data-action=refund][data-row="${rowId}"]`);
    if (!await until(() => app.tab === "log" && btn(), 8000)) throw new Error("the Pull log has no Refund for the new row");
    const rowText = btn().closest("tr")?.innerText.replace(/\s+/g, " ").trim() ?? null;
    btn().focus();
    click(btn());
    const dialog = () => [...document.querySelectorAll(".application.dialog")].pop();
    const button = () => [...(dialog()?.querySelectorAll("button") ?? [])].find(b => new RegExp(press, "i").test(b.dataset.action ?? b.textContent));
    await until(() => button());
    const dialogText = dialog()?.querySelector(".window-content")?.textContent.replace(/\s+/g, " ").trim() ?? null;
    const buttons = [...(dialog()?.querySelectorAll("button") ?? [])].map(b => b.textContent.trim());
    const at = Date.now();
    click(button());
    await until(() => !dialog(), 8000);
    if (press === "yes") await until(() => store.getLog().find(r => r.id === rowId)?.refunded, 8000);
    await wait(800);
    const row = store.getLog().find(r => r.id === rowId);
    const focus = document.activeElement?.matches?.(`[data-row="${rowId}"]`) ? (document.activeElement.matches("button") ? "the row's Refund" : "the row's status") : document.activeElement?.tagName ?? "none";
    const rowAfter = app.element?.querySelector(`[data-row="${rowId}"]`)?.closest("tr")?.innerText.replace(/\s+/g, " ").trim() ?? null;
    await app.close();
    return { at, rowText, dialogText, buttons, refunded: row?.refunded ?? null, focus, rowAfter };
  }, { base: MODULE_BASE, rowId, press });
}

(async () => {
  const browser = await chromium.launch();
  const out = { player: PLAYER, game: GAME, gm: null, hideGm: HIDE_GM, manual: MANUAL, short: SHORT };
  let gm = null, before = null;
  const state = {};
  try {
    const seats = await freeSeats(browser);
    const watcherName = WATCHER || seats.find(s => s !== "Gamemaster" && s !== PLAYER) || "";
    const pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");
    out.gm = "headless Gamemaster running the branch";
    const watcher = watcherName ? await join(browser, watcherName) : null;
    out.watcher = watcher ? `${watcherName}, tab hidden` : "none (no free seat)";
    before = await seed(gm.page);
    out.before = { purseCp: before.purseCp, rows: before.logIds.length, messages: before.messages, items: before.items, manualSet: before.manualSet ? before.manualSet.d6 : null };
    if (HIDE_GM) out.gmHidden = await hide(gm.page);
    if (watcher) await hide(watcher.page);

    // 1. One bet through the shop's own button, every frame watched.
    out.bet = await pl.page.evaluate(async ({ base, gameId }) => {
      const { openShop } = await import(base + "scripts/shop.js");
      const actor = game.actors.find(a => a.isOwner && a.type === "character");
      if (!actor) throw new Error(`${game.user.name} owns no character`);
      const app = openShop();
      await new Promise(r => setTimeout(r, 1500));
      const pick = app.element.querySelector(".lc-shop__actor");
      if (pick && pick.value !== actor.id) { pick.value = actor.id; pick.dispatchEvent(new Event("change")); await new Promise(r => setTimeout(r, 800)); }
      const card = () => app.element.querySelector(`.lc-box[data-box="${gameId}"]`);
      const read = () => ({
        buy: card()?.querySelector(".lc-box__buy")?.textContent.trim() ?? null,
        off: card()?.querySelector(".lc-box__buy")?.getAttribute("aria-disabled") === "true",
        why: card()?.querySelector(".lc-box__why")?.textContent.trim() ?? "",
        rule: card()?.querySelector(".lc-box__rule")?.textContent.trim() ?? "",
        pays: card()?.querySelector(".lc-box__stock")?.textContent.trim() ?? "",
        pills: [...(card()?.querySelectorAll(".lc-odd") ?? [])].map(p => p.textContent.trim()),
      });
      globalThis.__lcCard = read;
      const start = read();
      const buy = card()?.querySelector(".lc-box__buy");
      if (!buy) throw new Error("no dice card in the shop");
      if (buy.getAttribute("aria-disabled") === "true") throw new Error(`the dice can't be bet on: ${start.why}`);
      const purseBefore = foundry.utils.deepClone(actor.system.currency);
      // Chat cards as this client sees them: when each was created, and
      // whether each rendering was sealed.
      const cards = [];
      Hooks.on("createChatMessage", m => { if (m.flags?.["loot-crates"]) cards.push({ id: m.id, at: performance.now(), rolls: m.rolls?.length ?? 0, logId: m.flags["loot-crates"].logId ?? null }); });
      const renders = [];
      Hooks.on("renderChatMessageHTML", (m, html) => {
        if (!m.flags?.["loot-crates"]?.logId) return;
        // `hidden`: the whole message hidden while sealed (reveal.js: the
        // dice post a card only for a win, so the card's arrival would tell).
        renders.push({ ms: performance.now(), sealed: !!html.querySelector(".lc-chat--sealed"), hidden: html.style?.display === "none", verdictShown: !!html.querySelector(".lc-chat__name") && html.querySelector(".lc-chat__item")?.getClientRects().length > 0 });
      });
      const seen = new Set(document.querySelectorAll(".lc-reveal"));
      buy.focus();
      const t0 = performance.now();
      buy.click();
      // Every frame until the landing: the chat log must show no verdict
      // and no total of this pull. Only messages that arrive after the
      // click count: an earlier run's (refunded) dice card is in the log.
      let leakFrames = 0, shownFrames = 0, frames = 0, done = false, landedFrameMs = null;
      const leakAt = [], shownAt = [];
      // The dice's feet: the vault's own line, read off a die before any has
      // settled; a settled die must keep it until the stage is told the
      // total, or the first die to land reads the win 440 ms early.
      let footTellFrames = 0, lineColor = null, feetAtTotal = null, threeFrames = 0;
      const footTellAt = [];
      const watchFeet = r => {
        const stage = r?.querySelector(".lc-dice");
        if (!stage) return;
        // The path the stage took: Dice So Nice's 3D roll (lc-dice--three
        // while it waits) or the 2D tumble.
        if (stage.classList.contains("lc-dice--three")) threeFrames++;
        const dice = [...stage.querySelectorAll(".lc-dice__die")];
        const loose = dice.find(d => !d.classList.contains("lc-dice__die--set"));
        if (loose) lineColor ??= getComputedStyle(loose).borderBottomColor;
        const feet = dice.filter(d => d.classList.contains("lc-dice__die--set")).map(d => getComputedStyle(d).borderBottomColor);
        if (stage.classList.contains("lc-dice--told")) feetAtTotal ??= { lineColor, feet, ms: Math.round(performance.now() - t0) };
        else if (lineColor && feet.some(c => c !== lineColor)) { footTellFrames++; if (footTellAt.length < 5) footTellAt.push(Math.round(performance.now() - t0)); }
      };
      const known = new Set([...document.querySelectorAll("#chat [data-message-id]")].map(el => el.dataset.messageId));
      const newMessages = () => [...document.querySelectorAll("#chat [data-message-id]")].filter(m => !known.has(m.dataset.messageId));
      const chatLeak = () => newMessages()
        .some(m => [...m.querySelectorAll(".lc-chat .lc-chat__item")].some(el => el.getClientRects().length > 0 && /beats the dragon|doesn't beat|ties the dragon/.test(el.textContent)));
      // The pull's card showing at all (sealed or not): a card posted only
      // for a win tells the result by turning up, so the whole message must
      // stay hidden until the landing.
      const cardShown = () => newMessages().some(m => m.querySelector(".lc-chat") && m.getClientRects().length > 0);
      const frame = () => {
        if (done) return;
        // The landing as the frame loop sees it: a frame at or after it is
        // no leak (the 50 ms poll below would see the landing late and
        // count such a frame as before it).
        const r = [...document.querySelectorAll(".lc-reveal")].find(el => !seen.has(el));
        watchFeet(r);
        if (r?.querySelector(".lc-dice--landed")) { landedFrameMs ??= Math.round(performance.now() - t0); return; }
        frames++;
        if (chatLeak()) { leakFrames++; if (leakAt.length < 5) leakAt.push(Math.round(performance.now() - t0)); }
        if (cardShown()) { shownFrames++; if (shownAt.length < 5) shownAt.push(Math.round(performance.now() - t0)); }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      let rv = null, revealMs = null, landedMs = null;
      const labels = [];
      for (let i = 0; i < 600 && landedMs == null; i++) {
        await new Promise(r => setTimeout(r, 50));
        const label = card()?.querySelector(".lc-box__buy")?.textContent.trim();
        if (label && labels.at(-1)?.text !== label) labels.push({ text: label, ms: Math.round(performance.now() - t0) });
        rv ??= [...document.querySelectorAll(".lc-reveal")].find(el => !seen.has(el)) ?? null;
        if (rv && revealMs == null) revealMs = Math.round(performance.now() - t0);
        if (rv?.querySelector(".lc-dice--landed")) landedMs = Math.round(performance.now() - t0);
      }
      done = true;
      await new Promise(r => setTimeout(r, 1200));
      const result = rv?.querySelector(".lc-reveal__result");
      const reveal = {
        ms: { reveal: revealMs, landed: landedFrameMs ?? landedMs },
        faces: [...(rv?.querySelectorAll(".lc-dice__tray .lc-dice__face") ?? [])].map(f => f.textContent.trim()),
        total: rv?.querySelector(".lc-dice__total")?.textContent.trim() ?? "",
        outcome: rv?.querySelector(".lc-dice")?.dataset.outcome ?? null,
        head: rv?.querySelector(".lc-reveal__head")?.innerText.replace(/\s+/g, " ").trim() ?? null,
        result: result?.innerText.replace(/\s+/g, " ").trim() ?? null,
        liveRegion: !!result?.closest("[aria-live]"),
        watchAgain: !!(rv?.querySelector(".lc-reveal__watch") && !rv.querySelector(".lc-reveal__watch").hidden),
        focusOnClose: document.activeElement?.matches?.(".lc-reveal__close") ?? false,
      };
      const revealApp = [...foundry.applications.instances.values()].find(a => a.element === rv);
      if (revealApp) { await revealApp.close(); await new Promise(r => setTimeout(r, 500)); }
      const focusAfterClose = document.activeElement === buy ? "Buy" : document.activeElement?.tagName ?? "none";
      const chatAfter = { sealedNow: document.querySelectorAll(".lc-chat--sealed").length };
      const { getLog } = await import(base + "scripts/store.js");
      const row = getLog().filter(r => r.boxId === gameId).sort((a, b) => b.at - a.at)[0] ?? null;
      return {
        start, buyLabels: labels, purseBefore, purseAfter: foundry.utils.deepClone(actor.system.currency), reveal,
        path: threeFrames ? "3D" : "2D", threeFrames, diceSoNice: !!game.modules.get("dice-so-nice")?.active && !!game.dice3d,
        frames, leakFrames, leakAt, shownFrames, shownAt, footTellFrames, footTellAt, feetAtTotal, chatCards: cards.map(c => ({ ...c, ms: Math.round(c.at - t0) })), chatRenders: renders.map(r => ({ ms: Math.round(r.ms - t0), sealed: r.sealed, hidden: r.hidden, verdictShown: r.verdictShown })), chatAfter,
        focusAfterClose, cardAfter: read(), row: row && { id: row.id, win: row.win, faces: row.faces, total: row.total, target: row.target, price: row.price, payoutCp: row.payoutCp, name: row.name, itemId: row.itemId },
        toasts: globalThis.__lcToasts ?? null,
      };
    }, { base: MODULE_BASE, gameId: before.gameId });
    const row = out.bet.row;
    if (!row) throw new Error("no log row for the bet");
    state.wonPurse = out.bet.purseAfter;

    out.gmReveal = await readReveal(gm.page);
    if (watcher) out.watcherReveal = await readReveal(watcher.page);
    out.gmSide = await gm.page.evaluate(async ({ base, before, rowId }) => {
      const { toCopper } = await import(base + "scripts/currency.js");
      const actor = game.actors.get(before.actorId);
      const msg = game.messages.contents.filter(m => m.flags?.["loot-crates"]?.logId === rowId).at(-1) ?? null;
      return {
        purseCp: toCopper(actor.system.currency), items: actor.items.size, messages: game.messages.size,
        card: msg ? { id: msg.id, rolls: msg.rolls?.length ?? 0, hasRollHtml: /dice-roll|class="roll"/.test(msg.content), faces: (msg.content.match(/lc-dice__face--small">(\d)</g) ?? []).map(s => s.match(/(\d)/)[1]), refundedClass: /lc-chat--refunded/.test(msg.content) } : null,
        manualPrompt: !!document.querySelector(".roll-resolver, [id*='roll-resolver'], .dice-fulfillment"),
        toasts: globalThis.__lcToasts ?? null,
      };
    }, { base: MODULE_BASE, before, rowId: row.id });

    // 2. SHORT: the winnings are spent, so the refund must be refused.
    if (SHORT) {
      if (!row.win) out.short = { skipped: "the dice lost (1, 1, 1), so there are no winnings to spend" };
      else {
        const net = Math.round(row.payoutCp) - Math.round(row.price * 100);
        state.spentPurse = await gm.page.evaluate(async ({ actorId, leaveCp }) => {
          const actor = game.actors.get(actorId);
          const purse = { pp: 0, gp: Math.floor(leaveCp / 100), ep: 0, sp: Math.floor((leaveCp % 100) / 10), cp: leaveCp % 10 };
          await actor.update({ "system.currency": purse });
          return foundry.utils.deepClone(actor.system.currency);
        }, { actorId: before.actorId, leaveCp: Math.max(0, net - 500) });
        const refused = await refundFromLog(gm.page, { rowId: row.id, press: "close|ok" });
        const after = await gm.page.evaluate(async ({ base, actorId, rowId }) => {
          const { getLog } = await import(base + "scripts/store.js");
          const actor = game.actors.get(actorId);
          return { purse: foundry.utils.deepClone(actor.system.currency), refunded: getLog().find(r => r.id === rowId)?.refunded ?? null, messages: game.messages.size };
        }, { base: MODULE_BASE, actorId: before.actorId, rowId: row.id });
        // The purse back to where the win left it.
        await gm.page.evaluate(async ({ actorId, purse }) => game.actors.get(actorId).update({ "system.currency": purse }), { actorId: before.actorId, purse: state.wonPurse });
        delete state.spentPurse;
        out.short = { net, spentPurse: state.spentPurse ?? null, refused, after, ok: /has spent .* of the .* won at Live dice .*Nothing was refunded/.test(refused.dialogText ?? "") && !refused.buttons.some(b => /yes/i.test(b)) && after.refunded == null && JSON.stringify(after.purse) !== JSON.stringify(state.wonPurse) && after.messages === out.gmSide.messages && refused.focus === "the row's Refund" };
      }
    }

    // 3. The refund proper.
    out.refund = await refundFromLog(gm.page, { rowId: row.id, press: "yes" });
    out.afterRefund = await gm.page.evaluate(async ({ base, before }) => {
      const { toCopper } = await import(base + "scripts/currency.js");
      const actor = game.actors.get(before.actorId);
      return { purseCp: toCopper(actor.system.currency), purse: foundry.utils.deepClone(actor.system.currency), items: actor.items.size };
    }, { base: MODULE_BASE, before });
    out.cardAfterRefund = await pl.page.evaluate(async since => {
      for (let i = 0; i < 250; i++) {
        const card = [...document.querySelectorAll("#chat .lc-chat")].filter(c => c.querySelector(".lc-chat__dice")).at(-1);
        if (card?.classList.contains("lc-chat--refunded")) return { refunded: true, text: card.innerText.replace(/\s+/g, " ").trim(), ms: Date.now() - since };
        await new Promise(r => setTimeout(r, 20));
      }
      const card = [...document.querySelectorAll("#chat .lc-chat")].filter(c => c.querySelector(".lc-chat__dice")).at(-1);
      return { refunded: !!card?.classList.contains("lc-chat--refunded"), text: card?.innerText.replace(/\s+/g, " ").trim() ?? null, ms: null };
    }, out.refund.at);
    if (shot) await pl.page.screenshot({ path: shot });

    const b = out.bet, r = b.reveal;
    const faces = (row.faces ?? []).map(String);
    const net = Math.round(row.payoutCp) - Math.round(row.price * 100);
    const purseDelta = (await gm.page.evaluate(async ({ base, purse }) => (await import(base + "scripts/currency.js")).toCopper(purse), { base: MODULE_BASE, purse: b.purseAfter })) - before.purseCp;
    out.checks = {
      cardWords: b.start.buy === "Live dice: Bet 10 gp" && b.start.rule === "Roll 3d6 over the dragon's 3" && b.start.pays === "Pays 3× the stake: 30 gp" && b.start.pills.join(", ") === "Win >99%, Lose <1%",
      rowIsTheRoll: faces.length === 3 && row.target === 3 && row.price === 10 && typeof row.win === "boolean" && row.payoutCp === (row.win ? 3000 : 0) && row.itemId === null,
      sameFacesEverywhere: r.faces.join() === faces.join() && out.gmReveal?.faces.join() === faces.join() && (!watcher || out.watcherReveal?.faces.join() === faces.join()),
      playerLanded: r.outcome === (row.win ? "win" : "lose") && r.total === String(row.total) && r.liveRegion && r.focusOnClose && !r.watchAgain && r.ms.landed != null && r.ms.landed <= 9500,
      resultWords: new RegExp(`^${row.win ? `${row.total} beats the dragon's 3` : `${row.total} (doesn't beat|ties) the dragon's 3.*`} Rolled ${faces.join(", ")} on 3d6 · ${row.win ? "Won 30 gp" : "Lost 10 gp"} · .* in the purse$`).test(r.result ?? ""),
      headWords: /rolls 3d6 to beat the dragon's 3 at Live dice 10 gp/.test(r.head ?? ""),
      noLeakBeforeLanding: b.leakFrames === 0 && b.frames > 0 && b.chatRenders.filter(x => x.ms < r.ms.landed).every(x => x.sealed) && b.chatAfter.sealedNow === 0,
      feetWaitForTotal: b.footTellFrames === 0 && b.feetAtTotal?.lineColor != null && b.feetAtTotal.feet.length === 3 && b.feetAtTotal.feet.every(c => (row.win ? c !== b.feetAtTotal.lineColor : c === b.feetAtTotal.lineColor)),
      cardHiddenBeforeLanding: b.shownFrames === 0 && b.chatRenders.filter(x => x.ms < r.ms.landed).every(x => x.hidden) && (!row.win || b.chatRenders.length > 0),
      noRollInChat: (row.win ? out.gmSide.card != null && out.gmSide.card.rolls === 0 && !out.gmSide.card.hasRollHtml && out.gmSide.card.faces.join() === faces.join() : out.gmSide.card == null) && b.chatCards.every(c => c.rolls === 0),
      purseMovedByPayoutLessStake: purseDelta === net && out.gmSide.purseCp === before.purseCp + net && out.gmSide.items === before.items,
      watcherLandedAtOnce: !watcher || (out.watcherReveal?.landed && out.watcherReveal.button === "Close" && !out.watcherReveal.watchAgain),
      gmHiddenLandedAtOnce: !HIDE_GM || (out.gmReveal?.landed && out.gmReveal.button === "Close"),
      noManualPrompt: !MANUAL || (!out.gmSide.manualPrompt && r.ms.reveal != null && r.ms.reveal <= 2500 && before.manualSet?.d6 === "manual"),
      short: !SHORT || !row.win || out.short?.ok === true,
      refund: /^(Take 20 gp back from|Return 10 gp to) Crate Tester\?/.test(out.refund.dialogText ?? "") && (row.win ? /^Take/ : /^Return/).test(out.refund.dialogText ?? "") && out.refund.refunded != null && out.afterRefund.purseCp === before.purseCp && out.afterRefund.items === before.items && out.refund.focus === "the row's status",
      cardReadsRefunded: !row.win || (out.cardAfterRefund.refunded && out.cardAfterRefund.ms != null && out.cardAfterRefund.ms <= 5000),
      focusBackOnBuy: b.focusAfterClose === "Buy",
    };
    out.ok = Object.values(out.checks).every(Boolean);
    out.gmTimings = gm.logs.filter(l => l.includes("timings"));
    out.gmConsole = gm.logs.filter(l => !l.includes("timings"));
    out.playerLog = pl.logs;
    if (watcher) out.watcherLog = watcher.logs;
  } catch (err) {
    out.error = String(err?.stack || err);
    out.ok = false;
  } finally {
    try { out.restored = await restore(gm?.page, before, state); } catch (err) { out.restored = { error: String(err) }; }
    console.log(JSON.stringify(out, null, 1));
    if (!out.ok) process.exitCode = 1;
    await browser.close();
  }
})();
