// Live check: the GM's welcome (welcome.js, welcomewindow.js), with the
// branch's code on both ends.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/headless/live-welcome.cjs [--shot out.png]
//
// Env: PLAYER (default Player2).
//
// Two headless clients, the Gamemaster and the player, each with the
// branch's welcome registered (its world setting and the Game Settings
// menu) in place of the installed module's, which has none. Each load runs
// what main.js runs at ready, welcomeAtLoad(), since the branch's code
// arrives after Foundry's own ready. Then, as people do:
//
//   1. The welcome's flag cleared, the GM loads: the welcome opens, named
//      by its heading, focus on its primary button. Escape (the real key)
//      closes it, and the flag says this version was seen. The GM reloads
//      the page: nothing opens.
//   2. Cleared again and loaded: the GM clicks the real "Open the manager":
//      the welcome closes and the manager opens.
//   3. Cleared again and loaded: the GM clicks "Don't show again", then
//      reloads the page: nothing opens.
//   4. Game Settings, Configure Settings, Loot Crates, "Show the welcome"
//      (real clicks): the welcome opens though it was turned off.
//   5. An update (the flag says an older version was seen): when the
//      installed version has lines in the branch's changelog.js, "What's
//      new in X" opens with them, focus on Close, and the real Close marks
//      it seen; a reload shows nothing. When it has none, nothing opens and
//      the flag moves up to this version.
//   6. The player, with the flag cleared, loads: nothing opens, and the
//      player's Game Settings has no Show the welcome.
//
// Restored in a finally: the flag as it was (the default if the world had
// none), every window this run opened closed. No purchase; nothing is
// created or deleted.
/* global game, foundry */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const shot = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : null;

// The branch's stylesheet and welcome on a loaded page; then main.js's
// ready step. Returns whether a window opened.
async function load(page) {
  await page.waitForFunction(() => window.game?.ready, null, { timeout: 120000 });
  // What main.js does first: the branch's words, from its own lang/en.json
  // (the installed release may have no language file, or older words).
  await page.evaluate(async base => (await import(base + "scripts/i18n.js")).loadStrings(), MODULE_BASE);
  return page.evaluate(async base => {
    globalThis.canvas?.app?.ticker?.stop();
    if (!document.querySelector("link[data-lc-branch]")) {
      const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: base + "styles/module.css" });
      link.dataset.lcBranch = "1";
      document.head.append(link);
      await new Promise(r => { link.onload = r; link.onerror = r; });
    }
    const store = await import(base + "scripts/store.js");
    try { store.registerSettings(); } catch { /* the installed module registered them */ }
    const w = await import(base + "scripts/welcomewindow.js");
    if (!game.settings.settings.has("loot-crates.welcome")) w.registerWelcome();
    globalThis.__lcWelcome = w;
    return !!w.welcomeAtLoad();
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
  return { page, logs };
}

async function reload(page) {
  await page.reload({ waitUntil: "load" });
  return load(page);
}

// The flag, written by the GM as the setup (not the thing checked).
const setFlag = (page, value) => page.evaluate(v => game.settings.set("loot-crates", "welcome", v), value);
const getFlag = page => page.evaluate(() => game.settings.get("loot-crates", "welcome"));
const CLEAR = { seen: null, off: false };

// What the welcome window shows, if it is open.
const welcome = page => page.evaluate(() => {
  const el = document.getElementById("loot-crates-welcome");
  if (!el) return { open: false };
  const section = el.querySelector(".lc-welcome");
  const head = section && document.getElementById(section.getAttribute("aria-labelledby"));
  const primary = el.querySelector("[data-primary]");
  return {
    open: true, heading: head?.tagName === "H2" ? head.textContent.trim() : null,
    primary: primary?.textContent.trim() ?? null, focusOnPrimary: !!primary && document.activeElement === primary,
    buttons: [...el.querySelectorAll(".lc-welcome button, .lc-welcome a")].map(b => b.textContent.trim()),
  };
});
const waitOpen = page => page.waitForSelector("#loot-crates-welcome .lc-welcome", { timeout: 10000 }).then(() => page.waitForTimeout(400));
const waitGone = page => page.waitForFunction(() => !document.getElementById("loot-crates-welcome"), null, { timeout: 10000 }).then(() => true).catch(() => false);
const closeOurs = page => page?.evaluate(() => { for (const a of [...foundry.applications.instances.values()]) if (/^loot-crates/.test(a.id) && a.rendered) a.close(); }).catch(() => {});

