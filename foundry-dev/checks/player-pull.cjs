// A real player purchase, timed, with the branch's code on both ends.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/checks/player-pull.cjs [--shot out.png]
//
// Env: PLAYER (default Player2, must own a character with coins), BOX (crate
// name, default "Live UI crate").
//
// Two headless clients: the Gamemaster (when that seat is free) and the
// player. In each, the installed Loot Crates' socket listener is removed and
// the branch's is registered from MODULE_BASE, so the pull runs the working
// copy, never the installed copy and never both (two listeners on one GM
// client would charge twice). If a person holds the Gamemaster seat, their
// client (running the installed module) does the pull and the result says so:
// timings then describe the installed code, not the branch.
//
// COUNT=n (1 to 3, default 1) buys n crates in a row in the same session;
// the first is the first purchase after a fresh GM page load, and the GM runs
// the branch's load-time sweep of every pool (main.js ready) just before it,
// so a pull that waits on that sweep shows. The GM's per-step timings
// (socket.js stepTimer, a console.debug line) are in gmTimings.
//
// Headless Chromium draws Foundry's canvas with SwiftShader (software), and
// on this VM every frame takes 0.5 to 1.4 s, so each await on either client
// waits that long behind it: a measure of the VM, not of the module (a GPU
// draws the same scene in milliseconds). Both clients' canvas ticker is
// paused unless CANVAS=on, which keeps it running to see the worst case.
//
// HIDE_GM=1 forces the headless GM page's document hidden (visibilityState
// and a visibilitychange event) before the purchase, as a GM with their
// Foundry tab in the background: the chat card must still reach the table
// (chatMs, from the click to the player's client seeing the ChatMessage), the
// GM's own reveal lands at once, and no toast fires on the GM unless the pull
// was slow (gmToasts lists every notification the GM's page raised).
// Then the GM "comes back" (visible again) and gmWatch reports Watch again in
// that reveal, which never spun there: it must be shown beside Close; a real
// click turns it into Skip with the result hidden, the strip replays to a
// landed card with the same result, Watch again goes, focus is on Close, and
// the chat log and Pull log are unchanged.
//
// GM_LOG=1 opens the branch's manager on the headless GM's Pull log before
// the purchase and reports gmLog.rowMs: from the player's click to the new
// row standing in the GM's .lc-table (written by the GM's own pull, drawn by
// the settings' onChange; redraw.js), which must be within 2 s.
//
// CLOSE_SHOP=1 buys nothing: with the player's shop open, the GM clicks the
// manager's shop toggle ("Shop open", pressed -> unpressed) and closeShop reports how
// long the player's crate took to show it (Buy aria-disabled, the header
// notice naming the closed shop), within 2 s, then opens the shop again the
// same way and reports the Buy back on.
//
// focus follows the keyboard: the Buy is focused before it is pressed, and
// focusAfterCharge records where focus is once the GM's charge reached this
// client (updateActor re-renders the shop): it must still be that Buy (the
// shop keeps its nodes) or the reveal's Close. focusAtLanding and
// focusAfterClose: Close on landing, then back on the Buy when it closes.
//
// REPLAY=1, after the purchase: on the player's client, clicks "Watch
// again" on the new chat card in the chat log (a real mouse click; the chat
// tab is clicked open first if needed) and reports the replay: its window
// title ("Replay: ..."), the item and rarity it lands on against the card's
// result, no gold line and no Open item, that a second click brings the same
// window forward rather than opening another, and that the chat message
// count, the Pull log's rows, the character's purse and items are unchanged.
// Focus must move from the clicked Watch again to the replay's Close on
// landing (focusAtLanding); Close is then clicked and focus must return to
// the Watch again button (focusBack).
//
// SEAL=1 (use a BOX with a pity rule, e.g. "Live pity crate"): before the
// purchase the player opens their character's sheet from the Actors sidebar
// (a click on its name, as a person does) and its Inventory tab, with the
// shop still open. `seal` reports, for the item the pull grants: whether any
// element naming it ([data-item-id]) was visible in any animation frame
// between the click and the landing (leakFrames, must be 0), at reveal +1 s
// (row hidden, the shop card's pity text and odds unchanged from before the
// click, and the crate's Buy off with "Still spinning") and at landed +0.5 s
// (row visible, the pity text now what the new state says, and "Still
// spinning" gone; whether the pity text or odds changed is reported as
// changedAfterPull, a fact that depends on what the character owns, not a
// pass condition). reveal.js holds both until
// this client's spin lands. longTasks and sheetRenders show what kept the
// player's page busy: on this VM an open dnd5e sheet takes ~0.9 s to
// re-render, once for the charge and once for the item, and the reveal
// waits behind both (~2.4 s from the click instead of ~0.5 s).
//
// chatRenders lists each rendering of the pull's chat card on the player's
// client and whether it was sealed (head and "Opening…", reveal.js
// sealChatCard): a card rendered while that client's spin plays must be, and
// chatSealedAfterLanding must be 0.
//
// Prints JSON: who did the pull, the purse before and
// after, the item granted, and timings from the click: reveal broadcast
// received, strip landed; plus the GM's `loot-crates |` console lines.
/* global game, foundry, Hooks, ui -- used inside page.evaluate, which runs in the Foundry page */
const { chromium } = require("playwright");
const { keepWindowsOpen } = require("./lib/linger.cjs");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const BOX = process.env.BOX || "Live UI crate";
const CANVAS = process.env.CANVAS === "on";
const HIDE_GM = process.env.HIDE_GM === "1";
const COUNT = Math.min(3, Math.max(1, Number(process.env.COUNT) || 1));
const GM_LOG = process.env.GM_LOG === "1";
const CLOSE_SHOP = process.env.CLOSE_SHOP === "1";
const REPLAY = process.env.REPLAY === "1";
const SEAL = process.env.SEAL === "1";
const shot = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : null;

