// Live check: the Deck of Many Things (deck.js) at a real table, with the
// branch's code on both ends.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/headless/live-deck.cjs [--shot out.png]
//
// Env: PLAYER (default Player2, must own Crate Tester), DECK (the deck's
// name, default "Live deck"), HIDE_GM=1 (the GM's tab in the background).
//
// Two headless clients, the Gamemaster and the player, each with the
// installed module's socket listener removed and the branch's registered
// from MODULE_BASE (as player-pull.cjs does). The GM seeds "Live deck" (10
// gp a draw, half again for each draw in a row; three cards, every one
// once per deck: an item card drawing from "Live UI pool", a loss of 5 gp,
// an effect with GM text), reshuffles it so every card is in, waits out
// the two-minute window of any draw Crate Tester made at it just before
// (so the first draw here is a first draw, at 10 gp), and notes the purse,
// the log and the chat. Then, as a person does:
//
//   1. The player opens the shop, picks Crate Tester and presses the deck's
//      "Draw for 10 gp". Every animation frame to the landing (.lc-deck--
//      landed, as the frame loop sees it) is watched: the card must stay
//      face-down through its lift and hold (frames with its back to the
//      viewer, the first turned frame no earlier than 1.1 s after the
//      window opened and within half a second of the landing), and the
//      pull's chat card must render sealed ("Opening…", its item block
//      hidden) until the landing. The
//      reveal's card, result (in a live region), focus (on Close), Watch
//      again (none) and Draw again (shown to the buyer, "Draw again for 15
//      gp") are read; the GM's reveal must show the same card. The item is
//      granted only if the card was the item card.
//   2. The player presses Draw again in that window: this window must close
//      and a second open, held and turned the same way, at 15 gp, with the
//      head saying "2nd in a row", the cards left down to "1 of 3 cards
//      left" and Draw again now at 22 gp 5 sp. The purse must have dropped
//      by 10 gp then 15 gp (plus or less what the cards did), and the two
//      rows must carry their prices and cards.
//   3. The GM opens the Pull log by its tab, presses Refund on the second
//      row and Yes: the confirm names what moves, the purse goes back by
//      what the second draw cost, its item (if any) is gone, the card is
//      back in the deck ("2 of 3 cards left" on the player's card within
//      2 s) and the price step is back ("Draw for 15 gp": the first draw
//      is still within two minutes).
//
// Restored in a finally: the deck's record as it was (or left seeded when
// new this run); the first draw stands, as every live purchase does.
// Nothing is deleted. Needs "Crate Tester" in "Loot Crates Test" and "Live
// UI pool" (live-ui.js makes them).
/* global game, foundry, Hooks -- used inside page.evaluate, which runs in the Foundry page */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const DECK = process.env.DECK || "Live deck";
const HIDE_GM = process.env.HIDE_GM === "1";
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

