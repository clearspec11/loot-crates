// Live check: with dnd5e's calendar off (dnd5e 6's default), a day ends at
// each character's long rest (clock.js), so the Wishing Well's daily cap
// opens again after one without the world's time moving. Branch code on
// both ends.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/headless/live-well-day.cjs
//
// Env: PLAYER (default Player2, must own Crate Tester), WELL (default
// "Live well").
//
// Two headless clients, the Gamemaster and the player, each running the
// branch's socket and its dnd5e.restCompleted hook from MODULE_BASE (as
// live-well.cjs does). The GM turns dnd5e's calendar off if the world has
// it on, and seeds "Live well" (1 sp, odds nothing 100) under a fresh id
// with a cap of one throw, so Crate Tester's first throw reaches it. The id is fresh because the days entry is put back
// at the end while the run's throw rows stay, keyed r1 and r2: on the same
// id they would count again the next time the character reaches those
// rest counts, and the card would read "1 of 2" where "0 of 2" is expected.
// Then, as people do:
//
//   1. The player opens the shop, picks Crate Tester and presses Throw; once
//      the reveal lands and is closed, the card's Throw is off with "The
//      well is still until tomorrow (n of n today)".
//   2. The GM long-rests Crate Tester through dnd5e's own API
//      (actor.longRest with newDay, no dialog or chat): the player's card
//      must turn its Throw back on within 3 s, with no press, and the
//      world time must not move.
//   3. The player throws again to the cap, then long-rests Crate Tester on
//      their own client (the rest a player takes from the sheet): their
//      client sends newDay, the GM counts it, and the card's Throw comes
//      back on within 3 s.
//
// In a finally: the calendar setting, the world time, the well's record
// and Crate Tester's count of rests (the actor-state setting's days entry)
// are put back. Two real 1 sp throws; Crate Tester is rested twice (its
// hit points and uses recover, as a test actor's may). Nothing is deleted.
/* global game, foundry, Hooks */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const WELL = process.env.WELL || "Live well";

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
    // The branch's long-rest hook (main.js); the installed module has none.
    Hooks.on("dnd5e.restCompleted", (actor, result, config) => socket.restCompleted(actor, result, config));
  }, MODULE_BASE);
  return { page, logs };
}

async function seed(gm) {
  return gm.evaluate(async ({ base, name }) => {
    const store = await import(base + "scripts/store.js");
    const folder = game.folders.find(f => f.type === "Actor" && f.name === "Loot Crates Test");
    const actor = game.actors.find(a => a.name === "Crate Tester" && a.folder?.id === folder?.id);
    if (!actor) throw new Error("no Crate Tester in Loot Crates Test: run live-pull.js first");
    if ((actor.system.currency.gp ?? 0) < 5) await actor.update({ "system.currency.gp": 1000 });
    const pool = Object.values(store.getPools()).find(p => p.name === "Live UI pool");
    if (!pool) throw new Error("no Live UI pool: run live-ui.js first");
    // The setting is a DataModel: its plain data is what is set and put back.
    const config = game.settings.get("dnd5e", "calendarConfig");
    const calendar = foundry.utils.deepClone(config?.toObject?.() ?? config ?? {});
    const turnOff = store.dayMode() !== "rest";
    if (turnOff) await game.settings.set("dnd5e", "calendarConfig", { ...calendar, enabled: false, dailyRecovery: "" });
    const old = Object.values(store.getBoxes()).find(b => b.name === name) ?? null;
    const today = store.todayKey(actor.id);
    // A well under a fresh id has no throws yet, so the cap is one.
    const base0 = 0;
    const well = await store.saveBox({
      // A fresh id each run: a run's throws stay in the log keyed on rest
      // counts the finally puts back, so on the old id they would count
      // again the next time the character reaches those counts.
      kind: "well", name, price: 0.1, pools: [{ id: pool.id, share: 1 }],
      weights: { uncommon: 75, rare: 25 }, odds: { nothing: 100, coin: 0, item: 0 }, rules: { cap: base0 + 1, pity: null, noDuplicates: false, stock: null },
    });
    const days = game.settings.get("loot-crates", "actorState")?.days ?? {};
    return {
      actorId: actor.id, wellId: well.id, old, calendar, calendarChanged: turnOff, mode: store.dayMode(),
      worldTime: game.time.worldTime, today, base: base0, cap: well.rules.cap,
      hadDays: Object.hasOwn(days, actor.id), days: days[actor.id] ?? null,
    };
  }, { base: MODULE_BASE, name: WELL });
}

