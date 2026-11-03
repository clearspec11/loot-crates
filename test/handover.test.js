/*
  After the reveal, on the GM (foundry/handover.js, VIB-219): the winner's
  Give to… and Sell back arrive by query like any request, the sender
  Foundry's, and run in the write queue. Real socket.js, store.js, pull.js
  and refund.js on a fake world: a pull grants the item, then the winner
  (or someone else, or a forger) asks for it to be given or sold.
*/
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../module/scripts/foundry/reveal.js", () => ({ showReveal: vi.fn(async () => ({ landed: Promise.resolve() })) }));
vi.mock("../module/scripts/foundry/chat.js", () => ({ postPullCard: vi.fn(async () => null), postKeptCard: vi.fn(async () => null) }));

const { registerSocket, heardRequest } = await import("../module/scripts/foundry/socket.js");
const { registerSettings, enqueueWrite, getLog, getTally, getActorState, appendLog } = await import("../module/scripts/foundry/store.js");
const { refundPull, describeRefund } = await import("../module/scripts/foundry/refund.js");
const { onParted } = await import("../module/scripts/foundry/handover.js");
const { wonCount } = await import("../module/scripts/core/tally.js");

const tick = () => new Promise(r => setTimeout(r, 0));
const GM = { id: "gm", name: "Gamemaster", isGM: true };
const ANA = { id: "p1", name: "Ana", isGM: false };
const CY = { id: "p3", name: "Cy", isGM: false };
const USERS = [GM, ANA, CY];
const PRICE = { value: 150, denomination: "gp" };

// A character `owners` own (a GM owns every one); `calls` records each
// item write in order across the world.
function makeActor(id, name, owners, calls, { type = "character", gp = 500 } = {}) {
  const items = [];
  items.get = itemId => items.find(i => i.id === itemId) ?? null;
  let n = 0;
  const actor = {
    id, name, type, items, updates: 0, failCreate: false, failDelete: false, failUpdate: false,
    system: { currency: { pp: 0, gp, ep: 0, sp: 0, cp: 0 } },
    testUserPermission: (user, level) => level === "OWNER" && (!!user?.isGM || owners.includes(user?.id)),
    async update(data) {
      await tick();
      if (actor.failUpdate) throw new Error("update failed");
      actor.updates++;
      if (data["system.currency"]) actor.system.currency = data["system.currency"];
    },
    async createEmbeddedDocuments(_t, docs, opts = {}) {
      await tick();
      calls.push(`create ${id}`);
      if (actor.failCreate) return [];
      const made = docs.map(d => {
        const doc = { ...structuredClone(d), id: opts.keepId && d._id ? d._id : `${id}-item${++n}` };
        doc.delete = () => actor.deleteEmbeddedDocuments("Item", [doc.id]);
        doc.toObject = () => { const { toObject: _o, delete: _d, ...rest } = structuredClone({ ...doc, toObject: null, delete: null }); return { ...rest, _id: doc.id }; };
        return doc;
      });
      items.push(...made);
      return made;
    },
    async deleteEmbeddedDocuments(_t, ids) {
      await tick();
      calls.push(`delete ${id}`);
      if (actor.failDelete) throw new Error("delete failed");
      for (const itemId of ids) { const i = items.findIndex(x => x.id === itemId); if (i >= 0) items.splice(i, 1); }
      return ids;
    },
  };
  return actor;
}

