// Live check: the Wishing Well (well.js) at a real table, with the branch's
// code on both ends.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/checks/live-well.cjs [--shot out.png]
//
// Env: PLAYER (default Player2, must own Crate Tester), WELL (the well's
// name, default "Live well"), HIDE_GM=1 (the GM's tab in the background).
//
// Two headless clients, the Gamemaster and the player, each with the
// installed module's socket listener removed and the branch's registered
// from MODULE_BASE (as player-pull.cjs does). The GM seeds a well "Live
// well" (1 sp a throw, drawing from "Live UI pool", odds nothing 100 so the
// five throws are five misses) with a cap of five more than Crate Tester
// has already thrown today (the cap is per in-game day, and the day doesn't
// turn between runs), and notes the world time, the purse and the log.
// Then, as a person does:
//
//   1. The player opens the shop, picks Crate Tester and presses the well's
//      Throw five times, waiting for each reveal to land (.lc-well--landed)
//      and closing it. After each, the card's count ("n of 5 throws today")
//      is read; after the fifth the Throw must be off with "The well is
//      still until tomorrow (5 of 5 today)" as its visible reason. No chat
//      card may appear for a miss; the reveal's result must sit in a live
//      region and read "The coin sinks. Nothing."; the purse must drop by
//      exactly 5 sp (50 cp) and five rows carrying today's key must be in
//      the Pull log.
//   2. The GM advances the world a day with dnd5e's calendar HUD (+1 day in
//      the advance menu; the HUD is shown for the check if the world has it
//      off, and put back). The player's card must drop the still line and
//      turn its Throw on within 2 s, with no press. The GM then turns the
//      day back the same way, and the still line must return.
//   3. The GM opens the manager's Pull log by clicking its tab, finds the
//      folded row ("5 throws, nothing"), presses Hide misses and Show misses,
//      then Refund one and Yes. The purse must gain 1 sp, the row must read
//      "4 throws, nothing", and the player's card must read "4 of 5 throws
//      today" with its Throw on, within 2 s.
//
// Everything the check changes is put back in a finally: the world time,
// the calendar HUD's settings, and the well's record (its odds and cap).
// Five real 1 sp throws, one refunded; nothing is deleted. Needs "Crate
// Tester" in "Loot Crates Test" and "Live UI pool" (live-ui.js makes them).
/* global game, foundry, Hooks, dnd5e -- used inside page.evaluate, which runs in the Foundry page */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const WELL = process.env.WELL || "Live well";
const HIDE_GM = process.env.HIDE_GM === "1";
const THROWS = 5;
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
  // What main.js does first: the branch's words, from its own lang/en.json
  // (the installed release may have no language file, or older words).
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
    const { sealChatCard, watchAgain, preSealItem } = await import(base + "scripts/foundry/reveal.js");
    Hooks.on("renderChatMessageHTML", sealChatCard);
    Hooks.on("renderChatMessageHTML", watchAgain);
    for (const h of [...(Hooks.events?.createItem ?? [])]) if (h.fn?.name === "preSealItem") Hooks.off("createItem", h.id);
    Hooks.on("createItem", preSealItem);
  }, MODULE_BASE);
  return { page, logs };
}

