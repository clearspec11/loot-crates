// Live check: the Pull log's Character and Game pickers (logtable.js
// filterLog, manager.js logFilter), with the branch's code on the headless
// Gamemaster, on the world's own log.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/checks/live-log-filter.cjs [--shot out.png]
//
// As a GM does: open the manager, click the real Pull log tab. Then:
//
//   1. Pick the character with the most rows in the real Character picker:
//      every row left is theirs (or a round's line over their stakes), the
//      count says how many of how many, and focus stays on the picker
//      through the redraw.
//   2. Pick in the real Game picker the game they played most: every row is
//      that character at that game.
//   3. Press the real Show all: every row is back, the pickers read Every
//      character and Every game, and focus lands on the Character picker.
//
// Reads only; writes nothing. Needs a Pull log with at least two
// characters in it (any world that has had a session of pulls) and the
// Gamemaster seat free.
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const shot = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : null;

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && m.text().includes("loot-crates")) errors.push(m.text()); });
  const out = { base: MODULE_BASE };
  try {
    await page.goto(FOUNDRY + "/join", { waitUntil: "networkidle" });
    const free = await page.$eval("select[name=userId]", s => [...s.options].some(o => o.textContent.trim() === "Gamemaster" && !o.disabled));
    if (!free) throw new Error("the Gamemaster seat is taken; this check needs the headless Gamemaster");
    await page.selectOption("select[name=userId]", { label: "Gamemaster" });
    await page.click("button[name=join], button[type=submit]");
    await page.waitForURL(/\/game/, { timeout: 30000 });
    await page.waitForFunction(() => window.game?.ready, null, { timeout: 120000 });
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

    // Who played most, and where, from the world's log (the expected rows).
    const plan = await page.evaluate(async base => {
      const log = (await import(base + "scripts/foundry/store.js")).getLog();
      const count = key => log.reduce((m, r) => (r[key] && !r.house ? m.set(r[key], (m.get(r[key]) ?? 0) + 1) : m), new Map());
      const top = m => [...m].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const actor = top(count("actorId"));
      const mine = log.filter(r => r.actorId === actor);
      const box = top(mine.reduce((m, r) => m.set(r.boxId, (m.get(r.boxId) ?? 0) + 1), new Map()));
      return { total: log.length, actors: count("actorId").size, actor, actorName: mine[0]?.actorName ?? null, mine: mine.length, box, both: mine.filter(r => r.boxId === box).length, boxName: mine.find(r => r.boxId === box)?.boxName ?? null };
    }, MODULE_BASE);
    out.plan = plan;
    if (plan.actors < 2) throw new Error(`the world's Pull log has ${plan.actors} character(s); this check needs two`);

    await win.locator('.lc-tabs [data-tab="log"]').click();
    await page.waitForFunction(() => globalThis.__lcApp.tab === "log" && globalThis.__lcApp.element.querySelector("[data-log-filter]"), null, { timeout: 10000 });

    const read = () => page.evaluate(() => {
      const app = globalThis.__lcApp.element;
      const pick = k => app.querySelector(`select[data-log-filter="${k}"]`);
      const rows = [...app.querySelectorAll(".lc-table--log tbody tr")];
      return {
        actorPick: pick("actor")?.selectedOptions[0]?.textContent ?? null,
        boxPick: pick("box")?.selectedOptions[0]?.textContent ?? null,
        rows: rows.length,
        who: [...new Set(rows.map(tr => tr.querySelector('[data-label="Who"]')?.textContent.trim()))],
        boxes: [...new Set(rows.filter(tr => !tr.classList.contains("lc-row--group")).map(tr => tr.querySelector('[data-label="Game"]')?.textContent.trim().replace(/ \(.*\)$/, "")))],
        count: app.querySelector(".lc-log__count")?.textContent ?? null,
        showAll: !!app.querySelector('[data-action="clearLogFilter"]'),
        focus: document.activeElement?.dataset?.logFilter ?? document.activeElement?.dataset?.action ?? document.activeElement?.tagName ?? null,
        empty: app.querySelector(".lc-tab > .lc-empty")?.textContent ?? null,
      };
    });
    out.all = await read();

    // 1. The character, by the real picker.
    await win.locator('select[data-log-filter="actor"]').focus();
    await win.locator('select[data-log-filter="actor"]').selectOption(plan.actor);
    await page.waitForFunction(() => globalThis.__lcApp.logFilter.actor && document.querySelector('[data-action="clearLogFilter"]'), null, { timeout: 10000 });
    await page.waitForTimeout(300);
    out.actor = await read();
    if (shot) await page.screenshot({ path: shot });

    // 2. And their most-played game.
    await win.locator('select[data-log-filter="box"]').focus();
    await win.locator('select[data-log-filter="box"]').selectOption(plan.box);
    await page.waitForFunction(() => globalThis.__lcApp.logFilter.box, null, { timeout: 10000 });
    await page.waitForTimeout(300);
    out.both = await read();

    // 3. Show all.
    await win.locator('[data-action="clearLogFilter"]').click();
    await page.waitForFunction(() => !globalThis.__lcApp.logFilter.actor && !globalThis.__lcApp.logFilter.box, null, { timeout: 10000 });
    await page.waitForTimeout(300);
    out.cleared = await read();

    const okWho = r => r.who.every(w => w === plan.actorName || w === "Round");
    out.ok = out.all.actorPick === "Every character" && out.all.boxPick === "Every game" && !out.all.showAll
      && out.actor.actorPick === plan.actorName && okWho(out.actor) && out.actor.count === `Showing ${plan.mine} of ${plan.total} rows` && out.actor.focus === "actor" && out.actor.showAll
      && out.both.boxPick === plan.boxName && okWho(out.both) && out.both.boxes.every(b => b === plan.boxName) && out.both.count === `Showing ${plan.both} of ${plan.total} rows` && out.both.focus === "box"
      && out.cleared.actorPick === "Every character" && out.cleared.boxPick === "Every game" && out.cleared.rows === out.all.rows && !out.cleared.showAll && out.cleared.focus === "actor"
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
