// Live check: after the reveal (VIB-219: reveal.js, views/afterreveal.js,
// socket.js requestGive/requestSell, handover.js), at a real table with the
// branch's code on every client.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/checks/live-afterreveal.cjs [--shot out.png]
//   (or: npm run live -- live-afterreveal)
//
// Env: PLAYER (default Player2, must own Crate Tester), OTHER (default
// Player3, must not own it), PACK (default dnd5e.items, where the pool's one
// priced item comes from).
//
// Three headless clients, the Gamemaster, the player and the other player,
// each running the branch's socket (as live-keep.cjs does). Then, as people do:
//
//   0. The GM seeds "Live after pool" (one priced item from PACK, common)
//      and a crate drawing from it at 5 gp (Sell back at its default 50%),
//      opens the shop if it was closed, tops Crate Tester's gold up, and
//      finds a character OTHER owns in "Loot Crates Test" (seeding "Live
//      gift tester" for OTHER if there is none, deleted again at the end).
//   1. The player opens the shop on Crate Tester and presses the crate's
//      Buy; on its reveal (Skip, as a player does) presses "Sell back for
//      N": the purse rises by exactly N, the item is gone from Crate
//      Tester, the row says sold for N, the window says it, the GM's
//      window of the same pull says it too (with no buttons), and the
//      chat card has the line.
//   2. Closes it, presses Buy again, and on the new reveal presses Give to…,
//      picks OTHER's character in the list and presses Give: the item is on
//      that character and gone from Crate Tester, and the row says given.
//   3. OTHER buys the crate once on their character. The player then sends
//      a give and a sell for OTHER's row by the real query path (Foundry
//      names the player as the sender): both refused, nothing moved.
//   4. The GM presses Refund on the sold row in the Pull log: it says the
//      item is gone and nothing is refunded.
//
// Restored in a finally: OTHER's row refunded (its item leaves with it),
// the given item deleted from OTHER's character (or that character
// deleted, when this run seeded it), Crate Tester's and OTHER's purses as
// they were, the crate deleted, the shop's open state as it was. The
// player's two rows stay in the log (given and sold: refunds are refused).
// The pool stays seeded.
/* global game, foundry, fromUuid, Actor, __lc */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const OTHER = process.env.OTHER || "Player3";
const PACK = process.env.PACK || "dnd5e.items";
const POOL = "Live after pool";
const shot = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : null;
const STAMP = Date.now().toString(36);
const CRATE = `Live after crate ${STAMP}`;
const GIFT = "Live gift tester";

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

// An actor as the GM sees it: its purse in copper and its items from the crate ({ id, name }).
const readActor = (page, actorId, boxId) => page.evaluate(async ({ base, actorId, boxId }) => {
  const { toCopper } = await import(base + "scripts/core/currency.js");
  const actor = game.actors.get(actorId);
  return { purseCp: toCopper(actor?.system?.currency ?? {}), items: (actor?.items ?? []).filter(i => i.flags?.["loot-crates"]?.boxId === boxId).map(i => ({ id: i.id, name: i.name, given: i.flags["loot-crates"].given ?? null })) };
}, { base: MODULE_BASE, actorId, boxId });
const untilActor = async (page, actorId, boxId, pred, ms = 10000) => {
  const t0 = Date.now();
  let a = await readActor(page, actorId, boxId);
  while (!pred(a) && Date.now() - t0 < ms) { await page.waitForTimeout(100); a = await readActor(page, actorId, boxId); }
  return { ...a, ms: pred(a) ? Date.now() - t0 : null };
};
const logRows = (page, boxId) => page.evaluate(async ({ base, boxId }) => (await import(base + "scripts/foundry/store.js")).getLog().filter(r => r.boxId === boxId).map(r => ({ id: r.id, userId: r.userId, actorId: r.actorId, itemId: r.itemId ?? null, refunded: !!r.refunded, parted: r.parted ?? null, worth: r.worth ?? null })), { base: MODULE_BASE, boxId });
const untilRows = async (page, boxId, n, ms = 10000) => {
  let rows = [];
  for (const t0 = Date.now(); Date.now() - t0 < ms; await page.waitForTimeout(100)) if ((rows = await logRows(page, boxId)).length >= n) break;
  return rows;
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
  await btn.click();
}

