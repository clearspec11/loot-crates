// Live check: a scratch ticket whose prize line pays an item, coins and the gem at once (scratch.js prize lines), with what is left hidden from players, at a real table with the branch's code on both ends.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/checks/live-scratch-combo.cjs [--shot out.png]
//   (or: npm run live -- live-scratch-combo)
//
// Env: PLAYER (default Player2, must own Crate Tester), PACK (default
// dnd5e.items, where the pool's one item comes from).
//
// Two headless clients, the Gamemaster and the player, each running the
// branch's socket, redraw and shop code (as live-scratch-roll.cjs does).
// Then, as people do:
//
//   0. The GM seeds a pool "Live combo pool" holding one item from PACK
//      (the first uncommon loot-type item), and tops Crate Tester's gold up
//      if it is low.
//   1. The GM clicks "New scratch ticket" on the Boxes tab, types a name,
//      "1 gp" and 2 tickets, removes prize rows with their remove buttons
//      until one is left, makes it 1 ticket of the pool item's rarity,
//      presses the row's "Add a part" and makes the new part 5 gp coins,
//      presses it again and makes that part the bonus spot, sets the bonus
//      spot to 10 gp, unticks "Players see what is left in the roll",
//      ticks the pool and presses Add to shelf. One record: a roll of 2
//      with one line { item, 5 gp, the gem } and showLeft false.
//   2. The player's open shop shows its card with no tickets-left line and
//      no prize list, but its top prize and its Buy; the GM's manager row
//      reads "2 of 2 tickets left" and "hidden from players".
//   3. The player presses Buy until the combination ticket comes (two at
//      most), opening each with the reveal's Reveal all. On that ticket
//      the card has three winning panels (the item, the 5 gp, the gem),
//      the result names the item and "15 gp into Crate Tester's purse",
//      the item is on Crate Tester's sheet and the purse rose by 15 gp less
//      the 1 gp ticket.
//   4. The GM refunds the combination ticket from the Pull log (Refund,
//      Yes): the item is gone from the sheet and the purse is back where it
//      was before that Buy (the 15 gp taken back, the 1 gp returned).
//
// Restored in a finally: every ticket this run bought is refunded, the
// game it made deleted (only that one), the shop's open state put back;
// the pool stays seeded. Needs "Crate Tester" in "Loot Crates Test".
/* global game, Hooks, foundry, fromUuid, __lc */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const PACK = process.env.PACK || "dnd5e.items";
const POOL = "Live combo pool";
const shot = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : null;
const STAMP = Date.now().toString(36);
const NAME = `Live combo ${STAMP}`;

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
  // What main.js does first: the branch's words, from its own lang/en.json.
  await page.evaluate(async base => (await import(base + "scripts/core/i18n.js")).loadStrings(), MODULE_BASE);
  // The branch's code in place of the installed module's, as main.js wires it.
  await page.evaluate(async base => {
    globalThis.canvas?.app?.ticker?.stop();
    // The installed build's stylesheet goes (Foundry imports each module's
    // into a style element): its prize row hid a gold field by the row's
    // choice, which a row of several parts no longer has.
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
    const { refreshShop, registerShopHooks } = await import(base + "scripts/foundry/shop.js");
    const { refreshManager } = await import(base + "scripts/foundry/manager.js");
    const redraw = storeRedraw({ refreshShop, refreshManager });
    store.setStoreListener(redraw);
    for (const key of store.WORLD_KEYS) {
      const cfg = game.settings.settings.get(`loot-crates.${key}`);
      if (cfg && !String(cfg.onChange ?? "").includes("storeChanged")) cfg.onChange = () => redraw(key);
    }
    registerShopHooks?.(Hooks);
  }, MODULE_BASE);
  return { page, logs };
}

const HELPERS = `
  globalThis.__lc = globalThis.__lc ?? {};
  __lc.wait = ms => new Promise(r => setTimeout(r, ms));
  __lc.until = async (fn, ms = 15000) => { for (let t = 0; t < ms && !fn(); t += 50) await __lc.wait(50); return fn(); };
  __lc.click = el => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
  __lc.dialog = () => [...document.querySelectorAll(".application.lc-dialog")].pop() ?? null;
  __lc.status = () => __lc.app?.element?.querySelector(".lc-manager__status")?.textContent ?? null;
  __lc.closeReveals = () => { for (const a of [...foundry.applications.instances.values()]) if (a.element?.classList.contains("lc-reveal")) a.close(); };
`;

