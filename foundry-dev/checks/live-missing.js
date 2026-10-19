// Live check: a pool entry whose source is gone is never drawn, and the pool
// editor shows it. Part 1 (the draw) saves a test
// pool of real uncommon/rare items from dnd5e's compendium plus one entry at
// the box's top rarity (legendary) pointing at a UUID that doesn't exist,
// then buys one crate through the GM's own socket path (requestPull, which
// sweeps the box before rolling). Reports the odds before and after, the
// purse before and after (charged once), and that the pool setting now flags
// the dead entry `missing: true`.
//
// Part 2 (the editor) adds a second dead entry the sweep hasn't seen and two
// entries whose snapshot name is stale, opens the manager on Boxes (odds as
// of now) and on Pools, and reports each problem row's status text, that the
// render flagged the new dead entry for the shop, that Update copied the
// source's name, and that dropping an item on a missing row relinked it with
// its weight kept. --shot shows the pool with one missing and one renamed row.
//
//   FOUNDRY_URL=http://192.168.0.57:30000 MODULE_BASE=http://192.168.0.190:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/headless/run.cjs foundry-dev/checks/live-missing.js
//
// Never deletes anything. Writes the module's own settings (one pool, one
// box, one log row); each run adds one item to the test actor and posts one
// chat card.
const store = await import(MODULE_BASE + "scripts/store.js");
const { registerSocket, requestPull } = await import(MODULE_BASE + "scripts/socket.js");
const { oddsTable } = await import(MODULE_BASE + "scripts/odds.js");
const { toCopper } = await import(MODULE_BASE + "scripts/currency.js");

try { store.registerSettings(); } catch (e) { if (!/already registered/i.test(String(e))) throw e; }
store.registerIndexFields();
try { registerSocket(); } catch { /* registered on an earlier run of the same page */ }

const FOLDER = "Loot Crates Test";
let folder = game.folders.find(f => f.type === "Actor" && f.name === FOLDER);
folder ??= await Folder.create({ name: FOLDER, type: "Actor" });
const name = "Crate Tester";
let actor = game.actors.find(a => a.name === name && a.folder?.id === folder.id);
actor ??= await Actor.create({ name, type: "character", folder: folder.id, system: { currency: { pp: 0, gp: 500, ep: 0, sp: 0, cp: 0 } } });
if (actor.system.currency.gp < 50) await actor.update({ "system.currency.gp": 500 });

const DEAD = "Compendium.dnd5e.items.Item.deadbeefdeadbeef";
const live = await store.entriesFromCompendium("dnd5e.items", { types: ["weapon", "equipment", "consumable"], rarities: ["uncommon", "rare"] });
if (!live.length) throw new Error("no uncommon/rare items in dnd5e.items");
const pool = await store.savePool({ id: "live-missing", name: "Live missing check", pools: [],
  entries: [...live.slice(0, 30), { uuid: DEAD, name: "Ghost Blade", img: "", rarity: "legendary", weight: 1 }] });
const box = await store.saveBox({ id: "live-missing-box", name: "Live Missing Crate", price: 50, pools: [{ id: pool.id, share: 1 }], weights: { uncommon: 50, rare: 30, legendary: 20 }, rules: {} });

const odds = () => oddsTable(box, store.getPools()).map(o => `${o.rarity} ${Math.round(o.chance * 100)}%`);
const oddsBefore = odds();

const wasOpen = store.isShopOpen();
if (!wasOpen) await store.setShopOpen(true);
let charges = 0;
const hook = Hooks.on("updateActor", (a, change) => { if (a.id === actor.id && change.system?.currency) charges++; });
const before = foundry.utils.deepClone(actor.system.currency);
const itemsBefore = actor.items.size;
let reveal = null, error = null;
try {
  reveal = await requestPull({ boxId: box.id, actorId: actor.id });
} catch (err) {
  error = String(err?.message ?? err);
} finally {
  Hooks.off("updateActor", hook);
  if (!wasOpen) await store.setShopOpen(false);
}
const after = foundry.utils.deepClone(actor.system.currency);
const oddsAfterPull = odds();
const deadEntry = store.getPools()[pool.id].entries.find(e => e.uuid === DEAD);
const drawOk = !!reveal && !error && charges === 1 && toCopper(before) - toCopper(after) === 5000 && deadEntry?.missing === true && !odds().some(o => o.startsWith("legendary"));

