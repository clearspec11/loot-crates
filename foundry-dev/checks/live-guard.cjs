// Live check: the editors' guard rails (editordialog.js, editorguard.js,
// playable.js): no edit lost to Escape or Cancel, and a game that can't be
// played saves off the shelf, with the branch's code on both ends.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/checks/live-guard.cjs [--shot out.png]
//   (or: npm run live -- live-guard)
//
// Env: PLAYER (default Player2, must own Crate Tester).
//
// Two headless clients, the Gamemaster and the player, each running the
// branch's code (as live-new-game.cjs does). The GM seeds "Live guard crate
// <stamp>" at 13 gp drawing from "Live UI pool"; Player2's shop is open on
// Crate Tester. Then, as a GM does, on the manager's Boxes tab:
//
//   1. Click the crate's Edit; type 40 gp into its price; press Escape (the
//      real key): Foundry's confirm "Discard changes?" asks "Discard your
//      changes to Live guard crate ...?", Keep editing focused. Click Keep
//      editing: the editor is still open and the price still reads 40 gp.
//   2. Click Cancel: the question again. Click Discard: the editor closes and
//      the crate's price is still 13 gp.
//   3. Click Edit again and press Escape with nothing changed: it closes at
//      once, no question.
//   4. Click New crate: with no pool ticked its button reads "Save off the
//      shelf" and the On the shelf box is unticked and off, the reason under
//      it. Type a name and press that button: one box is added, off the
//      shelf (rules.shelved false), the status line says why, and Player2's
//      shop doesn't show it.
//
// Deleted in a finally: only the boxes this run created. No purchase.
// Needs "Crate Tester" in "Loot Crates Test" and "Live UI pool" (live-ui.js).
/* global game, Hooks, foundry, __lc */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const shot = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : null;
const STAMP = Date.now().toString(36);
const CRATE = `Live guard crate ${STAMP}`;
const EMPTY = `Live guard empty ${STAMP}`;

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
  // The branch's words, then its code in place of the installed module's, as main.js wires it.
  await page.evaluate(async base => (await import(base + "scripts/core/i18n.js")).loadStrings(), MODULE_BASE);
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
  }, MODULE_BASE);
  return { page, logs };
}

const GM_HELPERS = `
  globalThis.__lc = globalThis.__lc ?? {};
  __lc.wait = ms => new Promise(r => setTimeout(r, ms));
  __lc.until = async (fn, ms = 15000) => { for (let t = 0; t < ms && !fn(); t += 50) await __lc.wait(50); return fn(); };
  __lc.click = el => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
  __lc.dialog = () => [...document.querySelectorAll(".application.lc-dialog")].pop() ?? null;
  __lc.question = () => [...document.querySelectorAll(".application.dialog")].find(d => !d.classList.contains("lc-dialog") && /Discard changes\\?/.test(d.querySelector(".window-title")?.textContent ?? "")) ?? null;
  __lc.status = () => __lc.app?.element?.querySelector(".lc-manager__status")?.textContent ?? null;
`;
const READ_SHOP = `globalThis.__lcCards = () => [...document.querySelectorAll("#loot-crates-shop .lc-box[data-box]")].map(c => c.dataset.box);`;

