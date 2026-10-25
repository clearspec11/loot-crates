// Live check: the starter crates (starter.js, starterbuild.js) at a real
// table, with the branch's code on both ends.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/headless/live-starter.cjs [--shot out.png]
//
// Env: PLAYER (default Player2, must own Crate Tester).
//
// Two headless clients, the Gamemaster and the player, each running the
// branch's socket and redraw code (as live-shelf.cjs does). The player
// opens the shop on Crate Tester and leaves it open. Then, as people do:
//
//   1. The GM opens the manager, clicks the Boxes tab and presses the real
//      "Add starter crates" (the toolbar's: cc-dev is not an empty world;
//      the empty tabs' offer is the same action, seen in the harness).
//      With the set not in the world, no confirm may appear, and four new
//      pools must hold real dnd5e items (more than none each, every one a
//      Compendium.dnd5e.* reference). With the set (or part of it) already
//      there, the manager's own confirm must appear ("The starter set is
//      already here: ..."), and the GM presses its Add copies as a person
//      would; only the starter pools not there yet are made, and the games
//      draw from the ones already there. Either way: eight new games, one
//      of every kind (named as copies where the name is taken), every one
//      off the shelf: its row dimmed, "On the shelf" unpressed, the first
//      game's Edit focused, the status line saying what came in. The
//      player's open shop must list none of them. out.before.path says
//      which way ran ("fresh" or "copies").
//   2. The GM presses the Adventurer's cache row's "On the shelf"; the
//      player's shop shows it with its Buy on within 2 s.
//   3. The player presses that Buy once and closes the reveal when it
//      lands: 50 gp charged, one item on the sheet, one log row.
//   4. The GM opens the Pull log by its tab, presses the row's Refund and
//      Yes: the purse and the sheet are as before.
//
// Restored in a finally: every pool and game this run's press made is
// removed (the pools and boxes as they were, by id), and each character's
// state on those games; the shop's open state as it was. Only records this
// run created are touched: a starter pool or game already in the world is
// never removed or changed. The world's pool and game ids and counts are
// printed before and after, and the run fails unless they match. One real
// 50 gp purchase, refunded; the log row and the chat card stay, as in
// every purchase check.
/* global game */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const shot = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : null;
const STARTER_GAMES = ["Adventurer's cache", "Arcane coffer", "Dragon's hoard chest", "Wishing Well", "Dragon's Teeth", "Deck of Many Things", "Tavern roulette", "Hoard chest auction"];
const STARTER_POOLS = ["Potions and scrolls", "Wondrous trinkets", "Arms and armour", "Dragon's hoard"];

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
    registerShopHooks?.(globalThis.Hooks);
  }, MODULE_BASE);
  return { page, logs };
}

async function prepare(gm) {
  return gm.evaluate(async ({ base, games, pools }) => {
    const store = await import(base + "scripts/store.js");
    const { toCopper } = await import(base + "scripts/currency.js");
    const folder = game.folders.find(f => f.type === "Actor" && f.name === "Loot Crates Test");
    const actor = game.actors.find(a => a.name === "Crate Tester" && a.folder?.id === folder?.id);
    if (!actor) throw new Error("no Crate Tester in Loot Crates Test");
    if ((actor.system.currency.gp ?? 0) < 60) await actor.update({ "system.currency.gp": 1000 });
    const shopOpen = store.isShopOpen();
    if (!shopOpen) await store.setShopOpen(true);
    return {
      actorId: actor.id, shopOpen,
      boxIds: Object.keys(store.getBoxes()), poolIds: Object.keys(store.getPools()),
      stateKeys: Object.keys(game.settings.get("loot-crates", "actorState") ?? {}),
      present: { games: Object.values(store.getBoxes()).map(b => b.name).filter(n => games.includes(n)), pools: [...new Set(Object.values(store.getPools()).map(p => p.name).filter(n => pools.includes(n)))] },
      // The starter pools already here, which copies of the games draw from.
      starterPoolIds: Object.values(store.getPools()).filter(p => pools.includes(p.name)).map(p => p.id),
      purseCp: toCopper(actor.system.currency),
      items: actor.items.filter(i => !i.flags?.dnd5e?.cachedFor).length,
      logIds: store.getLog().map(r => r.id),
    };
  }, { base: MODULE_BASE, games: STARTER_GAMES, pools: STARTER_POOLS });
}

