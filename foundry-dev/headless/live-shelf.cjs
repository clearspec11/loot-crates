// Live check: On the shelf (shelf.js) at a real table, with the branch's
// code on both ends.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/headless/live-shelf.cjs [--shot out.png]
//
// Env: PLAYER (default Player2, must own Crate Tester), BOX (the crate's
// name, default "Live shelf crate").
//
// Two headless clients, the Gamemaster and the player, each running the
// branch's socket and redraw code (as live-limits.cjs does). The player
// opens the shop on Crate Tester and leaves it open throughout. Then, as
// people do:
//
//   1. The GM opens the manager, clicks the Boxes tab and New box, types the
//      crate's name and a 1 gp price, ticks "Live UI pool", unticks "On the
//      shelf" (the default button must turn from "Add to shelf" to "Add")
//      and presses Add. The row must read "Off the shelf" with its toggle
//      "On the shelf" unpressed, the status line say it was added off the
//      shelf, and
//      the toolbar count it. The player's open shop must not list it.
//   2. The GM presses the row's "On the shelf" (unpressed): focus stays on the toggle,
//      now pressed, and the player's open shop shows the crate with its Buy
//      on within 2 s.
//   3. The player's hand is on that Buy as the GM presses the toggle again:
//      the player presses it the moment the change reaches their client,
//      before the shop redraws. The shop's notice must read "That crate is
//      no longer on the shelf.", nothing is sent, and the card then goes.
//   4. A pull for it sent anyway (the shop's own requestPull, as a stale or
//      crafted client would) is refused by the GM: "<name> is no longer on
//      the shelf. Nothing was charged.", purse, items and log unchanged.
//
// Restored in a finally: the crate this run made is removed (the boxes as
// they were), the shop's open state as it was. No purchase; nothing else is
// deleted. Needs "Crate Tester" in "Loot Crates Test"; seeds "Live UI pool"
// by name (as live-ui.js does) when it is missing.
/* global game */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const BOX = process.env.BOX || "Live shelf crate";
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
    registerShopHooks?.(globalThis.Hooks);
  }, MODULE_BASE);
  return { page, logs };
}

// The GM's side: the pool the crate draws from, and what is to be restored.
async function prepare(gm) {
  return gm.evaluate(async ({ base, name }) => {
    const store = await import(base + "scripts/store.js");
    const { toCopper } = await import(base + "scripts/currency.js");
    const folder = game.folders.find(f => f.type === "Actor" && f.name === "Loot Crates Test");
    const actor = game.actors.find(a => a.name === "Crate Tester" && a.folder?.id === folder?.id);
    if (!actor) throw new Error("no Crate Tester in Loot Crates Test");
    if ((actor.system.currency.gp ?? 0) < 5) await actor.update({ "system.currency.gp": 1000 });
    const seeded = [];
    let pool = Object.values(store.getPools()).find(p => p.name === "Live UI pool");
    if (!pool) {
      const entries = await store.entriesFromCompendium("dnd5e.items", { types: ["weapon", "equipment"], rarities: ["uncommon", "rare"] });
      pool = await store.createPool({ name: "Live UI pool", entries: entries.slice(0, 40) });
      seeded.push("Live UI pool");
    }
    // A crate of this name left by a run that died is not this run's to keep.
    const stale = Object.values(store.getBoxes()).filter(b => b.name === name).map(b => b.id);
    const shopOpen = store.isShopOpen();
    if (!shopOpen) await store.setShopOpen(true);
    return {
      actorId: actor.id, poolId: pool.id, seeded, stale, shopOpen,
      boxIds: Object.keys(store.getBoxes()),
      purseCp: toCopper(actor.system.currency),
      items: actor.items.filter(i => !i.flags?.dnd5e?.cachedFor).length,
      logIds: store.getLog().map(r => r.id),
    };
  }, { base: MODULE_BASE, name: BOX });
}

async function restore(gm, before) {
  if (!gm || !before) return null;
  return gm.evaluate(async ({ base, before }) => {
    const out = {};
    try {
      const store = await import(base + "scripts/store.js");
      const made = Object.keys(store.getBoxes()).filter(id => !before.boxIds.includes(id));
      for (const id of made) await store.removeBox(id);
      out.removed = made.length;
      out.boxesAsBefore = Object.keys(store.getBoxes()).sort().join() === [...before.boxIds].sort().join();
      if (!before.shopOpen) { await store.setShopOpen(false); out.shop = "closed again"; }
      const { toCopper } = await import(base + "scripts/currency.js");
      out.purseCp = toCopper(game.actors.get(before.actorId).system.currency);
    } catch (err) { out.error = String(err?.stack || err); }
    return out;
  }, { base: MODULE_BASE, before });
}

