/*
  The core's grant, whatever another module's hooks do: a creation a
  preCreateItem hook cancels (Foundry returns fewer documents than asked,
  with no error) is a failed grant, so the coins come back and nothing is
  logged; a Plutonium item is marked with Plutonium's own opt-out so its
  "Use Importer?" prompt never fires; and one play can grant several items
  (a kind's `grants`), created in one call, logged on one row and
  refunded together. The pull runs through the real socket handler, log and
  refund with a fake `game`, as kinds.test.js does.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../module/scripts/foundry/reveal.js", () => ({ showReveal: vi.fn(async () => ({ landed: Promise.resolve() })), heldState: () => null, boxHeld: () => false, onHold: () => () => {}, onRelease: () => () => {} }));

const { registerKind, readyToGrant, grantsOf, _resetKinds } = await import("../module/scripts/games/kinds.js");
const { performPull, createGrants, PullError } = await import("../module/scripts/foundry/pull.js");
const { registerSocket, itemColumns } = await import("../module/scripts/foundry/socket.js");
const { registerSettings, appendLog, getLog } = await import("../module/scripts/foundry/store.js");
const { refundPull, describeRefund, grantedItems } = await import("../module/scripts/foundry/refund.js");
const { postRefundCard } = await import("../module/scripts/foundry/chat.js");
const { toCopper } = await import("../module/scripts/core/currency.js");

const tick = () => new Promise(r => setTimeout(r, 0));

const PLUTONIUM = { page: "items.html", source: "DMG", hash: "flame%20tongue_dmg", propDroppable: "item" };
const itemData = (name, extra = {}) => ({ name, type: "weapon", flags: { "loot-crates": { boxId: "pair", sourceUuid: `Compendium.world.imps.Item.${name}`, at: 1 } }, ...extra });

// Two items a play: a stand-in for a scratch line that pays two (B2).
const PAIR = {
  id: "pair",
  noun: "crate",
  async roll() {
    return { result: { name: "Flame Tongue and Rope", img: "", rarity: "rare", uuid: "Compendium.world.imps.Item.Flame" }, grants: [itemData("Flame Tongue", { flags: { "loot-crates": { boxId: "pair", sourceUuid: "Compendium.world.imps.Item.Flame", at: 1 }, plutonium: { ...PLUTONIUM } } }), itemData("Rope")] };
  },
  logRow: ({ out }) => ({ name: out.result?.name ?? "", uuid: out.result?.uuid ?? null }),
};
// One Plutonium item, as the crate grants one from cc-dev's world.imps.
const ONE = {
  id: "one",
  async roll() {
    return { result: { name: "Flame Tongue", img: "", rarity: "rare", uuid: "Compendium.world.imps.Item.Flame" }, grant: itemData("Flame Tongue", { flags: { "loot-crates": { boxId: "one", sourceUuid: "Compendium.world.imps.Item.Flame", at: 1 }, plutonium: { ...PLUTONIUM } } }) };
  },
  logRow: ({ out }) => ({ name: out.result?.name ?? "", uuid: out.result?.uuid ?? null }),
};

const GM = { id: "gm", name: "Gamemaster" };
const PLAYER = { id: "p1", name: "Player" };
const GAMES = {
  pair: { id: "pair", kind: "pair", name: "Pair crate", price: 10, pools: [], weights: {}, rules: {} },
  one: { id: "one", kind: "one", name: "Imps crate", price: 10, pools: [], weights: {}, rules: {} },
};

/*
  An actor whose creation runs a preCreateItem stand-in per document:
  `veto(data)` true cancels that one, as Plutonium's hook does for an
  unmarked item it imported. Foundry returns the documents it made.
*/
function makeActor({ veto = () => false, deleteFails = false } = {}) {
  let n = 0;
  const actor = {
    id: "actor1", name: "Crate Tester", items: new Map(), writes: [], creations: [], deletions: [],
    system: { currency: { pp: 0, gp: 100, ep: 0, sp: 0, cp: 0 } },
    testUserPermission: () => true,
    async update(data) { await tick(); actor.writes.push(data["system.currency"]); if (data["system.currency"]) actor.system.currency = data["system.currency"]; },
    async createEmbeddedDocuments(_type, docs) {
      await tick();
      actor.creations.push(docs);
      const made = [];
      for (const d of docs) {
        if (veto(d)) continue;
        const id = `item${++n}`;
        const doc = { id, ...structuredClone(d), async delete() { await tick(); actor.items.delete(id); } };
        actor.items.set(id, doc);
        made.push(doc);
      }
      return made;
    },
    async deleteEmbeddedDocuments(_type, ids) {
      await tick();
      if (deleteFails) throw new Error("the server said no");
      actor.deletions.push(ids);
      for (const id of ids) actor.items.delete(id);
    },
  };
  return actor;
}

