/*
  The Auction (auction.js) on the table round: a bid is an open stake, a
  higher bid refunds the one it beats in the same queued task, the gavel
  moves with each bid, a character can't outbid themselves, two bids at
  one amount queued together leave the second refused naming the new
  least bid, house bidders bid only against a player and within budget,
  and the one hammer settles the top bid (item or sealed crate), or
  refunds it (house win, reserve, lot gone, grant failed), once. A GM's
  load past the gavel and its grace refunds an open bid; Call it off
  refunds every bid. The Pull log shows a house bid with no Refund.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDocument } from "./minidom.js";

vi.mock("../module/scripts/foundry/reveal.js", () => ({ showReveal: vi.fn(async () => ({ landed: Promise.resolve() })), showRound: vi.fn(() => ({ landed: Promise.resolve(), instant: true })), boxHeld: vi.fn(() => false) }));
vi.mock("../module/scripts/foundry/chat.js", () => ({ postPullCard: vi.fn(async () => null) }));

const { registerSocket } = await import("../module/scripts/foundry/socket.js");
const { registerSettings, getLog, getRounds, enqueueWrite, saveRound } = await import("../module/scripts/foundry/store.js");
const { openRound, resolveRound, recoverRounds, cancelRound, tableTick, stopWatching, onTable } = await import("../module/scripts/foundry/table.js");
const { refundPull } = await import("../module/scripts/foundry/refund.js");
const { stakesOf, tableDue, stakeNote, ROUND_GRACE_MS } = await import("../module/scripts/core/round.js");
const { toCopper } = await import("../module/scripts/core/currency.js");
const { getKind } = await import("../module/scripts/games/kinds.js");
const auction = await import("../module/scripts/games/auction.js");
const { tableBodyHTML } = await import("../module/scripts/views/tableview.js");
const { logTableHTML } = await import("../module/scripts/views/logtable.js");
const { postPullCard } = await import("../module/scripts/foundry/chat.js");

const KIND = getKind("auction");
const tick = () => new Promise(r => setTimeout(r, 0));

const GM = { id: "gm", name: "Gamemaster" };
const USERS = [GM, { id: "p1", name: "Ana" }, { id: "p2", name: "Bo" }, { id: "p3", name: "Cy" }];

function makeActor(id, owner, gp = 100) {
  const items = new Map();
  const actor = {
    id, name: `Char ${id}`, owners: new Set([owner, "gm"]),
    system: { currency: { pp: 0, gp, ep: 0, sp: 0, cp: 0 } },
    items: { get: i => items.get(i) ?? null, get size() { return items.size; } },
    failGrant: false,
    testUserPermission(user) { return actor.owners.has(user?.id); },
    async update(data) {
      await tick();
      if (data["system.currency"]) actor.system.currency = data["system.currency"];
    },
    async createEmbeddedDocuments(_type, list) {
      await tick();
      if (actor.failGrant) throw new Error("sheet refused");
      return list.map(d => {
        const item = { id: `it${items.size + 1}`, name: d.name, flags: d.flags, delete: async () => { items.delete(item.id); } };
        items.set(item.id, item);
        return item;
      });
    },
  };
  return actor;
}

// Item sources by uuid, as fromUuid finds them.
const SOURCES = {
  "Item.sling": { name: "Sling +2", img: "sling.webp", uuid: "Item.sling", toObject: () => ({ _id: "x", name: "Sling +2", type: "weapon", system: { rarity: "uncommon" } }) },
  "Item.cloak": { name: "Cloak of Elvenkind", img: "cloak.webp", uuid: "Item.cloak", toObject: () => ({ _id: "y", name: "Cloak of Elvenkind", type: "equipment", system: { rarity: "uncommon" } }) },
};

function makeWorld() {
  const settings = new Map();
  const handlers = [];
  const emitted = [];
  const actors = new Map([["a1", makeActor("a1", "p1")], ["a2", makeActor("a2", "p2")], ["a3", makeActor("a3", "p3")]]);
  const notes = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  const game = {
    user: GM,
    users: { activeGM: GM, get: id => USERS.find(u => u.id === id) ?? null },
    actors: { get: id => actors.get(id) ?? null },
    messages: { contents: [] },
    settings: {
      register: (ns, key, { default: def }) => settings.set(`${ns}.${key}`, def),
      get: (ns, key) => settings.get(`${ns}.${key}`),
      async set(ns, key, value) { await tick(); settings.set(`${ns}.${key}`, structuredClone(value)); },
    },
    socket: { on: (_n, fn) => handlers.push(fn), emit: (_n, msg) => emitted.push(msg) },
  };
  globalThis.game = game;
  globalThis.ui = { notifications: notes };
  globalThis.foundry = { utils: { randomID: n => Math.random().toString(36).slice(2, 2 + n), deepClone: v => structuredClone(v), escapeHTML: s => String(s) } };
  globalThis.fromUuid = async uuid => SOURCES[uuid] ?? null;
  registerSettings();
  registerSocket();
  const deliver = msg => Promise.all(handlers.map(h => h(msg)));
  return { game, actors, emitted, deliver, notes };
}

const ITEM_LOT = { type: "item", uuid: "Item.sling", name: "Sling +2", img: "sling.webp", rarity: "uncommon" };
const AUCTION = (over = {}) => ({ id: "lot", name: "The Sling", kind: "auction", price: 10, pools: [], auction: { lot: ITEM_LOT, increment: 5, reserve: 0, gavelSec: 20, house: { count: 0, budget: 100, chance: 25 }, ...over }, rules: {} });
const POOLS = { loot: { id: "loot", name: "Loot", pools: [], entries: [{ uuid: "Item.cloak", name: "Cloak of Elvenkind", img: "cloak.webp", rarity: "uncommon", weight: 1 }] } };
const CRATE = { id: "crate", name: "Adventurer's Crate", price: 50, pools: [{ id: "loot", share: 1 }], weights: { common: 0, uncommon: 1, rare: 0, veryRare: 0, legendary: 0, artifact: 0 }, rules: {} };

async function seed(world, boxes = { lot: AUCTION() }, pools = POOLS) {
  await world.game.settings.set("loot-crates", "boxes", boxes);
  await world.game.settings.set("loot-crates", "pools", pools);
}

// A player's bid as the GM's socket hears it.
const bid = (round, actorId, userId, amount) => ({ type: "stake", requestId: `r-${actorId}-${Math.random()}`, boxId: "lot", roundId: round.id, actorId, userId, price: amount, bet: { amount } });
const gp = actor => toCopper(actor.system.currency) / 100;
const errorsFor = (world, userId) => world.emitted.filter(m => m.type === "error" && m.userId === userId).map(m => m.message);
const rowsOf = round => getLog().filter(r => r.roundId === round.id);

let world;
beforeEach(async () => {
  world = makeWorld();
  await seed(world);
  postPullCard.mockClear();
});

afterEach(() => {
  stopWatching();
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete globalThis.game;
  delete globalThis.ui;
  delete globalThis.foundry;
  delete globalThis.fromUuid;
});

describe("bids", () => {
  it("hold their amount as an open stake; a higher bid refunds the one it beats in the same queued task", async () => {
    const round = await openRound("lot");
    await world.deliver(bid(round, "a1", "p1", 10));
    expect(gp(world.actors.get("a1"))).toBe(90);
    // The second bid and a probe queued behind it: the probe runs as soon
    // as the bid's own task is done, and finds the beaten bid refunded.
    let seen = null;
    const second = world.deliver(bid(round, "a2", "p2", 15));
    const probe = enqueueWrite(async () => { seen = { a1: gp(world.actors.get("a1")), rows: rowsOf(round).map(r => [r.actorId, r.status, r.refundReason ?? null]) }; });
    await Promise.all([second, probe]);
    expect(seen.a1).toBe(100);
    expect(seen.rows).toEqual([["a2", "open", null], ["a1", "refunded", "outbid"]]);
    expect(gp(world.actors.get("a2"))).toBe(85);
    // One open stake per lot.
    expect(stakesOf(getLog(), round.id).filter(r => r.status === "open")).toHaveLength(1);
    const staked = world.emitted.filter(m => m.type === "staked");
    expect(staked.at(-1)).toMatchObject({ actorId: "a2", price: 15, stake: { amount: 15, label: "Bid 15 gp" }, outbid: [rowsOf(round)[1].id] });
  });

  it("move the gavel to now plus the gavel time, and say so in the broadcast", async () => {
    const round = await openRound("lot", { windowMs: 20000 });
    const before = Date.now();
    await saveRound({ ...getRounds()[round.id], closesAt: before + 3000 });
    await world.deliver(bid(round, "a1", "p1", 10));
    const closesAt = getRounds()[round.id].closesAt;
    expect(closesAt).toBeGreaterThanOrEqual(before + 20000);
    expect(world.emitted.find(m => m.type === "staked").round.closesAt).toBe(closesAt);
  });

  it("two at the same amount queued together: the first holds, the second is refused naming the new least bid", async () => {
    const round = await openRound("lot");
    await Promise.all([world.deliver(bid(round, "a1", "p1", 15)), world.deliver(bid(round, "a2", "p2", 15))]);
    expect(errorsFor(world, "p2")).toEqual(["The bid is now 15 gp by Char a1; the least you can bid is 20 gp."]);
    expect(gp(world.actors.get("a1"))).toBe(85);
    expect(gp(world.actors.get("a2"))).toBe(100);
    expect(rowsOf(round)).toHaveLength(1);
  });

  it("refuses a character outbidding themselves, a bid under the opening, and one past the purse, charging nothing", async () => {
    const round = await openRound("lot");
    await world.deliver(bid(round, "a1", "p1", 5));
    expect(errorsFor(world, "p1")).toEqual(["The opening bid at The Sling is 10 gp."]);
    await world.deliver(bid(round, "a1", "p1", 10));
    await world.deliver(bid(round, "a1", "p1", 20));
    expect(errorsFor(world, "p1").at(-1)).toBe("Char a1 already holds the top bid, 10 gp.");
    expect(gp(world.actors.get("a1"))).toBe(90);
    await world.deliver(bid(round, "a3", "p3", 200));
    expect(errorsFor(world, "p3")).toEqual(["Char a3 can't afford The Sling."]);
    expect(gp(world.actors.get("a3"))).toBe(100);
    expect(rowsOf(round)).toHaveLength(1);
  });

  it("refuse a bid once the gavel has run out", async () => {
    const round = await openRound("lot");
    await saveRound({ ...getRounds()[round.id], closesAt: Date.now() - 10 });
    await world.deliver(bid(round, "a1", "p1", 10));
    expect(errorsFor(world, "p1")).toEqual(["Bets are closed for this round."]);
    expect(gp(world.actors.get("a1"))).toBe(100);
  });

  it("are refused on an auction taken off the shelf, and no auction opens off it or sold out", async () => {
    await seed(world, { lot: { ...AUCTION(), rules: { shelved: false } } });
    await expect(openRound("lot")).rejects.toThrow("The Sling is off the shelf. Put it on the shelf to open a round.");
    await seed(world, { lot: { ...AUCTION(), rules: { stock: 0 } } });
    await expect(openRound("lot")).rejects.toThrow("The Sling is sold out.");
    await seed(world, { lot: AUCTION({ lot: null }) });
    await expect(openRound("lot")).rejects.toThrow("The Sling has no lot. Pick one in its editor first.");
    expect(getRounds()).toEqual({});
  });
});

describe("house bidders", () => {
  const house = (h, stakes, rng = () => 0) => auction.houseBid({ game: AUCTION({ house: h }), stakes, rng });
  const open = (id, amount, extra = {}) => ({ id, actorId: "a1", actorName: "Char a1", price: amount, stake: { amount }, status: "open", ...extra });

  it("bid the next legal amount, only against a player, never past their budget", () => {
    expect(house({ count: 2, budget: 100, chance: 100 }, [])).toBeNull();
    expect(house({ count: 2, budget: 100, chance: 100 }, [open("h", 20, { house: true, actorId: null })])).toBeNull();
    expect(house({ count: 2, budget: 100, chance: 100 }, [open("p", 20)])).toMatchObject({ amount: 25, outbid: ["p"], closesIn: 20000, actorName: expect.stringMatching(/^House bidder [12]$/) });
    expect(house({ count: 2, budget: 24, chance: 100 }, [open("p", 20)])).toBeNull();
    expect(house({ count: 2, budget: 25, chance: 100 }, [open("p", 20)])).toMatchObject({ amount: 25 });
    expect(house({ count: 0, budget: 100, chance: 100 }, [open("p", 20)])).toBeNull();
    expect(house({ count: 3, budget: 100, chance: 0 }, [open("p", 20)], Math.random)).toBeNull();
    expect(house({ count: 1, budget: 100, chance: 50 }, [open("p", 20)], () => 0.6)).toBeNull();
  });

  it("bid on the GM in the write queue as rows with no character and no coins, refunding the player at once", async () => {
    await seed(world, { lot: AUCTION({ house: { count: 1, budget: 100, chance: 100 } }) });
    const round = await openRound("lot");
    await world.deliver(bid(round, "a1", "p1", 10));
    const heard = [];
    const off = onTable(m => heard.push(m));
    const staked = await tableTick(round.id, { rng: () => 0 });
    off();
    expect(staked).toMatchObject({ type: "staked", house: true, actorId: null, actorName: "House bidder 1", price: 0, stake: { amount: 15, house: 1 } });
    expect(heard.map(m => m.type)).toEqual(["staked"]);
    expect(gp(world.actors.get("a1"))).toBe(100);
    const [h, p] = rowsOf(round);
    expect(h).toMatchObject({ house: true, actorId: null, price: 0, status: "open" });
    expect(p).toMatchObject({ actorId: "a1", status: "refunded", refundReason: "outbid" });
    // The house doesn't outbid itself.
    expect(await tableTick(round.id, { rng: () => 0 })).toBeNull();
  });
});

describe("the hammer", () => {
  it("sells the lot to the top bid: the item on the sheet, the purse down exactly the bid, one chat card", async () => {
    const round = await openRound("lot");
    await world.deliver(bid(round, "a1", "p1", 10));
    await world.deliver(bid(round, "a2", "p2", 15));
    const out = await resolveRound(round.id);
    const a2 = world.actors.get("a2");
    expect(gp(a2)).toBe(85);
    expect(gp(world.actors.get("a1"))).toBe(100);
    expect(a2.items.size).toBe(1);
    expect(out.reveal.outcome).toMatchObject({ verdict: "sold", amount: 15, bidder: "Char a2", actorId: "a2", bids: 2, result: { name: "Sling +2", rarity: "uncommon" } });
    const row = rowsOf(round).find(r => r.actorId === "a2");
    expect(row).toMatchObject({ status: "settled", payoutCp: 0, name: "Sling +2", uuid: "Item.sling", itemId: "it1", note: "Won at the hammer for 15 gp." });
    expect(stakeNote(row)).toBe("Won at the hammer for 15 gp.");
    // The grant never rides in the broadcast.
    expect(JSON.stringify(out.reveal)).not.toContain("toObject");
    expect(out.reveal.grants).toBeUndefined();
    expect(postPullCard).toHaveBeenCalledTimes(1);
    expect(auction.verdictText(out.reveal.outcome)).toBe("Sold to Char a2 for 15 gp.");
  });

  it("settles once: a second hammer, even queued at the same time, does nothing", async () => {
    const round = await openRound("lot");
    await world.deliver(bid(round, "a1", "p1", 10));
    const [first, second] = await Promise.all([resolveRound(round.id), resolveRound(round.id)]);
    expect(first.status).toBe("resolved");
    expect(second.status).toBe("already");
    expect((await resolveRound(round.id)).status).toBe("already");
    expect(gp(world.actors.get("a1"))).toBe(90);
    expect(world.actors.get("a1").items.size).toBe(1);
    expect(postPullCard).toHaveBeenCalledTimes(1);
  });

  it("refunds the top bid when the reserve isn't met", async () => {
    await seed(world, { lot: AUCTION({ reserve: 50 }) });
    const round = await openRound("lot");
    await world.deliver(bid(round, "a1", "p1", 20));
    const out = await resolveRound(round.id);
    expect(out.reveal.outcome).toMatchObject({ verdict: "reserve", reserve: true, reserveMet: false });
    expect(gp(world.actors.get("a1"))).toBe(100);
    expect(world.actors.get("a1").items.size).toBe(0);
    const row = rowsOf(round)[0];
    expect(row).toMatchObject({ status: "refunded", refundReason: "reserve" });
    expect(stakeNote(row)).toBe("Refunded at the hammer: the reserve wasn't met.");
  });

  it("sells nothing on a house win: every player's bid came back and no purse moved", async () => {
    await seed(world, { lot: AUCTION({ house: { count: 1, budget: 100, chance: 100 } }) });
    const round = await openRound("lot");
    await world.deliver(bid(round, "a1", "p1", 10));
    await tableTick(round.id, { rng: () => 0 });
    const out = await resolveRound(round.id);
    expect(out.reveal.outcome).toMatchObject({ verdict: "house", amount: 15, bidder: "House bidder 1", house: true });
    expect(gp(world.actors.get("a1"))).toBe(100);
    expect(world.actors.get("a1").items.size).toBe(0);
    const house = rowsOf(round).find(r => r.house);
    expect(house).toMatchObject({ status: "settled", payoutCp: 0, name: "Won by the house at 15 gp" });
    expect(world.notes.warn).not.toHaveBeenCalled();
  });

  it("refunds the winner when the lot is gone, or the item can't be put on the sheet", async () => {
    await seed(world, { lot: AUCTION({ lot: { ...ITEM_LOT, uuid: "Item.gone" } }) });
    let round = await openRound("lot");
    await world.deliver(bid(round, "a1", "p1", 10));
    let out = await resolveRound(round.id);
    expect(out.reveal.outcome.verdict).toBe("lot");
    expect(rowsOf(round)[0]).toMatchObject({ status: "refunded", refundReason: "lot" });
    expect(gp(world.actors.get("a1"))).toBe(100);

    await seed(world, { lot: AUCTION() });
    world.actors.get("a2").failGrant = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    round = await openRound("lot");
    await world.deliver(bid(round, "a2", "p2", 10));
    out = await resolveRound(round.id);
    expect(out.reveal.stakes[0]).toMatchObject({ action: "refund", reason: "grant" });
    expect(auction.verdictText(auction.outcomeOf(out.reveal))).toBe("No sale: the lot couldn't be put on Char a2's sheet. The top bid of 10 gp came back.");
    expect(rowsOf(round)[0]).toMatchObject({ status: "refunded", refundReason: "grant" });
    expect(gp(world.actors.get("a2"))).toBe(100);
  });

  it("runs the crate's roll for the winner of a sealed crate: its draw granted, its strip in the broadcast", async () => {
    await seed(world, { lot: AUCTION({ lot: { type: "crate", boxId: "crate", name: "Adventurer's Crate" } }), crate: CRATE });
    const round = await openRound("lot");
    await world.deliver(bid(round, "a1", "p1", 10));
    await world.deliver(bid(round, "a3", "p3", 30));
    const out = await resolveRound(round.id);
    expect(out.reveal.outcome).toMatchObject({ verdict: "sold", actorId: "a3", amount: 30, lot: { type: "crate", name: "Adventurer's Crate" }, result: { name: "Cloak of Elvenkind", uuid: "Item.cloak" } });
    const strip = out.reveal.strip;
    expect(strip.cards[strip.landIndex]).toMatchObject({ uuid: "Item.cloak", result: true });
    expect(world.actors.get("a3").items.size).toBe(1);
    expect(gp(world.actors.get("a3"))).toBe(70);
    expect(rowsOf(round).find(r => r.actorId === "a3")).toMatchObject({ status: "settled", name: "Cloak of Elvenkind", uuid: "Item.cloak" });
    expect(auction.verdictText(out.reveal.outcome)).toBe("Sold to Char a3 for 30 gp. The crate gave Cloak of Elvenkind.");
  });

  it("is undone by the GM's Refund in the Pull log: the bid back, the item off the sheet", async () => {
    const round = await openRound("lot");
    await world.deliver(bid(round, "a1", "p1", 25));
    await resolveRound(round.id);
    const row = rowsOf(round)[0];
    const done = await refundPull(row.id);
    expect(done.status).toBe("refunded");
    expect(done.removedItem).toBe("Sling +2");
    expect(gp(world.actors.get("a1"))).toBe(100);
    expect(world.actors.get("a1").items.size).toBe(0);
  });

  it("waits for a bid queued just ahead of the watch's hammer (ifDue), and is owed once the gavel runs out", async () => {
    const round = await openRound("lot", { windowMs: 20000 });
    await world.deliver(bid(round, "a1", "p1", 10));
    expect((await resolveRound(round.id, { ifDue: true })).status).toBe("not-due");
    expect(tableDue(getRounds()[round.id], KIND, { now: Date.now(), lastTick: Date.now() })).toBeNull();
    expect(tableDue(getRounds()[round.id], KIND, { now: getRounds()[round.id].closesAt })).toBe("hammer");
    expect(tableDue(getRounds()[round.id], KIND, { now: Date.now(), lastTick: Date.now() - 2500 })).toBe("tick");
    await saveRound({ ...getRounds()[round.id], closesAt: Date.now() - 1 });
    expect((await resolveRound(round.id, { ifDue: true })).status).toBe("resolved");
    expect(tableDue(getRounds()[round.id], KIND, { now: Date.now() })).toBeNull();
  });

  it("is brought down by the GM's watch when the gavel runs out", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const { watchTables } = await import("../module/scripts/foundry/table.js");
    const round = await openRound("lot", { windowMs: 20000 });
    await world.deliver(bid(round, "a1", "p1", 10));
    expect(watchTables()).toBe(false);
    await vi.advanceTimersByTimeAsync(21000);
    for (let i = 0; i < 200 && rowsOf(round)[0].status !== "settled"; i++) await tick();
    expect(getRounds()[round.id].status).toBe("resolved");
    expect(world.actors.get("a1").items.size).toBe(1);
  });
});

describe("recovery and calling it off", () => {
  it("refunds an open bid on the GM's load once the gavel and its grace have passed, counting no house bid", async () => {
    await seed(world, { lot: AUCTION({ house: { count: 1, budget: 100, chance: 100 } }) });
    const round = await openRound("lot", { windowMs: 20000 });
    await world.deliver(bid(round, "a1", "p1", 10));
    await tableTick(round.id, { rng: () => 0 });
    await world.deliver(bid(round, "a2", "p2", 20));
    // Inside the grace the load leaves it for the gavel.
    await saveRound({ ...getRounds()[round.id], closesAt: Date.now() - 1000 });
    expect(await recoverRounds()).toEqual({ refunded: 0, gone: 0, voided: 0 });
    // Past it, the load refunds it.
    await saveRound({ ...getRounds()[round.id], closesAt: Date.now() - ROUND_GRACE_MS - 1000 });
    expect(await recoverRounds()).toEqual({ refunded: 1, gone: 0, voided: 1 });
    expect(gp(world.actors.get("a2"))).toBe(100);
    expect(rowsOf(round).find(r => r.actorId === "a2")).toMatchObject({ status: "refunded", refundReason: "stale" });
    expect(getRounds()[round.id]).toMatchObject({ status: "resolved", voided: expect.any(Number) });
    expect(world.notes.warn).toHaveBeenCalledWith("Loot Crates: 1 open stake from a round that never spun was refunded.");
  });

  it("calls it off: every open bid refunded, the round voided, everyone told, no more bids", async () => {
    await seed(world, { lot: AUCTION({ house: { count: 1, budget: 100, chance: 100 } }) });
    const round = await openRound("lot");
    await world.deliver(bid(round, "a1", "p1", 10));
    await tableTick(round.id, { rng: () => 0 });
    await world.deliver(bid(round, "a2", "p2", 20));
    const heard = [];
    const off = onTable(m => heard.push(m));
    expect(await cancelRound(round.id)).toEqual({ status: "cancelled", refunded: 1, gone: 0 });
    off();
    expect(gp(world.actors.get("a1"))).toBe(100);
    expect(gp(world.actors.get("a2"))).toBe(100);
    expect(rowsOf(round).filter(r => r.status === "open")).toEqual([]);
    expect(rowsOf(round).find(r => r.actorId === "a2")).toMatchObject({ refundReason: "cancel" });
    expect(stakeNote(rowsOf(round).find(r => r.actorId === "a2"))).toBe("Refunded: the GM called the round off.");
    expect(heard).toEqual([expect.objectContaining({ type: "round", event: "void", roundIds: [round.id], cancelled: true })]);
    expect(getRounds()[round.id]).toMatchObject({ status: "resolved", cancelled: true });
    await world.deliver(bid(round, "a3", "p3", 30));
    expect(errorsFor(world, "p3")).toEqual(["That round has already been settled."]);
    expect((await resolveRound(round.id)).status).toBe("already");
  });
});

describe("the auction's words and board", () => {
  const rows = [
    { id: "b3", actorId: "a2", actorName: "Bo", price: 25, stake: { amount: 25 }, status: "open", roundId: "R" },
    { id: "b2", actorId: null, actorName: "House bidder 1", price: 0, stake: { amount: 20, house: 1 }, house: true, status: "refunded", refunded: 1, refundReason: "outbid", roundId: "R" },
    { id: "b1", actorId: "a1", actorName: "Ana", price: 15, stake: { amount: 15 }, status: "refunded", refunded: 1, refundReason: "outbid", roundId: "R" },
  ];

  it("count every bid, the beaten ones included, and say who was outbid", () => {
    expect(auction.bidCount(rows)).toBe("3 bids from 3 bidders");
    expect(auction.bidCount([])).toBe("No bids yet");
    expect(auction.bidAnnouncement(rows[0], { outbid: [rows[1]] })).toBe("Bo bids 25 gp, the top bid; House bidder 1 is outbid.");
    expect(auction.bidAnnouncement(rows[1], { outbid: [rows[2]] })).toBe("House bidder 1 bids 20 gp, the top bid; Ana's bid came back.");
  });

  it("draw the board: the top bid and its bidder, the reserve met or not (never its amount), the last five, the gavel's clock", () => {
    const html = auction.boardHTML(AUCTION({ reserve: 30 }), rows.filter(r => r.status === "open"), { history: rows, round: { id: "R", status: "open", closesAt: 123456 }, actorIds: ["a2"] });
    expect(html).toContain("Top bid");
    expect(html).toContain(">25 gp<");
    expect(html).toContain(">Bo<");
    expect(html).toContain("Reserve not met yet");
    expect(html).not.toContain("30 gp");
    expect(html).toContain('data-closes-at="123456"');
    expect(html.match(/<li /g)).toHaveLength(3);
    expect(html).toContain("lc-auction__past--mine");
    const many = Array.from({ length: 8 }, (_, i) => ({ ...rows[2], id: `x${i}` }));
    expect(auction.boardHTML(AUCTION(), [], { history: many }).match(/<li /g)).toHaveLength(5);
    const sold = auction.boardHTML(AUCTION(), [], { outcome: { verdict: "sold", amount: 25, bidder: "Bo", lot: ITEM_LOT, reserveMet: true } });
    expect(sold).toContain("Sold for");
    expect(sold).not.toContain("data-closes-at");
  });

  it("give the player one primary action naming the next legal bid, and the GM the gavel and Call it off", () => {
    const game = AUCTION();
    const round = { id: "R", boxId: "lot", kind: "auction", status: "open", opensAt: Date.now(), closesAt: Date.now() + 15000 };
    const stakes = rows.filter(r => r.status === "open");
    const player = tableBodyHTML({ kind: KIND, game, round, stakes, history: rows, viewer: { isGM: false, actors: [{ id: "a1", name: "Ana" }] } });
    expect(player).toMatch(/<button type="submit" class="lc-table__bet" data-action="placeBet">Bid 30 gp<\/button>/);
    expect(player).toContain('name="amount"');
    expect(player).toContain("3 bids from 3 bidders");
    expect(player).toMatch(/role="timer"[^>]*>The gavel falls in 0:1\d</);
    expect(player).not.toContain("Bring the gavel down");
    const gm = tableBodyHTML({ kind: KIND, game, round, stakes, history: rows, viewer: { isGM: true, actors: [] } });
    expect(gm).toContain(">Bring the gavel down<");
    expect(gm).toContain('data-action="cancelRound">Call it off<');
    // The lot taken off the shelf mid-auction: no bid is offered, in the auction's word.
    const off = tableBodyHTML({ kind: KIND, game: { ...game, rules: { ...(game.rules ?? {}), shelved: false } }, round, stakes, history: rows, viewer: { isGM: false, actors: [{ id: "a1", name: "Ana" }] } });
    expect(off).toMatch(/class="lc-table__bet" data-action="placeBet" aria-disabled="true"/);
    expect(off).toContain(`is off the shelf: no bids until the GM puts it back.</span>`);
  });

  it("refuse a slip before any round trip: under the next legal bid, or outbidding yourself", () => {
    const stakes = rows.filter(r => r.status === "open");
    expect(() => auction.readBid(AUCTION(), { amount: "28", actorId: "a1" }, stakes)).toThrow("Bid at least 30 gp.");
    expect(() => auction.readBid(AUCTION(), { amount: "40", actorId: "a2" }, stakes)).toThrow("Bo already holds the top bid.");
    expect(auction.readBid(AUCTION(), { amount: "40", actorId: "a1" }, stakes)).toEqual({ bet: { amount: 40 }, price: 40 });
    expect(auction.bidLabel(AUCTION(), { stakes, values: { amount: "40" } })).toBe("Bid 40 gp");
    expect(auction.bidLabel(AUCTION(), { stakes, values: { amount: "2" } })).toBe("Bid 30 gp");
  });

  it("show a house bid in the Pull log with no Refund, and a won bid with its note", () => {
    const log = [
      { ...rows[0], kind: "auction", boxId: "lot", boxName: "The Sling", at: 1, status: "settled", name: "Sling +2", note: "Won at the hammer for 25 gp.", payoutCp: 0 },
      { ...rows[1], kind: "auction", boxId: "lot", boxName: "The Sling", at: 0, name: "Bid 20 gp" },
    ];
    const html = logTableHTML({ log, rounds: { R: { id: "R", status: "resolved" } } });
    expect(html).toContain("(house bid)");
    expect(html).toContain("A house bid, outbid: no coins were held.");
    expect(html).toContain("Won at the hammer for 25 gp.");
    expect(html.match(/data-action="refund"/g)).toHaveLength(1);
  });

  it("mount a board whose gavel drains on one transform and whose hammer lands at once under reduced motion", () => {
    const doc = createDocument();
    vi.stubGlobal("document", doc);
    const host = doc.createElement("div");
    doc.body.appendChild(host);
    const ctrl = auction.mountBoard(host, { pockets: { lot: ITEM_LOT } });
    ctrl.rail(auction.boardHTML(AUCTION(), [], { round: { id: "R", status: "open", closesAt: Date.now() + 10000 } }));
    expect(host.querySelector(".lc-gavel__bar").style.transform).toMatch(/^scaleX\(0\.[45]\d*\)$/);
    let landed = 0;
    const spin = ctrl.spin({ reducedMotion: true, onLand: () => landed++ });
    spin.play();
    expect(landed).toBe(1);
    expect(host.classList.contains("lc-table__stage--landed")).toBe(true);
    expect(host.querySelector(".lc-gavel__bar").style.transform).toBe("scaleX(0.0000)");
    vi.unstubAllGlobals();
  });

  it("keep a record's settings in one shape: the opening, the increment, the gavel's floor, the house's bounds", () => {
    expect(auction.openingOf({ price: 0, auction: { increment: 3 } })).toBe(3);
    expect(auction.gavelMsOf({ auction: { gavelSec: 1 } })).toBe(5000);
    expect(auction.houseOf({ auction: { house: { count: 99, budget: -4, chance: 400 } } })).toEqual({ count: 6, budget: 0, chance: 100 });
    expect(auction.lotOf({ auction: { lot: { type: "item" } } })).toBeNull();
    expect(auction.minBid(AUCTION(), [])).toBe(10);
    const draft = auction.draftAuction(AUCTION(), { lot: "crate:crate", price: "12", increment: "2", reserve: "", gavelSec: "30", houseCount: "2", houseBudget: "60", houseChance: "40" }, key => (key === "crate:crate" ? auction.lotFromCrate(CRATE) : null));
    expect(draft).toMatchObject({ price: 12, pools: [], auction: { lot: { type: "crate", boxId: "crate", name: "Adventurer's Crate" }, increment: 2, reserve: 0, gavelSec: 30, house: { count: 2, budget: 60, chance: 40 } } });
    expect(auction.auctionRulesText(draft)).toBe("opens at 12 gp, +2 gp a bid, no reserve, 30 s gavel, 2 house bidders up to 60 gp");
  });
});

describe("the auction's chat card", () => {
  const card = getKind("auction").chat.card;
  const esc = s => String(s ?? "");
  const itemLink = (uuid, name) => `<a data-uuid="${uuid}">${name}</a>`;
  it("names the item won with its link to the sheet, its rarity and the verdict, once", () => {
    const outcome = { verdict: "sold", lot: { type: "item", uuid: "Item.sling", name: "Sling +2", img: "sling.webp", rarity: "uncommon" }, amount: 15, leaderId: "r1", bidder: "Ana", actorId: "a1", bids: 3, result: { uuid: "Item.sling", name: "Sling +2", img: "sling.webp", rarity: "uncommon" } };
    const html = card({ box: { name: "The Sling" }, outcome, stakes: [{ logId: "r1", actorId: "a1", action: "settle", itemId: "it1" }] }, { esc, itemLink });
    expect(html).toContain('<a data-uuid="Actor.a1.Item.it1">Sling +2</a>');
    expect(html).toContain('<div class="lc-chat__rarity">Uncommon</div>');
    expect(html).toContain("Sold to Ana for 15 gp.");
    expect(html).toContain("3 bids");
    expect(html.match(/Sling \+2/g)).toHaveLength(1);
  });
  it("says no sale for a house win, with nothing linked", () => {
    const html = card({ box: { name: "The Sling" }, outcome: { verdict: "house", lot: ITEM_LOT, amount: 20, bidder: "House bidder 1", bids: 2 }, stakes: [] }, { esc, itemLink });
    expect(html).toContain('<div class="lc-chat__name">No sale</div>');
    expect(html).toContain("The house took it at 20 gp.");
    expect(html).not.toContain("data-uuid");
  });
});
