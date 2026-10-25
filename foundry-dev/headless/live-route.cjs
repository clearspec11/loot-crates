// Live check: the one-click ways between the Items sidebar, the shop and
// the manager (route.js, VIB-201), with the branch's code on both ends.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/headless/live-route.cjs [--shot out.png]
//
// Env: PLAYER (default Player2).
//
// Two headless clients, the Gamemaster and the player, each running the
// branch's sidebar buttons, socket and redraw code in place of the
// installed module's (as live-shelf.cjs does). Then, as people do, with
// real clicks:
//
//   1. The GM opens the Items sidebar and clicks "Manage crates": the
//      manager opens. A second click brings the same window forward: still
//      exactly one manager.
//   2. The GM clicks the manager's "View shop": the shop opens.
//   3. The GM opens the shop's header controls (the ellipsis) and clicks
//      "Manage crates": the manager comes to the front, still one of it.
//   4. The player opens the Items sidebar: "Crates" alone, no "Manage
//      crates". Clicking it opens the shop: its header controls (Foundry
//      v14 gives every window "Detach Window") hold no "Manage crates", and
//      the window has none anywhere.
//   5. The GM takes every game the world holds off the shelf with its
//      Boxes row's "On the shelf" toggle, one click each: the player's open
//      shop says the shelf is empty without any talk of Game Settings, and
//      has no button.
//
// Every window here is the branch's: the installed module's sidebar hook is
// taken out first, or its buttons would open the installed shop, which the
// branch's redraw never reaches (an open shop that never empties).
//
// Restored in a finally: each game's shelf flag as it was (written back
// through the store), every window this run opened closed. No purchase;
// nothing is created or deleted.
/* global game, foundry */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
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
    // The branch's sidebar buttons (route.js) in place of the installed
    // module's, as main.js wires them, drawn again on the open directory.
    const route = await import(base + "scripts/route.js");
    const { openShop } = await import(base + "scripts/shop.js");
    const { openManager } = await import(base + "scripts/manager.js");
    // The installed module's hook calls addDirectoryButtons (route.js); left
    // in, its buttons are drawn first and open the installed shop and
    // manager, which this page's redraw no longer reaches.
    for (const h of [...(globalThis.Hooks.events?.renderItemDirectory ?? [])]) if (/Crates|addDirectoryButtons/.test(String(h.fn))) globalThis.Hooks.off("renderItemDirectory", h.fn);
    globalThis.Hooks.on("renderItemDirectory", (_app, html) => {
      const root = html instanceof HTMLElement ? html : html?.[0];
      if (root) route.addDirectoryButtons(root, { isGM: !!game.user.isGM, open: { shop: () => openShop(), manager: () => openManager() } });
    });
    document.querySelectorAll(".loot-crates-open, .loot-crates-manage").forEach(b => b.remove());
    await globalThis.ui.items?.render({ force: true });
  }, MODULE_BASE);
  return { page, logs };
}

// The Items tab of the sidebar, clicked open.
async function itemsTab(page) {
  const tab = page.locator('#sidebar [data-tab="items"]').first();
  await tab.click();
  await page.locator("#items .directory-header").first().waitFor({ timeout: 10000 });
  return page.locator("#items");
}

// The windows open on a page: how many managers and shops, and which is in front.
const windows = page => page.evaluate(() => {
  const all = [...foundry.applications.instances.values()];
  const z = id => Number(getComputedStyle(document.getElementById(id) ?? document.body).zIndex) || 0;
  return {
    managers: document.querySelectorAll("#loot-crates-manager").length, managerApps: all.filter(a => a.id === "loot-crates-manager" && a.rendered).length,
    shops: document.querySelectorAll("#loot-crates-shop").length,
    managerZ: z("loot-crates-manager"), shopZ: z("loot-crates-shop"),
    managerFront: document.getElementById("loot-crates-manager") ? z("loot-crates-manager") > z("loot-crates-shop") : false,
  };
});

const closeOurs = page => page?.evaluate(() => { for (const a of [...foundry.applications.instances.values()]) if (/^loot-crates/.test(a.id) && a.rendered) a.close(); }).catch(() => {});

