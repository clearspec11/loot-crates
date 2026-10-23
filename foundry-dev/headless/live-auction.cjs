// Live check: the Auction (auction.js) on the shared table window
// (tablewindow.js) at a real table, with the branch's code on both ends.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/headless/live-auction.cjs [--shot out.png]
//
// Env: PLAYER (default Player2, must own Crate Tester), AUCTION (the game's
// name, default "Live auction"), GAVEL_SEC (default 10), HIDE_GM=1 (hide
// the GM's tab; visible by default, since the GM's client runs the gavel
// and the house).
//
// Two headless clients, the Gamemaster and the player, each with the
// installed module's socket listener removed and the branch's registered
// from MODULE_BASE (as live-roulette.cjs does), the table window included.
// The GM seeds "Live auction": an item lot (an SRD item from the system's
// item compendium), bids opening at 1 gp and rising by 1 gp, no reserve, a
// GAVEL_SEC gavel, and one house bidder with a 2 gp budget and a 100%
// chance, so it answers the first bid and can't answer the second. Then,
// as people do:
//
//   1. The GM opens the Boxes tab and presses the auction's "Open the
//      auction": the round opens and the table window opens on both
//      clients, the player's form offering "Bid 1 gp".
//   2. The player presses the real "Bid 1 gp": the purse drops by 1 gp.
//   3. House bidder 1 bids 2 gp on the GM within a few seconds: Crate
//      Tester's purse is back where it started as soon as the house's bid
//      is heard, the player's board shows the house on top and the bid
//      struck, and the status line says the bid came back.
//   4. The player presses "Bid 3 gp" (the button follows the table): the
//      purse drops by 3 gp, the gavel's bar fills again, and the house,
//      out of budget, passes.
//   5. The gavel falls by itself: both clients land, the verdict "Sold to
//      Crate Tester for 3 gp." is in the player's live region with Close
//      focused, the round's one chat card is sealed until the landing, the
//      item is on Crate Tester's sheet and the purse is down exactly 3 gp.
//   6. The GM refunds the winning row from the Pull log (its tab, Refund,
//      Yes): the purse is back and the item is off the sheet.
//
// Restored in a finally: any open bid is refunded (the auction is called
// off), and the record is put back as it was, or a new one is left off the
// shelf. Nothing is deleted. Needs "Crate Tester" in "Loot Crates Test".
/* global game, Hooks */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const AUCTION = process.env.AUCTION || "Live auction";
const GAVEL_SEC = Number(process.env.GAVEL_SEC) || 10;
const HIDE_GM = process.env.HIDE_GM === "1";
const shot = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : null;

const wait = ms => new Promise(r => setTimeout(r, ms));
// A purse in copper, as currency.js toCopper counts it.
const cp = purse => (purse ? Math.round((purse.pp ?? 0) * 1000 + (purse.gp ?? 0) * 100 + (purse.ep ?? 0) * 50 + (purse.sp ?? 0) * 10 + (purse.cp ?? 0)) : null);

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
    const store = await import(base + "scripts/store.js");
    try { store.registerSettings(); } catch { /* the installed module registered them */ }
    try { store.registerIndexFields?.(); } catch { /* already in CONFIG */ }
    const socket = await import(base + "scripts/socket.js");
    socket.registerSocket();
    const { storeRedraw } = await import(base + "scripts/redraw.js");
    const { refreshShop, registerShopHooks } = await import(base + "scripts/shop.js");
    const { refreshManager } = await import(base + "scripts/manager.js");
    const { refreshTables } = await import(base + "scripts/tablewindow.js");
    const redraw = storeRedraw({ refreshShop, refreshManager, refreshTables });
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
  await wire(page);
  return { page, logs };
}

const hideTab = page => page.evaluate(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
  document.dispatchEvent(new Event("visibilitychange"));
  return document.visibilityState;
});

