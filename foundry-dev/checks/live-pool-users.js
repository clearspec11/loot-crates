// Live check: a pool shows which boxes draw from it, and its destructive
// actions name the boxes they would empty before anything happens.
//
// Seeds a test pool holding one item and a test box that draws only from it
// (both the module's own settings, stable ids, so a rerun overwrites them),
// opens the manager and reads the pool's header line. Then clicks the pool's
// Delete button and reads the DialogV2 confirm for the box's name and the
// "nothing inside" sentence, and clicks No; then clicks Remove on the pool's
// only item, reads that confirm, and clicks No. Reports that the pool and its
// item are still there. Never deletes anything.
//
//   FOUNDRY_URL=http://192.168.0.57:30000 MODULE_BASE=http://192.168.0.190:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/headless/run.cjs foundry-dev/checks/live-pool-users.js [--shot users.png]
if (!document.querySelector("link[data-loot-crates]")) {
  const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: MODULE_BASE + "styles/module.css" });
  link.dataset.lootCrates = "1";
  document.head.appendChild(link);
}
const store = await import(MODULE_BASE + "scripts/store.js");
try { store.registerSettings(); } catch (e) { if (!/already registered/i.test(String(e))) throw e; }
store.registerIndexFields();
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
const POOL = "live-users-pool", BOX = "live-users-box";
await store.savePool({ id: POOL, name: "Live users check pool", entries: [item], pools: [] });
await store.saveBox({ id: BOX, name: "Live users check crate", price: 1, pools: [{ id: POOL, share: 1 }], weights: {}, rules: {} });

const { openManager } = await import(MODULE_BASE + "scripts/manager.js");
const app = openManager();
const card = () => app.element?.querySelector(`[data-drop-pool="${POOL}"]`);
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
  const pool = store.getPools()[POOL];
  const result = {
    header,
    deleteDialog: del,
    removeDialog: remove,
    poolKept: !!pool,
    itemKept: pool?.entries?.some(e => e.uuid === item.uuid) ?? false,
    boxKept: !!store.getBoxes()[BOX],
    errors,
  };
  result.ok = header === "In Live users check crate"
    && del.opened && del.closed && /It is in Live users check crate\./.test(del.text) && /Live users check crate will have nothing inside and can't be bought until it has an item that can drop\./.test(del.text)
    && remove.opened && remove.closed && /last item Live users check crate can drop/.test(remove.text)
    && result.poolKept && result.itemKept && result.boxKept && !errors.length;
  return result;
} finally {
  window.removeEventListener("error", onError);
  window.removeEventListener("unhandledrejection", onError);
  await app.close();
}
