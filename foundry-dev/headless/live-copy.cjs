// Live check: Copy on a game's row of the manager's Boxes tab opens its
// editor on an unsaved copy (newgame.js copyOf), with the branch's code on
// both ends.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/headless/live-copy.cjs [--shot out.png]
//
// Env: PLAYER (default Player2, must own Crate Tester), BOX (default
// "Live UI crate", seeded by live-ui.js).
//
// Two headless clients, the Gamemaster and the player, each running the
// branch's code (as live-new-game.cjs does). Player2's shop is open on
// Crate Tester. Then, as a GM does, on the Boxes tab:
//
//   1. Click the crate's Copy: the dialog "Copy box" opens with the name
//      "<name> (copy)" focused and "Add to shelf" as its default button,
//      holding the source's price, pools and shares, weights and rules, with
//      no Restock (a draft has no record to fill); no record is written while
//      it is open and the player's shop shows no new card.
//   2. Press "Add to shelf": exactly one box is added with the same price,
//      pools, weights and rules (its stock full), the manager is on the Boxes
//      tab with focus on that row's Edit, the row marked new and in view, the
//      status line reads "<name> (copy) is on the shelf at <price>.", and the
//      player's shop shows its card within 2 s.
//   3. Player2 presses Buy on the copy once and closes the reveal when it
//      lands: one row for the copy is in the log, the source's rows and Crate
//      Tester's state for the source (its pity count, its collection) are
//      as they were, and the copy's state was empty before the pull.
//   4. Copy, then Cancel: nothing written, the table as it was.
//
// In a finally: the purchase is refunded through the module's own refund
// (the purse back, the granted item gone) and only the boxes the check
// created are deleted. One real purchase per run. Needs "Crate Tester" in
// "Loot Crates Test" and the BOX crate (live-ui.js).
/* global game, Hooks, __lc */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const BOX = process.env.BOX || "Live UI crate";
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
    const { refreshManager } = await import(base + "scripts/manager.js");
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

// Helpers every GM step shares, defined in the page once.
const GM_HELPERS = `
  globalThis.__lc = globalThis.__lc ?? {};
  __lc.wait = ms => new Promise(r => setTimeout(r, ms));
  __lc.until = async (fn, ms = 15000) => { for (let t = 0; t < ms && !fn(); t += 50) await __lc.wait(50); return fn(); };
  __lc.click = el => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
  __lc.dialog = () => [...document.querySelectorAll(".application.lc-dialog")].pop() ?? null;
  __lc.title = () => __lc.dialog()?.querySelector(".window-title")?.textContent.trim() ?? null;
  __lc.ok = () => __lc.dialog()?.querySelector('button[data-action="ok"]') ?? null;
  __lc.cancel = () => __lc.dialog()?.querySelector('button[data-action="cancel"]') ?? null;
  __lc.rows = () => __lc.app?.element?.querySelectorAll(".lc-table tbody tr").length ?? 0;
  __lc.status = () => __lc.app?.element?.querySelector(".lc-manager__status")?.textContent ?? null;
  __lc.field = name => __lc.dialog()?.querySelector('[name="' + name + '"]') ?? null;
`;

// The player's card list, read as a person sees it.
const READ_SHOP = `globalThis.__lcCards = () => [...document.querySelectorAll("#loot-crates-shop .lc-box[data-box]")].map(c => ({ id: c.dataset.box, name: c.querySelector(".lc-box__name, .lc-box__title, h3")?.textContent.trim() ?? c.textContent.trim().slice(0, 40), off: c.querySelector(".lc-box__buy")?.getAttribute("aria-disabled") === "true" }));`;

