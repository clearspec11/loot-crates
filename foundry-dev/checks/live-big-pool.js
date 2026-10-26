// Live check: a big pool is a craft table. Saves a pool of every dnd5e.items
// entry (872), opens the manager on Pools and times render({force:true}) to
// the second animation frame (must be under 300 ms; it was ~880 ms to 1.9 s
// when every row was drawn). The big pool starts collapsed with its census
// in the summary and no rows; (Two rAFs alone take ~500 ms in the headless
// runner, where the WebGL canvas paints in software, so the check reports
// render plus forced style and layout, which is the window's own cost, and
// the two-rAF time with an idle two-rAF baseline subtracted; both must be
// under 300 ms.) opened, it draws 50 rows. Then, through the
// pool's own controls: the "No rarity set" chip shows only unset rows; a
// search for "wand" shows only wands; one wand set to Rare is stored by
// updatePool (rarityOverride "rare") with focus kept on its select; the Rare
// chip with the search still on survives a full re-render; Show more draws
// rows 51-100 and puts focus on row 51. --shot shows the open pool.
//
//   FOUNDRY_URL=http://<foundry>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/run.cjs foundry-dev/checks/live-big-pool.js --shot big.png
//
// Deletes nothing; writes the module's own settings (one pool, emptied again
// at the end so later checks don't carry 872 entries).
const store = await import(MODULE_BASE + "scripts/foundry/store.js");
const { rarityUnset } = await import(MODULE_BASE + "scripts/core/odds.js");
try { store.registerSettings(); } catch (e) { if (!/already registered/i.test(String(e))) throw e; }
store.registerIndexFields();
if (!document.querySelector("link[data-loot-crates]")) {
  const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: MODULE_BASE + "styles/module.css" });
  link.dataset.lootCrates = "1";
  document.head.appendChild(link);
}

const POOL = "live-big-pool";
const entries = await store.entriesFromCompendium("dnd5e.items");
await store.savePool({ id: POOL, name: "Live big pool", pools: [], entries });
const unsetStored = entries.filter(rarityUnset).length;

const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 10000) => { for (let t = 0; t < ms && !fn(); t += 50) await wait(50); return fn(); };
const frames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
const { openManager } = await import(MODULE_BASE + "scripts/foundry/manager.js");
const app = openManager();
app.tab = "pools";
const poolEl = () => app.element?.querySelector(`.lc-pool[data-drop-pool="${POOL}"]`);
const details = () => poolEl()?.querySelector(".lc-pool__details");
await until(() => poolEl());
await until(() => !app.checking);

// ---- Render time, warm (the first run warms indexes and the stylesheet) ----
const idleFrames = [];
for (let i = 0; i < 3; i++) { const t = performance.now(); await frames(); idleFrames.push(Math.round(performance.now() - t)); }
const idle = Math.min(...idleFrames);
const timeRender = async () => {
  const t = performance.now();
  await app.render({ force: true });
  app.element.getBoundingClientRect(); void document.body.offsetHeight; // style and layout, now
  const layout = Math.round(performance.now() - t);
  await frames();
  const raf = Math.round(performance.now() - t);
  return { layout, raf, rafLessIdle: raf - idle };
};
const collapsedMs = [];
for (let i = 0; i < 4; i++) { collapsedMs.push(await timeRender()); await wait(200); }
const selectsInDom = app.element.querySelectorAll("select.lc-entry__rarity").length;
const elementsInDom = app.element.querySelectorAll("*").length;
const firstOpen = {
  collapsed: details()?.open === false,
  rowsDrawn: poolEl().querySelectorAll(".lc-entry").length,
  summary: poolEl().querySelector("summary")?.innerText.replace(/\s+/g, " ").trim(),
  selectsInDom, elementsInDom,
  openPools: [...app.element.querySelectorAll(".lc-pool__details")].map(d => ({ pool: d.dataset.pool, open: d.open, selects: d.querySelectorAll("select.lc-entry__rarity").length })),
  liveRegions: app.element.querySelectorAll("[aria-live]").length,
  statusRegions: app.element.querySelectorAll('[role="status"]').length,
};

// ---- Open it: 50 rows ----
poolEl().querySelector("summary").click();
await until(() => poolEl().querySelector(".lc-entry"));
await frames();
const opened = { selects: poolEl().querySelectorAll("select.lc-entry__rarity").length, rows: poolEl().querySelectorAll(".lc-entry").length, more: poolEl().querySelector(".lc-pool__more")?.textContent.trim() };
const openMs = [];
for (let i = 0; i < 3; i++) { openMs.push(await timeRender()); await wait(200); }
const maxSelectsPerOpenPool = Math.max(...[...app.element.querySelectorAll(".lc-pool__details[open]")].map(d => d.querySelectorAll("select.lc-entry__rarity").length));

// ---- The "No rarity set" chip ----
const chip = key => poolEl().querySelector(`[data-chip="${key}"]`);
const unsetChipText = chip("unset")?.textContent.trim();
chip("unset").click();
await until(() => chip("unset")?.getAttribute("aria-pressed") === "true");
const unsetRows = [...poolEl().querySelectorAll(".lc-entry")];
const unsetView = { rows: unsetRows.length, allUnset: unsetRows.every(li => li.classList.contains("lc-entry--unset")), chipText: unsetChipText, pressed: chip("unset").getAttribute("aria-pressed"), status: app.element.querySelector(".lc-manager__status")?.textContent };
chip("unset").click();
await until(() => chip("unset")?.getAttribute("aria-pressed") === "false");