// The GM's side: seed the deck, note what is to be restored.
async function seed(gm) {
  return gm.evaluate(async ({ base, name }) => {
    const store = await import(base + "scripts/store.js");
    const { toCopper } = await import(base + "scripts/currency.js");
    const folder = game.folders.find(f => f.type === "Actor" && f.name === "Loot Crates Test");
    const actor = game.actors.find(a => a.name === "Crate Tester" && a.folder?.id === folder?.id);
    if (!actor) throw new Error("no Crate Tester in Loot Crates Test: run live-pull.js first");
    if ((actor.system.currency.gp ?? 0) < 60) await actor.update({ "system.currency.gp": 1000 });
    const pool = Object.values(store.getPools()).find(p => p.name === "Live UI pool");
    if (!pool) throw new Error("no Live UI pool: run live-ui.js first");
    const old = Object.values(store.getBoxes()).find(b => b.name === name) ?? null;
    const deck = await store.saveBox({
      ...(old ? { id: old.id } : {}), kind: "deck", name, price: 10, pools: [{ id: pool.id, share: 1 }],
      weights: { common: 1, uncommon: 1, rare: 1, veryRare: 1, legendary: 1, artifact: 1 },
      deck: { step: 1.5, shuffledAt: Date.now(), cards: [
        { id: "live-item", label: "Live fortune", kind: "item", weight: 1, once: true },
        { id: "live-loss", label: "Live ruin", kind: "loss", weight: 1, once: true, gp: 5 },
        { id: "live-omen", label: "Live omen", kind: "effect", weight: 1, once: true, text: "The GM decides what the omen means." },
      ] },
      rules: {},
    });
    // A draw at this deck within the last two minutes would make the first
    // draw here the second in a row (deck.js STREAK_MS): wait it out.
    const { STREAK_MS } = await import(base + "scripts/deck.js");
    const last = Math.max(0, ...store.getLog().filter(r => r.kind === "deck" && r.boxId === deck.id && r.actorId === actor.id && !r.refunded).map(r => r.at || 0));
    const waitMs = Math.max(0, last + STREAK_MS + 2000 - Date.now());
    if (waitMs) await new Promise(r => setTimeout(r, waitMs));
    return {
      actorId: actor.id, deckId: deck.id, old, waitedMs: waitMs,
      purseCp: toCopper(actor.system.currency), items: actor.items.size,
      logIds: store.getLog().map(r => r.id), messages: game.messages.size,
    };
  }, { base: MODULE_BASE, name: DECK });
}

async function restore(gm, before) {
  if (!gm || !before) return null;
  return gm.evaluate(async ({ base, before, name }) => {
    const out = {};
    try {
      const store = await import(base + "scripts/store.js");
      if (before.old) { await store.saveBox(before.old); out.deck = "restored"; }
      else { const d = Object.values(store.getBoxes()).find(b => b.name === name); out.deck = d ? "left seeded (new this run)" : "none"; }
    } catch (err) { out.error = String(err?.stack || err); }
    return out;
  }, { base: MODULE_BASE, before, name: DECK });
}

// What a client's newest reveal shows.
const readReveal = page => page.evaluate(() => {
  const rv = [...document.querySelectorAll(".application.lc-reveal")].at(-1);
  if (!rv) return null;
  const result = rv.querySelector(".lc-reveal__result");
  const again = rv.querySelector(".lc-reveal__again");
  return {
    card: rv.querySelector(".lc-deck__label")?.textContent.trim() ?? null,
    kind: rv.querySelector(".lc-deck__kind")?.textContent.trim() ?? null,
    tone: rv.querySelector(".lc-deck")?.dataset.tone ?? null,
    landed: !!rv.querySelector(".lc-deck--landed"),
    head: rv.querySelector(".lc-reveal__head")?.innerText.replace(/\s+/g, " ").trim() ?? null,
    result: result?.innerText.replace(/\s+/g, " ").trim() ?? null,
    liveRegion: !!result?.closest("[aria-live]"),
    button: rv.querySelector(".lc-reveal__close")?.textContent.trim() ?? null,
    watchAgain: !!(rv.querySelector(".lc-reveal__watch") && !rv.querySelector(".lc-reveal__watch").hidden),
    again: again && !again.hidden ? { text: again.textContent.trim(), off: again.getAttribute("aria-disabled") === "true", why: rv.querySelector(".lc-reveal__why")?.textContent.trim() ?? "" } : null,
    openItem: !!(rv.querySelector(".lc-reveal__open") && !rv.querySelector(".lc-reveal__open").hidden),
  };
});

