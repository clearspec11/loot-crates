// Live check: the Pull log's 500-row trim changes no rule (core/tally.js,
// VIB-213), at a real table with the branch's code on both ends.
//
//   npm run live -- live-log-cap [--shot out.png]
//
// Env: PLAYER (default Player2, must own Crate Tester).
//
// Two headless clients, the Gamemaster and the player, each running the
// branch's socket code (as live-limits.cjs does). The GM notes the Pull
// log and the actorState setting (the pity state and the tallies) to put
// back, then seeds:
//   - "Live log-cap crate", 1 gp from "Live UI pool", one per character in
//     all (one more than any purchase Crate Tester still has counted, so
//     the limit is always one away);
//   - "Live log-cap ticket", a scratch ticket of 5 (one 1 gp prize, four
//     duds) with one ticket already sold, written through the store as a
//     pull writes it (its tier kept off the row).
// Then, as a person does:
//
//   1. The player opens the shop on Crate Tester: the crate reads "You can
//      buy 1 more", the ticket "4 of 5 tickets left". The player presses the
//      crate's Buy once and closes the reveal: the card reads "Limit
//      reached: 1 of 1 for Crate Tester" with its Buy off.
//   2. The GM pads the log past 500 with synthetic rows (newer than the
//      purchase) and writes one more row through the store, whose trim
//      keeps 500: the purchase's row and the sold ticket's row are gone
//      from the log.
//   3. The player's crate still reads "Limit reached" with its Buy off; a
//      press on it sends nothing, and a Buy sent anyway (the shop's own
//      requestPull) is refused by the GM with the limit's sentence:
//      nothing charged, no item, no row. The ticket still reads "4 of 5
//      tickets left".
//
// Restored in a finally: the purchase's row is put back and refunded
// through the real refund (the 1 gp back, the item it granted taken off
// the sheet), then the Pull log and the actorState setting are set back
// to what they were, and a crate or ticket record that existed before is
// put back (new ones are left seeded). One real 1 gp purchase, refunded.
// Needs "Crate Tester" in "Loot Crates Test" and "Live UI pool" (live-ui.js).
/* global game, Hooks */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const CRATE = "Live log-cap crate";
const TICKET = "Live log-cap ticket";
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
    registerShopHooks?.(Hooks);
    const { sealChatCard, watchAgain, preSealItem } = await import(base + "scripts/foundry/reveal.js");
    Hooks.on("renderChatMessageHTML", sealChatCard);
    Hooks.on("renderChatMessageHTML", watchAgain);
    for (const h of [...(Hooks.events?.createItem ?? [])]) if (h.fn?.name === "preSealItem") Hooks.off("createItem", h.id);
    Hooks.on("createItem", preSealItem);
  }, MODULE_BASE);
  return { page, logs };
}

