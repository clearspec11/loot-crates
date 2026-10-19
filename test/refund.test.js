/*
  Refunding a logged pull with a fake `game`: coin-exact in whole coins, once
  only, removes only the item it granted, and puts the box's stock back.
*/
import { describe, it, expect, afterEach } from "vitest";
import { registerSettings, appendLog, getLog, getBoxes } from "../module/scripts/store.js";
import { refundPull, describeRefund, grantedItem } from "../module/scripts/refund.js";
import { toCopper, isWholeCoins } from "../module/scripts/currency.js";

const tick = () => new Promise(r => setTimeout(r, 0));

function makeActor(currency, items = []) {
  const actor = {
    id: "actor1", name: "Crate Tester", updates: 0,
    system: { currency: { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0, ...currency } },
    items: new Map(items.map(i => [i.id, { ...i, async delete() { await tick(); actor.items.delete(i.id); } }])),
    async update(data) { await tick(); actor.updates++; if (data["system.currency"]) actor.system.currency = data["system.currency"]; },
  };
  return actor;
}

function makeWorld(actor) {
  const settings = new Map();
  globalThis.game = {
    actors: { get: id => (id === actor.id ? actor : null) },
    settings: {
      register: (ns, key, { default: def }) => settings.set(`${ns}.${key}`, def),
      get: (ns, key) => settings.get(`${ns}.${key}`),
      async set(ns, key, value) { await tick(); settings.set(`${ns}.${key}`, value); },
    },
  };
  globalThis.foundry = { utils: { randomID: n => Math.random().toString(36).slice(2, 2 + n), deepClone: v => structuredClone(v) } };
  registerSettings();
}

const BOX = { id: "box", name: "Test Crate", price: 17.35, pools: [], weights: {}, rules: { stock: 2 } };
const ROW = { boxId: "box", boxName: "Test Crate", actorId: "actor1", actorName: "Crate Tester", userId: "p1", itemId: "item1", name: "Wand", uuid: "Compendium.dnd5e.items.Item.abc", rarity: "rare", price: 17.35 };
const GRANTED = { id: "item1", name: "Wand", flags: { "loot-crates": { boxId: "box", sourceUuid: "Compendium.dnd5e.items.Item.abc" } } };

async function seed(actor, { box = BOX, row = ROW } = {}) {
  makeWorld(actor);
  await globalThis.game.settings.set("loot-crates", "boxes", box ? { [box.id]: box } : {});
  await appendLog(row);
  return getLog()[0].id;
}

afterEach(() => { delete globalThis.game; delete globalThis.foundry; });

describe("refundPull", () => {
  it("returns the exact copper in whole coins, removes the granted item and restores stock", async () => {
    const actor = makeActor({ gp: 482, sp: 6, cp: 5 }, [GRANTED]);
    const rowId = await seed(actor);
    const before = toCopper(actor.system.currency);
    const out = await refundPull(rowId);
    expect(out.status).toBe("refunded");
    expect(out.removedItem).toBe("Wand");
    expect(actor.system.currency).toEqual({ pp: 0, gp: 499, ep: 0, sp: 9, cp: 10 });
    expect(toCopper(actor.system.currency)).toBe(before + 1735);
    expect(isWholeCoins(actor.system.currency)).toBe(true);
    expect(actor.items.has("item1")).toBe(false);
    expect(getBoxes().box.rules.stock).toBe(3);
    expect(getLog()[0].refunded).toBeTypeOf("number");
  });

  it("is a no-op the second time, even when both clicks land together", async () => {
    const actor = makeActor({ gp: 500 }, [GRANTED]);
    const rowId = await seed(actor);
    const [a, b] = await Promise.all([refundPull(rowId), refundPull(rowId)]);
    expect([a.status, b.status].sort()).toEqual(["already", "refunded"]);
    const third = await refundPull(rowId);
    expect(third.status).toBe("already");
    expect(actor.updates).toBe(1);
    expect(actor.system.currency.gp).toBe(517);
    expect(getBoxes().box.rules.stock).toBe(3);
  });

  it("only deletes the item carrying this pull's flag, and says so", async () => {
    const stranger = { id: "item1", name: "Player's own wand", flags: {} };
    const actor = makeActor({ gp: 500 }, [stranger]);
    const rowId = await seed(actor);
    expect(grantedItem(getLog()[0], actor)).toBeNull();
    expect(describeRefund(rowId).item).toBeNull();
    const out = await refundPull(rowId);
    expect(out.status).toBe("refunded");
    expect(out.removedItem).toBeNull();
    expect(actor.items.has("item1")).toBe(true);
    expect(actor.system.currency.gp).toBe(517);
  });

  it("refunds coins when the item is already gone and leaves unlimited stock alone", async () => {
    const actor = makeActor({ gp: 500 });
    const rowId = await seed(actor, { box: { ...BOX, rules: {} } });
    const out = await refundPull(rowId);
    expect(out).toMatchObject({ status: "refunded", removedItem: null, stock: null });
    expect(getBoxes().box.rules).toEqual({});
  });

  it("marks the row before the purse write, so a failed write can't be paid twice", async () => {
    const actor = makeActor({ gp: 500 }, [GRANTED]);
    actor.update = async () => { throw new Error("network blip"); };
    const rowId = await seed(actor);
    await expect(refundPull(rowId)).rejects.toThrow("network blip");
    expect(getLog()[0].refunded).toBeTypeOf("number");
    expect((await refundPull(rowId)).status).toBe("already");
  });

  it("reports a missing row or character without writing", async () => {
    const actor = makeActor({ gp: 500 });
    const rowId = await seed(actor, { row: { ...ROW, actorId: "ghost" } });
    expect((await refundPull("nope")).status).toBe("missing");
    expect((await refundPull(rowId)).status).toBe("no-actor");
    expect(getLog()[0].refunded).toBeUndefined();
  });
});