async function join(browser, user, { readySweep = false } = {}) {
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
  // The branch's socket in place of the installed one.
  await page.evaluate(async ([base, readySweep, canvasOn]) => {
    if (!canvasOn) globalThis.canvas?.app?.ticker?.stop();
    game.socket.off("module.loot-crates");
    const store = await import(base + "scripts/foundry/store.js");
    try { store.registerSettings(); } catch { /* the installed module registered them */ }
    try { store.registerIndexFields?.(); } catch { /* already in CONFIG */ }
    const socket = await import(base + "scripts/foundry/socket.js");
    socket.registerSocket();
    // What main.js's init does: open windows redraw as the world settings
    // change. If the installed module registered the settings first and
    // Foundry kept its entries, point their onChange at the branch's too.
    const { storeRedraw } = await import(base + "scripts/core/redraw.js");
    const { refreshShop, registerShopHooks } = await import(base + "scripts/foundry/shop.js");
    const { refreshManager } = await import(base + "scripts/foundry/manager.js");
    const redraw = storeRedraw({ refreshShop, refreshManager });
    store.setStoreListener(redraw);
    for (const key of store.WORLD_KEYS) {
      const cfg = game.settings.settings.get(`loot-crates.${key}`);
      if (cfg && !String(cfg.onChange ?? "").includes("storeChanged")) cfg.onChange = () => redraw(key);
    }
    // What main.js does for the shop: it redraws on the purse and on
    // ownership changes.
    registerShopHooks?.(Hooks);
    // What main.js does for chat: a pull's card stays sealed while it spins here.
    // And "Watch again" on a pull's card.
    const { sealChatCard, watchAgain, preSealItem } = await import(base + "scripts/foundry/reveal.js");
    Hooks.on("renderChatMessageHTML", sealChatCard);
    Hooks.on("renderChatMessageHTML", watchAgain);
    // And for the sheet: a pull's item stays hidden until it lands here. The
    // installed module (0.7.0 on) pre-seals too, into the same <style>, and
    // with its socket listener off it never takes the hold over: its pre-seal
    // timer ran out mid-spin and emptied the style the branch's hold had
    // filled. Only the branch's pre-seal runs, as with the socket.
    for (const h of [...(Hooks.events?.createItem ?? [])]) if (h.fn?.name === "preSealItem") Hooks.off("createItem", h.id);
    Hooks.on("createItem", preSealItem);
    // What main.js's ready hook does on the active GM.
    if (readySweep && socket.isActiveGM()) store.sweepAllPools();
  }, [MODULE_BASE, readySweep, CANVAS]);
  return { page, logs };
}