function makeWorld() {
  const settings = new Map();
  const onChange = new Map();
  const emitted = [];
  const calls = [];
  const brinn = makeActor("actor1", "Brinn", ["p1"], calls);
  const saria = makeActor("actor2", "Saria", ["p3"], calls);
  const pony = makeActor("actor3", "Brinn's pony", ["p1"], calls);
  const npcHero = makeActor("actor4", "Sir Nobody", [], calls);
  const wolf = makeActor("actor5", "Cy's wolf", ["p3"], calls, { type: "npc" });
  const actors = [brinn, saria, pony, npcHero, wolf];
  const notes = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  const game = {
    user: GM,
    users: { activeGM: GM, contents: USERS, get: id => USERS.find(u => u.id === id) ?? null },
    actors: { contents: actors, get: id => actors.find(a => a.id === id) ?? null },
    messages: { contents: [] },
    settings: {
      register: (ns, key, { default: def, onChange: fn }) => { settings.set(`${ns}.${key}`, def); if (fn) onChange.set(`${ns}.${key}`, fn); },
      get: (ns, key) => settings.get(`${ns}.${key}`),
      async set(ns, key, value) { await tick(); settings.set(`${ns}.${key}`, value); onChange.get(`${ns}.${key}`)?.(value); },
    },
    socket: { on: () => {}, emit: (_n, msg) => emitted.push(msg) },
  };
  globalThis.game = game;
  globalThis.ui = { notifications: notes };
  globalThis.CONFIG = { queries: {} };
  globalThis.foundry = { utils: { randomID: n => Math.random().toString(36).slice(2, 2 + n), deepClone: v => structuredClone(v), escapeHTML: s => String(s) } };
  globalThis.fromUuid = async uuid => ({ name: `Wand ${uuid}`, img: "", toObject: () => ({ name: `Wand ${uuid}`, type: "equipment", system: { price: { ...PRICE }, quantity: 1 }, flags: {} }) });
  registerSettings();
  registerSocket();
  return { game, brinn, saria, pony, npcHero, wolf, emitted, notes, calls };
}

const POOL = { id: "pool", name: "Pool", pools: [], entries: [{ uuid: "wand", name: "Wand", img: "", rarity: "common", weight: 1 }] };
async function seed(game, rules = {}) {
  await game.settings.set("loot-crates", "pools", { pool: POOL });
  await game.settings.set("loot-crates", "boxes", { box: { id: "box", name: "Test Crate", price: 10, pools: [{ id: "pool", share: 1 }], weights: { common: 1 }, rules } });
  await game.settings.set("loot-crates", "shopOpen", true);
}
const setRules = async (game, rules) => {
  const boxes = game.settings.get("loot-crates", "boxes");
  await game.settings.set("loot-crates", "boxes", { box: { ...boxes.box, rules: { ...boxes.box.rules, ...rules } } });
};