// Plutonium's preCreateItem, as Bundle.js has it: an item it imported,
// created on an actor without its opt-out, is cancelled.
const plutoniumVeto = d => { const f = d.flags?.plutonium; return !!f && f.propDroppable === "item" && !f.isStandardDragDrop && !f.isDirectImport; };

function makeWorld(actor) {
  const settings = new Map();
  const handlers = [];
  const emitted = [];
  const game = {
    user: GM,
    users: { activeGM: GM, get: id => [GM, PLAYER].find(u => u.id === id) ?? null },
    actors: { get: id => (id === actor.id ? actor : null) },
    settings: {
      register: (ns, key, { default: def }) => settings.set(`${ns}.${key}`, def),
      get: (ns, key) => settings.get(`${ns}.${key}`),
      async set(ns, key, value) { await tick(); settings.set(`${ns}.${key}`, value); },
    },
    socket: { on: (_n, fn) => handlers.push(fn), emit: (_n, msg) => emitted.push(msg) },
    messages: { contents: [] },
  };
  globalThis.game = game;
  globalThis.foundry = { utils: { randomID: n => Math.random().toString(36).slice(2, 2 + n), deepClone: v => structuredClone(v), escapeHTML: s => String(s) } };
  globalThis.ChatMessage = { create: vi.fn(async data => data), getSpeaker: () => ({ actor: actor.id }) };
  globalThis.ui = { notifications: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } };
  registerSettings();
  registerSocket();
  return { game, emitted, deliver: msg => Promise.all(handlers.map(h => h(msg))) };
}

async function buy(world, boxId) {
  await world.game.settings.set("loot-crates", "boxes", GAMES);
  await world.deliver({ type: "pull", requestId: `r-${boxId}`, boxId, actorId: "actor1", userId: "p1", price: 10 });
}

let errors;
beforeEach(() => {
  registerKind(PAIR);
  registerKind(ONE);
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...a) => errors.push(a.join(" ")));
});
afterEach(() => {
  _resetKinds(["crate"]);
  vi.restoreAllMocks();
  delete globalThis.game; delete globalThis.foundry; delete globalThis.ChatMessage; delete globalThis.ui;
});

describe("readyToGrant: Plutonium's own opt-out", () => {
  it("marks an item Plutonium imported isStandardDragDrop and keeps its other flags, on a copy", () => {
    const data = itemData("Flame Tongue", { flags: { "loot-crates": { boxId: "one" }, plutonium: { ...PLUTONIUM } } });
    const ready = readyToGrant(data);
    expect(ready.flags.plutonium).toEqual({ ...PLUTONIUM, isStandardDragDrop: true });
    expect(ready.flags["loot-crates"]).toEqual({ boxId: "one" });
    expect(ready.name).toBe("Flame Tongue");
    expect(data.flags.plutonium).not.toHaveProperty("isStandardDragDrop");
    expect(plutoniumVeto(ready)).toBe(false);
  });

  it("leaves everything else as it is: no Plutonium flags, Plutonium flags with nothing droppable, already marked", () => {
    const plain = itemData("Rope");
    expect(readyToGrant(plain)).toBe(plain);
    const noProp = itemData("Rope", { flags: { plutonium: { page: "items.html", hash: "rope" } } });
    expect(readyToGrant(noProp)).toBe(noProp);
    expect(readyToGrant(noProp).flags.plutonium).not.toHaveProperty("isStandardDragDrop");
    const marked = itemData("Rope", { flags: { plutonium: { ...PLUTONIUM, isStandardDragDrop: true } } });
    expect(readyToGrant(marked)).toBe(marked);
    expect(readyToGrant(null)).toBeNull();
  });

  it("reads a roll's items: grants when given, else its one grant, else none", () => {
    expect(grantsOf({ grants: [{ name: "a" }, null, { name: "b" }] })).toEqual([{ name: "a" }, { name: "b" }]);
    expect(grantsOf({ grant: { name: "a" } })).toEqual([{ name: "a" }]);
    expect(grantsOf({ grants: [], grant: { name: "a" } })).toEqual([{ name: "a" }]);
    expect(grantsOf({ grant: null })).toEqual([]);
    expect(grantsOf(undefined)).toEqual([]);
  });
});