// The GM's side: the lot from the system's items, the auction seeded, any
// round left over called off, what is to be restored noted.
async function seed(gm) {
  return gm.evaluate(async ({ base, name, gavelSec }) => {
    const store = await import(base + "scripts/store.js");
    const { toCopper } = await import(base + "scripts/currency.js");
    const { liveRoundOf } = await import(base + "scripts/round.js");
    const { cancelRound } = await import(base + "scripts/table.js");
    const { lotFromEntry } = await import(base + "scripts/auction.js");
    const folder = game.folders.find(f => f.type === "Actor" && f.name === "Loot Crates Test");
    const actor = game.actors.find(a => a.name === "Crate Tester" && a.folder?.id === folder?.id);
    if (!actor) throw new Error("no Crate Tester in Loot Crates Test: run live-pull.js first");
    if ((actor.system.currency.gp ?? 0) < 20) await actor.update({ "system.currency.gp": 1000 });
    // An SRD item to sell: a cheap, physical one from a system compendium.
    let lot = null;
    const want = ["Potion of Healing", "Rope, Hempen (50 feet)", "Rope", "Torch", "Dagger"];
    for (const pack of game.packs.filter(p => p.documentName === "Item" && p.metadata.packageType === "system")) {
      const index = await pack.getIndex({ fields: ["type", "img"] });
      const hit = want.map(n => index.find(e => e.name === n)).find(Boolean) ?? index.find(e => store.isLootType(e.type));
      if (!hit) continue;
      const doc = await pack.getDocument(hit._id);
      if (!doc || !store.isLootType(doc.type)) continue;
      lot = lotFromEntry(store.entryFromItem(doc, doc.uuid));
      break;
    }
    if (!lot) throw new Error("no item in the system's compendia to sell");
    const old = Object.values(store.getBoxes()).find(b => b.name === name) ?? null;
    const box = await store.saveBox({
      ...(old ? { id: old.id } : {}), kind: "auction", name, price: 1, pools: [], weights: {},
      auction: { lot, increment: 1, reserve: 0, gavelSec, house: { count: 1, budget: 2, chance: 100 } },
      rules: {},
    });
    const leftover = liveRoundOf(store.getRounds(), box.id);
    if (leftover) await cancelRound(leftover.id);
    return {
      actorId: actor.id, actorName: actor.name, boxId: box.id, lot, old, leftover: !!leftover,
      purseCp: toCopper(actor.system.currency), items: actor.items.size,
      logIds: store.getLog().map(r => r.id), messages: game.messages.size,
    };
  }, { base: MODULE_BASE, name: AUCTION, gavelSec: GAVEL_SEC });
}

async function restore(gm, before) {
  if (!gm || !before) return null;
  return gm.evaluate(async ({ base, before, name }) => {
    const out = {};
    try {
      const store = await import(base + "scripts/store.js");
      const { liveRoundOf } = await import(base + "scripts/round.js");
      const { cancelRound } = await import(base + "scripts/table.js");
      const box = Object.values(store.getBoxes()).find(b => b.name === name);
      const live = box ? liveRoundOf(store.getRounds(), box.id) : null;
      if (live) out.cancelled = await cancelRound(live.id);
      if (before.old) { await store.saveBox(before.old); out.auction = "restored"; }
      else if (box) { await store.saveBox({ ...box, rules: { ...(box.rules ?? {}), shelved: false } }); out.auction = "left seeded off the shelf (new this run)"; }
      else out.auction = "none";
    } catch (err) { out.error = String(err?.stack || err); }
    return out;
  }, { base: MODULE_BASE, before, name: AUCTION });
}