/*
  One draw on the player's page, from `press` (the shop's Buy, or the open
  reveal's Draw again), watched frame by frame to the landing: the new
  window's card front must never face the viewer before the turn, and the
  pull's chat card must render sealed until then.
*/
const drawAndWatch = (page, { deckId, press }) => page.evaluate(async ({ base, deckId, press }) => {
  const app = [...foundry.applications.instances.values()].find(a => a.options?.id === "loot-crates-shop");
  const card = () => app?.element?.querySelector(`.lc-box[data-box="${deckId}"]`);
  const readCard = () => ({
    buy: card()?.querySelector(".lc-box__buy")?.textContent.trim() ?? null,
    price: card()?.querySelector(".lc-box__buy")?.dataset.price ?? null,
    off: card()?.querySelector(".lc-box__buy")?.getAttribute("aria-disabled") === "true",
    why: card()?.querySelector(".lc-box__why")?.textContent.trim() ?? "",
    left: card()?.querySelector(".lc-box__stock")?.textContent.trim() ?? "",
    rule: card()?.querySelector(".lc-box__rule")?.textContent.trim() ?? "",
    pills: [...(card()?.querySelectorAll(".lc-odd") ?? [])].map(p => p.textContent.trim()),
  });
  globalThis.__lcCard = readCard;
  const before = readCard();
  const seen = new Set(document.querySelectorAll(".lc-reveal"));
  const openBefore = [...document.querySelectorAll(".application.lc-reveal")];
  const renders = [];
  const onRender = (m, html) => {
    if (!m.flags?.["loot-crates"]?.logId) return;
    renders.push({ ms: performance.now() - t0, sealed: !!html.querySelector(".lc-chat--sealed"), itemShown: (html.querySelector(".lc-chat__item")?.getClientRects().length ?? 0) > 0, opening: /Opening…/.test(html.textContent) });
  };
  const hookId = Hooks.on("renderChatMessageHTML", onRender);
  let button;
  if (press === "buy") button = card()?.querySelector(".lc-box__buy");
  else button = openBefore.at(-1)?.querySelector(".lc-reveal__again");
  if (!button) throw new Error(`no ${press} button to press`);
  if (button.getAttribute("aria-disabled") === "true") throw new Error(`${press} is off: ${readCard().why || openBefore.at(-1)?.querySelector(".lc-reveal__why")?.textContent}`);
  button.focus();
  const t0 = performance.now();
  button.click();
  const turnedOf = rv => { const c = rv?.querySelector(".lc-deck__card"); if (!c) return null; const m = new DOMMatrix(getComputedStyle(c).transform); return m.m11 < 0; };
  let frames = 0, heldFrames = 0, firstTurnMs = null, landedFrameMs = null, done = false;
  const frame = () => {
    if (done) return;
    const rv = [...document.querySelectorAll(".lc-reveal")].find(el => !seen.has(el));
    if (rv?.querySelector(".lc-deck--landed")) { landedFrameMs ??= Math.round(performance.now() - t0); return; }
    frames++;
    if (rv) {
      if (turnedOf(rv)) firstTurnMs ??= Math.round(performance.now() - t0);
      else if (firstTurnMs == null) heldFrames++;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  let rv = null, revealMs = null, landedMs = null, drawingLabel = null;
  for (let i = 0; i < 400 && landedMs == null; i++) {
    await new Promise(r => setTimeout(r, 50));
    if (press === "again") { const l = openBefore.at(-1)?.querySelector(".lc-reveal__again")?.textContent.trim(); if (l && l !== "Draw again for 15 gp") drawingLabel ??= l; }
    rv ??= [...document.querySelectorAll(".lc-reveal")].find(el => !seen.has(el)) ?? null;
    if (rv && revealMs == null) revealMs = Math.round(performance.now() - t0);
    if (rv?.querySelector(".lc-deck--landed")) landedMs = Math.round(performance.now() - t0);
  }
  done = true;
  await new Promise(r => setTimeout(r, 1200));
  Hooks.off("renderChatMessageHTML", hookId);
  const landedAt = landedFrameMs ?? landedMs;
  const result = rv?.querySelector(".lc-reveal__result");
  const again = rv?.querySelector(".lc-reveal__again");
  const reveal = rv ? {
    ms: { reveal: revealMs, landed: landedAt },
    card: rv.querySelector(".lc-deck__label")?.textContent.trim() ?? null,
    kind: rv.querySelector(".lc-deck__kind")?.textContent.trim() ?? null,
    tone: rv.querySelector(".lc-deck")?.dataset.tone ?? null,
    head: rv.querySelector(".lc-reveal__head")?.innerText.replace(/\s+/g, " ").trim() ?? null,
    result: result?.innerText.replace(/\s+/g, " ").trim() ?? null,
    liveRegion: !!result?.closest("[aria-live]"),
    focusOnClose: document.activeElement?.matches?.(".lc-reveal__close") ?? false,
    watchAgain: !!(rv.querySelector(".lc-reveal__watch") && !rv.querySelector(".lc-reveal__watch").hidden),
    again: again && !again.hidden ? { text: again.textContent.trim(), off: again.getAttribute("aria-disabled") === "true", why: rv.querySelector(".lc-reveal__why")?.textContent.trim() ?? "" } : null,
    openItem: !!(rv.querySelector(".lc-reveal__open") && !rv.querySelector(".lc-reveal__open").hidden),
  } : null;
  const openAfter = [...document.querySelectorAll(".application.lc-reveal")].length;
  const previousClosed = press === "again" ? !openBefore.at(-1)?.isConnected : null;
  const actor = game.actors.find(a => a.isOwner && a.type === "character");
  const { getLog } = await import(base + "scripts/store.js");
  const row = getLog().filter(r => r.boxId === deckId).sort((a, b) => b.at - a.at)[0] ?? null;
  return {
    before, reveal, frames, heldFrames, firstTurnMs, renders: renders.map(r => ({ ...r, ms: Math.round(r.ms) })), landedAt, openAfter, previousClosed, drawingLabel,
    purse: foundry.utils.deepClone(actor.system.currency), items: actor.items.size, cardAfter: readCard(),
    row: row && { id: row.id, cardId: row.cardId, card: row.card, cardKind: row.cardKind, tone: row.tone, once: row.once, price: row.price, payoutCp: row.payoutCp, itemId: row.itemId, streak: row.streak, item: row.itemId ? { name: actor.items.get(row.itemId)?.name ?? null, type: actor.items.get(row.itemId)?.type ?? null } : null },
  };
}, { base: MODULE_BASE, deckId, press });

// The GM refunds a row from the Pull log, as a person does: the tab, Refund, Yes.
async function refundFromLog(gm, rowId) {
  return gm.evaluate(async ({ base, rowId }) => {
    const { openManager } = await import(base + "scripts/manager.js");
    const store = await import(base + "scripts/store.js");
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

(async () => {
  const browser = await chromium.launch();
  const out = { player: PLAYER, deck: DECK, gm: null, hideGm: HIDE_GM };
  let gm = null, before = null;
  try {
    const pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");
    out.gm = "headless Gamemaster running the branch";
    before = await seed(gm.page);
    out.before = { purseCp: before.purseCp, items: before.items, rows: before.logIds.length, messages: before.messages, waitedMs: before.waitedMs };
    if (HIDE_GM) {
      out.gmHidden = await gm.page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
        document.dispatchEvent(new Event("visibilitychange"));
        return document.visibilityState;
      });
    }
    // The shop, open on Crate Tester.
    out.shop = await pl.page.evaluate(async ({ base, deckId }) => {
      const { openShop } = await import(base + "scripts/shop.js");
      const actor = game.actors.find(a => a.isOwner && a.type === "character");
      if (!actor) throw new Error(`${game.user.name} owns no character`);
      const app = openShop();
      await new Promise(r => setTimeout(r, 1500));
      const pick = app.element.querySelector(".lc-shop__actor");
      if (pick && pick.value !== actor.id) { pick.value = actor.id; pick.dispatchEvent(new Event("change")); await new Promise(r => setTimeout(r, 800)); }
      const card = app.element.querySelector(`.lc-box[data-box="${deckId}"]`);
      return { found: !!card, buy: card?.querySelector(".lc-box__buy")?.textContent.trim() ?? null, pills: [...(card?.querySelectorAll(".lc-odd") ?? [])].map(p => p.textContent.trim()), left: card?.querySelector(".lc-box__stock")?.textContent.trim() ?? "" };
    }, { base: MODULE_BASE, deckId: before.deckId });

    // 1. The first draw, from the shop's Buy.
    out.first = await drawAndWatch(pl.page, { deckId: before.deckId, press: "buy" });
    out.gmFirst = await readReveal(gm.page);
    // 2. The second, from the window's Draw again.
    out.second = await drawAndWatch(pl.page, { deckId: before.deckId, press: "again" });
    out.gmSecond = await readReveal(gm.page);
    const rows = await gm.page.evaluate(async ({ base, before }) => {
      const store = await import(base + "scripts/store.js");
      const { toCopper } = await import(base + "scripts/currency.js");
      const actor = game.actors.get(before.actorId);
      const fresh = store.getLog().filter(r => !before.logIds.includes(r.id)).sort((a, b) => a.at - b.at);
      return { purseCp: toCopper(actor.system.currency), items: actor.items.size, messages: game.messages.size, rows: fresh.map(r => ({ id: r.id, cardId: r.cardId, tone: r.tone, price: r.price, payoutCp: r.payoutCp, itemId: r.itemId, streak: r.streak, once: r.once })) };
    }, { base: MODULE_BASE, before });
    out.gmAfterDraws = rows;
    // Close the second window as the player would, so the card's "Still turning" clears.
    await pl.page.evaluate(async () => {
      for (const app of [...foundry.applications.instances.values()].filter(a => a.options?.classes?.includes("lc-reveal"))) await app.close();
      await new Promise(r => setTimeout(r, 600));
    });
    out.cardAfterDraws = await pl.page.evaluate(() => globalThis.__lcCard());

    // 3. The GM refunds the second draw.
    const second = rows.rows[1];
    if (!second) throw new Error("no row for the second draw");
    out.refund = await refundFromLog(gm.page, second.id);
    out.afterRefund = await gm.page.evaluate(async ({ base, before }) => {
      const { toCopper } = await import(base + "scripts/currency.js");
      const actor = game.actors.get(before.actorId);
      return { purseCp: toCopper(actor.system.currency), items: actor.items.size };
    }, { base: MODULE_BASE, before });
    out.cardAfterRefund = await pl.page.evaluate(async since => {
      for (let i = 0; i < 250; i++) {
        const c = globalThis.__lcCard();
        if (c.left === "2 of 3 cards left") return { ...c, ms: Date.now() - since };
        await new Promise(r => setTimeout(r, 20));
      }
      return { ...globalThis.__lcCard(), ms: null };
    }, out.refund.at);
    if (shot) await pl.page.screenshot({ path: shot });

    const f = out.first, s = out.second;
    const [r1, r2] = rows.rows;
    const net = r => Math.round(r.price * 100) - Math.round(r.payoutCp || 0);
    const cardName = { "live-item": "Live fortune", "live-loss": "Live ruin", "live-omen": "Live omen" };
    const toneOf = { "live-item": "boon", "live-loss": "bane", "live-omen": "effect" };
    const sealedUntilTurn = d => d.renders.filter(x => x.ms < d.landedAt).every(x => x.sealed && !x.itemShown && x.opening) && d.renders.length > 0 && d.renders.some(x => x.ms >= d.landedAt ? !x.sealed : true);
    // Face-down through the lift and the hold (1.2 s), turned only in the flip's last 420 ms before landing.
    const heldThenTurned = d => d.heldFrames > 0 && d.firstTurnMs != null && d.firstTurnMs - d.reveal.ms.reveal >= 1100 && d.landedAt - d.firstTurnMs <= 520;
    out.checks = {
      shopCard: out.shop.found && out.shop.buy === `${DECK}: Draw for 10 gp` && out.shop.left === "3 of 3 cards left" && out.shop.pills.join(", ") === "Item 34%, Loss 33%, Effect 33%",
      twoRows: rows.rows.length === 2 && r1.price === 10 && r2.price === 15 && r1.streak === 1 && r2.streak === 2 && r1.cardId !== r2.cardId && rows.rows.every(r => r.once === true),
      firstHeldThenTurned: f.frames > 0 && heldThenTurned(f) && f.reveal?.tone === toneOf[r1.cardId] && f.reveal.card === cardName[r1.cardId] && f.reveal.ms.landed != null && f.reveal.ms.landed <= 6000,
      secondHeldThenTurned: s.frames > 0 && heldThenTurned(s) && s.reveal?.tone === toneOf[r2.cardId] && s.reveal.card === cardName[r2.cardId] && s.reveal.ms.landed != null && s.reveal.ms.landed <= 6000,
      sameCardOnGm: out.gmFirst?.card === f.reveal?.card && out.gmSecond?.card === s.reveal?.card && out.gmSecond?.landed === true,
      chatSealedUntilTurn: sealedUntilTurn(f) && sealedUntilTurn(s),
      firstWords: /draws from Live deck 10 gp$/.test(f.reveal?.head ?? "") && f.reveal.liveRegion && f.reveal.focusOnClose && !f.reveal.watchAgain && /2 of 3 cards left/.test(f.reveal.result ?? "") && /\d [gsc]p left/.test(f.reveal.result ?? ""),
      drawAgainOffered: f.reveal?.again?.text === "Draw again for 15 gp" && f.reveal.again.off === false,
      secondWords: /draws from Live deck 15 gp · 2nd in a row$/.test(s.reveal?.head ?? "") && /1 of 3 cards left/.test(s.reveal?.result ?? "") && s.reveal?.again?.text === "Draw again for 22 gp 5 sp" && s.previousClosed === true && s.openAfter === 1,
      drawingLabel: s.drawingLabel === "Drawing…",
      // At least one item per item card: a granted container brings its contents with it (dnd5e), as a crate's would.
      itemOnlyForItemCard: (r1.cardId === "live-item") === (r1.itemId != null) && (r2.cardId === "live-item") === (r2.itemId != null) && f.reveal?.openItem === (r1.cardId === "live-item") && s.reveal?.openItem === (r2.cardId === "live-item") && rows.items >= before.items + rows.rows.filter(r => r.itemId).length && (rows.rows.some(r => r.itemId) || rows.items === before.items),
      // What that check read, for the record.
      items: { before: before.items, after: rows.items, granted: [f.row?.item, s.row?.item].filter(Boolean), openItem: [f.reveal?.openItem, s.reveal?.openItem] },
      goldDroppedBaseThenStep: rows.purseCp === before.purseCp - net(r1) - net(r2) && (r1.tone !== "bane" || r1.payoutCp === -500) && (r2.tone !== "bane" || r2.payoutCp === -500),
      cardsLeftDrop: f.cardAfter.left === "2 of 3 cards left" && (s.cardAfter.left === "1 of 3 cards left" || out.cardAfterDraws.left === "1 of 3 cards left") && out.cardAfterDraws.buy === `${DECK}: Draw for 22 gp 5 sp` && /3rd draw in a row: 22 gp 5 sp/.test(out.cardAfterDraws.rule),
      refund: out.refund.refunded != null && out.afterRefund.purseCp === rows.purseCp + net(r2) && (r2.itemId ? out.afterRefund.items < rows.items : out.afterRefund.items === rows.items) && /Crate Tester/.test(out.refund.dialogText ?? ""),
      cardAfterRefund: out.cardAfterRefund.ms != null && out.cardAfterRefund.ms <= 2000 && out.cardAfterRefund.left === "2 of 3 cards left" && out.cardAfterRefund.buy === `${DECK}: Draw for 15 gp` && /2nd draw in a row: 15 gp/.test(out.cardAfterRefund.rule),
      gmHiddenLandedAtOnce: !HIDE_GM || (out.gmFirst?.landed && out.gmFirst.button === "Close"),
    };
    out.detail = { items: out.checks.items };
    delete out.checks.items;
    out.ok = Object.values(out.checks).every(Boolean);
    out.gmTimings = gm.logs.filter(l => l.includes("timings"));
    out.gmConsole = gm.logs.filter(l => !l.includes("timings"));
    out.playerLog = pl.logs;
  } catch (err) {
    out.error = String(err?.stack || err);
    out.ok = false;
  } finally {
    try { out.restored = await restore(gm?.page, before); } catch (err) { out.restored = { error: String(err) }; }
    console.log(JSON.stringify(out, null, 1));
    if (!out.ok) process.exitCode = 1;
    await browser.close();
  }
})();
