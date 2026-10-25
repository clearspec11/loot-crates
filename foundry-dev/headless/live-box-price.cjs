// Live check: the price typed into a Boxes row (VIB-201), at a real table
// with the branch's code on both ends.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/headless/live-box-price.cjs [--shot out.png]
//
// Env: PLAYER (default Player2, must own Crate Tester), BOX (default "Live
// UI crate"), PRICE (what is typed, default "7 gp 5 sp").
//
// Two headless clients, the Gamemaster and the player, each running the
// branch's socket, redraw and sidebar code (as live-shelf.cjs does). The
// player opens the shop on Crate Tester and leaves it open. Then, as
// people do:
//
//   1. The GM opens the manager, clicks the Boxes tab, clicks the crate's
//      price field, selects it, types PRICE key by key and presses Tab.
//      The stored price must become 7.5 gp with nothing else on the record
//      changed, the field read "7 gp 5 sp", the status line say it was
//      saved ("Saved: Live UI crate, 7 gp 5 sp.", since round 20), and
//      focus move on (Tab) to the row's next control.
//   2. The player's open shop must read "Open for 7 gp 5 sp" on its Buy.
//   3. The GM types "5 gold" and presses Enter: the field goes back to
//      "7 gp 5 sp", the status line says how to type a price, and nothing
//      is written.
//   4. The player presses Buy (one purchase): charged exactly 750 cp, one
//      item, one log row at 7.5 gp.
//
// Restored in a finally: the old price, typed back into the row the same
// way (written directly only if that fails), and the shop's open state.
// Seeds "Live UI pool" and "Live UI crate" by name (as live-ui.js does) when
// missing; never deletes anything. Needs "Crate Tester" in "Loot Crates Test".
/* global game, foundry */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const BOX = process.env.BOX || "Live UI crate";
const PRICE = process.env.PRICE || "7 gp 5 sp";
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
    registerShopHooks?.(globalThis.Hooks);
    // The branch's sidebar buttons (route.js) in place of the installed
    // module's, as main.js wires them, drawn again on the open directory.
    const route = await import(base + "scripts/views/route.js");
    const { openShop } = await import(base + "scripts/foundry/shop.js");
    const { openManager } = await import(base + "scripts/foundry/manager.js");
    // The installed module's hook calls addDirectoryButtons (route.js); left
    // in, its buttons are drawn first and open the installed shop and
    // manager, which this page's redraw no longer reaches (as live-route).
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

async function prepare(gm) {
  return gm.evaluate(async ({ base, name }) => {
    const store = await import(base + "scripts/foundry/store.js");
    const folder = game.folders.find(f => f.type === "Actor" && f.name === "Loot Crates Test");
    const actor = game.actors.find(a => a.name === "Crate Tester" && a.folder?.id === folder?.id);
    if (!actor) throw new Error("no Crate Tester in Loot Crates Test");
    if ((actor.system.currency.gp ?? 0) < 20) await actor.update({ "system.currency.gp": 1000 });
    const seeded = [];
    let pool = Object.values(store.getPools()).find(p => p.name === "Live UI pool");
    if (!pool) {
      const entries = await store.entriesFromCompendium("dnd5e.items", { types: ["weapon", "equipment"], rarities: ["uncommon", "rare"] });
      pool = await store.createPool({ name: "Live UI pool", entries: entries.slice(0, 40) });
      seeded.push("Live UI pool");
    }
    let box = Object.values(store.getBoxes()).find(b => b.name === name);
    if (!box) {
      box = await store.createBox({ name, price: 75, pools: [{ id: pool.id, share: 1 }], weights: { uncommon: 75, rare: 25 } });
      seeded.push(name);
    }
    const shopOpen = store.isShopOpen();
    if (!shopOpen) await store.setShopOpen(true);
    return { actorId: actor.id, boxId: box.id, record: structuredClone(store.getBoxes()[box.id]), seeded, shopOpen, logIds: store.getLog().map(r => r.id) };
  }, { base: MODULE_BASE, name: BOX });
}

