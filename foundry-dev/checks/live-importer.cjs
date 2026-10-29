// Live check: a crate whose only prize is an item Plutonium imported lands on the sheet with no "Use Importer?" prompt on the GM's screen, and its refund takes it back.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/checks/live-importer.cjs
//   (or: npm run live -- live-importer)
//
// Env: PLAYER (default Player2, must own Crate Tester), PACK (default
// world.imps, the compendium Plutonium filled).
//
// Plutonium's preCreateItem hook cancels the creation of any item it
// imported (flags.plutonium.propDroppable) on an actor unless it carries
// isStandardDragDrop, and in its "prompt" mode opens "Import via
// Plutonium?" on the client that creates it: the GM's, mid-spin, naming the
// prize. The core marks every grant with that opt-out (kinds.js
// readyToGrant) and treats a cancelled creation as a failed grant.
//
// Two headless clients, the Gamemaster and the player, each with the
// installed module's socket listener and createItem seal removed and the
// branch's registered from MODULE_BASE (as live-well.cjs does). Then:
//
//   0. The GM picks the first loot-type item in PACK carrying
//      flags.plutonium.propDroppable "item" (if PACK is missing or holds
//      none, the check reports `unavailable` and changes nothing), and
//      saves a pool "Live importer pool" holding that one item and a 1 gp
//      crate "Live importer crate" drawing only from it. A watcher on the
//      GM's page records every element added to the page whose text is
//      Plutonium's prompt, for the whole run.
//   1. Control, so a pass means something: the GM creates the same item
//      on Crate Tester the plain way, without the opt-out. With Plutonium's
//      prompt mode on, its prompt must appear (the watcher sees it) and the
//      creation must make nothing; the prompt is then closed with its own
//      close control (closing it imports nothing) and the watcher reset.
//      In another mode the control reports which, and the run goes on.
//   2. The player opens the shop, picks Crate Tester and presses the
//      crate's Buy, waits for the strip to land (.lc-card--landed) and
//      closes the reveal. The watcher must have seen nothing on the GM's
//      page; the purse must have dropped by 1 gp; the Pull log's new row
//      must name the item in itemId and itemIds; the item must be on
//      Crate Tester's sheet with flags.plutonium.isStandardDragDrop true
//      and its other Plutonium flags kept, and be the only new copy of it
//      (Plutonium made none of its own).
//   3. The GM opens the manager's Pull log by clicking its tab, presses the
//      row's Refund and Yes. The item must be gone from the sheet, no copy
//      of it left over, and the purse back where it started.
//
// Restored in finally: the crate goes back to what it was before the run,
// or is taken off the shelf if the run made it; the pool stays seeded. One
// real 1 gp purchase, refunded; nothing else is deleted.
/* global game, foundry, Hooks, fromUuid -- used inside page.evaluate, which runs in the Foundry page */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const PACK = process.env.PACK || "world.imps";
const POOL = "Live importer pool";
const CRATE = "Live importer crate";

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