// The player's own reveal of the newest pull, landed (Skip pressed as a
// player does), with its after-the-reveal section: the window's id.
async function landedReveal(page, known = []) {
  const id = await page.waitForFunction(ids => [...document.querySelectorAll(".application.lc-reveal")].map(a => a.id).find(i => !ids.includes(i)) ?? null, known, { timeout: 15000 }).then(h => h.jsonValue());
  const skip = page.locator(`#${id} .lc-reveal__close`);
  if ((await skip.textContent()).trim() === "Skip") await skip.click().catch(() => {});
  await page.waitForSelector(`#${id} .lc-reveal__after:not([hidden]) .lc-after__give`, { timeout: 15000 });
  await page.waitForTimeout(600);
  return id;
}

(async () => {
  const browser = await chromium.launch();
  const out = { player: PLAYER, other: OTHER };
  let gm = null, pl = null, ot = null;
  let boxId = null, seed = null;
  try {
    pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");

    // 0. The pool, the crate, the shop, the gold, OTHER's character.
    seed = out.seed = await gm.page.evaluate(async ({ base, pack: packId, poolName, crate, other, player, gift }) => {
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
      if ((target.system.currency.gp ?? 0) < 20) await target.update({ "system.currency.gp": 100 });
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
      return { crateId: c.id, shopWasOpen, purses, testerId: tester.id, targetId: target.id, targetName: target.name, made, itemName: entry.name, price: hit.system.price };
    }, { base: MODULE_BASE, pack: PACK, poolName: POOL, crate: CRATE, other: OTHER, player: PLAYER, gift: GIFT });
    boxId = seed.crateId;
    const wantCp = Math.floor(seed.price.value * 50 / 100) * 100;

    // 1. Buy, then Sell back on the reveal.
    const before = await readActor(gm.page, seed.testerId, boxId);
    await buy(pl, boxId, "Crate Tester");
    const first = await landedReveal(pl.page);
    const sell = pl.page.locator(`#${first} .lc-after__sell`);
    out.sellButton = (await sell.textContent()).trim();
    out.lead = (await pl.page.textContent(`#${first} .lc-after__lead`)).trim();
    out.targets = await pl.page.$$eval(`#${first} .lc-after__target option`, os => os.map(o => o.textContent));
    const granted = await untilActor(gm.page, seed.testerId, boxId, a => a.items.length === before.items.length + 1);
    if (shot) await pl.page.screenshot({ path: shot });
    await sell.click();
    out.sold = await untilActor(gm.page, seed.testerId, boxId, a => a.items.length === before.items.length && a.purseCp === granted.purseCp + wantCp, 15000);
    await pl.page.waitForFunction(id => /sold .+ back for/.test(document.querySelector(`#${id} .lc-after__said`)?.textContent ?? ""), first, { timeout: 8000 }).catch(() => {});
    out.soldLine = await pl.page.evaluate(id => document.querySelector(`#${id} .lc-after__item`)?.textContent.replace(/\s+/g, " ").trim() ?? null, first);
    out.soldFocus = await pl.page.evaluate(id => document.activeElement?.matches?.(`#${id} .lc-reveal__close`) ?? false, first);
    let rows = await untilRows(gm.page, boxId, 1);
    out.soldRow = rows[0];
    // The GM's window of the same pull (a spectator): the line, no buttons.
    await gm.page.waitForFunction(() => [...document.querySelectorAll(".application.lc-reveal .lc-after__said")].some(s => /sold .+ back for/.test(s.textContent)), null, { timeout: 15000 }).catch(() => {});
    out.gmWindow = await gm.page.evaluate(() => {
      const win = [...document.querySelectorAll(".application.lc-reveal")].find(a => a.querySelector(".lc-after__said"));
      return win ? { text: win.querySelector(".lc-reveal__after").textContent.replace(/\s+/g, " ").trim(), buttons: win.querySelectorAll(".lc-reveal__after button").length } : null;
    });
    await gm.page.waitForTimeout(500);
    out.card = await gm.page.evaluate(logId => game.messages.contents.find(m => m.flags?.["loot-crates"]?.logId === logId)?.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() ?? null, rows[0]?.id);

    // 2. Close, Buy again, Give to… OTHER's character.
    await pl.page.locator(`#${first} .lc-reveal__close`).click();
    await pl.page.waitForTimeout(600);
    await buy(pl, boxId, "Crate Tester");
    const second = await landedReveal(pl.page, [first]);
    const before2 = await untilActor(gm.page, seed.testerId, boxId, a => a.items.length === before.items.length + 1);
    const giftItemId = before2.items.find(i => !before.items.some(b => b.id === i.id))?.id ?? null;
    await pl.page.locator(`#${second} .lc-after__give`).click();
    await pl.page.locator(`#${second} .lc-after__target`).selectOption(seed.targetId);
    await pl.page.locator(`#${second} .lc-after__confirm`).click();
    out.given = await untilActor(gm.page, seed.targetId, boxId, a => a.items.some(i => i.given), 15000);
    out.afterGive = await untilActor(gm.page, seed.testerId, boxId, a => !a.items.some(i => i.id === giftItemId), 8000);
    await pl.page.waitForFunction(id => /gave .+ to/.test(document.querySelector(`#${id} .lc-after__said`)?.textContent ?? ""), second, { timeout: 8000 }).catch(() => {});
    out.gaveLine = await pl.page.evaluate(id => document.querySelector(`#${id} .lc-after__item`)?.textContent.replace(/\s+/g, " ").trim() ?? null, second);
    rows = await untilRows(gm.page, boxId, 2);
    out.givenRow = rows[0];
    await pl.page.locator(`#${second} .lc-reveal__close`).click().catch(() => {});

    // 3. OTHER buys once; the player's forged give and sell for that row.
    ot = await join(browser, OTHER);
    if (!ot) throw new Error(`${OTHER} is not free to join`);
    const otherBefore = await readActor(gm.page, seed.targetId, boxId);
    await buy(ot, boxId, seed.targetName);
    const withOther = await untilActor(gm.page, seed.targetId, boxId, a => a.items.length === otherBefore.items.length + 1, 15000);
    rows = await untilRows(gm.page, boxId, 3);
    const otherRow = rows.find(r => r.actorId === seed.targetId && !r.parted);
    out.otherRow = otherRow ?? null;
    out.forged = await pl.page.evaluate(async ({ row, testerId }) => {
      const ask = data => game.users.activeGM.query("loot-crates.request", { requestId: "forge" + Math.random().toString(36).slice(2, 8), userId: game.user.id, replyBy: "query", ...data }, { timeout: 10000 }).catch(e => ({ thrown: e.message }));
      return {
        give: await ask({ type: "give", logId: row.id, itemId: row.itemId, targetId: testerId }),
        sell: await ask({ type: "sell", logId: row.id, itemId: row.itemId, cp: 1 }),
      };
    }, { row: otherRow, testerId: seed.testerId });
    await gm.page.waitForTimeout(800);
    out.otherAfter = await readActor(gm.page, seed.targetId, boxId);
    out.otherRowAfter = (await logRows(gm.page, boxId)).find(r => r.id === otherRow?.id) ?? null;

    // 4. The GM's Refund on the sold row: refused, the item being gone.
    out.refund = await gm.page.evaluate(async ({ base, helpers, rowId }) => {
      (0, eval)(helpers);
      const store = await import(base + "scripts/foundry/store.js");
      const { openManager } = await import(base + "scripts/foundry/manager.js");
      __lc.app = openManager();
      await __lc.until(() => __lc.app.element?.querySelector('.lc-tabs [data-tab="log"]'));
      __lc.click(__lc.app.element.querySelector('.lc-tabs [data-tab="log"]'));
      const btn = () => __lc.app.element?.querySelector(`button[data-action=refund][data-row="${rowId}"]`);
      if (!await __lc.until(() => __lc.app.tab === "log" && btn(), 8000)) return { error: "no Refund on the sold row" };
      const note = btn().closest("tr")?.querySelector(".lc-log__parted")?.textContent ?? null;
      __lc.click(btn());
      const dialog = () => [...document.querySelectorAll(".application.dialog")].pop();
      await __lc.until(() => dialog()?.querySelector(".window-content"));
      const said = dialog()?.querySelector(".window-content")?.textContent.replace(/\s+/g, " ").trim() ?? null;
      const ok = [...(dialog()?.querySelectorAll("button") ?? [])].find(b => /close|ok/i.test(b.dataset.action ?? b.textContent));
      if (ok) __lc.click(ok);
      await __lc.wait(500);
      return { note, said, refunded: !!store.getLog().find(r => r.id === rowId)?.refunded };
    }, { base: MODULE_BASE, helpers: HELPERS, rowId: out.soldRow?.id });

    const soldPart = out.soldRow?.parted?.[out.soldRow?.itemId];
    const givenPart = out.givenRow?.parted?.[out.givenRow?.itemId];
    const price = `${wantCp / 100} gp`;
    out.checks = {
      offered: out.sellButton === `Sell back for ${price}` && /Closing it leaves it with Crate Tester\.$/.test(out.lead) && out.targets.some(t => t.startsWith(`${seed.targetName} (`)),
      soldPaid: out.sold.ms != null && out.sold.purseCp === granted.purseCp + wantCp,
      soldGone: out.sold.items.length === before.items.length,
      soldRow: soldPart?.soldCp === wantCp,
      soldSaid: out.soldLine === `Crate Tester sold ${seed.itemName} back for ${price}.` && out.soldFocus,
      spectator: out.gmWindow?.text === `Crate Tester sold ${seed.itemName} back for ${price}.` && out.gmWindow.buttons === 0,
      chatLine: (out.card ?? "").includes(`Crate Tester sold it back for ${price}.`),
      givenMoved: out.given.ms != null && out.given.items.some(i => i.name === seed.itemName && i.given) && out.afterGive.ms != null,
      givenRow: givenPart?.given?.actorId === seed.targetId,
      gaveSaid: out.gaveLine === `Crate Tester gave ${seed.itemName} to ${seed.targetName}.`,
      forgedRefused: out.forged.give?.type === "error" && out.forged.sell?.type === "error" && /Only the player who won/.test(out.forged.give.message ?? "") && /Only the player who won/.test(out.forged.sell.message ?? ""),
      forgedNothingMoved: out.otherAfter.items.length === withOther.items.length && out.otherAfter.purseCp === withOther.purseCp && !out.otherRowAfter?.parted,
      refundRefused: out.refund.note === `Crate Tester sold it back for ${price}.` && /can't be refunded/.test(out.refund.said ?? "") && !out.refund.refunded,
    };
    out.ok = Object.values(out.checks).every(Boolean);
    out.gmConsole = gm.logs.filter(l => !l.includes("timings"));
    out.playerLog = pl.logs.filter(l => !l.includes("timings"));
  } catch (err) {
    out.error = String(err?.stack || err);
    out.ok = false;
  } finally {
    // OTHER's row refunded, the gift taken back (or its character, when
    // seeded here), the purses, the crate and the shop as they were.
    try {
      out.restored = gm && boxId ? await gm.page.evaluate(async ({ base, boxId, seed }) => {
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
        const purseOk = toCopper(tester.system.currency) === toCopper(seed.purses.tester);
        if (!purseOk) await tester.update({ "system.currency": seed.purses.tester });
        await store.removeBox(boxId);
        if (!seed.shopWasOpen) await store.setShopOpen(false);
        try { await globalThis.__lc?.app?.close(); } catch { /* closed */ }
        return { refunded, actorGone, purseRestored: toCopper(tester.system.currency) === toCopper(seed.purses.tester), gone: !store.getBoxes()[boxId], shop: store.isShopOpen() === seed.shopWasOpen };
      }, { base: MODULE_BASE, boxId, seed }) : null;
    } catch (err) { out.restored = { error: String(err) }; out.ok = false; }
    if (out.restored && (out.restored.error || !out.restored.gone || !out.restored.shop || !out.restored.purseRestored || out.restored.refunded.some(s => s !== "refunded"))) out.ok = false;
    for (const c of [pl, ot]) { try { await c?.page.evaluate(() => { for (const a of [...foundry.applications.instances.values()]) if (/loot-crates/.test(a.id)) a.close(); }); } catch { /* closing */ } }
    console.log(JSON.stringify(out, null, 1));
    if (!out.ok) process.exitCode = 1;
    await browser.close();
  }
})();
