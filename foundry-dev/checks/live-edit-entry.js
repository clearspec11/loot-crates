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
// Then one live pull through the socket path (requestPull) for Crate Tester
// on a box that can only drop the overridden entry, reporting the granted
// copy's stored rarities, its rarity getter, its loot-crates provenance
// flags, _stats.compendiumSource and the newest log row's sourceRarity, and
// that the pool editor shows the "granted item carries" hint.
//
//   FOUNDRY_URL=http://<foundry>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/run.cjs foundry-dev/checks/live-edit-entry.js --shot edit.png
//
// Deletes nothing; writes the module's own settings (one pool, two boxes, one
// log row), adds one item to the test actor and posts one chat card.
const store = await import(MODULE_BASE + "scripts/foundry/store.js");
const { registerSocket } = await import(MODULE_BASE + "scripts/foundry/socket.js");
const { oddsTable, shopOdds, sourceStatus, draw, seededRng } = await import(MODULE_BASE + "scripts/core/odds.js");

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
const { openManager } = await import(MODULE_BASE + "scripts/foundry/manager.js");
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

// The rarity consequence is visible before picking.
const rarityHint = poolEl().querySelector(`#${CSS.escape(`lc-rarity-hint-${pool.id}`)}`)?.textContent.trim() ?? null;
const describedBy = poolEl().querySelector(`select[data-uuid="${CSS.escape(target.uuid)}"]`)?.getAttribute("aria-describedby");

// One live pull on a box that can only drop the overridden entry.
const { requestPull } = await import(MODULE_BASE + "scripts/foundry/socket.js");
const FOLDER = "Loot Crates Test";
let folder = game.folders.find(f => f.type === "Actor" && f.name === FOLDER);
folder ??= await Folder.create({ name: FOLDER, type: "Actor" });
let actor = game.actors.find(a => a.name === "Crate Tester" && a.folder?.id === folder.id);
actor ??= await Actor.create({ name: "Crate Tester", type: "character", folder: folder.id, system: { currency: { pp: 0, gp: 500, ep: 0, sp: 0, cp: 0 } } });
if (actor.system.currency.gp < 50) await actor.update({ "system.currency.gp": 500 });
const overrideBox = await store.saveBox({ id: "live-edit-entry-override", name: "Live Override Crate", price: 50, pools: [{ id: pool.id, share: 1 }], weights: { common: 0, uncommon: 0, rare: 0, veryRare: 0, legendary: 1, artifact: 0 }, rules: {} });
if (!store.isShopOpen()) await store.setShopOpen(true);
const reveal = await requestPull({ boxId: overrideBox.id, actorId: actor.id });
const granted = actor.items.get(reveal.itemId);
const logRow = store.getLog().find(r => r.itemId === reveal.itemId) ?? null;
const pulled = {
  name: granted?.name, sourceRarities: granted?._source.system.rarities, rarityGetter: granted?.system.rarity,
  flags: granted?.flags["loot-crates"], compendiumSource: granted?._stats.compendiumSource,
  revealRarity: reveal.result.rarity, logRow: logRow && { rarity: logRow.rarity, sourceRarity: logRow.sourceRarity },
};
app.tab = "log"; app.render(); await wait(1500);
const logNote = [...(app.element?.querySelectorAll(".lc-log__rarity") ?? [])].map(el => el.textContent.trim())[0] ?? null;
app.tab = "pools"; app.render(); await wait(1500);
const pullOk = granted?.name === target.name && pulled.revealRarity === "legendary"
  && JSON.stringify(pulled.sourceRarities) === '["legendary"]' && pulled.rarityGetter === "legendary"
  && JSON.stringify(pulled.flags?.sourceRarity) === '["uncommon"]' && pulled.flags?.rarityOverride === true
  && pulled.compendiumSource === target.uuid
  && JSON.stringify(logRow?.sourceRarity) === '["uncommon"]' && /Legendary, set by GM \(source Uncommon\)/.test(logNote ?? "")
  && /granted item carries/.test(rarityHint ?? "") && describedBy === `lc-rarity-hint-${pool.id}`;

const ok = pullOk && stored?.rarityOverride === "legendary" && stored.weight === 3 && stored.sourceRarity === "uncommon"
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
  rarityHint, describedBy, pulled, logNote, pullOk,
};