// The GM's side: find the item, seed the pool and crate, start the watcher.
async function seed(gm) {
  return gm.evaluate(async ({ base, pack: packId, poolName, crateName }) => {
    const store = await import(base + "scripts/foundry/store.js");
    const { toCopper } = await import(base + "scripts/core/currency.js");
    const folder = game.folders.find(f => f.type === "Actor" && f.name === "Loot Crates Test");
    const actor = game.actors.find(a => a.name === "Crate Tester" && a.folder?.id === folder?.id);
    if (!actor) throw new Error("no Crate Tester in Loot Crates Test: run live-pull.js first");
    const plutonium = !!game.modules.get("plutonium")?.active;
    const pack = game.packs.get(packId);
    if (!pack) return { unavailable: `no ${packId} compendium in this world` };
    const index = await pack.getIndex({ fields: ["flags.plutonium", "type"] });
    const hit = index.find(e => e.flags?.plutonium?.propDroppable === "item" && store.isLootType(e.type));
    if (!hit) return { unavailable: `${packId} holds no loot-type item Plutonium imported` };
    const source = await fromUuid(hit.uuid);
    const entry = store.entryFromItem(source, hit.uuid);
    if ((actor.system.currency.gp ?? 0) < 5) await actor.update({ "system.currency.gp": 1000 });
    const oldPool = Object.values(store.getPools()).find(p => p.name === poolName);
    const pool = await store.savePool({ ...(oldPool ? { id: oldPool.id } : {}), name: poolName, entries: [entry], pools: [] });
    const old = Object.values(store.getBoxes()).find(b => b.name === crateName) ?? null;
    const crate = await store.saveBox({
      ...(old ? { id: old.id } : {}), name: crateName, price: 1, pools: [{ id: pool.id, share: 1 }],
      weights: { [entry.rarity]: 100 }, rules: { pity: null, noDuplicates: false, stock: null, shelved: true },
    });
    // Every element the page gains whose text is Plutonium's prompt ("Import
    // via Plutonium?", "Yes, use the importer", "Use Importer when
    // Drag-Dropping Items to Actors"), from now. Not "importer" alone: the
    // crate's own name says it, on its chat card.
    const PROMPT = /import via|use the importer|use importer/i;
    globalThis.__lcImporterPrompt = PROMPT;
    globalThis.__lcImporterSeen = [];
    globalThis.__lcImporterWatch?.disconnect();
    const watch = new MutationObserver(list => {
      for (const m of list) for (const el of m.addedNodes) {
        if (!(el instanceof HTMLElement)) continue;
        const text = el.textContent ?? "";
        if (PROMPT.test(text) && !el.closest(".loot-crates, .chat-message, #chat-log")) globalThis.__lcImporterSeen.push({ at: Date.now(), cls: String(el.className).slice(0, 80), dialog: el.matches(".application.dialog, .dialog, [role=dialog]") || !!el.querySelector(".application.dialog, .dialog, [role=dialog]"), text: text.replace(/\s+/g, " ").trim().slice(0, 160) });
      }
    });
    watch.observe(document.body, { childList: true, subtree: true });
    globalThis.__lcImporterWatch = watch;
    const copies = actor.items.filter(i => i.name === source.name).map(i => i.id);
    return {
      actorId: actor.id, plutonium, item: { uuid: hit.uuid, name: source.name, rarity: entry.rarity, flags: foundry.utils.deepClone(source.flags?.plutonium ?? null) },
      poolId: pool.id, crateId: crate.id, old, copies, purseCp: toCopper(actor.system.currency), logIds: store.getLog().map(r => r.id),
      mode: (() => { try { return globalThis.Config?.get?.("import", "dragDropMode") ?? null; } catch { return null; } })(),
    };
  }, { base: MODULE_BASE, pack: PACK, poolName: POOL, crateName: CRATE });
}

// The control: the same item created the plain way, without the opt-out.
async function control(gm, before) {
  return gm.evaluate(async ({ before }) => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const PROMPT = globalThis.__lcImporterPrompt;
    const actor = game.actors.get(before.actorId);
    const source = await fromUuid(before.item.uuid);
    const data = source.toObject();
    delete data._id;
    const made = await actor.createEmbeddedDocuments("Item", [data]);
    for (let t = 0; t < 4000 && !globalThis.__lcImporterSeen.length; t += 100) await wait(100);
    const seen = [...globalThis.__lcImporterSeen];
    // Closed by its own close control: Plutonium imports nothing then.
    let closed = false;
    for (const app of [...foundry.applications.instances.values()]) {
      if (!PROMPT.test(app.element?.textContent ?? "")) continue;
      await app.close();
      closed = true;
    }
    if (!closed) {
      for (const el of document.querySelectorAll(".application, .dialog, .window-app")) {
        if (!PROMPT.test(el.textContent ?? "")) continue;
        const x = el.querySelector('[data-action="close"], .header-control.close, .close');
        if (x) { x.click(); closed = true; }
      }
    }
    await wait(1500);
    const leftover = actor.items.filter(i => i.name === source.name && !before.copies.includes(i.id)).map(i => i.id);
    // Nothing should have been made; anything this control made is its own to take back.
    if (leftover.length) await actor.deleteEmbeddedDocuments("Item", leftover);
    globalThis.__lcImporterSeen = [];
    return { created: made.length, prompt: seen.length > 0, seen, closed, leftover };
  }, { before });
}