// Removes what this run made, by id: the games and pools not there before,
// and the characters' state keyed on those games. Nothing else.
async function restore(gm, before) {
  if (!gm || !before) return null;
  return gm.evaluate(async ({ base, before }) => {
    const out = {};
    try {
      const store = await import(base + "scripts/store.js");
      const boxes = Object.keys(store.getBoxes()).filter(id => !before.boxIds.includes(id));
      for (const id of boxes) await store.removeBox(id);
      const pools = Object.keys(store.getPools()).filter(id => !before.poolIds.includes(id));
      for (const id of pools) await store.removePool(id);
      const state = game.settings.get("loot-crates", "actorState") ?? {};
      const keys = Object.keys(state).filter(k => !before.stateKeys.includes(k) && boxes.some(id => k.endsWith(`.${id}`)));
      if (keys.length) { const next = { ...state }; for (const k of keys) delete next[k]; await game.settings.set("loot-crates", "actorState", next); }
      out.removed = { boxes: boxes.length, pools: pools.length, state: keys.length };
      out.after = { boxes: Object.keys(store.getBoxes()).length, pools: Object.keys(store.getPools()).length, boxIds: Object.keys(store.getBoxes()).sort(), poolIds: Object.keys(store.getPools()).sort() };
      out.boxesAsBefore = out.after.boxIds.join() === [...before.boxIds].sort().join();
      out.poolsAsBefore = out.after.poolIds.join() === [...before.poolIds].sort().join();
      if (!before.shopOpen) { await store.setShopOpen(false); out.shop = "closed again"; }
      const { toCopper } = await import(base + "scripts/currency.js");
      out.purseCp = toCopper(game.actors.get(before.actorId).system.currency);
    } catch (err) { out.error = String(err?.stack || err); }
    return out;
  }, { base: MODULE_BASE, before });
}

const untilCard = (pl, boxId, pred, since) => pl.evaluate(async ({ boxId, pred, since }) => {
  const test = new Function("c", `return (${pred})(c)`);
  const read = () => {
    const card = document.querySelector(`#loot-crates-shop .lc-box[data-box="${boxId}"]`);
    return { listed: !!card, off: card?.querySelector(".lc-box__buy")?.getAttribute("aria-disabled") === "true" };
  };
  for (let i = 0; i < 250; i++) {
    const c = read();
    if (test(c)) return { ...c, ms: Date.now() - since };
    await new Promise(r => setTimeout(r, 20));
  }
  return { ...read(), ms: null };
}, { boxId, pred: String(pred), since });

