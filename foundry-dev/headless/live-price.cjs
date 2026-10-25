// Live check: a player is charged only the price on the Buy they pressed.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/headless/live-price.cjs [--shot out.png]
//
// Env: PLAYER (default Player2), BOX (default "Live UI crate"), RAISE (gp
// added to the price, default 5).
//
// Two headless clients with the branch's socket code, as player-pull.cjs
// sets them up; needs the Gamemaster seat free (exits 2 when a person holds
// it). The player opens the shop. The GM raises the box's price in the
// manager as a person does (the Boxes tab, the box's Edit, the price field,
// Save). The world's broadcast of that setting is held back from the
// player's page on its WebSocket, so the shop still shows the old price, as
// it does for a pull already in flight when the GM saves (or a redraw that
// was missed, or a reconnect). The player clicks that stale Buy: the GM must
// refuse it with the warning toast ("... now costs N gp (you pressed M gp).
// Nothing was charged.") and the purse, items and Pull log stay as they were.
// The held broadcast is then let through, the shop redraws to the new price,
// and the player clicks again: charged exactly the new price, with a log row
// at that price. The GM then puts the old price back the same way (always,
// even when the check fails).
//
// One real purchase per run (the second click); never deletes anything.
/* global game, foundry, ui -- used inside page.evaluate, which runs in the Foundry page */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const BOX = process.env.BOX || "Live UI crate";
const RAISE = Number(process.env.RAISE) || 5;
const shot = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : null;

async function join(browser, user, { holdBoxes = null } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // The player's page: while holdBoxes.on, the server's frames naming the
  // boxes setting's document (holdBoxes.id) wait here; everything else (the
  // GM's socket replies, the purse, the log) passes.
  if (holdBoxes) {
    await context.routeWebSocket(/socket\.io/, ws => {
      const server = ws.connectToServer();
      holdBoxes.sockets = (holdBoxes.sockets ?? 0) + 1;
      server.onMessage(m => {
        // A setting's update goes out as its document id and new value.
        if (holdBoxes.on && typeof m === "string" && holdBoxes.id && m.includes(holdBoxes.id)) holdBoxes.frames.push(() => ws.send(m));
        else ws.send(m);
      });
      ws.onMessage(m => server.send(m));
    });
  }
  const page = await context.newPage();
  const logs = [];
  page.on("console", m => { const t = m.text(); if (t.includes("loot-crates")) logs.push(t); });
  page.on("pageerror", e => logs.push("pageerror: " + e.message));
  await page.goto(FOUNDRY + "/join", { waitUntil: "networkidle" });
  const free = await page.$eval("select[name=userId]", (s, u) => [...s.options].some(o => o.textContent.trim() === u && !o.disabled), user);
  if (!free) { await context.close(); return null; }
  await page.selectOption("select[name=userId]", { label: user });
  await page.click("button[name=join], button[type=submit]");
  await page.waitForURL(/\/game/, { timeout: 30000 });
  await page.waitForFunction(() => window.game?.ready, null, { timeout: 120000 });
  // What main.js does first: the branch's words, from its own lang/en.json
  // (the installed release may have no language file, or older words).
  await page.evaluate(async base => (await import(base + "scripts/core/i18n.js")).loadStrings(), MODULE_BASE);
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
    const { refreshShop } = await import(base + "scripts/foundry/shop.js");
    const { refreshManager } = await import(base + "scripts/foundry/manager.js");
    const redraw = storeRedraw({ refreshShop, refreshManager });
    store.setStoreListener(redraw);
    for (const key of store.WORLD_KEYS) {
      const cfg = game.settings.settings.get(`loot-crates.${key}`);
      if (cfg && !String(cfg.onChange ?? "").includes("storeChanged")) cfg.onChange = () => redraw(key);
    }
  }, MODULE_BASE);
  return { page, logs };
}

