// Live check: the box editor shows the odds a player will see, live.
// Opens the manager's Boxes tab as the GM, opens the editor for an existing
// box, reads the preview's pills, types a new weight (input events, as a
// keyboard does), unticks every pool, and reads the pills and the "drops
// nothing" line each time. The dialog is left open in THEME for --shot and
// never saved: the stored box must be unchanged. Writes nothing.
//
// Edit THEME below to "light" for Foundry's light theme.
//
//   FOUNDRY_URL=http://<foundry>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/run.cjs foundry-dev/checks/live-box-odds.js --shot /tmp/box-odds.png
const THEME = "dark";
// The installed copy's stylesheet may be older than the branch's: add the branch's.
if (!document.querySelector("link[data-loot-crates]")) {
  const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: MODULE_BASE + "styles/module.css" });
  link.dataset.lootCrates = "1";
  document.head.appendChild(link);
}
const store = await import(MODULE_BASE + "scripts/foundry/store.js");
try { store.registerSettings(); } catch (e) { if (!/already registered/i.test(String(e))) throw e; }
store.registerIndexFields();
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { for (let t = 0; t < ms && !fn(); t += 50) await wait(50); return fn(); };

const pools = store.getPools();
// The first box with a pool that can drop something.
const box = Object.values(store.getBoxes()).find(b => b.pools?.some(ref => pools[ref.id]?.entries?.some(e => !e.missing)));
if (!box) return { ok: false, error: "no box with a live pool in the world" };
const storedBefore = JSON.stringify(store.getBoxes()[box.id]);

const { openManager } = await import(MODULE_BASE + "scripts/foundry/manager.js");
const app = openManager();
app.tab = "boxes";
await app.render();
await until(() => app.element?.querySelector(`[data-action="editBox"][data-box="${box.id}"]`));
app.element.querySelector(`[data-action="editBox"][data-box="${box.id}"]`).click();
const dialog = () => [...document.querySelectorAll(".lc-dialog")].find(d => d.querySelector(".lc-form__preview"));
await until(() => dialog()?.querySelector(".lc-form__preview").innerHTML);
const dlg = dialog();
if (THEME === "light") { dlg.classList.remove("theme-dark"); dlg.classList.add("themed", "theme-light"); }
else { dlg.classList.remove("theme-light"); dlg.classList.add("themed", "theme-dark"); }

const read = () => {
  const p = dlg.querySelector(".lc-form__preview");
  return {
    pills: [...p.querySelectorAll(".lc-odd")].map(s => s.textContent.trim()),
    ribbon: p.querySelectorAll(".lc-ribbon__seg").length,
    note: p.querySelector(".lc-form__hint")?.textContent ?? "",
    unheld: [...dlg.querySelectorAll("[data-held]")].filter(s => s.textContent).map(s => s.dataset.held),
  };
};
const type = (input, value) => { input.focus(); input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); };

const before = read();
// Weight the box's best held rarity up to match the rest combined.
const held = ["artifact", "legendary", "veryRare", "rare", "uncommon", "common"].filter(r => !before.unheld.includes(r));
const target = held[0];
const wInput = dlg.querySelector(`input[name="w.${target}"]`);
const oldWeight = wInput.value;
type(wInput, String((Number(oldWeight) || 0) * 3 + 10));
await wait(50);
const afterWeight = read();

// Untick every pool: the box would drop nothing.
const boxes = [...dlg.querySelectorAll('input[type=checkbox][name^="pool."]')].filter(cb => cb.checked);
for (const cb of boxes) { cb.checked = false; cb.dispatchEvent(new Event("change", { bubbles: true })); }
await wait(50);
const noPools = read();
// Tick them back, so the shot shows the typed weight's odds.
for (const cb of boxes) { cb.checked = true; cb.dispatchEvent(new Event("change", { bubbles: true })); }
await wait(50);
const restored = read();
// Scrolled to the top: the odds stay pinned at the foot while the pools show.
dlg.querySelector(".window-content")?.scrollTo?.(0, 0);
await wait(300);

const storedAfter = JSON.stringify(store.getBoxes()[box.id]);
return {
  ok: before.pills.length > 0 && JSON.stringify(afterWeight.pills) !== JSON.stringify(before.pills)
    && noPools.pills.length === 0 && /drop nothing/.test(noPools.note)
    && JSON.stringify(restored.pills) === JSON.stringify(afterWeight.pills) && storedBefore === storedAfter,
  theme: THEME,
  box: box.name,
  storedWeights: box.weights,
  typed: { field: `w.${target}`, from: oldWeight, to: wInput.value },
  before, afterWeight, noPools, restored,
  savedUnchanged: storedBefore === storedAfter,
  dialogTheme: [...dlg.classList].filter(c => c.startsWith("theme")),
};
