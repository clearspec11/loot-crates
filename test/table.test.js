/*
  The table round on the core, with a stub table kind: stakes are open log
  rows charged once each in the queue, one resolve settles or refunds every
  stake through settle(), a second resolve does nothing, the GM's load
  refunds what a stale round left, the guards run again at the resolve,
  and an open stake refunds through the existing Refund.
*/
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";

vi.mock("../module/scripts/reveal.js", () => ({ showReveal: vi.fn(async () => ({ landed: Promise.resolve() })), showRound: vi.fn(() => ({ landed: Promise.resolve(), instant: true })), boxHeld: vi.fn(() => false) }));
vi.mock("../module/scripts/chat.js", () => ({ postPullCard: vi.fn(async () => null) }));

const { registerSocket, requestStake } = await import("../module/scripts/socket.js");
const { registerSettings, getLog, getRounds, enqueueWrite } = await import("../module/scripts/store.js");
const { openRound, closeRound, resolveRound, recoverRounds, refundOrphanRounds, onTable, watchStale, stopStaleWatch, STALE_SLACK_MS } = await import("../module/scripts/table.js");
const { refundPull, describeRefund } = await import("../module/scripts/refund.js");
const { performPull, PullError } = await import("../module/scripts/pull.js");
const { registerKind, kindIds, _resetKinds } = await import("../module/scripts/kinds.js");
const { rowStatus, stakesOf, staleStakes, staleAt, nextStaleAt, groupRounds, roundLine, stakeNote, orphanRounds, heldBy, ROUND_WINDOW_MS, ROUND_GRACE_MS } = await import("../module/scripts/round.js");
const { showRound, boxHeld } = await import("../module/scripts/reveal.js");
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
  boxHeld.mockReset();
  boxHeld.mockReturnValue(false);
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