// The GM's side: note what is to be put back, then seed the two games.
async function seed(gm) {
  return gm.evaluate(async ({ base, crate, ticket }) => {
    const store = await import(base + "scripts/foundry/store.js");
    const { boughtBy } = await import(base + "scripts/core/limits.js");
    const { toCopper } = await import(base + "scripts/core/currency.js");
    const folder = game.folders.find(f => f.type === "Actor" && f.name === "Loot Crates Test");
    const actor = game.actors.find(a => a.name === "Crate Tester" && a.folder?.id === folder?.id);
    if (!actor) throw new Error("no Crate Tester in Loot Crates Test: run live-pull.js first");
    if ((actor.system.currency.gp ?? 0) < 5) await actor.update({ "system.currency.gp": 1000 });
    const pool = Object.values(store.getPools()).find(p => p.name === "Live UI pool");
    if (!pool) throw new Error("no Live UI pool: run live-ui.js first");
    // Exactly as stored, to set back in the finally.
    const saved = {
      log: structuredClone(game.settings.get("loot-crates", "pullLog")),
      state: structuredClone(game.settings.get("loot-crates", "actorState")),
    };
    const boxes = Object.values(store.getBoxes());
    const oldCrate = boxes.find(b => b.name === crate) ?? null;
    const oldTicket = boxes.find(b => b.name === ticket) ?? null;
    const already = oldCrate ? boughtBy(store.getTally(), { boxId: oldCrate.id, actorId: actor.id }) : 0;
    const crateBox = await store.createBox({
      ...(oldCrate ? { id: oldCrate.id } : {}), name: crate, price: 1, pools: [{ id: pool.id, share: 1 }],
      weights: { common: 1, uncommon: 1, rare: 1, veryRare: 1, legendary: 1 },
      rules: { pity: null, noDuplicates: false, perCharacter: { max: already + 1, per: "ever" } },
    });
    // A roll id no earlier run has counted, so the roll starts whole.
    const rollId = Math.max(1, Number(oldTicket?.roll?.id) || 0) + 1;
    const ticketBox = await store.createBox({
      ...(oldTicket ? { id: oldTicket.id } : {}), kind: "scratch", name: ticket, price: 1, pools: [{ id: pool.id, share: 1 }], weights: {},
      layout: "lucky", grid: { cols: 4, rows: 3 }, bonus: { on: false, gp: 0 }, theme: "hoard", showLeft: true,
      roll: { id: rollId, size: 5, prizes: [{ count: 1, parts: [{ gp: 1 }] }] }, rules: {},
    });
    // One ticket already sold, as a pull writes it: the row, its tier off the row.
    const soldId = await store.enqueueWrite(() => store.appendLog(
      { kind: "scratch", boxId: ticketBox.id, boxName: ticket, actorId: actor.id, actorName: actor.name, userId: game.user.id, itemId: null, price: 1, payoutCp: 0, rollId, outcome: "nothing", swatch: "none", name: "A dud" },
      { hidden: { tier: "dud", ticketNo: 1, winners: [] } },
    ));
    const items = actor.items.filter(i => !i.flags?.dnd5e?.cachedFor).map(i => i.id);
    return { actorId: actor.id, crateId: crateBox.id, ticketId: ticketBox.id, oldCrate, oldTicket, max: already + 1, soldId, purseCp: toCopper(actor.system.currency), items, rows: saved.log.length, saved };
  }, { base: MODULE_BASE, crate: CRATE, ticket: TICKET });
}

// The player's two cards, as a person reads them.
const readCards = (pl, before) => pl.evaluate(async ({ base, before }) => {
  const { toCopper } = await import(base + "scripts/core/currency.js");
  const actor = game.actors.get(before.actorId);
  const read = id => {
    const card = document.querySelector(`#loot-crates-shop .lc-box[data-box="${id}"]`);
    const buy = card?.querySelector(".lc-box__buy");
    return {
      shown: !!card, stock: card?.querySelector(".lc-box__stock")?.textContent.trim() ?? "", limit: card?.querySelector(".lc-box__limit")?.textContent.trim() ?? "",
      why: card?.querySelector(".lc-box__why")?.textContent.trim() ?? "", off: buy?.getAttribute("aria-disabled") === "true",
    };
  };
  return { crate: read(before.crateId), ticket: read(before.ticketId), purseCp: toCopper(actor.system.currency), items: actor.items.filter(i => !i.flags?.dnd5e?.cachedFor).length };
}, { base: MODULE_BASE, before });

const until = async (pl, before, pred, ms = 6000) => {
  const t0 = Date.now();
  let c = await readCards(pl, before);
  while (!pred(c) && Date.now() - t0 < ms) { await pl.waitForTimeout(100); c = await readCards(pl, before); }
  return { ...c, ms: pred(c) ? Date.now() - t0 : null };
};

