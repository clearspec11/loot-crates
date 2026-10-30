// Live check: tickets you carry (games/ticket.js, foundry/tickets.js), at a real table with the branch's code on both ends.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/checks/live-ticket.cjs [--shot out.png]
//   (or: npm run live -- live-ticket)
//
// Env: PLAYER (default Player2, must own Crate Tester), PACK (default
// dnd5e.items, where the pool's one item comes from).
//
// Two headless clients, the Gamemaster and the player, each running the
// branch's socket and the branch's dnd5e.preUseActivity hook (any copy of
// that hook the installed build registered is swapped out first). Then, as
// people do:
//
//   0. The GM seeds a pool "Live ticket pool" holding one item from PACK
//      (tagged common), a crate drawing from it and a scratch ticket with a roll of 20,
//      and tops Crate Tester's gold up if it is low.
//   1. The GM presses Make a ticket on the scratch ticket's Boxes row and on
//      the crate's row (the real buttons). Each makes a world Item in the
//      Items folder "Loot Crates tickets" and the tab's status line says so.
//   2. The GM gives Crate Tester two of the crate ticket (quantity 2) and
//      one scratch ticket, by the GM's API (createEmbeddedDocuments).
//   3. The player opens Crate Tester's sheet, its Inventory tab, and presses
//      the crate ticket's Use (the sheet's own data-action="use" control).
//      The reveal plays on both clients and says "with a ticket"; the ticket
//      stack drops to 1; the prize is on the sheet; no coins move; no dnd5e
//      chat card for the ticket is posted.
//   4. The GM refunds that row from the Pull log (Refund, Yes): the stack is
//      2 again, the prize is gone, no coins move.
//   5. The player presses Use on the scratch ticket and scratches every
//      panel with real mouse strokes until the card lands; the ticket is
//      used up (gone from the sheet) and its row carries the ticket.
//
// Restored in a finally: every row this run made refunded, every ticket on
// Crate Tester for this run's games deleted, the world tickets it made
// deleted, the two games deleted; the pool stays seeded and the folder
// "Loot Crates tickets" stays (checks never delete folders). Needs "Crate
// Tester" in "Loot Crates Test".
/* global game, Hooks, foundry, fromUuid, Item, __lc */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const PACK = process.env.PACK || "dnd5e.items";
const POOL = "Live ticket pool";
const shot = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : null;
const STAMP = Date.now().toString(36);
const CRATE = `Live ticket crate ${STAMP}`;
const SCRATCH = `Live ticket scratch ${STAMP}`;

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
    // A ticket's Use: the branch's hook, and no other copy of it (a
    // newer installed build registers its own, which would ask twice).
    for (const h of [...(Hooks.events?.["dnd5e.preUseActivity"] ?? [])]) if (/ticketOf|requestRedeem|redeem/.test(String(h.fn))) Hooks.off("dnd5e.preUseActivity", h.fn);
    const { ticketUseHook } = await import(base + "scripts/foundry/tickets.js");
    Hooks.on("dnd5e.preUseActivity", ticketUseHook(socket.requestRedeem));
  }, MODULE_BASE);
  return { page, logs };
}

const HELPERS = `
  globalThis.__lc = globalThis.__lc ?? {};
  __lc.wait = ms => new Promise(r => setTimeout(r, ms));
  __lc.until = async (fn, ms = 15000) => { for (let t = 0; t < ms && !fn(); t += 50) await __lc.wait(50); return fn(); };
  __lc.click = el => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
  __lc.status = () => __lc.app?.element?.querySelector(".lc-manager__status")?.textContent ?? null;
  __lc.closeReveals = () => { for (const a of [...foundry.applications.instances.values()]) if (a.element?.classList.contains("lc-reveal")) a.close(); };
`;