// ---- Part 2: the pool editor ----
if (!document.querySelector("link[data-loot-crates]")) {
  const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: MODULE_BASE + "styles/module.css" });
  link.dataset.lootCrates = "1";
  document.head.appendChild(link);
}
const { openManager } = await import(MODULE_BASE + "scripts/manager.js");
const DEAD2 = "Compendium.dnd5e.items.Item.deadbeef00000002";
const [r1, r2, relinkTo] = live.slice(30, 33);
const fresh = store.getPools()[pool.id];
await store.savePool({ ...fresh, entries: [
  ...fresh.entries.filter(e => ![DEAD2, r1.uuid, r2.uuid, relinkTo.uuid].includes(e.uuid)),
  { uuid: DEAD2, name: "Old Wand", img: "", rarity: "veryRare", weight: 3 },
  { ...r1, name: `${r1.name} (old)` },
  { ...r2, name: `${r2.name} (old)` },
] });
const oddsStored = odds();
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 6000) => { for (let t = 0; t < ms && !fn(); t += 100) await wait(100); return fn(); };
const app = openManager();
app.tab = "boxes"; app.render({ force: true });
await wait(1500);
const boxRow = [...app.element.querySelectorAll(".lc-table tbody tr")].find(tr => tr.textContent.includes(box.name));
const oddsBoxesTab = [...(boxRow?.querySelectorAll(".lc-odd") ?? [])].map(el => `${el.title} ${el.textContent}`);
app.tab = "pools"; app.render();
await wait(2000);
// The render's sweep is queued behind the editor's own render of every pool
// in the world; wait for its write rather than a fixed time.
const t2 = performance.now();
await until(() => store.getPools()[pool.id].entries.find(e => e.uuid === DEAD2)?.missing === true, 10000);
const flagWaitMs = Math.round(performance.now() - t2);
const poolEl = () => app.element.querySelector(`[data-drop-pool="${pool.id}"]`);
const rowText = uuid => poolEl()?.querySelector(`[data-uuid="${CSS.escape(uuid)}"]`)?.closest("li")?.innerText.replace(/\s+/g, " ").trim();
const rows = { dead: rowText(DEAD), dead2: rowText(DEAD2), renamed1: rowText(r1.uuid), renamed2: rowText(r2.uuid) };
const header = poolEl()?.querySelector(".lc-pool__count")?.textContent.trim();
const problemRows = [...poolEl().querySelectorAll(".lc-entry--missing, .lc-entry--renamed")].map(li => li.innerText.replace(/\s+/g, " ").trim());
const dead2Flagged = store.getPools()[pool.id].entries.find(e => e.uuid === DEAD2)?.missing === true;

poolEl().querySelector(`[data-action="updateEntry"][data-uuid="${CSS.escape(r2.uuid)}"]`).click();
await until(() => store.getPools()[pool.id].entries.find(e => e.uuid === r2.uuid)?.name === r2.name);
const updatedName = store.getPools()[pool.id].entries.find(e => e.uuid === r2.uuid)?.name;

const dt = new DataTransfer();
dt.setData("text/plain", JSON.stringify({ type: "Item", uuid: relinkTo.uuid }));
poolEl().querySelector(`[data-relink="${CSS.escape(DEAD2)}"]`).dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
await until(() => store.getPools()[pool.id].entries.some(e => e.uuid === relinkTo.uuid));
await wait(1000);
const entriesNow = store.getPools()[pool.id].entries;
const relinked = entriesNow.find(e => e.uuid === relinkTo.uuid);
// Put the editor in front for --shot: close this run's reveal windows.
for (const w of foundry.applications.instances.values()) if (w.id?.startsWith("loot-crates-reveal")) await w.close({ animate: false });
app.bringToFront?.();
poolEl()?.scrollIntoView({ block: "start" });
await wait(500);

const editorOk = /Source missing/.test(rows.dead ?? "") && /Source missing/.test(rows.dead2 ?? "") && /was .*\(old\)/.test(rows.renamed1 ?? "")
  && oddsStored.some(o => o.startsWith("veryRare")) && !oddsBoxesTab.some(o => o.startsWith("Very Rare")) && dead2Flagged
  && updatedName === r2.name && !!relinked && relinked.weight === 3 && !entriesNow.some(e => e.uuid === DEAD2);

return {
  ok: drawOk && editorOk, drawOk, editorOk,
  oddsBefore, oddsAfter: oddsAfterPull,
  result: reveal?.result ?? null, error,
  stripHasDead: !!reveal?.strip.cards.some(c => c.uuid === DEAD),
  before, after, spentGp: (toCopper(before) - toCopper(after)) / 100, charges,
  itemsBefore, itemsAfter: actor.items.size,
  deadEntry,
  editor: { header, problemRows, rows, oddsStored, oddsBoxesTab, dead2FlaggedByRender: dead2Flagged, flagWaitMs, updatedName, expectedName: r2.name, relinked: relinked && { uuid: relinked.uuid, name: relinked.name, weight: relinked.weight } },
};
