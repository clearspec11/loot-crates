/*
  The Pools tab follows another client's pool edits: a second GM's rename, a
  new pool (the starter crates added elsewhere) or an entry added or weighed
  elsewhere redraws the open tab through the store's batched redraw
  (redraw.js), keeping each pool's open state, a typed search, focus and a
  weight being typed. This window's own edits are drawn in place (a row, a
  pool's body) and are not drawn a second time when their write's batch
  lands, unless another change came in with them. Drives the real manager
  and the real batching, the Pools tab rendered into a minimal DOM, the
  store stubbed: its writes are heard as Foundry's onChange is, before the
  write's promise resolves.
*/
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { createDocument } from "./minidom.js";

vi.mock("../module/scripts/foundry/shop.js", () => ({ refreshShop: vi.fn() }));
vi.mock("../module/scripts/foundry/chat.js", () => ({ postRefundCard: vi.fn() }));

let pools, boxes;
// The store listener (redraw.js storeRedraw) each test makes; a write calls it.
let heard = () => {};
// Another client's write that lands while this window's own is in flight.
let alsoMeanwhile = null;
vi.mock("../module/scripts/foundry/store.js", async importOriginal => ({
  ...(await importOriginal()),
  getPools: () => structuredClone(pools),
  getBoxes: () => structuredClone(boxes),
  getLog: () => [],
  getRounds: () => ({}),
  isShopOpen: () => true,
  checkSources: async entries => new Map(entries.map(e => [e.uuid, { name: e.name, img: e.img, rarity: e.rarity }])),
  sweepPools: async () => [],
  updatePool: async (id, edit) => {
    if (alsoMeanwhile) { alsoMeanwhile(); alsoMeanwhile = null; heard("pools"); }
    pools[id] = typeof edit === "function" ? edit(structuredClone(pools[id])) : { ...pools[id], ...edit };
    heard("pools");
    return structuredClone(pools[id]);
  },
  removeEntry: async (poolId, uuid) => {
    pools[poolId].entries = pools[poolId].entries.filter(e => e.uuid !== uuid);
    heard("pools");
  },
}));

let renders = 0;
// ApplicationV2 as far as the manager uses it: a render draws the body and
// puts it in the window's content through _replaceHTML.
class App {
  rendered = false;
  async render() {
    renders++;
    const body = await this._renderHTML();
    this.content ??= document.body.appendChild(document.createElement("div"));
    this._replaceHTML(body, this.content);
    this.element = this.content;
    this.rendered = true;
    return this;
  }
}