async function restore(gm, before, purchaseRow) {
  if (!gm || !before) return null;
  return gm.evaluate(async ({ base, before, purchaseRow, crate, ticket }) => {
    const out = {};
    try {
      const store = await import(base + "scripts/foundry/store.js");
      const { refundPull } = await import(base + "scripts/foundry/refund.js");
      const { toCopper } = await import(base + "scripts/core/currency.js");
      // The purchase back on the log for its refund, which takes the coins
      // and the item back as a GM's Refund does.
      if (purchaseRow && !purchaseRow.refunded) {
        if (!store.getLog().some(r => r.id === purchaseRow.id)) await game.settings.set("loot-crates", "pullLog", [purchaseRow, ...game.settings.get("loot-crates", "pullLog")]);
        out.refund = (await refundPull(purchaseRow.id))?.status ?? null;
      }
      await store.enqueueWrite(async () => {
        await game.settings.set("loot-crates", "pullLog", before.saved.log);
        await game.settings.set("loot-crates", "actorState", before.saved.state);
      });
      out.log = game.settings.get("loot-crates", "pullLog").length === before.saved.log.length ? "restored" : "differs";
      out.state = JSON.stringify(game.settings.get("loot-crates", "actorState")) === JSON.stringify(before.saved.state) ? "restored" : "differs";
      if (before.oldCrate) { await store.createBox(before.oldCrate); out.crate = "restored"; } else out.crate = Object.values(store.getBoxes()).some(b => b.name === crate) ? "left seeded (new this run)" : "none";
      if (before.oldTicket) { await store.createBox(before.oldTicket); out.ticket = "restored"; } else out.ticket = Object.values(store.getBoxes()).some(b => b.name === ticket) ? "left seeded (new this run)" : "none";
      const actor = game.actors.get(before.actorId);
      out.purseCp = toCopper(actor.system.currency);
      out.items = actor.items.filter(i => !i.flags?.dnd5e?.cachedFor).length;
    } catch (err) { out.error = String(err?.stack || err); }
    return out;
  }, { base: MODULE_BASE, before, purchaseRow, crate: CRATE, ticket: TICKET });
}