// The player's card for the game as the shop shows it, the log's rows of
// the game and Crate Tester's purse and items.
const readCard = (pl, boxId) => pl.evaluate(async ({ base, boxId }) => {
  const { getLog } = await import(base + "scripts/foundry/store.js");
  const { toCopper } = await import(base + "scripts/core/currency.js");
  const actor = game.actors.find(a => a.isOwner && a.type === "character" && a.name === "Crate Tester");
  const card = document.querySelector(`#loot-crates-shop .lc-box[data-box="${boxId}"]`);
  const buy = card?.querySelector(".lc-box__buy");
  return {
    shown: !!card, text: card?.innerText.replace(/\s+/g, " ").trim() ?? "", stock: card?.querySelector(".lc-box__stock")?.textContent.trim() ?? null,
    prizes: !!card?.querySelector(".lc-scratch__prizes"), off: buy?.getAttribute("aria-disabled") === "true",
    rows: getLog().filter(r => r.boxId === boxId).length, purseCp: toCopper(actor.system.currency), items: actor.items.map(i => i.id),
  };
}, { base: MODULE_BASE, boxId });

const untilCard = async (pl, boxId, pred, ms = 5000) => {
  const t0 = Date.now();
  let c = await readCard(pl, boxId);
  while (!pred(c) && Date.now() - t0 < ms) { await pl.waitForTimeout(100); c = await readCard(pl, boxId); }
  return { ...c, ms: pred(c) ? Date.now() - t0 : null };
};