/*
  The GM closes the shop from the manager's toggle while the player's shop is
  open; the player's crate must show it within 2 s without a press. Then the
  GM opens it again (always, even when the check fails).
*/
async function closeShopCheck(player, gm) {
  await player.evaluate(async ({ base, box }) => {
    const { openShop } = await import(base + "scripts/foundry/shop.js");
    const app = openShop();
    await new Promise(r => setTimeout(r, 1500));
    globalThis.__lcShop = () => {
      const card = [...app.element.querySelectorAll(".lc-box")].find(c => c.querySelector(".lc-box__name")?.textContent.trim() === box);
      const buy = card?.querySelector(".lc-box__buy");
      return { off: buy?.getAttribute("aria-disabled") === "true", notice: app.element.querySelector(".lc-shop__notice")?.textContent.trim() ?? "" };
    };
  }, { base: MODULE_BASE, box: BOX });
  const before = await player.evaluate(() => globalThis.__lcShop());
  if (before.off) throw new Error(`${BOX} can't be bought before the check: ${before.notice}`);
  await gm.evaluate(async base => {
    const { openManager } = await import(base + "scripts/foundry/manager.js");
    const app = openManager();
    await app.render({ force: true });
    await new Promise(r => setTimeout(r, 500));
    globalThis.__lcToggle = () => {
      const t = app.element.querySelector(".lc-shop-toggle");
      const at = Date.now();
      t.click();
      return { at, was: t.textContent.trim() };
    };
  }, MODULE_BASE);
  const until = (want, since) => player.evaluate(async ({ want, since }) => {
    for (let i = 0; i < 250; i++) {
      const s = globalThis.__lcShop();
      if (s.off === want) return { ...s, ms: Date.now() - since };
      await new Promise(r => setTimeout(r, 20));
    }
    return { ...globalThis.__lcShop(), ms: null };
  }, { want, since });
  const closed = await gm.evaluate(() => globalThis.__lcToggle());
  const closedSeen = await until(true, closed.at);
  // Open it again however the first half went.
  let openedSeen = null;
  const isOpen = () => gm.evaluate(() => game.settings.get("loot-crates", "shopOpen"));
  if (!(await isOpen())) {
    const opened = await gm.evaluate(() => globalThis.__lcToggle());
    openedSeen = await until(false, opened.at);
  }
  const ok = closed.was === "Shop open" && closedSeen.ms != null && closedSeen.ms <= 2000 && /closed/i.test(closedSeen.notice)
    && openedSeen?.ms != null && openedSeen.ms <= 2000 && (await isOpen());
  return { before, toggled: closed.was, closed: closedSeen, reopened: openedSeen, shopOpenAtEnd: await isOpen(), ok };
}

/*
  SEAL: the player opens their character's sheet as a person does: the
  Actors tab in the sidebar, a click on the character's name, then the
  sheet's Inventory tab.
*/
async function openSheet(page) {
  const id = await page.evaluate(() => game.actors.find(a => a.isOwner && a.type === "character")?.id);
  await page.locator('#sidebar [data-tab="actors"]').first().click();
  await page.waitForTimeout(600);
  const entry = page.locator(`#actors [data-entry-id="${id}"] .entry-name`).first();
  // Open its folder (and any folder above it) first, as a person would.
  if (!(await entry.isVisible())) {
    const folders = await page.evaluate(id => {
      const out = [];
      for (let f = game.actors.get(id)?.folder; f; f = f.folder) out.unshift(f.id);
      return out;
    }, id);
    for (const fid of folders) {
      const folder = page.locator(`#actors .folder[data-folder-id="${fid}"]`).first();
      if (!(await folder.evaluate(el => el.classList.contains("expanded")))) {
        await folder.locator(":scope > header").first().click();
        await page.waitForTimeout(400);
      }
    }
  }
  await entry.click();
  const sheet = page.locator(`.application.sheet.actor[id$="${id}"]`).first();
  await sheet.waitFor({ timeout: 15000 });
  await page.waitForTimeout(800);
  await sheet.locator('nav [data-tab="inventory"]').first().click();
  await page.waitForTimeout(600);
  return page.evaluate(id => {
    const el = [...document.querySelectorAll(".application.sheet.actor")].find(e => e.id.endsWith(id));
    const active = el?.querySelector('nav [data-tab].active')?.dataset.tab ?? null;
    return { id: el?.id ?? null, tab: active, rows: el?.querySelectorAll("[data-item-id]").length ?? 0 };
  }, id);
}