let CrateManager, openManager, refreshManager, storeRedraw, SETTINGS;
beforeAll(async () => {
  vi.stubGlobal("document", createDocument());
  vi.stubGlobal("CSS", { escape: s => String(s) });
  vi.stubGlobal("ui", { notifications: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  vi.stubGlobal("foundry", {
    utils: { escapeHTML: s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"), deepClone: v => structuredClone(v) },
    applications: { api: { ApplicationV2: App, DialogV2: class { static confirm = async () => true; } } },
  });
  vi.stubGlobal("game", { settings: { get: () => true }, user: { isGM: true } });
  ({ CrateManager, openManager, refreshManager } = await import("../module/scripts/foundry/manager.js"));
  ({ storeRedraw } = await import("../module/scripts/core/redraw.js"));
  ({ SETTINGS } = await import("../module/scripts/core/config.js"));
});
afterAll(() => vi.unstubAllGlobals());

const item = (uuid, name, extra = {}) => ({ uuid, name, img: "", rarity: "rare", sourceRarity: "rare", weight: 1, ...extra });
beforeEach(() => {
  pools = {
    core: { id: "core", name: "Core magic items", pools: [], entries: [item("Item.sword", "Flame Tongue"), item("Item.ring", "Ring of Warmth"), item("Item.rope", "Rope of Climbing")] },
    spare: { id: "spare", name: "Spare parts", pools: [], entries: [item("Item.cog", "Cog")] },
  };
  boxes = { royal: { id: "royal", name: "Royal Crate", price: 50, pools: [{ id: "core", share: 1 }], weights: {}, rules: {} } };
  alsoMeanwhile = null;
});

const card = (app, id) => app.element.querySelector(`[data-drop-pool="${id}"]`);
const names = (app, id) => card(app, id).querySelectorAll(".lc-entries li").map(li => li.getAttribute("data-entry"));
const press = (app, action, el) => CrateManager.DEFAULT_OPTIONS.actions[action].call(app, {}, el);

// The manager open on its Pools tab, with the store's batched redraw wired
// to it; writes the stubbed store makes are heard by it.
async function poolsTab() {
  const app = openManager();
  app.tab = "pools";
  await app.render();
  expandPools(app);
  const listen = storeRedraw({ refreshShop: () => {}, refreshManager });
  heard = key => listen(key === "pools" ? SETTINGS.POOLS : key);
  renders = 0;
  return app;
}
// The tab opens with only the newest pool open (poolview.js poolToOpen);
// these open the rest as a GM does, a click on each pool's summary.
function expandPools(app) {
  for (const d of app.element.querySelectorAll(".lc-pool__details")) {
    if (d.hasAttribute("open")) continue;
    d.setAttribute("open", "");
    d.open = true;
    d.dispatchEvent({ type: "toggle" });
  }
}
// Another client's write: the setting changes and this client hears it.
const remote = change => { change(); heard("pools"); };
const batch = () => vi.advanceTimersByTimeAsync(200);

describe("the Pools tab and another client's pool edits", () => {
  it("draws a rename, a new pool and an entry added elsewhere, once for the batch", async () => {
    vi.useFakeTimers();
    try {
      const app = await poolsTab();
      remote(() => { pools.spare.name = "Odds and ends"; });
      remote(() => { pools.gems = { id: "gems", name: "Gems", pools: [], entries: [item("Item.ruby", "Ruby")] }; });
      remote(() => { pools.core.entries.push(item("Item.wand", "Wand of Sparks")); });
      await batch();
      expect(renders).toBe(1);
      expect(card(app, "spare").querySelector("summary").textContent).toMatch(/Odds and ends/);
      expect(card(app, "gems")).not.toBeNull();
      expect(names(app, "core")).toContain("Item.wand");
      // Nothing more came in: the next batch draws nothing.
      await batch();
      expect(renders).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it("keeps each pool's open state, the typed search and focus across that redraw", async () => {
    vi.useFakeTimers();
    try {
      const app = await poolsTab();
      // The GM closes Spare parts and searches Core for "Flame".
      const spare = card(app, "spare").querySelector(".lc-pool__details");
      spare.open = false;
      spare.dispatchEvent({ type: "toggle" });
      const search = card(app, "core").querySelector(".lc-pool__search");
      search.value = "Flame";
      app.element.querySelector(".lc-manager__body").dispatchEvent({ type: "input", target: search });
      await vi.advanceTimersByTimeAsync(200);
      expect(names(app, "core")).toEqual(["Item.sword"]);
      search.focus();
      renders = 0;

      remote(() => { pools.core.entries.push(item("Item.flail", "Flame Flail")); pools.spare.entries.push(item("Item.gear", "Gear")); });
      await batch();
      expect(renders).toBe(1);
      const again = card(app, "core").querySelector(".lc-pool__search");
      expect(again.value).toBe("Flame");
      expect(document.activeElement).toBe(again);
      expect(names(app, "core")).toEqual(["Item.sword", "Item.flail"]);
      expect(card(app, "spare").querySelector(".lc-pool__details").hasAttribute("open")).toBe(false);
      expect(card(app, "spare").querySelector(".lc-pool__body").childElementCount).toBe(0);
      // The manager is one window kept across these tests: put the view back.
      again.value = "";
      app.element.querySelector(".lc-manager__body").dispatchEvent({ type: "input", target: again });
      await vi.advanceTimersByTimeAsync(200);
      const closed = card(app, "spare").querySelector(".lc-pool__details");
      closed.open = true;
      closed.dispatchEvent({ type: "toggle" });
    } finally { vi.useRealTimers(); }
  });

  it("keeps where the GM had scrolled to when another client's edit redraws the tab", async () => {
    vi.useFakeTimers();
    try {
      const app = await poolsTab();
      const tab = () => app.element.querySelector(".lc-tab");
      tab().scrollTop = 1500;
      remote(() => { pools.spare.name = "Odds and ends"; });
      await batch();
      expect(renders).toBe(1);
      expect(tab().scrollTop).toBe(1500);
      // A tab switch starts at the top.
      press(app, "switchTab", { dataset: { tab: "boxes" } });
      await batch();
      expect(tab().getAttribute("aria-labelledby")).toBe("lc-manager-tab-boxes");
      expect(tab().scrollTop ?? 0).toBe(0);
      press(app, "switchTab", { dataset: { tab: "pools" } });
      await batch();
    } finally { vi.useRealTimers(); }
  });

  it("keeps a weight being typed, and focus on it, when another client's edit redraws the tab", async () => {
    vi.useFakeTimers();
    try {
      const app = await poolsTab();
      const weight = () => card(app, "core").querySelector('[data-entry="Item.ring"] input[data-curate="weight"]');
      weight().focus();
      weight().value = "7";
      remote(() => { pools.spare.name = "Odds and ends"; });
      await batch();
      expect(renders).toBe(1);
      expect(weight().value).toBe("7");
      expect(document.activeElement).toBe(weight());
    } finally { vi.useRealTimers(); }
  });
});

describe("the Pools tab's own edits", () => {
  it("draws a weight saved on a row in place, and not again when its write's batch lands", async () => {
    vi.useFakeTimers();
    try {
      const app = await poolsTab();
      const weight = card(app, "core").querySelector('[data-entry="Item.ring"] input[data-curate="weight"]');
      weight.focus();
      weight.value = "4";
      app.element.querySelector(".lc-manager__body").dispatchEvent({ type: "change", target: weight });
      await batch();
      expect(pools.core.entries.find(e => e.uuid === "Item.ring").weight).toBe(4);
      expect(renders).toBe(0);
      // The same node, still focused: the row was drawn in place.
      expect(document.activeElement).toBe(weight);
      expect(weight.isConnected).toBe(true);
      // A later change from elsewhere still draws.
      remote(() => { pools.core.name = "Core items"; });
      await batch();
      expect(renders).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it("draws Remove in place, and not again when its write's batch lands", async () => {
    vi.useFakeTimers();
    try {
      const app = await poolsTab();
      await press(app, "removeEntry", card(app, "spare").querySelector('[data-entry="Item.cog"] .lc-entry__remove'));
      await batch();
      expect(pools.spare.entries).toEqual([]);
      expect(renders).toBe(0);
      expect(names(app, "spare")).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it("redraws when another client's edit lands while its own row is saving", async () => {
    vi.useFakeTimers();
    try {
      const app = await poolsTab();
      const weight = card(app, "core").querySelector('[data-entry="Item.ring"] input[data-curate="weight"]');
      alsoMeanwhile = () => { pools.core.entries.push(item("Item.wand", "Wand of Sparks")); };
      weight.value = "4";
      app.element.querySelector(".lc-manager__body").dispatchEvent({ type: "change", target: weight });
      await batch();
      expect(renders).toBe(1);
      expect(names(app, "core")).toContain("Item.wand");
      expect(card(app, "core").querySelector('[data-entry="Item.ring"] input[data-curate="weight"]').value).toBe("4");
    } finally { vi.useRealTimers(); }
  });
});