(async () => {
  const browser = await chromium.launch();
  const out = { player: PLAYER, created: [] };
  let gm = null;
  try {
    const pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");

    // Seed the crate this run edits.
    out.before = await gm.page.evaluate(async ({ base, name }) => {
      const store = await import(base + "scripts/foundry/store.js");
      const pool = Object.values(store.getPools()).find(p => p.name === "Live UI pool");
      if (!pool) throw new Error("no Live UI pool: run live-ui.js first");
      const id = store.newId();
      await store.saveBox({ id, name, price: 13, pools: [{ id: pool.id, share: 1 }], weights: {}, rules: {} });
      return { id, poolId: pool.id, pools: Object.keys(store.getPools()).length, boxIds: Object.keys(store.getBoxes()), shopOpen: store.isShopOpen() };
    }, { base: MODULE_BASE, name: CRATE });
    out.created.push(out.before.id);

    // The player's shop, open on Crate Tester.
    out.shop = await pl.page.evaluate(async ({ base, read }) => {
      (0, eval)(read);
      const { openShop } = await import(base + "scripts/foundry/shop.js");
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
      const { openManager } = await import(base + "scripts/foundry/manager.js");
      __lc.app = openManager();
      await __lc.until(() => __lc.app.element?.querySelector('.lc-tabs [data-tab="boxes"]'));
      __lc.click(__lc.app.element.querySelector('.lc-tabs [data-tab="boxes"]'));
      await __lc.until(() => __lc.app.tab === "boxes" && __lc.app.element.querySelector('[data-action="addBox"]'), 8000);
      await __lc.wait(300);
    }, { base: MODULE_BASE, helpers: GM_HELPERS });

    const editor = () => gm.page.locator(".application.lc-dialog").last();
    const question = () => gm.page.locator(".application.dialog:not(.lc-dialog)").filter({ hasText: "Discard changes?" }).last();
    const openEdit = async () => {
      await gm.page.locator(`[data-action="editBox"][data-box="${out.before.id}"]`).click();
      await editor().locator('input[name="price"]').waitFor({ timeout: 8000 });
      await gm.page.waitForTimeout(300);
    };
    const read = () => gm.page.evaluate(() => ({
      editor: !!__lc.dialog(), price: __lc.dialog()?.querySelector('input[name="price"]')?.value ?? null,
      question: __lc.question() ? { text: __lc.question().querySelector(".dialog-content")?.textContent.replace(/\s+/g, " ").trim(), focused: document.activeElement?.closest(".application") === __lc.question() ? document.activeElement.textContent.trim() : null, buttons: [...__lc.question().querySelectorAll("footer button")].map(b => b.textContent.trim()) } : null,
    }));

    // 1. Edit, a new price, Escape: the question; Keep editing keeps the price.
    await openEdit();
    await editor().locator('input[name="price"]').fill("40 gp");
    await gm.page.keyboard.press("Escape");
    await question().waitFor({ timeout: 5000 }).catch(() => {});
    await gm.page.waitForTimeout(300);
    out.escape = await read();
    if (shot) await gm.page.screenshot({ path: shot });
    await question().locator('button[data-action="no"]').click().catch(e => { out.keepError = String(e); });
    await gm.page.waitForTimeout(500);
    out.kept = await read();

    // 2. Cancel: the question again; Discard closes, nothing written.
    await editor().locator('button[data-action="cancel"]').click();
    await question().waitFor({ timeout: 5000 }).catch(() => {});
    await gm.page.waitForTimeout(300);
    out.cancel = await read();
    await question().locator('button[data-action="yes"]').click().catch(e => { out.discardError = String(e); });
    await gm.page.waitForTimeout(800);
    out.discarded = { ...await read(), stored: await gm.page.evaluate(async ({ base, id }) => (await import(base + "scripts/foundry/store.js")).getBoxes()[id]?.price ?? null, { base: MODULE_BASE, id: out.before.id }) };

    // 3. Nothing changed: Escape closes at once.
    await openEdit();
    await editor().locator('input[name="price"]').focus();
    await gm.page.keyboard.press("Escape");
    await gm.page.waitForTimeout(800);
    out.unchanged = await read();

    // 4. New crate with no pool: Save off the shelf.
    await gm.page.locator('[data-action="addBox"]').click();
    await editor().locator('input[name="name"]').waitFor({ timeout: 8000 });
    await gm.page.waitForTimeout(300);
    out.offShelf = await gm.page.evaluate(() => {
      const d = __lc.dialog();
      const box = d.querySelector('input[name="onShelf"]');
      return {
        ticked: [...d.querySelectorAll('input[name^="pool."]')].filter(i => i.checked).length,
        okLabel: d.querySelector('button[data-action="ok"]')?.textContent.trim(),
        boxChecked: box?.checked, boxDisabled: box?.disabled,
        why: d.querySelector("[data-shelf-why]")?.textContent.trim(),
        describedBy: box?.getAttribute("aria-describedby") === d.querySelector("[data-shelf-why]")?.id,
      };
    });
    await editor().locator('input[name="name"]').fill(EMPTY);
    const t0 = Date.now();
    await editor().locator('button[data-action="ok"]').click();
    out.offShelf.saved = await gm.page.evaluate(async ({ base, known, name }) => {
      const store = await import(base + "scripts/foundry/store.js");
      const fresh = () => Object.values(store.getBoxes()).filter(b => !known.includes(b.id));
      await __lc.until(() => fresh().length && !__lc.dialog(), 8000);
      await __lc.until(() => __lc.status(), 3000);
      await __lc.wait(300);
      const box = fresh().find(b => b.name === name) ?? null;
      return { added: fresh().map(b => ({ id: b.id, name: b.name, shelved: b.rules?.shelved, pools: b.pools })), id: box?.id ?? null, status: __lc.status() };
    }, { base: MODULE_BASE, known: out.before.boxIds, name: EMPTY });
    out.created.push(...out.offShelf.saved.added.map(b => b.id));
    // Player2's shop over the next 2 s: no card for it.
    out.offShelf.card = await pl.page.evaluate(async ({ id, since }) => {
      let seen = false;
      while (Date.now() - since < 2500) { if (globalThis.__lcCards().includes(id)) seen = true; await new Promise(r => setTimeout(r, 50)); }
      return { seen, cards: globalThis.__lcCards().length };
    }, { id: out.offShelf.saved.id, since: t0 });

    const q = out.escape.question;
    out.checks = {
      escapeAsks: out.escape.editor && !!q && q.text === `Discard your changes to ${CRATE}? Nothing you changed has been saved.` && q.buttons.join("|") === "Discard|Keep editing" && q.focused === "Keep editing",
      keepEditing: out.kept.editor && !out.kept.question && out.kept.price === "40 gp",
      cancelAsks: out.cancel.editor && !!out.cancel.question,
      discardCloses: !out.discarded.editor && !out.discarded.question && out.discarded.stored === 13,
      unchangedCloses: !out.unchanged.editor && !out.unchanged.question,
      offShelfEditor: out.offShelf.ticked === 0 && out.offShelf.okLabel === "Save off the shelf" && out.offShelf.boxChecked === false && out.offShelf.boxDisabled === true && out.offShelf.why === "This crate can drop nothing: tick a pool above." && out.offShelf.describedBy,
      offShelfSaved: out.offShelf.saved.added.length === 1 && out.offShelf.saved.added[0].shelved === false && out.offShelf.saved.status === `${EMPTY} added off the shelf. This crate can drop nothing: tick a pool above.`,
      notInShop: !out.offShelf.card.seen && out.offShelf.card.cards === out.shop.cards,
    };
    out.ok = Object.values(out.checks).every(Boolean);
    out.gmConsole = gm.logs;
    out.playerLog = pl.logs;
  } catch (err) {
    out.error = String(err?.stack || err);
    out.ok = false;
  } finally {
    // Only the boxes this run created go; any dialog left open is closed without asking.
    try {
      out.deleted = gm ? await gm.page.evaluate(async ({ base, ids }) => {
        for (const app of [...(foundry.applications.instances?.values?.() ?? [])]) if (app.lcGuard || app.element?.classList?.contains("lc-dialog")) { app.lcGuard = null; try { await app.close(); } catch { /* closed */ } }
        const store = await import(base + "scripts/foundry/store.js");
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