(async () => {
  const browser = await chromium.launch();
  const out = { player: PLAYER };
  let gm = null, pl = null, was;
  try {
    pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");
    await load(gm.page);
    await closeOurs(gm.page);
    was = await gm.page.evaluate(() => game.settings.storage.get("world").getSetting("loot-crates.welcome")?.toObject?.() ?? null);
    out.flagWas = was?.value ?? null;
    out.version = await gm.page.evaluate(() => game.modules.get("loot-crates")?.version);

    // 1. Cleared: the welcome opens on load; Escape closes it; a reload shows nothing.
    await setFlag(gm.page, CLEAR);
    out.load1 = await reload(gm.page);
    await waitOpen(gm.page);
    out.welcome = await welcome(gm.page);
    if (shot) await gm.page.screenshot({ path: shot });
    await gm.page.keyboard.press("Escape");
    out.escapeCloses = await waitGone(gm.page);
    await gm.page.waitForTimeout(600);
    out.flagAfterEscape = await getFlag(gm.page);
    out.reloadAfterClose = await reload(gm.page);
    await gm.page.waitForTimeout(800);
    out.openAfterClose = (await welcome(gm.page)).open;

    // 2. Cleared: Open the manager.
    await setFlag(gm.page, CLEAR);
    await reload(gm.page);
    await waitOpen(gm.page);
    await gm.page.locator('#loot-crates-welcome [data-action="welcomeManager"]').click();
    out.managerCloses = await waitGone(gm.page);
    out.managerOpens = await gm.page.locator("#loot-crates-manager .lc-tabs").waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
    await closeOurs(gm.page);

    // 3. Cleared: Don't show again, then a reload.
    await setFlag(gm.page, CLEAR);
    await reload(gm.page);
    await waitOpen(gm.page);
    await gm.page.locator('#loot-crates-welcome [data-action="welcomeQuiet"]').click();
    out.quietCloses = await waitGone(gm.page);
    await gm.page.waitForTimeout(600);
    out.flagAfterQuiet = await getFlag(gm.page);
    out.reloadAfterQuiet = await reload(gm.page);
    await gm.page.waitForTimeout(800);
    out.openAfterQuiet = (await welcome(gm.page)).open;

    // 4. Game Settings, Configure Settings, Loot Crates, Show the welcome.
    await gm.page.locator('#sidebar [data-tab="settings"]').first().click();
    await gm.page.locator('#settings [data-app="configure"], #settings button:has-text("Configure Settings")').first().click();
    const config = gm.page.locator("#settings-config");
    await config.waitFor({ timeout: 10000 });
    await config.locator('[data-tab="loot-crates"]').first().click().catch(() => {});
    const menuButton = config.locator('[data-key="loot-crates.welcomeMenu"]').first();
    out.menuLabel = (await menuButton.textContent().catch(() => ""))?.trim();
    await menuButton.click();
    await waitOpen(gm.page);
    out.fromMenu = await welcome(gm.page);
    await gm.page.locator('#loot-crates-welcome [data-action="welcomeManager"]').click();
    await waitGone(gm.page);
    await gm.page.waitForTimeout(600);
    out.flagAfterMenu = await getFlag(gm.page);
    await closeOurs(gm.page);
    await gm.page.evaluate(() => Object.values(globalThis.ui.windows ?? {}).forEach(a => a.close?.())).catch(() => {});
    await gm.page.evaluate(() => { for (const a of foundry.applications.instances.values()) if (a.id === "settings-config") a.close(); }).catch(() => {});

    // 5. An update: What's new once when this version has lines, else nothing.
    out.hasLines = await gm.page.evaluate(async ({ base, v }) => !!(await import(base + "scripts/welcome.js")).newsFor(v), { base: MODULE_BASE, v: out.version });
    await setFlag(gm.page, { seen: "0.0.1", off: false });
    out.reloadUpdate = await reload(gm.page);
    if (out.hasLines) {
      await waitOpen(gm.page);
      out.news = await gm.page.evaluate(() => ({ lines: document.querySelectorAll("#loot-crates-welcome .lc-welcome__news li").length }));
      Object.assign(out.news, await welcome(gm.page));
      await gm.page.locator('#loot-crates-welcome [data-action="welcomeDone"]').click();
      out.news.closes = await waitGone(gm.page);
      await gm.page.waitForTimeout(600);
    } else await gm.page.waitForTimeout(800);
    out.flagUpdate = await getFlag(gm.page);
    out.reloadAfterUpdate = await reload(gm.page);
    await gm.page.waitForTimeout(800);
    out.openAfterUpdate = (await welcome(gm.page)).open;

    // 6. The player, with the flag cleared.
    await setFlag(gm.page, CLEAR);
    out.playerLoad = await reload(pl.page);
    await pl.page.waitForTimeout(800);
    out.playerOpen = (await welcome(pl.page)).open;
    out.playerMenu = await pl.page.evaluate(() => {
      const menu = game.settings.menus.get("loot-crates.welcomeMenu");
      return { restricted: menu?.restricted ?? null, openWelcome: globalThis.__lcWelcome.openWelcome("welcome") === null && !document.getElementById("loot-crates-welcome") };
    });
    out.playerFlag = await getFlag(pl.page);

    const v = out.version, w = out.welcome;
    out.checks = {
      opensOnLoad: out.load1 && w.open && w.heading === "Welcome to Loot Crates",
      focusOnPrimary: w.focusOnPrimary && ["Open the manager", "Add starter crates"].includes(w.primary),
      buttons: ["Open the manager", "Add starter crates", "Read the guide", "Don't show again"].every(b => w.buttons.includes(b)),
      escapeCloses: out.escapeCloses && out.flagAfterEscape?.seen === v && out.flagAfterEscape?.off === false,
      closedStaysClosed: !out.reloadAfterClose && !out.openAfterClose,
      openTheManager: out.managerCloses && out.managerOpens,
      dontShowAgain: out.quietCloses && out.flagAfterQuiet?.off === true && !out.reloadAfterQuiet && !out.openAfterQuiet,
      menuBringsItBack: out.menuLabel === "Show the welcome" && out.fromMenu.open && out.flagAfterMenu?.off === false,
      updateNote: (out.hasLines
        ? out.reloadUpdate && out.news.heading === `What's new in ${v}` && out.news.lines >= 3 && out.news.lines <= 5 && out.news.primary === "Close" && out.news.focusOnPrimary && out.news.closes
        : !out.reloadUpdate) && out.flagUpdate?.seen === v && out.flagUpdate?.off === false && !out.reloadAfterUpdate && !out.openAfterUpdate,
      playerSeesNothing: !out.playerLoad && !out.playerOpen && out.playerMenu.restricted === true && out.playerMenu.openWelcome && out.playerFlag?.seen === null,
    };
    out.ok = Object.values(out.checks).every(Boolean);
    out.gmConsole = gm.logs.filter(l => !l.includes("timings"));
    out.playerLog = pl.logs;
  } catch (err) {
    out.error = String(err?.stack || err);
    out.ok = false;
  } finally {
    if (gm) {
      try {
        const back = was?.value != null ? (typeof was.value === "string" ? JSON.parse(was.value) : was.value) : CLEAR;
        await setFlag(gm.page, back);
        out.restored = { flag: await getFlag(gm.page) };
        out.restored.asBefore = JSON.stringify(out.restored.flag) === JSON.stringify(back);
      } catch (err) { out.restored = { error: String(err) }; }
      if (!out.restored?.asBefore) out.ok = false;
    }
    await closeOurs(gm?.page);
    await closeOurs(pl?.page);
    console.log(JSON.stringify(out, null, 1));
    if (!out.ok) process.exitCode = 1;
    await browser.close();
  }
})();