// The player's view of the crate's card, and the purse, items and log.
const facts = (pl, boxId) => pl.evaluate(async ({ base, boxId }) => {
  const { getLog } = await import(base + "scripts/foundry/store.js");
  const { toCopper } = await import(base + "scripts/core/currency.js");
  const actor = game.actors.find(a => a.isOwner && a.type === "character" && a.name === "Crate Tester");
  const buy = document.querySelector(`#loot-crates-shop .lc-box__buy[data-box="${boxId}"]`);
  return {
    label: buy?.textContent.replace(/\s+/g, " ").trim() ?? null, dataPrice: buy?.dataset.price ?? null, off: buy?.getAttribute("aria-disabled") === "true",
    purseCp: toCopper(actor.system.currency), items: actor.items.filter(i => !i.getFlag("dnd5e", "cachedFor")).length, newest: getLog()[0] ?? null,
  };
}, { base: MODULE_BASE, boxId });

// The GM's manager on the Boxes tab, opened and clicked as a person does.
async function boxesTab(gm) {
  await gm.evaluate(async base => { (await import(base + "scripts/foundry/manager.js")).openManager(); }, MODULE_BASE);
  const manager = gm.locator("#loot-crates-manager");
  await manager.waitFor({ timeout: 10000 });
  await manager.locator('.lc-tabs [data-tab="boxes"]').click();
  return manager;
}

// Types into the row's price field key by key, then presses `key`.
async function typePrice(gm, boxId, text, key = "Tab") {
  const manager = await boxesTab(gm);
  const field = manager.locator(`input[data-box-price="${boxId}"]`);
  await field.waitFor({ timeout: 10000 });
  await field.click();
  await gm.keyboard.press("Control+A");
  await field.pressSequentially(text, { delay: 30 });
  await gm.keyboard.press(key);
  return manager;
}

const storedPrice = (gm, boxId) => gm.evaluate(id => game.settings.get("loot-crates", "boxes")[id]?.price, boxId);

