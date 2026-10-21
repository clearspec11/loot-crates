// Live check: the shop follows ownership while it is open.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/headless/live-ownership.cjs [--shot out.png]
//
// Env: PLAYER (default Player2), ACTOR (default "Crate Tester", which must
// be in the Actors folder "Loot Crates Test" and owned by PLAYER), BOX
// (default "Live UI crate", a crate the actor can buy).
//
// Two headless clients with the branch's shop and socket code, as
// player-pull.cjs sets them up; needs the Gamemaster seat free (exits 2 when
// a person holds it). The player opens the shop on ACTOR. The GM takes
// PLAYER's ownership of ACTOR down to Observer as a GM does it (the Actors
// sidebar, right-click the actor, Configure Ownership, PLAYER's select,
// Save). Within a second the player's open shop must stop offering ACTOR:
// no live Buy, no ACTOR in the picker or purse. The player then clicks the
// crate's Buy anyway, and no pull may go out on the socket (nor a reveal or
// a refusal toast). The GM gives Owner back the same way, and ACTOR must
// come back in the same open shop, with its Buy live, without reopening it.
// PLAYER's ownership is put back as it was in a finally, even when the check
// fails (through the data API if the dialog can't be used).
//
// No purchase; never deletes anything.
/* global game, foundry, Hooks, ui */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";
const PLAYER = process.env.PLAYER || "Player2";
const ACTOR = process.env.ACTOR || "Crate Tester";
const BOX = process.env.BOX || "Live UI crate";
const FOLDER = "Loot Crates Test";
const OBSERVER = 2;
const OWNER = 3;
const shot = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : null;

async function join(browser, user) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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
    const { refreshManager } = await import(base + "scripts/manager.js");
    const redraw = storeRedraw({ refreshShop, refreshManager });
    store.setStoreListener(redraw);
    for (const key of store.WORLD_KEYS) {
      const cfg = game.settings.settings.get(`loot-crates.${key}`);
      if (cfg && !String(cfg.onChange ?? "").includes("storeChanged")) cfg.onChange = () => redraw(key);
    }
    registerShopHooks(Hooks);
  }, MODULE_BASE);
  return { page, logs };
}

// The GM sets PLAYER's level on ACTOR as a person does: the Actors tab,
// right-click the actor, Configure Ownership, the player's select, Save.
async function setLevel(gm, actorId, userId, level) {
  await gm.locator('#sidebar-tabs [data-tab="actors"], nav.tabs [data-tab="actors"]').first().click();
  const entry = gm.locator(`#actors li.directory-item[data-entry-id="${actorId}"]`).first();
  await entry.waitFor({ state: "attached", timeout: 10000 });
  // Its folders may be collapsed on this client: open them, outermost
  // first, as a person would.
  const folders = gm.locator("#actors li.folder").filter({ has: gm.locator(`li[data-entry-id="${actorId}"]`) });
  for (let i = 0; i < await folders.count() && !(await entry.isVisible()); i++) {
    const header = folders.nth(i).locator(":scope > header.folder-header");
    if (!(await folders.nth(i).locator(":scope > ol.subdirectory").isVisible())) await header.click();
  }
  await entry.waitFor({ timeout: 10000 });
  await entry.scrollIntoViewIfNeeded();
  await entry.click({ button: "right" });
  await gm.locator("#context-menu li", { hasText: "Configure Ownership" }).first().click();
  const form = gm.locator(`form.document-ownership[id*="${actorId}"]`).first();
  await form.waitFor({ timeout: 10000 });
  await form.locator(`select[name="${userId}"]`).selectOption(String(level));
  const at = Date.now();
  await form.locator('button[type="submit"]').click();
  await gm.waitForFunction(([a, u, l]) => game.actors.get(a)?.ownership?.[u] === l, [actorId, userId, level], { timeout: 10000 });
  return at;
}

