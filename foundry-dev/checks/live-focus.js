// Live check: a full render of the pool editor keeps the GM where they were.
// Saves a pool of every dnd5e.items entry, opens it, types in its search and
// re-renders before the search's debounce has run (as a late source check
// does): the typed text must survive and focus stay in the search. Then
// focuses a row's rarity select and re-renders: focus must come back to the
// same row's select, not the top of the page. Deletes nothing; empties its
// own pool at the end.
//
//   FOUNDRY_URL=http://<foundry>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/run.cjs foundry-dev/checks/live-focus.js
const store = await import(MODULE_BASE + "scripts/foundry/store.js");
try { store.registerSettings(); } catch (e) { if (!/already registered/i.test(String(e))) throw e; }
store.registerIndexFields();
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 30000) => { for (let t = 0; t < ms && !fn(); t += 50) await wait(50); return fn(); };

const POOL = "live-focus-pool";
await store.savePool({ id: POOL, name: "Live focus pool", pools: [], entries: await store.entriesFromCompendium("dnd5e.items") });
const { openManager } = await import(MODULE_BASE + "scripts/foundry/manager.js");
const app = openManager();
app.tab = "pools";
const poolEl = () => app.element?.querySelector(`.lc-pool[data-drop-pool="${POOL}"]`);
const active = () => document.activeElement;
try {
  await until(() => poolEl());
  await until(() => !app.checking);
  poolEl().querySelector("summary").click();
  await until(() => poolEl().querySelector(".lc-pool__search"));

  const s = poolEl().querySelector(".lc-pool__search");
  s.focus();
  s.value = "wand of";
  s.dispatchEvent(new Event("input", { bubbles: true }));
  await app.render(); // before the 150 ms debounce
  await wait(400);
  const search = { value: poolEl().querySelector(".lc-pool__search")?.value, focused: active()?.classList.contains("lc-pool__search"), rows: poolEl().querySelectorAll(".lc-entry").length };

  const sel = poolEl().querySelector("select.lc-entry__rarity");
  sel.focus();
  await app.render();
  await wait(300);
  const select = { focused: active()?.matches("select.lc-entry__rarity"), sameRow: active()?.dataset.uuid === sel.dataset.uuid };

  const ok = search.value === "wand of" && search.focused && select.focused && select.sameRow;
  return { ok, search, select };
} finally {
  const v = poolEl()?.querySelector(".lc-pool__search");
  if (v) { v.value = ""; v.dispatchEvent(new Event("input", { bubbles: true })); }
  await app.close();
  await store.savePool({ id: POOL, name: "Live focus pool", pools: [], entries: [] });
}