// What a client's table window shows.
const readTable = page => page.evaluate(() => {
  const win = [...document.querySelectorAll(".application.lc-table")].at(-1);
  if (!win) return null;
  const text = sel => win.querySelector(sel)?.textContent.replace(/\s+/g, " ").trim() ?? null;
  const result = win.querySelector(".lc-table__result");
  const bar = win.querySelector(".lc-gavel__bar");
  return {
    title: win.querySelector(".window-title")?.textContent.trim() ?? null,
    state: text(".lc-table__state"),
    count: text(".lc-table__count"),
    lot: text(".lc-auction__lotname strong"),
    line: text(".lc-auction__line"),
    amount: text(".lc-auction__amount"),
    who: text(".lc-auction__who"),
    past: [...win.querySelectorAll(".lc-auction__past")].map(li => ({ text: li.textContent.replace(/\s+/g, " ").trim(), beaten: li.classList.contains("lc-auction__past--beaten"), mine: li.classList.contains("lc-auction__past--mine") })),
    live: text(".lc-table__live"),
    form: !!win.querySelector(".lc-table__form"),
    bet: text(".lc-table__bet"),
    spin: text(".lc-table__spin"),
    cancel: text(".lc-table__cancel"),
    button: text(".lc-reveal__close"),
    landed: !!win.querySelector(".lc-table__stage--landed"),
    stamp: text(".lc-auction__stamp"),
    bar: bar ? new DOMMatrix(getComputedStyle(bar).transform).a : null,
    reset: !!win.querySelector(".lc-gavel--reset"),
    result: result?.innerText.replace(/\s+/g, " ").trim() ?? null,
    liveRegion: !!result?.closest("[aria-live]"),
    focusOnClose: document.activeElement?.matches?.(".lc-reveal__close") ?? false,
  };
});

// The player's bid through the window's real button: the character picked
// if the player has more than one, the button pressed as it reads.
async function pressBid(page, actorId) {
  return page.evaluate(async ({ actorId }) => {
    const until = async (fn, ms = 10000) => { for (let t = 0; t < ms && !fn(); t += 50) await new Promise(r => setTimeout(r, 50)); return fn(); };
    const win = [...document.querySelectorAll(".application.lc-table")].at(-1);
    const form = win?.querySelector(".lc-table__form");
    if (!form) throw new Error("no bid form in the player's table window");
    const pick = form.querySelector('select[name="actorId"]');
    if (pick && pick.value !== actorId) { pick.value = actorId; pick.dispatchEvent(new Event("change", { bubbles: true })); }
    const btn = form.querySelector(".lc-table__bet");
    const label = btn.textContent.trim();
    const top = () => win.querySelector(".lc-auction__who")?.textContent.trim();
    const amount = () => win.querySelector(".lc-auction__amount")?.textContent.trim();
    // The board's moment with this bid on top, caught as it is drawn (the
    // house may answer it a moment later).
    let seen = null;
    const look = () => { if (!seen && top() === "Crate Tester" && `Bid ${amount()}` === label) seen = { top: top(), amount: amount(), live: win.querySelector(".lc-table__live")?.textContent ?? "" }; };
    const watch = new MutationObserver(look);
    watch.observe(win, { subtree: true, childList: true, characterData: true });
    const heard = (window.__lcHeard ?? []).length;
    btn.focus();
    const t0 = performance.now();
    btn.click();
    const busy = await until(() => btn.textContent.trim() === "Bidding…", 2000) ? "Bidding…" : btn.textContent.trim();
    await until(() => btn.textContent.trim() !== "Bidding…" && seen, 15000);
    watch.disconnect();
    const staked = (window.__lcHeard ?? []).slice(heard).find(m => m.type === "staked" && m.actorId === actorId) ?? null;
    return { label, busy, ms: Math.round(performance.now() - t0), why: form.querySelector(".lc-table__why")?.textContent ?? "", top: seen?.top ?? top(), amount: seen?.amount ?? amount(), live: seen?.live ?? "", after: btn.textContent.trim(), focusOnButton: document.activeElement === btn, stakedPurse: staked?.purse ?? null };
  }, { actorId });
}

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
    click(yes());
    await until(() => store.getLog().find(r => r.id === rowId)?.refunded, 8000);
    await wait(800);
    const rowAfter = app.element?.querySelector(`[data-row="${rowId}"]`)?.closest("tr")?.innerText.replace(/\s+/g, " ").trim() ?? null;
    await app.close();
    return { rowText, dialogText, refunded: store.getLog().find(r => r.id === rowId)?.refunded ?? null, rowAfter };
  }, { base: MODULE_BASE, rowId });
}

