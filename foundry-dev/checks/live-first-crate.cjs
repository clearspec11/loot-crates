// Live check: a first crate by hand, as the GM usability test walked it
// (round 30, B3), with the branch's code, counting clicks and windows.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/checks/live-first-crate.cjs [--shot out.png]
//
// One headless client, the Gamemaster (the seat must be free), running the
// branch's code. Every counted step is a real click on the real control
// (Playwright's mouse); typing is not counted, as the walkthrough counted it.
// After each step that says something, the status line must be in view: the
// first thing in the tab's pane, inside its visible rect, whatever the scroll.
//
// A. Pool first, on the Pools tab (the walkthrough's T2 took 14 clicks and
//    6 windows, with every status line out of view):
//    1. New pool: a dialog "New pool", the name focused and selected; type a
//       name over it. 2. Make the pool: the pool is made with that name, the
//       tab scrolled to it, open, its Add from compendium focused, the status
//       line in view saying so. 3. Add from compendium: Items (SRD) picked,
//       Types and Rarities as chips; 4. tick Loot, 5. tick Common, type
//       "cloak"; 6. Preview; 7. Add N items: the items are in, the status
//       line in view. 8. New crate from this pool: "New crate", the price
//       focused; type it. 9. Add to shelf: one crate drawing from the pool,
//       the Boxes tab, the status line in view.
// B. In the editor: 1. New crate on the Boxes tab: no pool ticked, "Make a
//    pool from a compendium" offered; type a name. 2. Make a pool from a
//    compendium; 3. tick Loot, 4. tick Common, type "cloak"; 5. Preview;
//    6. Add N items: a pool named for the crate, ticked and focused in the
//    picker, the line under it saying so. Type a price. 7. Add to shelf: the
//    crate draws from that pool; the status line in view.
//
// Deleted in a finally: only the crates and pools this run made. No purchase.
/* global game, foundry, __lc */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const shot = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : null;
const STAMP = Date.now().toString(36);
const POOL_NAME = `Live first pool ${STAMP}`;
const CRATE_B = `Live first crate ${STAMP}`;

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
    (await import(base + "scripts/foundry/socket.js")).registerSocket();
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

const GM_HELPERS = `
  globalThis.__lc = globalThis.__lc ?? {};
  __lc.wait = ms => new Promise(r => setTimeout(r, ms));
  __lc.until = async (fn, ms = 15000) => { for (let t = 0; t < ms && !fn(); t += 50) await __lc.wait(50); return fn(); };
  __lc.dialog = () => [...document.querySelectorAll(".application.lc-dialog")].pop() ?? null;
  __lc.title = () => __lc.dialog()?.querySelector(".window-title")?.textContent.trim() ?? null;
  __lc.status = () => __lc.app?.element?.querySelector(".lc-manager__status")?.textContent ?? null;
  // The status line as the GM sees it: its words, whether the bar is the
  // pane's first child and inside its visible rect, and how far down the
  // pane is scrolled (so "in view" is shown at a real scroll).
  __lc.seen = () => {
    const tab = __lc.app?.element?.querySelector(".lc-tab");
    const bar = tab?.querySelector(".lc-manager__statusbar");
    if (!tab || !bar) return { text: null, inView: false };
    const t = tab.getBoundingClientRect(), b = bar.getBoundingClientRect();
    const text = bar.querySelector(".lc-manager__status")?.textContent.trim() ?? "";
    return { text, first: tab.firstElementChild === bar, inView: !!text && b.height > 0 && b.top >= t.top - 1 && b.bottom <= t.bottom + 1, scrollTop: Math.round(tab.scrollTop), scrollHeight: tab.scrollHeight };
  };
`;