// ---- Search "wand", set one to Rare ----
const search = poolEl().querySelector(".lc-pool__search");
search.focus(); search.value = "wand"; search.dispatchEvent(new Event("input", { bubbles: true }));
await until(() => [...poolEl().querySelectorAll(".lc-entry__name")].every(n => /wand/i.test(n.textContent)) && poolEl().querySelector(".lc-entry"));
await wait(100);
const wandNames = [...poolEl().querySelectorAll(".lc-entry .lc-entry__name")].map(n => n.textContent.trim());
const sel = [...poolEl().querySelectorAll("select.lc-entry__rarity")].find(s => s.querySelector('option[value="rare"]') && /Magic Detection/.test(s.getAttribute("aria-label")))
  ?? [...poolEl().querySelectorAll("select.lc-entry__rarity")].find(s => s.querySelector('option[value="rare"]'));
const target = sel.dataset.uuid;
sel.focus(); sel.value = "rare"; sel.dispatchEvent(new Event("change", { bubbles: true }));
const entryOf = uuid => store.getPools()[POOL].entries.find(e => e.uuid === uuid);
await until(() => entryOf(target)?.rarityOverride === "rare");
await wait(200);
const edit = {
  name: entryOf(target)?.name, stored: entryOf(target)?.rarityOverride,
  focusKept: document.activeElement === sel,
  rowClass: sel.closest("li")?.className,
  searchKept: poolEl().querySelector(".lc-pool__search")?.value,
  rowsStillWands: [...poolEl().querySelectorAll(".lc-entry .lc-entry__name")].every(n => /wand/i.test(n.textContent)),
};

// ---- The Rare chip with the search on, then a full re-render ----
chip("rare").click();
await until(() => chip("rare")?.getAttribute("aria-pressed") === "true");
await app.render({ force: true }); await frames();
await until(() => poolEl()?.querySelector(".lc-pool__search"));
const rareRows = [...poolEl().querySelectorAll(".lc-entry")];
const afterRender = {
  open: details()?.open, search: poolEl().querySelector(".lc-pool__search")?.value,
  rarePressed: chip("rare")?.getAttribute("aria-pressed"),
  rows: rareRows.map(li => li.querySelector(".lc-entry__name")?.textContent.trim()),
  allRareWands: rareRows.length > 0 && rareRows.every(li => li.classList.contains("lc-rarity-rare") && /wand/i.test(li.textContent)),
  editedShown: rareRows.some(li => li.dataset.entry === target),
};

// ---- Clear, then Show more ----
chip("rare").click();
await until(() => chip("rare")?.getAttribute("aria-pressed") === "false");
const s2 = poolEl().querySelector(".lc-pool__search");
s2.value = ""; s2.dispatchEvent(new Event("input", { bubbles: true }));
await until(() => poolEl().querySelectorAll(".lc-entry").length === 50);
const list = poolEl().querySelector(".lc-entries");
const firstFifty = [...list.children].map(li => li.dataset.entry);
poolEl().querySelector(".lc-pool__more").click();
await until(() => list.children.length > 50);
await wait(100);
const more = {
  rows: list.children.length,
  focusOnRow51: list.children[50]?.contains(document.activeElement) ?? false,
  focused: document.activeElement?.getAttribute("aria-label"),
  noRepeats: new Set([...list.children].map(li => li.dataset.entry)).size === list.children.length,
  firstFiftyKept: firstFifty.every((u, i) => list.children[i]?.dataset.entry === u),
  foot: poolEl().querySelector(".lc-pool__foot")?.innerText.replace(/\s+/g, " ").trim(),
};

// For --shot: the pool open at the top with the Rare chip and search shown.
const s3 = poolEl().querySelector(".lc-pool__search");
s3.value = "wand"; s3.dispatchEvent(new Event("input", { bubbles: true }));
await wait(400);
app.bringToFront?.();
poolEl().scrollIntoView({ block: "start" });
await wait(300);

// Empty the pool again (a setting, not a document), as live-sweep does.
await store.updatePool(POOL, fresh => ({ ...fresh, entries: [] }));

const worst = runs => Math.max(...runs.slice(1).flatMap(r => [r.layout, r.rafLessIdle]));
const ok = entries.length >= 800
  && worst(collapsedMs) < 300 && worst(openMs) < 300
  && firstOpen.collapsed && firstOpen.rowsDrawn === 0 && /872 items/.test(firstOpen.summary ?? "") && /no rarity set/.test(firstOpen.summary ?? "")
  && firstOpen.liveRegions === 0 && firstOpen.statusRegions === 1
  && opened.selects === 50 && maxSelectsPerOpenPool <= 50 && /Show 50 more \(\d+ left\)/.test(opened.more ?? "")
  && unsetView.allUnset && unsetView.rows === Math.min(50, unsetStored) && unsetView.chipText === `${unsetStored} no rarity set`
  && wandNames.length > 0 && edit.stored === "rare" && edit.focusKept && edit.searchKept === "wand" && edit.rowsStillWands
  && afterRender.open && afterRender.search === "wand" && afterRender.rarePressed === "true" && afterRender.allRareWands && afterRender.editedShown
  && more.rows === 100 && more.focusOnRow51 && more.noRepeats && more.firstFiftyKept;

return {
  ok,
  entries: entries.length, unsetStored,
  timingsMs: { idleTwoFrames: idleFrames, collapsed: collapsedMs, openWith50Rows: openMs, worstWarmCollapsed: worst(collapsedMs), worstWarmOpen: worst(openMs) },
  firstOpen, opened, maxSelectsPerOpenPool,
  unsetView, wandNames, edit, afterRender, more,
};