// What the player's open shop shows for a box id.
const readCard = (pl, boxId) => pl.evaluate(({ boxId }) => {
  const shop = document.querySelector("#loot-crates-shop");
  const card = shop?.querySelector(`.lc-box[data-box="${boxId}"]`);
  const buy = card?.querySelector(".lc-box__buy");
  return { open: !!shop, cards: shop?.querySelectorAll(".lc-box").length ?? 0, listed: !!card, off: buy?.getAttribute("aria-disabled") === "true", notice: shop?.querySelector(".lc-shop__notice")?.textContent.trim() ?? "" };
}, { boxId });

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

// The GM presses the row's toggle, as a person does: focus, then click.
const pressToggle = (gm, boxId) => gm.evaluate(async ({ boxId }) => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, ms = 8000) => { for (let t = 0; t < ms && !fn(); t += 25) await wait(25); return fn(); };
  const click = el => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
  const app = document.querySelector(".lc-manager");
  const toggle = () => app?.querySelector(`button[data-action="toggleShelf"][data-box="${boxId}"]`);
  const was = toggle()?.getAttribute("aria-pressed");
  toggle().focus();
  const at = Date.now();
  click(toggle());
  await until(() => toggle() && toggle().getAttribute("aria-pressed") !== was);
  await wait(250);
  const t = toggle();
  const row = t?.closest("tr");
  return {
    at, was, pressed: t?.getAttribute("aria-pressed"), label: t?.textContent.trim(), aria: t?.getAttribute("aria-label"),
    focused: document.activeElement === t, offTag: row?.querySelector(".lc-kind--off")?.textContent.trim() ?? "",
    dimmed: !!row?.classList.contains("lc-row--off"),
    status: app.querySelector(".lc-manager__status")?.textContent.trim(), count: app.querySelector(".lc-shelf-count")?.textContent.trim(),
  };
}, { boxId });

