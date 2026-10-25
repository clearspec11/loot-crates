// Live check: a pool shows which boxes draw from it, and its destructive
// actions name the boxes they would empty before anything happens.
//
// Seeds a test pool holding one item and a test box that draws only from it
// (both the module's own settings, stable ids, so a rerun overwrites them),
// opens the manager and reads the pool's header line. Then clicks the pool's
// Delete button and reads the DialogV2 confirm for the box's name and the
// "nothing inside" sentence, and clicks No; then clicks Remove on the pool's
// only item, reads that confirm, and clicks No. Reports that the pool and its
// item are still there.
//
// Then another GM's edit, with the manager left on the Pools tab: a second
// test pool no box uses ("Not in any box") has a search typed in it, and the
// test box's pools are changed outside this window (the same world-setting
// write another GM's Save makes; every client hears its onChange). The second
// pool's line must read "In Live users check crate" within ~1 s, patched in
// place: the tab's content is the same node, the typed search and focus are
// kept. A stock-only change to the box must then touch nothing (the same
// line node and text node). The box is put back as it was. Never deletes
// anything.
//
//   FOUNDRY_URL=http://192.168.0.57:30000 MODULE_BASE=http://192.168.0.190:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/headless/run.cjs foundry-dev/checks/live-pool-users.js [--shot users.png]
if (!document.querySelector("link[data-loot-crates]")) {
  const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: MODULE_BASE + "styles/module.css" });
  link.dataset.lootCrates = "1";
  document.head.appendChild(link);
}
// The software-rendered canvas holds this VM's main thread (and every timer)
// for most of a second at a time; the manager doesn't need it.
globalThis.canvas?.app?.ticker?.stop();
const store = await import(MODULE_BASE + "scripts/foundry/store.js");
try { store.registerSettings(); } catch (e) { if (!/already registered/i.test(String(e))) throw e; }
store.registerIndexFields();
// The branch's redraw, as main.js wires it: the installed module registered
// the settings, so its onChange calls its own listener, not this one.
const { storeRedraw } = await import(MODULE_BASE + "scripts/core/redraw.js");
const { refreshShop } = await import(MODULE_BASE + "scripts/foundry/shop.js");
const { openManager, refreshManager } = await import(MODULE_BASE + "scripts/foundry/manager.js");
const redraw = storeRedraw({ refreshShop, refreshManager });
store.setStoreListener(redraw);
for (const key of store.WORLD_KEYS) {
  const cfg = game.settings.settings.get(`loot-crates.${key}`);
  if (cfg && !String(cfg.onChange ?? "").includes("storeChanged")) cfg.onChange = () => redraw(key);
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { for (let t = 0; t < ms && !fn(); t += 100) await wait(100); return fn(); };
const click = el => el?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));

const errors = [];
const onError = e => errors.push(String(e.error?.message ?? e.message ?? e.reason?.message ?? e.reason));
window.addEventListener("error", onError);
window.addEventListener("unhandledrejection", onError);

// One real item from dnd5e's compendium as the pool's only entry.
const pack = game.packs.get("dnd5e.items");
const index = await pack.getIndex({ fields: store.INDEX_FIELDS });
const row = [...index].find(r => store.isLootType(r.type) && /^Potion of Healing$/.test(r.name)) ?? [...index].find(r => store.isLootType(r.type));
const item = store.entryFromItem(row, row.uuid ?? `Compendium.dnd5e.items.Item.${row._id}`);
const POOL = "live-users-pool", POOL2 = "live-users-pool-2", BOX = "live-users-box";
const BOX_AS_SEEDED = { id: BOX, name: "Live users check crate", price: 1, pools: [{ id: POOL, share: 1 }], weights: {}, rules: {} };
await store.savePool({ id: POOL, name: "Live users check pool", entries: [item], pools: [] });
await store.savePool({ id: POOL2, name: "Live users second pool", entries: [item], pools: [] });
await store.saveBox(BOX_AS_SEEDED);