(async () => {
  const browser = await chromium.launch();
  const out = { player: PLAYER, box: BOX, typed: PRICE };
  let gm = null, pl = null, before = null;
  try {
    pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");
    before = await prepare(gm.page);
    out.before = { price: before.record.price, seeded: before.seeded };

    await pl.page.evaluate(async base => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const { openShop } = await import(base + "scripts/foundry/shop.js");
      const actor = game.actors.find(a => a.isOwner && a.type === "character" && a.name === "Crate Tester");
      const app = openShop();
      for (let t = 0; t < 8000 && !app.element?.querySelector(".lc-shop__body"); t += 50) await wait(50);
      const pick = app.element.querySelector(".lc-shop__actor");
      if (pick && pick.value !== actor.id) { pick.value = actor.id; pick.dispatchEvent(new Event("change")); await wait(800); }
    }, MODULE_BASE);
    await pl.page.waitForTimeout(1200);
    const start = await facts(pl.page, before.boxId);
    if (!start.label) throw new Error(`no ${BOX} in ${PLAYER}'s shop`);

    // 1. Typed into the row, then Tab.
    await typePrice(gm.page, before.boxId, PRICE, "Tab");
    await gm.page.waitForFunction(id => game.settings.get("loot-crates", "boxes")[id]?.price === 7.5, before.boxId, { timeout: 10000 }).catch(() => {});
    await gm.page.waitForTimeout(600);
    out.typed = await gm.page.evaluate(({ boxId, was }) => {
      const app = document.querySelector("#loot-crates-manager");
      const field = app.querySelector(`input[data-box-price="${boxId}"]`);
      const now = game.settings.get("loot-crates", "boxes")[boxId];
      const changed = Object.keys({ ...now, ...was }).filter(k => k !== "price" && JSON.stringify(now[k]) !== JSON.stringify(was[k]));
      const active = document.activeElement;
      return {
        price: now.price, changed, field: field?.value, label: field?.getAttribute("aria-label"),
        status: app.querySelector(".lc-manager__status")?.textContent.trim() ?? null,
        focus: active === field ? "the price field" : active?.closest?.("tr") === field?.closest("tr") ? `${active.dataset.action ?? active.tagName} in the same row` : (active?.dataset?.action ?? active?.tagName ?? null),
      };
    }, { boxId: before.boxId, was: before.record });

    // 2. The player's open shop.
    await pl.page.waitForFunction(id => /Open for 7 gp 5 sp$/.test(document.querySelector(`#loot-crates-shop .lc-box__buy[data-box="${id}"]`)?.textContent.replace(/\s+/g, " ").trim() ?? ""), before.boxId, { timeout: 5000 }).catch(() => {});
    out.shop = await facts(pl.page, before.boxId);

    // 3. A price it can't read, then Enter.
    await typePrice(gm.page, before.boxId, "5 gold", "Enter");
    await gm.page.waitForTimeout(800);
    out.bad = await gm.page.evaluate(boxId => {
      const app = document.querySelector("#loot-crates-manager");
      return { price: game.settings.get("loot-crates", "boxes")[boxId].price, field: app.querySelector(`input[data-box-price="${boxId}"]`)?.value, status: app.querySelector(".lc-manager__status")?.textContent.trim() };
    }, before.boxId);

    // 4. One purchase at the new price.
    const pre = await facts(pl.page, before.boxId);
    await pl.page.locator(`#loot-crates-shop .lc-box__buy[data-box="${before.boxId}"]`).click();
    await pl.page.waitForSelector(".application.lc-reveal .lc-card--landed", { timeout: 20000 });
    await pl.page.waitForTimeout(1500);
    const post = await facts(pl.page, before.boxId);
    out.bought = { paidCp: pre.purseCp - post.purseCp, items: post.items - pre.items, rowPrice: post.newest?.id !== pre.newest?.id ? post.newest?.price : null, rowBox: post.newest?.boxName ?? null };
    if (shot) await pl.page.screenshot({ path: shot });

    const t = out.typed, s = out.shop, b = out.bad;
    out.checks = {
      saved: t.price === 7.5 && t.changed.length === 0,
      fieldReads: t.field === "7 gp 5 sp" && t.label === `Price of ${BOX}`,
      saidSaved: t.status === `Saved: ${BOX}, 7 gp 5 sp.`,
      tabMovedOn: t.focus !== "the price field" && t.focus != null,
      shopReads: s.label === `${BOX}: Open for 7 gp 5 sp` && s.dataPrice === "7.5" && !s.off,
      badPutBack: b.price === 7.5 && b.field === "7 gp 5 sp" && b.status === 'Couldn\'t read "5 gold"; try 5 gp or 5 sp.',
      charged750: out.bought.paidCp === 750 && out.bought.items === 1 && out.bought.rowPrice === 7.5,
    };
    out.ok = Object.values(out.checks).every(Boolean);
    out.gmConsole = gm.logs.filter(l => !l.includes("timings"));
    out.playerLog = pl.logs;
  } catch (err) {
    out.error = String(err?.stack || err);
    out.ok = false;
  } finally {
    if (gm && before) {
      try {
        const back = await gm.page.evaluate(async ({ base, p }) => (await import(base + "scripts/core/currency.js")).formatPrice(p), { base: MODULE_BASE, p: before.record.price });
        if (await storedPrice(gm.page, before.boxId) !== before.record.price) {
          await typePrice(gm.page, before.boxId, back, "Tab").catch(() => {});
          await gm.page.waitForFunction(([id, p]) => game.settings.get("loot-crates", "boxes")[id]?.price === p, [before.boxId, before.record.price], { timeout: 8000 }).catch(() => {});
        }
        let how = "typed into the row";
        if (await storedPrice(gm.page, before.boxId) !== before.record.price) {
          how = "written directly";
          await gm.page.evaluate(async ({ base, id, p }) => { const s = await import(base + "scripts/foundry/store.js"); await s.updateBox(id, f => ({ ...f, price: p })); }, { base: MODULE_BASE, id: before.boxId, p: before.record.price });
        }
        if (!before.shopOpen) await gm.page.evaluate(async base => (await import(base + "scripts/foundry/store.js")).setShopOpen(false), MODULE_BASE);
        out.restored = { price: await storedPrice(gm.page, before.boxId), want: before.record.price, how };
        await gm.page.evaluate(() => { for (const a of [...foundry.applications.instances.values()]) if (/loot-crates/.test(a.id) || a.element?.classList.contains("lc-reveal")) a.close(); });
      } catch (err) { out.restored = { error: String(err) }; }
    }
    try { await pl?.page.evaluate(() => { for (const a of [...foundry.applications.instances.values()]) if (/loot-crates/.test(a.id) || a.element?.classList.contains("lc-reveal")) a.close(); }); } catch { /* closing */ }
    if (out.restored?.price !== before?.record?.price) out.ok = false;
    console.log(JSON.stringify(out, null, 1));
    if (!out.ok) process.exitCode = 1;
    await browser.close();
  }
})();