(async () => {
  const browser = await chromium.launch();
  const out = { player: PLAYER };
  let gm = null, before = null, purchaseRow = null;
  try {
    const pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");
    before = await seed(gm.page);
    out.before = { purseCp: before.purseCp, items: before.items.length, max: before.max, rows: before.rows };

    // 1. The shop, and one purchase through the crate's Buy.
    out.open = await pl.page.evaluate(async ({ base, before }) => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const until = async (fn, ms = 15000) => { for (let t = 0; t < ms && !fn(); t += 50) await wait(50); return fn(); };
      const { openShop } = await import(base + "scripts/foundry/shop.js");
      const actor = game.actors.get(before.actorId);
      if (!actor?.isOwner) throw new Error(`${game.user.name} doesn't own Crate Tester`);
      const app = openShop();
      await until(() => app.element?.querySelector(`.lc-box[data-box="${before.crateId}"]`) && app.element?.querySelector(`.lc-box[data-box="${before.ticketId}"]`));
      const pick = app.element.querySelector(".lc-shop__actor");
      if (pick && pick.value !== actor.id) { pick.value = actor.id; pick.dispatchEvent(new Event("change")); await wait(800); }
      return true;
    }, { base: MODULE_BASE, before });
    out.start = await until(pl.page, before, c => c.crate.limit !== "" && c.ticket.stock !== "");
    const buy = pl.page.locator(`#loot-crates-shop .lc-box[data-box="${before.crateId}"] .lc-box__buy`);
    await buy.click();
    const close = pl.page.locator('.lc-reveal [data-action="dismiss"]').last();
    await close.waitFor({ state: "visible", timeout: 20000 });
    await pl.page.waitForTimeout(700);
    await close.click();
    out.bought = await until(pl.page, before, c => c.crate.off && c.crate.why !== "");
    purchaseRow = await gm.page.evaluate(async ({ base, before }) => structuredClone((await import(base + "scripts/foundry/store.js")).getLog().find(r => r.boxId === before.crateId && !r.refunded) ?? null), { base: MODULE_BASE, before });
    out.purchase = purchaseRow ? { id: purchaseRow.id, price: purchaseRow.price } : null;

    // 2. The log padded past 500, newer than the purchase, then one row
    // written through the store, whose trim keeps 500.
    out.trim = await gm.page.evaluate(async ({ base, before, purchaseId }) => {
      const store = await import(base + "scripts/foundry/store.js");
      const now = Date.now();
      const pad = Array.from({ length: 520 }, (_, i) => ({ id: `lcpad${i.toString(36)}`, at: now + 520 - i, kind: "crate", boxId: "lc-log-cap-pad", boxName: "Log padding", actorId: null, actorName: "Nobody", userId: null, itemId: null, price: 0, payoutCp: 0, name: "Padding" }));
      await store.enqueueWrite(() => game.settings.set("loot-crates", "pullLog", [...pad, ...game.settings.get("loot-crates", "pullLog")]));
      const padded = store.getLog().length;
      await store.enqueueWrite(() => store.appendLog({ kind: "crate", boxId: "lc-log-cap-pad", boxName: "Log padding", actorId: null, actorName: "Nobody", userId: null, itemId: null, price: 0, payoutCp: 0, name: "Padding" }));
      const log = store.getLog();
      const tally = store.getTally();
      return {
        padded, after: log.length, pastCap: log.slice(500).length, pastCapAreStakes: log.slice(500).every(r => r.roundId),
        purchaseGone: !log.some(r => r.id === purchaseId), soldGone: !log.some(r => r.id === before.soldId),
        hiddenGone: !tally.hidden?.[before.soldId], tallyVersion: tally.v,
      };
    }, { base: MODULE_BASE, before, purchaseId: purchaseRow?.id ?? null });

    // 3. The player's cards after the trim, a press on the crate's Buy, and a Buy sent anyway.
    out.afterTrim = await until(pl.page, before, c => c.crate.off && c.ticket.stock !== "");
    await buy.click({ force: true });
    await pl.page.waitForTimeout(1500);
    out.afterPress = await readCards(pl.page, before);
    out.stale = await pl.page.evaluate(async ({ base, before }) => {
      const { requestPull } = await import(base + "scripts/foundry/socket.js");
      try { await requestPull({ boxId: before.crateId, actorId: before.actorId, price: 1 }); return { refused: null }; }
      catch (err) { return { refused: err.message }; }
    }, { base: MODULE_BASE, before });
    await pl.page.waitForTimeout(800);
    out.afterStale = await readCards(pl.page, before);
    out.rowsAfter = await gm.page.evaluate(async ({ base, before }) => (await import(base + "scripts/foundry/store.js")).getLog().filter(r => r.boxId === before.crateId).length, { base: MODULE_BASE, before });
    if (shot) await pl.page.screenshot({ path: shot });

    const limitWhy = `Limit reached: ${before.max} of ${before.max} for Crate Tester`;
    const sentence = `${CRATE}: limit reached, ${before.max} of ${before.max} for Crate Tester. Nothing was charged.`;
    const paid = before.purseCp - 100;
    out.checks = {
      cardsBefore: out.start.ms != null && out.start.crate.limit === "You can buy 1 more" && !out.start.crate.off && out.start.ticket.stock === "4 of 5 tickets left" && !out.start.ticket.off,
      bought: out.bought.ms != null && out.purchase?.price === 1 && out.bought.purseCp === paid && out.bought.items === before.items.length + 1 && out.bought.crate.why === limitWhy,
      trimmed: out.trim.padded > 500 && out.trim.after >= 500 && out.trim.pastCapAreStakes && out.trim.purchaseGone && out.trim.soldGone && out.trim.hiddenGone && out.trim.tallyVersion === 1,
      limitHolds: out.afterTrim.crate.off && out.afterTrim.crate.why === limitWhy && out.afterTrim.crate.limit === "",
      pressDoesNothing: out.afterPress.purseCp === paid && out.afterPress.items === before.items.length + 1 && out.afterPress.crate.off,
      staleRefused: out.stale.refused === sentence && out.afterStale.purseCp === paid && out.afterStale.items === before.items.length + 1 && out.rowsAfter === 0,
      rollHolds: out.afterTrim.ticket.stock === "4 of 5 tickets left" && out.afterStale.ticket.stock === "4 of 5 tickets left" && !out.afterStale.ticket.off,
    };
    out.ok = Object.values(out.checks).every(Boolean);
    out.gmConsole = gm.logs.filter(l => !l.includes("timings"));
    out.playerLog = pl.logs;
  } catch (err) {
    out.error = String(err?.stack || err);
    out.ok = false;
  } finally {
    try { out.restored = await restore(gm?.page, before, purchaseRow); } catch (err) { out.restored = { error: String(err) }; }
    if (out.restored && before) out.restoredOk = out.restored.log === "restored" && out.restored.state === "restored" && (!purchaseRow || (out.restored.refund === "refunded" && out.restored.purseCp === before.purseCp && out.restored.items === before.items.length));
    console.log(JSON.stringify(out, null, 1));
    if (!out.ok || out.restoredOk === false) process.exitCode = 1;
    await browser.close();
  }
})();
