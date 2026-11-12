// Live check: a scratch ticket that wins an item its pools can't give
// (VIB-221) at a real table, with the branch's code on both ends: the roll
// sells, the ticket is won and the item owed, the GM hands it over from
// the Pull log, and the one refund takes it back.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ //     NODE_PATH=$(npm root -g) node foundry-dev/checks/live-owed.cjs [--shot out.png]
//
// Env: PLAYER (default Player2, must own Crate Tester).
//
// Two headless clients, the Gamemaster and the player, each running the
// branch's socket, redraw and shop code (as live-scratch-roll.cjs does).
//
//   1. The GM's store gains a scratch ticket at 1 gp, a roll of one ticket
//      that wins a Rare item, using a pool that holds only a common item;
//      a second pool the game doesn't use holds a rare one. (Written
//      through the store: the editor would keep such a game off the shelf,
//      and this is the state a pool edited later leaves.) Its row on the
//      Boxes tab says "a prize would be owed".
//   2. The player's card has its Buy on; the player buys the ticket and
//      opens it with Reveal all. The window names the prize "Rare item"
//      and says "Owed by the GM: Rare item", with no "Added to", no Open
//      item and nothing to sell or give; 1 gp was charged.
//   3. On the GM the row owes a rare item and names no item, nothing is on
//      the sheet, a notice says to hand it over from the Pull log, and the
//      chat card says "Owed by the GM: Rare item" with no link.
//   4. The GM opens the Pull log, presses Hand over on the row, picks the
//      rare item in the dialog and presses Hand over: the item is on the
//      sheet with this game's flag, the row names it and owes nothing, the
//      log says "Handed over by the GM", the button is gone, and the chat
//      card says "The GM handed over ...".
//   5. The GM refunds the row: the item is removed and the 1 gp returned.
//
// Restored in a finally: the ticket refunded if it wasn't, the game and
// the two pools this run made deleted, the shop's open state put back.
// Needs "Crate Tester" in "Loot Crates Test" and a compendium of items.
/* global game, Hooks, foundry, __lc */
const { chromium } = require("playwright");
// A Buy over half the purse asks first; pressSpend presses it again then.
const { pressSpend } = require("./lib/spend.cjs");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const shot = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : null;
const STAMP = Date.now().toString(36);
const NAME = `Live owed ${STAMP}`;

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
    // choice, which a row of prize lines (scratch.js) no longer has.
    for (const sheet of [...document.styleSheets]) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (let i = rules.length - 1; i >= 0; i--) if (rules[i] instanceof CSSImportRule && /modules\/loot-crates\//.test(rules[i].href)) sheet.deleteRule(i);
    }
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

