/*
  The table round on the core, with a stub table kind: stakes are open log
  rows charged once each in the queue, one resolve settles or refunds every
  stake through settle(), a second resolve does nothing, the GM's load
  refunds what a stale round left, the guards run again at the resolve,
  and an open stake refunds through the existing Refund.
*/
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";

vi.mock("../module/scripts/reveal.js", () => ({ showReveal: vi.fn(async () => ({ landed: Promise.resolve() })), showRound: vi.fn(() => ({ landed: Promise.resolve(), instant: true })) }));
vi.mock("../module/scripts/chat.js", () => ({ postPullCard: vi.fn(async () => null) }));

const { registerSocket, requestStake } = await import("../module/scripts/socket.js");
const { registerSettings, getLog, getRounds, enqueueWrite } = await import("../module/scripts/store.js");
const { openRound, closeRound, resolveRound, recoverRounds, onTable } = await import("../module/scripts/table.js");
const { refundPull, describeRefund } = await import("../module/scripts/refund.js");
const { performPull, PullError } = await import("../module/scripts/pull.js");
const { registerKind, kindIds, _resetKinds } = await import("../module/scripts/kinds.js");
const { rowStatus, stakesOf, staleStakes, groupRounds, roundLine, stakeNote, ROUND_WINDOW_MS } = await import("../module/scripts/round.js");
const { showRound } = await import("../module/scripts/reveal.js");
const { toCopper } = await import("../module/scripts/currency.js");

const tick = () => new Promise(r => setTimeout(r, 0));
const BUILT_IN = kindIds();

// A table kind that proves the contract: bet on "red" or "black", a 1:1
// payout (stake back and as much again), the outcome fixed by the test.
let nextOutcome = "red";
const STUB = registerKind({
  id: "stubtable",
  noun: "table",
  table: true,
  priceOf: ({ game, bet }) => (bet?.amount != null ? bet.amount : game.price),
  stake: ({ bet, stakes }) => {
    if (bet?.colour === "auction") {
      // The Auction's shape: one open stake per lot, the best bid displaces the last.
      return { label: "Bid", outbid: stakes.filter(r => r.status === "open").map(r => r.id) };
    }
    if (!["red", "black"].includes(bet?.colour)) throw new PullError("Pick red or black.");
    return { label: bet.colour === "red" ? "Red" : "Black", colour: bet.colour };
  },
  roll: vi.fn(async () => ({ outcome: nextOutcome, ball: 7 })),
  settle: ({ outcome, row }) => (row.stake?.colour === outcome
    ? { payoutCp: Math.round(row.price * 100) * 2, name: `Won on ${outcome}` }
    : { payoutCp: 0, name: `Lost on ${row.stake?.colour}` }),
});

const GM = { id: "gm", name: "Gamemaster" };
const USERS = [GM, { id: "p1", name: "Ana" }, { id: "p2", name: "Bo" }, { id: "p3", name: "Cy" }];

function makeActor(id, owner, gp = 100) {
  const actor = {
    id, name: `Char ${id}`, owners: new Set([owner, "gm"]),
    system: { currency: { pp: 0, gp, ep: 0, sp: 0, cp: 0 } },
    items: { get: () => null },
    updates: 0,
    testUserPermission(user) { return actor.owners.has(user?.id); },
    async update(data) {
      await tick();
      actor.updates++;
      if (data["system.currency"]) actor.system.currency = data["system.currency"];
    },
  };
  return actor;
}

function makeWorld() {
  const settings = new Map();
  const writes = [];
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
      async set(ns, key, value) { await tick(); writes.push(key); settings.set(`${ns}.${key}`, value); },
    },
    socket: { on: (_n, fn) => handlers.push(fn), emit: (_n, msg) => emitted.push(msg) },
  };
  globalThis.game = game;
  globalThis.ui = { notifications: notes };
  globalThis.foundry = { utils: { randomID: n => Math.random().toString(36).slice(2, 2 + n), deepClone: v => structuredClone(v), escapeHTML: s => String(s) } };
  registerSettings();
  registerSocket();
  const deliver = msg => Promise.all(handlers.map(h => h(msg)));
  return { game, actors, emitted, deliver, writes, notes, settings };
}

