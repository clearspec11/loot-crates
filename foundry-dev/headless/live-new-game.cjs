// Live check: a New on the manager's Boxes tab opens its editor on an
// unsaved draft (newgame.js), with the branch's code on both ends.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/headless/live-new-game.cjs [--shot out.png]
//
// Env: PLAYER (default Player2, must own Crate Tester).
//
// Two headless clients, the Gamemaster and the player, each running the
// branch's code (as live-limits.cjs does). Player2's shop is open on Crate
// Tester. Then, as a GM does, on the Boxes tab:
//
//   1. Click "New dice game": the dialog "New dice game" opens with the name
//      focused and its default button reading "Add to shelf" (the shop is
//      open), no record is written, and the player's shop shows no new card
//      while it is open. Cancel: still nothing written, the Boxes table has
//      the rows it had.
//   2. Click "New box": the dialog "New box"; type a name and a price, tick
//      "Live UI pool", press "Add to shelf". Exactly one box is added, the
//      player's shop shows its card within 2 s, the manager is on the Boxes
//      tab with focus on that row's Edit, the row is marked new and the
//      status line reads "<name> is on the shelf at <price>."
//   3. Click "New box" and Cancel: the box count and the table are unchanged.
//   4. On the Pools tab, click "New crate from this pool" on Live UI pool:
//      the dialog "New box" with the pool's name, the pool ticked and the
//      price focused; type a price and press "Add to shelf": one more box,
//      drawing from that pool, the Boxes tab with its row focused.
//
// Deleted in a finally: only the boxes the check created. No purchase.
// Needs "Crate Tester" in "Loot Crates Test" and "Live UI pool" (live-ui.js).
/* global game, Hooks, __lc */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const shot = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : null;
const STAMP = Date.now().toString(36);

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
  __lc.focusIs = sel => document.activeElement === (sel ? document.querySelector(sel) : null);