describe("a creation another module cancels", () => {
  it("is a failed grant: the coins come back and the buyer is told, with nothing on the sheet", async () => {
    const actor = makeActor({ veto: () => true });
    const promise = performPull({ box: GAMES.one, pools: {}, actor, rng: () => 0.5 });
    await expect(promise).rejects.toBeInstanceOf(PullError);
    await expect(promise).rejects.toThrow("The item couldn't be added; your coins were returned.");
    expect(actor.writes).toHaveLength(2);
    expect(toCopper(actor.writes[0])).toBe(10000 - 1000);
    expect(actor.system.currency.gp).toBe(100);
    expect(actor.items.size).toBe(0);
    expect(errors.some(e => e.startsWith("loot-crates |") && e.includes("cancelled"))).toBe(true);
  });

  it("refuses over the socket and writes no row: nobody is charged for nothing", async () => {
    const actor = makeActor({ veto: () => true });
    const world = makeWorld(actor);
    await buy(world, "one");
    expect(world.emitted.find(m => m.type === "reveal")).toBeUndefined();
    expect(world.emitted.find(m => m.type === "error")).toMatchObject({ userId: "p1", message: "The item couldn't be added; your coins were returned." });
    expect(getLog()).toEqual([]);
    expect(actor.system.currency.gp).toBe(100);
  });

  it("rolls back a partial creation: the item that was made is deleted again and the coins come back", async () => {
    const actor = makeActor({ veto: d => d.name === "Rope" });
    const promise = performPull({ box: GAMES.pair, pools: {}, actor, rng: () => 0.5 });
    await expect(promise).rejects.toThrow("The item couldn't be added; your coins were returned.");
    expect(actor.creations).toHaveLength(1);
    expect(actor.deletions).toEqual([["item1"]]);
    expect(actor.items.size).toBe(0);
    expect(actor.system.currency.gp).toBe(100);
  });

  it("tells the GM by name when the item made can't be taken back, and still returns the coins", async () => {
    const actor = makeActor({ veto: d => d.name === "Rope", deleteFails: true });
    makeWorld(actor);
    await expect(createGrants(actor, PAIR_GRANTS())).rejects.toThrow("made 1 of 2 items");
    expect(globalThis.ui.notifications.error).toHaveBeenCalledWith("Flame Tongue could not be taken back from Crate Tester after a grant that failed; remove them from the sheet by hand.");
  });
});
const PAIR_GRANTS = () => [itemData("Flame Tongue", { flags: { plutonium: { ...PLUTONIUM } } }), itemData("Rope")];

describe("a Plutonium item", () => {
  it("lands on the sheet with no prompt, marked with the opt-out, and the row and reveal name it", async () => {
    const actor = makeActor({ veto: plutoniumVeto });
    const world = makeWorld(actor);
    await buy(world, "one");
    const reveal = world.emitted.find(m => m.type === "reveal");
    expect(reveal).toMatchObject({ itemId: "item1", itemUuid: "Actor.actor1.Item.item1", itemIds: ["item1"], itemUuids: ["Actor.actor1.Item.item1"] });
    const item = actor.items.get("item1");
    expect(item.flags.plutonium).toEqual({ ...PLUTONIUM, isStandardDragDrop: true });
    const [row] = getLog();
    expect(row).toMatchObject({ itemId: "item1", itemIds: ["item1"] });
    expect(row).not.toHaveProperty("itemNames");
    expect(actor.system.currency.gp).toBe(90);
    const out = await refundPull(row.id);
    expect(out).toMatchObject({ status: "refunded", removedItem: "Flame Tongue", removedItems: ["Flame Tongue"], goneItems: [] });
    expect(actor.items.size).toBe(0);
    expect(actor.system.currency.gp).toBe(100);
  });
});