const app = openManager();
const card = () => app.element?.querySelector(`[data-drop-pool="${POOL}"]`);
const card2 = () => app.element?.querySelector(`[data-drop-pool="${POOL2}"]`);
const users2 = () => card2()?.querySelector("summary .lc-pool__users") ?? null;
const tabBody = () => app.element?.querySelector(".lc-manager__body") ?? null;
const dialogs = () => [...document.querySelectorAll(".application.dialog")];
// Press a button, wait for the confirm it opens, read it and press No.
async function confirmText(button, title) {
  const before = new Set(dialogs());
  button.focus();
  click(button);
  const found = await until(() => dialogs().find(d => !before.has(d) && d.querySelector(".window-title")?.textContent.includes(title)));
  if (!found) return { opened: false };
  const out = { opened: true, title: found.querySelector(".window-title")?.textContent.trim(), text: found.querySelector(".window-content")?.textContent.replace(/\s+/g, " ").trim() };
  const no = found.querySelector('[data-action="no"]');
  out.noLabel = no?.textContent.trim() ?? null;
  click(no);
  out.closed = !!await until(() => !found.isConnected, 4000);
  return out;
}
try {
  await until(() => card());
  // Open the pool if it starts collapsed (it shouldn't, with one entry).
  const details = card()?.querySelector(".lc-pool__details");
  if (details && !details.open) { details.open = true; await until(() => card()?.querySelector(".lc-entry")); }
  const header = card()?.querySelector("summary .lc-pool__users")?.textContent ?? null;
  const del = await confirmText(card().querySelector('[data-action="deletePool"]'), "Delete pool");
  await wait(300);
  const remove = await confirmText(card().querySelector(".lc-entry .lc-entry__remove"), "Remove item");
  await wait(300);
  // A source check landing late renders the whole tab; let it land first.
  await until(() => !app.checking, 15000);
  // Another GM adds the second pool to the box while this manager sits on
  // Pools with a search typed in that pool.
  const search = card2()?.querySelector(".lc-pool__search");
  search?.focus();
  if (search) { search.value = "Potion"; search.dispatchEvent(new Event("input", { bubbles: true })); }
  await wait(500);
  const body = tabBody();
  const remote = { tab: app.tab, before: users2()?.textContent ?? null };
  // The moment the line's text changes, not the next poll after it.
  let shownAt = null;
  const seen = new MutationObserver(() => { if (shownAt == null && users2()?.textContent === "In Live users check crate") shownAt = performance.now(); });
  if (card2()) seen.observe(card2(), { subtree: true, childList: true, characterData: true });
  const t0 = performance.now();
  // When this client hears the change: Foundry calls onChange as the
  // server's update arrives, which is when another GM's edit arrives too.
  let heardAt = null;
  const heard = Hooks.on("updateSetting", setting => { if (setting.key === "loot-crates.boxes" && heardAt == null) heardAt = performance.now(); });
  await store.updateBox(BOX, b => ({ ...b, pools: [...b.pools, { id: POOL2, share: 1 }] }));
  remote.writeMs = Math.round(performance.now() - t0);
  remote.updated = !!await until(() => users2()?.textContent === "In Live users check crate", 3000);
  seen.disconnect();
  shownAt ??= performance.now();
  Hooks.off("updateSetting", heard);
  remote.totalMs = Math.round(shownAt - t0);
  remote.ms = heardAt == null ? null : Math.round(shownAt - heardAt);
  remote.after = users2()?.textContent ?? null;
  remote.sameContent = tabBody() === body;
  remote.searchKept = !!search?.isConnected && search.value === "Potion";
  remote.focusKept = document.activeElement === search;
  remote.tabAfter = app.tab;
  // A pull that only counts down the box's stock writes the same key.
  const line = users2(), text = line?.firstChild;
  await store.updateBox(BOX, b => ({ ...b, rules: { ...b.rules, stock: 7 } }));
  await wait(800);
  const stockOnly = { sameLine: users2() === line, sameText: users2()?.firstChild === text, sameContent: tabBody() === body, focusKept: document.activeElement === search, text: users2()?.textContent ?? null };
  // And back, the same way.
  await store.updateBox(BOX, () => ({ ...BOX_AS_SEEDED }));
  remote.restored = !!await until(() => users2()?.textContent === "Not in any box", 3000);
  remote.ok = remote.before === "Not in any box" && remote.updated && remote.ms != null && remote.ms < 1000 && remote.sameContent && remote.searchKept && remote.focusKept && remote.tabAfter === "pools" && remote.restored;
  stockOnly.ok = stockOnly.sameLine && stockOnly.sameText && stockOnly.sameContent && stockOnly.focusKept && stockOnly.text === "In Live users check crate";
  if (search) { search.value = ""; search.dispatchEvent(new Event("input", { bubbles: true })); }

  const pool = store.getPools()[POOL];
  const result = {
    header,
    deleteDialog: del,
    removeDialog: remove,
    remote,
    stockOnly,
    poolKept: !!pool,
    itemKept: pool?.entries?.some(e => e.uuid === item.uuid) ?? false,
    boxKept: !!store.getBoxes()[BOX],
    errors,
  };
  result.ok = header === "In Live users check crate"
    && del.opened && del.closed && /It is in Live users check crate\./.test(del.text) && /Live users check crate will have nothing inside and can't be bought until it has an item that can drop\./.test(del.text)
    && remove.opened && remove.closed && /last item Live users check crate can drop/.test(remove.text)
    && remote.ok && stockOnly.ok
    && result.poolKept && result.itemKept && result.boxKept && !errors.length;
  return result;
} finally {
  // The box as seeded, even when a step above failed.
  if (JSON.stringify(store.getBoxes()[BOX]) !== JSON.stringify(BOX_AS_SEEDED)) await store.saveBox(BOX_AS_SEEDED);
  window.removeEventListener("error", onError);
  window.removeEventListener("unhandledrejection", onError);
  await app.close();
}
