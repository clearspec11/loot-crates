// Live check: the manager's Boxes and Pull log tabs in a window a GM has
// sized down to 390 px (boxestable.js, logtable.js, module.css's lc-tab
// container), with the branch's code on the headless Gamemaster.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/headless/live-narrow.cjs [--shot out.png]
//
// Env: BOX (default "Live UI crate", seeded by live-ui.js); WIDTH (default
// 390) for another width: in a pane wider than 560 px (module.css) the rows
// are expected as a table that still fits it, with no button off its edge.
//
// As a GM does: open the manager and drag its resize handle until the
// window is 390 px wide (setPosition stands in if the drag is refused, and
// the result says so). Then:
//
//   1. Click the real Boxes tab: the pane doesn't scroll sideways, the five
//      New buttons fit it, every row stacks as a card with its kind's tag
//      (the crate's reads "Crate") and its Edit, Copy and Delete inside the
//      pane and the window.
//   2. Click the real Edit on the BOX crate: the dialog "Edit box" opens;
//      Cancel closes it with nothing written.
//   3. Click the real Pull log tab: the pane doesn't scroll sideways and
//      every Refund is inside the pane.
//   4. Back on Boxes, reach the last row's Edit with the keyboard (focus
//      it, press Enter): its dialog opens; Escape (or Cancel) closes it.
//
// Reads only; writes nothing. Needs the BOX crate (live-ui.js) and the
// Gamemaster seat free.
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const BOX = process.env.BOX || "Live UI crate";
const WIDTH = Number(process.env.WIDTH || 390);
// The pane width at and under which module.css stacks the rows as cards
// (the lc-tab container query); a wider pane must show the table, fitting.
const STACK_AT = 560;
const shot = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : null;

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && m.text().includes("loot-crates")) errors.push(m.text()); });
  const out = { base: MODULE_BASE, box: BOX, width: WIDTH };
  try {
    await page.goto(FOUNDRY + "/join", { waitUntil: "networkidle" });
    const free = await page.$eval("select[name=userId]", s => [...s.options].some(o => o.textContent.trim() === "Gamemaster" && !o.disabled));
    if (!free) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");
    await page.selectOption("select[name=userId]", { label: "Gamemaster" });
    await page.click("button[name=join], button[type=submit]");
    await page.waitForURL(/\/game/, { timeout: 30000 });
    await page.waitForFunction(() => window.game?.ready, null, { timeout: 120000 });
    // What main.js does first: the branch's words, from its own lang/en.json
    // (the installed release may have no language file, or older words).
    await page.evaluate(async base => (await import(base + "scripts/core/i18n.js")).loadStrings(), MODULE_BASE);

    // The branch's code and styles; the manager opened as the GM opens it.
    await page.evaluate(async base => {
      globalThis.canvas?.app?.ticker?.stop();
      if (!document.querySelector("link[data-lc-branch]")) {
        const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: base + "styles/module.css" });
        link.dataset.lcBranch = "1";
        document.head.append(link);
        await new Promise(r => { link.onload = r; link.onerror = r; });
      }
      const store = await import(base + "scripts/foundry/store.js");
      try { store.registerSettings(); } catch { /* the installed module registered them */ }
      try { store.registerIndexFields?.(); } catch { /* already in CONFIG */ }
      const { openManager } = await import(base + "scripts/foundry/manager.js");
      globalThis.__lcApp = openManager();
      for (let t = 0; t < 100 && !globalThis.__lcApp.element?.querySelector(".lc-tabs [data-tab]"); t++) await new Promise(r => setTimeout(r, 50));
    }, MODULE_BASE);
    const win = page.locator("#loot-crates-manager");
    await win.waitFor({ timeout: 10000 });
    const boxThere = await page.evaluate(async ({ base, name }) => Object.values((await import(base + "scripts/foundry/store.js")).getBoxes()).some(b => b.name === name), { base: MODULE_BASE, name: BOX });
    if (!boxThere) throw new Error(`no ${BOX}: run live-ui.js first`);

    // Size the window down by its handle, as a GM drags it.
    const before = await win.boundingBox();
    const handle = win.locator(".window-resize-handle");
    out.resize = { from: Math.round(before.width), by: "drag" };
    if (await handle.count()) {
      const h = await handle.boundingBox();
      await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) await page.mouse.move(h.x + h.width / 2 - (before.width - WIDTH) * i / 10, h.y + h.height / 2);
      await page.mouse.up();
      await page.waitForTimeout(300);
    }
    let after = await win.boundingBox();
    if (Math.abs(after.width - WIDTH) > 4) {
      await page.evaluate(w => globalThis.__lcApp.setPosition({ width: w }), WIDTH);
      await page.waitForTimeout(300);
      after = await win.boundingBox();
      out.resize.by = "setPosition (the drag left it at " + Math.round(after.width) + ")";
    }
    out.resize.to = Math.round(after.width);

    // What a tab's pane shows, read as a person sees it.
    const readPane = () => page.evaluate(() => {
      const app = globalThis.__lcApp.element;
      const panel = app.querySelector(".lc-tab");
      const pr = panel.getBoundingClientRect();
      const wr = app.getBoundingClientRect();
      const inside = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.left >= pr.left - 1 && r.right <= pr.right + 1 && r.left >= wr.left - 1 && r.right <= wr.right + 1; };
      const label = b => b.getAttribute("aria-label") ?? b.textContent.trim();
      const buttons = [...panel.querySelectorAll("button")];
      const rows = [...panel.querySelectorAll(".lc-table tbody tr")];
      return {
        tab: globalThis.__lcApp.tab,
        paneWidth: Math.round(pr.width),
        sideways: panel.scrollWidth - panel.clientWidth,
        toolbarFits: [...panel.querySelectorAll(".lc-toolbar")].every(t => t.scrollWidth <= t.clientWidth + 1 && t.getBoundingClientRect().right <= pr.right + 1),
        newButtons: [...panel.querySelectorAll('.lc-toolbar [data-action^="add"]')].map(label),
        rows: rows.length,
        stacked: rows.length ? rows.every(tr => getComputedStyle(tr).display === "grid") : null,
        headerHidden: panel.querySelector(".lc-table thead") ? panel.querySelector(".lc-table thead").getBoundingClientRect().width <= 2 : null,
        roles: !!panel.querySelector('.lc-table[role="table"]') && rows.every(tr => tr.getAttribute("role") === "row"),
        tags: rows.map(tr => tr.querySelector(".lc-kind")?.textContent ?? null),
        offScreen: buttons.filter(b => !inside(b)).map(label),
        actions: rows.map(tr => [...tr.lastElementChild.querySelectorAll("[data-action]")].map(b => b.dataset.action)),
        refunds: panel.querySelectorAll('[data-action="refund"]').length,
      };
    });
    const dialog = () => page.evaluate(() => { const d = [...document.querySelectorAll(".application.lc-dialog")].pop(); return d ? { title: d.querySelector(".window-title")?.textContent.trim() ?? null, focusInside: d.contains(document.activeElement) } : null; });
    const waitDialog = (open, ms = 8000) => page.waitForFunction(o => !![...document.querySelectorAll(".application.lc-dialog")].pop() === o, open, { timeout: ms }).then(() => true, () => false);
    const boxesBefore = await page.evaluate(async base => JSON.stringify((await import(base + "scripts/foundry/store.js")).getBoxes()), MODULE_BASE);

    // 1. The Boxes tab, by its real tab button.
    await win.locator('.lc-tabs [data-tab="boxes"]').click();
    await page.waitForFunction(() => globalThis.__lcApp.tab === "boxes" && globalThis.__lcApp.element.querySelector(".lc-toolbar--boxes"), null, { timeout: 10000 });
    await page.waitForTimeout(400);
    out.boxes = await readPane();
    const crate = await page.evaluate(async ({ base, name }) => Object.values((await import(base + "scripts/foundry/store.js")).getBoxes()).find(b => b.name === name)?.id ?? null, { base: MODULE_BASE, name: BOX });
    out.boxes.crateTag = await page.evaluate(id => globalThis.__lcApp.element.querySelector(`[data-action="editBox"][data-box="${id}"]`)?.closest("tr")?.querySelector(".lc-kind")?.textContent ?? null, crate);
    if (shot) await page.screenshot({ path: shot });

    // 2. The real Edit on the crate; Cancel writes nothing.
    await win.locator(`[data-action="editBox"][data-box="${crate}"]`).click();
    out.edit = { opened: await waitDialog(true), ...(await dialog() ?? {}) };
    if (out.edit.opened) {
      await page.locator('.application.lc-dialog button[data-action="cancel"]').last().click();
      out.edit.closed = await waitDialog(false);
    }
    out.edit.written = (await page.evaluate(async base => JSON.stringify((await import(base + "scripts/foundry/store.js")).getBoxes()), MODULE_BASE)) !== boxesBefore;

    // 3. The Pull log, by its real tab button.
    await win.locator('.lc-tabs [data-tab="log"]').click();
    await page.waitForFunction(() => globalThis.__lcApp.tab === "log", null, { timeout: 10000 });
    await page.waitForTimeout(400);
    out.log = await readPane();
    if (shot) await page.screenshot({ path: shot.replace(/\.png$/, "-log.png") });

    // 4. Back on Boxes: the last row's Edit by keyboard.
    await win.locator('.lc-tabs [data-tab="boxes"]').click();
    await page.waitForFunction(() => globalThis.__lcApp.tab === "boxes" && globalThis.__lcApp.element.querySelector('[data-action="editBox"]'), null, { timeout: 10000 });
    await page.waitForTimeout(400);
    const lastEdit = win.locator('.lc-table tbody tr').last().locator('[data-action="editBox"]');
    await lastEdit.focus();
    out.keyboard = { label: await lastEdit.getAttribute("aria-label"), focused: await page.evaluate(() => document.activeElement?.dataset.action === "editBox") };
    await page.keyboard.press("Enter");
    out.keyboard.opened = await waitDialog(true);
    Object.assign(out.keyboard, await dialog() ?? {});
    if (out.keyboard.opened) {
      await page.keyboard.press("Escape");
      out.keyboard.escapeClosed = await waitDialog(false, 3000);
      if (!out.keyboard.escapeClosed) { await page.locator('.application.lc-dialog button[data-action="cancel"]').last().click(); out.keyboard.cancelClosed = await waitDialog(false); }
    }
    out.keyboard.written = (await page.evaluate(async base => JSON.stringify((await import(base + "scripts/foundry/store.js")).getBoxes()), MODULE_BASE)) !== boxesBefore;

    const b = out.boxes, l = out.log;
    // Rows stack in a pane of STACK_AT or narrower; a wider one shows the
    // table, which must still fit it (no sideways scroll, no button off it).
    const stacks = b.paneWidth <= STACK_AT;
    out.stacks = stacks;
    out.ok = Math.abs(out.resize.to - WIDTH) <= 4
      && b.tab === "boxes" && b.sideways <= 0 && b.toolbarFits && b.newButtons.length === 5 && b.rows > 0 && b.stacked === stacks && b.headerHidden === stacks && b.roles
      && b.tags.every(Boolean) && b.crateTag === "Crate" && b.offScreen.length === 0 && b.actions.every(a => a.slice(-3).join("|") === "editBox|copyBox|deleteBox")
      && out.edit.opened && out.edit.title === "Edit box" && out.edit.closed && !out.edit.written
      && l.tab === "log" && l.sideways <= 0 && l.offScreen.length === 0 && (l.rows === 0 || (l.stacked === stacks && l.roles))
      && out.keyboard.focused && out.keyboard.opened && /^Edit /.test(out.keyboard.title ?? "") && (out.keyboard.escapeClosed || out.keyboard.cancelClosed) && !out.keyboard.written
      && errors.length === 0;
  } catch (e) {
    out.ok = false;
    out.error = String(e?.stack || e);
  } finally {
    out.errors = errors;
    await page.evaluate(() => globalThis.__lcApp?.close()).catch(() => {});
    await browser.close();
  }
  console.log(JSON.stringify(out, null, 1));
  process.exit(out.ok ? 0 : 1);
})();