const purseOf = (gm, actorId, lotName) => gm.evaluate(async ({ base, actorId, lotName }) => {
  const { toCopper } = await import(base + "scripts/currency.js");
  const actor = game.actors.get(actorId);
  return { purseCp: toCopper(actor.system.currency), items: actor.items.size, lotItems: actor.items.filter(i => i.name === lotName && i.flags?.["loot-crates"]).length };
}, { base: MODULE_BASE, actorId, lotName });

const freshRows = (gm, before) => gm.evaluate(async ({ base, before }) => {
  const store = await import(base + "scripts/store.js");
  return store.getLog().filter(r => !before.logIds.includes(r.id)).sort((a, b) => a.at - b.at).map(r => ({ id: r.id, name: r.name, actorId: r.actorId, house: !!r.house, price: r.price, amount: r.stake?.amount ?? null, status: r.status, roundId: r.roundId, refunded: r.refunded ?? null, refundReason: r.refundReason ?? null, itemId: r.itemId, note: r.note ?? null }));
}, { base: MODULE_BASE, before });

(async () => {
  const browser = await chromium.launch();
  const out = { player: PLAYER, auction: AUCTION, gavelSec: GAVEL_SEC, gm: null, hideGm: HIDE_GM };
  let gm = null, before = null;
  try {
    const pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");
    out.gm = "headless Gamemaster running the branch";
    before = await seed(gm.page);
    out.before = { purseCp: before.purseCp, items: before.items, rows: before.logIds.length, messages: before.messages, leftover: before.leftover, lot: before.lot.name };
    if (HIDE_GM) out.gmHidden = await hideTab(gm.page);

    // What the player's client hears of the table (the branch's onTable), and
    // its chat from now: the round's card must render sealed until the landing.
    await pl.page.evaluate(async base => {
      const { onTable } = await import(base + "scripts/table.js");
      window.__lcHeard = [];
      onTable(m => window.__lcHeard.push(m));
      window.__lcRenders = [];
      const t0 = performance.now();
      Hooks.on("renderChatMessageHTML", (m, html) => {
        const f = m.flags?.["loot-crates"];
        if (!f?.logId) return;
        const win = [...document.querySelectorAll(".application.lc-table")].at(-1);
        window.__lcRenders.push({ logId: f.logId, ms: Math.round(performance.now() - t0), landed: !!win?.querySelector(".lc-table__stage--landed"), sealed: !!html.querySelector(".lc-chat--sealed"), verdictShown: (html.querySelector(".lc-chat__text")?.getClientRects().length ?? 0) > 0 && !html.querySelector(".lc-chat--sealed") });
      });
    }, MODULE_BASE);

    // 1. The GM opens the auction from the Boxes tab.
    out.open = await gm.page.evaluate(async ({ base, boxId }) => {
      const { openManager } = await import(base + "scripts/manager.js");
      const store = await import(base + "scripts/store.js");
      const { liveRoundOf } = await import(base + "scripts/round.js");
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const until = async (fn, ms = 15000) => { for (let t = 0; t < ms && !fn(); t += 50) await wait(50); return fn(); };
      const click = el => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
      const app = openManager();
      await until(() => app.element?.querySelector('.lc-tabs [data-tab="boxes"]'));
      click(app.element.querySelector('.lc-tabs [data-tab="boxes"]'));
      const btn = () => app.element?.querySelector(`button[data-action=openTable][data-box="${boxId}"]`);
      if (!await until(() => app.tab === "boxes" && btn(), 8000)) throw new Error("the Boxes tab has no Open the auction");
      const label = btn().textContent.trim();
      click(btn());
      const round = await until(() => liveRoundOf(store.getRounds(), boxId), 10000);
      await until(() => document.querySelector(".application.lc-table"), 10000);
      await wait(300);
      const after = app.element?.querySelector(`button[data-action=openTable][data-box="${boxId}"]`)?.textContent.trim() ?? null;
      await app.close();
      return { label, after, roundId: round?.id ?? null, gavel: round ? round.closesAt - round.opensAt : null };
    }, { base: MODULE_BASE, boxId: before.boxId });
    await pl.page.waitForFunction(() => document.querySelector(".application.lc-table .lc-table__form"), null, { timeout: 10000 }).catch(() => {});
    out.playerOpen = await readTable(pl.page);
    out.gmOpen = await readTable(gm.page);

    // 2. The player's first bid, through the real button.
    out.bid1 = await pressBid(pl.page, before.actorId);
    out.afterBid1 = await purseOf(gm.page, before.actorId, before.lot.name);

    // 3. The house answers on the GM; the player's purse comes back as it is heard.
    out.house = await pl.page.evaluate(async () => {
      const win = [...document.querySelectorAll(".application.lc-table")].at(-1);
      const t0 = performance.now();
      for (let i = 0; i < 200; i++) {
        if (win.querySelector(".lc-auction__who")?.textContent.trim() === "House bidder 1") return { ms: Math.round(performance.now() - t0) };
        await new Promise(r => setTimeout(r, 50));
      }
      return { ms: null };
    });
    out.afterHouse = await purseOf(gm.page, before.actorId, before.lot.name);
    out.playerAfterHouse = await readTable(pl.page);
    out.rowsAfterHouse = await freshRows(gm.page, before);

    // 4. The player bids again; the house, out of budget, passes.
    out.bid2 = await pressBid(pl.page, before.actorId);
    out.gavelAfterBid2 = await pl.page.evaluate(() => {
      const win = [...document.querySelectorAll(".application.lc-table")].at(-1);
      const bar = win?.querySelector(".lc-gavel__bar");
      return { reset: !!win?.querySelector(".lc-gavel--reset"), bar: bar ? new DOMMatrix(getComputedStyle(bar).transform).a : null };
    });
    out.afterBid2 = await purseOf(gm.page, before.actorId, before.lot.name);
    await wait(4500);
    out.playerBeforeHammer = await readTable(pl.page);

    // 5. The gavel falls by itself.
    out.hammer = await pl.page.evaluate(async ms => {
      const win = [...document.querySelectorAll(".application.lc-table")].at(-1);
      const t0 = performance.now();
      for (let t = 0; t < ms; t += 50) {
        if (win.querySelector(".lc-table__stage--landed")) return { ms: Math.round(performance.now() - t0) };
        await new Promise(r => setTimeout(r, 50));
      }
      return { ms: null };
    }, (GAVEL_SEC + 12) * 1000);
    await wait(1500);
    out.playerLanded = await readTable(pl.page);
    out.gmLanded = await readTable(gm.page);
    out.afterHammer = await purseOf(gm.page, before.actorId, before.lot.name);
    out.rowsSettled = await freshRows(gm.page, before);
    out.chat = await gm.page.evaluate(({ before, roundId }) => {
      const fresh = game.messages.contents.filter(m => m.flags?.["loot-crates"]?.logId === roundId);
      return { messages: game.messages.size - before.messages, roundCards: fresh.length, hasRoll: fresh.some(m => (m.rolls?.length ?? 0) > 0), text: fresh.at(-1)?.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() ?? null };
    }, { before, roundId: out.open.roundId });
    out.renders = await pl.page.evaluate(id => (window.__lcRenders ?? []).filter(r => r.logId === id), out.open.roundId);
    if (shot) await pl.page.screenshot({ path: shot });

    // 6. The GM refunds the win from the Pull log.
    const won = out.rowsSettled.find(r => r.actorId === before.actorId && r.status === "settled");
    if (!won) throw new Error("no settled row for Crate Tester's winning bid");
    out.refund = await refundFromLog(gm.page, won.id);
    out.afterRefund = await purseOf(gm.page, before.actorId, before.lot.name);

    const first = out.rowsAfterHouse.find(r => r.actorId === before.actorId);
    const house = out.rowsAfterHouse.find(r => r.house);
    out.checks = {
      openedFromBoxes: out.open.label === "Open the auction" && out.open.after === "Go to the auction" && !!out.open.roundId && out.open.gavel === GAVEL_SEC * 1000,
      windowOnBothClients: out.playerOpen?.title === `The auction at ${AUCTION}` && out.playerOpen.form && out.playerOpen.bet === "Bid 1 gp" && out.playerOpen.lot === before.lot.name && out.playerOpen.line === "Opening bid" && /^The gavel falls in 0:\d\d$/.test(out.playerOpen.state ?? "") && out.gmOpen?.spin === "Bring the gavel down" && out.gmOpen.cancel === "Call it off" && !out.gmOpen.form,
      firstBidThroughButton: out.bid1.label === "Bid 1 gp" && out.bid1.busy === "Bidding…" && out.bid1.top === "Crate Tester" && out.bid1.amount === "1 gp" && !out.bid1.why && cp(out.bid1.stakedPurse) === before.purseCp - 100,
      houseOutbidRefundsAtOnce: out.house.ms != null && out.afterHouse.purseCp === before.purseCp && !!first && first.status === "refunded" && first.refundReason === "outbid" && !!house && house.amount === 2 && house.price === 0 && house.status === "open",
      boardShowsHouseOnTop: out.playerAfterHouse?.amount === "2 gp" && out.playerAfterHouse.who === "House bidder 1" && out.playerAfterHouse.past.some(p => p.mine && p.beaten) && /House bidder 1 bids 2 gp, the top bid; Crate Tester's bid came back\./.test(out.playerAfterHouse.live ?? "") && out.playerAfterHouse.bet === "Bid 3 gp",
      rebidThroughButton: out.bid2.label === "Bid 3 gp" && out.bid2.top === "Crate Tester" && out.bid2.amount === "3 gp" && cp(out.bid2.stakedPurse) === before.purseCp - 300 && out.afterBid2.purseCp === before.purseCp - 300 && out.gavelAfterBid2.reset && out.gavelAfterBid2.bar > 0.8,
      housePassedOutOfBudget: out.playerBeforeHammer?.who === "Crate Tester" && out.playerBeforeHammer.amount === "3 gp",
      gavelLanded: out.hammer.ms != null && out.playerLanded?.landed && out.gmLanded?.landed && out.playerLanded.stamp === "Sold" && out.playerLanded.state === "Settled",
      verdictInLiveRegion: (out.playerLanded?.result ?? "").startsWith("Sold to Crate Tester for 3 gp.") && out.playerLanded.liveRegion && out.playerLanded.focusOnClose && out.playerLanded.button === "Close",
      itemOnSheetPurseDownTheBid: out.afterHammer.purseCp === before.purseCp - 300 && out.afterHammer.items === before.items + 1 && out.afterHammer.lotItems >= 1 && won.note === "Won at the hammer for 3 gp." && won.name === before.lot.name,
      oneSealedChatCard: out.chat.roundCards === 1 && !out.chat.hasRoll && /Sold to Crate Tester for 3 gp/.test(out.chat.text ?? "") && out.renders.length > 0 && out.renders.every(r => r.landed || (r.sealed && !r.verdictShown)),
      refundUndoesIt: out.refund.refunded != null && out.afterRefund.purseCp === before.purseCp && out.afterRefund.items === before.items && /refunded/.test(out.refund.rowAfter ?? ""),
    };
    out.ok = Object.values(out.checks).every(Boolean);
    out.gmConsole = gm.logs.filter(l => !l.includes("timings"));
    out.playerLog = pl.logs.filter(l => !l.includes("timings"));
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