describe("several items for one play", () => {
  it("are created in one call, logged on one row and refunded together", async () => {
    const actor = makeActor({ veto: plutoniumVeto });
    const world = makeWorld(actor);
    await buy(world, "pair");
    expect(actor.creations).toHaveLength(1);
    expect(actor.creations[0].map(d => d.name)).toEqual(["Flame Tongue", "Rope"]);
    const reveal = world.emitted.find(m => m.type === "reveal");
    expect(reveal).toMatchObject({ itemId: "item1", itemUuid: "Actor.actor1.Item.item1", itemIds: ["item1", "item2"], itemUuids: ["Actor.actor1.Item.item1", "Actor.actor1.Item.item2"] });
    expect(reveal).not.toHaveProperty("grants");
    expect(reveal).not.toHaveProperty("grant");
    const [row] = getLog();
    expect(row).toMatchObject({ itemId: "item1", itemIds: ["item1", "item2"], itemNames: ["Flame Tongue", "Rope"], price: 10 });
    expect(actor.system.currency.gp).toBe(90);

    const plan = describeRefund(row.id);
    expect(plan.items.map(i => i.name)).toEqual(["Flame Tongue", "Rope"]);
    expect(plan.gone).toEqual([]);
    const out = await refundPull(row.id);
    expect(out).toMatchObject({ status: "refunded", removedItem: "Flame Tongue and Rope", removedItems: ["Flame Tongue", "Rope"], goneItems: [] });
    expect(actor.deletions).toEqual([["item1", "item2"]]);
    expect(actor.items.size).toBe(0);
    expect(actor.system.currency.gp).toBe(100);
    const card = await postRefundCard({ row, actor, removedItem: out.removedItem, removedItems: out.removedItems, goneItems: out.goneItems });
    expect(card.content).toContain("Flame Tongue and Rope were removed from their inventory.");
  });

  it("removes the ones still there and names the one already gone", async () => {
    const actor = makeActor();
    const world = makeWorld(actor);
    await buy(world, "pair");
    actor.items.delete("item2");
    const [row] = getLog();
    const out = await refundPull(row.id);
    expect(out).toMatchObject({ status: "refunded", removedItems: ["Flame Tongue"], goneItems: ["Rope"] });
    expect(actor.items.size).toBe(0);
    expect(actor.system.currency.gp).toBe(100);
    const card = await postRefundCard({ row, actor, removedItem: out.removedItem, removedItems: out.removedItems, goneItems: out.goneItems });
    expect(card.content).toContain("Removed from their inventory: Flame Tongue. Already gone: Rope.");
  });

  it("never deletes an item under one of the row's ids that another game granted, or the player added", () => {
    const actor = makeActor();
    actor.items.set("item1", { id: "item1", name: "Flame Tongue", flags: { "loot-crates": { boxId: "pair" } } });
    actor.items.set("item2", { id: "item2", name: "Player's rope", flags: {} });
    actor.items.set("item3", { id: "item3", name: "Other crate's rope", flags: { "loot-crates": { boxId: "other" } } });
    const row = { boxId: "pair", name: "Pair", itemId: "item1", itemIds: ["item1", "item2", "item3"], itemNames: ["Flame Tongue", "Rope", "Rope again"] };
    const { items, gone } = grantedItems(row, actor);
    expect(items.map(i => i.id)).toEqual(["item1"]);
    expect(gone).toEqual(["Rope", "Rope again"]);
    // One item on a row keeps the stricter match on its source.
    const one = { boxId: "pair", name: "Flame Tongue", uuid: "Compendium.world.imps.Item.Flame", itemId: "item1", itemIds: ["item1"] };
    expect(grantedItems(one, actor)).toEqual({ items: [], gone: ["Flame Tongue"] });
    actor.items.get("item1").flags["loot-crates"].sourceUuid = one.uuid;
    expect(grantedItems(one, actor).items.map(i => i.id)).toEqual(["item1"]);
  });
});

describe("a row from before several items", () => {
  it("still refunds its one itemId, matched on the source it was granted from", async () => {
    const actor = makeActor();
    makeWorld(actor);
    await globalThis.game.settings.set("loot-crates", "boxes", GAMES);
    actor.items.set("old1", { id: "old1", name: "Wand", flags: { "loot-crates": { boxId: "one", sourceUuid: "Compendium.dnd5e.items.Item.wand" } }, async delete() { actor.items.delete("old1"); } });
    await appendLog({ kind: "one", boxId: "one", boxName: "Imps crate", actorId: "actor1", actorName: "Crate Tester", userId: "p1", itemId: "old1", name: "Wand", uuid: "Compendium.dnd5e.items.Item.wand", price: 10 });
    const [row] = getLog();
    expect(row).not.toHaveProperty("itemIds");
    const out = await refundPull(row.id);
    expect(out).toMatchObject({ status: "refunded", removedItem: "Wand", removedItems: ["Wand"], goneItems: [] });
    expect(actor.items.has("old1")).toBe(false);
    expect(actor.system.currency.gp).toBe(110);
  });

  it("names it as gone when it is, as before", () => {
    const actor = makeActor();
    expect(grantedItems({ boxId: "one", itemId: "old1", name: "Wand", uuid: "x" }, actor)).toEqual({ items: [], gone: ["Wand"] });
    expect(grantedItems({ boxId: "one", itemId: null, name: "A wish" }, actor)).toEqual({ items: [], gone: [] });
  });
});

describe("the row's item columns", () => {
  it("are the ids, the names only when there are several, and nothing for a play that granted none", () => {
    expect(itemColumns({ itemIds: [] })).toEqual({});
    expect(itemColumns({})).toEqual({});
    expect(itemColumns({ itemIds: ["a"], itemNames: ["Rope"] })).toEqual({ itemIds: ["a"] });
    expect(itemColumns({ itemIds: ["a", "b"], itemNames: ["Rope", "Wand"] })).toEqual({ itemIds: ["a", "b"], itemNames: ["Rope", "Wand"] });
  });
});