/*
  Watch again, driven as a person does: click the button on the newest pull
  card in the chat log, watch the replay land, click it again, click Close.
*/
async function replayCheck(page) {
  const facts = () => page.evaluate(async base => {
    const { getLog } = await import(base + "scripts/foundry/store.js");
    const actor = game.actors.find(a => a.isOwner && a.type === "character");
    const msg = game.messages.contents.filter(m => m.flags?.["loot-crates"]?.logId).at(-1);
    return {
      messages: game.messages.size, logRows: getLog().length,
      purse: JSON.stringify(actor.system.currency), items: actor.items.size,
      messageId: msg?.id ?? null, stored: msg?.flags["loot-crates"].replay?.result ?? null,
      replayBytes: msg?.flags["loot-crates"].replay ? JSON.stringify(msg.flags["loot-crates"].replay).length : 0,
      windows: document.querySelectorAll(".lc-reveal").length,
    };
  }, MODULE_BASE);
  const before = await facts();
  if (!before.messageId || !before.stored) return { ok: false, error: "the newest pull card has no replay snapshot", before };
  const btn = page.locator(`#chat .chat-log [data-message-id="${before.messageId}"] .lc-chat__replay`);
  // A collapsed sidebar keeps the chat log in the page but off screen: open
  // it from the chat tab, as a person would.
  if (!(await btn.isVisible()) || !(await page.evaluate(() => ui.sidebar?.expanded ?? true))) {
    await page.locator('#sidebar [data-tab="chat"]').first().click().catch(() => {});
    await page.waitForTimeout(600);
  }
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  await page.waitForSelector(".application.lc-reveal .lc-card--landed", { timeout: 15000 });
  await page.waitForTimeout(200);
  // The click left focus on Watch again; on landing it moves to the
  // replay's Close, as a Buy's does to the reveal's.
  const focusAtLanding = await page.evaluate(() => document.activeElement?.matches?.(".application.lc-reveal .lc-reveal__close") ? "Close" : document.activeElement?.matches?.(".lc-chat__replay") ? "Watch again" : document.activeElement?.tagName ?? "none");
  const seen = await page.evaluate(() => {
    const el = [...document.querySelectorAll(".application.lc-reveal")].find(a => /^Replay:/.test(a.querySelector(".window-title")?.textContent.trim() ?? ""));
    if (!el) return null;
    const shown = n => !!n && !n.hidden && n.getBoundingClientRect().height > 0;
    const landed = el.querySelector(".lc-card--landed");
    return {
      id: el.id, title: el.querySelector(".window-title").textContent.trim(),
      landedName: landed?.querySelector(".lc-card__name")?.textContent, landedRarity: landed?.dataset.rarity,
      result: el.querySelector(".lc-reveal__result")?.innerText ?? "",
      gold: /\d [gsc]p left/.test(el.querySelector(".lc-reveal__result")?.innerText ?? ""),
      openItem: shown(el.querySelector(".lc-reveal__open")),
      button: el.querySelector(".lc-reveal__close")?.textContent.trim(),
    };
  });
  // A second press: the same window, brought forward.
  await btn.click();
  await page.waitForTimeout(600);
  const replayWindows = await page.evaluate(() => [...document.querySelectorAll(".application.lc-reveal")].filter(a => /^Replay:/.test(a.querySelector(".window-title")?.textContent.trim() ?? "")).length);
  await page.waitForTimeout(800);
  const after = await facts();
  // Close as a person would; focus should be back on Watch again.
  await page.locator(`#${seen?.id} .lc-reveal__close`).click();
  await page.waitForTimeout(800);
  const focusBack = await page.evaluate(id => document.activeElement?.matches?.(`[data-message-id="${id}"] .lc-chat__replay`) ?? false, before.messageId);
  const unchanged = ["messages", "logRows", "purse", "items"].every(k => before[k] === after[k]);
  const ok = !!seen && /^Replay: .+ opens .+/.test(seen.title) && seen.landedName === before.stored.name && seen.landedRarity === before.stored.rarity
    && !seen.gold && !seen.openItem && seen.button === "Close" && replayWindows === 1 && unchanged
    && focusAtLanding === "Close" && focusBack;
  return { ok, seen, stored: before.stored, replayBytes: before.replayBytes, replayWindows, unchanged, before, after, focusAtLanding, focusBack };
}