// The GM's side: seed the well, note what is to be restored.
async function seed(gm) {
  return gm.evaluate(async ({ base, name }) => {
    const store = await import(base + "scripts/foundry/store.js");
    const folder = game.folders.find(f => f.type === "Actor" && f.name === "Loot Crates Test");
    const actor = game.actors.find(a => a.name === "Crate Tester" && a.folder?.id === folder?.id);
    if (!actor) throw new Error("no Crate Tester in Loot Crates Test: run live-pull.js first");
    if ((actor.system.currency.gp ?? 0) < 5) await actor.update({ "system.currency.gp": 1000 });
    const pool = Object.values(store.getPools()).find(p => p.name === "Live UI pool");
    if (!pool) throw new Error("no Live UI pool: run live-ui.js first");
    const old = Object.values(store.getBoxes()).find(b => b.name === name) ?? null;
    const { throwsToday } = await import(base + "scripts/games/well.js");
    // This check turns the day with the calendar, so the calendar is the
    // day from the first throw: with it off (dnd5e 6's default) a day ends
    // at a long rest instead (clock.js; live-well-day.cjs checks that).
    const calendar = { config: foundry.utils.deepClone(game.settings.get("dnd5e", "calendarConfig")), prefs: foundry.utils.deepClone(game.settings.get("dnd5e", "calendarPreferences")) };
    if (!calendar.config?.enabled) await game.settings.set("dnd5e", "calendarConfig", { ...game.settings.get("dnd5e", "calendarConfig"), enabled: true });
    const today = store.todayKey(actor.id);
    const base0 = old ? throwsToday(store.getLog(), { boxId: old.id, actorId: actor.id, day: today }) : 0;
    const well = await store.saveBox({
      ...(old ? { id: old.id } : {}), kind: "well", name, price: 0.1, pools: [{ id: pool.id, share: 1 }],
      weights: { uncommon: 75, rare: 25 }, odds: { nothing: 100, coin: 0, item: 0 }, rules: { cap: base0 + 5, pity: null, noDuplicates: false, stock: null },
    });
    return {
      actorId: actor.id, wellId: well.id, old, worldTime: game.time.worldTime, today, base: base0, cap: well.rules.cap,
      calendarEnabled: !!(calendar.config?.enabled && calendar.prefs?.visible), calendar,
      purseCp: (await import(base + "scripts/core/currency.js")).toCopper(actor.system.currency),
      logIds: store.getLog().map(r => r.id), messages: game.messages.size,
    };
  }, { base: MODULE_BASE, name: WELL });
}

async function restore(gm, before) {
  if (!gm || !before) return null;
  return gm.evaluate(async ({ base, before, name }) => {
    const out = {};
    try {
      if (game.time.worldTime !== before.worldTime) { await game.time.set(before.worldTime); out.worldTime = "restored"; }
      if (!before.calendarEnabled) {
        await game.settings.set("dnd5e", "calendarConfig", before.calendar.config);
        await game.settings.set("dnd5e", "calendarPreferences", before.calendar.prefs);
        out.calendar = "restored";
      }
      const store = await import(base + "scripts/foundry/store.js");
      if (before.old) { await store.saveBox(before.old); out.well = "restored"; }
      else { const w = Object.values(store.getBoxes()).find(b => b.name === name); out.well = w ? "left seeded (new this run)" : "none"; }
    } catch (err) { out.error = String(err?.stack || err); }
    return out;
  }, { base: MODULE_BASE, before, name: WELL });
}

