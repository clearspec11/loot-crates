// Live check: switch the manager's tabs the way a GM does, by pressing each
// tab button (Pools -> Boxes -> Pull log -> Pools), and report for each press
// whether the window shows that tab, the pressed tab keeps keyboard focus, and
// nothing was thrown or logged as an error. Before 0.5.0 the buttons used the
// action name "tab", which ApplicationV2 keeps for itself: a press threw "You
// must pass both the tab and tab group identifier" and the tab never changed.
//
//   FOUNDRY_URL=http://192.168.0.57:30000 MODULE_BASE=http://192.168.0.190:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/headless/run.cjs foundry-dev/checks/live-tabs.js
//
// Point MODULE_BASE at the installed copy (<FOUNDRY_URL>/modules/loot-crates/)
// to run the same presses against the released code. Reads only; writes nothing.
if (!document.querySelector("link[data-loot-crates]")) {
  const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: MODULE_BASE + "styles/module.css" });
  link.dataset.lootCrates = "1";
  document.head.appendChild(link);
}
const store = await import(MODULE_BASE + "scripts/store.js");
const { openManager } = await import(MODULE_BASE + "scripts/manager.js");
try { store.registerSettings(); } catch (e) { if (!/already registered/i.test(String(e))) throw e; }
store.registerIndexFields();
const wait = ms => new Promise(r => setTimeout(r, ms));

const errors = [];
const onError = e => errors.push(String(e.error?.message ?? e.message ?? e.reason?.message ?? e.reason));
window.addEventListener("error", onError);
window.addEventListener("unhandledrejection", onError);
const consoleError = console.error;
console.error = (...args) => { errors.push(args.map(String).join(" ")); consoleError.apply(console, args); };

const app = openManager();
try {
  for (let t = 0; t < 100 && !app.element?.querySelector(".lc-tabs [data-tab]"); t++) await wait(50);
  const steps = [];
  for (const tab of ["pools", "boxes", "log", "pools"]) {
    const before = errors.length;
    const button = app.element.querySelector(`.lc-tabs [data-tab="${tab}"]`);
    button.focus();
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
    for (let t = 0; t < 60 && app.element.querySelector(`.lc-tabs [data-tab="${tab}"]`)?.classList.contains("active") !== true; t++) await wait(50);
    await wait(300);
    const now = app.element.querySelector(`.lc-tabs [data-tab="${tab}"]`);
    const panel = app.element.querySelector(".lc-tab");
    const step = {
      tab,
      appTab: app.tab,
      active: now?.classList.contains("active") ?? false,
      selected: now?.getAttribute("aria-selected") ?? null,
      panelLabelledBy: panel?.getAttribute("aria-labelledby") ?? null,
      shows: panel?.querySelector("h2, .lc-toolbar button, th")?.textContent?.trim() ?? null,
      focusOnTab: document.activeElement?.dataset?.tab === tab,
      errors: errors.slice(before),
    };
    step.ok = step.appTab === tab && step.active && step.selected === "true" && step.panelLabelledBy === `lc-manager-tab-${tab}` && step.focusOnTab && !step.errors.length;
    steps.push(step);
  }
  // The keyboard: ArrowRight from the focused Pools tab opens Boxes and
  // keeps focus on it; End then opens the Pull log.
  const keys = [];
  for (const [key, tab] of [["ArrowRight", "boxes"], ["End", "log"]]) {
    const before = errors.length;
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    for (let t = 0; t < 60 && app.tab !== tab; t++) await wait(50);
    await wait(300);
    const now = app.element.querySelector(`.lc-tabs [data-tab="${tab}"]`);
    const step = { key, tab, appTab: app.tab, selected: now?.getAttribute("aria-selected") ?? null, tabindex: now?.getAttribute("tabindex") ?? null, focusOnTab: document.activeElement?.dataset?.tab === tab, errors: errors.slice(before) };
    step.ok = step.appTab === tab && step.selected === "true" && step.tabindex === "0" && step.focusOnTab && !step.errors.length;
    keys.push(step);
  }
  return { ok: steps.every(s => s.ok) && keys.every(s => s.ok), base: MODULE_BASE, steps, keys };
} finally {
  console.error = consoleError;
  window.removeEventListener("error", onError);
  window.removeEventListener("unhandledrejection", onError);
  await app.close();
}