/*
  Watch again in the GM's own reveal, which landed while the page was
  hidden. The page is made visible again (the GM back on the tab), then the
  button is clicked as a person would.
*/
async function gmWatchCheck(page) {
  const id = await page.evaluate(async base => {
    // The installed module's stylesheet is the released one: add the branch's.
    if (!document.querySelector("link[data-lc-branch]")) {
      const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: base + "styles/module.css" });
      link.dataset.lcBranch = "1";
      document.head.append(link);
      await new Promise(r => { link.onload = r; link.onerror = r; });
    }
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
    const { getLog } = await import(base + "scripts/foundry/store.js");
    globalThis.__lcCounts = () => ({ messages: game.messages.size, logRows: getLog().length });
    globalThis.__lcBefore = globalThis.__lcCounts();
    return [...document.querySelectorAll(".application.lc-reveal")].at(-1)?.id ?? null;
  }, MODULE_BASE);
  if (!id) return { ok: false, error: "no reveal window on the GM" };
  const state = () => page.evaluate(id => {
    const el = document.getElementById(id);
    const watch = el.querySelector(".lc-reveal__watch");
    const shown = n => !!n && !n.hidden && n.getBoundingClientRect().height > 0;
    return {
      watch: shown(watch) ? watch.textContent.trim() : null,
      close: el.querySelector(".lc-reveal__close")?.textContent.trim(),
      landed: !!el.querySelector(".lc-card--landed"),
      resultHidden: (r => r.hidden || getComputedStyle(r).visibility === "hidden")(el.querySelector(".lc-reveal__result")),
      name: el.querySelector(".lc-reveal__name")?.textContent ?? null,
      focus: document.activeElement === watch ? "Watch again" : document.activeElement?.matches?.(".lc-reveal__close") ? "Close" : document.activeElement?.tagName ?? "none",
    };
  }, id);
  const before = await state();
  if (before.watch !== "Watch again") return { ok: false, error: "no Watch again on the GM's hidden-landed reveal", before };
  await page.locator(`#${id} .lc-reveal__watch`).click();
  await page.waitForTimeout(150);
  const playing = await state();
  const t0 = Date.now();
  await page.waitForSelector(`#${id} .lc-card--landed`, { timeout: 15000 });
  const replayMs = Date.now() - t0;
  await page.waitForTimeout(300);
  const after = await state();
  const counts = await page.evaluate(() => ({ before: globalThis.__lcBefore, after: globalThis.__lcCounts() }));
  const unchanged = counts.before.messages === counts.after.messages && counts.before.logRows === counts.after.logRows;
  const ok = playing.watch === "Skip" && !playing.landed && playing.resultHidden && playing.close === "Close"
    && after.landed && after.watch === null && !after.resultHidden && after.name === before.name && after.focus === "Close" && unchanged;
  return { ok, before, playing, after, replayMs, counts, unchanged };
}

