/*
  The manager's pool and box edits apply only what the GM changed, to the
  setting as it is when the edit lands. A dialog's copy goes stale while it
  is open: a pull lowers stock and a sweep flags a dead entry missing, and
  writing that copy back would undo them.
*/
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerSettings, getPools, getBoxes, savePool, saveBox, markMissing, enqueueWrite, updatePool, updateBox, removePool } from "../module/scripts/store.js";

let settings;
beforeEach(() => {
  settings = new Map();
  vi.stubGlobal("foundry", { utils: { deepClone: v => structuredClone(v) } });
  vi.stubGlobal("game", { settings: {
    register: (_m, key, cfg) => settings.set(key, cfg.default),
    get: (_m, key) => settings.get(key),
    // A world setting's new value arrives only after the server answers.
    set: async (_m, key, v) => { await new Promise(r => setTimeout(r, 5)); settings.set(key, structuredClone(v)); },
  } });
  registerSettings();
});
afterEach(() => vi.unstubAllGlobals());

describe("pool and box edits", () => {
  it("renaming a pool keeps a missing flag set while the dialog was open", async () => {
    await savePool({ id: "p", name: "Old", entries: [{ uuid: "Item.dead", name: "Ghost Blade", rarity: "rare", weight: 1 }] });
    const opened = getPools().p; // the rename dialog's copy
    await enqueueWrite(() => markMissing("p", ["Item.dead"], true)); // a pull's sweep
    await updatePool(opened.id, { name: "New" });
    expect(getPools().p).toMatchObject({ name: "New", entries: [{ uuid: "Item.dead", missing: true }] });
  });

  it("editing a box keeps the stock a pull took while the dialog was open", async () => {
    await saveBox({ id: "b", name: "Crate", price: 50, rules: { stock: 3 } });
    const opened = getBoxes().b;
    await enqueueWrite(() => saveBox({ ...getBoxes().b, rules: { ...getBoxes().b.rules, stock: 2 } }));
    await updateBox(opened.id, fresh => ({ ...fresh, price: 60, rules: { ...fresh.rules } }));
    expect(getBoxes().b).toMatchObject({ price: 60, rules: { stock: 2 } });
  });

  it("queues edits behind writes in flight, so neither is lost", async () => {
    await savePool({ id: "p", name: "Pool", entries: [{ uuid: "Item.a", name: "A", weight: 1 }] });
    await savePool({ id: "q", name: "Other", entries: [] });
    const sweep = enqueueWrite(() => markMissing("p", ["Item.a"], true));
    const rename = updatePool("q", { name: "Renamed" });
    await Promise.all([sweep, rename]);
    expect(getPools().p.entries[0].missing).toBe(true);
    expect(getPools().q.name).toBe("Renamed");
  });

  it("does nothing to a pool or box deleted meanwhile", async () => {
    await savePool({ id: "p", name: "Pool" });
    await removePool("p");
    expect(await updatePool("p", { name: "Back" })).toBeNull();
    expect(getPools().p).toBeUndefined();
    expect(await updateBox("nope", b => b)).toBeNull();
  });
});