async function restore(gm, before) {
  if (!gm || !before) return null;
  return gm.evaluate(async ({ base, before, name }) => {
    const out = {};
    const step = async (key, fn) => { try { out[key] = await fn(); } catch (err) { out[key] = `failed: ${err?.message ?? err}`; } };
    const store = await import(base + "scripts/store.js");
    await step("well", async () => {
      if (before.old) { await store.removeBox(before.wellId); await store.saveBox(before.old); return "restored (this run's well removed)"; }
      return Object.values(store.getBoxes()).some(b => b.name === name) ? "left seeded (new this run)" : "none";
    });
    await step("days", () => store.enqueueWrite(async () => {
      const all = foundry.utils.deepClone(game.settings.get("loot-crates", "actorState"));
      const days = { ...(all.days ?? {}) };
      if (before.hadDays) days[before.actorId] = before.days; else delete days[before.actorId];
      if (Object.keys(days).length) all.days = days; else delete all.days;
      await game.settings.set("loot-crates", "actorState", all);
      return `restored (${before.hadDays ? before.days : "none"})`;
    }));
    await step("calendar", async () => {
      if (!before.calendarChanged) return "unchanged";
      await game.settings.set("dnd5e", "calendarConfig", before.calendar);
      return "restored";
    });
    await step("worldTime", async () => {
      if (game.time.worldTime === before.worldTime) return "unchanged";
      await game.time.set(before.worldTime);
      return "restored";
    });
    return out;
  }, { base: MODULE_BASE, before, name: WELL });
}

// The player's shop, opened and on Crate Tester; `__lcWell()` reads the card.
async function openShop(page, wellId) {
  return page.evaluate(async ({ base, wellId }) => {
    const { openShop } = await import(base + "scripts/shop.js");
    const actor = game.actors.find(a => a.isOwner && a.type === "character" && a.name === "Crate Tester");
    if (!actor) throw new Error(`${game.user.name} doesn't own Crate Tester`);
    const app = openShop();
    await new Promise(r => setTimeout(r, 1500));
    const pick = app.element.querySelector(".lc-shop__actor");
    if (pick && pick.value !== actor.id) { pick.value = actor.id; pick.dispatchEvent(new Event("change")); await new Promise(r => setTimeout(r, 800)); }
    const card = () => app.element?.querySelector(`.lc-box[data-box="${wellId}"]`);
    globalThis.__lcWell = () => ({
      off: card()?.querySelector(".lc-box__buy")?.getAttribute("aria-disabled") === "true",
      why: card()?.querySelector(".lc-box__why")?.textContent.trim() ?? "",
      count: card()?.querySelector(".lc-box__stock")?.textContent.trim() ?? "",
    });
    globalThis.__lcThrow = async () => {
      const buy = card()?.querySelector(".lc-box__buy");
      if (!buy) throw new Error("no well card in the shop");
      if (buy.getAttribute("aria-disabled") === "true") throw new Error(`the well can't be thrown into: ${globalThis.__lcWell().why}`);
      const seen = new Set(document.querySelectorAll(".lc-reveal"));
      buy.focus();
      buy.click();
      let rv = null;
      for (let i = 0; i < 400 && !rv?.querySelector(".lc-well--landed"); i++) {
        await new Promise(r => setTimeout(r, 50));
        rv ??= [...document.querySelectorAll(".lc-reveal")].find(el => !seen.has(el)) ?? null;
      }
      const landed = !!rv?.querySelector(".lc-well--landed");
      await new Promise(r => setTimeout(r, 400));
      const revealApp = [...foundry.applications.instances.values()].find(a => a.element === rv);
      if (revealApp) await revealApp.close();
      await new Promise(r => setTimeout(r, 800));
      return { landed, card: globalThis.__lcWell() };
    };
    return globalThis.__lcWell();
  }, { base: MODULE_BASE, wellId });
}