(async () => {
  const browser = await chromium.launch();
  const out = { gm: null, made: { pools: [], boxes: [] }, clicks: { a: [], b: [] }, windows: { a: new Set(), b: new Set() } };
  let gm = null;
  try {
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");
    out.gm = "headless Gamemaster running the branch";
    const page = gm.page;
    out.before = await page.evaluate(async base => {
      const store = await import(base + "scripts/foundry/store.js");
      return { poolIds: Object.keys(store.getPools()), boxIds: Object.keys(store.getBoxes()), shopOpen: store.isShopOpen(), hasSrd: !!game.packs.get("dnd5e.items") };
    }, MODULE_BASE);
    const addLabel = out.before.shopOpen ? "Add to shelf" : "Add";
    const dialog = () => page.locator(".application.lc-dialog").last();
    const title = () => page.evaluate(() => __lc.title());
    // One counted click on the real control, and the window it leaves open.
    const click = async (path, label, locator) => {
      await locator.click();
      out.clicks[path].push(label);
      await page.waitForTimeout(250);
      const t = await title();
      out.windows[path].add("manager");
      if (t) out.windows[path].add(t.replace(/ to .+$/, " to <pool>"));
    };
    const untilTitle = (want, ms = 8000) => page.waitForFunction(w => __lc.title() === w, want, { timeout: ms }).catch(() => null);

    await page.evaluate(async ({ base, helpers }) => {
      (0, eval)(helpers);
      const { openManager } = await import(base + "scripts/foundry/manager.js");
      __lc.app = openManager();
      await __lc.until(() => __lc.app.element?.querySelector('.lc-tabs [data-tab="pools"]'));
    }, { base: MODULE_BASE, helpers: GM_HELPERS });
    // To the Pools tab (navigation, before the walkthrough's count starts).
    await page.locator('#loot-crates-manager .lc-tabs [data-tab="pools"]').click();
    await page.waitForFunction(() => __lc.app.tab === "pools" && __lc.app.element.querySelector('[data-action="addPool"]'), null, { timeout: 15000 });
    await page.waitForTimeout(500);
    out.poolsTab = await page.evaluate(() => {
      const all = [...__lc.app.element.querySelectorAll(".lc-pool__details")];
      return { pools: all.length, open: all.filter(d => d.open).length, height: __lc.app.element.querySelector(".lc-tab").scrollHeight };
    });

    // ---------- A. Pool first ----------
    await click("a", "New pool", page.locator('#loot-crates-manager [data-action="addPool"]'));
    await untilTitle("New pool");
    out.a = { prompt: await page.evaluate(() => {
      const i = __lc.dialog()?.querySelector('input[name="name"]');
      return { title: __lc.title(), ok: __lc.dialog()?.querySelector('button[data-action="ok"]')?.textContent.trim(), focused: document.activeElement === i, selected: !!i && i.selectionStart === 0 && i.selectionEnd === i.value.length, value: i?.value };
    }) };
    await page.keyboard.type(POOL_NAME);
    await click("a", "Make the pool", dialog().locator('button[data-action="ok"]'));
    await page.waitForFunction(name => Object.values(game.settings.get("loot-crates", "pools")).some(p => p.name === name) && !__lc.dialog(), POOL_NAME, { timeout: 8000 });
    await page.waitForTimeout(500);
    out.a.made = await page.evaluate(name => {
      const pool = Object.values(game.settings.get("loot-crates", "pools")).find(p => p.name === name);
      const details = __lc.app.element.querySelector(`.lc-pool__details[data-pool="${pool.id}"]`);
      const add = details?.querySelector('[data-action="bulkAdd"]');
      const r = add?.getBoundingClientRect(), t = __lc.app.element.querySelector(".lc-tab").getBoundingClientRect();
      return { id: pool.id, tab: __lc.app.tab, open: !!details?.open, addFocused: document.activeElement === add, addInView: !!r && r.top >= t.top && r.bottom <= t.bottom, seen: __lc.seen() };
    }, POOL_NAME);
    out.made.pools.push(out.a.made.id);

    await click("a", "Add from compendium", page.locator(`#loot-crates-manager .lc-pool__details[data-pool="${out.a.made.id}"] [data-action="bulkAdd"]`));
    await untilTitle("Add from compendium");
    out.a.bulk = await page.evaluate(() => {
      const d = __lc.dialog();
      const chips = name => [...d.querySelectorAll(`input[name="${name}"]`)];
      return { title: __lc.title(), ok: d.querySelector('button[data-action="ok"]')?.textContent.trim(), pack: d.querySelector('select[name="pack"]')?.value, multiSelects: d.querySelectorAll("select[multiple]").length, types: chips("types").map(c => `${c.value}${c.checked ? "+" : ""}`), rarities: chips("rarities").map(c => `${c.value}${c.checked ? "+" : ""}`) };
    });
    await click("a", "tick Loot", dialog().locator('label.lc-chipbox:has(input[name="types"][value="loot"])'));
    await click("a", "tick Common", dialog().locator('label.lc-chipbox:has(input[name="rarities"][value="common"])'));
    await dialog().locator('input[name="name"]').fill("cloak");
    await click("a", "Preview", dialog().locator('button[data-action="ok"]'));
    await page.waitForFunction(() => /^Add to /.test(__lc.title() ?? ""), null, { timeout: 15000 });
    out.a.preview = { title: await title(), add: (await dialog().locator('button[data-action="add"]').textContent()).trim() };
    await click("a", out.a.preview.add, dialog().locator('button[data-action="add"]'));
    await page.waitForFunction(id => (game.settings.get("loot-crates", "pools")[id]?.entries?.length ?? 0) > 0 && !__lc.dialog(), out.a.made.id, { timeout: 8000 });
    await page.waitForTimeout(500);
    out.a.added = await page.evaluate(id => ({ entries: game.settings.get("loot-crates", "pools")[id].entries.length, seen: __lc.seen() }), out.a.made.id);

    await click("a", "New crate from this pool", page.locator(`#loot-crates-manager [data-action="crateFromPool"][data-pool="${out.a.made.id}"]`));
    await untilTitle("New crate");
    out.a.editor = await page.evaluate(id => {
      const d = __lc.dialog();
      return { title: __lc.title(), ticked: d.querySelector(`input[name="pool.${id}"]`)?.checked ?? null, priceFocused: document.activeElement === d.querySelector('input[name="price"]'), ok: d.querySelector('button[data-action="ok"]')?.textContent.trim() };
    }, out.a.made.id);
    await dialog().locator('input[name="price"]').fill("25 gp");
    await click("a", out.a.editor.ok, dialog().locator('button[data-action="ok"]'));
    await page.waitForFunction(known => Object.keys(game.settings.get("loot-crates", "boxes")).some(id => !known.includes(id)) && !__lc.dialog(), out.before.boxIds, { timeout: 8000 });
    await page.waitForTimeout(600);
    out.a.saved = await page.evaluate(known => {
      const box = Object.values(game.settings.get("loot-crates", "boxes")).find(b => !known.includes(b.id));
      return { id: box.id, name: box.name, price: box.price, pools: box.pools, tab: __lc.app.tab, seen: __lc.seen() };
    }, out.before.boxIds);
    out.made.boxes.push(out.a.saved.id);

    // ---------- B. Make a pool inside an empty crate editor ----------
    await click("b", "New crate", page.locator('#loot-crates-manager [data-action="addBox"]'));
    await untilTitle("New crate");
    out.b = { editor: await page.evaluate(() => {
      const d = __lc.dialog();
      const offer = d.querySelector("[data-make-pool]");
      return { title: __lc.title(), ticked: d.querySelectorAll('.lc-pool-pick input[type="checkbox"]:checked').length, offer: offer?.textContent.trim() ?? null, offerShown: !!offer && !offer.closest("[hidden]") };
    }) };
    await dialog().locator('input[name="name"]').fill(CRATE_B);
    const editorB = page.locator(".application.lc-dialog").last();
    await click("b", "Make a pool from a compendium", editorB.locator("[data-make-pool]"));
    await untilTitle("Add from compendium");
    await click("b", "tick Loot", dialog().locator('label.lc-chipbox:has(input[name="types"][value="loot"])'));
    await click("b", "tick Common", dialog().locator('label.lc-chipbox:has(input[name="rarities"][value="common"])'));
    await dialog().locator('input[name="name"]').fill("cloak");
    await click("b", "Preview", dialog().locator('button[data-action="ok"]'));
    await page.waitForFunction(() => /^Add to /.test(__lc.title() ?? ""), null, { timeout: 15000 });
    out.b.preview = { title: await title() };
    await click("b", "Add items", dialog().locator('button[data-action="add"]'));
    await page.waitForFunction(() => __lc.dialog()?.querySelector(".lc-pool-picker__made")?.textContent, null, { timeout: 15000 });
    out.b.made = await page.evaluate(({ name, known }) => {
      const d = __lc.dialog();
      const pool = Object.values(game.settings.get("loot-crates", "pools")).find(p => p.name === name && !known.includes(p.id));
      const tick = pool && d.querySelector(`input[name="pool.${pool.id}"]`);
      return { id: pool?.id ?? null, entries: pool?.entries?.length ?? 0, title: __lc.title(), ticked: !!tick?.checked, focused: !!tick && document.activeElement === tick, said: d.querySelector(".lc-pool-picker__made")?.textContent ?? null, offerHidden: !!d.querySelector(".lc-pool-picker__make")?.closest("[hidden]") || !!d.querySelector(".lc-pool-picker__make[hidden]"), windows: document.querySelectorAll(".application.lc-dialog").length };
    }, { name: CRATE_B, known: out.before.poolIds });
    if (out.b.made.id) out.made.pools.push(out.b.made.id);
    await editorB.locator('input[name="price"]').fill("12 gp");
    const okB = (await editorB.locator('button[data-action="ok"]').textContent()).trim();
    await click("b", okB, editorB.locator('button[data-action="ok"]'));
    await page.waitForFunction(known => Object.keys(game.settings.get("loot-crates", "boxes")).some(id => !known.includes(id)) && !__lc.dialog(), [...out.before.boxIds, ...out.made.boxes], { timeout: 8000 });
    await page.waitForTimeout(600);
    out.b.saved = await page.evaluate(known => {
      const box = Object.values(game.settings.get("loot-crates", "boxes")).find(b => !known.includes(b.id));
      return { id: box.id, name: box.name, price: box.price, pools: box.pools, tab: __lc.app.tab, seen: __lc.seen() };
    }, [...out.before.boxIds, ...out.made.boxes]);
    out.made.boxes.push(out.b.saved.id);
    if (shot) await page.screenshot({ path: shot });

    const a = out.a, b = out.b;
    const said = (s, re) => !!s?.inView && s.first && re.test(s.text ?? "");
    out.count = {
      a: { clicks: out.clicks.a.length, windows: out.windows.a.size, list: [...out.windows.a] },
      b: { clicks: out.clicks.b.length, windows: out.windows.b.size, list: [...out.windows.b] },
      walkthrough: { clicks: 14, windows: 6 },
    };
    out.checks = {
      poolsCollapsed: out.poolsTab.open <= 1,
      namePrompt: a.prompt.title === "New pool" && a.prompt.ok === "Make the pool" && a.prompt.focused && a.prompt.selected && a.prompt.value === "New pool",
      poolMade: a.made.tab === "pools" && a.made.open && a.made.addFocused && a.made.addInView && said(a.made.seen, new RegExp(`^Made the pool ${POOL_NAME}\\.`)),
      chips: a.bulk.title === "Add from compendium" && a.bulk.ok === "Preview" && a.bulk.multiSelects === 0 && (!out.before.hasSrd || a.bulk.pack === "dnd5e.items") && a.bulk.types.includes("weapon+") && a.bulk.types.includes("loot") && a.bulk.rarities.includes("rare+") && a.bulk.rarities.includes("common"),
      previewStep: a.preview.title === `Add to ${POOL_NAME}` && /^Add \d+ items?$/.test(a.preview.add),
      added: a.added.entries > 0 && said(a.added.seen, new RegExp(`^Added \\d+ items? from .+ to ${POOL_NAME}`)),
      crateEditor: a.editor.title === "New crate" && a.editor.ticked === true && a.editor.priceFocused && a.editor.ok === addLabel,
      crateSaved: a.saved.price === 25 && JSON.stringify(a.saved.pools) === JSON.stringify([{ id: a.made.id, share: 1 }]) && a.saved.tab === "boxes" && said(a.saved.seen, /^.+ (is on the shelf at 25 gp|added\. The shop is closed)/),
      clicksA: out.clicks.a.length <= 9,
      offer: b.editor.title === "New crate" && b.editor.ticked === 0 && b.editor.offerShown && b.editor.offer === "Make a pool from a compendium",
      madeInEditor: !!b.made.id && b.made.entries > 0 && b.made.title === "New crate" && b.made.ticked && b.made.focused && b.made.offerHidden && /^Made the pool .+ with \d+ items? and ticked it\.$/.test(b.made.said ?? "") && b.made.windows === 1,
      crateB: b.saved.name === CRATE_B && b.saved.price === 12 && JSON.stringify(b.saved.pools) === JSON.stringify([{ id: b.made.id, share: 1 }]) && said(b.saved.seen, new RegExp(`^${CRATE_B} (is on the shelf at 12 gp|added\\. The shop is closed)`)),
    };
    out.ok = Object.values(out.checks).every(Boolean);
    out.gmConsole = gm.logs;
  } catch (err) {
    out.error = String(err?.stack || err);
    out.ok = false;
  } finally {
    // Only what this run made goes: its crates, then its pools.
    try {
      out.deleted = gm ? await gm.page.evaluate(async ({ base, boxes, pools, stamp }) => {
        const store = await import(base + "scripts/foundry/store.js");
        // And any this run made before a step failed: named with its stamp.
        for (const b of Object.values(store.getBoxes())) if (String(b.name).includes(stamp) && !boxes.includes(b.id)) boxes.push(b.id);
        for (const p of Object.values(store.getPools())) if (String(p.name).includes(stamp) && !pools.includes(p.id)) pools.push(p.id);
        const gone = { boxes: [], pools: [] };
        for (const id of boxes) if (store.getBoxes()[id]) { await store.removeBox(id); gone.boxes.push(id); }
        for (const id of pools) if (store.getPools()[id]) { await store.removePool(id); gone.pools.push(id); }
        for (const app of foundry.applications.instances.values()) if (app.element?.classList?.contains("lc-dialog")) { try { await app.close(); } catch { /* closed */ } }
        try { await globalThis.__lc?.app?.close(); } catch { /* closed */ }
        return gone;
      }, { base: MODULE_BASE, boxes: [...out.made.boxes], pools: [...out.made.pools], stamp: STAMP }) : [];
    } catch (err) { out.deleted = { error: String(err) }; }
    out.windows = { a: [...out.windows.a], b: [...out.windows.b] };
    console.log(JSON.stringify(out, null, 1));
    if (!out.ok) process.exitCode = 1;
    await browser.close();
  }
})();
