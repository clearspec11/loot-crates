// Live check: a pool entry's rarity and weight are edited in place in the
// pool editor, and the box odds follow. Saves a test pool of dnd5e items
// (two uncommon, the rest weapons whose source has no rarity) and a box that
// draws from it, opens the manager on Pools, and through the row's own
// controls (change events, as a GM's pick fires) sets one uncommon entry to
// Legendary at weight 3 and another to weight 0. Reports what getPools()
// stored, the row's classes and status text, the pool header, the box odds
// (Legendary now in, the weight-0 entry never drawn), that a source sweep
// leaves the overridden entry "ok" (not renamed), and the "No rarity set"
// rows with the pool's "Set rarity for N unset" button. --shot shows the
// pool editor.
//
//   FOUNDRY_URL=http://192.168.0.57:30000 MODULE_BASE=http://192.168.0.190:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/headless/run.cjs foundry-dev/checks/live-edit-entry.js --shot edit.png
//
// Makes no purchase and deletes nothing; writes the module's own settings
// (one pool, one box).
const store = await import(MODULE_BASE + "scripts/store.js");
const { registerSocket } = await import(MODULE_BASE + "scripts/socket.js");
const { oddsTable, shopOdds, sourceStatus, draw, seededRng } = await import(MODULE_BASE + "scripts/odds.js");

try { store.registerSettings(); } catch (e) { if (!/already registered/i.test(String(e))) throw e; }
store.registerIndexFields();
try { registerSocket(); } catch { /* registered on an earlier run of the same page */ }
if (!document.querySelector("link[data-loot-crates]")) {
  const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: MODULE_BASE + "styles/module.css" });
  link.dataset.lootCrates = "1";
  document.head.appendChild(link);
}

const uncommon = await store.entriesFromCompendium("dnd5e.items", { types: ["equipment", "consumable"], rarities: ["uncommon"] });
const blank = (await store.entriesFromCompendium("dnd5e.items", { types: ["weapon"], rarities: ["common"] })).filter(e => e.sourceRarity === "");
if (uncommon.length < 2 || blank.length < 4) throw new Error(`not enough items: ${uncommon.length} uncommon, ${blank.length} without rarity`);
const [target, zeroed] = uncommon;
const pool = await store.savePool({ id: "live-edit-entry", name: "Live edit entry check", pools: [], entries: [target, zeroed, ...blank.slice(0, 4)] });
const box = await store.saveBox({ id: "live-edit-entry-box", name: "Live Edit Crate", price: 50, pools: [{ id: pool.id, share: 1 }], weights: { common: 60, uncommon: 30, rare: 9, legendary: 1 }, rules: {} });
const odds = () => shopOdds(box, store.getPools()).rows.map(r => `${r.rarity} ${r.label}`);
const oddsBefore = odds();

const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { for (let t = 0; t < ms && !fn(); t += 100) await wait(100); return fn(); };
const { openManager } = await import(MODULE_BASE + "scripts/manager.js");
const app = openManager();
app.tab = "pools"; app.render({ force: true });
const poolEl = () => app.element?.querySelector(`[data-drop-pool="${pool.id}"]`);
await until(() => poolEl()?.querySelector(`select[data-uuid="${CSS.escape(target.uuid)}"]`));
await until(() => !app.checking);
await wait(500);
const headerBefore = poolEl().querySelector(".lc-pool__count").textContent.trim();
const unsetRows = [...poolEl().querySelectorAll(".lc-entry--unset")].map(li => li.innerText.replace(/\s+/g, " ").trim());
const unsetButton = poolEl().querySelector('[data-action="setUnsetRarity"]')?.textContent.trim() ?? null;
const sourceOption = poolEl().querySelector(`select[data-uuid="${CSS.escape(target.uuid)}"] option[value=""]`)?.textContent;
const labels = {
  rarity: poolEl().querySelector(`select[data-uuid="${CSS.escape(target.uuid)}"]`)?.getAttribute("aria-label"),
  weight: poolEl().querySelector(`input[data-uuid="${CSS.escape(target.uuid)}"]`)?.getAttribute("aria-label"),
};