(async () => {
  const browser = await chromium.launch();
  const out = { player: PLAYER, box: BOX, gm: null, created: [], rows: [] };
  let gm = null;
  try {
    const pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");
    out.gm = "headless Gamemaster running the branch";

    // The world as it is: the source crate, Crate Tester's state for it, its log rows.
    out.before = await gm.page.evaluate(async ({ base, name }) => {
      const store = await import(base + "scripts/store.js");
      const { toCopper } = await import(base + "scripts/currency.js");
      const source = Object.values(store.getBoxes()).find(b => b.name === name);
      if (!source) throw new Error(`no ${name}: run live-ui.js first`);
      if (!(source.pools ?? []).some(r => store.getPools()[r.id])) throw new Error(`${name} draws from no live pool: run live-ui.js first`);
      const actor = game.actors.find(a => a.type === "character" && a.name === "Crate Tester" && a.folder?.name === "Loot Crates Test");
      if (!actor) throw new Error("no Crate Tester in Loot Crates Test");
      // A purse short of the price is topped up, as the brief allows.
      if (toCopper(actor.system.currency) < Math.ceil(Number(source.price) || 0) * 100) await actor.update({ "system.currency.gp": 1000 });
      return {
        source: structuredClone(source), boxIds: Object.keys(store.getBoxes()), shopOpen: store.isShopOpen(), actorId: actor.id,
        sourceState: structuredClone(store.getActorState(actor.id, source.id)), sourceRows: store.getLog().filter(r => r.boxId === source.id).length,
        logIds: store.getLog().map(r => r.id), purseCp: toCopper(actor.system.currency), items: actor.items.filter(i => !i.flags?.dnd5e?.cachedFor).length,
      };
    }, { base: MODULE_BASE, name: BOX });
    const source = out.before.source;
    const addLabel = out.before.shopOpen ? "Add to shelf" : "Add";
    const copyName = `${BOX} (copy)`;

    // The player's shop, open on Crate Tester.
    out.shop = await pl.page.evaluate(async ({ base, read }) => {
      (0, eval)(read);
      const { openShop } = await import(base + "scripts/shop.js");
      const actor = game.actors.find(a => a.isOwner && a.type === "character" && a.name === "Crate Tester");
      if (!actor) throw new Error(`${game.user.name} doesn't own Crate Tester`);
      const app = openShop();
      for (let t = 0; t < 200 && !app.element?.querySelector(".lc-box"); t++) await new Promise(r => setTimeout(r, 50));
      const pick = app.element.querySelector(".lc-shop__actor");
      if (pick && pick.value !== actor.id) { pick.value = actor.id; pick.dispatchEvent(new Event("change")); await new Promise(r => setTimeout(r, 800)); }
      return { cards: globalThis.__lcCards().length };
    }, { base: MODULE_BASE, read: READ_SHOP });

    // The manager on the Boxes tab, by its tab.
    await gm.page.evaluate(async ({ base, helpers, id }) => {
      (0, eval)(helpers);
      const { openManager } = await import(base + "scripts/manager.js");
      __lc.app = openManager();
      await __lc.until(() => __lc.app.element?.querySelector('.lc-tabs [data-tab="boxes"]'));
      __lc.click(__lc.app.element.querySelector('.lc-tabs [data-tab="boxes"]'));
      await __lc.until(() => __lc.app.tab === "boxes" && __lc.app.element.querySelector(`[data-action="copyBox"][data-box="${id}"]`), 8000);
      await __lc.wait(300);
    }, { base: MODULE_BASE, helpers: GM_HELPERS, id: source.id });

    // 1. The row's Copy: the dialog on the copy, nothing written.
    out.open = await gm.page.evaluate(async ({ base, id }) => {
      const store = await import(base + "scripts/store.js");
      const rows = __lc.rows();
      const btn = __lc.app.element.querySelector(`[data-action="copyBox"][data-box="${id}"]`);
      const label = btn.getAttribute("aria-label");
      const cell = [...btn.closest("td").querySelectorAll("[data-action]")].map(b => b.dataset.action);
      btn.focus();
      __lc.click(btn);
      await __lc.until(() => __lc.dialog()?.querySelector('input[name="name"]'), 8000);
      await __lc.wait(400);
      const d = __lc.dialog();
      const pools = Object.fromEntries([...d.querySelectorAll('input[name^="pool."]')].filter(i => i.checked).map(i => [i.name.slice(5), Number(d.querySelector(`input[name="share.${i.name.slice(5)}"]`)?.value)]));
      const weights = Object.fromEntries([...d.querySelectorAll('input[name^="w."]')].map(i => [i.name.slice(2), Number(i.value)]));
      const open = {
        label, cell, rows, title: __lc.title(), okLabel: __lc.ok()?.textContent.trim(),
        name: __lc.field("name")?.value, nameFocused: document.activeElement === __lc.field("name"),
        price: Number(__lc.field("price")?.value), pools, weights,
        pity: { minRarity: __lc.field("pityRarity")?.value, after: Number(__lc.field("pityAfter")?.value) }, noDuplicates: !!__lc.field("noDuplicates")?.checked,
        stock: __lc.field("stock")?.value, restock: !!d.querySelector("[data-restock]"),
        preview: d.querySelector(".lc-form__preview")?.textContent.trim(),
        boxes: Object.keys(store.getBoxes()).length,
      };
      await __lc.wait(800);
      open.boxesLater = Object.keys(store.getBoxes()).length;
      return open;
    }, { base: MODULE_BASE, id: source.id });
    out.openCards = await pl.page.evaluate(() => globalThis.__lcCards().length);

    // 2. Add to shelf.
    const tSave = Date.now();
    await gm.page.locator(".application.lc-dialog").last().locator('button[data-action="ok"]').click();
    out.saved = await gm.page.evaluate(async ({ base, before, name }) => {
      const store = await import(base + "scripts/store.js");
      const fresh = () => Object.values(store.getBoxes()).filter(b => !before.includes(b.id));
      await __lc.until(() => fresh().length && !__lc.dialog(), 8000);
      await __lc.until(() => __lc.status(), 3000);
      await __lc.wait(300);
      const added = fresh();
      const box = added.find(b => b.name === name) ?? null;
      const edit = box && __lc.app.element.querySelector(`[data-action="editBox"][data-box="${box.id}"]`);
      const row = edit?.closest("tr");
      const tab = __lc.app.element.querySelector(".lc-tab").getBoundingClientRect();
      const er = edit?.getBoundingClientRect();
      return {
        added: added.map(b => structuredClone(b)),
        tab: __lc.app.tab,
        focusOnEdit: !!edit && document.activeElement === edit,
        editLabel: edit?.getAttribute("aria-label") ?? null,
        rowNew: row?.classList.contains("lc-row--new") ?? false,
        rowInView: !!er && er.top >= tab.top - 1 && er.bottom <= tab.bottom + 1,
        status: __lc.status(),
        rows: __lc.rows(),
        copyState: structuredClone(store.getActorState(before.actorId, box?.id)),
      };
    }, { base: MODULE_BASE, before: Object.assign([...out.before.boxIds], { actorId: out.before.actorId }), name: copyName });
    out.created.push(...out.saved.added.map(b => b.id));
    const copy = out.saved.added.find(b => b.name === copyName) ?? null;
    if (shot) await gm.page.screenshot({ path: shot });
    out.copyCard = await pl.page.evaluate(async ({ id, since }) => {
      for (let t = 0; t < 4000; t += 20) {
        const c = globalThis.__lcCards();
        if (c.some(x => x.id === id)) return { shown: true, ms: Date.now() - since, card: c.find(x => x.id === id), cards: c.length };
        await new Promise(r => setTimeout(r, 20));
      }
      return { shown: false, ms: null, cards: globalThis.__lcCards().length };
    }, { id: copy?.id ?? "", since: tSave });

    // 3. Player2 buys the copy once; the source's history stays its own.
    if (copy && out.before.shopOpen && out.copyCard.shown && !out.copyCard.card.off) {
      out.pull = await pl.page.evaluate(async ({ id }) => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const until = async (fn, ms = 20000) => { for (let t = 0; t < ms && !fn(); t += 50) await wait(50); return fn(); };
        const click = el => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
        const buy = () => document.querySelector(`#loot-crates-shop .lc-box[data-box="${id}"] .lc-box__buy`);
        buy().focus();
        click(buy());
        const closeBtn = () => [...document.querySelectorAll(".lc-reveal")].pop()?.querySelector('[data-action="dismiss"]');
        const landed = await until(() => closeBtn(), 20000);
        const result = [...document.querySelectorAll(".lc-reveal")].pop()?.querySelector(".lc-reveal__result, [role=status]")?.textContent.trim() ?? "";
        if (landed) { await wait(700); click(closeBtn()); }
        await wait(500);
        return { landed: !!landed, result };
      }, { id: copy.id });
      out.afterPull = await gm.page.evaluate(async ({ base, before, copyId }) => {
        const store = await import(base + "scripts/store.js");
        const { toCopper } = await import(base + "scripts/currency.js");
        await __lc.until(() => store.getLog().some(r => !before.logIds.includes(r.id)), 5000);
        await __lc.wait(300);
        const actor = game.actors.get(before.actorId);
        const rows = store.getLog().filter(r => !before.logIds.includes(r.id));
        return {
          rows: rows.map(r => ({ id: r.id, boxId: r.boxId, boxName: r.boxName, price: r.price, itemId: r.itemId })),
          sourceRows: store.getLog().filter(r => r.boxId === before.source.id).length,
          sourceState: structuredClone(store.getActorState(before.actorId, before.source.id)),
          copyState: structuredClone(store.getActorState(before.actorId, copyId)),
          source: structuredClone(store.getBoxes()[before.source.id]),
          purseCp: toCopper(actor.system.currency), items: actor.items.filter(i => !i.flags?.dnd5e?.cachedFor).length,
        };
      }, { base: MODULE_BASE, before: out.before, copyId: copy.id });
      out.rows.push(...out.afterPull.rows.map(r => r.id));
    } else out.pull = { skipped: !out.before.shopOpen ? "the shop is closed" : "the copy's card has no live Buy" };

    // 4. Copy, then Cancel.
    out.cancel = await gm.page.evaluate(async ({ base, id }) => {
      const store = await import(base + "scripts/store.js");
      const before = { boxes: Object.keys(store.getBoxes()).length, rows: __lc.rows(), html: __lc.app.element.querySelector(".lc-table")?.innerHTML.length };
      __lc.click(__lc.app.element.querySelector(`[data-action="copyBox"][data-box="${id}"]`));
      await __lc.until(() => __lc.dialog()?.querySelector('input[name="name"]'), 8000);
      await __lc.wait(300);
      const title = __lc.title();
      __lc.click(__lc.cancel());
      await __lc.until(() => !__lc.dialog(), 5000);
      await __lc.wait(500);
      return { title, before, after: { boxes: Object.keys(store.getBoxes()).length, rows: __lc.rows(), html: __lc.app.element.querySelector(".lc-table")?.innerHTML.length, dialog: !!__lc.dialog() } };
    }, { base: MODULE_BASE, id: source.id });

    const o = out.open, s = out.saved;
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    // A game's settings: all but its id, name and stock count; a rule the
    // editor's Save writes as null (no pity, no limit) is the same as none.
    const settings = b => { const { id, name, rules, ...rest } = b; void id; void name; return { ...rest, rules: Object.fromEntries(Object.entries(rules ?? {}).filter(([k, v]) => k !== "stock" && v != null)) }; };
    const srcPools = Object.fromEntries((source.pools ?? []).map(r => [r.id, r.share ?? 1]));
    const price = Math.round(Number(source.price) || 0);
    const { formatPrice } = await import("../../module/scripts/currency.js");
    const expectedStatus = out.before.shopOpen ? `${copyName} is on the shelf at ${formatPrice(source.price)}.` : `${copyName} added. The shop is closed, so players can't see it yet.`;
    out.checks = {
      rowButton: o.label === `Copy ${BOX}` && o.cell.slice(-3).join("|") === "editBox|copyBox|deleteBox",
      dialog: o.title === "Copy box" && o.okLabel === addLabel && o.name === copyName && o.nameFocused,
      dialogHoldsSource: o.price === price && same(o.pools, srcPools) && Object.entries(o.weights).every(([r, w]) => w === Number(source.weights?.[r] ?? (o.weights[r]))) && o.pity.minRarity === (source.rules?.pity?.minRarity ?? "") && o.noDuplicates === !!source.rules?.noDuplicates && !o.restock && /\d+%/.test(o.preview ?? ""),
      writesNothingWhileOpen: o.boxes === out.before.boxIds.length && o.boxesLater === out.before.boxIds.length && out.openCards === out.shop.cards,
      added: !!copy && s.added.length === 1 && same(settings(copy), settings(source)) && (copy.rules?.stockMax == null || copy.rules.stock === copy.rules.stockMax) && same(out.saved.copyState, {}),
      shown: s.tab === "boxes" && s.focusOnEdit && s.editLabel === `Edit ${copyName}` && s.rowNew && s.rowInView && s.rows === o.rows + 1,
      said: s.status === expectedStatus,
      card: out.copyCard.shown && out.copyCard.ms <= 2000 && out.copyCard.cards === out.shop.cards + 1,
      pulled: out.pull.skipped ? "skipped" : out.pull.landed && out.afterPull.rows.length === 1 && out.afterPull.rows[0].boxId === copy.id && out.afterPull.purseCp === out.before.purseCp - price * 100 && out.afterPull.items === out.before.items + 1,
      sourceUntouched: out.pull.skipped ? "skipped" : out.afterPull.sourceRows === out.before.sourceRows && same(out.afterPull.sourceState, out.before.sourceState) && same(out.afterPull.source, source),
      cancel: out.cancel.title === "Copy box" && out.cancel.after.boxes === out.cancel.before.boxes && out.cancel.after.rows === out.cancel.before.rows && out.cancel.after.html === out.cancel.before.html && !out.cancel.after.dialog,
    };
    out.ok = Object.values(out.checks).every(v => v === true || v === "skipped");
    out.gmConsole = gm.logs;
    out.playerLog = pl.logs;
  } catch (err) {
    out.error = String(err?.stack || err);
    out.ok = false;
  } finally {
    // The purchase refunded through the module's own path, then only the
    // boxes this run created go.
    try {
      out.restored = gm ? await gm.page.evaluate(async ({ base, ids, rows, actorId }) => {
        const store = await import(base + "scripts/store.js");
        const { refundPull } = await import(base + "scripts/refund.js");
        const { toCopper } = await import(base + "scripts/currency.js");
        const refunded = [];
        for (const id of rows) { try { refunded.push({ id, status: (await refundPull(id))?.status ?? "done" }); } catch (err) { refunded.push({ id, error: String(err) }); } }
        const gone = [];
        for (const id of ids) if (store.getBoxes()[id]) { await store.removeBox(id); gone.push(id); }
        try { await globalThis.__lc?.app?.close(); } catch { /* closed */ }
        const actor = actorId && game.actors.get(actorId);
        return { refunded, deleted: gone, purseCp: actor ? toCopper(actor.system.currency) : null, items: actor ? actor.items.filter(i => !i.flags?.dnd5e?.cachedFor).length : null };
      }, { base: MODULE_BASE, ids: out.created, rows: out.rows, actorId: out.before?.actorId ?? null }) : null;
    } catch (err) { out.restored = { error: String(err) }; }
    console.log(JSON.stringify(out, null, 1));
    if (!out.ok) process.exitCode = 1;
    await browser.close();
  }
})();
