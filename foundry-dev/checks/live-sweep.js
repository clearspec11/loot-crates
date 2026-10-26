// Live check: rarity is read one way from one registered index field list,
// and the source sweep of a big pool is fast. Registers the module's settings
// and index fields by hand (hooks have fired), warms dnd5e.items' index once
// as Foundry's load would with the fields registered, then makes the call
// dnd5e's compendium browser makes (its own field list, which used to evict
// ours). Builds (or reuses) a pool of every dnd5e.items entry and times
// checkSources and refreshMissing twice each: every warm call must be under
// 1000 ms. Reports that the entries keep the tiers their index rows give and
// that the count flagged "No rarity set" matches the rows with no rarity.
//
// Then: a world Item in the Items folder "Loot Crates Test" whose rarities
// set is empty (created once, reused after) goes into a small pool as an
// older entry (no sourceRarity); a sweep teaches it "" and the pool editor
// shows it "No rarity set". Finally the "Live UI pool" is swept and its
// older entries are reported gaining sourceRarity.
//
//   FOUNDRY_URL=http://<foundry>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/run.cjs foundry-dev/checks/live-sweep.js [--shot out.png]
//
// Never deletes anything. Writes the module's own settings (two pools, the
// big one emptied again at the end, and the Live UI pool's learned
// sourceRarity) and creates one world Item once.
const store = await import(MODULE_BASE + "scripts/foundry/store.js");
const odds = await import(MODULE_BASE + "scripts/core/odds.js");
const { normalizeRarity, rarityUnset } = odds;
// The same read as odds.js rawRarityOf, so the check also runs against a
// build that predates it (for a before/after timing).
const rawRarityOf = odds.rawRarityOf ?? (sys => {
  const set = sys?.rarities;
  if (Array.isArray(set) || set instanceof Set) { for (const r of set) return String(r ?? ""); return ""; }
  return sys?.rarity == null ? null : String(sys.rarity);
});

try { store.registerSettings(); } catch (e) { if (!/already registered/i.test(String(e))) throw e; }
const registered = typeof store.registerIndexFields === "function";
store.registerIndexFields?.();

const time = async fn => { const t = performance.now(); const v = await fn(); return [Math.round(performance.now() - t), v]; };
const wait = ms => new Promise(r => setTimeout(r, ms));
const pack = game.packs.get("dnd5e.items");

// Foundry indexes every pack at load with its configured fields; with ours
// registered at init that index already has them.
const [warmInit] = await time(() => pack.getIndex());
const [browserCall] = await time(() => pack.getIndex({ fields: ["system.rarities", "system.price.value"] }));

const POOL = "live-sweep";
let pool = store.getPools()[POOL];
let built = null;
if (!pool || pool.entries.length < 800) {
  const [ms, entries] = await time(() => store.entriesFromCompendium("dnd5e.items"));
  built = ms;
  pool = await store.savePool({ id: POOL, name: "Live sweep pool", pools: [], entries });
}
const entries = pool.entries;

const runs = { checkSources: [], refreshMissing: [] };
let sources;
for (let i = 0; i < 2; i++) {
  const [a, got] = await time(() => store.checkSources(entries, { rarity: true }));
  runs.checkSources.push(a); sources = got;
  const [b] = await time(() => store.enqueueWrite(() => store.refreshMissing([POOL])));
  runs.refreshMissing.push(b);
}
const [entriesFromCompendiumWarm] = await time(() => store.entriesFromCompendium("dnd5e.items"));

// Tiers and the unset count against the index rows themselves.
const rows = [...pack.index];
const rowShape = { legacyString: rows.filter(r => typeof r.system?.rarity === "string").length, raritiesArray: rows.filter(r => Array.isArray(r.system?.rarities)).length, neither: rows.filter(r => rawRarityOf(r.system) === null).length };
const rowById = new Map(rows.map(r => [r.uuid, r]));
const saved = store.getPools()[POOL].entries;
const tierMismatch = saved.filter(e => { const r = rowById.get(e.uuid); return r && rawRarityOf(r.system) !== null && normalizeRarity(rawRarityOf(r.system)) !== e.rarity; }).map(e => e.name);
const tiers = saved.reduce((o, e) => (o[e.rarity] = (o[e.rarity] ?? 0) + 1, o), {});
const noRarityRows = rows.filter(r => rawRarityOf(r.system) === "").length;
const flaggedUnset = saved.filter(e => !e.missing && rarityUnset(e)).length;
const sourceBlank = [...sources.values()].filter(s => s?.rawRarity === "").length;
const unknownRarity = [...sources.values()].filter(s => s && s.rawRarity == null).length;