// The GM edits the box's price in the manager, as a person does.
async function setPrice(gm, boxId, price) {
  await gm.evaluate(async base => {
    const { openManager } = await import(base + "scripts/foundry/manager.js");
    const app = openManager();
    await app.render({ force: true });
  }, MODULE_BASE);
  const manager = gm.locator(".application.lc-manager, #loot-crates-manager").first();
  await manager.waitFor({ timeout: 10000 });
  await manager.locator('.lc-tabs [data-tab="boxes"]').click();
  const edit = manager.locator(`[data-action="editBox"][data-box="${boxId}"]`);
  await edit.waitFor({ timeout: 10000 });
  await edit.click();
  const dialog = gm.locator(".lc-dialog").last();
  const field = dialog.locator('input[name="price"]');
  await field.waitFor({ timeout: 10000 });
  await field.fill(String(price));
  const at = Date.now();
  await dialog.locator('[data-action="ok"]').click();
  await gm.waitForFunction(([id, p]) => game.settings.get("loot-crates", "boxes")[id]?.price === p, [boxId, price], { timeout: 10000 });
  return at;
}

(async () => {
  const browser = await chromium.launch();
  const out = { player: PLAYER, box: BOX };
  const hold = { on: false, frames: [] };
  let gm = null, boxId = null, oldPrice = null;
  try {
    const pl = await join(browser, PLAYER, { holdBoxes: hold });
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    gm = await join(browser, "Gamemaster");
    if (!gm) { out.error = "the Gamemaster seat is taken: unverifiable"; process.exitCode = 2; return; }

    // The player's shop, and what the world says now.
    const facts = () => pl.page.evaluate(async ({ base, box }) => {
      const { getLog } = await import(base + "scripts/foundry/store.js");
      const actor = game.actors.find(a => a.isOwner && a.type === "character");
      const shop = [...foundry.applications.instances.values()].find(a => a.id === "loot-crates-shop");
      const card = shop && [...shop.element.querySelectorAll(".lc-box")].find(c => c.querySelector(".lc-box__name")?.textContent.trim() === box);
      const buy = card?.querySelector(".lc-box__buy");
      const { toCopper } = await import(base + "scripts/core/currency.js");
      return {
        boxId: card?.dataset.box ?? null, label: buy?.textContent.replace(/\s+/g, " ").trim() ?? null, dataPrice: buy?.dataset.price ?? null,
        off: buy?.getAttribute("aria-disabled") === "true",
        purseCp: toCopper(actor.system.currency), purse: JSON.stringify(actor.system.currency),
        // Granted items only: dnd5e adds a spell for an item's cast activity
        // (flags.dnd5e.cachedFor), so a Circlet of Blasting adds two.
        items: actor.items.filter(i => !i.getFlag("dnd5e", "cachedFor")).length,
        newestRow: getLog()[0] ?? null, reveals: document.querySelectorAll(".lc-reveal").length,
      };
    }, { base: MODULE_BASE, box: BOX });
    await pl.page.evaluate(async base => {
      const { openShop } = await import(base + "scripts/foundry/shop.js");
      openShop();
      globalThis.__lcToasts = [];
      for (const kind of ["info", "warn", "error"]) {
        const orig = ui.notifications[kind].bind(ui.notifications);
        ui.notifications[kind] = (msg, opts) => { globalThis.__lcToasts.push({ kind, msg: String(msg) }); return orig(msg, opts); };
      }
    }, MODULE_BASE);
    await pl.page.waitForTimeout(1500);
    const before = await facts();
    if (!before.boxId) throw new Error(`no crate named ${BOX} in ${PLAYER}'s shop`);
    if (before.off) throw new Error(`${BOX} can't be bought before the check`);
    boxId = before.boxId;
    hold.id = await pl.page.evaluate(() => game.settings.storage.get("world").find(s => s.key === "loot-crates.boxes")?.id ?? null);
    if (!hold.id || !hold.sockets) throw new Error(`can't hold the boxes setting back from ${PLAYER} (setting id ${hold.id}, sockets routed ${hold.sockets ?? 0})`);
    oldPrice = await gm.page.evaluate(id => game.settings.get("loot-crates", "boxes")[id].price, boxId);
    const newPrice = oldPrice + RAISE;
    const buy = pl.page.locator(`.lc-shop .lc-box__buy[data-box="${boxId}"]`);

    // 1. The GM raises the price while the broadcast to the player is in flight.
    hold.on = true;
    await setPrice(gm.page, boxId, newPrice);
    for (let i = 0; i < 50 && !hold.frames.length; i++) await pl.page.waitForTimeout(100);
    await pl.page.waitForTimeout(300);
    const stale = await facts();
    out.held = hold.frames.length;
    // Only a stale Buy is worth pressing: anything else would be a second sale.
    if (!out.held || stale.label !== `${BOX}: Open for ${oldPrice} gp`) throw new Error(`the player's shop wasn't stale (held ${out.held}, Buy reads "${stale.label}"); nothing pressed`);
    // 2. The player presses the Buy that still says the old price.
    await buy.click();
    const want = `${BOX} now costs ${newPrice} gp (you pressed ${oldPrice} gp). Nothing was charged.`;
    await pl.page.waitForFunction(w => globalThis.__lcToasts.some(t => t.msg === w), want, { timeout: 15000 }).catch(() => {});
    await pl.page.waitForTimeout(800);
    const refused = await facts();
    const toasts = await pl.page.evaluate(() => globalThis.__lcToasts.splice(0));
    const toastShown = await pl.page.evaluate(w => [...document.querySelectorAll("#notifications .notification")].some(n => n.textContent.includes(w)), want);
    out.stale = {
      before: { label: before.label, dataPrice: before.dataPrice }, atClick: { label: stale.label, dataPrice: stale.dataPrice },
      toasts, toastShown,
      unchanged: { purse: refused.purse === before.purse, items: refused.items === before.items, log: refused.newestRow?.id === before.newestRow?.id, noReveal: refused.reveals === before.reveals },
    };
    out.stale.ok = out.held > 0 && stale.label === `${BOX}: Open for ${oldPrice} gp` && toasts.some(t => t.kind === "warn" && t.msg === want) && toastShown
      && Object.values(out.stale.unchanged).every(Boolean);

    // 3. The broadcast arrives; the shop redraws to the new price.
    hold.on = false;
    const releasedAt = Date.now();
    for (const send of hold.frames.splice(0)) send();
    await pl.page.waitForFunction(([id, p]) => document.querySelector(`.lc-shop .lc-box__buy[data-box="${id}"]`)?.dataset.price === String(p), [boxId, newPrice], { timeout: 5000 }).catch(() => {});
    const redrawn = await facts();
    out.redraw = { label: redrawn.label, dataPrice: redrawn.dataPrice, ms: Date.now() - releasedAt, off: redrawn.off };

    // 4. Pressed again: charged exactly the new price.
    await buy.click();
    await pl.page.waitForSelector(".application.lc-reveal .lc-card--landed", { timeout: 20000 });
    await pl.page.waitForTimeout(1200);
    const charged = await facts();
    out.charged = {
      paidCp: before.purseCp - charged.purseCp, wantCp: Math.round(newPrice * 100),
      items: charged.items - before.items, newRow: charged.newestRow?.id !== before.newestRow?.id,
      rowPrice: charged.newestRow?.price ?? null, rowItem: charged.newestRow?.name ?? null,
      toasts: await pl.page.evaluate(() => globalThis.__lcToasts.splice(0)),
    };
    out.charged.ok = out.charged.paidCp === out.charged.wantCp && out.charged.items === 1 && out.charged.newRow && out.charged.rowPrice === newPrice && !out.charged.toasts.some(t => t.kind !== "info");
    out.redraw.ok = redrawn.label === `${BOX}: Open for ${newPrice} gp` && !redrawn.off;
    if (shot) await pl.page.screenshot({ path: shot });
    await pl.page.evaluate(() => { for (const a of [...foundry.applications.instances.values()]) if (a.element?.classList.contains("lc-reveal")) a.close(); });
    out.gmConsole = gm.logs.filter(l => !l.includes("timings"));
    out.playerLog = pl.logs;
  } catch (err) {
    out.error = String(err?.stack || err);
    process.exitCode = 1;
  } finally {
    // The old price back, as the GM sets it.
    if (gm && boxId && oldPrice != null) {
      try {
        hold.on = false;
        for (const send of hold.frames.splice(0)) send();
        const now = await gm.page.evaluate(id => game.settings.get("loot-crates", "boxes")[id].price, boxId);
        if (now !== oldPrice) await setPrice(gm.page, boxId, oldPrice);
        out.restored = { price: await gm.page.evaluate(id => game.settings.get("loot-crates", "boxes")[id].price, boxId), want: oldPrice };
      } catch (err) { out.restored = { error: String(err) }; }
    }
    out.ok = !!(out.stale?.ok && out.redraw?.ok && out.charged?.ok && out.restored?.price === oldPrice);
    if (!out.ok && process.exitCode == null) process.exitCode = 1;
    console.log(JSON.stringify(out, null, 1));
    await browser.close();
  }
})();
