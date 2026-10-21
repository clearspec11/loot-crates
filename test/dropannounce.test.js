/*
  A drop on a pool is announced once: the manager's status line (role=status)
  names where the item went, and no toast repeats the same sentence for a
  screen reader to read twice. A drop that didn't go in still gets a toast.
  Drives the real manager: its pools tab rendered into a minimal DOM, a drop
  event on the pool, the store's drop helpers stubbed.
*/
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { createDocument } from "./minidom.js";

vi.mock("../module/scripts/shop.js", () => ({ refreshShop: vi.fn() }));
vi.mock("../module/scripts/chat.js", () => ({ postRefundCard: vi.fn() }));

let pools;
const NEW = { uuid: "Item.flame", name: "Flame Tongue", img: "", rarity: "rare", weight: 1 };
vi.mock("../module/scripts/store.js", async importOriginal => ({
  ...(await importOriginal()),
  getPools: () => pools,
  checkSources: async entries => new Map(entries.map(e => [e.uuid, { name: e.name, img: e.img, rarity: e.rarity }])),
  sweepPools: async () => [],
  entriesFromDrop: async (data, { known }) => (data.type !== "Item" ? null : known.includes(data.uuid)
    ? { label: "Flame Tongue", entries: [], skipped: { duplicates: 1, notLoot: {} } }
    : { label: "Flame Tongue", entries: [NEW], skipped: { duplicates: 0, notLoot: {} } }),
  addEntries: async (poolId, entries) => {
    pools = { ...pools, [poolId]: { ...pools[poolId], entries: [...pools[poolId].entries, ...entries] } };
    return entries.length;
  },
}));

const notifications = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let dropped = null;
let CrateManager;
beforeAll(async () => {
  vi.stubGlobal("document", createDocument());
  vi.stubGlobal("CSS", { escape: s => String(s) });
  vi.stubGlobal("ui", { notifications });
  vi.stubGlobal("foundry", {
    utils: { escapeHTML: s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"), deepClone: v => structuredClone(v) },
    applications: {
      api: { ApplicationV2: class { render() {} }, DialogV2: class {} },
      ux: { TextEditor: { implementation: { getDragEventData: () => dropped } } },
    },
  });
  vi.stubGlobal("game", { settings: { get: () => true } });
  ({ CrateManager } = await import("../module/scripts/manager.js"));
});
afterAll(() => vi.unstubAllGlobals());

const torch = { uuid: "Item.torch", name: "Torch", img: "", rarity: "common", weight: 1 };
beforeEach(() => {
  pools = { pool: { id: "pool", name: "Core magic items", pools: [], entries: [torch] } };
  for (const fn of Object.values(notifications)) fn.mockClear();
});

async function openPools() {
  const app = new CrateManager();
  const root = await app._renderHTML();
  document.body.appendChild(root);
  app.element = root;
  return app;
}

async function drop(app, data) {
  dropped = data;
  const event = { type: "drop", defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  app.element.querySelector('[data-drop-pool="pool"]').dispatchEvent(event);
  // #onDrop awaits the store's helpers; let them settle.
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
}

const status = app => app.element.querySelector(".lc-manager__status");

describe("a drop on a pool", () => {
  it("is announced once, in the status line, with no info toast", async () => {
    const app = await openPools();
    expect(status(app).getAttribute("role")).toBe("status");
    await drop(app, { type: "Item", uuid: NEW.uuid });
    expect(pools.pool.entries.map(e => e.uuid)).toEqual([torch.uuid, NEW.uuid]);
    expect(status(app).textContent).toBe("Flame Tongue added to Core magic items, Rare, at the top.");
    expect(notifications.info).not.toHaveBeenCalled();
    // The dropped row is pinned first in the opened pool.
    expect(app.element.querySelector(".lc-entries").children[0].getAttribute("data-entry")).toBe(NEW.uuid);
  });

  it("of an item already in the pool says so once, in the status line", async () => {
    pools.pool.entries.push(NEW);
    const app = await openPools();
    await drop(app, { type: "Item", uuid: NEW.uuid });
    expect(status(app).textContent).toBe("Flame Tongue is already in Core magic items; it is at the top.");
    expect(notifications.info).not.toHaveBeenCalled();
  });

  it("that can't go in is still a toast, and leaves the status line alone", async () => {
    const app = await openPools();
    await drop(app, { type: "Actor", uuid: "Actor.goblin" });
    expect(notifications.warn).toHaveBeenCalledWith("Drop an item, an Items folder, an item compendium or a roll table.");
    expect(status(app).textContent).toBe("");
  });
});