(async () => {
  const browser = await chromium.launch();
  const out = { player: PLAYER, actor: ACTOR, box: BOX };
  let gm = null, actorId = null, userId = null, original = null;
  try {
    gm = await join(browser, "Gamemaster");
    if (!gm) { out.error = "the Gamemaster seat is taken: unverifiable"; process.exitCode = 2; return; }
    const facts0 = await gm.page.evaluate(([name, player]) => {
      const a = game.actors.getName(name);
      const u = game.users.getName(player);
      return { actorId: a?.id ?? null, userId: u?.id ?? null, folder: a?.folder?.name ?? null, level: a && u ? a.ownership[u.id] ?? null : null };
    }, [ACTOR, PLAYER]);
    ({ actorId, userId } = facts0);
    out.before = { folder: facts0.folder, level: facts0.level };
    if (!actorId || !userId) throw new Error(`no actor ${ACTOR} or user ${PLAYER}`);
    if (facts0.folder !== FOLDER) throw new Error(`${ACTOR} is not in the ${FOLDER} folder (${facts0.folder}); not touching it`);
    if (facts0.level !== OWNER) throw new Error(`${PLAYER} doesn't own ${ACTOR} to begin with (level ${facts0.level})`);
    original = facts0.level;

    const pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    // The player's shop, opened once; what it shows, and every pull it sends.
    await pl.page.evaluate(async base => {
      const { openShop } = await import(base + "scripts/shop.js");
      const shop = openShop();
      globalThis.__lcShop = shop;
      globalThis.__lcPulls = [];
      globalThis.__lcToasts = [];
      globalThis.__lcUpdates = [];
      const emit = game.socket.emit.bind(game.socket);
      game.socket.emit = (channel, msg, ...rest) => {
        if (channel === "module.loot-crates" && msg?.type === "pull") globalThis.__lcPulls.push({ at: Date.now(), actorId: msg.actorId, boxId: msg.boxId });
        return emit(channel, msg, ...rest);
      };
      for (const kind of ["info", "warn", "error"]) {
        const orig = ui.notifications[kind].bind(ui.notifications);
        ui.notifications[kind] = (m, o) => { globalThis.__lcToasts.push({ kind, msg: String(m) }); return orig(m, o); };
      }
      Hooks.on("updateActor", (_a, change) => { if (change.ownership) globalThis.__lcUpdates.push(Date.now()); });
    }, MODULE_BASE);
    const facts = () => pl.page.evaluate(([box, actorId]) => {
      const shop = globalThis.__lcShop;
      const el = shop?.element;
      const card = el && [...el.querySelectorAll(".lc-box")].find(c => c.querySelector(".lc-box__name")?.textContent.trim() === box);
      const buy = card?.querySelector(".lc-box__buy");
      const select = el?.querySelector(".lc-shop__actor");
      return {
        rendered: !!shop?.rendered, sameShop: [...foundry.applications.instances.values()].filter(a => a.id === "loot-crates-shop").length === 1 && el?.isConnected,
        who: el?.querySelector(".lc-shop__who")?.textContent.trim() ?? null,
        options: select ? [...select.options].map(o => o.textContent.trim()) : null, picked: select ? select.selectedOptions[0]?.textContent.trim() ?? null : null,
        purse: el?.querySelector(".lc-shop__purse")?.textContent.trim() ?? null, notice: el?.querySelector(".lc-shop__notice")?.textContent.trim() ?? null,
        boxId: card?.dataset.box ?? null, label: buy?.textContent.replace(/\s+/g, " ").trim() ?? null,
        liveBuys: el ? [...el.querySelectorAll(".lc-box__buy")].filter(b => b.getAttribute("aria-disabled") !== "true").length : null,
        boxLive: !!buy && buy.getAttribute("aria-disabled") !== "true",
        shopActorId: shop?.actorId ?? null, ownsActor: game.actors.get(actorId)?.isOwner ?? null,
        reveals: document.querySelectorAll(".lc-reveal").length, pulls: globalThis.__lcPulls.length,
        purseData: JSON.stringify(game.actors.get(actorId)?.system.currency ?? null),
      };
    }, [BOX, actorId]);
    await pl.page.waitForFunction(box => [...(globalThis.__lcShop?.element?.querySelectorAll(".lc-box__name") ?? [])].some(n => n.textContent.trim() === box), BOX, { timeout: 10000 });
    await pl.page.waitForTimeout(800);
    const before = await facts();
    out.open = before;
    const names = f => [f.who, f.picked].filter(Boolean);
    if (!before.boxId) throw new Error(`no crate named ${BOX} in ${PLAYER}'s shop`);
    if (!names(before).includes(ACTOR) || !before.boxLive) throw new Error(`the shop isn't on ${ACTOR} with a live Buy before the check (${JSON.stringify(before)})`);
    // The window itself, so "reappears without reopening" means this one.
    await pl.page.evaluate(() => { globalThis.__lcShop.element.__lcSame = true; });

    // 1. The GM takes the player down to Observer.
    const savedAt = await setLevel(gm.page, actorId, userId, OBSERVER);
    await pl.page.waitForFunction(name => {
      const el = globalThis.__lcShop?.element;
      if (!el) return false;
      const live = [...el.querySelectorAll(".lc-box__buy")].some(b => b.getAttribute("aria-disabled") !== "true");
      const shown = [el.querySelector(".lc-shop__who")?.textContent.trim(), el.querySelector(".lc-shop__actor")?.selectedOptions[0]?.textContent.trim()];
      return !live && !shown.includes(name);
    }, ACTOR, { timeout: 10000, polling: 25 }).catch(() => {});
    const goneAt = Date.now();
    const gone = await facts();
    const updateAt = await pl.page.evaluate(() => globalThis.__lcUpdates[0] ?? null);
    if (shot) await pl.page.screenshot({ path: shot });
    // 2. The player presses the crate's Buy anyway, with the mouse and with
    // Enter. It is aria-disabled, which Playwright won't click without
    // force; a person's click still reaches it (it isn't disabled).
    const buy = pl.page.locator(`.lc-shop .lc-box__buy[data-box="${before.boxId}"]`);
    await buy.click({ force: true });
    await buy.focus();
    await pl.page.keyboard.press("Enter");
    await pl.page.waitForTimeout(1500);
    const pressed = await facts();
    out.observer = {
      saveToShopMs: goneAt - savedAt, updateSeenAfterSaveMs: updateAt ? updateAt - savedAt : null,
      who: gone.who, options: gone.options, purse: gone.purse, notice: gone.notice, liveBuys: gone.liveBuys, label: gone.label, shopActorId: gone.shopActorId,
      afterPress: { pulls: pressed.pulls, reveals: pressed.reveals, purseSame: pressed.purseData === before.purseData, toasts: await pl.page.evaluate(() => globalThis.__lcToasts.splice(0)) },
    };
    out.observer.ok = gone.ownsActor === false && gone.liveBuys === 0 && !names(gone).includes(ACTOR) && gone.purse == null
      && out.observer.saveToShopMs <= 1000 && pressed.pulls === 0 && pressed.reveals === before.reveals && out.observer.afterPress.purseSame
      && !out.observer.afterPress.toasts.length;

    // 3. The GM gives Owner back; the same open shop shows the actor again.
    const backAt = await setLevel(gm.page, actorId, userId, OWNER);
    await pl.page.waitForFunction(([box, name]) => {
      const el = globalThis.__lcShop?.element;
      const card = el && [...el.querySelectorAll(".lc-box")].find(c => c.querySelector(".lc-box__name")?.textContent.trim() === box);
      const shown = [el?.querySelector(".lc-shop__who")?.textContent.trim(), el?.querySelector(".lc-shop__actor")?.selectedOptions[0]?.textContent.trim()];
      return shown.includes(name) && card?.querySelector(".lc-box__buy")?.getAttribute("aria-disabled") !== "true";
    }, [BOX, ACTOR], { timeout: 10000, polling: 25 }).catch(() => {});
    const backMs = Date.now() - backAt;
    const back = await facts();
    out.owner = {
      saveToShopMs: backMs, who: back.who, picked: back.picked, purse: back.purse, label: back.label, boxLive: back.boxLive, shopActorId: back.shopActorId,
      sameWindow: await pl.page.evaluate(() => globalThis.__lcShop.element.__lcSame === true) && back.sameShop, pulls: back.pulls,
    };
    out.owner.ok = names(back).includes(ACTOR) && back.boxLive && back.shopActorId === actorId && back.purse === before.purse && out.owner.sameWindow && back.pulls === 0 && backMs <= 1000;
    out.playerLog = pl.logs;
    out.gmConsole = gm.logs;
  } catch (err) {
    out.error = String(err?.stack || err);
    process.exitCode = 1;
  } finally {
    // PLAYER's ownership back as it was, as the GM sets it; through the data
    // API only if the dialog couldn't be used.
    if (gm && actorId && userId && original != null) {
      try {
        const now = await gm.page.evaluate(([a, u]) => game.actors.get(a).ownership[u], [actorId, userId]);
        if (now !== original) {
          try { await setLevel(gm.page, actorId, userId, original); } catch (err) {
            out.restoreDialogError = String(err);
            await gm.page.evaluate(([a, u, l]) => game.actors.get(a).update({ ownership: { [u]: l } }), [actorId, userId, original]);
          }
        }
        out.restored = await gm.page.evaluate(([a, u]) => ({ level: game.actors.get(a).ownership[u], folder: game.actors.get(a).folder?.name ?? null }), [actorId, userId]);
      } catch (err) { out.restored = { error: String(err) }; }
    }
    out.ok = !!(out.observer?.ok && out.owner?.ok && out.restored?.level === original && out.restored?.folder === FOLDER);
    if (!out.ok && process.exitCode == null) process.exitCode = 1;
    console.log(JSON.stringify(out, null, 1));
    await browser.close();
  }
})();