const TABLE = { id: "wheel", name: "Wheel", kind: "stubtable", price: 10, pools: [] };

async function seed(world, boxes = { wheel: TABLE }) {
  await world.game.settings.set("loot-crates", "boxes", boxes);
}

// A player's stake as the GM's socket hears it.
const stakeMsg = (round, actorId, userId, colour = "red", extra = {}) => ({ type: "stake", requestId: `r-${actorId}-${Math.random()}`, boxId: "wheel", roundId: round.id, actorId, userId, price: 10, bet: { colour }, ...extra });
const gp = actor => toCopper(actor.system.currency) / 100;

let world;
beforeEach(async () => {
  world = makeWorld();
  await seed(world);
  nextOutcome = "red";
  STUB.roll.mockClear();
  showRound.mockClear();
});

afterAll(() => _resetKinds(BUILT_IN));

afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.game;
  delete globalThis.ui;
  delete globalThis.foundry;
});

async function threeStakes() {
  const round = await openRound("wheel");
  await world.deliver(stakeMsg(round, "a1", "p1", "red"));
  await world.deliver(stakeMsg(round, "a2", "p2", "black"));
  await world.deliver(stakeMsg(round, "a3", "p3", "red"));
  return round;
}

describe("a table round's stakes", () => {
  it("writes three open rows and charges each character once", async () => {
    const round = await threeStakes();
    const log = getLog();
    expect(log).toHaveLength(3);
    for (const r of log) expect(r).toMatchObject({ status: "open", roundId: round.id, kind: "stubtable", price: 10, payoutCp: 0, itemId: null });
    expect(log.map(r => r.name).sort()).toEqual(["Black", "Red", "Red"]);
    for (const a of world.actors.values()) {
      expect(a.updates).toBe(1);
      expect(gp(a)).toBe(90);
    }
    const staked = world.emitted.filter(m => m.type === "staked");
    expect(staked.map(m => m.actorId)).toEqual(["a1", "a2", "a3"]);
    expect(stakesOf(getLog(), round.id)).toHaveLength(3);
  });

  it("refuses a stake on a closed round, a bad bet, or a character the user doesn't own, charging nothing", async () => {
    const round = await openRound("wheel");
    await world.deliver(stakeMsg(round, "a1", "p1", "green"));
    await world.deliver(stakeMsg(round, "a2", "p1", "red"));
    await closeRound(round.id);
    await world.deliver(stakeMsg(round, "a3", "p3", "red"));
    const errors = world.emitted.filter(m => m.type === "error").map(m => m.message);
    expect(errors).toEqual(["Pick red or black.", "You don't own that character.", "Bets are closed for this round."]);
    expect(getLog()).toHaveLength(0);
    for (const a of world.actors.values()) expect(gp(a)).toBe(100);
  });

  it("refuses a stake past the round's clock", async () => {
    const round = await openRound("wheel", { windowMs: 1000 });
    vi.spyOn(Date, "now").mockReturnValue(round.opensAt + 1000);
    await world.deliver(stakeMsg(round, "a1", "p1", "red"));
    expect(world.emitted.find(m => m.type === "error")?.message).toBe("Bets are closed for this round.");
    expect(gp(world.actors.get("a1"))).toBe(100);
  });

  it("opens one round per game at a time", async () => {
    const a = await openRound("wheel");
    const b = await openRound("wheel");
    expect(b.id).toBe(a.id);
    expect(Object.keys(getRounds())).toEqual([a.id]);
  });

  it("is staked, never pulled", async () => {
    const actor = world.actors.get("a1");
    await expect(performPull({ box: TABLE, pools: {}, actor })).rejects.toThrow("played at the table");
    expect(actor.updates).toBe(0);
  });

  it("refunds a displaced stake in the same task (the Auction's outbid)", async () => {
    const round = await openRound("wheel");
    await world.deliver(stakeMsg(round, "a1", "p1", "auction", { price: 10 }));
    await world.deliver(stakeMsg(round, "a2", "p2", "auction", { price: 20, bet: { colour: "auction", amount: 20 } }));
    const [top, first] = getLog();
    expect(top).toMatchObject({ actorId: "a2", status: "open", price: 20 });
    expect(rowStatus(first)).toBe("refunded");
    expect(first.refundReason).toBe("outbid");
    expect(gp(world.actors.get("a1"))).toBe(100);
    expect(gp(world.actors.get("a2"))).toBe(80);
    expect(world.emitted.filter(m => m.type === "staked").at(-1).outbid).toEqual([first.id]);
  });

  it("resolves a player's requestStake on the GM's staked broadcast", async () => {
    world.game.user = USERS[1];
    const handlers = [];
    world.game.socket.on = (_n, fn) => handlers.push(fn);
    registerSocket();
    const promise = requestStake({ boxId: "wheel", roundId: "r1", actorId: "a1", price: 10, bet: { colour: "red" } });
    const sent = world.emitted.at(-1);
    expect(sent).toMatchObject({ type: "stake", roundId: "r1", actorId: "a1", userId: "p1", price: 10, bet: { colour: "red" } });
    const heard = vi.fn();
    const stop = onTable(heard);
    const staked = { type: "staked", requestId: sent.requestId, userId: "p1", roundId: "r1", logId: "x" };
    await Promise.all(handlers.map(h => h(staked)));
    await expect(promise).resolves.toBe(staked);
    expect(heard).toHaveBeenCalledWith(staked);
    stop();
  });
});

