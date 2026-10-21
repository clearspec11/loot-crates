/*
  A pool's header names the boxes that draw from it, Delete pool names them
  (and apart from them the ones it would empty), and Remove asks first only
  when the item is the last one some box can drop. Drives the real manager:
  its pools tab rendered into a minimal DOM, the store stubbed, DialogV2's
  confirm recorded.
*/
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { createDocument } from "./minidom.js";

vi.mock("../module/scripts/shop.js", () => ({ refreshShop: vi.fn() }));
vi.mock("../module/scripts/chat.js", () => ({ postRefundCard: vi.fn() }));

let pools, boxes;
const removed = [];
vi.mock("../module/scripts/store.js", async importOriginal => ({
  ...(await importOriginal()),
  getPools: () => structuredClone(pools),
  getBoxes: () => structuredClone(boxes),
  checkSources: async entries => new Map(entries.map(e => [e.uuid, e.missing ? null : { name: e.name, img: e.img, rarity: e.rarity }])),
  sweepPools: async () => [],
  removePool: async id => { removed.push(["pool", id]); },
  removeEntry: async (poolId, uuid) => {
    removed.push(["entry", poolId, uuid]);
    pools[poolId].entries = pools[poolId].entries.filter(e => e.uuid !== uuid);
  },
}));

const confirm = vi.fn();
let CrateManager;
beforeAll(async () => {
  vi.stubGlobal("document", createDocument());
  vi.stubGlobal("CSS", { escape: s => String(s) });
  vi.stubGlobal("ui", { notifications: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  vi.stubGlobal("foundry", {
    utils: { escapeHTML: s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"), deepClone: v => structuredClone(v) },
    applications: { api: { ApplicationV2: class { render() {} }, DialogV2: class { static confirm = confirm; } } },
  });
  vi.stubGlobal("game", { settings: { get: () => true } });
  ({ CrateManager } = await import("../module/scripts/manager.js"));
});
afterAll(() => vi.unstubAllGlobals());

const item = (uuid, name, extra = {}) => ({ uuid, name, img: "", rarity: "rare", sourceRarity: "rare", weight: 1, ...extra });
const box = (id, name, ...refs) => ({ id, name, price: 50, pools: refs.map(r => ({ id: r, share: 1 })), weights: {}, rules: {} });
beforeEach(() => {
  pools = {
    core: { id: "core", name: "Core magic items", pools: [], entries: [item("Item.sword", "Flame Tongue"), item("Item.ring", "Ring of Warmth")] },
    gems: { id: "gems", name: "Gems", pools: [], entries: [item("Item.ruby", "Ruby"), item("Item.dud", "Paste gem", { weight: 0 })] },
    hoard: { id: "hoard", name: "Hoard", pools: ["gems"], entries: [] },
    spare: { id: "spare", name: "Spare parts", pools: [], entries: [item("Item.cog", "Cog")] },
  };
  boxes = {
    adventurer: box("adventurer", "Adventurer's Crate", "core", "hoard"),
    royal: box("royal", "Royal Crate", "core"),
    dragon: box("dragon", "Dragon Chest", "hoard"),
  };
  confirm.mockReset();
  removed.length = 0;
});

async function openPools() {
  const app = new CrateManager();
  const root = await app._renderHTML();
  document.body.appendChild(root);
  app.element = root;
  return app;
}
const card = (app, id) => app.element.querySelector(`[data-drop-pool="${id}"]`);
const press = (app, action, el) => CrateManager.DEFAULT_OPTIONS.actions[action].call(app, {}, el);
const removeButton = (app, uuid) => app.element.querySelector(`[data-entry="${uuid}"] .lc-entry__remove`);

describe("a pool's header", () => {
  it("names the boxes that draw from it, nested ones too, or says none", async () => {
    const app = await openPools();
    const line = id => card(app, id).querySelector("summary .lc-pool__users")?.textContent;
    expect(line("core")).toBe("In Adventurer's Crate, Royal Crate");
    expect(line("gems")).toBe("In Adventurer's Crate, Dragon Chest");
    expect(line("hoard")).toBe("In Adventurer's Crate, Dragon Chest");
    expect(line("spare")).toBe("Not in any box");
  });
});

describe("Delete pool", () => {
  it("names the boxes that use it, and the one it would leave with nothing inside", async () => {
    confirm.mockResolvedValue(false);
    const app = await openPools();
    await press(app, "deletePool", card(app, "core").querySelector('[data-action="deletePool"]'));
    expect(confirm).toHaveBeenCalledTimes(1);
    const { content, window } = confirm.mock.calls[0][0];
    expect(window.title).toBe("Delete pool");
    expect(content).toContain("It is in <strong>Adventurer's Crate</strong> and <strong>Royal Crate</strong>.");
    expect(content).toContain("<p><strong>Adventurer's Crate</strong> can still drop items from its other pools.</p>");
    expect(content).toContain("<p><strong>Royal Crate</strong> will have nothing inside and can't be bought until it has an item that can drop.</p>");
    // No means nothing is deleted.
    expect(removed).toEqual([]);
  });

  it("of an unused pool says no box draws from it, and Yes deletes", async () => {
    confirm.mockResolvedValue(true);
    const app = await openPools();
    await press(app, "deletePool", card(app, "spare").querySelector('[data-action="deletePool"]'));
    expect(confirm.mock.calls[0][0].content).toBe("<p>Delete <strong>Spare parts</strong>? No box draws from it.</p>");
    expect(removed).toEqual([["pool", "spare"]]);
  });
});

describe("Remove", () => {
  it("with no box emptied opens no dialog and removes at once", async () => {
    const app = await openPools();
    await press(app, "removeEntry", removeButton(app, "Item.sword"));
    expect(confirm).not.toHaveBeenCalled();
    expect(removed).toEqual([["entry", "core", "Item.sword"]]);
    expect(card(app, "core").querySelector('[data-entry="Item.sword"]')).toBeNull();
  });

  it("of the last item a box can drop names that box first, and No keeps it", async () => {
    confirm.mockResolvedValue(false);
    const app = await openPools();
    // The ruby is Gems' only droppable item (the paste gem weighs 0): the
    // Dragon Chest draws only from Hoard, which nests only Gems.
    const button = removeButton(app, "Item.ruby");
    await press(app, "removeEntry", button);
    expect(confirm).toHaveBeenCalledTimes(1);
    const { content, window } = confirm.mock.calls[0][0];
    expect(window.title).toBe("Remove item");
    expect(content).toBe("<p>Remove <strong>Ruby</strong> from <strong>Gems</strong>? It is the last item Dragon Chest can drop.</p>"
      + "<p><strong>Dragon Chest</strong> will have nothing inside and can't be bought until it has an item that can drop.</p>");
    expect(content).not.toContain("Adventurer");
    expect(removed).toEqual([]);
    expect(document.activeElement).toBe(button);
  });

  it("goes ahead when the GM says Yes", async () => {
    confirm.mockResolvedValue(true);
    const app = await openPools();
    await press(app, "removeEntry", removeButton(app, "Item.ruby"));
    expect(removed).toEqual([["entry", "gems", "Item.ruby"]]);
  });
});