// Crate Tester as the GM sees it: the purse in copper, the item ids, and the
// quantity of the ticket item `ticketId` (null when it is gone).
const readActor = (page, ticketId) => page.evaluate(async ({ base, ticketId }) => {
  const { toCopper } = await import(base + "scripts/core/currency.js");
  const actor = game.actors.find(a => a.name === "Crate Tester" && a.folder?.name === "Loot Crates Test");
  return { purseCp: toCopper(actor.system.currency), items: actor.items.map(i => i.id), qty: ticketId ? actor.items.get(ticketId)?.system.quantity ?? null : null };
}, { base: MODULE_BASE, ticketId });

const untilActor = async (page, ticketId, pred, ms = 10000) => {
  const t0 = Date.now();
  let a = await readActor(page, ticketId);
  while (!pred(a) && Date.now() - t0 < ms) { await page.waitForTimeout(100); a = await readActor(page, ticketId); }
  return { ...a, ms: pred(a) ? Date.now() - t0 : null };
};

const logRows = (page, boxId) => page.evaluate(async ({ base, boxId }) => (await import(base + "scripts/foundry/store.js")).getLog().filter(r => r.boxId === boxId).map(r => ({ id: r.id, price: r.price, payoutCp: r.payoutCp, itemId: r.itemId ?? null, refunded: !!r.refunded, redeem: r.redeem ? { itemId: r.redeem.itemId, itemName: r.redeem.itemName, paid: r.redeem.paid } : null })), { base: MODULE_BASE, boxId });
// The GM writes a play's row just after its reveal goes out, so a read
// right after the ticket drops can come before it: wait for the row.
const untilRows = async (page, boxId, n = 1, ms = 8000) => {
  let rows = await logRows(page, boxId);
  for (const t0 = Date.now(); rows.filter(r => r.redeem).length < n && Date.now() - t0 < ms;) { await page.waitForTimeout(100); rows = await logRows(page, boxId); }
  return rows;
};

// The newest reveal window on a page: what its head says in place of a
// price, and its text.
const readReveal = page => page.evaluate(() => {
  const rv = [...document.querySelectorAll(".application.lc-reveal")].pop();
  return rv ? { price: rv.querySelector(".lc-reveal__price")?.textContent.trim() ?? null, text: rv.innerText.replace(/\s+/g, " ").trim().slice(0, 300) } : null;
});

// The player presses Use on a ticket on Crate Tester's sheet: the sheet
// open, its Inventory tab pressed, then the row's own use control.
async function pressUse(page, itemId) {
  const sheetId = await page.evaluate(async ({ helpers }) => {
    (0, eval)(helpers);
    const actor = game.actors.find(a => a.isOwner && a.name === "Crate Tester");
    await actor.sheet.render(true);
    await __lc.until(() => actor.sheet.element?.isConnected, 8000);
    return actor.sheet.element.id;
  }, { helpers: HELPERS });
  const sheet = page.locator(`#${sheetId}`);
  await sheet.locator('nav [data-tab="inventory"]').first().click();
  const use = sheet.locator(`[data-item-id="${itemId}"] [data-action="use"]`).first();
  await use.waitFor({ timeout: 8000 });
  await use.click();
  return sheetId;
}

