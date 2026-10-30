// Live check: Delete on a table game with its round open (manager.js
// #deleteBox, P13). The round is called off first (table.js cancelRound),
// so no stake waits in escrow for a game that can't be spun.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/checks/live-delete-round.cjs
//
// Env: PLAYER (default Player2, must own Crate Tester), WHEEL (the game's
// name, default "Live delete wheel").
//
// Two headless clients, the Gamemaster and the player, each with the
// installed module's socket listener removed and the branch's registered
// from MODULE_BASE (as live-roulette.cjs does); the GM's store listener
// also runs the branch's safety net (table.js refundOrphanRounds on a
// change of the boxes), as main.js wires it. The GM seeds the wheel (1 gp
// to 10 gp a bet, open until the GM spins, no item on a rarity) and notes
// Crate Tester's purse. Then, as people do:
//
//   1. The GM presses the wheel's "Open a round" on the Boxes tab; the
//      table window opens on both clients.
//   2. Player2 places one 2 gp bet through the window's real form: the
//      purse drops by 2 gp and an open row is in the log.
//   3. The GM presses the wheel's Delete on the Boxes row. The confirm must
//      be titled "Delete Roulette wheel" and say the round holds 1 stake (2 gp),
//      refunded first. The GM presses Yes.
//   4. The game is gone, the round resolved and voided as cancelled, the
//      row refunded (reason "cancel"), the purse back to its value before
//      the bet, the GM's status line says "Deleted <wheel>. Its round was
//      called off: 1 stake was refunded." and the safety net says nothing
//      more (the refund is said once). Player2's table window says the
//      round was called off, with no chip and no form.
//
// Restored in a finally: the wheel is re-created as it was seeded (its own
// id), so the next run finds it; the refunded row stands, as every live
// purchase does. One stake per run. Needs "Crate Tester" in "Loot Crates Test".
/* global game, foundry, Hooks, ui -- used inside page.evaluate, which runs in the Foundry page */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const WHEEL = process.env.WHEEL || "Live delete wheel";

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
    const { refundOrphanRounds } = await import(base + "scripts/foundry/table.js");
    const redrawOnly = storeRedraw({ refreshShop, refreshManager, refreshTables });
    // As main.js: the active GM calls off a round whose game is gone.
    const redraw = key => {
      redrawOnly(key);
      if (key === "boxes") refundOrphanRounds().catch(err => console.error("loot-crates | refunding the round of a deleted game failed", err));
    };
    store.setStoreListener(redraw);
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

// The GM's side: seed the wheel, call off any round left over, note the purse.
async function seed(gm) {
  return gm.evaluate(async ({ base, name }) => {
    const store = await import(base + "scripts/foundry/store.js");
    const { toCopper } = await import(base + "scripts/core/currency.js");
    const { ROULETTE_DEFAULTS } = await import(base + "scripts/games/roulette.js");
    const { liveRoundOf } = await import(base + "scripts/core/round.js");
    const { cancelRound } = await import(base + "scripts/foundry/table.js");
    const folder = game.folders.find(f => f.type === "Actor" && f.name === "Loot Crates Test");
    const actor = game.actors.find(a => a.name === "Crate Tester" && a.folder?.id === folder?.id);
    if (!actor) throw new Error("no Crate Tester in Loot Crates Test: run live-pull.js first");
    if ((actor.system.currency.gp ?? 0) < 60) await actor.update({ "system.currency.gp": 1000 });
    const old = Object.values(store.getBoxes()).find(b => b.name === name) ?? null;
    const wheel = await store.saveBox({
      ...(old ? { id: old.id } : {}), kind: "roulette", name, price: 1, pools: [], weights: {},
      roulette: { colours: ["Red", "Black"], pockets: ROULETTE_DEFAULTS.pockets.map(p => ({ ...p })), payouts: { ...ROULETTE_DEFAULTS.payouts }, itemOnRarity: false, maxStake: 10, maxBets: 3, windowSec: 0 },
      rules: {},
    });
    const leftover = liveRoundOf(store.getRounds(), wheel.id);
    if (leftover) await cancelRound(leftover.id);
    return { actorId: actor.id, wheel: structuredClone(wheel), leftover: !!leftover, purseCp: toCopper(actor.system.currency), logIds: store.getLog().map(r => r.id) };
  }, { base: MODULE_BASE, name: WHEEL });
}

