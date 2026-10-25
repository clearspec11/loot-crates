// Live check: "Make a crate" from a roll table (B1), with the branch's code
// on both ends.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/headless/live-table-crate.cjs [--shot out.png]
//
// Env: PLAYER (default Player2, must own Crate Tester).
//
// Seeds a world roll table "Live loot table": two compendium items at
// weights 1 and 99, a nested table "Live loot table (nested)" at weight 100
// holding one more item, and a text result "You find nothing" at weight 100.
// Then, as a GM does:
//
//   1. Opens the Roll Tables sidebar tab, right-clicks the table and clicks
//      "Make a crate" in Foundry's own context menu. The branch's menu entry
//      is the one main.js adds (Foundry builds a directory's menu once, at
//      its first render, before this page could load the branch, so the
//      entry joins that same menu's items).
//   2. The crate editor opens on an unsaved draft: "New box", named for the
//      table, the price focused, "Use the table's odds" picked with the
//      rarity weights hidden, the copy note "Copied from Live loot table (3
//      items, 1 nested table flattened)", "Count text results as nothing"
//      unticked with the text's share (33%). A pool named for the table
//      holds the three items at 1, 99 and 100 (the nested table's weight
//      multiplied through). Types "1 gp" in the price and presses Add to shelf.
//   3. Player2's shop shows the crate's card naming both items with the
//      chances shopOdds gives them, and no rarity pills. Player2 presses Buy
//      once and closes the reveal when it lands.
//   4. The GM opens the Pull log by its tab, presses the row's Refund and Yes.
//
// In a finally: anything not refunded is refunded through the module's own
// refund, then the crate, its pool and both seeded tables are deleted. One
// real purchase per run. Needs Crate Tester in "Loot Crates Test".
/* global game, Hooks, RollTable, foundry, __lc */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const TABLE = "Live loot table";
const shot = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : null;

async function join(browser, user) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // The Roll Tables directory builds its context menu once, at its first
  // render, from the get<Document>ContextOptions hook. Keep the array it
  // builds, so the branch's entry can join it once the branch is loaded.
  await context.addInitScript(() => {
    const t = setInterval(() => {
      if (!globalThis.Hooks?.on) return;
      clearInterval(t);
      globalThis.Hooks.on("getRollTableContextOptions", (_app, options) => { (globalThis.__lcTableMenus ??= []).push(options); });
    }, 5);
  });
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
    const store = await import(base + "scripts/store.js");
    try { store.registerSettings(); } catch { /* the installed module registered them */ }
    try { store.registerIndexFields?.(); } catch { /* already in CONFIG */ }
    const socket = await import(base + "scripts/socket.js");
    socket.registerSocket();
    const { storeRedraw } = await import(base + "scripts/redraw.js");
    const { refreshShop, registerShopHooks } = await import(base + "scripts/shop.js");
    const { refreshManager, makeCrateMenuEntry } = await import(base + "scripts/manager.js");
    const redraw = storeRedraw({ refreshShop, refreshManager });
    store.setStoreListener(redraw);
    for (const key of store.WORLD_KEYS) {
      const cfg = game.settings.settings.get(`loot-crates.${key}`);
      if (cfg && !String(cfg.onChange ?? "").includes("storeChanged")) cfg.onChange = () => redraw(key);
    }
    registerShopHooks?.(Hooks);
    // main.js's hook: the entry in every Roll Tables menu, built or to come.
    // The installed module (1.0.0 from GitHub on cc-dev) adds its own "Make
    // a crate" through the same hook, so the branch's takes its place: one
    // entry, the branch's, as a world running only the branch would have.
    const swap = options => {
      for (let i = options.length - 1; i >= 0; i--) if ((options[i]?.label ?? options[i]?.name) === "Make a crate") options.splice(i, 1);
      options.push(makeCrateMenuEntry());
    };
    for (const options of globalThis.__lcTableMenus ?? []) swap(options);
    Hooks.on("getRollTableContextOptions", (_app, options) => swap(options));
  }, MODULE_BASE);
  return { page, logs };
}