(async () => {
  const browser = await chromium.launch();
  const out = { player: PLAYER };
  let gm = null, pl = null;
  const made = { boxes: [], worldItems: [] };
  try {
    pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");

    // 0. The pool, the two games and the gold.
    out.seed = await gm.page.evaluate(async ({ base, pack: packId, poolName, crate, scratch }) => {
      const store = await import(base + "scripts/foundry/store.js");
      const folder = game.folders.find(f => f.type === "Actor" && f.name === "Loot Crates Test");
      const actor = game.actors.find(a => a.name === "Crate Tester" && a.folder?.id === folder?.id);
      if (!actor) throw new Error("no Crate Tester in Loot Crates Test");
      if ((actor.system.currency.gp ?? 0) < 20) await actor.update({ "system.currency.gp": 1000 });
      const pack = game.packs.get(packId);
      if (!pack) throw new Error(`no ${packId} compendium in this world`);
      const index = await pack.getIndex({ fields: ["system.rarity", "type"] });
      // Any item a pool takes (not a consumable, so it is never taken for a
      // ticket), tagged common in the pool.
      const hit = index.find(e => store.isLootType(e.type) && e.type !== "consumable");
      if (!hit) throw new Error(`${packId} holds no loot-type item`);
      const entry = store.entryFromItem(await fromUuid(hit.uuid), hit.uuid);
      const old = Object.values(store.getPools()).find(p => p.name === poolName);
      const pool = await store.savePool({ ...(old ? { id: old.id } : {}), name: poolName, entries: [{ ...entry, rarity: "common" }], pools: [] });
      const c = await store.saveBox({ name: crate, price: 5, pools: [{ id: pool.id, share: 1 }], weights: { common: 1 }, rules: {} });
      const s = await store.saveBox({ kind: "scratch", name: scratch, price: 1, pools: [{ id: pool.id, share: 1 }], weights: {}, layout: "lucky", grid: { cols: 4, rows: 3 }, bonus: { on: false, gp: 0 }, theme: "hoard", roll: { id: 1, size: 20, prizes: [{ count: 5, parts: [{ gp: 1 }] }] }, rules: {} });
      return { poolId: pool.id, item: entry.name, crateId: c.id, scratchId: s.id };
    }, { base: MODULE_BASE, pack: PACK, poolName: POOL, crate: CRATE, scratch: SCRATCH });
    const { crateId, scratchId } = out.seed;
    made.boxes.push(crateId, scratchId);

    // 1. Make a ticket on each row, the real buttons.
    await gm.page.evaluate(async ({ base, helpers }) => {
      (0, eval)(helpers);
      const { openManager } = await import(base + "scripts/foundry/manager.js");
      __lc.app = openManager();
      await __lc.until(() => __lc.app.element?.querySelector('.lc-tabs [data-tab="boxes"]'));
      __lc.click(__lc.app.element.querySelector('.lc-tabs [data-tab="boxes"]'));
      await __lc.until(() => __lc.app.tab === "boxes" && __lc.app.element.querySelector('[data-action="makeTicket"]'), 8000);
    }, { base: MODULE_BASE, helpers: HELPERS });
    const ticketsOf = boxId => gm.page.evaluate(({ boxId }) => game.items.filter(i => i.flags?.["loot-crates"]?.ticket?.boxId === boxId).map(i => ({ id: i.id, name: i.name, type: i.type, folder: i.folder?.name ?? null, folderFlag: !!i.folder?.flags?.["loot-crates"]?.tickets, activity: i.system.activities?.contents?.map(a => `${a.type}:${a.name}`) ?? [], value: i.system.price?.value })), { boxId });
    out.make = {};
    for (const [key, boxId] of [["scratch", scratchId], ["crate", crateId]]) {
      await gm.page.locator(`#loot-crates-manager [data-action="makeTicket"][data-box="${boxId}"]`).click();
      await gm.page.waitForFunction(id => game.items.some(i => i.flags?.["loot-crates"]?.ticket?.boxId === id), boxId, { timeout: 8000 });
      await gm.page.waitForTimeout(200);
      const items = await ticketsOf(boxId);
      made.worldItems.push(...items.map(i => i.id));
      out.make[key] = { items, status: await gm.page.evaluate(() => __lc.status()), label: await gm.page.locator(`#loot-crates-manager [data-action="makeTicket"][data-box="${boxId}"]`).getAttribute("aria-label") };
    }

    // 2. The GM gives Crate Tester two crate tickets and one scratch ticket.
    out.given = await gm.page.evaluate(async ({ crateItem, scratchItem }) => {
      const actor = game.actors.find(a => a.name === "Crate Tester" && a.folder?.name === "Loot Crates Test");
      const data = (id, qty) => { const d = game.items.get(id).toObject(); delete d._id; delete d.folder; d.system.quantity = qty; return d; };
      const [c, s] = await actor.createEmbeddedDocuments("Item", [data(crateItem, 2), data(scratchItem, 1)]);
      return { crateTicket: c.id, scratchTicket: s.id, crateQty: c.system.quantity, scratchQty: s.system.quantity };
    }, { crateItem: out.make.crate.items[0]?.id, scratchItem: out.make.scratch.items[0]?.id });
    const { crateTicket, scratchTicket } = out.given;

    // 3. The player presses Use on the crate ticket.
    const before = await readActor(gm.page, crateTicket);
    const chatBefore = await gm.page.evaluate(() => game.messages.contents.length);
    await pressUse(pl.page, crateTicket);
    await pl.page.waitForSelector(".application.lc-reveal", { timeout: 15000 });
    await gm.page.waitForSelector(".application.lc-reveal", { timeout: 15000 });
    const usedCrate = await untilActor(gm.page, crateTicket, a => a.qty === 1 && a.items.length === before.items.length + 1, 15000);
    await pl.page.waitForSelector(".application.lc-reveal .lc-reveal__result", { timeout: 15000 }).catch(() => {});
    out.crateReveal = { player: await readReveal(pl.page), gm: await readReveal(gm.page) };
    if (shot) await pl.page.screenshot({ path: shot });
    const crateRows = await untilRows(gm.page, crateId);
    const chatAfter = await gm.page.evaluate(n => game.messages.contents.slice(n).map(m => ({ lc: !!m.flags?.["loot-crates"], dnd5e: !!m.flags?.dnd5e || m.type === "usage" || m.type === "item", text: m.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) })), chatBefore);
    out.useCrate = { before: { purseCp: before.purseCp, qty: before.qty }, after: { purseCp: usedCrate.purseCp, qty: usedCrate.qty, ms: usedCrate.ms }, rows: crateRows, chat: chatAfter };
    const prizeId = crateRows[0]?.itemId ?? null;
    await pl.page.evaluate(() => __lc?.closeReveals?.()).catch(() => {});
    await gm.page.evaluate(() => __lc.closeReveals());

    // 4. The GM refunds that row from the Pull log: Refund, Yes.
    out.refund = await gm.page.evaluate(async ({ base, rowId }) => {
      const store = await import(base + "scripts/foundry/store.js");
      __lc.click(__lc.app.element.querySelector('.lc-tabs [data-tab="log"]'));
      const btn = () => __lc.app.element?.querySelector(`button[data-action=refund][data-row="${rowId}"]`);
      if (!await __lc.until(() => __lc.app.tab === "log" && btn(), 8000)) throw new Error("the Pull log has no Refund for the ticket's row");
      const cell = btn().closest("tr")?.querySelector('td[data-label="Box"]')?.textContent.trim() ?? null;
      __lc.click(btn());
      const dialog = () => [...document.querySelectorAll(".application.dialog")].pop();
      const yes = () => [...(dialog()?.querySelectorAll("button") ?? [])].find(b => /yes/i.test(b.dataset.action ?? b.textContent));
      await __lc.until(() => yes());
      const ask = dialog()?.querySelector(".window-content")?.textContent.replace(/\s+/g, " ").trim() ?? null;
      const chatN = game.messages.contents.length;
      __lc.click(yes());
      await __lc.until(() => store.getLog().find(r => r.id === rowId)?.refunded, 8000);
      await __lc.until(() => game.messages.contents.length > chatN, 5000);
      const card = game.messages.contents.slice(chatN).map(m => m.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).join(" | ");
      return { cell, ask, card, refunded: !!store.getLog().find(r => r.id === rowId)?.refunded };
    }, { base: MODULE_BASE, rowId: crateRows[0]?.id });
    out.afterRefund = await untilActor(gm.page, crateTicket, a => a.qty === 2 && !a.items.includes(prizeId), 10000);

    // 5. The player uses the scratch ticket and scratches it by hand.
    const sBefore = await readActor(gm.page, scratchTicket);
    await pressUse(pl.page, scratchTicket);
    const reveal = pl.page.locator(".application.lc-reveal").last();
    await reveal.locator(".lc-scratch__ticket [data-panel]").first().waitFor({ timeout: 15000 });
    await gm.page.waitForSelector(".application.lc-reveal", { timeout: 15000 });
    out.scratchHead = (await readReveal(pl.page))?.price ?? null;
    const count = await reveal.locator(".lc-scratch__ticket [data-panel]").count();
    out.strokes = [];
    for (let i = 0; i < count; i++) {
      const panel = reveal.locator(".lc-scratch__ticket [data-panel]").nth(i);
      await panel.scrollIntoViewIfNeeded();
      let tries = 0, opened = await panel.evaluate(p => p.classList.contains("lc-scratch__panel--open"));
      while (!opened && tries < 4) {
        tries++;
        const r = await panel.boundingBox();
        const rows = Math.max(2, Math.ceil(r.height / 20));
        await pl.page.mouse.move(r.x + 3, r.y + r.height / (2 * rows));
        await pl.page.mouse.down();
        for (let k = 0; k < rows; k++) await pl.page.mouse.move(k % 2 ? r.x + 3 : r.x + r.width - 3, r.y + r.height * ((k + 0.5) / rows), { steps: Math.max(4, Math.round(r.width / 12)) });
        await pl.page.mouse.up();
        opened = await panel.evaluate(p => new Promise(res => {
          const t = performance.now();
          const look = () => (p.classList.contains("lc-scratch__panel--open") ? res(true) : performance.now() - t > 1200 ? res(false) : requestAnimationFrame(look));
          look();
        }));
      }
      out.strokes.push({ i, tries, opened });
      if (!opened) break;
    }
    await reveal.locator(".lc-scratch--landed").waitFor({ timeout: 8000 }).catch(() => {});
    out.scratchLanded = await reveal.evaluate(rv => ({ landed: !!rv.querySelector(".lc-scratch--landed"), result: rv.querySelector(".lc-reveal__result")?.innerText.replace(/\s+/g, " ").trim() ?? null }));
    const sAfter = await untilActor(gm.page, scratchTicket, a => a.qty === null, 10000);
    const scratchRows = await untilRows(gm.page, scratchId);
    out.useScratch = { before: { qty: sBefore.qty, purseCp: sBefore.purseCp }, after: { qty: sAfter.qty, purseCp: sAfter.purseCp, ms: sAfter.ms }, rows: scratchRows };

    const cRow = crateRows[0];
    const sRow = scratchRows[0];
    out.checks = {
      madeScratch: out.make.scratch.items.length === 1 && out.make.scratch.items[0].type === "consumable" && out.make.scratch.items[0].folder != null && out.make.scratch.items[0].folderFlag && out.make.scratch.items[0].activity.join() === "utility:Scratch"
        && out.make.scratch.label === `Make a ticket for ${SCRATCH}` && out.make.scratch.status === `A ${SCRATCH} ticket is in the Items sidebar, in the folder ${out.make.scratch.items[0].folder}. Drag it onto a character's sheet, a loot sheet or a pool.`,
      madeCrate: out.make.crate.items.length === 1 && out.make.crate.items[0].activity.join() === "utility:Open" && out.make.crate.items[0].value === 5 && /^A Live ticket crate .+ ticket is in the Items sidebar/.test(out.make.crate.status ?? ""),
      given: out.given.crateQty === 2 && out.given.scratchQty === 1,
      revealBoth: !!out.crateReveal.player && !!out.crateReveal.gm && out.crateReveal.player.price === "with a ticket" && out.crateReveal.gm.price === "with a ticket",
      spentOne: out.useCrate.before.qty === 2 && out.useCrate.after.qty === 1 && out.useCrate.after.ms != null,
      noCoins: out.useCrate.after.purseCp === out.useCrate.before.purseCp,
      crateRow: cRow?.price === 0 && cRow?.redeem?.itemId === crateTicket && cRow?.redeem?.paid === 0 && !!cRow?.itemId,
      noDnd5eCard: out.useCrate.chat.every(m => m.lc),
      refunded: out.refund.refunded && /\(ticket\)/.test(out.refund.cell ?? "") && /ticket back/.test(out.refund.ask ?? "") && /ticket went back into their pack/.test(out.refund.card ?? "")
        && out.afterRefund.ms != null && out.afterRefund.qty === 2 && !out.afterRefund.items.includes(prizeId) && out.afterRefund.purseCp === out.useCrate.before.purseCp,
      scratchedByHand: out.scratchHead === "with a ticket" && out.strokes.length > 0 && out.strokes.every(s => s.opened) && out.scratchLanded.landed,
      scratchSpent: out.useScratch.before.qty === 1 && out.useScratch.after.qty === null && sRow?.redeem?.itemId === scratchTicket && sRow?.price === 0,
    };
    out.ok = Object.values(out.checks).every(Boolean);
    out.gmConsole = gm.logs.filter(l => !l.includes("timings"));
    out.playerLog = pl.logs;
  } catch (err) {
    out.error = String(err?.stack || err);
    out.ok = false;
  } finally {
    // Every row this run made refunded, every ticket for its games off
    // Crate Tester, the world tickets it made and the two games deleted.
    try {
      out.restored = gm && made.boxes.length ? await gm.page.evaluate(async ({ base, boxes, worldItems }) => {
        const store = await import(base + "scripts/foundry/store.js");
        const { refundPull } = await import(base + "scripts/foundry/refund.js");
        const refunded = [];
        for (const r of store.getLog().filter(x => boxes.includes(x.boxId) && !x.refunded)) refunded.push((await refundPull(r.id)).status);
        const actor = game.actors.find(a => a.name === "Crate Tester" && a.folder?.name === "Loot Crates Test");
        const tickets = actor.items.filter(i => boxes.includes(i.flags?.["loot-crates"]?.ticket?.boxId)).map(i => i.id);
        if (tickets.length) await actor.deleteEmbeddedDocuments("Item", tickets);
        const world = worldItems.filter(id => game.items.get(id));
        if (world.length) await Item.deleteDocuments(world);
        for (const id of boxes) await store.removeBox(id);
        try { await globalThis.__lc?.app?.close(); } catch { /* closed */ }
        __lc.closeReveals?.();
        return { refunded, tickets: tickets.length, world: world.length, gone: boxes.every(id => !store.getBoxes()[id]), left: actor.items.filter(i => boxes.includes(i.flags?.["loot-crates"]?.ticket?.boxId)).length + worldItems.filter(id => game.items.get(id)).length };
      }, { base: MODULE_BASE, boxes: made.boxes, worldItems: made.worldItems }) : null;
    } catch (err) { out.restored = { error: String(err) }; out.ok = false; }
    if (out.restored && (out.restored.error || !out.restored.gone || out.restored.left || out.restored.refunded.some(s => s !== "refunded"))) out.ok = false;
    try { await pl?.page.evaluate(() => { for (const a of [...foundry.applications.instances.values()]) if (/loot-crates/.test(a.id) || a.element?.classList.contains("lc-reveal") || a.document?.name === "Crate Tester") a.close(); }); } catch { /* closing */ }
    console.log(JSON.stringify(out, (k, v) => (k === "items" && Array.isArray(v) && typeof v[0] === "string" ? v.length : v), 1));
    if (!out.ok) process.exitCode = 1;
    await browser.close();
  }
})();