// Waits for the card's Throw to be on (or off), from `since`.
const cardUntil = (page, want, since) => page.evaluate(async ({ want, since }) => {
  for (let i = 0; i < 300; i++) {
    const c = globalThis.__lcWell();
    if (c.off === want) return { ...c, ms: Date.now() - since };
    await new Promise(r => setTimeout(r, 20));
  }
  return { ...globalThis.__lcWell(), ms: null };
}, { want, since });

// A long rest through dnd5e's own API, on whichever client `page` is.
const longRest = (page, actorId) => page.evaluate(async actorId => {
  const actor = game.actors.get(actorId);
  const result = await actor.longRest({ dialog: false, chat: false, newDay: true });
  return { at: Date.now(), newDay: result?.newDay ?? null, worldTime: game.time.worldTime };
}, actorId);

const daysOf = (gm, actorId) => gm.evaluate(id => game.settings.get("loot-crates", "actorState")?.days?.[id] ?? null, actorId);

(async () => {
  const browser = await chromium.launch();
  const out = { player: PLAYER, well: WELL };
  let gm = null, before = null;
  try {
    const pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");
    before = await seed(gm.page);
    out.before = { mode: before.mode, calendarChanged: before.calendarChanged, today: before.today, thrownAlready: before.base, cap: before.cap, days: before.days, worldTime: before.worldTime };
    const still = `The well is still until tomorrow (${before.cap} of ${before.cap} today)`;

    out.shop = await openShop(pl.page, before.wellId);
    // 1. Throw to the cap.
    out.first = await pl.page.evaluate(() => globalThis.__lcThrow());
    // 2. The GM long-rests Crate Tester.
    const gmRest = await longRest(gm.page, before.actorId);
    out.gmRest = { ...gmRest, card: await cardUntil(pl.page, false, gmRest.at), days: await daysOf(gm.page, before.actorId) };
    // 3. Again to the cap, then the player's own long rest.
    out.second = await pl.page.evaluate(() => globalThis.__lcThrow());
    const plRest = await longRest(pl.page, before.actorId);
    out.playerRest = { ...plRest, card: await cardUntil(pl.page, false, plRest.at), days: await daysOf(gm.page, before.actorId) };
    out.worldTimeAfter = await gm.page.evaluate(() => game.time.worldTime);

    const d0 = before.days ?? 0;
    const capped = t => t.landed && t.card.off && t.card.why === still;
    const reopened = (r, n) => r.newDay === true && r.card.ms != null && r.card.ms <= 3000 && !r.card.off && r.card.why === "" && r.card.count === `0 of ${before.cap} throws today` && r.days === d0 + n;
    out.checks = {
      restMode: before.mode === "rest",
      firstCapped: capped(out.first),
      gmRestReopens: reopened(out.gmRest, 1),
      secondCapped: capped(out.second),
      playerRestReopens: reopened(out.playerRest, 2),
      clockStill: gmRest.worldTime === before.worldTime && plRest.worldTime === before.worldTime && out.worldTimeAfter === before.worldTime,
      errors: [...pl.logs, ...gm.logs].filter(t => /pageerror|failed/i.test(t)),
    };
    out.ok = Object.entries(out.checks).every(([k, v]) => (k === "errors" ? v.length === 0 : v === true));
  } catch (err) {
    out.ok = false;
    out.error = String(err?.stack || err);
  } finally {
    out.restored = await restore(gm?.page, before).catch(err => ({ error: String(err) }));
    await browser.close();
  }
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
})();