`;

// The player's card list, read as a person sees it.
const READ_SHOP = `globalThis.__lcCards = () => [...document.querySelectorAll("#loot-crates-shop .lc-box[data-box]")].map(c => ({ id: c.dataset.box, name: c.querySelector(".lc-box__name, .lc-box__title, h3")?.textContent.trim() ?? c.textContent.trim().slice(0, 40) }));`;

const untilCards = (pl, pred, since, ms = 4000) => pl.evaluate(async ({ pred, since, ms }) => {
  const test = new Function("c", `return (${pred})(c)`);
  for (let t = 0; t < ms; t += 20) {
    const c = globalThis.__lcCards();
    if (test(c)) return { cards: c, ms: Date.now() - since };
    await new Promise(r => setTimeout(r, 20));
  }
  return { cards: globalThis.__lcCards(), ms: null };
}, { pred: String(pred), since, ms });

(async () => {
  const browser = await chromium.launch();
  const out = { player: PLAYER, gm: null, created: [] };
  let gm = null;
  try {
    const pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");
    out.gm = "headless Gamemaster running the branch";

    // The world as it is: the boxes, the pool, the shop's state.
    out.before = await gm.page.evaluate(async base => {
      const store = await import(base + "scripts/store.js");
      const pool = Object.values(store.getPools()).find(p => p.name === "Live UI pool");
      if (!pool) throw new Error("no Live UI pool: run live-ui.js first");
      return { boxIds: Object.keys(store.getBoxes()), poolId: pool.id, shopOpen: store.isShopOpen() };
    }, MODULE_BASE);
    const addLabel = out.before.shopOpen ? "Add to shelf" : "Add";

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
    await gm.page.evaluate(async ({ base, helpers }) => {
      (0, eval)(helpers);
      const { openManager } = await import(base + "scripts/manager.js");
      __lc.app = openManager();
      await __lc.until(() => __lc.app.element?.querySelector('.lc-tabs [data-tab="boxes"]'));
      __lc.click(__lc.app.element.querySelector('.lc-tabs [data-tab="boxes"]'));
      await __lc.until(() => __lc.app.tab === "boxes" && __lc.app.element.querySelector('[data-action="addDice"]'), 8000);
      await __lc.wait(300);
    }, { base: MODULE_BASE, helpers: GM_HELPERS });

    // 1. New dice game, then Cancel.
    out.dice = await gm.page.evaluate(async base => {
      const store = await import(base + "scripts/store.js");
      const rows = __lc.rows();
      const btn = __lc.app.element.querySelector('[data-action="addDice"]');
      btn.focus();
      __lc.click(btn);
      await __lc.until(() => __lc.dialog()?.querySelector('input[name="name"]'), 8000);
      await __lc.wait(400);
      const open = {
        title: __lc.title(), okLabel: __lc.ok()?.textContent.trim(),
        nameFocused: document.activeElement === __lc.dialog()?.querySelector('input[name="name"]'),
        name: __lc.dialog()?.querySelector('input[name="name"]')?.value,
        boxes: Object.keys(store.getBoxes()).length, rows: __lc.rows(),
      };
      await __lc.wait(800);
      open.boxesLater = Object.keys(store.getBoxes()).length;
      __lc.click(__lc.cancel());
      await __lc.until(() => !__lc.dialog(), 5000);
      await __lc.wait(500);
      return { rowsBefore: rows, open, after: { boxes: Object.keys(store.getBoxes()).length, rows: __lc.rows(), dialog: !!__lc.dialog() } };
    }, MODULE_BASE);
    out.diceCards = await untilCards(pl.page, c => c.length !== 0, Date.now(), 300);

    // 2. New box: type, tick, Add to shelf.
    const crateName = `Live new crate ${STAMP}`;
    out.crate = await gm.page.evaluate(async () => {
      const btn = __lc.app.element.querySelector('[data-action="addBox"]');
      btn.focus();
      __lc.click(btn);
      await __lc.until(() => __lc.dialog()?.querySelector('input[name="name"]'), 8000);
      await __lc.wait(300);
      return { title: __lc.title(), okLabel: __lc.ok()?.textContent.trim(), nameFocused: document.activeElement === __lc.dialog()?.querySelector('input[name="name"]'), preview: __lc.dialog()?.querySelector(".lc-form__preview")?.textContent.trim() };
    });
    const dlg = gm.page.locator(".application.lc-dialog").last();
    await dlg.locator('input[name="name"]').fill(crateName);
    await dlg.locator('input[name="price"]').fill("7");
    await dlg.locator(`label.lc-row:has-text("Live UI pool") input[type="checkbox"]`).check();
    out.crate.previewTicked = (await dlg.locator(".lc-form__preview").textContent()).trim();
    const t2save = Date.now();
    await dlg.locator('button[data-action="ok"]').click();
    out.crate.saved = await gm.page.evaluate(async ({ base, before, name }) => {
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
        added: added.map(b => ({ id: b.id, name: b.name, price: b.price, pools: b.pools })),
        tab: __lc.app.tab,
        focusOnEdit: !!edit && document.activeElement === edit,
        editLabel: edit?.getAttribute("aria-label") ?? null,
        rowNew: row?.classList.contains("lc-row--new") ?? false,
        rowInView: !!er && er.top >= tab.top - 1 && er.bottom <= tab.bottom + 1,
        status: __lc.status(),
        rows: __lc.rows(),
      };
    }, { base: MODULE_BASE, before: out.before.boxIds, name: crateName });
    out.created.push(...out.crate.saved.added.map(b => b.id));
    const crateId = out.crate.saved.added.find(b => b.name === crateName)?.id;
    out.crateCard = await pl.page.evaluate(async ({ id, since }) => {
      for (let t = 0; t < 4000; t += 20) {
        const c = globalThis.__lcCards();
        if (c.some(x => x.id === id)) return { shown: true, ms: Date.now() - since, name: c.find(x => x.id === id).name, cards: c.length };
        await new Promise(r => setTimeout(r, 20));
      }
      return { shown: false, ms: null, cards: globalThis.__lcCards().length };
    }, { id: crateId, since: t2save });

    // 3. New box, then Cancel.
    out.cancel = await gm.page.evaluate(async base => {
      const store = await import(base + "scripts/store.js");
      const before = { boxes: Object.keys(store.getBoxes()).length, rows: __lc.rows(), html: __lc.app.element.querySelector(".lc-table")?.innerHTML.length };
      __lc.click(__lc.app.element.querySelector('[data-action="addBox"]'));
      await __lc.until(() => __lc.dialog()?.querySelector('input[name="name"]'), 8000);
      await __lc.wait(300);
      __lc.click(__lc.cancel());
      await __lc.until(() => !__lc.dialog(), 5000);
      await __lc.wait(500);
      return { before, after: { boxes: Object.keys(store.getBoxes()).length, rows: __lc.rows(), html: __lc.app.element.querySelector(".lc-table")?.innerHTML.length } };
    }, MODULE_BASE);

    // 4. New crate from this pool, on the Pools tab.
    out.fromPool = await gm.page.evaluate(async ({ poolId }) => {
      __lc.click(__lc.app.element.querySelector('.lc-tabs [data-tab="pools"]'));
      await __lc.until(() => __lc.app.tab === "pools" && __lc.app.element.querySelector(`.lc-pool__details[data-pool="${poolId}"]`), 8000);
      const details = __lc.app.element.querySelector(`.lc-pool__details[data-pool="${poolId}"]`);
      if (!details.open) { __lc.click(details.querySelector("summary")); await __lc.until(() => details.open, 3000); }
      const btn = () => __lc.app.element.querySelector(`[data-action="crateFromPool"][data-pool="${poolId}"]`);
      await __lc.until(() => btn(), 3000);
      const label = btn().getAttribute("aria-label");
      btn().focus();
      __lc.click(btn());
      await __lc.until(() => __lc.dialog()?.querySelector('input[name="name"]'), 8000);
      await __lc.wait(400);
      const d = __lc.dialog();
      return {
        label, title: __lc.title(), okLabel: __lc.ok()?.textContent.trim(),
        name: d.querySelector('input[name="name"]').value,
        poolTicked: d.querySelector(`input[name="pool.${poolId}"]`)?.checked ?? null,
        priceFocused: document.activeElement === d.querySelector('input[name="price"]'),
        preview: d.querySelector(".lc-form__preview")?.textContent.trim(),
      };
    }, { poolId: out.before.poolId });
    await gm.page.locator(".application.lc-dialog").last().locator('input[name="price"]').fill("9");
    await gm.page.locator(".application.lc-dialog").last().locator('button[data-action="ok"]').click();
    out.fromPool.saved = await gm.page.evaluate(async ({ base, known }) => {
      const store = await import(base + "scripts/store.js");
      const fresh = () => Object.values(store.getBoxes()).filter(b => !known.includes(b.id));
      await __lc.until(() => fresh().length && !__lc.dialog(), 8000);
      await __lc.until(() => __lc.status(), 3000);
      await __lc.wait(300);
      const added = fresh();
      const edit = added[0] && __lc.app.element.querySelector(`[data-action="editBox"][data-box="${added[0].id}"]`);
      return { added: added.map(b => ({ id: b.id, name: b.name, price: b.price, pools: b.pools })), tab: __lc.app.tab, focusOnEdit: !!edit && document.activeElement === edit, status: __lc.status() };
    }, { base: MODULE_BASE, known: [...out.before.boxIds, ...out.created] });
    out.created.push(...out.fromPool.saved.added.map(b => b.id));
    if (shot) await gm.page.screenshot({ path: shot });

    const d = out.dice, c = out.crate, f = out.fromPool;
    const poolRef = [{ id: out.before.poolId, share: 1 }];
    out.checks = {
      diceDialog: d.open.title === "New dice game" && d.open.okLabel === addLabel && d.open.nameFocused && d.open.name === "New dice game",
      diceWritesNothing: d.open.boxes === out.before.boxIds.length && d.open.boxesLater === out.before.boxIds.length && d.open.rows === d.rowsBefore,
      diceNoCard: out.diceCards.cards.length === out.shop.cards,
      diceCancel: d.after.boxes === out.before.boxIds.length && d.after.rows === d.rowsBefore && !d.after.dialog,
      crateDialog: c.title === "New box" && c.okLabel === addLabel && c.nameFocused && /drop nothing/.test(c.preview ?? "") && /\d+%/.test(c.previewTicked ?? ""),
      crateAdded: c.saved.added.length === 1 && c.saved.added[0].name === crateName && c.saved.added[0].price === 7 && JSON.stringify(c.saved.added[0].pools) === JSON.stringify(poolRef),
      crateShown: c.saved.tab === "boxes" && c.saved.focusOnEdit && c.saved.editLabel === `Edit ${crateName}` && c.saved.rowNew && c.saved.rowInView && c.saved.rows === d.rowsBefore + 1,
      crateSaid: c.saved.status === (out.before.shopOpen ? `${crateName} is on the shelf at 7 gp.` : `${crateName} added. The shop is closed, so players can't see it yet.`),
      crateCard: out.crateCard.shown && out.crateCard.ms <= 2000 && out.crateCard.cards === out.shop.cards + 1,
      cancel: out.cancel.after.boxes === out.cancel.before.boxes && out.cancel.after.rows === out.cancel.before.rows && out.cancel.after.html === out.cancel.before.html,
      fromPoolDialog: f.label === "New crate from Live UI pool" && f.title === "New box" && f.okLabel === addLabel && f.name === "Live UI pool" && f.poolTicked === true && f.priceFocused && /\d+%/.test(f.preview ?? ""),
      fromPoolAdded: f.saved.added.length === 1 && f.saved.added[0].name === "Live UI pool" && f.saved.added[0].price === 9 && JSON.stringify(f.saved.added[0].pools) === JSON.stringify(poolRef) && f.saved.tab === "boxes" && f.saved.focusOnEdit && /^Live UI pool is on the shelf at 9 gp\.$|^Live UI pool added\./.test(f.saved.status ?? ""),
    };
    out.ok = Object.values(out.checks).every(Boolean);
    out.gmConsole = gm.logs;
    out.playerLog = pl.logs;
  } catch (err) {
    out.error = String(err?.stack || err);
    out.ok = false;
  } finally {
    // Only the boxes this run created go.
    try {
      out.deleted = gm ? await gm.page.evaluate(async ({ base, ids }) => {
        const store = await import(base + "scripts/store.js");
        const gone = [];
        for (const id of ids) if (store.getBoxes()[id]) { await store.removeBox(id); gone.push(id); }
        try { await globalThis.__lc?.app?.close(); } catch { /* closed */ }
        return gone;
      }, { base: MODULE_BASE, ids: out.created }) : [];
    } catch (err) { out.deleted = { error: String(err) }; }
    console.log(JSON.stringify(out, null, 1));
    if (!out.ok) process.exitCode = 1;
    await browser.close();
  }
})();