(async () => {
  const browser = await chromium.launch();
  const out = { player: PLAYER, box: BOX, gm: null };
  let gm = null, before = null;
  try {
    const pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");
    out.gm = "headless Gamemaster running the branch";
    before = await prepare(gm.page);
    out.before = { purseCp: before.purseCp, items: before.items, rows: before.logIds.length, boxes: before.boxIds.length, seeded: before.seeded, stale: before.stale };

    // The player's shop, open on Crate Tester for the whole check.
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

    // 1. New box, off the shelf, through the editor.
    out.add = await gm.page.evaluate(async ({ base, name, poolId }) => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const until = async (fn, ms = 10000) => { for (let t = 0; t < ms && !fn(); t += 50) await wait(50); return fn(); };
      const click = el => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
      const type = (el, v) => { el.focus(); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };
      const store = await import(base + "scripts/store.js");
      const { openManager } = await import(base + "scripts/manager.js");
      const had = new Set(Object.keys(store.getBoxes()));
      const app = openManager();
      await until(() => app.element?.querySelector('.lc-tabs [data-tab="boxes"]'));
      click(app.element.querySelector('.lc-tabs [data-tab="boxes"]'));
      if (!await until(() => app.tab === "boxes" && app.element.querySelector('button[data-action="addBox"]'))) throw new Error("no New box on the Boxes tab");
      click(app.element.querySelector('button[data-action="addBox"]'));
      const dialog = () => [...document.querySelectorAll(".application.dialog")].find(d => d.querySelector('input[name="onShelf"]'));
      if (!await until(() => dialog())) throw new Error("New box opened no editor with an On the shelf box");
      const d = dialog();
      const ok = () => d.querySelector('button[data-action="ok"]');
      const shelf = d.querySelector('input[name="onShelf"]');
      const tickedAtFirst = shelf.checked;
      const okBefore = ok().textContent.trim();
      type(d.querySelector('input[name="name"]'), name);
      type(d.querySelector('input[name="price"]'), "1");
      const pool = d.querySelector(`input[name="pool.${poolId}"]`);
      if (!pool.checked) click(pool);
      click(shelf);
      await wait(100);
      const okAfter = ok().textContent.trim();
      click(ok());
      await until(() => !dialog(), 5000);
      const id = await until(() => Object.keys(store.getBoxes()).find(k => !had.has(k) && store.getBoxes()[k].name === name));
      await until(() => app.element.querySelector(`button[data-action="toggleShelf"][data-box="${id}"]`));
      await wait(300);
      const t = app.element.querySelector(`button[data-action="toggleShelf"][data-box="${id}"]`);
      const row = t?.closest("tr");
      return {
        id, tickedAtFirst, okBefore, okAfter, record: structuredClone(store.getBoxes()[id]),
        toggle: { pressed: t?.getAttribute("aria-pressed"), label: t?.textContent.trim() }, offTag: row?.querySelector(".lc-kind--off")?.textContent.trim() ?? "",
        dimmed: !!row?.classList.contains("lc-row--off"),
        status: app.element.querySelector(".lc-manager__status")?.textContent.trim(), count: app.element.querySelector(".lc-shelf-count")?.textContent.trim(),
      };
    }, { base: MODULE_BASE, name: BOX, poolId: before.poolId });
    const boxId = out.add.id;
    await pl.page.waitForTimeout(1500);
    out.playerWhileOff = await readCard(pl.page, boxId);

    // 2. On the shelf, pressed: the player's open shop shows it.
    out.putOn = await pressToggle(gm.page, boxId);
    out.playerAfterOn = await untilCard(pl.page, boxId, c => c.listed && !c.off, out.putOn.at);

    // 3. Taken off again while the player's hand is on its Buy.
    const press = pl.page.evaluate(async ({ boxId }) => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const click = el => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
      const shelved = () => game.settings.get("loot-crates", "boxes")?.[boxId]?.rules?.shelved === false;
      for (let t = 0; t < 10000 && !shelved(); t += 2) await wait(2);
      if (!shelved()) return { pressed: false, why: "the change never reached the player" };
      const buy = document.querySelector(`#loot-crates-shop .lc-box[data-box="${boxId}"] .lc-box__buy`);
      if (!buy) return { pressed: false, why: "the shop redrew before the press" };
      const live = buy.getAttribute("aria-disabled") !== "true";
      buy.focus();
      click(buy);
      await wait(600);
      const shop = document.querySelector("#loot-crates-shop");
      return { pressed: true, live, notice: shop?.querySelector(".lc-shop__notice")?.textContent.trim() ?? "", listed: !!shop?.querySelector(`.lc-box[data-box="${boxId}"]`), busy: !!shop?.querySelector(".lc-box__buy")?.textContent.includes("Opening") };
    }, { boxId });
    await pl.page.waitForTimeout(150);
    out.takeOff = await pressToggle(gm.page, boxId);
    out.stalePress = await press;
    if (shot) await pl.page.screenshot({ path: shot });

    // 4. A pull sent anyway.
    out.sent = await pl.page.evaluate(async ({ base, boxId }) => {
      const { requestPull } = await import(base + "scripts/socket.js");
      const actor = game.actors.find(a => a.isOwner && a.name === "Crate Tester");
      try { await requestPull({ boxId, actorId: actor.id, price: 1 }); return { refused: false }; }
      catch (err) { return { refused: true, message: err.message }; }
    }, { base: MODULE_BASE, boxId });
    out.after = await gm.page.evaluate(async ({ base, before }) => {
      const store = await import(base + "scripts/store.js");
      const { toCopper } = await import(base + "scripts/currency.js");
      const actor = game.actors.get(before.actorId);
      return { purseCp: toCopper(actor.system.currency), items: actor.items.filter(i => !i.flags?.dnd5e?.cachedFor).length, newRows: store.getLog().filter(r => !before.logIds.includes(r.id)).length };
    }, { base: MODULE_BASE, before });

    const a = out.add, on = out.putOn, off = out.takeOff, s = out.stalePress;
    out.checks = {
      editorBox: a.tickedAtFirst === true && a.okBefore === "Add to shelf" && a.okAfter === "Add",
      addedOff: a.record?.rules?.shelved === false && a.record?.price === 1 && a.record?.pools?.[0]?.id === before.poolId,
      rowOff: a.toggle.pressed === "false" && a.toggle.label === "On the shelf" && a.offTag === "Off the shelf" && a.dimmed,
      saidOff: a.status === `${BOX} added off the shelf. Players can't see it until you put it on the shelf.` && /^\d+ of \d+ on the shelf$/.test(a.count ?? ""),
      playerDoesNotSee: out.playerWhileOff.open && !out.playerWhileOff.listed,
      putOn: on.pressed === "true" && on.label === "On the shelf" && on.focused && on.offTag === "" && !on.dimmed && on.status === `${BOX} is on the shelf; players can see it.`,
      playerSeesWithin2s: out.playerAfterOn.ms != null && out.playerAfterOn.ms <= 2000 && out.playerAfterOn.listed && !out.playerAfterOn.off,
      takeOff: off.pressed === "false" && off.label === "On the shelf" && off.focused && off.status === `${BOX} is off the shelf; players can't see it.`,
      staleBuyRefused: s.pressed && s.live && s.notice === "That crate is no longer on the shelf." && !s.listed && !s.busy,
      sentRefused: out.sent.refused && out.sent.message === `${BOX} is no longer on the shelf. Nothing was charged.`,
      nothingCharged: out.after.purseCp === before.purseCp && out.after.items === before.items && out.after.newRows === 0,
    };
    out.ok = Object.values(out.checks).every(Boolean);
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