// Ana's pull: the row, with its one item on Brinn.
async function won(world, rules = {}) {
  await seed(world.game, rules);
  const answer = await heardRequest({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1", price: 10, replyBy: "query" }, { user: ANA });
  const row = getLog()[0];
  world.calls.length = 0;
  return { answer, row, itemId: row.itemId };
}

// As Foundry delivers a player's query to the GM: the answer, or a refusal as { type: "error" }.
const ask = (msg, from) => globalThis.CONFIG.queries["loot-crates.request"]({ requestId: `q${Math.random()}`, replyBy: "query", ...msg }, { user: from });
const sell = (row, itemId, cp, from = ANA) => ask({ type: "sell", logId: row.id, itemId, cp, userId: from.id }, from);
const give = (row, itemId, targetId, from = ANA) => ask({ type: "give", logId: row.id, itemId, targetId, userId: from.id }, from);
const gp = actor => actor.system.currency.gp;

afterEach(() => {
  onParted(null);
  for (const k of ["game", "ui", "CONFIG", "foundry", "fromUuid"]) delete globalThis[k];
});

describe("a pull keeps what each item was worth as granted", () => {
  it("on the row and in the buyer's answer, by item id", async () => {
    const world = makeWorld();
    const { answer, row, itemId } = await won(world);
    expect(row.worth).toEqual({ [itemId]: { value: 150, denomination: "gp", quantity: 1 } });
    expect(answer.worth).toEqual(row.worth);
  });
});

describe("Sell back", () => {
  it("deletes the item and pays the game's share of its price, in one queued step, and records it", async () => {
    const world = makeWorld();
    const { row, itemId } = await won(world, { noDuplicates: true });
    expect(getActorState("actor1", "box").owned).toEqual(["wand"]);
    expect(wonCount(getTally(), { boxId: "box", actorId: "actor1", uuid: "wand" })).toBe(1);
    const heard = [];
    onParted(msg => heard.push(msg));
    // Behind a write already in the queue, nothing moves until it is done.
    let release;
    const held = enqueueWrite(() => new Promise(r => { release = r; }));
    const sale = sell(row, itemId, 7500);
    while (!release) await tick();
    await tick();
    expect(world.brinn.items).toHaveLength(1);
    expect(gp(world.brinn)).toBe(490);
    release();
    await held;
    const answer = await sale;
    expect(answer).toMatchObject({ type: "parted", logId: row.id, itemId, itemName: "Wand wand", actorName: "Brinn", part: { soldCp: 7500 } });
    expect(world.brinn.items).toHaveLength(0);
    expect(gp(world.brinn)).toBe(565);
    expect(answer.purse.gp).toBe(565);
    expect(world.calls).toEqual(["delete actor1"]);
    // The row, the tallies and the no-duplicates record, in the mark's write.
    expect(getLog()[0].parted[itemId]).toMatchObject({ soldCp: 7500 });
    expect(wonCount(getTally(), { boxId: "box", actorId: "actor1", uuid: "wand" })).toBe(0);
    expect(getActorState("actor1", "box").owned).toEqual([]);
    // Everyone's reveal hears it (the GM's own through the listener).
    expect(world.emitted.filter(m => m.type === "parted")).toEqual([expect.objectContaining({ logId: row.id, userId: "p1", itemId, part: expect.objectContaining({ soldCp: 7500 }) })]);
    expect(heard).toHaveLength(1);
  });

  it("pays in the item's own coin, floored, at the game's percentage", async () => {
    const world = makeWorld();
    globalThis.fromUuid = async () => ({ name: "Rope", img: "", toObject: () => ({ name: "Rope", type: "loot", system: { price: { value: 5, denomination: "sp" }, quantity: 1 }, flags: {} }) });
    const { row, itemId } = await won(world, { sellBack: 50 });
    const answer = await sell(row, itemId, 20);
    expect(answer.part.soldCp).toBe(20);
    expect(world.brinn.system.currency).toMatchObject({ gp: 490, sp: 2 });
  });

  it("refuses a press at a price the house no longer pays, naming the new one, and moves nothing", async () => {
    const world = makeWorld();
    const { row, itemId } = await won(world);
    await setRules(world.game, { sellBack: 40 });
    expect(await sell(row, itemId, 7500)).toEqual({ type: "error", message: "Test Crate now buys Wand wand back for 60 gp. Nothing was sold; press Sell back again to sell it at that." });
    expect(world.brinn.items).toHaveLength(1);
    expect(gp(world.brinn)).toBe(490);
    expect(getLog()[0].parted).toBeUndefined();
    expect((await sell(row, itemId, 6000)).part.soldCp).toBe(6000);
  });

  it("pays for no more of a stack than is still on the sheet, never for the stack as won", async () => {
    const world = makeWorld();
    globalThis.fromUuid = async () => ({ name: "Potion", img: "", toObject: () => ({ name: "Potion", type: "consumable", system: { price: { value: 50, denomination: "gp" }, quantity: 5 }, flags: {} }) });
    const { row, itemId } = await won(world);
    expect(row.worth[itemId].quantity).toBe(5);
    // Four drunk since the grant: the button's price for five is refused, naming one's.
    world.brinn.items[0].system.quantity = 1;
    expect((await sell(row, itemId, 12500)).message).toBe("Test Crate now buys Potion back for 25 gp. Nothing was sold; press Sell back again to sell it at that.");
    expect(gp(world.brinn)).toBe(490);
    expect(world.brinn.items).toHaveLength(1);
    expect((await sell(row, itemId, 2500)).part.soldCp).toBe(2500);
    expect(gp(world.brinn)).toBe(515);
  });

  it("refuses at 0%, or for an item with no price", async () => {
    const world = makeWorld();
    const { row, itemId } = await won(world, { sellBack: 0 });
    expect((await sell(row, itemId, 7500)).message).toBe("Test Crate doesn't buy Wand wand back. Nothing was sold.");
    expect(world.brinn.items).toHaveLength(1);
  });

  it("puts the item back with its id when the coins can't be paid, and lifts the mark", async () => {
    const world = makeWorld();
    const { row, itemId } = await won(world);
    vi.spyOn(console, "error").mockImplementation(() => {});
    world.brinn.failUpdate = true;
    expect((await sell(row, itemId, 7500)).message).toBe("Selling Wand wand back didn't work, so it stays with Brinn and no coins moved.");
    expect(world.brinn.items.map(i => i.id)).toEqual([itemId]);
    expect(gp(world.brinn)).toBe(490);
    expect(getLog()[0].parted).toBeUndefined();
  });
});

describe("Give to…", () => {
  it("makes the item on the other player's character, then takes it off the winner's, and records it", async () => {
    const world = makeWorld();
    const { row, itemId } = await won(world, { noDuplicates: true });
    const answer = await give(row, itemId, "actor2");
    expect(answer).toMatchObject({ type: "parted", itemId, part: { given: { actorId: "actor2", actorName: "Saria" } } });
    expect(world.calls).toEqual(["create actor2", "delete actor1"]);
    expect(world.brinn.items).toHaveLength(0);
    expect(world.saria.items).toHaveLength(1);
    const gift = world.saria.items[0];
    expect(gift.name).toBe("Wand wand");
    // Not taken for a fresh grant on anyone's sheet (reveal.js preSealItem).
    expect(gift.flags["loot-crates"]).toMatchObject({ boxId: "box", sourceUuid: "wand", given: { fromActorId: "actor1", logId: row.id } });
    expect(gift.flags["loot-crates"].at).toBeUndefined();
    expect(gp(world.brinn)).toBe(490);
    expect(getLog()[0].parted[itemId].given).toEqual({ actorId: "actor2", actorName: "Saria" });
    expect(getActorState("actor1", "box").owned).toEqual([]);
  });

  it("deletes the copy again when the winner's can't be taken off: never on both sheets, never on neither", async () => {
    const world = makeWorld();
    const { row, itemId } = await won(world);
    vi.spyOn(console, "error").mockImplementation(() => {});
    world.brinn.failDelete = true;
    expect((await give(row, itemId, "actor2")).message).toBe("Giving Wand wand to Saria didn't work, so it stays with Brinn.");
    expect(world.calls).toEqual(["create actor2", "delete actor1", "delete actor2"]);
    expect(world.brinn.items).toHaveLength(1);
    expect(world.saria.items).toHaveLength(0);
    expect(getLog()[0].parted).toBeUndefined();
  });

  it("leaves the item with the winner when another module cancels the creation", async () => {
    const world = makeWorld();
    const { row, itemId } = await won(world);
    vi.spyOn(console, "error").mockImplementation(() => {});
    world.saria.failCreate = true;
    expect((await give(row, itemId, "actor2")).message).toBe("Giving Wand wand to Saria didn't work, so it stays with Brinn.");
    expect(world.brinn.items).toHaveLength(1);
    expect(world.saria.items).toHaveLength(0);
    expect(getLog()[0].parted).toBeUndefined();
  });

  it.each([
    ["owned by a GM alone", "actor4"],
    ["owned by the same player", "actor3"],
    ["not a character", "actor5"],
    ["the winner's own", "actor1"],
    ["gone", "nobody"],
  ])("refuses a target %s", async (_why, target) => {
    const world = makeWorld();
    const { row, itemId } = await won(world);
    expect((await give(row, itemId, target)).message).toBe("Wand wand can only go to a character another player owns. Nothing moved.");
    expect(world.brinn.items).toHaveLength(1);
    expect(world.calls).toEqual([]);
  });
});

describe("the GM refuses what isn't the sender's to do", () => {
  it("another player's row, a forged sender, a refunded row, an item already given or sold, an item gone", async () => {
    const world = makeWorld();
    const { row, itemId } = await won(world);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Cy, as himself, for Ana's play.
    expect((await sell(row, itemId, 7500, CY)).message).toBe("Only the player who won an item can give it away or sell it back. Nothing moved.");
    expect((await give(row, itemId, "actor2", CY)).message).toBe("Only the player who won an item can give it away or sell it back. Nothing moved.");
    // Cy, naming Ana in the body: refused at the door.
    await expect(ask({ type: "sell", logId: row.id, itemId, cp: 7500, userId: "p1" }, CY)).resolves.toMatchObject({ type: "error", message: expect.stringContaining("named someone other than the player who sent it") });
    expect(world.brinn.items).toHaveLength(1);
    expect(gp(world.brinn)).toBe(490);
    // Not on the row, or not there any more.
    expect((await sell(row, "elsewhere", 7500)).message).toBe("That item didn't come from this play. Nothing moved.");
    expect((await sell({ id: "gone" }, itemId, 7500)).message).toBe("That play is no longer in the Pull log, so nothing was given or sold.");
    // Sold once, then again; given after it.
    await sell(row, itemId, 7500);
    expect((await sell(row, itemId, 7500)).message).toBe("Wand wand was already sold back.");
    expect((await give(row, itemId, "actor2")).message).toBe("Wand wand was already sold back.");
    expect(gp(world.brinn)).toBe(565);
  });

  it("an item already given, and one no longer on the sheet", async () => {
    const world = makeWorld();
    const { row, itemId } = await won(world);
    await give(row, itemId, "actor2");
    expect((await sell(row, itemId, 7500)).message).toBe("Wand wand was already given to Saria.");
    const second = await heardRequest({ type: "pull", requestId: "r2", boxId: "box", actorId: "actor1", userId: "p1", price: 10, replyBy: "query" }, { user: ANA });
    const row2 = getLog()[0];
    world.brinn.items.splice(0);
    expect(second.logId).toBe(row2.id);
    expect((await sell(row2, row2.itemId, 7500)).message).toBe("Wand wand is no longer on Brinn's sheet. Nothing moved.");
  });

  it("a refunded row", async () => {
    const world = makeWorld();
    const { row, itemId } = await won(world);
    expect((await refundPull(row.id)).status).toBe("refunded");
    expect((await sell(row, itemId, 7500)).message).toBe("That play was refunded, so Wand wand is no longer yours to pass on. Nothing moved.");
  });
});

describe("a refund after a give or a sell", () => {
  it("is refused with a plain sentence, and nothing moves", async () => {
    const world = makeWorld();
    const { row, itemId } = await won(world);
    await sell(row, itemId, 7500);
    expect(describeRefund(row.id)).toMatchObject({ status: "parted", message: "This play can't be refunded, because what it won has left the sheet: Brinn sold it back for 75 gp. Nothing was refunded." });
    const done = await refundPull(row.id);
    expect(done.status).toBe("parted");
    expect(gp(world.brinn)).toBe(565);
    expect(getLog()[0].refunded).toBeUndefined();
  });

  it("names a gift the same way", async () => {
    const world = makeWorld();
    const { row, itemId } = await won(world);
    await give(row, itemId, "actor2");
    expect(describeRefund(row.id).message).toBe("This play can't be refunded, because what it won has left the sheet: Brinn gave it to Saria. Nothing was refunded.");
  });
});

describe("several items from one play", () => {
  it("each is its own decision; the other stays to give or sell, and the row names each", async () => {
    const world = makeWorld();
    await seed(world.game);
    const made = await world.brinn.createEmbeddedDocuments("Item", [
      { name: "Wand of Webs", type: "equipment", system: { price: { ...PRICE } }, flags: { "loot-crates": { boxId: "box" } } },
      { name: "Potion", type: "consumable", system: { price: { value: 50, denomination: "gp" } }, flags: { "loot-crates": { boxId: "box" } } },
    ]);
    const [a, b] = made.map(d => d.id);
    await appendLog({ id: "row2", kind: "scratch", boxId: "box", boxName: "Test Crate", actorId: "actor1", actorName: "Brinn", userId: "p1", itemId: a, itemIds: [a, b], itemNames: ["Wand of Webs", "Potion"], price: 10, payoutCp: 0, worth: { [a]: { value: 150, denomination: "gp", quantity: 1 }, [b]: { value: 50, denomination: "gp", quantity: 1 } } });
    const row = getLog()[0];
    await give(row, a, "actor2");
    expect(world.brinn.items.map(i => i.id)).toEqual([b]);
    expect((await sell(row, b, 2500)).part.soldCp).toBe(2500);
    expect(world.brinn.items).toHaveLength(0);
    expect(Object.keys(getLog()[0].parted).sort()).toEqual([a, b].sort());
    expect(describeRefund("row2").message).toBe("This play can't be refunded, because what it won has left the sheet: Brinn gave Wand of Webs to Saria; sold Potion back for 25 gp. Nothing was refunded.");
  });
});
