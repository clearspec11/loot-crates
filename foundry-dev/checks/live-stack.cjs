// Live check: a partly used stack sold back and given away (handover.js
// doSell and doGive, the part's `qty`, core/afterplay.js heldWorth and
// partWorthCp, the economy's sold, soldWorth, gave and got in core/tally.js),
// at a real table with the branch's code on the Gamemaster's and the
// player's client.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/checks/live-stack.cjs [--shot out.png]
//   (or: npm run live -- live-stack)
//
// Env: PLAYER (default Player2, must own Crate Tester), OTHER (default
// Player3, must not own it; only their character is needed, they never join).
//
// Two headless clients, the Gamemaster and the player, each running the
// branch's socket (as live-afterreveal.cjs does). Then, as people do:
//
//   0. The GM seeds a world item "Live stack <stamp>" (loot, a stack of
//      STACK at PRICE gp each), "Live stack pool" holding it alone and a
//      crate drawing from it at 5 gp (Sell back at its default 50%), opens
//      the shop if it was closed, tops Crate Tester's gold up, and finds a
//      character OTHER owns in "Loot Crates Test" (seeding "Live gift
//      tester" for OTHER if there is none). The GM opens the manager on the
//      Pull log tab; the readout and the tallies are read before.
//   1. The player buys the crate on Crate Tester and lands the reveal: the
//      stack of STACK is on the sheet, its row's worth says STACK, and the
//      reveal offers Sell back for the whole stack. The player opens Crate
//      Tester's sheet, its Inventory tab, and types SOLD_LEFT into the
//      item's quantity (as a player marks some used), then presses Sell
//      back and its Sell: the button still had the whole stack's price, so
//      the GM refuses ("now buys ... back for N"), nothing moves and the
//      button follows at what is left. Pressed again: the purse rises by
//      exactly the price of SOLD_LEFT, the item is gone, and the row's part
//      says that price and `qty` SOLD_LEFT.
//   2. Buys again, lands the reveal, types GIVEN_LEFT into the new stack's
//      quantity on the sheet, and gives it to OTHER's character through
//      Give to...: that character has it at GIVEN_LEFT, Crate Tester has it
//      no more, and the row's part says given with `qty` GIVEN_LEFT.
//   3. The GM's readout: All time (the tallies) has Crate Tester's sold,
//      soldWorth and gave, and OTHER's character's got, up by the price of
//      what was left, never the stack as won (the part used up stays in
//      Won in items); the table's Won in coins and Won in items say the
//      same. This session (the log's rows) says it too.
//
// Two purchases: a sale and a gift each take their own stack, so one is not
// enough.
//
// Restored in a finally: any play of the crate with nothing parted refunded,
// the given stack deleted from OTHER's character (or that character
// deleted, when this run seeded it), both purses as they were, the crate,
// the pool and the world item deleted, the shop's open state as it was, the
// sheet closed. The two parted rows stay in the log (given and sold:
// refunds are refused), so their plays stay in the economy, as
// live-afterreveal's do.
/* global game, foundry, Actor, Item, __lc */
const { chromium } = require("playwright");
// A Buy over half the purse asks first; pressSpend presses it again then.
const { pressSpend } = require("./lib/spend.cjs");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const OTHER = process.env.OTHER || "Player3";
const POOL = "Live stack pool";
const shot = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : null;
const STAMP = Date.now().toString(36);
const CRATE = `Live stack crate ${STAMP}`;
const ITEM = `Live stack ${STAMP}`;
const GIFT = "Live gift tester";
// The stack as won, its price each (gp), and what is left on the sheet when it is sold or given.
const STACK = 5;
const PRICE = 10;
const SOLD_LEFT = 2;
const GIVEN_LEFT = 3;
const SELL_PCT = 50;

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
    const { logHeard } = await import(base + "scripts/foundry/handover.js");
    const heard = key => { redraw(key); if (key === "pullLog") logHeard(); };
    store.setStoreListener(heard);
    for (const key of store.WORLD_KEYS) {
      const cfg = game.settings.settings.get(`loot-crates.${key}`);
      if (cfg && !String(cfg.onChange ?? "").includes("storeChanged")) cfg.onChange = () => heard(key);
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

// An actor as the GM sees it: its purse in copper and its items from the crate ({ id, quantity, given }).
const readActor = (page, actorId, boxId) => page.evaluate(async ({ base, actorId, boxId }) => {
  const { toCopper } = await import(base + "scripts/core/currency.js");
  const actor = game.actors.get(actorId);
  return { purseCp: toCopper(actor?.system?.currency ?? {}), items: (actor?.items ?? []).filter(i => i.flags?.["loot-crates"]?.boxId === boxId).map(i => ({ id: i.id, name: i.name, quantity: i.system?.quantity ?? null, given: i.flags["loot-crates"].given ?? null })) };
}, { base: MODULE_BASE, actorId, boxId });
const untilActor = async (page, actorId, boxId, pred, ms = 10000) => {
  const t0 = Date.now();
  let a = await readActor(page, actorId, boxId);
  while (!pred(a) && Date.now() - t0 < ms) { await page.waitForTimeout(100); a = await readActor(page, actorId, boxId); }
  return { ...a, ms: pred(a) ? Date.now() - t0 : null };
};
const logRows = (page, boxId) => page.evaluate(async ({ base, boxId }) => (await import(base + "scripts/foundry/store.js")).getLog().filter(r => r.boxId === boxId).map(r => ({ id: r.id, itemId: r.itemId ?? null, worth: r.worth ?? null, parted: r.parted ?? null })), { base: MODULE_BASE, boxId });
const untilRow = async (page, boxId, pred, ms = 10000) => {
  let row = null;
  for (const t0 = Date.now(); Date.now() - t0 < ms; await page.waitForTimeout(100)) if ((row = (await logRows(page, boxId)).find(pred) ?? null)) break;
  return row;
};

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

// The player's own reveal of the newest pull, landed (Skip pressed as a
// player does), with its after-the-reveal section: the window's id.
async function landedReveal(page, known = []) {
  const id = await page.waitForFunction(ids => [...document.querySelectorAll(".application.lc-reveal")].map(a => a.id).find(i => !ids.includes(i)) ?? null, known, { timeout: 15000 }).then(h => h.jsonValue());
  const skip = page.locator(`#${id} .lc-reveal__close`);
  if ((await skip.textContent()).trim() === "Skip") await skip.click().catch(() => {});
  await page.waitForSelector(`#${id} .lc-reveal__after:not([hidden]) .lc-after__give`, { timeout: 15000 });
  await page.waitForTimeout(400);
  return id;
}

/*
  As a player marks some of a stack used: opens the character's sheet, its
  Inventory tab, types `qty` into the item's quantity and presses Enter, then
  closes the sheet. Resolves once the GM's client has the new quantity.
*/
async function lowerOnSheet({ pl, gm }, actorId, itemId, boxId, qty) {
  const sheetId = await pl.page.evaluate(async ({ helpers, actorId }) => {
    (0, eval)(helpers);
    const sheet = game.actors.get(actorId).sheet;
    await sheet.render(true);
    await __lc.until(() => sheet.element?.querySelector('[data-tab="inventory"]'), 8000);
    return sheet.id;
  }, { helpers: HELPERS, actorId });
  await pl.page.locator(`#${sheetId} nav [data-tab="inventory"], #${sheetId} [data-action="tab"][data-tab="inventory"]`).first().click();
  const input = pl.page.locator(`#${sheetId} li[data-item-id="${itemId}"] input[data-name="system.quantity"]`);
  await input.waitFor({ timeout: 8000 });
  await input.fill(String(qty));
  await input.press("Enter");
  const seen = await untilActor(gm.page, actorId, boxId, a => a.items.find(i => i.id === itemId)?.quantity === qty, 8000);
  await pl.page.evaluate(id => [...foundry.applications.instances.values()].find(a => a.id === id)?.close(), sheetId).catch(() => {});
  return seen.ms != null;
}

// The readout as the GM's open manager shows it: the pressed period and the
// characters' table, each name's lines ([cells]): a seeded "Live gift
// tester" deleted by an earlier run keeps its own line under the same name.
const readout = page => page.evaluate(() => {
  const econ = __lc.app?.element?.querySelector(".lc-econ");
  if (!econ) return { present: false };
  const chars = {};
  for (const tr of econ.querySelectorAll(".lc-econ__scroll")[0]?.querySelectorAll("tbody tr") ?? []) (chars[tr.children[0].textContent.trim()] ??= []).push([...tr.children].map(c => c.textContent.trim()));
  return { present: true, pressed: [...econ.querySelectorAll('[data-action="econPeriod"][aria-pressed="true"]')].map(b => b.textContent.trim()), chars };
});
const cp = s => { let n = 0; for (const [, v, c] of String(s ?? "").matchAll(/(\d+) (pp|gp|ep|sp|cp)/g)) n += Number(v) * { pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1 }[c]; return String(s ?? "").startsWith("−") ? -n : n; };
// A name's lines in a readout, summed: { spent, coins, items } in copper (0 with no line).
const lineOf = (r, name) => (r?.chars?.[name] ?? []).reduce((s, c) => ({ spent: s.spent + cp(c[1]), coins: s.coins + cp(c[2]), items: s.items + cp(c[3]) }), { spent: 0, coins: 0, items: 0 });

async function press(page, period) {
  await page.locator(`#loot-crates-manager [data-action="econPeriod"][data-period="${period}"]`).click();
  await page.waitForFunction(p => __lc.app?.element?.querySelector(`[data-action="econPeriod"][data-period="${p}"]`)?.getAttribute("aria-pressed") === "true", period, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);
}

// The tallies' economy for both characters (All time), and the same counted
// from the log's rows of this crate (econOf: what This session counts).
const econNow = (page, ids, boxId) => page.evaluate(async ({ base, ids, boxId }) => {
  const store = await import(base + "scripts/foundry/store.js");
  const { econOf } = await import(base + "scripts/core/tally.js");
  const chars = store.getTally()?.chars ?? {};
  const rows = econOf(store.getLog().filter(r => r.boxId === boxId)).chars ?? {};
  const pick = c => Object.fromEntries(["spent", "items", "sold", "soldWorth", "gave", "got"].map(k => [k, Number(c?.[k]) || 0]));
  return { all: Object.fromEntries(ids.map(id => [id, pick(chars[id])])), rows: Object.fromEntries(ids.map(id => [id, pick(rows[id])])) };
}, { base: MODULE_BASE, ids, boxId });

(async () => {
  const browser = await chromium.launch();
  const out = { player: PLAYER, other: OTHER };
  let gm = null, pl = null;
  let boxId = null, seed = null;
  try {
    // The GM first: This session counts the plays since its client loaded.
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");
    pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);

    // 0. The stack, its pool, the crate, the shop, the gold, OTHER's character.
    seed = out.seed = await gm.page.evaluate(async ({ base, poolName, crate, itemName, other, player, gift, stack, price }) => {
      const store = await import(base + "scripts/foundry/store.js");
      const folder = game.folders.find(f => f.type === "Actor" && f.name === "Loot Crates Test");
      const tester = game.actors.find(a => a.name === "Crate Tester" && a.folder?.id === folder?.id);
      if (!tester) throw new Error("no Crate Tester in Loot Crates Test");
      const otherUser = game.users.find(u => u.name === other);
      if (!otherUser) throw new Error(`no user ${other}`);
      if (tester.testUserPermission(otherUser, "OWNER")) throw new Error(`${other} owns Crate Tester`);
      const playerUser = game.users.find(u => u.name === player);
      let target = game.actors.find(a => a.type === "character" && a.folder?.id === folder?.id && a.id !== tester.id && a.testUserPermission(otherUser, "OWNER") && !a.testUserPermission(playerUser, "OWNER"));
      let made = false;
      if (!target) {
        target = await Actor.create({ name: gift, type: "character", folder: folder.id, ownership: { default: 0, [otherUser.id]: 3 } });
        made = true;
      }
      const purses = { tester: foundry.utils.deepClone(tester.system.currency), target: foundry.utils.deepClone(target.system.currency) };
      if ((tester.system.currency.gp ?? 0) < 20) await tester.update({ "system.currency.gp": 1000 });
      const item = await Item.create({ name: itemName, type: "loot", system: { quantity: stack, price: { value: price, denomination: "gp" }, rarity: "common" } });
      const entry = store.entryFromItem(item, item.uuid);
      const old = Object.values(store.getPools()).find(p => p.name === poolName);
      const pool = await store.savePool({ ...(old ? { id: old.id } : {}), name: poolName, entries: [{ ...entry, rarity: "common" }], pools: [] });
      const c = await store.saveBox({ name: crate, price: 5, pools: [{ id: pool.id, share: 1 }], weights: { common: 1 }, rules: {} });
      const shopWasOpen = store.isShopOpen();
      if (!shopWasOpen) await store.setShopOpen(true);
      return { crateId: c.id, poolId: pool.id, itemId: item.id, shopWasOpen, purses, testerId: tester.id, targetId: target.id, targetName: target.name, made };
    }, { base: MODULE_BASE, poolName: POOL, crate: CRATE, itemName: ITEM, other: OTHER, player: PLAYER, gift: GIFT, stack: STACK, price: PRICE });
    boxId = seed.crateId;
    const ids = [seed.testerId, seed.targetId];
    const each = PRICE * 100;
    const sellAt = left => Math.floor(PRICE * left * SELL_PCT / 100) * 100;
    const gp = c => `${c / 100} gp`;

    // The GM's Pull log tab, the readout and the tallies before.
    out.opened = await gm.page.evaluate(async ({ base, helpers }) => {
      (0, eval)(helpers);
      const { openManager } = await import(base + "scripts/foundry/manager.js");
      __lc.app = openManager();
      await __lc.until(() => __lc.app.element?.querySelector('.lc-tabs [data-tab="log"]'));
      __lc.click(__lc.app.element.querySelector('.lc-tabs [data-tab="log"]'));
      return !!await __lc.until(() => __lc.app.tab === "log" && __lc.app.element?.querySelector(".lc-econ, .lc-empty"), 8000);
    }, { base: MODULE_BASE, helpers: HELPERS });
    out.econBefore = await econNow(gm.page, ids, boxId);
    const allBefore = await readout(gm.page);
    await press(gm.page, "session");
    const sessionBefore = await readout(gm.page);
    await press(gm.page, "all");

    // 1. Buy, use some of the stack on the sheet, Sell back.
    const before = await readActor(gm.page, seed.testerId, boxId);
    await buy(pl, boxId, "Crate Tester");
    const first = await landedReveal(pl.page);
    const won = await untilActor(gm.page, seed.testerId, boxId, a => a.items.length === before.items.length + 1);
    const sellItem = won.items.find(i => !before.items.some(b => b.id === i.id)) ?? null;
    out.wonQty = sellItem?.quantity ?? null;
    const sellRow0 = await untilRow(gm.page, boxId, r => r.itemId === sellItem?.id);
    out.wonWorth = sellRow0?.worth?.[sellItem?.id] ?? null;
    const sell = pl.page.locator(`#${first} .lc-after__sell`);
    out.sellOffered = (await sell.textContent()).trim();
    out.soldLowered = await lowerOnSheet({ pl, gm }, seed.testerId, sellItem?.id, boxId, SOLD_LEFT);
    out.revealStillOpen = await pl.page.evaluate(id => !!document.getElementById(id), first);
    const lowered = await readActor(gm.page, seed.testerId, boxId);
    // The button had the whole stack's price: the GM refuses it, nothing moves, the button follows.
    await sell.click();
    await pl.page.locator(`#${first} .lc-after__sellgo`).waitFor({ timeout: 5000 });
    await pl.page.locator(`#${first} .lc-after__sellgo`).click();
    await pl.page.waitForFunction(({ id, want }) => document.querySelector(`#${id} .lc-after__sell`)?.textContent.trim() === want, { id: first, want: `Sell back for ${gp(sellAt(SOLD_LEFT))}` }, { timeout: 10000 }).catch(() => {});
    out.sellFollowed = (await sell.textContent().catch(() => null))?.trim() ?? null;
    out.refusedSaid = await pl.page.evaluate(id => document.querySelector(`#${id} .lc-reveal__after`)?.textContent.replace(/\s+/g, " ").trim() ?? null, first);
    const refusedState = await readActor(gm.page, seed.testerId, boxId);
    out.refusedNothingMoved = refusedState.purseCp === lowered.purseCp && refusedState.items.some(i => i.id === sellItem?.id && i.quantity === SOLD_LEFT);
    // Pressed again, at what is left.
    await sell.click();
    await pl.page.locator(`#${first} .lc-after__sellgo`).waitFor({ timeout: 5000 });
    await pl.page.locator(`#${first} .lc-after__sellgo`).click();
    out.sold = await untilActor(gm.page, seed.testerId, boxId, a => !a.items.some(i => i.id === sellItem?.id) && a.purseCp !== lowered.purseCp, 15000);
    out.soldPaidCp = out.sold.purseCp - lowered.purseCp;
    out.soldRow = await untilRow(gm.page, boxId, r => r.itemId === sellItem?.id && r.parted?.[sellItem?.id]);
    if (shot) await pl.page.screenshot({ path: shot });
    await pl.page.locator(`#${first} .lc-reveal__close`).click().catch(() => {});
    await pl.page.waitForTimeout(500);

    // 2. Buy again, use some on the sheet, Give to... OTHER's character.
    const before2 = await readActor(gm.page, seed.testerId, boxId);
    await buy(pl, boxId, "Crate Tester");
    const second = await landedReveal(pl.page, [first]);
    const won2 = await untilActor(gm.page, seed.testerId, boxId, a => a.items.length === before2.items.length + 1);
    const giftItem = won2.items.find(i => !before2.items.some(b => b.id === i.id)) ?? null;
    out.wonQty2 = giftItem?.quantity ?? null;
    out.givenLowered = await lowerOnSheet({ pl, gm }, seed.testerId, giftItem?.id, boxId, GIVEN_LEFT);
    out.revealStillOpen2 = await pl.page.evaluate(id => !!document.getElementById(id), second);
    await pl.page.locator(`#${second} .lc-after__give`).click();
    await pl.page.locator(`#${second} .lc-after__target`).selectOption(seed.targetId);
    await pl.page.locator(`#${second} .lc-after__confirm`).click();
    out.given = await untilActor(gm.page, seed.targetId, boxId, a => a.items.some(i => i.given), 15000);
    out.afterGive = await untilActor(gm.page, seed.testerId, boxId, a => !a.items.some(i => i.id === giftItem?.id), 8000);
    out.givenRow = await untilRow(gm.page, boxId, r => r.itemId === giftItem?.id && r.parted?.[giftItem?.id]);
    await pl.page.locator(`#${second} .lc-reveal__close`).click().catch(() => {});

    // 3. The readout: the tallies, the log's rows, the GM's table in both periods.
    await gm.page.waitForTimeout(800);
    out.econAfter = await econNow(gm.page, ids, boxId);
    const allAfter = await readout(gm.page);
    await press(gm.page, "session");
    const sessionAfter = await readout(gm.page);
    await press(gm.page, "all");

    const delta = (a, b) => Object.fromEntries(Object.keys(a).map(k => [k, a[k] - (b?.[k] ?? 0)]));
    const dAll = Object.fromEntries(ids.map(id => [id, delta(out.econAfter.all[id], out.econBefore.all[id])]));
    const dRows = Object.fromEntries(ids.map(id => [id, delta(out.econAfter.rows[id], out.econBefore.rows[id])]));
    const dLine = (after, beforeR, name) => delta(lineOf(after, name), lineOf(beforeR, name));
    out.deltas = {
      all: dAll, rows: dRows,
      tableAll: { tester: dLine(allAfter, allBefore, "Crate Tester"), target: dLine(allAfter, allBefore, seed.targetName) },
      tableSession: { tester: dLine(sessionAfter, sessionBefore, "Crate Tester"), target: dLine(sessionAfter, sessionBefore, seed.targetName) },
      pressed: [allAfter.pressed.join(), sessionAfter.pressed.join()],
    };

    // What the readout must say: each stack won at STACK, the sale and the gift at what was left.
    const want = {
      items: 2 * STACK * each, sold: sellAt(SOLD_LEFT), soldWorth: SOLD_LEFT * each, gave: GIVEN_LEFT * each, got: GIVEN_LEFT * each,
    };
    const wonItems = want.items - want.soldWorth - want.gave;
    const econOk = d => d[seed.testerId].spent === 1000 && d[seed.testerId].items === want.items && d[seed.testerId].sold === want.sold && d[seed.testerId].soldWorth === want.soldWorth && d[seed.testerId].gave === want.gave && d[seed.targetId].got === want.got;
    const tableOk = t => t.tester.spent === 1000 && t.tester.coins === want.sold && t.tester.items === wonItems && t.target.items === want.got;
    const soldPart = out.soldRow?.parted?.[sellItem?.id];
    const givenPart = out.givenRow?.parted?.[giftItem?.id];
    out.checks = {
      stackWon: out.wonQty === STACK && out.wonQty2 === STACK && out.wonWorth?.quantity === STACK && Number(out.wonWorth?.value) === PRICE,
      offeredWhole: out.sellOffered === `Sell back for ${gp(sellAt(STACK))}`,
      usedOnSheet: out.soldLowered && out.givenLowered && out.revealStillOpen && out.revealStillOpen2,
      staleRefused: out.refusedNothingMoved && /now buys .* back for /.test(out.refusedSaid ?? "") && (out.refusedSaid ?? "").includes(gp(sellAt(SOLD_LEFT))),
      sellFollowed: out.sellFollowed === `Sell back for ${gp(sellAt(SOLD_LEFT))}`,
      soldPaid: out.sold.ms != null && out.soldPaidCp === sellAt(SOLD_LEFT),
      soldRow: soldPart?.soldCp === sellAt(SOLD_LEFT) && soldPart?.qty === SOLD_LEFT,
      givenMoved: out.given.ms != null && out.given.items.some(i => i.given && i.quantity === GIVEN_LEFT) && out.afterGive.ms != null,
      givenRow: givenPart?.given?.actorId === seed.targetId && givenPart?.qty === GIVEN_LEFT,
      tallyAllTime: econOk(dAll),
      rowsCount: econOk(dRows),
      readoutAllTime: out.deltas.pressed[0] === "All time" && tableOk(out.deltas.tableAll),
      readoutSession: out.deltas.pressed[1] === "This session" && tableOk(out.deltas.tableSession),
    };
    out.want = { ...want, wonItems };
    out.ok = Object.values(out.checks).every(Boolean);
    out.gmConsole = gm.logs.filter(l => !l.includes("timings"));
    out.playerLog = pl.logs.filter(l => !l.includes("timings"));
  } catch (err) {
    out.error = String(err?.stack || err);
    out.ok = false;
  } finally {
    // Unparted plays refunded, the gift taken back (or its character, when
    // seeded here), the purses, the crate, the pool, the item and the shop as they were.
    try {
      out.restored = gm && seed ? await gm.page.evaluate(async ({ base, boxId, seed }) => {
        const store = await import(base + "scripts/foundry/store.js");
        const { refundPull } = await import(base + "scripts/foundry/refund.js");
        const { toCopper } = await import(base + "scripts/core/currency.js");
        const refunded = [];
        for (const r of store.getLog().filter(x => x.boxId === boxId && !x.refunded && !Object.keys(x.parted ?? {}).length)) refunded.push((await refundPull(r.id)).status);
        const target = game.actors.get(seed.targetId);
        let actorGone = false;
        if (seed.made && target) { await target.delete(); actorGone = true; }
        else if (target) {
          const left = target.items.filter(i => i.flags?.["loot-crates"]?.boxId === boxId).map(i => i.id);
          if (left.length) await target.deleteEmbeddedDocuments("Item", left);
          if (toCopper(target.system.currency) !== toCopper(seed.purses.target)) await target.update({ "system.currency": seed.purses.target });
        }
        const tester = game.actors.get(seed.testerId);
        const stray = tester.items.filter(i => i.flags?.["loot-crates"]?.boxId === boxId).map(i => i.id);
        if (stray.length) await tester.deleteEmbeddedDocuments("Item", stray);
        if (toCopper(tester.system.currency) !== toCopper(seed.purses.tester)) await tester.update({ "system.currency": seed.purses.tester });
        await store.removeBox(boxId);
        await store.deletePool(seed.poolId);
        await game.items.get(seed.itemId)?.delete();
        if (!seed.shopWasOpen) await store.setShopOpen(false);
        try { await globalThis.__lc?.app?.close(); } catch { /* closed */ }
        const targetNow = game.actors.get(seed.targetId);
        return {
          refunded, actorGone, stray: stray.length,
          purseRestored: toCopper(tester.system.currency) === toCopper(seed.purses.tester),
          targetRestored: seed.made ? !targetNow : toCopper(targetNow.system.currency) === toCopper(seed.purses.target) && !targetNow.items.some(i => i.flags?.["loot-crates"]?.boxId === boxId),
          gone: !store.getBoxes()[boxId] && !store.getPools()[seed.poolId] && !game.items.get(seed.itemId),
          shop: store.isShopOpen() === seed.shopWasOpen,
        };
      }, { base: MODULE_BASE, boxId, seed }) : null;
    } catch (err) { out.restored = { error: String(err) }; out.ok = false; }
    if (out.restored && (out.restored.error || !out.restored.gone || !out.restored.shop || !out.restored.purseRestored || !out.restored.targetRestored || out.restored.refunded.some(s => s !== "refunded"))) out.ok = false;
    for (const c of [pl, gm]) { try { await c?.page.evaluate(() => { for (const a of [...foundry.applications.instances.values()]) if (/loot-crates|ActorSheet|CharacterActorSheet/.test(a.id ?? "") || a.document?.documentName === "Actor") a.close(); }); } catch { /* closing */ } }
    console.log(JSON.stringify(out, null, 1));
    if (!out.ok) process.exitCode = 1;
    await browser.close();
  }
})();
