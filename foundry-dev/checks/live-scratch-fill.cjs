// Live check: Fill the prize list (scratchplan.js) in the real scratch editor, and a hidden game's counts kept out of the player's browser, at a real table with the branch's code on both ends.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/checks/live-scratch-fill.cjs [--shot out.png]
//   (or: npm run live -- live-scratch-fill)
//
// Env: PLAYER (default Player2, must own Crate Tester), PACK (default
// dnd5e.items, where the pool's items come from).
//
// Two headless clients, the Gamemaster and the player, each running the
// branch's socket, redraw and shop code (as live-scratch-combo.cjs does).
// The player's page also listens on the module's socket and keeps every
// message it receives. Then, as people do:
//
//   0. The GM seeds a pool "Live fill pool" holding a rare and an uncommon
//      loot-type item from PACK, and tops Crate Tester's gold up if low.
//   1. The GM clicks "New scratch ticket" on the Boxes tab, types a name,
//      "5 gp" and 100 tickets, ticks the pool, presses "Fill the prize
//      list", leaves its fields at their defaults (65%, 1 in 3.5, top
//      prize Rare item, some combinations) and presses Fill. The editor's
//      six starting rows are the GM's, so Foundry's confirm asks first:
//      Yes. The rows are replaced: the first is one Rare item, the readout
//      says "1 in 3.4 tickets wins" and "Pays back" within 3 points of 65%.
//      Shuffle: the rows change, with no second question. The GM unticks
//      "Players see what is left in the roll" and presses Add to shelf:
//      one record whose prize list is the shuffled rows, showLeft false.
//   2. The player presses Buy once and opens the ticket with Reveal all;
//      it lands. The reveal message the player's page received for it has
//      no "left", no stateBefore.scratch, and a ticket of the roll alone.
//      Whether the player's client can read the Pull log setting is noted
//      (the CHANGELOG's remaining limit), not judged.
//   3. The GM refunds that ticket from the Pull log (Refund, Yes): the
//      purse is back where it was before the Buy.
//
// Restored in a finally: the ticket refunded, the game this run made
// deleted (only that one), the shop's open state put back; the pool stays
// seeded. Needs "Crate Tester" in "Loot Crates Test". One purchase.
/* global game, Hooks, foundry, fromUuid, __lc */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const PACK = process.env.PACK || "dnd5e.items";
const POOL = "Live fill pool";
const shot = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : null;
const STAMP = Date.now().toString(36);
const NAME = `Live fill ${STAMP}`;

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

