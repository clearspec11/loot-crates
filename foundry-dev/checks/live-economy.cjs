// Live check: the economy readout (VIB-218: views/economy.js, the chars
// and games tallies in core/tally.js) on the manager's Pull log tab, at a
// real table with the branch's code on the Gamemaster's and the player's
// client.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/checks/live-economy.cjs [--shot out.png]
//   (or: npm run live -- live-economy)
//
// Env: PLAYER (default Player2, must own Crate Tester), PACK (default
// dnd5e.items, where the pool's one priced item comes from).
//
// Two headless clients, the Gamemaster and the player, each running the
// branch's socket (as live-afterreveal.cjs does). Then, as people do:
//
//   0. The GM seeds "Live economy pool" (one priced item from PACK,
//      common) and a crate drawing from it at 5 gp, opens the shop if it
//      was closed and tops Crate Tester's gold up.
//   1. The GM opens the manager and clicks the Pull log tab: the readout
//      sits at the top, All time pressed; reads Crate Tester's Spent and
//      that the new crate has no line yet.
//   2. The player opens the shop on Crate Tester and presses the crate's
//      Buy once.
//   3. Without touching the manager, the GM's readout redraws: Crate
//      Tester's Spent is up by exactly 5 gp, the crate's line reads Plays
//      1, Taken 5 gp and Paid in items the item's price. The GM presses
//      This session: the crate's line is there too (the pull came after
//      this client loaded), the note says what the period counts.
//   4. The non-GM's view: the player's client, opening the manager the
//      same way, has no readout.
//
// Restored in a finally: the pull refunded (its item leaves with it), and
// the GM's readout read once more (Crate Tester's Spent back where it
// was, the crate's line gone: the refund undid the tallies), Crate
// Tester's purse as it was, the crate deleted, the shop's open state as it
// was. The pool stays seeded.
/* global game, foundry, fromUuid, __lc */
const { chromium } = require("playwright");
// A Buy over half the purse asks first; pressSpend presses it again then.
const { pressSpend } = require("./lib/spend.cjs");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const PACK = process.env.PACK || "dnd5e.items";
const POOL = "Live economy pool";
const shot = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : null;
const STAMP = Date.now().toString(36);
const CRATE = `Live economy crate ${STAMP}`;

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
  await page.evaluate(async base => (await import(base + "scripts/core/i18n.js")).loadStrings(), MODULE_BASE);
  // The branch's code in place of the installed module's, as main.js wires it.
  await page.evaluate(async base => {
    globalThis.canvas?.app?.ticker?.stop();
    for (const sheet of [...document.styleSheets]) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (let i = rules.length - 1; i >= 0; i--) if (rules[i] instanceof CSSImportRule && /modules\/loot-crates\//.test(rules[i].href)) sheet.deleteRule(i);
    }
    for (const l of document.querySelectorAll('link[rel="stylesheet"][href*="modules/loot-crates/"]')) l.disabled = true;
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

const HELPERS = `
  globalThis.__lc = globalThis.__lc ?? {};
  __lc.wait = ms => new Promise(r => setTimeout(r, ms));
  __lc.until = async (fn, ms = 15000) => { for (let t = 0; t < ms && !fn(); t += 50) await __lc.wait(50); return fn(); };
  __lc.click = el => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
`;

// Opens the shop on `actorName` and presses the crate's Buy (the real button).
async function buy(client, boxId, actorName) {
  await client.page.evaluate(async ({ base, helpers, actorName }) => {
    (0, eval)(helpers);
    const { openShop } = await import(base + "scripts/foundry/shop.js");
    const actor = game.actors.find(a => a.isOwner && a.name === actorName);
    __lc.shop = openShop();
    await __lc.until(() => __lc.shop.element?.querySelector(".lc-box"), 8000);
    const pick = __lc.shop.element.querySelector(".lc-shop__actor");
    if (pick && pick.value !== actor.id) { pick.value = actor.id; pick.dispatchEvent(new Event("change")); await __lc.wait(800); }
  }, { base: MODULE_BASE, helpers: HELPERS, actorName });
  const btn = client.page.locator(`#loot-crates-shop .lc-box__buy[data-box="${boxId}"]`);
  await btn.waitFor({ timeout: 10000 });
  await client.page.waitForFunction(id => document.querySelector(`#loot-crates-shop .lc-box__buy[data-box="${id}"]`)?.getAttribute("aria-disabled") !== "true", boxId, { timeout: 10000 });
  await pressSpend(btn);
}


// The readout as the GM's open manager shows it: the pressed period, each
// table's lines by name ({ cells }), the notes.
const readout = page => page.evaluate(() => {
  const app = __lc.app?.element;
  const econ = app?.querySelector(".lc-econ");
  if (!econ) return { present: false, tab: __lc.app?.tab ?? null };
  const table = i => Object.fromEntries([...(econ.querySelectorAll(".lc-econ__scroll")[i]?.querySelectorAll("tbody tr") ?? [])].map(tr => [tr.children[0].textContent.trim(), [...tr.children].map(c => c.textContent.trim())]));
  return {
    present: true,
    first: econ.parentElement?.firstElementChild === econ,
    pressed: [...econ.querySelectorAll('[data-action="econPeriod"][aria-pressed="true"]')].map(b => b.textContent.trim()),
    chars: table(0), games: table(1),
    notes: [...econ.querySelectorAll(".lc-econ__note")].map(p => p.textContent.trim()),
  };
});
const cp = s => { let n = 0; for (const [, v, c] of String(s ?? "").matchAll(/(\d+) (pp|gp|ep|sp|cp)/g)) n += Number(v) * { pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1 }[c]; return String(s ?? "").startsWith("−") ? -n : n; };

// Opens the manager on this client and clicks its Pull log tab (the real tab).
async function openLog(page) {
  return page.evaluate(async ({ base, helpers }) => {
    (0, eval)(helpers);
    const { openManager } = await import(base + "scripts/foundry/manager.js");
    __lc.app = openManager();
    await __lc.until(() => __lc.app.element?.querySelector('.lc-tabs [data-tab="log"]'));
    __lc.click(__lc.app.element.querySelector('.lc-tabs [data-tab="log"]'));
    return !!await __lc.until(() => __lc.app.tab === "log" && __lc.app.element?.querySelector(".lc-table--log, .lc-empty"), 8000);
  }, { base: MODULE_BASE, helpers: HELPERS });
}

(async () => {
  const browser = await chromium.launch();
  const out = { player: PLAYER };
  let gm = null, pl = null;
  let boxId = null, seed = null;
  try {
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");
    pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);

    // 0. The pool, the crate, the shop, the gold.
    seed = out.seed = await gm.page.evaluate(async ({ base, pack: packId, poolName, crate }) => {
      const store = await import(base + "scripts/foundry/store.js");
      const folder = game.folders.find(f => f.type === "Actor" && f.name === "Loot Crates Test");
      const tester = game.actors.find(a => a.name === "Crate Tester" && a.folder?.id === folder?.id);
      if (!tester) throw new Error("no Crate Tester in Loot Crates Test");
      const purse = foundry.utils.deepClone(tester.system.currency);
      if ((tester.system.currency.gp ?? 0) < 20) await tester.update({ "system.currency.gp": 1000 });
      const pack = game.packs.get(packId);
      if (!pack) throw new Error(`no ${packId} compendium in this world`);
      const index = await pack.getIndex({ fields: ["system.rarity", "system.price", "type"] });
      const hit = index.find(e => store.isLootType(e.type) && e.type !== "consumable" && Number(e.system?.price?.value) >= 4 && Number(e.system?.price?.value) <= 500 && e.system?.price?.denomination === "gp");
      if (!hit) throw new Error(`${packId} holds no priced loot-type item`);
      const entry = store.entryFromItem(await fromUuid(hit.uuid), hit.uuid);
      const old = Object.values(store.getPools()).find(p => p.name === poolName);
      const pool = await store.savePool({ ...(old ? { id: old.id } : {}), name: poolName, entries: [{ ...entry, rarity: "common" }], pools: [] });
      const c = await store.saveBox({ name: crate, price: 5, pools: [{ id: pool.id, share: 1 }], weights: { common: 1 }, rules: {} });
      const shopWasOpen = store.isShopOpen();
      if (!shopWasOpen) await store.setShopOpen(true);
      return { crateId: c.id, shopWasOpen, purse, testerId: tester.id, itemName: entry.name, price: hit.system.price };
    }, { base: MODULE_BASE, pack: PACK, poolName: POOL, crate: CRATE });
    boxId = seed.crateId;

    // 1. The GM's Pull log tab, its readout before.
    out.opened = await openLog(gm.page);
    out.before = await readout(gm.page);

    // 2. One pull by the player.
    await buy(pl, boxId, "Crate Tester");
    const grew = () => gm.page.waitForFunction(name => [...(__lc.app?.element?.querySelectorAll(".lc-econ__scroll tbody th") ?? [])].some(th => th.textContent.trim() === name), CRATE, { timeout: 15000 }).then(() => true, () => false);
    out.redrawn = await grew();
    await gm.page.waitForTimeout(400);
    out.after = await readout(gm.page);
    if (shot) await gm.page.screenshot({ path: shot });

    // 3. This session, pressed as the GM does.
    await gm.page.locator('#loot-crates-manager [data-action="econPeriod"][data-period="session"]').click();
    await gm.page.waitForFunction(() => __lc.app?.element?.querySelector('[data-action="econPeriod"][data-period="session"]')?.getAttribute("aria-pressed") === "true", null, { timeout: 8000 }).catch(() => {});
    out.session = await readout(gm.page);
    out.sessionFocus = await gm.page.evaluate(() => document.activeElement?.dataset?.period ?? null);
    await gm.page.locator('#loot-crates-manager [data-action="econPeriod"][data-period="all"]').click();

    // 4. The player's manager: no readout.
    await openLog(pl.page);
    out.playerView = await readout(pl.page);
    await pl.page.evaluate(() => __lc.app?.close()).catch(() => {});

    const tester = name => name === "Crate Tester";
    const spent = r => cp(Object.entries(r?.chars ?? {}).find(([n]) => tester(n))?.[1]?.[1]);
    const line = r => r?.games?.[CRATE] ?? null;
    const itemCp = Math.round(Number(seed.price.value) * 100);
    out.checks = {
      readout: out.opened && out.before.present && out.before.first && out.before.pressed.join() === "All time",
      noLineBefore: !line(out.before),
      spentRose: spent(out.after) - spent(out.before) === 500,
      plays: out.redrawn && line(out.after)?.[1] === "1",
      taken: line(out.after)?.[2] === "5 gp",
      itemsOut: cp(line(out.after)?.[4]) === itemCp,
      session: out.session.pressed.join() === "This session" && line(out.session)?.[1] === "1" && out.session.notes.some(n => /^This session counts the plays since you loaded the world/.test(n)) && out.sessionFocus === "session",
      gmOnly: out.playerView.present === false,
    };
    out.ok = Object.values(out.checks).every(Boolean);
    out.gmConsole = gm.logs.filter(l => !l.includes("timings"));
  } catch (err) {
    out.error = String(err?.stack || err);
    out.ok = false;
  } finally {
    // The pull refunded, the readout read back, the purse, the crate and the shop as they were.
    try {
      out.restored = gm && boxId ? await gm.page.evaluate(async ({ base, boxId, seed }) => {
        const store = await import(base + "scripts/foundry/store.js");
        const { refundPull } = await import(base + "scripts/foundry/refund.js");
        const { toCopper } = await import(base + "scripts/core/currency.js");
        const refunded = [];
        for (const r of store.getLog().filter(x => x.boxId === boxId && !x.refunded)) refunded.push((await refundPull(r.id)).status);
        const tally = store.getTally();
        const undone = !tally.games?.[boxId];
        const tester = game.actors.get(seed.testerId);
        if (toCopper(tester.system.currency) !== toCopper(seed.purse)) await tester.update({ "system.currency": seed.purse });
        await store.removeBox(boxId);
        if (!seed.shopWasOpen) await store.setShopOpen(false);
        return { refunded, undone, purseRestored: toCopper(tester.system.currency) === toCopper(seed.purse), gone: !store.getBoxes()[boxId], shop: store.isShopOpen() === seed.shopWasOpen };
      }, { base: MODULE_BASE, boxId, seed }) : null;
      if (gm && out.before?.present) {
        await gm.page.waitForTimeout(800);
        const back = await readout(gm.page);
        const s = r => cp(Object.entries(r?.chars ?? {}).find(([n]) => n === "Crate Tester")?.[1]?.[1]);
        out.restored.readoutBack = s(back) === s(out.before) && !back.games?.[CRATE];
      }
      try { await gm?.page.evaluate(() => __lc.app?.close()); } catch { /* closed */ }
    } catch (err) { out.restored = { error: String(err) }; out.ok = false; }
    if (out.restored && (out.restored.error || !out.restored.gone || !out.restored.shop || !out.restored.purseRestored || !out.restored.undone || out.restored.readoutBack === false || out.restored.refunded.some(s => s !== "refunded"))) out.ok = false;
    for (const c of [pl, gm]) { try { await c?.page.evaluate(() => { for (const a of [...foundry.applications.instances.values()]) if (/loot-crates/.test(a.id)) a.close(); }); } catch { /* closing */ } }
    console.log(JSON.stringify(out, null, 1));
    if (!out.ok) process.exitCode = 1;
    await browser.close();
  }
})();