(async () => {
  const browser = await chromium.launch();
  const out = { gm: null, player: PLAYER, box: BOX, canvas: CANVAS ? "running (software)" : "paused" };
  const linger = keepWindowsOpen();
  try {
    // The player first, so the GM's page load (and its load-time sweep) is
    // as fresh as it can be when the first crate is bought.
    const pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    const gm = await join(browser, "Gamemaster", { readySweep: true });
    out.gm = gm ? "headless Gamemaster running the branch" : "a person's Gamemaster client running the installed module";
    // The reveal is read after it lands (Watch again, gmWatch): finished
    // windows stay open for the run on the pages this check drives (lib/linger.cjs).
    await linger.hold(pl.page, PLAYER);
    if (gm) await linger.hold(gm.page, "Gamemaster");
    if (HIDE_GM) {
      if (!gm) throw new Error("HIDE_GM needs the headless Gamemaster");
      out.gmHidden = await gm.page.evaluate(() => {
        globalThis.__lcToasts = [];
        for (const kind of ["info", "warn", "error"]) {
          const orig = ui.notifications[kind].bind(ui.notifications);
          ui.notifications[kind] = (msg, opts) => { globalThis.__lcToasts.push({ kind, msg: String(msg), permanent: !!opts?.permanent }); return orig(msg, opts); };
        }
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
        document.dispatchEvent(new Event("visibilitychange"));
        return document.visibilityState;
      });
    }
    if (CLOSE_SHOP) {
      if (!gm) throw new Error("CLOSE_SHOP needs the headless Gamemaster");
      out.closeShop = await closeShopCheck(pl.page, gm.page);
      if (!out.closeShop.ok) process.exitCode = 1;
      return;
    }
    if (GM_LOG) {
      if (!gm) throw new Error("GM_LOG needs the headless Gamemaster");
      await gm.page.evaluate(async base => {
        const { openManager } = await import(base + "scripts/foundry/manager.js");
        const app = openManager();
        app.tab = "log";
        await app.render({ force: true });
        await new Promise(r => setTimeout(r, 500));
        const rows = () => app.element?.querySelectorAll(".lc-table tbody tr").length ?? 0;
        const first = () => app.element?.querySelector(".lc-table tbody tr")?.innerText ?? null;
        globalThis.__lcLog = { before: rows(), firstBefore: first(), at: null, renders: 0 };
        const watch = setInterval(() => {
          if (globalThis.__lcLog.at == null && rows() > globalThis.__lcLog.before) {
            globalThis.__lcLog.at = Date.now();
            globalThis.__lcLog.firstAfter = first();
            globalThis.__lcLog.tab = app.tab;
          }
        }, 20);
        setTimeout(() => clearInterval(watch), 60000);
      }, MODULE_BASE);
    }
    if (SEAL) out.sheetOpened = await openSheet(pl.page);
    const result = await pl.page.evaluate(async ({ base, box, count, seal }) => {
      const { openShop } = await import(base + "scripts/foundry/shop.js");
      const actor = game.actors.find(a => a.isOwner && a.type === "character");
      if (!actor) throw new Error(`${game.user.name} owns no character`);
      const before = foundry.utils.deepClone(actor.system.currency);
      const app = openShop();
      await new Promise(r => setTimeout(r, 1500));
      const pick = app.element.querySelector(".lc-shop__actor");
      if (pick && pick.value !== actor.id) { pick.value = actor.id; pick.dispatchEvent(new Event("change")); await new Promise(r => setTimeout(r, 800)); }
      const purchases = [];
      /*
        SEAL: watches the item this pull grants on every animation frame
        from the click to the landing (any element naming it visible is a
        leak), and reads the shop card's pity text and odds at two moments.
      */
      async function sealWatch(base, actor, card) {
        const { getActorState, getBoxes, getPools } = await import(base + "scripts/foundry/store.js");
        const { shopOdds } = await import(base + "scripts/core/odds.js");
        const { pityLine } = await import(base + "scripts/views/boxcard.js");
        const boxId = card.dataset.box;
        const shopCard = () => document.querySelector(`.lc-shop .lc-box[data-box="${boxId}"]`);
        // "" when the card has no pity line (none this buyer can reach).
        const pity = () => shopCard()?.querySelector(".lc-box__pity")?.textContent.trim() ?? "";
        const odds = () => shopCard()?.querySelector(".lc-box__odds")?.textContent.replace(/\s+/g, " ").trim() ?? null;
        const expectedPity = () => pityLine(shopOdds(getBoxes()[boxId], getPools(), getActorState(actor.id, boxId)));
        let itemId = null, createdAt = null, leakFrames = 0, frames = 0, done = false;
        const hook = Hooks.on("createItem", item => { if (item.parent === actor && item.flags?.["loot-crates"]?.boxId) { itemId ??= item.id; createdAt ??= performance.now(); } });
        // What kept this client's main thread busy (an open sheet re-renders
        // on the charge and on the new item), and when the sheet rendered.
        const t0 = performance.now();
        const longTasks = [];
        const observer = new PerformanceObserver(list => { for (const e of list.getEntries()) longTasks.push([Math.round(e.startTime - t0), Math.round(e.duration)]); });
        try { observer.observe({ type: "longtask" }); } catch { /* not supported */ }
        const sheetRenders = [];
        const renderHook = Hooks.on("renderActorSheetV2", app => { if (app.document === actor) sheetRenders.push(Math.round(performance.now() - t0)); });
        const rows = () => itemId ? [...document.querySelectorAll(`[data-item-id="${itemId}"]`)] : [];
        const visible = () => rows().some(el => el.getClientRects().length > 0);
        // The landing is read on the frame itself: the loop below polls for
        // it every 50 ms, and the item is shown (rightly) the moment the spin
        // lands, so frames in that gap were counted as leaks.
        const revealsBefore = new Set(document.querySelectorAll(".lc-reveal"));
        const landedNow = () => [...document.querySelectorAll(".lc-reveal")].some(el => !revealsBefore.has(el) && el.querySelector(".lc-card--landed"));
        const leakAt = [];
        const frame = () => {
          if (done || landedNow()) { done = true; return; }
          frames++;
          if (visible()) { leakFrames++; if (leakAt.length < 5) leakAt.push(Math.round(performance.now() - t0)); }
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
        const before = { pity: pity(), odds: odds() };
        const snaps = {};
        const waits = [];
        // The crate's Buy: off while its spin plays here ("Still spinning"),
        // since the held card's odds aren't what a second pull would roll.
        const buyOff = () => shopCard()?.querySelector(".lc-box__buy")?.getAttribute("aria-disabled") === "true";
        const why = () => shopCard()?.querySelector(".lc-box__why")?.textContent.trim() ?? "";
        const snap = () => ({ rows: rows().length, rowVisible: visible(), pity: pity(), odds: odds(), expectedPity: expectedPity(), buyOff: buyOff(), why: why() });
        return {
          at(name, ms) { waits.push(new Promise(r => setTimeout(() => { snaps[name] = snap(); r(); }, ms))); },
          landed() { done = true; },
          async report() {
            await Promise.all(waits);
            Hooks.off("createItem", hook);
            Hooks.off("renderActorSheetV2", renderHook);
            observer.disconnect();
            const sheetOpen = [...foundry.applications.instances.values()].some(a => a.document === actor && a.rendered);
            const { mid, after } = snaps;
            const ok = !!itemId && sheetOpen && leakFrames === 0 && frames > 0
              && mid && !mid.rowVisible && mid.pity === before.pity && mid.odds === before.odds && mid.buyOff && mid.why === "Still spinning"
              && after && after.rows > 0 && after.rowVisible && after.pity === after.expectedPity && after.why !== "Still spinning";
            // A fact, not a pass condition: whether the card's pity line or
            // odds differ after the pull depends on what the character
            // already owns (owning every Rare leaves both as they were).
            const changedAfterPull = !!after && (after.pity !== before.pity || after.odds !== before.odds);
            return { ok, changedAfterPull, itemId, sheetOpen, frames, leakFrames, leakAt, before, mid, after, createdMs: createdAt && Math.round(createdAt - t0), sheetRenders, longTasks };
          },
        };
      }
      // When the table's client sees each Loot Crates chat card.
      const cards = [];
      Hooks.on("createChatMessage", m => { if (m.flags?.["loot-crates"] && !m.flags["loot-crates"].refunded) cards.push(performance.now()); });
      // Whether each rendering of a card showed its item (it should not
      // while this client's spin plays).
      const renders = [];
      Hooks.on("renderChatMessageHTML", (m, html) => {
        if (!m.flags?.["loot-crates"]?.logId) return;
        const card = html.querySelector(".lc-chat");
        renders.push({ ms: performance.now(), sealed: !!card?.classList.contains("lc-chat--sealed") });
      });
      for (let n = 0; n < count; n++) {
        const card = [...app.element.querySelectorAll(".lc-box")].find(c => c.querySelector(".lc-box__name")?.textContent.trim() === box);
        if (!card) throw new Error(`no crate named ${box}`);
        const buy = card.querySelector(".lc-box__buy");
        if (buy.getAttribute("aria-disabled") === "true") throw new Error(`${box} can't be bought: ${card.querySelector(".lc-box__why")?.textContent}`);
        const seen = new Set([...document.querySelectorAll(".lc-reveal")]);
        const labels = [];
        const where = () => {
          const el = document.activeElement;
          if (el === buy) return "Buy";
          if (el?.matches?.(".lc-reveal__close")) return "reveal Close";
          return el ? `${el.tagName}${el.className ? "." + String(el.className).split(" ")[0] : ""}` : "none";
        };
        let charged = null;
        const onCharge = Hooks.on("updateActor", (a, change) => {
          if (a === actor && change.system?.currency) setTimeout(() => { charged ??= where(); }, 100);
        });
        // SEAL: the granted item's rows, frame by frame, and the card's pity
        // text and odds at reveal +1 s and landed +0.5 s.
        const sl = seal ? await sealWatch(base, actor, card) : null;
        buy.focus();
        const t0 = performance.now();
        const clickedAt = Date.now();
        buy.click();
        let revealAt = null, landedAt = null, rv = null;
        const stillBuy = () => app.element.querySelector(`.lc-box__buy[data-box="${buy.dataset.box}"]`) === buy;
        for (let i = 0; i < 400 && landedAt == null; i++) {
          await new Promise(r => setTimeout(r, 50));
          const label = app.element.querySelector(`.lc-box__buy[data-box="${card.querySelector(".lc-box__buy").dataset.box}"]`)?.textContent.trim();
          if (label && labels.at(-1)?.text !== label) labels.push({ text: label, ms: Math.round(performance.now() - t0) });
          rv ??= [...document.querySelectorAll(".lc-reveal")].find(el => !seen.has(el)) ?? null;
          if (rv && revealAt == null) { revealAt = performance.now() - t0; sl?.at("mid", 1000); }
          if (rv?.querySelector(".lc-card--landed")) { landedAt = performance.now() - t0; sl?.landed(); sl?.at("after", 500); }
        }
        await new Promise(r => setTimeout(r, 1200));
        Hooks.off("updateActor", onCharge);
        const focusAtLanding = where();
        const sameBuyNode = stillBuy();
        // The branch's words, landed: the shop, the reveal and the pull's
        // chat card read in English, never a key (i18n.js reads every
        // sentence by key; the installed release has no lang file, so this
        // is the branch's own lang/en.json).
        const textOf = sel => [...document.querySelectorAll(sel)].map(el => el.innerText).join("\n");
        const shopText = textOf(".application.lc-shop"), revealText = rv?.innerText ?? "", chatText = textOf(".chat-log .loot-crates.lc-chat, #chat .loot-crates.lc-chat");
        const keysShown = [shopText, revealText, chatText].join("\n").match(/LOOTCRATES\.[\w.]+/g) ?? [];
        const words = { keysShown, ok: !keysShown.length && !!shopText && !!revealText && !!chatText, shop: shopText.slice(0, 80), reveal: revealText.replace(/\s+/g, " ").slice(0, 120), chat: chatText.replace(/\s+/g, " ").slice(-120) };
        // Close the reveal as the buyer would, and see where focus goes.
        const revealApp = [...foundry.applications.instances.values()].find(a => a.element === rv);
        if (revealApp) { await revealApp.close(); await new Promise(r => setTimeout(r, 400)); }
        const focusAfterClose = where();
        const chatAt = cards.find(t => t >= t0);
        const shown = renders.filter(r => r.ms >= t0).map(r => ({ ms: Math.round(r.ms - t0), sealed: r.sealed }));
        purchases.push({
          clickedAt,
          ms: { revealReceived: revealAt && Math.round(revealAt), landed: landedAt && Math.round(landedAt), chat: chatAt != null ? Math.round(chatAt - t0) : null },
          chatRenders: shown,
          chatSealedAfterLanding: document.querySelectorAll(".lc-chat--sealed").length,
          buyLabels: labels,
          focus: { afterCharge: charged, atLanding: focusAtLanding, afterClose: focusAfterClose, sameBuyNode, ok: ["Buy", "reveal Close"].includes(charged) && focusAtLanding === "reveal Close" && focusAfterClose === "Buy" && sameBuyNode },
          result: rv?.querySelector(".lc-reveal__result")?.innerText,
          words,
          ...(sl ? { seal: await sl.report() } : {}),
        });
      }
      const granted = actor.items.filter(i => (i.flags?.["loot-crates"]?.at ?? 0) > Date.now() - 120000).map(i => i.name);
      return { actor: actor.name, before, after: actor.system.currency, granted, purchases };
    }, { base: MODULE_BASE, box: BOX, count: COUNT, seal: SEAL });
    Object.assign(out, result);
    if (REPLAY) out.replay = await replayCheck(pl.page);
    if (GM_LOG) {
      const seen = await gm.page.evaluate(() => globalThis.__lcLog);
      const rowMs = seen.at != null ? seen.at - out.purchases[0].clickedAt : null;
      out.gmLog = { ...seen, rowMs, ok: rowMs != null && rowMs <= 2000 };
    }
    if (shot) await pl.page.screenshot({ path: shot });
    if (HIDE_GM) {
      out.gmSide = await gm.page.evaluate(() => {
        const rv = [...document.querySelectorAll(".lc-reveal")].at(-1);
        return {
          visibilityState: document.visibilityState,
          revealLanded: !!rv?.querySelector(".lc-card--landed"),
          revealButton: rv?.querySelector(".lc-reveal__close")?.textContent.trim() ?? null,
          toasts: globalThis.__lcToasts,
        };
      });
    }
    if (HIDE_GM) out.gmWatch = await gmWatchCheck(gm.page);
    out.gmTimings = (gm?.logs ?? []).filter(l => l.includes("timings"));
    out.gmConsole = (gm?.logs ?? []).filter(l => !l.includes("timings"));
    out.playerLog = pl.logs;
  } catch (err) {
    out.error = String(err?.stack || err);
    process.exitCode = 1;
  } finally {
    try { out.closeFinished = await linger.restore(); } catch (err) { out.closeFinished = { error: String(err) }; process.exitCode = 1; }
    console.log(JSON.stringify(out, null, 1));
    await browser.close();
  }
})();