// Re-creates the wheel as seeded (its own id) when the run deleted it.
async function restore(gm, before) {
  if (!gm || !before) return null;
  return gm.evaluate(async ({ base, wheel }) => {
    const store = await import(base + "scripts/foundry/store.js");
    if (store.getBoxes()[wheel.id]) return { wheel: "still there" };
    await store.saveBox(wheel);
    return { wheel: store.getBoxes()[wheel.id] ? "re-created" : "missing" };
  }, { base: MODULE_BASE, wheel: before.wheel });
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

const purseOf = (gm, actorId) => gm.evaluate(async ({ base, actorId }) => {
  const { toCopper } = await import(base + "scripts/core/currency.js");
  const actor = game.actors.get(actorId);
  return { purseCp: toCopper(actor.system.currency), items: actor.items.size };
}, { base: MODULE_BASE, actorId });


(async () => {
  const browser = await chromium.launch();
  const out = { player: PLAYER, wheel: WHEEL };
  let gm = null, pl = null, before = null;
  try {
    pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");
    before = await seed(gm.page);
    out.before = { purseCp: before.purseCp, leftover: before.leftover };

    // 1. The GM opens a round from the Boxes tab.
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
      click(btn());
      const round = await until(() => liveRoundOf(store.getRounds(), wheelId), 10000);
      await until(() => document.querySelector(".application.lc-table"), 10000);
      return { label, roundId: round?.id ?? null };
    }, { base: MODULE_BASE, wheelId: before.wheel.id });
    if (!out.open.roundId) throw new Error("no round opened");
    await pl.page.waitForFunction(() => document.querySelector(".application.lc-table .lc-table__form"), null, { timeout: 10000 }).catch(() => {});

    // 2. Player2 bets 2 gp on a colour through the window's real form.
    out.bet = await placeBet(pl.page, { type: "colour", pick: 0, stake: 2 });
    await wait(800);
    out.afterBet = await purseOf(gm.page, before.actorId);
    out.playerTableBet = await readTable(pl.page);

    // 3. The GM presses the wheel's Delete on the Boxes row, reads the confirm, presses Yes.
    out.del = await gm.page.evaluate(async ({ base, wheelId }) => {
      const { openManager } = await import(base + "scripts/foundry/manager.js");
      const store = await import(base + "scripts/foundry/store.js");
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const until = async (fn, ms = 15000) => { for (let t = 0; t < ms && !fn(); t += 50) await wait(50); return fn(); };
      const click = el => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
      const said = [];
      const warn = ui.notifications.warn.bind(ui.notifications);
      ui.notifications.warn = (msg, ...rest) => { said.push(String(msg)); return warn(msg, ...rest); };
      try {
        const app = openManager();
        await until(() => app.element?.querySelector('.lc-tabs [data-tab="boxes"]'));
        click(app.element.querySelector('.lc-tabs [data-tab="boxes"]'));
        const btn = () => app.element?.querySelector(`button[data-action=deleteBox][data-box="${wheelId}"]`);
        if (!await until(() => app.tab === "boxes" && btn(), 8000)) throw new Error("the Boxes tab has no Delete for the wheel");
        btn().focus();
        click(btn());
        const dialog = () => [...document.querySelectorAll(".application.dialog")].pop();
        const yes = () => [...(dialog()?.querySelectorAll("button") ?? [])].find(b => /yes/i.test(b.dataset.action ?? b.textContent));
        await until(() => yes());
        const title = dialog()?.querySelector(".window-title")?.textContent.trim() ?? null;
        const text = dialog()?.querySelector(".window-content p")?.textContent.replace(/\s+/g, " ").trim() ?? null;
        click(yes());
        await until(() => !store.getBoxes()[wheelId], 10000);
        await wait(1500);
        const status = app.element?.querySelector(".lc-manager__status")?.textContent.trim() ?? null;
        const rowLeft = !!app.element?.querySelector(`[data-box="${wheelId}"]`);
        await app.close();
        return { title, text, status, rowLeft, gone: !store.getBoxes()[wheelId], said };
      } finally {
        ui.notifications.warn = warn;
      }
    }, { base: MODULE_BASE, wheelId: before.wheel.id });

    // 4. What the delete left.
    out.after = await gm.page.evaluate(async ({ base, roundId, logIds }) => {
      const store = await import(base + "scripts/foundry/store.js");
      const round = store.getRounds()[roundId] ?? null;
      const rows = store.getLog().filter(r => !logIds.includes(r.id)).map(r => ({ id: r.id, status: r.status, roundId: r.roundId, price: r.price, refunded: r.refunded ?? null, refundReason: r.refundReason ?? null }));
      return { round: round && { status: round.status, voided: !!round.voided, cancelled: !!round.cancelled }, rows };
    }, { base: MODULE_BASE, roundId: out.open.roundId, logIds: before.logIds });
    out.afterDelete = await purseOf(gm.page, before.actorId);
    await pl.page.waitForFunction(() => document.querySelector('.application.lc-table .lc-table__state[data-state="void"]'), null, { timeout: 5000 }).catch(() => {});
    await wait(1000);
    out.playerTableVoid = await readTable(pl.page);

    const row = out.after.rows.find(r => r.roundId === out.open.roundId);
    out.checks = {
      openedFromBoxes: out.open.label === "Open a round" && !!out.open.roundId,
      betTaken: out.bet.landed && !out.bet.why && out.afterBet.purseCp === before.purseCp - 200 && out.playerTableBet?.chips === 1,
      confirmNamesStake: out.del.title === "Delete Roulette wheel" && out.del.text === `Delete ${WHEEL}? Its round still holds 1 stake (2 gp); it is refunded first.`,
      gameGone: out.del.gone && !out.del.rowLeft,
      roundCalledOff: out.after.round?.status === "resolved" && out.after.round.voided && out.after.round.cancelled,
      rowRefunded: !!row && !!row.refunded && row.refundReason === "cancel" && out.after.rows.length === 1,
      purseBack: out.afterDelete.purseCp === before.purseCp,
      saidOnce: out.del.status === `Deleted ${WHEEL}. Its round was called off: 1 stake was refunded.` && !out.del.said.some(s => /was deleted with its round open/.test(s)),
      calledOffOnPlayer: /called off; every stake came back/.test(out.playerTableVoid?.state ?? "") && out.playerTableVoid.chips === 0 && !out.playerTableVoid.form && out.playerTableVoid.title === `The wheel at ${WHEEL}`,
    };
    out.ok = Object.values(out.checks).every(Boolean);
    out.gmConsole = gm.logs.filter(l => !l.includes("timings"));
    out.playerLog = pl.logs;
  } catch (err) {
    out.error = String(err?.stack || err);
    out.ok = false;
  } finally {
    try {
      await pl?.page.evaluate(async () => {
        for (const app of [...foundry.applications.instances.values()].filter(a => a.options?.classes?.includes("lc-table"))) await app.close();
      });
    } catch { /* the player's page is gone */ }
    try { out.restored = await restore(gm?.page, before); } catch (err) { out.restored = { error: String(err) }; }
    console.log(JSON.stringify(out, null, 1));
    if (!out.ok) process.exitCode = 1;
    await browser.close();
  }
})();