(async () => {
  const browser = await chromium.launch();
  const out = { player: PLAYER, name: NAME };
  let gm = null, pl = null, boxId = null, shopOpen = true;
  try {
    pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");

    // 0. The pool, the gold and the shop.
    out.seed = await gm.page.evaluate(async ({ base, pack: packId, poolName }) => {
      const store = await import(base + "scripts/foundry/store.js");
      const folder = game.folders.find(f => f.type === "Actor" && f.name === "Loot Crates Test");
      const actor = game.actors.find(a => a.name === "Crate Tester" && a.folder?.id === folder?.id);
      if (!actor) throw new Error("no Crate Tester in Loot Crates Test");
      if ((actor.system.currency.gp ?? 0) < 20) await actor.update({ "system.currency.gp": 1000 });
      const pack = game.packs.get(packId);
      if (!pack) throw new Error(`no ${packId} compendium in this world`);
      const index = await pack.getIndex({ fields: ["system.rarity", "type"] });
      const hit = index.find(e => store.isLootType(e.type) && e.system?.rarity === "uncommon");
      if (!hit) throw new Error(`${packId} holds no uncommon loot-type item`);
      const entry = store.entryFromItem(await fromUuid(hit.uuid), hit.uuid);
      const old = Object.values(store.getPools()).find(p => p.name === poolName);
      const pool = await store.savePool({ ...(old ? { id: old.id } : {}), name: poolName, entries: [entry], pools: [] });
      const open = store.isShopOpen();
      if (!open) await store.setShopOpen(true);
      return { poolId: pool.id, item: entry.name, rarity: entry.rarity, open };
    }, { base: MODULE_BASE, pack: PACK, poolName: POOL });
    shopOpen = out.seed.open;
    const { poolId, rarity, item } = out.seed;

    // The player's shop, open on Crate Tester.
    await pl.page.evaluate(async ({ base, helpers }) => {
      (0, eval)(helpers);
      const { openShop } = await import(base + "scripts/foundry/shop.js");
      const actor = game.actors.find(a => a.isOwner && a.type === "character" && a.name === "Crate Tester");
      if (!actor) throw new Error(`${game.user.name} doesn't own Crate Tester`);
      const app = openShop();
      await __lc.until(() => app.element?.querySelector(".lc-shop__body"), 8000);
      const pick = app.element.querySelector(".lc-shop__actor");
      if (pick && pick.value !== actor.id) { pick.value = actor.id; pick.dispatchEvent(new Event("change")); await __lc.wait(800); }
    }, { base: MODULE_BASE, helpers: HELPERS });

    // 1. New scratch ticket with one combination line, in the editor.
    await gm.page.evaluate(async ({ base, helpers }) => {
      (0, eval)(helpers);
      const { openManager } = await import(base + "scripts/foundry/manager.js");
      __lc.app = openManager();
      await __lc.until(() => __lc.app.element?.querySelector('.lc-tabs [data-tab="boxes"]'));
      __lc.click(__lc.app.element.querySelector('.lc-tabs [data-tab="boxes"]'));
      await __lc.until(() => __lc.app.tab === "boxes" && __lc.app.element.querySelector('[data-action="addScratch"]'), 8000);
    }, { base: MODULE_BASE, helpers: HELPERS });
    await gm.page.locator('#loot-crates-manager [data-action="addScratch"]').click();
    const dlg = gm.page.locator(".application.lc-dialog").last();
    await dlg.locator('input[name="name"]').waitFor({ timeout: 8000 });
    await dlg.locator('input[name="name"]').fill(NAME);
    await dlg.locator('input[name="price"]').fill("1 gp");
    await dlg.locator('input[name="size"]').fill("2");
    while (await dlg.locator(".lc-prize-row").count() > 1) await dlg.locator(".lc-prize-row__remove").first().click();
    const row = dlg.locator(".lc-prize-row").first();
    await row.locator(".lc-prize-row__count").fill("1");
    await row.locator(".lc-prize-part").first().locator(".lc-prize-row__what").selectOption(`item.${rarity}`);
    await row.locator(".lc-prize-row__and").click();
    await row.locator(".lc-prize-part").nth(1).locator(".lc-prize-row__what").selectOption("gp");
    await row.locator(".lc-prize-part").nth(1).locator(".lc-prize-row__gp").fill("5");
    await row.locator(".lc-prize-row__and").click();
    await row.locator(".lc-prize-part").nth(2).locator(".lc-prize-row__what").selectOption("bonus");
    await dlg.locator('input[name="bonusOn"]').check();
    await dlg.locator('input[name="bonusGp"]').fill("10");
    await dlg.locator('input[name="showLeft"]').uncheck();
    await dlg.locator(`input[name="pool.${poolId}"]`).check();
    out.editor = {
      partLabels: await row.locator(".lc-prize-part .lc-prize-row__what").evaluateAll(els => els.map(e => e.getAttribute("aria-label"))),
      readout: (await dlg.locator(".lc-scratch-form__readout").textContent()).trim(),
    };
    const known = await gm.page.evaluate(() => Object.keys(game.settings.get("loot-crates", "boxes")));
    await dlg.locator('button[data-action="ok"]').click();
    out.made = await gm.page.evaluate(async ({ base, known }) => {
      const store = await import(base + "scripts/foundry/store.js");
      const fresh = () => Object.values(store.getBoxes()).filter(b => !known.includes(b.id));
      await __lc.until(() => fresh().length && !__lc.dialog(), 8000);
      const b = fresh()[0];
      return b ? { id: b.id, kind: b.kind, price: b.price, showLeft: b.showLeft, bonus: b.bonus, roll: b.roll, pools: b.pools } : null;
    }, { base: MODULE_BASE, known });
    boxId = out.made?.id ?? null;
    if (!boxId) throw new Error("no scratch ticket was added");

    // 2. Hidden from the player, shown to the GM.
    out.playerCard = await untilCard(pl.page, boxId, c => c.shown && /Top prize/.test(c.text));
    out.gmRow = await gm.page.evaluate(async ({ boxId }) => {
      await __lc.until(() => [...(__lc.app.element?.querySelectorAll(".lc-table--boxes tbody tr") ?? [])].some(r => r.querySelector(`[data-box="${boxId}"]`)), 8000);
      const r = [...__lc.app.element.querySelectorAll(".lc-table--boxes tbody tr")].find(x => x.querySelector(`[data-box="${boxId}"]`));
      return r?.querySelector('td[data-label="Rules"]')?.textContent.replace(/\s+/g, " ").trim() ?? null;
    }, { boxId });

    // 3. Buy until the combination ticket comes.
    out.buys = [];
    let combo = null;
    for (let i = 0; i < 2 && !combo; i++) {
      const before = await untilCard(pl.page, boxId, c => !c.off, 5000);
      await pl.page.locator(`#loot-crates-shop .lc-box__buy[data-box="${boxId}"]`).click();
      await pl.page.locator(".application.lc-reveal .lc-scratch__all").last().click({ timeout: 15000 });
      await pl.page.waitForSelector(".application.lc-reveal .lc-scratch--landed", { timeout: 15000 }).catch(() => {});
      const after = await untilCard(pl.page, boxId, c => c.rows === before.rows + 1, 15000);
      const reveal = await pl.page.evaluate(() => {
        const rv = [...document.querySelectorAll(".application.lc-reveal")].pop();
        const lit = [...(rv?.querySelectorAll(".lc-scratch__panel--win") ?? [])];
        return {
          lit: lit.length, gem: lit.some(p => p.dataset.panel === "bonus"), itemLit: lit.some(p => [...p.classList].some(c => c.startsWith("lc-rarity-"))),
          prizes: lit.filter(p => p.dataset.panel !== "bonus").map(p => p.querySelector(".lc-scratch__prize")?.textContent.trim()),
          foot: rv?.querySelector(".lc-scratch__roll")?.textContent.trim() ?? null,
          result: rv?.querySelector(".lc-reveal__result")?.innerText.replace(/\s+/g, " ").trim() ?? null,
        };
      });
      const rowNow = await gm.page.evaluate(async ({ base, boxId }) => {
        const r = (await import(base + "scripts/foundry/store.js")).getLog().filter(x => x.boxId === boxId)[0];
        return r ? { id: r.id, tier: r.tier, itemId: r.itemId ?? null, itemIds: r.itemIds ?? [], payoutCp: r.payoutCp, price: r.price } : null;
      }, { base: MODULE_BASE, boxId });
      const buy = { before: before.purseCp, after: after.purseCp, row: rowNow, reveal, newItems: after.items.filter(id => !before.items.includes(id)) };
      out.buys.push(buy);
      if (rowNow?.tier?.includes("+")) { combo = buy; if (shot) await pl.page.screenshot({ path: shot }); }
      await pl.page.evaluate(() => __lc.closeReveals());
      await gm.page.evaluate(() => __lc.closeReveals());
    }
    if (!combo) throw new Error("the combination ticket never came in a roll of two");
    out.onSheet = await gm.page.evaluate(({ itemId }) => {
      const actor = game.actors.find(a => a.name === "Crate Tester");
      return actor.items.get(itemId)?.name ?? null;
    }, { itemId: combo.row.itemId });

    // 4. The GM refunds the combination ticket from the Pull log: Refund, Yes.
    out.refund = await gm.page.evaluate(async ({ base, rowId }) => {
      const store = await import(base + "scripts/foundry/store.js");
      __lc.click(__lc.app.element.querySelector('.lc-tabs [data-tab="log"]'));
      const btn = () => __lc.app.element?.querySelector(`button[data-action=refund][data-row="${rowId}"]`);
      if (!await __lc.until(() => __lc.app.tab === "log" && btn(), 8000)) throw new Error("the Pull log has no Refund for the ticket");
      __lc.click(btn());
      const dialog = () => [...document.querySelectorAll(".application.dialog")].pop();
      const yes = () => [...(dialog()?.querySelectorAll("button") ?? [])].find(b => /yes/i.test(b.dataset.action ?? b.textContent));
      await __lc.until(() => yes());
      const ask = dialog()?.querySelector(".window-content")?.textContent.replace(/\s+/g, " ").trim() ?? null;
      __lc.click(yes());
      await __lc.until(() => store.getLog().find(r => r.id === rowId)?.refunded, 8000);
      return { ask, refunded: !!store.getLog().find(r => r.id === rowId)?.refunded };
    }, { base: MODULE_BASE, rowId: combo.row.id });
    out.afterRefund = await untilCard(pl.page, boxId, c => !c.items.includes(combo.row.itemId) && c.purseCp === combo.before, 8000);

    const line = out.made.roll?.prizes?.[0];
    out.checks = {
      editor: out.editor.partLabels.join("|") === "What part 1 of prize 1 is|What part 2 of prize 1 is|What part 3 of prize 1 is" && /^1 in 2 tickets wins, the top prize \(.+ item \+ 5 gp \+ the gem \(10 gp\)\) 1 in 2/.test(out.editor.readout),
      made: out.made.kind === "scratch" && out.made.price === 1 && out.made.showLeft === false && out.made.bonus?.on === true && out.made.bonus?.gp === 10 && out.made.roll?.size === 2
        && JSON.stringify(line) === JSON.stringify({ count: 1, parts: [{ item: { rarity } }, { gp: 5 }, { bonus: true }] }) && out.made.pools?.[0]?.id === poolId,
      playerHidden: out.playerCard.ms != null && out.playerCard.stock === null && !out.playerCard.prizes && !/tickets left|tickets wins/.test(out.playerCard.text) && /Buy a ticket for 1 gp/.test(out.playerCard.text) && !out.playerCard.off,
      gmShown: /2 of 2 tickets left/.test(out.gmRow ?? "") && /hidden from players/.test(out.gmRow ?? ""),
      threePanels: combo.reveal.lit === 3 && combo.reveal.gem && combo.reveal.itemLit && combo.reveal.prizes.includes("5 gp"),
      noCountsInReveal: combo.reveal.foot === "Roll 1" && !/tickets left/.test(combo.reveal.result ?? ""),
      result: (combo.reveal.result ?? "").includes(item) && /15 gp into Crate Tester's purse/.test(combo.reveal.result ?? ""),
      granted: combo.row.itemId && combo.newItems.includes(combo.row.itemId) && out.onSheet === item && combo.row.payoutCp === 1500,
      paid: combo.after - combo.before === 1500 - 100,
      refunded: out.refund.refunded && out.afterRefund.ms != null && !out.afterRefund.items.includes(combo.row.itemId) && out.afterRefund.purseCp === combo.before,
    };
    out.ok = Object.values(out.checks).every(Boolean);
    out.gmConsole = gm.logs.filter(l => !l.includes("timings"));
    out.playerLog = pl.logs;
  } catch (err) {
    out.error = String(err?.stack || err);
    out.ok = false;
  } finally {
    // Every ticket this run bought refunded, the game it made deleted, the shop as it was.
    try {
      out.restored = gm && boxId ? await gm.page.evaluate(async ({ base, boxId, shopOpen }) => {
        const store = await import(base + "scripts/foundry/store.js");
        const { refundPull } = await import(base + "scripts/foundry/refund.js");
        const refunded = [];
        for (const r of store.getLog().filter(x => x.boxId === boxId && !x.refunded)) { const res = await refundPull(r.id); refunded.push(res.status); }
        await store.removeBox(boxId);
        if (!shopOpen) await store.setShopOpen(false);
        try { await globalThis.__lc?.app?.close(); } catch { /* closed */ }
        __lc.closeReveals?.();
        return { refunded, gone: !store.getBoxes()[boxId], open: store.isShopOpen() };
      }, { base: MODULE_BASE, boxId, shopOpen }) : null;
    } catch (err) { out.restored = { error: String(err) }; out.ok = false; }
    if (out.restored && (out.restored.error || !out.restored.gone || out.restored.refunded.some(s => s !== "refunded"))) out.ok = false;
    try { await pl?.page.evaluate(() => { for (const a of [...foundry.applications.instances.values()]) if (/loot-crates/.test(a.id) || a.element?.classList.contains("lc-reveal")) a.close(); }); } catch { /* closing */ }
    // Crate Tester's inventory piles up: the item ids read as a count.
    console.log(JSON.stringify(out, (k, v) => (k === "items" && Array.isArray(v) ? v.length : v), 1));
    if (!out.ok) process.exitCode = 1;
    await browser.close();
  }
})();