(async () => {
  const browser = await chromium.launch();
  const out = { player: PLAYER };
  let gm = null, pl = null, shelf = null;
  try {
    pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");
    await closeOurs(gm.page);
    await closeOurs(pl.page);

    // 1. The sidebar's Manage crates, twice.
    const gmItems = await itemsTab(gm.page);
    out.gmSidebar = await gmItems.locator(".directory-header").first().evaluate(h => ({
      shop: [...h.querySelectorAll(".loot-crates-open")].map(b => b.textContent.trim()), manage: [...h.querySelectorAll(".loot-crates-manage")].map(b => b.textContent.trim()),
    }));
    await gmItems.locator(".loot-crates-manage").click();
    await gm.page.locator("#loot-crates-manager .lc-tabs").waitFor({ timeout: 10000 });
    out.afterFirst = await windows(gm.page);
    await gmItems.locator(".loot-crates-manage").click();
    await gm.page.waitForTimeout(800);
    out.afterSecond = await windows(gm.page);

    // 2. The manager's View shop.
    await gm.page.locator('#loot-crates-manager [data-action="openShop"]').click();
    await gm.page.locator("#loot-crates-shop .lc-shop__body").waitFor({ timeout: 10000 });
    await gm.page.waitForTimeout(500);
    out.viewShop = await windows(gm.page);

    // 3. The shop's header controls, then Manage crates.
    await gm.page.locator('#loot-crates-shop .window-header [data-action="toggleControls"]').click();
    const item = gm.page.locator("#context-menu .context-item", { hasText: "Manage crates" });
    await item.waitFor({ timeout: 5000 });
    out.menu = await gm.page.locator("#context-menu .context-item").allTextContents();
    await item.click();
    await gm.page.waitForTimeout(800);
    out.backToManager = await windows(gm.page);
    if (shot) await gm.page.screenshot({ path: shot });

    // 4. The player's sidebar and shop.
    const plItems = await itemsTab(pl.page);
    out.playerSidebar = await plItems.locator(".directory-header").first().evaluate(h => ({
      shop: [...h.querySelectorAll(".loot-crates-open")].map(b => b.textContent.trim()), manage: h.querySelectorAll(".loot-crates-manage").length,
    }));
    await plItems.locator(".loot-crates-open").click();
    await pl.page.locator("#loot-crates-shop .lc-shop__body").waitFor({ timeout: 10000 });
    out.playerShop = await pl.page.evaluate(() => {
      const shop = document.getElementById("loot-crates-shop");
      const toggle = shop.querySelector('.window-header [data-action="toggleControls"]');
      return { controlsHidden: !toggle || toggle.classList.contains("hidden") || toggle.getBoundingClientRect().width === 0, manageAnywhere: /Manage crates/.test(shop.textContent), managers: document.querySelectorAll("#loot-crates-manager").length };
    });
    // Opened as a person would, to read what the menu offers this player.
    if (!out.playerShop.controlsHidden) {
      await pl.page.locator('#loot-crates-shop .window-header [data-action="toggleControls"]').click().catch(() => {});
      await pl.page.waitForTimeout(400);
      out.playerShop.menu = await pl.page.locator("#context-menu .context-item").allTextContents().catch(() => []);
      await pl.page.keyboard.press("Escape").catch(() => {});
    }

    // 5. Every game off the shelf, by the GM's toggles: the player's empty shelf.
    shelf = await gm.page.evaluate(async base => {
      const store = await import(base + "scripts/store.js");
      return Object.fromEntries(Object.values(store.getBoxes()).map(b => [b.id, b.rules?.shelved]));
    }, MODULE_BASE);
    await gm.page.locator('#loot-crates-manager .lc-tabs [data-tab="boxes"]').click();
    const onToggle = gm.page.locator('#loot-crates-manager button[data-action="toggleShelf"][aria-pressed="true"]');
    await gm.page.locator('#loot-crates-manager button[data-action="toggleShelf"]').first().waitFor({ timeout: 10000 });
    out.toggled = 0;
    for (let left = await onToggle.count(); left > 0 && out.toggled < 200; left = await onToggle.count()) {
      const id = await onToggle.first().getAttribute("data-box");
      await onToggle.first().click();
      await gm.page.locator(`#loot-crates-manager button[data-action="toggleShelf"][data-box="${id}"][aria-pressed="false"]`).waitFor({ timeout: 8000 });
      out.toggled++;
    }
    out.gmCount = (await gm.page.locator("#loot-crates-manager .lc-shelf-count").textContent().catch(() => ""))?.trim();
    await pl.page.waitForFunction(() => document.querySelector("#loot-crates-shop .lc-shop__empty"), null, { timeout: 8000 }).catch(() => {});
    out.playerEmpty = await pl.page.evaluate(() => {
      const empty = document.querySelector("#loot-crates-shop .lc-shop__empty");
      return { text: empty?.textContent.replace(/\s+/g, " ").trim() ?? null, buttons: empty?.querySelectorAll("button").length ?? null, cards: document.querySelectorAll("#loot-crates-shop .lc-box").length };
    });

    const s = out.gmSidebar, f = out.afterFirst, t = out.afterSecond, v = out.viewShop, b = out.backToManager, ps = out.playerSidebar, p = out.playerShop, e = out.playerEmpty;
    out.checks = {
      gmSidebar: s.shop.join() === "Crates" && s.manage.join() === "Manage crates",
      managerOpens: f.managers === 1 && f.managerApps === 1,
      secondClickOneManager: t.managers === 1 && t.managerApps === 1,
      viewShopOpens: v.shops === 1 && v.managers === 1,
      headerManage: out.menu.map(x => x.trim()).includes("Manage crates") && b.managers === 1 && b.managerApps === 1 && b.shops === 1 && b.managerFront,
      playerSidebar: ps.shop.join() === "Crates" && ps.manage === 0,
      playerShopNoControl: !p.manageAnywhere && p.managers === 0 && !(p.menu ?? []).some(x => /Manage/.test(x)),
      allToggledOff: out.toggled === Object.values(shelf).filter(v => v !== false).length,
      playerEmpty: e.cards === 0 && e.text === "No crates on the shelf yet. The GM hasn't put any out." && e.buttons === 0 && !/Game Settings/.test(e.text ?? ""),
    };
    out.ok = Object.values(out.checks).every(Boolean);
    out.gmConsole = gm.logs.filter(l => !l.includes("timings"));
    out.playerLog = pl.logs;
  } catch (err) {
    out.error = String(err?.stack || err);
    out.ok = false;
  } finally {
    if (gm && shelf) {
      try {
        out.restored = await gm.page.evaluate(async ({ base, was }) => {
          const store = await import(base + "scripts/store.js");
          for (const [id, flag] of Object.entries(was)) {
            await store.updateBox(id, f => {
              const rules = { ...(f.rules ?? {}) };
              if (flag === undefined) delete rules.shelved; else rules.shelved = flag;
              return { ...f, rules };
            });
          }
          const now = Object.fromEntries(Object.values(store.getBoxes()).map(b => [b.id, b.rules?.shelved]));
          return { asBefore: Object.keys(was).every(id => now[id] === was[id]), games: Object.keys(was).length };
        }, { base: MODULE_BASE, was: shelf });
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
