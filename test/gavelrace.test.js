/*
  Two GMs and one gavel (table.js resolveRound). Foundry's active GM is the
  lowest-id active GM, so a second GM joining mid-resolve becomes the
  active one while the first GM's resolve is still rolling, and the write
  queue is each client's own. Two GM clients here, each with its own copy
  of the module (its own queue and watch) and its own view of who the
  active GM is, share one world: its settings, its characters and its
  socket. However the two interleave, an auction's gavel settles once, and
  its house bidder bids once a turn (table.js tableTick).
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import en from "../module/lang/en.json";

vi.mock("../module/scripts/foundry/reveal.js", () => ({ showReveal: vi.fn(async () => ({ landed: Promise.resolve() })), showRound: vi.fn(() => ({ landed: Promise.resolve(), instant: true })), boxHeld: vi.fn(() => false) }));
vi.mock("../module/scripts/foundry/chat.js", () => ({ postPullCard: vi.fn(async () => null) }));

const tick = () => new Promise(r => setTimeout(r, 0));

// Each client's own `game`, carried through every await of a call made on it.
const client = new AsyncLocalStorage();
const as = (game, fn) => client.run(game, fn);

// One copy of the module per client, as each browser loads its own.
async function loadClient() {
  vi.resetModules();
  const { setStrings } = await import("../module/scripts/core/i18n.js");
  setStrings(en);
  await import("../module/scripts/games/auction.js");
  return {
    store: await import("../module/scripts/foundry/store.js"),
    socket: await import("../module/scripts/foundry/socket.js"),
    table: await import("../module/scripts/foundry/table.js"),
  };
}

// The first GM, and a second one with a lower id: Foundry makes them the active GM once they join.
const GM1 = { id: "gm1", name: "First GM" };
const GM0 = { id: "gm0", name: "Second GM" };
const USERS = [GM1, GM0, { id: "p1", name: "Ana" }];

const SOURCES = {
  "Item.sling": { name: "Sling +2", img: "sling.webp", uuid: "Item.sling", toObject: () => ({ _id: "x", name: "Sling +2", type: "weapon", system: { rarity: "uncommon" } }) },
};

function makeActor(id, owner, gp = 100) {
  const items = new Map();
  const actor = {
    id, name: `Char ${id}`, owners: new Set([owner, GM1.id, GM0.id]),
    system: { currency: { pp: 0, gp, ep: 0, sp: 0, cp: 0 } },
    items: { get: i => items.get(i) ?? null, get size() { return items.size; } },
    testUserPermission(user) { return actor.owners.has(user?.id); },
    async update(data) {
      await tick();
      if (data["system.currency"]) actor.system.currency = data["system.currency"];
    },
    async createEmbeddedDocuments(_type, list) {
      await tick();
      return list.map(d => {
        const item = { id: `it${items.size + 1}`, name: d.name, delete: async () => { items.delete(item.id); } };
        items.set(item.id, item);
        return item;
      });
    },
  };
  return actor;
}

// The roll's one await (the lot's source) waits at a client's gate until
// the test opens it, so the test sets where each GM is when the other moves.
function makeGate() {
  let reach, open;
  const gate = { reached: new Promise(r => { reach = r; }), opened: new Promise(r => { open = r; }) };
  gate.reach = reach;
  gate.open = open;
  return gate;
}

function makeWorld() {
  const settings = new Map();
  const emitted = [];
  const handlers = [];
  const gates = new Map();
  const actors = new Map([["a1", makeActor("a1", "p1")]]);
  const shared = {
    actors: { get: id => actors.get(id) ?? null },
    messages: { contents: [] },
    settings: {
      register: (ns, key, { default: def }) => { if (!settings.has(`${ns}.${key}`)) settings.set(`${ns}.${key}`, def); },
      get: (ns, key) => settings.get(`${ns}.${key}`),
      async set(ns, key, value) { await tick(); settings.set(`${ns}.${key}`, structuredClone(value)); },
    },
    socket: { on: (_n, fn) => handlers.push(fn), emit: (_n, msg) => emitted.push(msg) },
  };
  const gameFor = user => ({ ...shared, user, users: { activeGM: GM1, get: id => USERS.find(u => u.id === id) ?? null } });
  globalThis.ui = { notifications: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } };
  globalThis.foundry = { utils: { randomID: n => Math.random().toString(36).slice(2, 2 + n), deepClone: v => structuredClone(v), escapeHTML: s => String(s) } };
  globalThis.fromUuid = async uuid => {
    const gate = gates.get(globalThis.game.user.id);
    if (gate) { gate.reach(); await gate.opened; }
    return SOURCES[uuid] ?? null;
  };
  return { actors, emitted, handlers, gates, game1: gameFor(GM1), game0: gameFor(GM0) };
}

const AUCTION = { id: "lot", name: "The Sling", kind: "auction", price: 10, pools: [], auction: { lot: { type: "item", uuid: "Item.sling", name: "Sling +2", img: "sling.webp", rarity: "uncommon" }, increment: 5, reserve: 0, gavelSec: 20, house: { count: 0, budget: 100, chance: 25 } }, rules: {} };

let world, first, second, round;

beforeEach(async () => {
  world = makeWorld();
  Object.defineProperty(globalThis, "game", { configurable: true, get: () => client.getStore() ?? world.game1 });
  first = await loadClient();
  second = await loadClient();
  await as(world.game1, async () => {
    first.store.registerSettings();
    first.socket.registerSocket();
    await world.game1.settings.set("loot-crates", "boxes", { lot: AUCTION });
    await world.game1.settings.set("loot-crates", "pools", {});
    round = await first.table.openRound("lot", { windowMs: 20000 });
    // Ana's bid, as the first GM's socket hears it.
    await Promise.all(world.handlers.map(h => h({ type: "stake", requestId: "r-a1", boxId: "lot", roundId: round.id, actorId: "a1", userId: "p1", price: 10, bet: { amount: 10 } })));
    // The gavel's clock has run out: the round is due.
    await first.store.saveRound({ ...first.store.getRounds()[round.id], closesAt: Date.now() - 1 });
    // The round's open started the first GM's watch; each test starts the watches it means to.
    first.table.stopWatching();
  });
});

afterEach(() => {
  as(world.game1, () => first.table.stopWatching());
  as(world.game0, () => second.table.stopWatching());
  vi.restoreAllMocks();
  delete globalThis.game;
  delete globalThis.ui;
  delete globalThis.foundry;
  delete globalThis.fromUuid;
});

const settleAll = async () => { for (let i = 0; i < 60; i++) await tick(); };
const gp = actor => actor.system.currency.gp + actor.system.currency.pp * 10 + actor.system.currency.ep / 2 + actor.system.currency.sp / 10 + actor.system.currency.cp / 100;
const resolves = () => world.emitted.filter(m => m.type === "round" && m.event === "resolve");
const rowsOf = () => as(world.game1, () => first.store.getLog().filter(r => r.roundId === round.id));

// One gavel: one resolve broadcast, one item on the winner's sheet, the bid
// paid once, one log row for the bid and it settled.
function expectOneSettle() {
  const a1 = world.actors.get("a1");
  expect(resolves()).toHaveLength(1);
  expect(a1.items.size).toBe(1);
  expect(gp(a1)).toBe(90);
  const rows = rowsOf();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ actorId: "a1", status: "settled", itemId: "it1" });
  expect(as(world.game1, () => first.store.getRounds()[round.id].status)).toBe("resolved");
}

describe("two GMs and one gavel", () => {
  it("settles once when a second GM becomes the active one mid-resolve and runs its watch", async () => {
    const g1 = makeGate(), g0 = makeGate();
    world.gates.set(GM1.id, g1);
    world.gates.set(GM0.id, g0);
    // The first GM's watch brings the gavel down; its roll is in flight.
    const hammer = as(world.game1, () => first.table.resolveRound(round.id, { ifDue: true }));
    await g1.reached;
    // The second GM joins with a lower id: the active GM on both clients.
    world.game1.users.activeGM = GM0;
    world.game0.users.activeGM = GM0;
    expect(as(world.game1, () => first.table.watchTables())).toBe(false);
    expect(as(world.game0, () => second.table.watchTables())).toBe(true);
    await g0.reached;
    // The first GM's roll lands: it is no longer the active GM, so it writes nothing.
    g1.open();
    await expect(hammer).rejects.toThrow("Only the GM running the game can do that.");
    await settleAll();
    expect(resolves()).toHaveLength(0);
    expect(world.actors.get("a1").items.size).toBe(0);
    // The second GM's lands and is the one settle.
    g0.open();
    await settleAll();
    expectOneSettle();
  });

  it("settles once when the second GM's resolve starts before the first GM has heard it joined", async () => {
    const g1 = makeGate(), g0 = makeGate();
    world.gates.set(GM1.id, g1);
    world.gates.set(GM0.id, g0);
    const hammer = as(world.game1, () => first.table.resolveRound(round.id, { ifDue: true }));
    await g1.reached;
    // The second GM sees itself as the active one; the first hasn't heard yet.
    world.game0.users.activeGM = GM0;
    const late = as(world.game0, () => second.table.resolveRound(round.id, { ifDue: true }));
    await g0.reached;
    // The first GM, still the active one by its own view, settles the round.
    g1.open();
    expect((await hammer).status).toBe("resolved");
    world.game1.users.activeGM = GM0;
    // The second GM's roll lands on a round already resolved: it writes nothing.
    g0.open();
    expect((await late).status).toBe("already");
    await settleAll();
    expectOneSettle();
  });

  it("says nothing on the first GM's screen when its hammer was handed over", async () => {
    const g1 = makeGate();
    world.gates.set(GM1.id, g1);
    expect(as(world.game1, () => first.table.watchTables())).toBe(true);
    await g1.reached;
    world.game1.users.activeGM = GM0;
    world.game0.users.activeGM = GM0;
    g1.open();
    await settleAll();
    expect(globalThis.ui.notifications.warn).not.toHaveBeenCalled();
    expect(resolves()).toHaveLength(0);
    // The second GM's watch brings it down.
    world.gates.delete(GM1.id);
    expect(as(world.game0, () => second.table.watchTables())).toBe(true);
    await settleAll();
    expectOneSettle();
  });
});

describe("two GMs and the house bidder", () => {
  // One house bidder who always bids, on a round still taking bids whose
  // last turn for the house was long enough ago that the next is due.
  beforeEach(() => as(world.game1, async () => {
    await world.game1.settings.set("loot-crates", "boxes", { lot: { ...AUCTION, auction: { ...AUCTION.auction, house: { count: 1, budget: 100, chance: 100 } } } });
    await first.store.saveRound({ ...first.store.getRounds()[round.id], opensAt: Date.now() - 60000, closesAt: Date.now() + 20000 });
  }));

  const houseRows = () => rowsOf().filter(r => r.house);
  const houseStaked = () => world.emitted.filter(m => m.type === "staked" && m.house);

  it("bids once when the first GM's turn for the house runs after it handed over, while the second GM's bid is on its way", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // The first GM's queue is busy (a stake being written), so its watch's
    // turn for the house waits behind it.
    const busy = makeGate();
    as(world.game1, () => first.store.enqueueWrite(() => busy.opened));
    expect(as(world.game1, () => first.table.watchTables())).toBe(true);
    // The second GM joins with a lower id: the active GM on both clients.
    world.game1.users.activeGM = GM0;
    world.game0.users.activeGM = GM0;
    expect(as(world.game1, () => first.table.watchTables())).toBe(false);
    // The second GM's watch gives the house its turn: it bids, and its
    // write is on its way to the world.
    expect(as(world.game0, () => second.table.watchTables())).toBe(true);
    // The first GM's queue frees before that write lands: its queued turn
    // runs on a client that is no longer the active GM, and writes nothing.
    busy.open();
    await settleAll();
    expect(houseStaked()).toHaveLength(1);
    expect(houseStaked()[0]).toMatchObject({ actorName: "House bidder 1", stake: { amount: 15, house: 1 } });
    const rows = rowsOf();
    expect(houseRows()).toHaveLength(1);
    expect(houseRows()[0]).toMatchObject({ status: "open", stake: { amount: 15 } });
    // The price stepped once: Ana's 10 gp outbid by 15, and her stake back once.
    expect(rows.filter(r => !r.house)).toEqual([expect.objectContaining({ actorId: "a1", status: "refunded", refundReason: "outbid" })]);
    expect(gp(world.actors.get("a1"))).toBe(100);
    // A handover is quiet on the first GM's screen and console.
    expect(error).not.toHaveBeenCalled();
    expect(globalThis.ui.notifications.warn).not.toHaveBeenCalled();
  });

  it("bids once when the second GM's turn comes after the first GM's bid landed", async () => {
    expect(as(world.game1, () => first.table.watchTables())).toBe(true);
    await settleAll();
    world.game1.users.activeGM = GM0;
    world.game0.users.activeGM = GM0;
    expect(as(world.game1, () => first.table.watchTables())).toBe(false);
    expect(as(world.game0, () => second.table.watchTables())).toBe(true);
    await settleAll();
    // The house never bids against itself, so the second turn passes.
    expect(houseStaked()).toHaveLength(1);
    expect(houseRows()).toHaveLength(1);
    expect(gp(world.actors.get("a1"))).toBe(100);
  });
});