const GM_HELPERS = `
  globalThis.__lc = globalThis.__lc ?? {};
  __lc.wait = ms => new Promise(r => setTimeout(r, ms));
  __lc.until = async (fn, ms = 15000) => { for (let t = 0; t < ms && !fn(); t += 50) await __lc.wait(50); return fn(); };
  __lc.dialog = () => [...document.querySelectorAll(".application.lc-dialog")].pop() ?? null;
  __lc.field = name => __lc.dialog()?.querySelector('[name="' + name + '"]') ?? null;
  __lc.manager = () => document.getElementById("loot-crates-manager");
`;

(async () => {
  const browser = await chromium.launch();
  const out = { player: PLAYER, seeded: null, created: { boxes: [], pools: [] }, rows: [] };
  let gm = null;
  try {
    const pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");
    await gm.page.evaluate(GM_HELPERS);

    // Seed the table: three loot items from dnd5e's SRD pack, the jackpot a rare.
    out.seeded = await gm.page.evaluate(async ({ base, name }) => {
      const store = await import(base + "scripts/store.js");
      const { toCopper } = await import(base + "scripts/currency.js");
      const pack = game.packs.get("dnd5e.items");
      const index = await pack.getIndex({ fields: ["system.rarity", "system.rarities", "type"] });
      const rows = [...index].filter(r => store.isLootType(r.type));
      const rarityOf = r => String([...(r.system?.rarities ?? [])][0] ?? r.system?.rarity ?? "");
      const rare = rows.find(r => rarityOf(r) === "rare");
      const commons = rows.filter(r => r !== rare && (rarityOf(r) === "common" || rarityOf(r) === "")).slice(0, 2);
      if (!rare || commons.length < 2) throw new Error("dnd5e.items has no rare and two common loot items");
      const uuid = r => `Compendium.dnd5e.items.Item.${r._id}`;
      const doc = (r, weight, range) => ({ type: "document", documentUuid: uuid(r), weight, range, name: r.name, img: r.img });
      for (const t of game.tables.filter(t => t.name === name || t.name === `${name} (nested)`)) await t.delete();
      const nested = await RollTable.create({ name: `${name} (nested)`, formula: "1d1", results: [doc(commons[1], 1, [1, 1])] });
      const table = await RollTable.create({ name, formula: "1d300", results: [
        doc(rare, 1, [1, 1]),
        doc(commons[0], 99, [2, 100]),
        { type: "document", documentUuid: nested.uuid, weight: 100, range: [101, 200], name: nested.name },
        { type: "text", description: "You find nothing", name: "You find nothing", weight: 100, range: [201, 300] },
      ] });
      const actor = game.actors.find(a => a.type === "character" && a.name === "Crate Tester" && a.folder?.name === "Loot Crates Test");
      if (!actor) throw new Error("no Crate Tester in Loot Crates Test");
      if (toCopper(actor.system.currency) < 100) await actor.update({ "system.currency.gp": 1000 });
      return {
        tableId: table.id, tableUuid: table.uuid, nestedId: nested.id,
        items: { jackpot: rare.name, common: commons[0].name, nested: commons[1].name },
        boxIds: Object.keys(store.getBoxes()), poolIds: Object.keys(store.getPools()), shopOpen: store.isShopOpen(),
        actorId: actor.id, logIds: store.getLog().map(r => r.id), purseCp: toCopper(actor.system.currency), items0: actor.items.filter(i => !i.flags?.dnd5e?.cachedFor).length,
      };
    }, { base: MODULE_BASE, name: TABLE });

    // 1. The Roll Tables tab, a right-click on the table, "Make a crate".
    await gm.page.locator('#sidebar [data-tab="tables"]').first().click();
    const entry = gm.page.locator(`#tables .directory-item[data-entry-id="${out.seeded.tableId}"]`);
    await entry.waitFor({ timeout: 10000 });
    await entry.click({ button: "right" });
    const item = gm.page.locator("#context-menu .context-item", { hasText: "Make a crate" });
    await item.waitFor({ timeout: 5000 });
    out.menu = await gm.page.$$eval("#context-menu .context-item", els => els.map(e => e.textContent.trim()));
    await item.click();

    // 2. The editor on the draft.
    out.editor = await gm.page.evaluate(async ({ base, before }) => {
      const store = await import(base + "scripts/store.js");
      await __lc.until(() => __lc.dialog()?.querySelector('input[name="price"]'), 15000);
      await __lc.wait(500);
      const d = __lc.dialog();
      const pool = Object.values(store.getPools()).find(p => !before.poolIds.includes(p.id));
      const checked = [...d.querySelectorAll('input[name^="pool."]')].filter(i => i.checked).map(i => i.name.slice(5));
      return {
        title: d.querySelector(".window-title")?.textContent.trim(),
        name: __lc.field("name")?.value,
        priceFocused: document.activeElement === __lc.field("price"),
        mode: d.querySelector('input[name="oddsMode"]:checked')?.value,
        weightsHidden: !!d.querySelector(".lc-form__weights")?.hidden,
        note: d.querySelector(".lc-form__from")?.textContent.trim(),
        nothing: { there: !!__lc.field("countNothing"), checked: !!__lc.field("countNothing")?.checked, hint: d.querySelector(".lc-form__nothing .lc-form__hint")?.textContent.trim() },
        preview: d.querySelector(".lc-form__preview")?.textContent.replace(/\s+/g, " ").trim(),
        okLabel: d.querySelector('button[data-action="ok"]')?.textContent.trim(),
        pool: pool ? { id: pool.id, name: pool.name, weights: Object.fromEntries(pool.entries.map(e => [e.name, e.weight])) } : null,
        checked,
        boxes: Object.keys(store.getBoxes()).length,
      };
    }, { base: MODULE_BASE, before: out.seeded });
    if (out.editor.pool) out.created.pools.push(out.editor.pool.id);
    await gm.page.locator(".application.lc-dialog").last().locator('input[name="price"]').fill("1 gp");
    await gm.page.locator(".application.lc-dialog").last().locator('button[data-action="ok"]').click();
    out.saved = await gm.page.evaluate(async ({ base, before }) => {
      const store = await import(base + "scripts/store.js");
      const { shopOdds } = await import(base + "scripts/odds.js");
      const fresh = () => Object.values(store.getBoxes()).filter(b => !before.boxIds.includes(b.id));
      await __lc.until(() => fresh().length && !__lc.dialog(), 10000);
      await __lc.wait(400);
      const box = fresh()[0] ?? null;
      const odds = box ? shopOdds(box, store.getPools()) : null;
      return { boxes: fresh().map(b => structuredClone(b)), expected: odds?.items?.map(i => ({ name: i.name, label: i.label })) ?? [], status: __lc.manager()?.querySelector(".lc-manager__status")?.textContent ?? null };
    }, { base: MODULE_BASE, before: out.seeded });
    out.created.boxes.push(...out.saved.boxes.map(b => b.id));
    const box = out.saved.boxes[0] ?? null;
    if (shot) await gm.page.screenshot({ path: shot });

    // 3. Player2's shop: the card names the items; one real Buy.
    out.card = box ? await pl.page.evaluate(async ({ base, id }) => {
      const { openShop } = await import(base + "scripts/shop.js");
      const actor = game.actors.find(a => a.isOwner && a.type === "character" && a.name === "Crate Tester");
      if (!actor) throw new Error(`${game.user.name} doesn't own Crate Tester`);
      const app = openShop();
      const card = () => app.element?.querySelector(`.lc-box[data-box="${id}"]`);
      for (let t = 0; t < 200 && !card(); t++) await new Promise(r => setTimeout(r, 50));
      const pick = app.element.querySelector(".lc-shop__actor");
      if (pick && pick.value !== actor.id) { pick.value = actor.id; pick.dispatchEvent(new Event("change")); await new Promise(r => setTimeout(r, 800)); }
      const c = card();
      return c ? {
        lines: [...c.querySelectorAll(".lc-chance")].map(l => ({ name: l.querySelector(".lc-chance__name")?.textContent.trim(), label: l.querySelector(".lc-chance__pct")?.textContent.trim() })),
        pills: c.querySelectorAll(".lc-odd").length,
        buy: c.querySelector(".lc-box__buy")?.textContent.replace(/\s+/g, " ").trim(),
        off: c.querySelector(".lc-box__buy")?.getAttribute("aria-disabled") === "true",
      } : null;
    }, { base: MODULE_BASE, id: box.id }) : null;
    if (box && out.card && !out.card.off) {
      await pl.page.locator(`#loot-crates-shop .lc-box[data-box="${box.id}"] .lc-box__buy`).click();
      out.pull = await pl.page.evaluate(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const until = async (fn, ms = 20000) => { for (let t = 0; t < ms && !fn(); t += 50) await wait(50); return fn(); };
        const closeBtn = () => [...document.querySelectorAll(".lc-reveal")].pop()?.querySelector('[data-action="dismiss"]');
        const landed = await until(() => closeBtn(), 20000);
        const result = [...document.querySelectorAll(".lc-reveal")].pop()?.querySelector(".lc-reveal__result")?.textContent.replace(/\s+/g, " ").trim() ?? "";
        return { landed: !!landed, result };
      });
      if (out.pull.landed) { await pl.page.waitForTimeout(700); await pl.page.locator(".lc-reveal [data-action=\"dismiss\"]").last().click(); }
      out.afterPull = await gm.page.evaluate(async ({ base, before, boxId }) => {
        const store = await import(base + "scripts/store.js");
        const { toCopper } = await import(base + "scripts/currency.js");
        await __lc.until(() => store.getLog().some(r => !before.logIds.includes(r.id)), 8000);
        await __lc.wait(300);
        const actor = game.actors.get(before.actorId);
        return {
          rows: store.getLog().filter(r => !before.logIds.includes(r.id)).map(r => ({ id: r.id, boxId: r.boxId, name: r.name, price: r.price, itemId: r.itemId })),
          purseCp: toCopper(actor.system.currency), items: actor.items.filter(i => !i.flags?.dnd5e?.cachedFor).length,
          stock: store.getBoxes()[boxId]?.rules?.stock ?? null,
        };
      }, { base: MODULE_BASE, before: out.seeded, boxId: box.id });
      out.rows.push(...out.afterPull.rows.map(r => r.id));

      // 4. The Pull log's Refund, as a GM presses it.
      const row = out.afterPull.rows[0];
      if (row) {
        await gm.page.locator('#loot-crates-manager .lc-tabs [data-tab="log"]').click();
        const refund = gm.page.locator(`#loot-crates-manager [data-action="refund"][data-row="${row.id}"]`);
        await refund.waitFor({ timeout: 8000 });
        await refund.click();
        const yes = gm.page.locator('.application.dialog button[data-action="yes"]').last();
        await yes.waitFor({ timeout: 8000 });
        out.refundDialog = (await gm.page.locator(".application.dialog .window-content").last().textContent())?.replace(/\s+/g, " ").trim();
        await yes.click();
        out.refunded = await gm.page.evaluate(async ({ base, before, id }) => {
          const store = await import(base + "scripts/store.js");
          const { toCopper } = await import(base + "scripts/currency.js");
          await __lc.until(() => store.getLog().find(r => r.id === id)?.refunded, 8000);
          await __lc.wait(400);
          const actor = game.actors.get(before.actorId);
          return { refunded: !!store.getLog().find(r => r.id === id)?.refunded, purseCp: toCopper(actor.system.currency), items: actor.items.filter(i => !i.flags?.dnd5e?.cachedFor).length };
        }, { base: MODULE_BASE, before: out.seeded, id: row.id });
      }
    } else out.pull = { skipped: !box ? "no crate was made" : !out.card ? "no card in the player's shop" : "the card's Buy is off" };

    const e = out.editor, s = out.seeded, it = s.items;
    const expected = Object.fromEntries(out.saved.expected.map(x => [x.name, x.label]));
    const lines = Object.fromEntries((out.card?.lines ?? []).map(x => [x.name, x.label]));
    out.checks = {
      menu: out.menu.includes("Make a crate"),
      editor: e.title === "New box" && e.name === TABLE && e.priceFocused && e.okLabel === (s.shopOpen ? "Add to shelf" : "Add"),
      tableOdds: e.mode === "weight" && e.weightsHidden && /Use the table's odds|\d+%/.test(e.preview ?? ""),
      copyNote: e.note === `Copied from ${TABLE} (3 items, 1 nested table flattened); edit the table and make the crate again to pick up changes.`,
      nothingOffer: e.nothing.there && !e.nothing.checked && /33%/.test(e.nothing.hint ?? ""),
      pool: !!e.pool && e.pool.name === TABLE && e.pool.weights[it.jackpot] === 1 && e.pool.weights[it.common] === 99 && e.pool.weights[it.nested] === 100 && Object.keys(e.pool.weights).length === 3 && e.checked.length === 1 && e.checked[0] === e.pool.id,
      noWriteWhileOpen: e.boxes === s.boxIds.length,
      saved: !!box && out.saved.boxes.length === 1 && box.price === 1 && box.rules?.oddsMode === "weight" && box.rules?.missChance == null && box.pools?.length === 1 && box.pools[0].id === e.pool?.id && box.fromTable?.name === TABLE,
      card: !!out.card && out.card.pills === 0 && lines[it.jackpot] === expected[it.jackpot] && lines[it.common] === expected[it.common] && !!lines[it.jackpot] && !!lines[it.common] && !/0%$/.test(lines[it.jackpot].replace("<1%", "")),
      pulled: out.pull.skipped ? "skipped" : out.pull.landed && out.afterPull.rows.length === 1 && out.afterPull.rows[0].boxId === box.id && out.afterPull.purseCp === s.purseCp - 100,
      refunded: out.pull.skipped ? "skipped" : !!out.refunded?.refunded && out.refunded.purseCp === s.purseCp && out.refunded.items === s.items0,
    };
    out.ok = Object.values(out.checks).every(v => v === true || v === "skipped") && out.pull.skipped == null;
    out.gmConsole = gm.logs.filter(l => !l.includes("timings"));
    out.playerLog = pl.logs.filter(l => !l.includes("timings"));
  } catch (err) {
    out.error = String(err?.stack || err);
    out.ok = false;
  } finally {
    try {
      out.restored = gm ? await gm.page.evaluate(async ({ base, created, rows, seeded, name }) => {
        const store = await import(base + "scripts/store.js");
        const { refundPull } = await import(base + "scripts/refund.js");
        const refunded = [];
        for (const id of rows) if (!store.getLog().find(r => r.id === id)?.refunded) { try { refunded.push({ id, status: (await refundPull(id))?.status ?? "done" }); } catch (err) { refunded.push({ id, error: String(err) }); } }
        for (const id of created.boxes) if (store.getBoxes()[id]) await store.removeBox(id);
        // The crate's pool, and any pool named for the table this run made.
        const pools = new Set([...created.pools, ...Object.values(store.getPools()).filter(p => p.name === name && !(seeded?.poolIds ?? []).includes(p.id)).map(p => p.id)]);
        for (const id of pools) if (store.getPools()[id]) await store.removePool(id);
        const tables = game.tables.filter(t => t.name === name || t.name === `${name} (nested)`);
        for (const t of tables) await t.delete();
        for (const app of foundry.applications.instances.values()) if (app.id === "loot-crates-manager" || app.options?.classes?.includes("lc-dialog")) { try { await app.close(); } catch { /* closed */ } }
        return { refunded, boxes: created.boxes, pools: [...pools], tables: tables.length };
      }, { base: MODULE_BASE, created: out.created, rows: out.rows, seeded: out.seeded, name: TABLE }) : null;
    } catch (err) { out.restored = { error: String(err) }; }
    // The world's ids were for the cleanup; the report counts them.
    if (out.seeded) out.seeded = { ...out.seeded, boxIds: out.seeded.boxIds.length, poolIds: out.seeded.poolIds.length, logIds: out.seeded.logIds.length };
    console.log(JSON.stringify(out, null, 1));
    if (!out.ok) process.exitCode = 1;
    await browser.close();
  }
})();