async function restore(gm, before) {
  if (!gm || !before?.crateId) return null;
  return gm.evaluate(async ({ base, before }) => {
    const out = {};
    try {
      globalThis.__lcImporterWatch?.disconnect();
      const store = await import(base + "scripts/foundry/store.js");
      if (before.old) { await store.saveBox(before.old); out.crate = "restored"; }
      else {
        const c = store.getBoxes()[before.crateId];
        if (c) { await store.saveBox({ ...c, rules: { ...c.rules, shelved: false } }); out.crate = "taken off the shelf (new this run)"; }
      }
    } catch (err) { out.error = String(err?.stack || err); }
    return out;
  }, { base: MODULE_BASE, before });
}

(async () => {
  const browser = await chromium.launch();
  const out = { player: PLAYER, pack: PACK };
  let gm = null, pl = null, before = null;
  try {
    pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");
    before = await seed(gm.page);
    if (before.unavailable) {
      out.unavailable = before.unavailable;
      out.ok = null;
      return;
    }
    out.before = { item: before.item, plutonium: before.plutonium, mode: before.mode, purseCp: before.purseCp, copies: before.copies.length };

    // 1. The control.
    out.control = await control(gm.page, before);

    // 2. The player buys the crate with its own Buy.
    out.buy = await pl.page.evaluate(async ({ base, crateId }) => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const until = async (fn, ms = 15000) => { for (let t = 0; t < ms && !fn(); t += 50) await wait(50); return fn(); };
      const { openShop } = await import(base + "scripts/foundry/shop.js");
      const actor = game.actors.find(a => a.isOwner && a.type === "character" && a.name === "Crate Tester");
      if (!actor) throw new Error(`${game.user.name} owns no Crate Tester`);
      const app = openShop();
      await until(() => app.element?.querySelector(".lc-shop__actor, .lc-box"));
      const pick = app.element.querySelector(".lc-shop__actor");
      if (pick && pick.value !== actor.id) { pick.value = actor.id; pick.dispatchEvent(new Event("change", { bubbles: true })); }
      const card = () => app.element?.querySelector(`.lc-box[data-box="${CSS.escape(crateId)}"]`);
      if (!await until(() => app.actorId === actor.id && card()?.querySelector(".lc-box__buy"))) throw new Error("no Live importer crate in the shop for Crate Tester");
      const buy = card().querySelector(".lc-box__buy");
      if (buy.getAttribute("aria-disabled") === "true") throw new Error(`the crate can't be bought: ${card().querySelector(".lc-box__why")?.textContent.trim()}`);
      const seen = new Set(document.querySelectorAll(".lc-reveal"));
      const t0 = performance.now();
      buy.focus();
      buy.click();
      let rv = null, revealMs = null, landedMs = null;
      for (let i = 0; i < 400 && landedMs == null; i++) {
        await wait(50);
        rv ??= [...document.querySelectorAll(".lc-reveal")].find(el => !seen.has(el)) ?? null;
        if (rv && revealMs == null) revealMs = Math.round(performance.now() - t0);
        if (rv?.querySelector(".lc-card--landed")) landedMs = Math.round(performance.now() - t0);
      }
      await wait(600);
      const result = {
        ms: { reveal: revealMs, landed: landedMs },
        landedName: rv?.querySelector(".lc-card--landed .lc-card__name")?.textContent.trim() ?? null,
        result: rv?.querySelector(".lc-reveal__result")?.innerText.replace(/\s+/g, " ").trim() ?? null,
        openItem: !!(rv?.querySelector(".lc-reveal__open") && !rv.querySelector(".lc-reveal__open").hidden),
        error: [...document.querySelectorAll("#notifications .notification.error")].map(n => n.textContent.trim()).slice(-1)[0] ?? null,
      };
      const revealApp = [...foundry.applications.instances.values()].find(a => a.element === rv);
      if (revealApp) await revealApp.close();
      await app.close();
      return result;
    }, { base: MODULE_BASE, crateId: before.crateId });

    out.granted = await gm.page.evaluate(async ({ base, before }) => {
      const store = await import(base + "scripts/foundry/store.js");
      const { toCopper } = await import(base + "scripts/core/currency.js");
      const actor = game.actors.get(before.actorId);
      const row = store.getLog().find(r => !before.logIds.includes(r.id) && r.boxId === before.crateId) ?? null;
      const item = row?.itemId ? actor.items.get(row.itemId) : null;
      const copies = actor.items.filter(i => i.name === before.item.name && !before.copies.includes(i.id)).map(i => i.id);
      return {
        row: row && { id: row.id, itemId: row.itemId, itemIds: row.itemIds ?? null, name: row.name, price: row.price },
        item: item && { id: item.id, name: item.name, plutonium: foundry.utils.deepClone(item.flags?.plutonium ?? null), lootCrates: foundry.utils.deepClone(item.flags?.["loot-crates"] ?? null) },
        newCopies: copies, purseCp: toCopper(actor.system.currency), importerSeen: [...globalThis.__lcImporterSeen],
      };
    }, { base: MODULE_BASE, before });

    // 3. The GM refunds it from the Pull log.
    const rowId = out.granted.row?.id;
    out.refund = rowId ? await gm.page.evaluate(async ({ base, before, rowId }) => {
      const { openManager } = await import(base + "scripts/foundry/manager.js");
      const store = await import(base + "scripts/foundry/store.js");
      const { toCopper } = await import(base + "scripts/core/currency.js");
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const until = async (fn, ms = 15000) => { for (let t = 0; t < ms && !fn(); t += 50) await wait(50); return fn(); };
      const click = el => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
      const actor = game.actors.get(before.actorId);
      const app = openManager();
      await until(() => app.element?.querySelector('.lc-tabs [data-tab="log"]'));
      click(app.element.querySelector('.lc-tabs [data-tab="log"]'));
      const btn = () => app.element?.querySelector(`button[data-action="refund"][data-row="${CSS.escape(rowId)}"]`);
      if (!await until(() => app.tab === "log" && btn(), 8000)) throw new Error("no Refund on the run's row in the Pull log");
      btn().focus();
      click(btn());
      const dialog = () => [...document.querySelectorAll(".application.dialog")].pop();
      const yes = () => [...(dialog()?.querySelectorAll("button") ?? [])].find(b => /yes/i.test(b.dataset.action ?? b.textContent));
      await until(() => yes());
      const dialogText = dialog()?.querySelector(".window-content")?.textContent.replace(/\s+/g, " ").trim() ?? null;
      click(yes());
      await until(() => store.getLog().find(r => r.id === rowId)?.refunded);
      await until(() => !actor.items.some(i => i.name === before.item.name && !before.copies.includes(i.id)), 5000);
      await app.close();
      return {
        dialogText, refunded: !!store.getLog().find(r => r.id === rowId)?.refunded,
        leftCopies: actor.items.filter(i => i.name === before.item.name && !before.copies.includes(i.id)).map(i => i.id),
        purseCp: toCopper(actor.system.currency), importerSeen: [...globalThis.__lcImporterSeen],
      };
    }, { base: MODULE_BASE, before, rowId }) : null;

    const g = out.granted;
    const pl0 = before.item.flags ?? {};
    out.checks = {
      noPromptDuringRun: g.importerSeen.length === 0 && (out.refund?.importerSeen.length ?? 0) === 0,
      landed: out.buy.ms.landed != null && out.buy.landedName === before.item.name,
      charged: g.purseCp === before.purseCp - 100,
      rowNamesItem: !!g.row?.itemId && Array.isArray(g.row.itemIds) && g.row.itemIds.length === 1 && g.row.itemIds[0] === g.row.itemId,
      itemOnSheet: !!g.item && g.item.name === before.item.name,
      optOutFlag: g.item?.plutonium?.isStandardDragDrop === true && g.item.plutonium.propDroppable === pl0.propDroppable && g.item.plutonium.hash === pl0.hash,
      onlyOurCopy: g.newCopies.length === 1 && g.newCopies[0] === g.item?.id,
      openItem: out.buy.openItem,
      refunded: !!out.refund?.refunded && out.refund.leftCopies.length === 0 && out.refund.purseCp === before.purseCp,
    };
    out.ok = Object.values(out.checks).every(Boolean);
  } catch (err) {
    out.error = String(err?.stack || err);
    out.ok = false;
  } finally {
    out.restored = await restore(gm?.page, before).catch(err => ({ error: String(err) }));
    out.gmLogs = gm?.logs.slice(-12) ?? [];
    out.playerLogs = pl?.logs.slice(-8) ?? [];
    await browser.close();
    console.log(JSON.stringify(out, null, 1));
    process.exit(out.ok === false ? 1 : 0);
  }
})();