describe("a table game off the shelf (shelf.js)", () => {
  it("opens no round, and writes nothing", async () => {
    await seed(world, { wheel: { ...TABLE, rules: { shelved: false } } });
    await expect(openRound("wheel")).rejects.toThrow("Wheel is off the shelf. Put it on the shelf to open a round.");
    expect(getRounds()).toEqual({});
  });

  it("refuses a stake on a round opened before it went off the shelf, charging nothing; the round still resolves", async () => {
    const round = await openRound("wheel");
    await world.deliver(stakeMsg(round, "a1", "p1", "red"));
    await seed(world, { wheel: { ...TABLE, rules: { shelved: false } } });
    await world.deliver(stakeMsg(round, "a2", "p2", "red"));
    expect(world.emitted.find(m => m.type === "error")?.message).toBe("Wheel is no longer on the shelf. Nothing was charged.");
    expect(gp(world.actors.get("a2"))).toBe(100);
    expect(world.actors.get("a2").updates).toBe(0);
    expect(getLog()).toHaveLength(1);
    // The stake already down is settled by the round's one resolve.
    await closeRound(round.id);
    await resolveRound(round.id);
    expect(gp(world.actors.get("a1"))).toBe(110);
  });
});

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

  it("refuses to open the next round while the last one still plays on the GM's screen, writing nothing", async () => {
    const first = await openRound("wheel");
    await closeRound(first.id);
    await resolveRound(first.id);
    const rounds = getRounds();
    boxHeld.mockImplementation(id => id === "wheel");
    await expect(openRound("wheel")).rejects.toThrow("The last round at Wheel is still playing. Open the next one once it lands.");
    expect(getRounds()).toEqual(rounds);
    expect(world.emitted.filter(m => m.event === "open")).toHaveLength(1);
    // Landed: the next round opens.
    boxHeld.mockImplementation(() => false);
    const next = await openRound("wheel");
    expect(next.id).not.toBe(first.id);
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

  // The log write that closes the stakes fails after the round was marked
  // resolved: nothing was paid, so the round goes back to closed and Spin
  // works again, rather than the table sitting at "waiting" until a reload.
  it("rolls the round back to closed when its stakes can't be closed, so Spin can try again", async () => {
    const round = await threeStakes();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const set = world.game.settings.set;
    let failLog = true;
    world.game.settings.set = async (ns, key, value) => {
      if (key === "pullLog" && failLog) { failLog = false; throw new Error("disk full"); }
      return set.call(world.game.settings, ns, key, value);
    };
    await expect(resolveRound(round.id)).rejects.toThrow("The spin at Wheel failed and nothing was paid: press Spin to try again.");
    expect(getRounds()[round.id]).toMatchObject({ status: "closed", closedAt: expect.any(Number) });
    expect(getRounds()[round.id].resolvedAt).toBeUndefined();
    expect(getLog().every(r => r.status === "open")).toBe(true);
    for (const a of world.actors.values()) expect(gp(a)).toBe(90);
    expect(world.emitted.filter(m => m.event === "resolve" || m.event === "void")).toHaveLength(0);
    expect(showRound).not.toHaveBeenCalled();
    // A second Spin rolls and pays, once.
    const again = await resolveRound(round.id);
    expect(again.status).toBe("resolved");
    expect([...world.actors.values()].map(gp)).toEqual([110, 90, 110]);
    expect(world.emitted.filter(m => m.event === "resolve")).toHaveLength(1);
    error.mockRestore();
  });

  it("calls the round off on every client when the rollback fails too, and the GM's next load refunds it", async () => {
    const round = await threeStakes();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const set = world.game.settings.set;
    let roundWrites = 0;
    world.game.settings.set = async (ns, key, value) => {
      if (key === "pullLog") throw new Error("disk full");
      if (key === "tableRounds" && ++roundWrites > 1) throw new Error("disk full");
      return set.call(world.game.settings, ns, key, value);
    };
    await expect(resolveRound(round.id)).rejects.toThrow("The spin at Wheel failed and couldn't be undone: every stake is refunded when you reload Foundry.");
    // Marked resolved, so it can't pay twice; every client hears the void.
    expect(getRounds()[round.id].status).toBe("resolved");
    expect(world.emitted.filter(m => m.type === "round" && m.event === "void")).toEqual([{ type: "round", event: "void", roundIds: [round.id], refunded: [], onReload: true }]);
    expect((await resolveRound(round.id)).status).toBe("already");
    for (const a of world.actors.values()) expect(gp(a)).toBe(90);
    // The GM reloads: the resolved round's open rows are refunded at once.
    world.game.settings.set = set;
    const out = await recoverRounds();
    expect(out.refunded).toBe(3);
    for (const a of world.actors.values()) expect(gp(a)).toBe(100);
    expect(getLog().every(r => r.refundReason === "stale")).toBe(true);
    error.mockRestore();
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

/*
  While the GM stays (table.js watchStale): one timer at the next round to
  go stale (round.js nextStaleAt) runs the load's recovery, so a stale
  round's stakes come back without a reload, once.
*/
describe("the GM's timer for a stale round", () => {
  afterEach(() => stopStaleWatch());
  const wait = ms => new Promise(r => setTimeout(r, ms));

  it("refunds a round left unspun once it goes stale, once, and arms nothing after", async () => {
    const round = await threeStakes();
    const staleMoment = round.opensAt + ROUND_WINDOW_MS;
    expect(nextStaleAt(getRounds())).toBe(staleMoment);
    const clock = vi.spyOn(Date, "now").mockReturnValue(staleMoment - 40);
    expect(watchStale()).toBe(40 + STALE_SLACK_MS);
    await wait(100);
    expect(getLog().filter(r => rowStatus(r) === "open")).toHaveLength(3);
    clock.mockReturnValue(staleMoment + 1);
    await wait(40 + STALE_SLACK_MS + 100);
    expect(getLog().filter(r => rowStatus(r) === "open")).toHaveLength(0);
    for (const a of world.actors.values()) expect(gp(a)).toBe(100);
    expect(getLog().every(r => r.refundReason === "stale")).toBe(true);
    expect(getRounds()[round.id]).toMatchObject({ status: "resolved", voided: expect.any(Number) });
    expect(world.notes.warn).toHaveBeenCalledTimes(1);
    expect(world.notes.warn).toHaveBeenCalledWith("Loot Crates: 3 open stakes from a round that never spun were refunded.");
    // Nothing left to wait for: armed again, it arms nothing and refunds nothing more.
    expect(watchStale()).toBeNull();
    await wait(STALE_SLACK_MS + 50);
    expect(world.notes.warn).toHaveBeenCalledTimes(1);
  });

  it("re-arms on each call for the soonest round, waiting the whole way for one far off", async () => {
    const round = await openRound("wheel");
    vi.spyOn(Date, "now").mockReturnValue(round.opensAt);
    expect(watchStale()).toBe(ROUND_WINDOW_MS + STALE_SLACK_MS);
    // Closed by the GM: the grace runs from the close.
    const closed = await closeRound(round.id);
    expect(watchStale()).toBe(closed.closedAt + ROUND_GRACE_MS - round.opensAt + STALE_SLACK_MS);
  });

  it("arms nothing on a client that isn't the active GM, or with no round open", async () => {
    expect(watchStale()).toBeNull();
    await openRound("wheel");
    world.game.users.activeGM = { id: "other-gm" };
    expect(watchStale()).toBeNull();
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

  // A short clock doesn't make a short grace: a GM who reloads a minute
  // after a 10-second round closed still gets to spin it.
  it("keeps a timed round for ROUND_GRACE_MS after its clock runs out, then refunds it", async () => {
    const round = await openRound("wheel", { windowMs: 10000 });
    await world.deliver(stakeMsg(round, "a1", "p1", "red"));
    expect(ROUND_GRACE_MS).toBe(10 * 60 * 1000);
    expect(staleAt(getRounds()[round.id])).toBe(round.closesAt + ROUND_GRACE_MS);
    const clock = vi.spyOn(Date, "now").mockReturnValue(round.closesAt + 60000);
    expect(await recoverRounds()).toEqual({ refunded: 0, gone: 0, voided: 0 });
    expect(gp(world.actors.get("a1"))).toBe(90);
    clock.mockReturnValue(round.closesAt + ROUND_GRACE_MS);
    expect(await recoverRounds()).toEqual({ refunded: 1, gone: 0, voided: 1 });
    expect(gp(world.actors.get("a1"))).toBe(100);
  });

  it("counts the grace from whichever came first, the GM's close or the clock", async () => {
    const round = await openRound("wheel", { windowMs: 60000 });
    const closed = await closeRound(round.id);
    expect(closed.closedAt).toBeLessThan(round.closesAt);
    expect(staleAt(closed)).toBe(closed.closedAt + ROUND_GRACE_MS);
    expect(staleAt({ ...closed, closedAt: round.closesAt + 5000 })).toBe(round.closesAt + ROUND_GRACE_MS);
    // A round with no clock: the window from its opening while open, the grace once closed.
    expect(staleAt({ status: "open", opensAt: 1000, closesAt: null })).toBe(1000 + ROUND_WINDOW_MS);
    expect(staleAt({ status: "closed", opensAt: 1000, closesAt: null, closedAt: 5000 })).toBe(5000 + ROUND_GRACE_MS);
    expect(staleAt({ status: "resolved", resolvedAt: 7 })).toBe(7);
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

/*
  A game deleted with its round open (P13): the round is called off and
  every stake comes back at once, on the active GM, not after a reload
  late enough for the round to be stale. orphanRounds decides which rounds
  have lost their game; refundOrphanRounds (heard on every change of the
  boxes) calls each off through cancelRound and says so once.
*/
describe("a round whose game is deleted", () => {
  it("orphanRounds names only unresolved rounds whose game is gone", () => {
    const rounds = {
      a: { id: "a", boxId: "gone", status: "open" },
      b: { id: "b", boxId: "gone", status: "closed" },
      c: { id: "c", boxId: "gone", status: "resolved" },
      d: { id: "d", boxId: "wheel", status: "open" },
      e: null,
    };
    expect(orphanRounds(rounds, { wheel: TABLE }).map(r => r.id)).toEqual(["a", "b"]);
    expect(orphanRounds(rounds, { wheel: TABLE, gone: { id: "gone" } })).toEqual([]);
    expect(orphanRounds({}, {})).toEqual([]);
    expect(orphanRounds(undefined, undefined)).toEqual([]);
  });

  it("heldBy counts a round's open stakes and their gold, not a house bid or a refunded one", () => {
    const log = [
      { id: "1", roundId: "R", status: "open", price: 10 },
      { id: "2", roundId: "R", status: "open", price: 25.5 },
      { id: "3", roundId: "R", status: "open", price: 0, house: true },
      { id: "4", roundId: "R", status: "open", price: 40, refunded: 1 },
      { id: "5", roundId: "R", status: "settled", price: 5 },
      { id: "6", roundId: "S", status: "open", price: 7 },
    ];
    expect(heldBy(log, "R")).toEqual({ count: 2, gp: 35.5 });
    expect(heldBy([], "R")).toEqual({ count: 0, gp: 0 });
  });

  it("refunds every stake at once when the game goes, voids the round and tells the GM once", async () => {
    const round = await threeStakes();
    world.actors.delete("a3");
    await seed(world, {});
    const out = await refundOrphanRounds();
    expect(out).toEqual([{ roundId: round.id, name: "Wheel", status: "cancelled", refunded: 2, gone: 1 }]);
    expect(gp(world.actors.get("a1"))).toBe(100);
    expect(gp(world.actors.get("a2"))).toBe(100);
    expect(getLog().filter(r => rowStatus(r) === "open")).toHaveLength(0);
    expect(getRounds()[round.id]).toMatchObject({ status: "resolved", voided: expect.any(Number), cancelled: true });
    expect(world.emitted.find(m => m.event === "void")).toMatchObject({ roundIds: [round.id], cancelled: true });
    expect(world.notes.warn).toHaveBeenCalledTimes(1);
    expect(world.notes.warn).toHaveBeenCalledWith("Loot Crates: Wheel was deleted with its round open; 2 stakes were refunded; 1 belonged to a character that is gone.");
    // Heard again (another change of the boxes): nothing more moves or is said.
    expect(await refundOrphanRounds()).toEqual([]);
    expect(gp(world.actors.get("a1"))).toBe(100);
    expect(world.notes.warn).toHaveBeenCalledTimes(1);
    // The voided round never spins and pays.
    expect((await resolveRound(round.id)).status).toBe("already");
  });

  it("leaves a round whose game is still there, and does nothing on a client that isn't the active GM", async () => {
    const round = await threeStakes();
    expect(await refundOrphanRounds()).toEqual([]);
    await seed(world, {});
    world.game.users.activeGM = { id: "other-gm" };
    expect(await refundOrphanRounds()).toEqual([]);
    expect(getLog().filter(r => rowStatus(r) === "open")).toHaveLength(3);
    expect(getRounds()[round.id].status).toBe("open");
  });

  it("calls off a round with no stakes yet without a word", async () => {
    const round = await openRound("wheel");
    await seed(world, {});
    const out = await refundOrphanRounds();
    expect(out).toEqual([{ roundId: round.id, name: "A deleted game", status: "cancelled", refunded: 0, gone: 0 }]);
    expect(world.notes.warn).not.toHaveBeenCalled();
    expect(getRounds()[round.id].status).toBe("resolved");
  });
});