// The editor's prize rows as text: "1 item.rare:" or "4 gp:10 bonus:".
const rowsOf = dlg => dlg.locator(".lc-prize-row").evaluateAll(rows => rows.map(r => [r.querySelector(".lc-prize-row__count").value, ...[...r.querySelectorAll(".lc-prize-part")].map(p => `${p.querySelector(".lc-prize-row__what").value}:${p.querySelector(".lc-prize-row__what").value === "gp" ? p.querySelector(".lc-prize-row__gp").value : ""}`)].join(" ")));
const lineText = line => [line.count, ...line.parts.map(q => (q.item ? `item.${q.item.rarity}:` : q.bonus ? "bonus:" : `gp:${q.gp}`))].join(" ");

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
      if ((actor.system.currency.gp ?? 0) < 50) await actor.update({ "system.currency.gp": 1000 });
      const pack = game.packs.get(packId);
      if (!pack) throw new Error(`no ${packId} compendium in this world`);
      const index = await pack.getIndex({ fields: ["system.rarity", "type"] });
      const entries = [];
      for (const rarity of ["rare", "uncommon"]) {
        const hit = index.find(e => store.isLootType(e.type) && e.system?.rarity === rarity);
        if (!hit) throw new Error(`${packId} holds no ${rarity} loot-type item`);
        entries.push(store.entryFromItem(await fromUuid(hit.uuid), hit.uuid));
      }
      const old = Object.values(store.getPools()).find(p => p.name === poolName);
      const pool = await store.savePool({ ...(old ? { id: old.id } : {}), name: poolName, entries, pools: [] });
      const open = store.isShopOpen();
      if (!open) await store.setShopOpen(true);
      return { poolId: pool.id, items: entries.map(e => `${e.name} (${e.rarity})`), open };
    }, { base: MODULE_BASE, pack: PACK, poolName: POOL });
    shopOpen = out.seed.open;
    const { poolId } = out.seed;

    // The player's shop, open on Crate Tester, and every module socket message the page receives.
    await pl.page.evaluate(async ({ base, helpers }) => {
      (0, eval)(helpers);
      __lc.seen = [];
      game.socket.on("module.loot-crates", msg => __lc.seen.push(JSON.parse(JSON.stringify(msg))));
      const { openShop } = await import(base + "scripts/foundry/shop.js");
      const actor = game.actors.find(a => a.isOwner && a.type === "character" && a.name === "Crate Tester");
      if (!actor) throw new Error(`${game.user.name} doesn't own Crate Tester`);
      const app = openShop();
      await __lc.until(() => app.element?.querySelector(".lc-shop__body"), 8000);
      const pick = app.element.querySelector(".lc-shop__actor");
      if (pick && pick.value !== actor.id) { pick.value = actor.id; pick.dispatchEvent(new Event("change")); await __lc.wait(800); }
    }, { base: MODULE_BASE, helpers: HELPERS });

    // 1. New scratch ticket, filled by Fill the prize list.
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
    await dlg.locator('input[name="price"]').fill("5 gp");
    await dlg.locator('input[name="size"]').fill("100");
    await dlg.locator(`input[name="pool.${poolId}"]`).check();
    const startRows = await rowsOf(dlg);
    await dlg.locator(".lc-fill__toggle").click();
    out.fields = {
      expanded: await dlg.locator(".lc-fill__toggle").getAttribute("aria-expanded"),
      payback: await dlg.locator('input[name="fillPayback"]').inputValue(),
      winEvery: await dlg.locator('input[name="fillWinEvery"]').inputValue(),
      top: await dlg.locator('select[name="fillTop"]').inputValue(),
      shuffleOff: await dlg.locator(".lc-fill__shuffle").getAttribute("aria-disabled"),
    };
    // The top prize: a rare item (the default here; picked as a GM would).
    await dlg.locator('select[name="fillTop"]').selectOption("item.rare");
    await dlg.locator(".lc-fill__fill").click();
    // Foundry's confirm: the rows are the GM's.
    const confirm = gm.page.locator(".application.dialog").filter({ hasText: "Replace the" }).last();
    await confirm.waitFor({ timeout: 8000 });
    out.confirmAsk = (await confirm.locator(".window-content").textContent()).replace(/\s+/g, " ").trim();
    await confirm.locator('button[data-action="yes"]').click();
    await gm.page.waitForFunction(() => /prizes filled in/.test(document.querySelector(".application.lc-dialog .lc-fill__said")?.textContent ?? ""), null, { timeout: 8000 });
    const read = async () => ({
      rows: await rowsOf(dlg),
      readout: (await dlg.locator(".lc-scratch-form__readout").textContent()).trim(),
      payback: (await dlg.locator(".lc-scratch-form__payback").textContent()).trim(),
      said: (await dlg.locator(".lc-fill__said").textContent()).trim(),
    });
    out.filled = await read();
    if (shot) await gm.page.screenshot({ path: shot });
    const dialogsBefore = await gm.page.locator(".application.dialog").count();
    await dlg.locator(".lc-fill__shuffle").click();
    await gm.page.waitForFunction(() => /^Shuffled/.test(document.querySelector(".application.lc-dialog .lc-fill__said")?.textContent ?? ""), null, { timeout: 8000 });
    out.shuffled = await read();
    out.secondConfirm = (await gm.page.locator(".application.dialog").count()) > dialogsBefore;
    await dlg.locator('input[name="showLeft"]').uncheck();
    const known = await gm.page.evaluate(() => Object.keys(game.settings.get("loot-crates", "boxes")));
    await dlg.locator('button[data-action="ok"]').click();
    out.made = await gm.page.evaluate(async ({ base, known }) => {
      const store = await import(base + "scripts/foundry/store.js");
      const fresh = () => Object.values(store.getBoxes()).filter(b => !known.includes(b.id));
      await __lc.until(() => fresh().length && !__lc.dialog(), 8000);
      const b = fresh()[0];
      return b ? { id: b.id, kind: b.kind, price: b.price, showLeft: b.showLeft, roll: b.roll, pools: b.pools, keys: Object.keys(b) } : null;
    }, { base: MODULE_BASE, known });
    boxId = out.made?.id ?? null;
    if (!boxId) throw new Error("no scratch ticket was added");

    // 2. One Buy as the player, opened with Reveal all.
    out.playerCard = await untilCard(pl.page, boxId, c => c.shown && /Top prize/.test(c.text) && !c.off, 8000);
    const before = out.playerCard;
    await pl.page.evaluate(() => { __lc.seen.length = 0; });
    await pl.page.locator(`#loot-crates-shop .lc-box__buy[data-box="${boxId}"]`).click();
    await pl.page.locator(".application.lc-reveal .lc-scratch__all").last().click({ timeout: 15000 });
    out.landed = await pl.page.waitForSelector(".application.lc-reveal .lc-scratch--landed", { timeout: 15000 }).then(() => true).catch(() => false);
    const after = await untilCard(pl.page, boxId, c => c.rows === before.rows + 1, 15000);
    out.bought = { before: before.purseCp, after: after.purseCp };
    out.message = await pl.page.evaluate(({ boxId }) => {
      const m = __lc.seen.find(x => x.type === "reveal" && x.box?.id === boxId);
      if (!m) return null;
      return { has: { left: "left" in m, stateBefore: "stateBefore" in m, scratch: !!m.stateBefore && "scratch" in m.stateBefore }, ticket: m.ticket, keys: Object.keys(m).sort(), json: JSON.stringify(m).length, counts: /"left"|"sold"|"no":/.test(JSON.stringify(m)) };
    }, { boxId });
    out.reveal = await pl.page.evaluate(() => {
      const rv = [...document.querySelectorAll(".application.lc-reveal")].pop();
      return { foot: rv?.querySelector(".lc-scratch__roll")?.textContent.trim() ?? null, result: rv?.querySelector(".lc-reveal__result")?.innerText.replace(/\s+/g, " ").trim() ?? null };
    });
    // The remaining limit, noted: can this player's client read the Pull log?
    out.playerReadsLog = await pl.page.evaluate(({ boxId }) => {
      try { return { rows: (game.settings.get("loot-crates", "pullLog") ?? []).filter(r => r.boxId === boxId).length }; } catch (err) { return { error: String(err) }; }
    }, { boxId });
    await pl.page.evaluate(() => __lc.closeReveals());
    await gm.page.evaluate(() => __lc.closeReveals());

    // 3. The GM refunds the ticket from the Pull log: Refund, Yes.
    const rowId = await gm.page.evaluate(async ({ base, boxId }) => (await import(base + "scripts/foundry/store.js")).getLog().find(x => x.boxId === boxId)?.id ?? null, { base: MODULE_BASE, boxId });
    out.refund = await gm.page.evaluate(async ({ base, rowId }) => {
      const store = await import(base + "scripts/foundry/store.js");
      __lc.click(__lc.app.element.querySelector('.lc-tabs [data-tab="log"]'));
      const btn = () => __lc.app.element?.querySelector(`button[data-action=refund][data-row="${rowId}"]`);
      if (!await __lc.until(() => __lc.app.tab === "log" && btn(), 8000)) throw new Error("the Pull log has no Refund for the ticket");
      __lc.click(btn());
      const dialog = () => [...document.querySelectorAll(".application.dialog")].pop();
      const yes = () => [...(dialog()?.querySelectorAll("button") ?? [])].find(b => /yes/i.test(b.dataset.action ?? b.textContent));
      await __lc.until(() => yes());
      __lc.click(yes());
      await __lc.until(() => store.getLog().find(r => r.id === rowId)?.refunded, 8000);
      return { refunded: !!store.getLog().find(r => r.id === rowId)?.refunded };
    }, { base: MODULE_BASE, rowId });
    out.afterRefund = await untilCard(pl.page, boxId, c => c.purseCp === before.purseCp, 8000);

    const oneIn = out.filled.readout.match(/^1 in ([\d.]+) tickets wins/)?.[1];
    const pct = s => Number(s.match(/Pays back (\d+)% in coins/)?.[1]);
    out.checks = {
      fields: out.fields.expanded === "true" && out.fields.payback === "65" && out.fields.winEvery === "3.5" && out.fields.shuffleOff === "true",
      confirmed: /Replace the \d+ prizes in the list with a new list\?/.test(out.confirmAsk ?? ""),
      filled: JSON.stringify(out.filled.rows) !== JSON.stringify(startRows) && out.filled.rows[0] === "1 item.rare:" && /prizes filled in/.test(out.filled.said),
      oneIn35: Number(oneIn) >= 3.3 && Number(oneIn) <= 3.7 && /the top prize \(Rare item\) 1 in 100/.test(out.filled.readout),
      payback65: Math.abs(pct(out.filled.payback) - 65) <= 3 && Math.abs(pct(out.shuffled.payback) - 65) <= 3,
      shuffled: JSON.stringify(out.shuffled.rows) !== JSON.stringify(out.filled.rows) && !out.secondConfirm,
      saved: out.made.kind === "scratch" && out.made.price === 5 && out.made.showLeft === false && out.made.roll?.size === 100
        && JSON.stringify(out.made.roll.prizes.map(lineText)) === JSON.stringify(out.shuffled.rows) && !out.made.keys.some(k => k.startsWith("fill")),
      playerHidden: out.playerCard.stock === null && !out.playerCard.prizes && /Top prize: Rare item/.test(out.playerCard.text),
      landed: out.landed && out.bought.after !== null && out.reveal.foot === "Roll 1",
      noCountsSent: !!out.message && !out.message.has.left && !out.message.has.scratch && !out.message.counts && JSON.stringify(out.message.ticket) === JSON.stringify({ rollId: 1, hidden: true }),
      refunded: out.refund.refunded && out.afterRefund.ms != null && out.afterRefund.purseCp === before.purseCp,
    };
    out.ok = Object.values(out.checks).every(Boolean);
    out.gmConsole = gm.logs.filter(l => !l.includes("timings"));
    out.playerLog = pl.logs;
  } catch (err) {
    out.error = String(err?.stack || err);
    out.ok = false;
  } finally {
    // The ticket refunded, the game this run made deleted, the shop as it was.
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
        for (const a of [...foundry.applications.instances.values()]) if (a.element?.classList.contains("lc-dialog")) a.close();
        return { refunded, gone: !store.getBoxes()[boxId], open: store.isShopOpen() };
      }, { base: MODULE_BASE, boxId, shopOpen }) : null;
    } catch (err) { out.restored = { error: String(err) }; out.ok = false; }
    if (out.restored && (out.restored.error || !out.restored.gone || out.restored.refunded.some(s => s !== "refunded"))) out.ok = false;
    try { await pl?.page.evaluate(() => { for (const a of [...foundry.applications.instances.values()]) if (/loot-crates/.test(a.id) || a.element?.classList.contains("lc-reveal")) a.close(); }); } catch { /* closing */ }
    console.log(JSON.stringify(out, (k, v) => (k === "items" && Array.isArray(v) ? v.length : v), 1));
    if (!out.ok) process.exitCode = 1;
    await browser.close();
  }
})();