// The player's card for the game, read from the shop as it stands.
const readCard = (pl, boxId) => pl.evaluate(async ({ base, boxId }) => {
  const { getLog } = await import(base + "scripts/foundry/store.js");
  const { toCopper } = await import(base + "scripts/core/currency.js");
  const actor = game.actors.find(a => a.isOwner && a.type === "character" && a.name === "Crate Tester");
  const card = document.querySelector(`#loot-crates-shop .lc-box[data-box="${boxId}"]`);
  const buy = card?.querySelector(".lc-box__buy");
  return {
    shown: !!card, stock: card?.querySelector(".lc-box__stock")?.textContent.trim() ?? null, why: card?.querySelector(".lc-box__why")?.textContent.trim() ?? "",
    buy: buy?.textContent.replace(/\s+/g, " ").trim() ?? null, off: buy?.getAttribute("aria-disabled") === "true",
    rows: getLog().filter(r => r.boxId === boxId).length, purseCp: toCopper(actor.system.currency),
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
  let gm = null, pl = null, boxId = null, poolIds = [], shopOpen = true;
  try {
    pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");

    // 1. The game on the shelf, its own pool with no rare item; the rare
    //    item in a pool the game doesn't use.
    const made = await gm.page.evaluate(async ({ base, name, helpers }) => {
      (0, eval)(helpers);
      const store = await import(base + "scripts/foundry/store.js");
      const { NEW_DEFAULTS } = await import(base + "scripts/views/newgame.js");
      const folder = game.folders.find(f => f.type === "Actor" && f.name === "Loot Crates Test");
      const actor = game.actors.find(a => a.name === "Crate Tester" && a.folder?.id === folder?.id);
      if (!actor) throw new Error("no Crate Tester in Loot Crates Test");
      if ((actor.system.currency.gp ?? 0) < 20) await actor.update({ "system.currency.gp": 1000 });
      const open = store.isShopOpen();
      if (!open) await store.setShopOpen(true);
      // Two real items to point pool entries at.
      const pack = game.packs.get("dnd5e.items") ?? game.packs.find(p => p.documentName === "Item");
      const index = [...(await pack.getIndex())].filter(e => e.type !== "container" && e.type !== "backpack").slice(0, 2);
      if (index.length < 2) throw new Error("no two items in a compendium to point the pools at");
      const entry = (e, rarity) => ({ uuid: `Compendium.${pack.collection}.Item.${e._id}`, name: e.name, img: e.img, rarity, rarityOverride: rarity, weight: 1 });
      const own = `lo-own-${Date.now().toString(36)}`, stash = `lo-stash-${Date.now().toString(36)}`;
      await store.savePool({ id: own, name: `${name} pool`, entries: [entry(index[0], "common")], pools: [] });
      await store.savePool({ id: stash, name: `${name} stash`, entries: [entry(index[1], "rare")], pools: [] });
      const id = `lo-${Date.now().toString(36)}`;
      await store.saveBox({ ...NEW_DEFAULTS.scratch(), id, name, price: 1, pools: [{ id: own, share: 1 }], bonus: { on: false, gp: 0 }, roll: { id: 1, size: 1, prizes: [{ count: 1, parts: [{ item: { rarity: "rare" } }] }] } });
      const { openManager } = await import(base + "scripts/foundry/manager.js");
      __lc.app = openManager();
      await __lc.until(() => __lc.app.element?.querySelector('.lc-tabs [data-tab="boxes"]'));
      __lc.click(__lc.app.element.querySelector('.lc-tabs [data-tab="boxes"]'));
      await __lc.until(() => __lc.app.tab === "boxes" && __lc.app.element.querySelector(`[data-box="${id}"]`), 8000);
      const rowText = [...__lc.app.element.querySelectorAll("tr")].find(tr => tr.querySelector(`[data-box="${id}"]`))?.textContent.replace(/\s+/g, " ") ?? "";
      return { id, own, stash, open, rare: { uuid: entry(index[1], "rare").uuid, name: index[1].name }, actorId: actor.id, items: actor.items.size, rowText };
    }, { base: MODULE_BASE, name: NAME, helpers: HELPERS });
    boxId = made.id; poolIds = [made.own, made.stash]; shopOpen = made.open;
    out.made = made;

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

    // 2. The Buy is on (the roll doesn't stall); the one ticket is won.
    out.start = await untilCard(pl.page, boxId, c => c.shown && c.stock === "1 of 1 ticket left");
    await pressSpend(pl.page.locator(`#loot-crates-shop .lc-box__buy[data-box="${boxId}"]`));
    await pl.page.locator(".application.lc-reveal .lc-scratch__all").last().click({ timeout: 15000 });
    await pl.page.waitForSelector(".application.lc-reveal .lc-scratch--landed", { timeout: 15000 }).catch(() => {});
    out.after = await untilCard(pl.page, boxId, c => c.rows === 1, 15000);
    await pl.page.waitForFunction(() => /Owed by the GM/.test([...document.querySelectorAll(".application.lc-reveal")].pop()?.querySelector(".lc-reveal__result")?.textContent ?? ""), null, { timeout: 15000 }).catch(() => {});
    out.reveal = await pl.page.evaluate(() => {
      const rv = [...document.querySelectorAll(".application.lc-reveal")].pop();
      const open = rv?.querySelector(".lc-reveal__open");
      return {
        result: rv?.querySelector(".lc-reveal__result")?.innerText.replace(/\s+/g, " ").trim() ?? null,
        openItem: !!open && !open.hidden && open.getBoundingClientRect().height > 0,
        winPanels: [...(rv?.querySelectorAll(".lc-scratch__panel--win") ?? [])].map(p => p.textContent.replace(/\s+/g, " ").trim()),
        after: !!rv?.querySelector(".lc-after:not([hidden]) button"),
      };
    });
    if (shot) await pl.page.screenshot({ path: shot });
    await pl.page.evaluate(() => __lc.closeReveals());

    // 3. On the GM: the row owes it, nothing was made, the GM was told, and
    //    the chat card says so.
    out.owed = await gm.page.evaluate(async ({ base, boxId, actorId }) => {
      const store = await import(base + "scripts/foundry/store.js");
      await __lc.until(() => store.getLog().some(r => r.boxId === boxId), 8000);
      const row = store.getLog().find(r => r.boxId === boxId);
      const card = () => game.messages.contents.find(m => m.flags?.["loot-crates"]?.logId === row.id);
      await __lc.until(() => card(), 15000);
      __lc.closeReveals();
      const notes = [...document.querySelectorAll("#notifications .notification, #notifications li")].map(n => n.textContent.replace(/\s+/g, " ").trim());
      return { id: row.id, name: row.name, rarity: row.rarity, owed: row.owed, itemId: row.itemId ?? null, uuid: row.uuid ?? null, price: row.price, items: game.actors.get(actorId).items.size, card: card()?.content ?? null, notice: notes.find(n => /Hand it over from the Pull log/.test(n)) ?? null };
    }, { base: MODULE_BASE, boxId, actorId: made.actorId });

    // 4. Hand over from the Pull log: the button, the dialog's picker, Hand over.
    await gm.page.evaluate(async rowId => {
      __lc.click(__lc.app.element.querySelector('.lc-tabs [data-tab="log"]'));
      const btn = () => __lc.app.element?.querySelector(`button[data-action="handOver"][data-row="${rowId}"]`);
      if (!await __lc.until(() => __lc.app.tab === "log" && btn(), 8000)) throw new Error("the Pull log has no Hand over for the row");
      __lc.note = __lc.app.element.querySelector(".lc-log__owed")?.textContent.trim() ?? null;
      __lc.label = btn().getAttribute("aria-label");
      __lc.click(btn());
    }, out.owed.id);
    const dlg = gm.page.locator(".application.lc-dialog").last();
    await dlg.locator('select[name="pick"]').waitFor({ timeout: 8000 });
    out.dialog = { text: (await dlg.locator(".window-content").innerText()).replace(/\s+/g, " ").trim(), options: await dlg.locator('select[name="pick"] option').allTextContents() };
    await dlg.locator('select[name="pick"]').selectOption(made.rare.uuid);
    await dlg.locator('button[data-action="give"]').click();
    out.handed = await gm.page.evaluate(async ({ base, rowId, actorId }) => {
      const store = await import(base + "scripts/foundry/store.js");
      const row = () => store.getLog().find(r => r.id === rowId);
      await __lc.until(() => row()?.handed?.length, 10000);
      await __lc.until(() => !__lc.app.element?.querySelector(`button[data-action="handOver"][data-row="${rowId}"]`), 5000);
      const actor = game.actors.get(actorId);
      const item = actor.items.get(row().itemId);
      const card = game.messages.contents.find(m => m.flags?.["loot-crates"]?.logId === rowId);
      return {
        note: __lc.note, label: __lc.label, row: { name: row().name, owed: row().owed, handed: row().handed, itemId: row().itemId, itemIds: row().itemIds, uuid: row().uuid },
        item: item ? { name: item.name, flag: item.flags?.["loot-crates"] ?? null } : null, items: actor.items.size,
        card: card?.content ?? null, button: !!__lc.app.element?.querySelector(`button[data-action="handOver"][data-row="${rowId}"]`),
        logNote: [...(__lc.app.element?.querySelectorAll(".lc-log__parted") ?? [])].map(n => n.textContent.trim()),
      };
    }, { base: MODULE_BASE, rowId: out.owed.id, actorId: made.actorId });

    // 5. The one refund takes the handed item back with the price.
    out.refund = await gm.page.evaluate(async ({ base, rowId, actorId }) => {
      const { refundPull } = await import(base + "scripts/foundry/refund.js");
      const { toCopper } = await import(base + "scripts/core/currency.js");
      const res = await refundPull(rowId);
      const actor = game.actors.get(actorId);
      return { status: res.status, removed: res.removedItem ?? null, items: actor.items.size, purseCp: toCopper(actor.system.currency) };
    }, { base: MODULE_BASE, rowId: out.owed.id, actorId: made.actorId });

    out.checks = {
      rowWarns: /a prize would be owed: its pools hold no item for it/.test(made.rowText),
      sells: out.start.ms != null && !out.start.off && out.start.why === "",
      won: /Rare item/.test(out.reveal.result ?? "") && /Owed by the GM: Rare item/.test(out.reveal.result ?? "") && !/Added to/.test(out.reveal.result ?? ""),
      noItemYet: !out.reveal.openItem && !out.reveal.after && out.owed.items === made.items && out.owed.itemId === null && out.owed.uuid === null,
      panel: out.reveal.winPanels.some(t => /Rare item/.test(t)),
      charged: out.start.purseCp - out.after.purseCp === 100,
      row: out.owed.name === "Rare item" && out.owed.rarity === "rare" && JSON.stringify(out.owed.owed) === JSON.stringify([{ rarity: "rare" }]),
      gmTold: /won Rare item at .* which its pools can't give\. Hand it over from the Pull log\./.test(out.owed.notice ?? ""),
      chatOwed: /lc-chat__owed">Owed by the GM: Rare item</.test(out.owed.card ?? "") && !/data-uuid="Actor\./.test(out.owed.card ?? ""),
      logRow: out.handed.note === "Owed: Rare item" && out.handed.label === "Hand over to Crate Tester. Owed: Rare item",
      dialog: /Crate Tester won Rare item at/.test(out.dialog.text) && out.dialog.options.length >= 1 && out.dialog.options.some(o => o.startsWith(made.rare.name)),
      handed: out.handed.item?.name === made.rare.name && out.handed.item.flag?.sourceUuid === made.rare.uuid && out.handed.item.flag?.boxId === boxId && out.handed.items === made.items + 1,
      rowAfter: out.handed.row.name === made.rare.name && out.handed.row.owed.length === 0 && out.handed.row.uuid === made.rare.uuid && out.handed.row.itemIds?.length === 1 && out.handed.row.handed[0]?.name === made.rare.name && !out.handed.button,
      logAfter: out.handed.logNote.includes(`Handed over by the GM: ${made.rare.name}`),
      chatHanded: (out.handed.card ?? "").includes(`lc-chat__owed">The GM handed over ${made.rare.name}.<`),
      refund: out.refund.status === "refunded" && out.refund.removed === made.rare.name && out.refund.items === made.items && out.refund.purseCp === out.start.purseCp,
    };
    out.ok = Object.values(out.checks).every(Boolean);
    out.gmConsole = gm.logs.filter(l => !l.includes("timings"));
    out.playerLog = pl.logs;
  } catch (err) {
    out.error = String(err?.stack || err);
    out.ok = false;
  } finally {
    // The ticket refunded if it wasn't, the game and both pools deleted, the shop as it was.
    try {
      out.restored = gm && boxId ? await gm.page.evaluate(async ({ base, boxId, poolIds, shopOpen }) => {
        const store = await import(base + "scripts/foundry/store.js");
        const { refundPull } = await import(base + "scripts/foundry/refund.js");
        const refunded = [];
        for (const r of store.getLog().filter(x => x.boxId === boxId && !x.refunded)) { const res = await refundPull(r.id); refunded.push(res.status); }
        await store.removeBox(boxId);
        for (const id of poolIds) await store.deletePool(id);
        if (!shopOpen) await store.setShopOpen(false);
        try { await globalThis.__lc?.app?.close(); } catch { /* closed */ }
        globalThis.__lc?.closeReveals?.();
        for (const n of [...(globalThis.ui?.notifications?.active ?? [])]) { try { globalThis.ui.notifications.remove?.(n); } catch { /* gone */ } }
        return { refunded, gone: !store.getBoxes()[boxId], pools: poolIds.filter(id => store.getPools()[id]).length, open: store.isShopOpen() };
      }, { base: MODULE_BASE, boxId, poolIds, shopOpen }) : null;
    } catch (err) { out.restored = { error: String(err) }; out.ok = false; }
    if (out.restored && (out.restored.error || !out.restored.gone || out.restored.pools || out.restored.refunded.some(s => s !== "refunded"))) out.ok = false;
    try { await pl?.page.evaluate(() => { for (const a of [...foundry.applications.instances.values()]) if (/loot-crates/.test(a.id) || a.element?.classList.contains("lc-reveal")) a.close(); }); } catch { /* closing */ }
    console.log(JSON.stringify(out, null, 1));
    if (!out.ok) process.exitCode = 1;
    await browser.close();
  }
})();