describe("a table round's resolve", () => {
  it("settles every open stake in one task, one log write, with payouts through settle()", async () => {
    const round = await threeStakes();
    world.writes.length = 0;
    const out = await resolveRound(round.id);
    expect(out.status).toBe("resolved");
    expect(STUB.roll).toHaveBeenCalledOnce();
    expect(world.writes.filter(k => k === "pullLog")).toHaveLength(1);
    expect(gp(world.actors.get("a1"))).toBe(110);
    expect(gp(world.actors.get("a2"))).toBe(90);
    expect(gp(world.actors.get("a3"))).toBe(110);
    // The loser's purse isn't written again.
    expect(world.actors.get("a2").updates).toBe(1);
    const byActor = Object.fromEntries(getLog().map(r => [r.actorId, r]));
    expect(byActor.a1).toMatchObject({ status: "settled", payoutCp: 2000, name: "Won on red" });
    expect(byActor.a2).toMatchObject({ status: "settled", payoutCp: 0, name: "Lost on black" });
    expect(getRounds()[round.id]).toMatchObject({ status: "resolved", outcome: "red" });
    const reveals = world.emitted.filter(m => m.type === "round" && m.event === "resolve");
    expect(reveals).toHaveLength(1);
    expect(reveals[0]).toMatchObject({ roundId: round.id, outcome: "red", ball: 7 });
    expect(reveals[0].stakes.map(s => [s.actorId, s.action, s.payoutCp]).sort()).toEqual([["a1", "settle", 2000], ["a2", "settle", 0], ["a3", "settle", 2000]]);
    expect(showRound).toHaveBeenCalledOnce();
  });

  it("does nothing the second time", async () => {
    const round = await threeStakes();
    await resolveRound(round.id);
    const before = [...world.actors.values()].map(gp);
    const emits = world.emitted.length;
    const again = await resolveRound(round.id);
    expect(again.status).toBe("already");
    expect([...world.actors.values()].map(gp)).toEqual(before);
    expect(world.emitted.length).toBe(emits);
    expect(STUB.roll).toHaveBeenCalledOnce();
  });

  it("takes no stake once the round is resolved", async () => {
    const round = await threeStakes();
    await resolveRound(round.id);
    await world.deliver(stakeMsg(round, "a1", "p1", "red"));
    expect(world.emitted.at(-1)).toMatchObject({ type: "error", message: "That round has already been settled." });
  });

  it("refunds, not pays, a stake whose character changed hands, and closes one whose character is gone", async () => {
    const round = await threeStakes();
    world.actors.get("a1").owners.delete("p1");
    world.actors.delete("a3");
    await resolveRound(round.id);
    expect(gp(world.actors.get("a1"))).toBe(100);
    const byActor = Object.fromEntries(getLog().map(r => [r.actorId, r]));
    expect(byActor.a1).toMatchObject({ status: "refunded", refundReason: "owner", payoutCp: 0 });
    expect(byActor.a3).toMatchObject({ status: "refunded", refundReason: "gone", payoutCp: 0 });
    expect(byActor.a2.status).toBe("settled");
    expect(world.notes.warn).toHaveBeenCalledWith(expect.stringContaining("1 stake was refunded, not paid"));
    // Nothing is left open: every coin taken has gone somewhere.
    expect(getLog().filter(r => rowStatus(r) === "open")).toHaveLength(0);
  });

  it("writes nothing when the roll throws", async () => {
    const round = await threeStakes();
    STUB.roll.mockRejectedValueOnce(new PullError("The wheel stuck."));
    await expect(resolveRound(round.id)).rejects.toThrow("The wheel stuck.");
    expect(getRounds()[round.id].status).toBe("open");
    expect(getLog().every(r => r.status === "open")).toBe(true);
    expect((await resolveRound(round.id)).status).toBe("resolved");
  });

  it("refunds every stake when the game was deleted before the spin", async () => {
    const round = await threeStakes();
    await world.game.settings.set("loot-crates", "boxes", {});
    await resolveRound(round.id);
    for (const a of world.actors.values()) expect(gp(a)).toBe(100);
    expect(getLog().every(r => r.refundReason === "game")).toBe(true);
    expect(STUB.roll).not.toHaveBeenCalled();
  });
});

