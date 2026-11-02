// Live check: Foundry v14's Detach header control (ApplicationV2
// #canDetach) is not offered on the game windows that read the main page
// (reveal.js, shop.js, tablewindow.js _canDetach), and is offered on a
// window that doesn't opt out (the manager), so the check knows the control
// is there to find on this build. With the branch's code on the headless
// Gamemaster:
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/checks/live-detach.cjs [--shot out.png]
//
// As a GM does: open the manager and the shop, and a pull's replay from a
// chat card that carries one (reveal.js showReplay, what the card's Watch
// again calls). On each window, look at its header: if it shows the
// controls button (the vertical ellipsis), click it and read the menu.
//   manager   the menu has Detach
//   shop      no Detach (the menu has Manage crates)
//   reveal    no Detach: no controls button at all, or a menu without it
// Reads only; writes nothing. Needs a chat card with a replay (any crate
// pull, e.g. player-pull.cjs) and the Gamemaster seat free.
/* global game */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const shot = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : null;

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && m.text().includes("loot-crates")) errors.push(m.text()); });
  const out = { base: MODULE_BASE };
  try {
    await page.goto(FOUNDRY + "/join", { waitUntil: "networkidle" });
    const free = await page.$eval("select[name=userId]", s => [...s.options].some(o => o.textContent.trim() === "Gamemaster" && !o.disabled));
    if (!free) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");
    await page.selectOption("select[name=userId]", { label: "Gamemaster" });
    await page.click("button[name=join], button[type=submit]");
    await page.waitForURL(/\/game/, { timeout: 30000 });
    await page.waitForFunction(() => window.game?.ready, null, { timeout: 120000 });
    await page.evaluate(async base => (await import(base + "scripts/core/i18n.js")).loadStrings(), MODULE_BASE);
    out.foundry = await page.evaluate(() => game.version);
    out.dnd5e = await page.evaluate(() => game.system.version);

    // The branch's windows, opened as the GM opens them.
    out.opened = await page.evaluate(async base => {
      globalThis.canvas?.app?.ticker?.stop();
      if (!document.querySelector("link[data-lc-branch]")) {
        const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: base + "styles/module.css" });
        link.dataset.lcBranch = "1";
        document.head.append(link);
        await new Promise(r => { link.onload = r; link.onerror = r; });
      }
      const store = await import(base + "scripts/foundry/store.js");
      try { store.registerSettings(); } catch { /* the installed module registered them */ }
      const { openManager } = await import(base + "scripts/foundry/manager.js");
      const { openShop } = await import(base + "scripts/foundry/shop.js");
      const { showReplay } = await import(base + "scripts/foundry/reveal.js");
      globalThis.__lcDetach = {};
      const manager = openManager();
      for (let t = 0; t < 100 && !manager.element?.querySelector(".lc-tabs [data-tab]"); t++) await new Promise(r => setTimeout(r, 50));
      const shop = openShop();
      await shop.render({ force: true });
      const message = [...game.messages].reverse().find(m => m.flags?.["loot-crates"]?.replay && !m.flags["loot-crates"].replay.kind);
      const reveal = message ? await showReplay(message.flags["loot-crates"].replay, message.id) : null;
      Object.assign(globalThis.__lcDetach, { manager, shop, reveal });
      return { manager: manager.id, shop: shop.id, reveal: reveal?.id ?? null, message: message?.id ?? null };
    }, MODULE_BASE);
    if (!out.opened.reveal) throw new Error("no chat card with a crate replay to open: run player-pull.cjs first");
    await page.waitForTimeout(600);

    // A window's header as a person reads it: the controls button, and the
    // menu it opens when clicked.
    const read = async name => {
      const id = out.opened[name];
      const win = page.locator(`#${id}`);
      const toggle = win.locator('.window-header [data-action="toggleControls"]');
      const r = { canDetach: await page.evaluate(n => globalThis.__lcDetach[n]._canDetach?.() ?? null, name) };
      r.controlsButton = (await toggle.count()) > 0 && await toggle.isVisible();
      r.menu = [];
      if (r.controlsButton) {
        await page.evaluate(n => globalThis.__lcDetach[n].bringToFront?.(), name);
        await toggle.click();
        await page.waitForSelector("#context-menu .context-item", { timeout: 3000 }).catch(() => {});
        r.menu = await page.$$eval("#context-menu .context-item", items => items.map(i => i.textContent.trim()));
        await page.keyboard.press("Escape");
        await page.mouse.click(5, 5);
        await page.waitForTimeout(200);
      }
      r.detach = r.menu.some(t => /detach/i.test(t));
      return r;
    };
    out.manager = await read("manager");
    out.shop = await read("shop");
    out.reveal = await read("reveal");
    if (shot) await page.screenshot({ path: shot });
    out.ok = out.manager.detach && !out.shop.detach && !out.reveal.detach
      && out.shop.canDetach === false && out.reveal.canDetach === false && errors.length === 0;
  } catch (e) {
    out.ok = false;
    out.error = String(e?.stack || e);
  } finally {
    out.errors = errors;
    await page.evaluate(() => { for (const app of Object.values(globalThis.__lcDetach ?? {})) app?.close?.(); }).catch(() => {});
    await browser.close();
  }
  console.log(JSON.stringify(out, null, 1));
  process.exit(out.ok ? 0 : 1);
})();
