// Live check: a whole compendium, a world Items folder and a roll table can
// go into a pool, each with a preview first.
//
// Makes sure an Item folder "Loot Crates Test" holds two test items (creating
// the folder and the items if absent; live-sweep.js adds a third), then calls entriesFromDrop with a
// Compendium payload for dnd5e.items, a Folder payload for that folder and a
// RollTable payload from dnd5e.tables, and adds the first two to a test pool
// with addEntries. Reports what each would add, what it skipped, and the
// entries actually added. Then drives the manager the way a GM does: drops
// the folder on a second test pool and clicks Add in the preview, and drops
// dnd5e.items on it and leaves that preview open, reporting its text; the
// compendium picker's packs are reported too. --shot shows the preview.
//
//   FOUNDRY_URL=http://192.168.0.57:30000 MODULE_BASE=http://192.168.0.190:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/headless/run.cjs foundry-dev/checks/live-drop.js --shot drop.png
//
// Never deletes anything. Writes the module's own settings (two pools, the
// big one emptied again at the end) and,
// on the first run only, one Item folder with two items.
const store = await import(MODULE_BASE + "scripts/store.js");
try { store.registerSettings(); } catch (e) { if (!/already registered/i.test(String(e))) throw e; }
store.registerIndexFields();

const FOLDER = "Loot Crates Test";
let folder = game.folders.find(f => f.type === "Item" && f.name === FOLDER);
folder ??= await Folder.create({ name: FOLDER, type: "Item" });
const want = [
  { name: "Crate Test Gem", type: "loot", system: { rarity: "rare" } },
  { name: "Crate Test Draught", type: "consumable", system: { rarity: "uncommon", type: { value: "potion" } } },
];
const missing = want.filter(w => !folder.contents.some(i => i.name === w.name));
if (missing.length) await Item.createDocuments(missing.map(w => ({ ...w, folder: folder.id })));

const inFolder = folder.contents.filter(i => store.isLootType(i.type)).length;

const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { for (let t = 0; t < ms && !fn(); t += 100) await wait(100); return fn(); };

// ---- Part 1: entriesFromDrop and addEntries ----
const pool = await store.savePool({ id: "live-drop", name: "Live drop check", entries: [], pools: [] });
const compendium = await store.entriesFromDrop({ type: "Compendium", collection: "dnd5e.items" }, { known: [] });
const fromFolder = await store.entriesFromDrop(folder.toDragData(), { known: [] });
const addedCompendium = await store.addEntries(pool.id, compendium.entries);
const addedFolder = await store.addEntries(pool.id, fromFolder.entries);
const again = await store.entriesFromDrop({ type: "Compendium", collection: "dnd5e.items" }, { known: store.getPools()[pool.id].entries.map(e => e.uuid) });

let table = null;
const tablePack = game.packs.get("dnd5e.tables");
if (tablePack) {
  const idx = await tablePack.getIndex();
  for (const row of [...idx].slice(0, 25)) {
    const plan = await store.entriesFromDrop({ type: "RollTable", uuid: row.uuid ?? `Compendium.dnd5e.tables.RollTable.${row._id}` });
    if (plan?.entries.length) { table = { name: plan.label, entries: plan.entries.length, weights: plan.entries.slice(0, 5).map(e => `${e.name} ${e.weight}`), skipped: plan.skipped }; break; }
  }
}

// ---- Part 2: the manager, as a GM uses it ----
if (!document.querySelector("link[data-loot-crates]")) {
  const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: MODULE_BASE + "styles/module.css" });
  link.dataset.lootCrates = "1";
  document.head.appendChild(link);
}
const { openManager } = await import(MODULE_BASE + "scripts/manager.js");
const uiPool = await store.savePool({ id: "live-drop-ui", name: "Live drop preview", entries: [], pools: [] });
const app = openManager();
app.tab = "pools"; app.render({ force: true });
await until(() => app.element?.querySelector(`[data-drop-pool="${uiPool.id}"]`));
const poolEl = () => app.element.querySelector(`[data-drop-pool="${uiPool.id}"]`);
const hint = poolEl().querySelector(".lc-pool__hint")?.textContent.trim();
const drop = data => {
  const dt = new DataTransfer();
  dt.setData("text/plain", JSON.stringify(data));
  poolEl().dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
};
const preview = () => [...document.querySelectorAll(".lc-dialog")].find(d => d.querySelector(".lc-preview"));
const readPreview = d => ({
  lead: d.querySelector(".lc-preview__lead")?.textContent.replace(/\s+/g, " ").trim(),
  rarities: [...d.querySelectorAll(".lc-preview__rarities .lc-odd")].map(s => s.textContent.trim()),
  skipped: [...d.querySelectorAll(".lc-preview__skipped li")].map(li => li.textContent.trim()),
  rows: d.querySelectorAll(".lc-preview__list li").length,
  more: d.querySelector(".lc-preview__more")?.textContent.trim() ?? null,
  addLabel: d.querySelector('[data-action="add"]')?.textContent.trim(),
});

drop(folder.toDragData());
await until(() => preview());
const folderPreview = preview() ? readPreview(preview()) : null;
const savedBeforeAdd = store.getPools()[uiPool.id].entries.length;
preview()?.querySelector('[data-action="add"]').click();
await until(() => store.getPools()[uiPool.id].entries.length >= 2);
const afterFolderAdd = store.getPools()[uiPool.id].entries.length;
await until(() => !preview());

drop({ type: "Compendium", collection: "dnd5e.items" });
await until(() => preview(), 15000);
await wait(400);
const compendiumPreview = preview() ? readPreview(preview()) : null;

const pickerPacks = game.packs.filter(store.packHasLoot).map(p => p.collection);
const poolNow = store.getPools()[pool.id];
// Empty the big test pool again (a setting, not a document): left full, its
// 874 entries slow every later check that opens the pool editor.
await store.savePool({ ...poolNow, entries: [] });
const ok = compendium.entries.length >= 700 && addedCompendium === compendium.entries.length && addedFolder === inFolder && inFolder >= 2
  && again.entries.length === 0 && again.skipped.duplicates === compendium.entries.length
  && savedBeforeAdd === 0 && afterFolderAdd === inFolder && new RegExp(`Add ${inFolder} items from Loot Crates Test`).test(folderPreview?.lead ?? "")
  && new RegExp(`Add ${compendium.entries.length} items from Items \\(SRD\\)`).test(compendiumPreview?.lead ?? "")
  && compendiumPreview?.rows === 50 && !pickerPacks.includes("dnd5e.spells") && !pickerPacks.includes("dnd5e.classfeatures");

return {
  ok,
  folder: { id: folder.id, created: missing.map(m => m.name), items: folder.contents.map(i => i.name) },
  compendium: { label: compendium.label, found: compendium.entries.length, skipped: compendium.skipped, added: addedCompendium },
  fromFolder: { label: fromFolder.label, found: fromFolder.entries.length, added: addedFolder, names: fromFolder.entries.map(e => `${e.name} (${e.rarity})`) },
  poolEntries: poolNow.entries.length,
  dropAgain: { found: again.entries.length, duplicates: again.skipped.duplicates },
  table,
  ui: { hint, folderPreview, savedBeforeAdd, afterFolderAdd, compendiumPreview },
  pickerPacks,
};