describe("refunding an open stake", () => {
  it("returns the stake, the round stops counting it, and the spin passes it by", async () => {
    const round = await threeStakes();
    const row = getLog().find(r => r.actorId === "a1");
    expect(describeRefund(row.id)).toMatchObject({ status: "ready", coins: 1000 });
    await refundPull(row.id);
    expect(gp(world.actors.get("a1"))).toBe(100);
    expect(rowStatus(getLog().find(r => r.id === row.id))).toBe("refunded");
    expect(stakesOf(getLog(), round.id).map(r => r.actorId).sort()).toEqual(["a2", "a3"]);
    await resolveRound(round.id);
    expect(gp(world.actors.get("a1"))).toBe(100);
    expect(world.emitted.find(m => m.event === "resolve").stakes).toHaveLength(2);
  });

  it("takes the winnings back after the spin, payout-aware", async () => {
    const round = await threeStakes();
    await resolveRound(round.id);
    const row = getLog().find(r => r.actorId === "a1");
    await refundPull(row.id);
    expect(gp(world.actors.get("a1"))).toBe(100);
  });
});

describe("the GM's load", () => {
  it("refunds open stakes past the window, voids the round and says how many", async () => {
    const round = await threeStakes();
    vi.spyOn(Date, "now").mockReturnValue(round.opensAt + ROUND_WINDOW_MS + 1);
    world.actors.delete("a3");
    const out = await recoverRounds();
    expect(out).toEqual({ refunded: 2, gone: 1, voided: 1 });
    expect(gp(world.actors.get("a1"))).toBe(100);
    expect(gp(world.actors.get("a2"))).toBe(100);
    expect(getLog().filter(r => rowStatus(r) === "open")).toHaveLength(0);
    expect(getLog().every(r => ["stale", "gone"].includes(r.refundReason))).toBe(true);
    expect(world.notes.warn).toHaveBeenCalledWith("Loot Crates: 3 open stakes from a round that never spun: 2 refunded, 1 belonged to a character that is gone.");
    expect(getRounds()[round.id]).toMatchObject({ status: "resolved", voided: expect.any(Number) });
    // A voided round never spins and pays.
    expect((await resolveRound(round.id)).status).toBe("already");
    expect(gp(world.actors.get("a1"))).toBe(100);
  });

  it("leaves a round inside its window for its spin", async () => {
    const round = await threeStakes();
    vi.spyOn(Date, "now").mockReturnValue(round.opensAt + ROUND_WINDOW_MS - 1);
    expect(await recoverRounds()).toEqual({ refunded: 0, gone: 0, voided: 0 });
    expect(getLog().filter(r => rowStatus(r) === "open")).toHaveLength(3);
    expect(world.notes.warn).not.toHaveBeenCalled();
  });

  it("refunds open rows whose round record is gone", async () => {
    const round = await threeStakes();
    await world.game.settings.set("loot-crates", "tableRounds", {});
    const out = await recoverRounds();
    expect(out.refunded).toBe(3);
    for (const a of world.actors.values()) expect(gp(a)).toBe(100);
    expect(world.notes.warn).toHaveBeenCalledWith("Loot Crates: 3 open stakes from a round that never spun were refunded.");
    expect(round.id).toBeTruthy();
  });

  it("runs in the write queue, after a stake already in it", async () => {
    const round = await openRound("wheel");
    const staking = world.deliver(stakeMsg(round, "a1", "p1", "red"));
    vi.spyOn(Date, "now").mockReturnValue(round.opensAt + ROUND_WINDOW_MS + 1);
    await Promise.all([staking, recoverRounds()]);
    await enqueueWrite(() => null);
    expect(gp(world.actors.get("a1"))).toBe(100);
  });
});