(async () => {
  const browser = await chromium.launch();
  const out = { player: PLAYER };
  let gm = null, before = null;
  try {
    const pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");
    before = await prepare(gm.page);
    const setPresent = !!(before.present.games.length || before.present.pools.length);
    out.before = { path: setPresent ? "copies" : "fresh", setPresent, purseCp: before.purseCp, items: before.items, rows: before.logIds.length, boxes: before.boxIds.length, pools: before.poolIds.length, present: before.present, boxIds: [...before.boxIds].sort(), poolIds: [...before.poolIds].sort() };

    out.shopOpened = await pl.page.evaluate(async ({ base }) => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const { openShop } = await import(base + "scripts/shop.js");
      const actor = game.actors.find(a => a.isOwner && a.type === "character" && a.name === "Crate Tester");
      if (!actor) throw new Error(`${game.user.name} doesn't own Crate Tester`);
      const app = openShop();
      for (let t = 0; t < 8000 && !app.element?.querySelector(".lc-shop__body"); t += 50) await wait(50);
      const pick = app.element.querySelector(".lc-shop__actor");
      if (pick && pick.value !== actor.id) { pick.value = actor.id; pick.dispatchEvent(new Event("change")); await wait(800); }
      return { cards: app.element.querySelectorAll(".lc-box").length };
    }, { base: MODULE_BASE });

    // 1. The GM presses Add starter crates.
    out.add = await gm.page.evaluate(async ({ base, before, setPresent }) => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const until = async (fn, ms = 10000) => { for (let t = 0; t < ms && !fn(); t += 50) await wait(50); return fn(); };
      const click = el => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
      const store = await import(base + "scripts/store.js");
      const { openManager } = await import(base + "scripts/manager.js");
      const app = openManager();
      await until(() => app.element?.querySelector('.lc-tabs [data-tab="boxes"]'));
      click(app.element.querySelector('.lc-tabs [data-tab="boxes"]'));
      const button = () => app.element.querySelector('button[data-action="starterCrates"]');
      if (!await until(() => app.tab === "boxes" && button())) throw new Error("no Add starter crates on the Boxes tab");
      const label = button().textContent.trim();
      button().focus();
      const at = Date.now();
      click(button());
      const newBoxes = () => Object.values(store.getBoxes()).filter(b => !before.boxIds.includes(b.id));
      const confirm = () => [...document.querySelectorAll(".application.dialog")].find(d => /starter set is already here/.test(d.textContent));
      await until(() => newBoxes().length >= 8 || confirm(), 60000);
      let confirmText = null;
      if (confirm()) {
        confirmText = (confirm().querySelector(".window-content p") ?? confirm()).textContent.replace(/\s+/g, " ").trim();
        if (!setPresent) { click([...confirm().querySelectorAll("button")].find(b => /cancel/i.test(b.textContent))); throw new Error("a confirm asked about a starter set already here, though none was"); }
        // The set is here: Add copies, pressed as the GM would.
        const yes = [...confirm().querySelectorAll("button")].find(b => /add copies/i.test(b.textContent));
        if (!yes) throw new Error("the confirm has no Add copies");
        yes.focus();
        click(yes);
        await until(() => newBoxes().length >= 8, 60000);
      } else if (setPresent) {
        throw new Error("no confirm appeared, though the starter set is already here");
      }
      const ms = Date.now() - at;
      await until(() => /^Added /.test(app.element.querySelector(".lc-manager__status")?.textContent ?? ""), 8000);
      await wait(300);
      const games = newBoxes();
      const pools = Object.values(store.getPools()).filter(p => !before.poolIds.includes(p.id));
      const baseName = n => String(n).replace(/ \(copy(?: \d+)?\)$/, "");
      const rows = games.map(g => {
        const t = app.element.querySelector(`button[data-action="toggleShelf"][data-box="${g.id}"]`);
        const tr = t?.closest("tr");
        return { id: g.id, name: g.name, base: baseName(g.name), kind: g.kind ?? "crate", shelved: g.rules?.shelved === false, price: g.price, pools: (g.pools ?? []).map(r => r.id), toggle: t?.textContent.trim(), pressed: t?.getAttribute("aria-pressed"), dimmed: !!tr?.classList.contains("lc-row--off"), tag: tr?.querySelector(".lc-kind--off")?.textContent.trim() };
      });
      const first = games.find(g => baseName(g.name) === "Adventurer's cache");
      return {
        label, ms, rows, confirmText,
        pools: pools.map(p => ({ id: p.id, name: p.name, count: p.entries.length, compendium: p.entries.every(e => /^Compendium\.dnd5e\.(items|equipment24)\.Item\./.test(e.uuid)), sample: p.entries.slice(0, 3).map(e => `${e.name} (${e.rarity})`) })),
        lot: games.find(g => g.kind === "auction")?.auction?.lot ?? null, chestId: games.find(g => baseName(g.name) === "Dragon's hoard chest")?.id ?? null,
        status: app.element.querySelector(".lc-manager__status")?.textContent.trim(),
        count: app.element.querySelector(".lc-shelf-count")?.textContent.trim(),
        focusedFirst: !!first && document.activeElement === app.element.querySelector(`button[data-action="editBox"][data-box="${first.id}"]`),
        buyId: first?.id ?? null,
      };
    }, { base: MODULE_BASE, before, setPresent });
    const boxId = out.add.buyId;
    await pl.page.waitForTimeout(1500);
    out.playerWhileOff = await pl.page.evaluate(ids => ids.filter(id => document.querySelector(`#loot-crates-shop .lc-box[data-box="${id}"]`)).length, out.add.rows.map(r => r.id));

    // 2. On the shelf, pressed on the row.
    out.putOn = await gm.page.evaluate(async ({ boxId }) => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const until = async (fn, ms = 8000) => { for (let t = 0; t < ms && !fn(); t += 25) await wait(25); return fn(); };
      const click = el => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
      const app = document.querySelector(".lc-manager");
      const toggle = () => app?.querySelector(`button[data-action="toggleShelf"][data-box="${boxId}"]`);
      toggle().focus();
      const at = Date.now();
      click(toggle());
      await until(() => toggle()?.getAttribute("aria-pressed") === "true");
      await wait(200);
      return { at, pressed: toggle()?.getAttribute("aria-pressed"), label: toggle()?.textContent.trim(), status: app.querySelector(".lc-manager__status")?.textContent.trim() };
    }, { boxId });
    out.playerAfterOn = await untilCard(pl.page, boxId, c => c.listed && !c.off, out.putOn.at);

    // 3. The player buys it once through the real Buy.
    out.buy = await pl.page.evaluate(async ({ boxId }) => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const until = async (fn, ms = 20000) => { for (let t = 0; t < ms && !fn(); t += 50) await wait(50); return fn(); };
      const click = el => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
      const buy = document.querySelector(`#loot-crates-shop .lc-box[data-box="${boxId}"] .lc-box__buy`);
      if (!buy) throw new Error("the player's shop has no Buy for the cache");
      const text = buy.textContent.replace(/\s+/g, " ").trim();
      buy.focus();
      click(buy);
      const closeBtn = () => [...document.querySelectorAll(".lc-reveal")].pop()?.querySelector('[data-action="dismiss"]');
      const landed = await until(() => closeBtn(), 25000);
      const result = [...document.querySelectorAll(".lc-reveal")].pop()?.querySelector(".lc-reveal__result")?.innerText.replace(/\s+/g, " ").trim() ?? "";
      if (landed) { await wait(700); click(closeBtn()); }
      return { text, landed: !!landed, result };
    }, { boxId });
    await gm.page.waitForTimeout(800);
    out.afterBuy = await gm.page.evaluate(async ({ base, before, boxId }) => {
      const store = await import(base + "scripts/store.js");
      const { toCopper } = await import(base + "scripts/currency.js");
      const actor = game.actors.get(before.actorId);
      const rows = store.getLog().filter(r => !before.logIds.includes(r.id));
      return { purseCp: toCopper(actor.system.currency), items: actor.items.filter(i => !i.flags?.dnd5e?.cachedFor).length, rows: rows.map(r => ({ id: r.id, boxId: r.boxId, price: r.price, name: r.name, itemId: r.itemId })), boxId };
    }, { base: MODULE_BASE, before, boxId });

    // 4. The GM refunds it from the Pull log.
    const rowId = out.afterBuy.rows.find(r => r.boxId === boxId)?.id;
    out.refund = await gm.page.evaluate(async ({ base, before, rowId }) => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const until = async (fn, ms = 15000) => { for (let t = 0; t < ms && !fn(); t += 50) await wait(50); return fn(); };
      const click = el => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
      const store = await import(base + "scripts/store.js");
      const { toCopper } = await import(base + "scripts/currency.js");
      const { openManager } = await import(base + "scripts/manager.js");
      const actor = game.actors.get(before.actorId);
      const app = openManager();
      await until(() => app.element?.querySelector('.lc-tabs [data-tab="log"]'));
      click(app.element.querySelector('.lc-tabs [data-tab="log"]'));
      const btn = () => app.element?.querySelector(`button[data-action="refund"][data-row="${CSS.escape(rowId)}"]`);
      if (!await until(() => app.tab === "log" && btn(), 8000)) throw new Error("no Refund for the purchase in the Pull log");
      btn().focus();
      click(btn());
      const dialog = () => [...document.querySelectorAll(".application.dialog")].pop();
      const yes = () => [...(dialog()?.querySelectorAll("button") ?? [])].find(b => /yes/i.test(b.dataset.action ?? b.textContent));
      await until(() => yes());
      const dialogText = dialog()?.querySelector(".window-content")?.textContent.replace(/\s+/g, " ").trim() ?? null;
      click(yes());
      await until(() => store.getLog().find(r => r.id === rowId)?.refunded);
      await wait(600);
      await app.close();
      return { dialogText, refunded: !!store.getLog().find(r => r.id === rowId)?.refunded, purseCp: toCopper(actor.system.currency), items: actor.items.filter(i => !i.flags?.dnd5e?.cachedFor).length };
    }, { base: MODULE_BASE, before, rowId });
    if (shot) await pl.page.screenshot({ path: shot });

    const a = out.add;
    const kinds = a.rows.map(r => r.kind).sort().join();
    // The pools the press should make: the starter pools not here yet.
    const reused = before.present.pools.length;
    const missingPools = STARTER_POOLS.filter(n => !before.present.pools.includes(n));
    const parts = [missingPools.length ? `${missingPools.length} starter pool${missingPools.length === 1 ? "" : "s"}` : "", "8 starter games"].filter(Boolean).join(" and ");
    const said = `Added ${parts}${reused ? " as copies" : ""}, all off the shelf${reused ? ", drawing from the starter pools already here" : ""}. Players can't see them yet: look each one over, then press On the shelf on its row.`;
    out.checks = {
      pressed: a.label === "Add starter crates",
      // The confirm appears exactly when the set is already here, and says so.
      confirm: setPresent ? /^The starter set is already here: .+ Add it again\?/.test(a.confirmText ?? "") : a.confirmText === null,
      poolsFilled: a.pools.length === missingPools.length && a.pools.map(p => p.name).sort().join() === [...missingPools].sort().join() && a.pools.every(p => p.count > 0 && p.compendium),
      eightGames: a.rows.length === 8 && a.rows.map(r => r.base).sort().join() === [...STARTER_GAMES].sort().join() && kinds === "auction,crate,crate,crate,deck,dice,roulette,well",
      allOffShelf: a.rows.every(r => r.shelved && r.toggle === "On the shelf" && r.pressed === "false" && r.dimmed && r.tag === "Off the shelf"),
      drawFromStarterPools: a.rows.filter(r => r.kind !== "roulette" && r.kind !== "auction").every(r => r.pools.length > 0 && r.pools.every(id => a.pools.some(p => p.id === id) || before.starterPoolIds.includes(id))),
      auctionLot: a.lot?.type === "crate" && a.lot.boxId === a.chestId,
      said: a.status === said && a.focusedFirst,
      playerSeesNone: out.playerWhileOff === 0,
      putOn: out.putOn.pressed === "true" && out.playerAfterOn.ms != null && out.playerAfterOn.ms <= 2000,
      bought: out.buy.landed && /50 gp/.test(out.buy.text) && out.afterBuy.purseCp === before.purseCp - 5000 && out.afterBuy.items === before.items + 1 && out.afterBuy.rows.length === 1,
      refunded: out.refund.refunded && out.refund.purseCp === before.purseCp && out.refund.items === before.items,
    };
    out.ok = Object.values(out.checks).every(Boolean);
    out.gmConsole = gm.logs.filter(l => !l.includes("timings"));
    out.playerLog = pl.logs;
  } catch (err) {
    out.error = String(err?.stack || err);
    out.ok = false;
  } finally {
    try { out.restored = await restore(gm?.page, before); } catch (err) { out.restored = { error: String(err) }; }
    // The world's pools and games exactly as before the run, by id and count.
    if (before && !(out.restored?.boxesAsBefore && out.restored?.poolsAsBefore)) { out.ok = false; out.worldChanged = true; }
    console.log(JSON.stringify(out, null, 1));
    if (!out.ok) process.exitCode = 1;
    await browser.close();
  }
})();