const entryOf = uuid => store.getPools()[pool.id].entries.find(e => e.uuid === uuid);
const pick = (sel, value) => { const el = poolEl().querySelector(sel); el.focus(); el.value = value; el.dispatchEvent(new Event("change", { bubbles: true })); return el; };
const raritySel = pick(`select[data-uuid="${CSS.escape(target.uuid)}"]`, "legendary");
await until(() => entryOf(target.uuid)?.rarityOverride === "legendary");
const weightInput = pick(`input[data-uuid="${CSS.escape(target.uuid)}"]`, "3");
await until(() => entryOf(target.uuid)?.weight === 3);
pick(`input[data-uuid="${CSS.escape(zeroed.uuid)}"]`, "0");
await until(() => entryOf(zeroed.uuid)?.weight === 0);
await wait(300);
const stored = entryOf(target.uuid);
const rowOf = uuid => poolEl().querySelector(`select[data-uuid="${CSS.escape(uuid)}"]`)?.closest("li");
const targetRow = { className: rowOf(target.uuid)?.className, text: rowOf(target.uuid)?.innerText.replace(/\s+/g, " ").trim() };
const zeroRow = { className: rowOf(zeroed.uuid)?.className, text: rowOf(zeroed.uuid)?.innerText.replace(/\s+/g, " ").trim() };
const headerAfter = poolEl().querySelector(".lc-pool__count").textContent.trim();
const focusKept = document.activeElement === weightInput || document.activeElement === raritySel || poolEl().contains(document.activeElement);
const oddsAfter = odds();
const table = oddsTable(box, store.getPools()).map(o => o.rarity);
let zeroDrawn = 0, legendaryHits = 0;
for (let seed = 1; seed <= 400; seed++) {
  const r = draw({ box, pools: store.getPools(), rng: seededRng(seed) });
  if (r?.entry.uuid === zeroed.uuid) zeroDrawn++;
  if (r?.entry.uuid === target.uuid) { legendaryHits++; if (r.rarity !== "legendary") throw new Error(`drew ${target.name} at ${r.rarity}`); }
}

// A source sweep, as the editor and each pull run it: the override is not drift.
const sources = await store.checkSources(store.getPools()[pool.id].entries, { rarity: true });
const statusAfterSweep = sourceStatus(stored, sources.get(target.uuid));
const newlyMissing = await store.enqueueWrite(() => store.refreshMissing([pool.id]));
app.render(); await wait(1500);
await until(() => !app.checking);
const renamedRows = [...poolEl().querySelectorAll(".lc-entry--renamed")].map(li => li.innerText.replace(/\s+/g, " ").trim());
const targetRowAfterSweep = rowOf(target.uuid)?.className;

// The Boxes tab's pills.
app.tab = "boxes"; app.render(); await wait(1500);
const boxRow = [...app.element.querySelectorAll(".lc-table tbody tr")].find(tr => tr.textContent.includes(box.name));
const boxesTabPills = [...(boxRow?.querySelectorAll(".lc-odd") ?? [])].map(el => el.textContent.trim());
app.tab = "pools"; app.render(); await wait(1500);
app.bringToFront?.();
poolEl()?.scrollIntoView({ block: "start" });
await wait(400);

const ok = stored?.rarityOverride === "legendary" && stored.weight === 3 && stored.sourceRarity === "uncommon"
  && entryOf(zeroed.uuid).weight === 0 && /lc-rarity-legendary/.test(targetRow.className ?? "") && /lc-entry--never/.test(zeroRow.className ?? "") && /Never drops/.test(zeroRow.text ?? "")
  && /legendary/.test(headerAfter) && /never drops/.test(headerAfter)
  && table.includes("legendary") && !oddsBefore.some(o => o.startsWith("legendary")) && oddsAfter.some(o => o.startsWith("legendary"))
  && boxesTabPills.some(p => p.startsWith("Legendary"))
  && zeroDrawn === 0 && legendaryHits > 0
  && statusAfterSweep === "ok" && !renamedRows.length && !/renamed/.test(targetRowAfterSweep ?? "") && newlyMissing.length === 0
  && unsetRows.length === 4 && unsetRows.every(t => /No rarity set/.test(t)) && /Set rarity for 4 unset/.test(unsetButton ?? "")
  && /\(source\)/.test(sourceOption ?? "") && !!labels.rarity && !!labels.weight && focusKept;

return {
  ok,
  target: { name: target.name, uuid: target.uuid }, zeroed: zeroed.name,
  stored, zeroWeight: entryOf(zeroed.uuid).weight,
  targetRow, zeroRow, headerBefore, headerAfter, focusKept, labels, sourceOption,
  unsetRows, unsetButton,
  oddsBefore, oddsAfter, oddsTable: table, boxesTabPills,
  draws: { zeroDrawn, legendaryHits, of: 400 },
  sweep: { statusAfterSweep, newlyMissing: newlyMissing.length, renamedRows, targetRowAfterSweep },
};