describe("rows and the log", () => {
  it("reads an old row without a status as settled", () => {
    expect(rowStatus({ id: "x", price: 10 })).toBe("settled");
    expect(rowStatus({ id: "x", refunded: 1 })).toBe("refunded");
    expect(rowStatus({ id: "x", status: "open" })).toBe("open");
    expect(staleStakes([{ id: "x", price: 10 }], {}, Date.now())).toEqual([]);
  });

  it("folds a round's rows under the round in the Pull log", () => {
    const rows = [
      { id: "s2", roundId: "R", boxName: "Wheel", status: "open", price: 10, at: 3 },
      { id: "p", boxName: "Crate", at: 2 },
      { id: "s1", roundId: "R", boxName: "Wheel", status: "settled", price: 5, at: 1 },
      { id: "s0", roundId: "R", boxName: "Wheel", status: "refunded", refunded: 1, price: 20, at: 0 },
    ];
    const items = groupRounds(rows.map(row => ({ row })), { R: { status: "open" } });
    expect(items.map(x => (x.round ? `round:${x.rows.length}` : x.row.id))).toEqual(["round:3", "p"]);
    expect(items[0]).toMatchObject({ open: 1, staked: 15 });
    expect(roundLine(items[0])).toBe("2 stakes, 1 waiting on the spin");
    expect(roundLine({ ...items[0], open: 0, status: "resolved" })).toBe("2 stakes, settled");
  });

  it("says on the row what happened to a stake's coins", () => {
    expect(stakeNote({ id: "x" })).toBe("");
    expect(stakeNote({ roundId: "R", status: "open" })).toBe("Open: waiting on the spin.");
    expect(stakeNote({ roundId: "R", refunded: 1, refundReason: "owner" })).toBe("Refunded at the spin: the character changed hands.");
  });
});