(async () => {
  const browser = await chromium.launch();
  const out = { player: PLAYER, well: WELL, gm: null };
  let gm = null, before = null;
  try {
    const pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");
    out.gm = "headless Gamemaster running the branch";
    before = await seed(gm.page);
    out.before = { today: before.today, purseCp: before.purseCp, rows: before.logIds.length, calendarEnabled: before.calendarEnabled, thrownAlready: before.base, cap: before.cap };
    if (HIDE_GM) {
      out.gmHidden = await gm.page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
        document.dispatchEvent(new Event("visibilitychange"));
        return document.visibilityState;
      });
    }

    // 1. Five throws through the shop's own button.
    out.throws = await pl.page.evaluate(async ({ base, wellId, count }) => {
      const { openShop } = await import(base + "scripts/foundry/shop.js");
      const actor = game.actors.find(a => a.isOwner && a.type === "character");
      if (!actor) throw new Error(`${game.user.name} owns no character`);
      const app = openShop();
      await new Promise(r => setTimeout(r, 1500));
      const pick = app.element.querySelector(".lc-shop__actor");
      if (pick && pick.value !== actor.id) { pick.value = actor.id; pick.dispatchEvent(new Event("change")); await new Promise(r => setTimeout(r, 800)); }
      const card = () => app.element.querySelector(`.lc-box[data-box="${wellId}"]`);
      const read = () => ({
        buy: card()?.querySelector(".lc-box__buy")?.textContent.trim() ?? null,
        off: card()?.querySelector(".lc-box__buy")?.getAttribute("aria-disabled") === "true",
        why: card()?.querySelector(".lc-box__why")?.textContent.trim() ?? "",
        count: card()?.querySelector(".lc-box__stock")?.textContent.trim() ?? "",
        pills: [...(card()?.querySelectorAll(".lc-odd") ?? [])].map(p => p.textContent.trim()),
      });
      const cards = [];
      Hooks.on("createChatMessage", m => { if (m.flags?.["loot-crates"]) cards.push(m.id); });
      // Make the shop's held state visible to the check without touching it.
      globalThis.__lcCard = read;
      const purchases = [];
      const start = read();
      for (let n = 0; n < count; n++) {
        const buy = card()?.querySelector(".lc-box__buy");
        if (!buy) throw new Error("no well card in the shop");
        if (buy.getAttribute("aria-disabled") === "true") throw new Error(`the well can't be thrown into: ${read().why}`);
        const seen = new Set(document.querySelectorAll(".lc-reveal"));
        buy.focus();
        const t0 = performance.now();
        buy.click();
        let rv = null, revealMs = null, landedMs = null;
        for (let i = 0; i < 400 && landedMs == null; i++) {
          await new Promise(r => setTimeout(r, 50));
          rv ??= [...document.querySelectorAll(".lc-reveal")].find(el => !seen.has(el)) ?? null;
          if (rv && revealMs == null) revealMs = Math.round(performance.now() - t0);
          if (rv?.querySelector(".lc-well--landed")) landedMs = Math.round(performance.now() - t0);
        }
        await new Promise(r => setTimeout(r, 400));
        const result = rv?.querySelector(".lc-reveal__result");
        const purchase = {
          ms: { reveal: revealMs, landed: landedMs },
          head: rv?.querySelector(".lc-reveal__head")?.innerText.replace(/\s+/g, " ").trim() ?? null,
          result: result?.innerText.replace(/\s+/g, " ").trim() ?? null,
          liveRegion: !!result?.closest("[aria-live]"),
          outcome: rv?.querySelector(".lc-well")?.dataset.outcome ?? null,
          watchAgain: !!(rv?.querySelector(".lc-reveal__watch") && !rv.querySelector(".lc-reveal__watch").hidden),
          focusOnClose: document.activeElement?.matches?.(".lc-reveal__close") ?? false,
        };
        const revealApp = [...foundry.applications.instances.values()].find(a => a.element === rv);
        if (revealApp) { await revealApp.close(); await new Promise(r => setTimeout(r, 500)); }
        purchase.card = read();
        purchases.push(purchase);
      }
      await new Promise(r => setTimeout(r, 800));
      return { start, purchases, chatCards: cards.length, final: read(), purse: foundry.utils.deepClone(actor.system.currency) };
    }, { base: MODULE_BASE, wellId: before.wellId, count: THROWS });

    out.gmAfterThrows = await gm.page.evaluate(async ({ base, before }) => {
      const store = await import(base + "scripts/foundry/store.js");
      const { toCopper } = await import(base + "scripts/core/currency.js");
      const actor = game.actors.get(before.actorId);
      const rows = store.getLog().filter(r => !before.logIds.includes(r.id));
      return { purseCp: toCopper(actor.system.currency), newRows: rows.map(r => ({ kind: r.kind, outcome: r.outcome, day: r.day, price: r.price, payoutCp: r.payoutCp, itemId: r.itemId })), messages: game.messages.size };
    }, { base: MODULE_BASE, before });

    // 2. The day turns, by the real calendar control.
    out.day = await (async () => {
      const show = await gm.page.evaluate(async enabled => {
        if (!enabled) {
          await game.settings.set("dnd5e", "calendarConfig", { ...game.settings.get("dnd5e", "calendarConfig"), enabled: true });
          await game.settings.set("dnd5e", "calendarPreferences", { ...game.settings.get("dnd5e", "calendarPreferences"), visible: true });
          dnd5e.ui.calendar?.onUpdateSettings?.();
          await new Promise(r => setTimeout(r, 800));
        }
        return { hud: !!document.getElementById("calendar-hud"), buttons: document.querySelectorAll('#calendar-hud [data-action="advance"]').length };
      }, before.calendarEnabled);
      if (!show.hud) return { ok: false, error: "no calendar HUD on the GM's page", show };
      // The +1 day / -1 day buttons sit in the HUD's hover menu: hovered
      // open, they take a pointer click; a headless page that can't hold the
      // hover gets a click event on the real button instead. The time is
      // stamped at the click that happens.
      const press = async action => {
        const main = gm.page.locator(`#calendar-hud [data-action="${action}"]:not([data-unit="day"]):not([data-unit="minute"])`).first();
        await main.hover().catch(() => {});
        const btn = gm.page.locator(`#calendar-hud [data-action="${action}"][data-unit="day"][data-value="1"]`).first();
        const visible = await btn.isVisible().catch(() => false);
        const at = Date.now();
        if (visible) await btn.click();
        else await btn.evaluate(el => el.click());
        return at;
      };
      const until = (want, since) => pl.page.evaluate(async ({ want, since }) => {
        for (let i = 0; i < 250; i++) {
          const c = globalThis.__lcCard();
          if (c.off === want) return { ...c, ms: Date.now() - since };
          await new Promise(r => setTimeout(r, 20));
        }
        return { ...globalThis.__lcCard(), ms: null };
      }, { want, since });
      const advancedAt = await press("advance");
      const cleared = await until(false, advancedAt);
      const todayAfter = await gm.page.evaluate(async ({ base, before }) => (await import(base + "scripts/foundry/store.js")).todayKey(before.actorId), { base: MODULE_BASE, before });
      const reversedAt = await press("reverse");
      const back = await until(true, reversedAt);
      const todayBack = await gm.page.evaluate(async ({ base, before }) => (await import(base + "scripts/foundry/store.js")).todayKey(before.actorId), { base: MODULE_BASE, before });
      const ok = cleared.ms != null && cleared.ms <= 2000 && !cleared.off && cleared.why === "" && cleared.count === `0 of ${before.cap} throws today` && todayAfter !== before.today
        && back.ms != null && back.ms <= 2000 && back.off && back.why === `The well is still until tomorrow (${before.cap} of ${before.cap} today)` && todayBack === before.today;
      return { ok, show, cleared, todayAfter, back, todayBack };
    })();

    // 3. The GM refunds one throw from the folded row.
    out.refund = await gm.page.evaluate(async ({ base, before }) => {
      const { openManager } = await import(base + "scripts/foundry/manager.js");
      const store = await import(base + "scripts/foundry/store.js");
      const { toCopper } = await import(base + "scripts/core/currency.js");
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const until = async (fn, ms = 15000) => { for (let t = 0; t < ms && !fn(); t += 50) await wait(50); return fn(); };
      const click = el => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
      const actor = game.actors.get(before.actorId);
      const purseBefore = toCopper(actor.system.currency);
      const app = openManager();
      await until(() => app.element?.querySelector('.lc-tabs [data-tab="log"]'));
      click(app.element.querySelector('.lc-tabs [data-tab="log"]'));
      if (!await until(() => app.tab === "log" && app.element?.querySelector(".lc-row--group"), 8000)) throw new Error("the Pull log has no folded row");
      const groupText = () => [...app.element.querySelectorAll(".lc-row--group")].map(tr => tr.innerText.replace(/\s+/g, " ").trim());
      const groupsBefore = groupText();
      // Hide misses, then show them again.
      click(app.element.querySelector('[data-action="toggleMisses"]'));
      await until(() => app.element?.querySelector('[data-action="toggleMisses"]')?.getAttribute("aria-pressed") === "true", 5000);
      const hidden = { groups: [...app.element.querySelectorAll(".lc-row--group")].filter(tr => /throws?, nothing/.test(tr.innerText)).length, button: app.element.querySelector('[data-action="toggleMisses"]')?.textContent.trim(), pressed: app.element.querySelector('[data-action="toggleMisses"]')?.getAttribute("aria-pressed") };
      click(app.element.querySelector('[data-action="toggleMisses"]'));
      // A table round's header is a .lc-row--group too, and stays while
      // misses are hidden: wait for the redraw that shows them again.
      const refundBtn = () => [...app.element.querySelectorAll(".lc-row--group button[data-action=refund]")].find(b => b.closest("tr").innerText.includes("Crate Tester"));
      await until(() => app.element?.querySelector('[data-action="toggleMisses"]')?.getAttribute("aria-pressed") === "false" && refundBtn(), 5000);
      if (!refundBtn()) throw new Error("no Refund one on Crate Tester's folded row");
      const rowId = refundBtn().dataset.row;
      refundBtn().focus();
      click(refundBtn());
      const dialog = () => [...document.querySelectorAll(".application.dialog")].pop();
      const yes = () => [...(dialog()?.querySelectorAll("button") ?? [])].find(b => /yes/i.test(b.dataset.action ?? b.textContent));
      await until(() => yes());
      const dialogText = dialog()?.querySelector(".window-content")?.textContent.replace(/\s+/g, " ").trim() ?? null;
      const at = Date.now();
      click(yes());
      await until(() => store.getLog().find(r => r.id === rowId)?.refunded);
      await until(() => groupText().some(t => new RegExp(`${before.cap - 1} throws, nothing`).test(t)), 5000);
      const groupsAfter = groupText();
      await app.close();
      return { at, rowId, groupsBefore, hidden, dialogText, groupsAfter, purseBefore, purseAfter: toCopper(actor.system.currency) };
    }, { base: MODULE_BASE, before });
    out.cardAfterRefund = await pl.page.evaluate(async since => {
      for (let i = 0; i < 250; i++) {
        const c = globalThis.__lcCard();
        if (!c.off) return { ...c, ms: Date.now() - since };
        await new Promise(r => setTimeout(r, 20));
      }
      return { ...globalThis.__lcCard(), ms: null };
    }, out.refund.at);
    if (shot) await pl.page.screenshot({ path: shot });

    const t = out.throws;
    const rows = out.gmAfterThrows.newRows;
    const { base, cap } = before;
    out.checks = {
      // The buyer's result: the quiet line, then their gold left and the day's count.
      fiveMisses: t.purchases.length === THROWS && t.purchases.every((p, i) => p.outcome === "nothing" && new RegExp(`^The coin sinks\\. Nothing\\. \\d.* left · ${base + i + 1} of ${cap} throws today$`).test(p.result ?? "") && p.liveRegion && !p.watchAgain),
      headNamesTheThrow: t.purchases.every(p => /throws a coin into Live well 1 sp/.test(p.head ?? "")),
      focusOnClose: t.purchases.every(p => p.focusOnClose),
      landedUnder4s: t.purchases.every(p => p.ms.landed != null && p.ms.landed <= 4000),
      noChatCard: t.chatCards === 0 && out.gmAfterThrows.messages === before.messages,
      countsClimb: t.purchases.slice(0, THROWS - 1).map(p => p.card.count).join("|") === Array.from({ length: THROWS - 1 }, (_, i) => `${base + i + 1} of ${cap} throws today`).join("|"),
      stillAtCap: t.final.off && t.final.why === `The well is still until tomorrow (${cap} of ${cap} today)` && t.final.count === "",
      buyLabel: t.start.buy === "Live well: Throw 1 sp" && t.start.pills.join(", ") === "Nothing 100%",
      purseDropped5sp: out.gmAfterThrows.purseCp === before.purseCp - 10 * THROWS,
      fiveRowsToday: rows.length === THROWS && rows.every(r => r.kind === "well" && r.outcome === "nothing" && r.day === before.today && r.price === 0.1 && r.payoutCp === 0 && r.itemId === null),
      dayTurns: out.day.ok,
      refund: out.refund.groupsBefore.some(x => new RegExp(`${cap} throws, nothing`).test(x)) && out.refund.hidden.groups === 0 && out.refund.hidden.button === "Hide misses" && out.refund.hidden.pressed === "true"
        && out.refund.groupsAfter.some(x => new RegExp(`${cap - 1} throws, nothing`).test(x)) && out.refund.purseAfter === out.refund.purseBefore + 10
        && /Return 1 sp to Crate Tester/.test(out.refund.dialogText ?? ""),
      cardAfterRefund: out.cardAfterRefund.ms != null && out.cardAfterRefund.ms <= 2000 && !out.cardAfterRefund.off && out.cardAfterRefund.count === `${cap - 1} of ${cap} throws today`,
    };
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