// ---- A dnd5e 6 world item with an empty rarities set ----
const FOLDER = "Loot Crates Test";
let folder = game.folders.find(f => f.type === "Item" && f.name === FOLDER);
folder ??= await Folder.create({ name: FOLDER, type: "Item" });
const ITEM = "Plain Bauble (no rarity)";
let bauble = game.items.find(i => i.name === ITEM && i.folder?.id === folder.id);
const createdItem = !bauble;
bauble ??= await Item.create({ name: ITEM, type: "loot", folder: folder.id, system: { rarities: [] } });
const WORLD_POOL = "live-sweep-world";
await store.savePool({ id: WORLD_POOL, name: "Live sweep world item", pools: [], entries: [
  { uuid: bauble.uuid, name: bauble.name, img: bauble.img, rarity: "common", weight: 1 }, // older: no sourceRarity
] });
const fresh = store.entryFromItem(bauble);
const baubleSource = (await store.checkSources([{ uuid: bauble.uuid }])).get(bauble.uuid);
await store.enqueueWrite(() => store.refreshMissing([WORLD_POOL]));
const baubleEntry = store.getPools()[WORLD_POOL].entries[0];

if (!document.querySelector("link[data-loot-crates]")) {
  const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: MODULE_BASE + "styles/module.css" });
  link.dataset.lootCrates = "1";
  document.head.appendChild(link);
}
const until = async (fn, ms = 15000) => { for (let t = 0; t < ms && !fn(); t += 100) await wait(100); return fn(); };
const { openManager } = await import(MODULE_BASE + "scripts/foundry/manager.js");
const app = openManager();
app.tab = "pools"; app.render({ force: true });
const worldPoolEl = () => app.element?.querySelector(`[data-drop-pool="${WORLD_POOL}"]`);
await until(() => worldPoolEl()?.querySelector(".lc-entry"));
worldPoolEl()?.scrollIntoView();
const baubleRow = worldPoolEl()?.querySelector(".lc-entry")?.innerText.replace(/\s+/g, " ").trim() ?? null;
const baubleHeader = worldPoolEl()?.querySelector(".lc-pool__count")?.textContent.trim() ?? null;
const sweepHeader = app.element?.querySelector(`[data-drop-pool="${POOL}"] .lc-pool__count`)?.textContent.trim() ?? null;

// ---- The Live UI pool's older entries ----
const liveUi = Object.values(store.getPools()).find(p => p.name === "Live UI pool");
let liveUiReport = null;
if (liveUi) {
  const olderBefore = liveUi.entries.filter(e => e.sourceRarity == null).length;
  await store.enqueueWrite(() => store.refreshMissing([liveUi.id]));
  const after = store.getPools()[liveUi.id].entries;
  liveUiReport = { entries: after.length, olderBefore, olderAfter: after.filter(e => e.sourceRarity == null).length,
    learnedBlank: after.filter(e => e.sourceRarity === "").length, stillOlder: after.filter(e => e.sourceRarity == null).map(e => e.name) };
}

// Empty the big pool again (a setting, not a document), as live-drop does:
// left full, its 872 rows slow every later check that opens the editor.
await store.updatePool(POOL, fresh => ({ ...fresh, entries: [] }));

const warm = [runs.checkSources[1], runs.refreshMissing[1], entriesFromCompendiumWarm];
const ok = registered && entries.length >= 800 && warm.every(ms => ms < 1000)
  && tierMismatch.length === 0 && flaggedUnset === noRarityRows && sourceBlank === noRarityRows && unknownRarity === 0
  && fresh.sourceRarity === "" && baubleSource?.rawRarity === "" && baubleEntry.sourceRarity === "" && /No rarity set/.test(baubleRow ?? "")
  && (!liveUi || liveUiReport.olderAfter < liveUiReport.olderBefore || liveUiReport.olderBefore === 0);

return {
  ok, registered,
  indexFields: [...pack.indexFields].filter(f => f.includes("rarit")),
  timingsMs: { warmInitGetIndex: warmInit, dnd5eBrowserGetIndex: browserCall, buildPool: built, checkSources: runs.checkSources, refreshMissing: runs.refreshMissing, entriesFromCompendiumWarm },
  pool: { entries: entries.length, tiers, tierMismatch: tierMismatch.slice(0, 10), noRarityRows, flaggedUnset, sourceBlank, unknownRarity, header: sweepHeader },
  rowShape,
  worldItem: { uuid: bauble.uuid, created: createdItem, rarities: [...(bauble.system.rarities ?? [])], entryFromItem: fresh.sourceRarity, checkSourcesRaw: baubleSource?.rawRarity, olderEntryLearned: baubleEntry.sourceRarity, row: baubleRow, header: baubleHeader },
  liveUiPool: liveUiReport,
};
