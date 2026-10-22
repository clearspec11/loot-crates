/*
  A second kind of game runs on the crate's core without a copy of the
  money, log, refund or chat code. "well" stands in for a wishing well: a
  copper stake, a miss that gives nothing, a win that pays coins out and
  grants no item. "flip" is the least a kind can be: a roll and nothing else.
  Real pull.js, socket.js, refund.js, chat.js and store.js on a fake world;
  reveal.js is mocked because it needs Foundry's ApplicationV2 at import
  (the window with a stub kind is kindreveal.test.js).
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../module/scripts/reveal.js", () => ({ showReveal: vi.fn(async () => ({ landed: Promise.resolve() })), heldState: () => null, onRelease: () => () => {} }));

const { registerKind, getKind, kindOf, kindIds, kindFor, PullError, _resetKinds } = await import("../module/scripts/kinds.js");
const { performPull } = await import("../module/scripts/pull.js");
const { registerSocket } = await import("../module/scripts/socket.js");
const { registerSettings, appendLog, getLog, getActorState } = await import("../module/scripts/store.js");
const { refundPull, describeRefund, refundCoins } = await import("../module/scripts/refund.js");
const { postPullCard } = await import("../module/scripts/chat.js");
const { showReveal } = await import("../module/scripts/reveal.js");
const { toCopper, isWholeCoins } = await import("../module/scripts/currency.js");

const tick = () => new Promise(r => setTimeout(r, 0));

// The well: 5 cp a throw; rng under 0.5 wins 3 gp (300 cp) and no item.
const WELL = {
  id: "well",
  noun: "well",
  async roll({ state = {}, rng }) {
    const win = rng() < 0.5;
    return { result: win ? { name: "A wish", img: "" } : null, grant: null, payoutCp: win ? 300 : 0, state: { throws: (state.throws ?? 0) + 1 }, ripple: true };
  },
  logRow: ({ out }) => ({ name: out.result?.name ?? "", wish: !!out.result }),
  undo: (state, _row) => ({ ...state, throws: Math.max(0, (state.throws ?? 0) - 1) }),
  chat: { card: (reveal, { esc }) => (reveal.result ? `<div class="loot-crates lc-chat lc-well">${esc(reveal.actorName)} wished at ${esc(reveal.box.name)}</div>` : null) },
};
// The least a kind can be.
const FLIP = { id: "flip", async roll() { return { result: null }; } };

const GM = { id: "gm", name: "Gamemaster" };
const PLAYER = { id: "p1", name: "Player" };
const GAME = { id: "well", kind: "well", name: "Wishing Well", price: 0.05, pools: [], weights: {}, rules: {} };

function makeActor(currency = { pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 }) {
  const actor = {
    id: "actor1", name: "Crate Tester", items: new Map(), writes: [],
    system: { currency: { ...currency } },
    testUserPermission: () => true,
    async update(data) { await tick(); actor.writes.push(data["system.currency"]); if (data["system.currency"]) actor.system.currency = data["system.currency"]; },
    async createEmbeddedDocuments() { throw new Error("no item should be granted"); },
  };
  actor.items.get = id => actor.items.has(id) ? Map.prototype.get.call(actor.items, id) : undefined;
  return actor;
}

function makeWorld({ user = GM, actor = makeActor() } = {}) {
  const settings = new Map();
  const handlers = [];
  const emitted = [];
  const game = {
    user,
    users: { activeGM: GM, get: id => [GM, PLAYER].find(u => u.id === id) ?? null },
    actors: { get: id => (id === actor.id ? actor : null) },
    settings: {
      register: (ns, key, { default: def }) => settings.set(`${ns}.${key}`, def),
      get: (ns, key) => settings.get(`${ns}.${key}`),
      async set(ns, key, value) { await tick(); settings.set(`${ns}.${key}`, value); },
    },
    socket: { on: (_n, fn) => handlers.push(fn), emit: (_n, msg) => emitted.push(msg) },
  };
  globalThis.game = game;
  globalThis.foundry = { utils: { randomID: n => Math.random().toString(36).slice(2, 2 + n), deepClone: v => structuredClone(v), escapeHTML: s => String(s) } };
  globalThis.ChatMessage = { create: vi.fn(async data => data), getSpeaker: () => ({ actor: actor.id }) };
  registerSettings();
  registerSocket();
  return { game, actor, emitted, deliver: msg => Promise.all(handlers.map(h => h(msg))) };
}

beforeEach(() => { registerKind(WELL); registerKind(FLIP); });
afterEach(() => {
  _resetKinds(["crate"]);
  showReveal.mockClear();
  delete globalThis.game; delete globalThis.foundry; delete globalThis.ChatMessage; delete globalThis.ui;
});

describe("the kind registry", () => {
  it("has the crate as soon as the core is imported, and a record with no kind is a crate", () => {
    expect(getKind("crate")?.id).toBe("crate");
    expect(kindIds()).toEqual(expect.arrayContaining(["crate", "well", "flip"]));
    expect(kindOf({})).toBe("crate");
    expect(kindOf({ kind: "" })).toBe("crate");
    expect(kindOf({ kind: "well" })).toBe("well");
    expect(kindFor({ kind: "well" })).toBe(WELL);
  });

  it("refuses a kind without a roll, and names a kind this client doesn't know as a PullError", async () => {
    expect(() => registerKind({ id: "x" })).toThrow(/needs a roll/);
    expect(() => kindFor({ kind: "slots", name: "Lucky Sevens" })).toThrow(PullError);
    expect(() => kindFor({ kind: "slots", name: "Lucky Sevens" })).toThrow("Lucky Sevens is a kind of game (slots) this client can't run.");
    const actor = makeActor();
    await expect(performPull({ box: { ...GAME, kind: "slots" }, pools: {}, actor })).rejects.toThrow(PullError);
    expect(actor.writes).toHaveLength(0);
  });
});

describe("performPull on a second kind", () => {
  it("charges a copper stake and grants nothing on a miss, in one purse write", async () => {
    const actor = makeActor();
    const out = await performPull({ box: GAME, pools: {}, actor, rng: () => 0.9 });
    expect(out).toMatchObject({ kind: "well", result: null, itemId: null, payoutCp: 0, state: { throws: 1 }, ripple: true });
    expect(out).not.toHaveProperty("grant");
    expect(actor.writes).toHaveLength(1);
    expect(actor.system.currency).toEqual({ pp: 0, gp: 0, ep: 0, sp: 9, cp: 5 });
    expect(isWholeCoins(actor.system.currency)).toBe(true);
  });

  it("settles the stake and the payout together on a win: one write, no item", async () => {
    const actor = makeActor();
    const out = await performPull({ box: GAME, pools: {}, actor, state: { throws: 4 }, rng: () => 0.1 });
    expect(out).toMatchObject({ result: { name: "A wish" }, payoutCp: 300, itemId: null, state: { throws: 5 } });
    expect(actor.writes).toHaveLength(1);
    expect(toCopper(actor.system.currency)).toBe(100 - 5 + 300);
    expect(actor.system.currency).toEqual({ pp: 0, gp: 3, ep: 0, sp: 9, cp: 5 });
    expect(out.purse).toEqual(actor.system.currency);
  });

  it("keeps the core's guards: a stale price, an empty purse and a sold-out game cost nothing", async () => {
    const actor = makeActor({ cp: 4 });
    await expect(performPull({ box: GAME, pools: {}, actor })).rejects.toThrow("Crate Tester can't afford Wishing Well.");
    await expect(performPull({ box: GAME, pools: {}, actor: makeActor(), expectedPrice: 0.1 })).rejects.toThrow("Nothing was charged.");
    await expect(performPull({ box: { ...GAME, rules: { stock: 0 } }, pools: {}, actor: makeActor() })).rejects.toThrow("is sold out.");
    expect(actor.writes).toHaveLength(0);
  });

  it("runs the least a kind can be, and writes nothing with grant: false", async () => {
    const actor = makeActor();
    const out = await performPull({ box: { ...GAME, kind: "flip" }, pools: {}, actor, grant: false });
    expect(out).toMatchObject({ kind: "flip", result: null, itemId: null, payoutCp: 0 });
    expect(out.state).toBeUndefined();
    expect(actor.writes).toHaveLength(0);
  });
});

describe("the GM's socket path for a second kind", () => {
  async function pull(world, rng) {
    const { game, deliver } = world;
    await game.settings.set("loot-crates", "boxes", { well: GAME });
    globalThis.CONFIG = { Dice: { randomUniform: rng } };
    try {
      await deliver({ type: "pull", requestId: "w1", boxId: "well", actorId: "actor1", userId: "p1", price: 0.05 });
    } finally { delete globalThis.CONFIG; }
  }

  it("broadcasts the kind's reveal and writes the one log row with payoutCp on a miss", async () => {
    const world = makeWorld();
    await pull(world, () => 0.9);
    const reveal = world.emitted.find(m => m.type === "reveal");
    expect(reveal).toMatchObject({ kind: "well", requestId: "w1", userId: "p1", actorId: "actor1", box: { id: "well", name: "Wishing Well", price: 0.05 }, result: null, itemId: null, itemUuid: null, payoutCp: 0, ripple: true, stateBefore: {} });
    for (const k of ["grant", "state", "pools", "odds"]) expect(reveal).not.toHaveProperty(k);
    expect(showReveal).toHaveBeenCalledWith(reveal);
    const [row] = world.game.settings.get("loot-crates", "pullLog");
    expect(row).toMatchObject({ id: reveal.logId, kind: "well", boxId: "well", boxName: "Wishing Well", actorId: "actor1", userId: "p1", itemId: null, price: 0.05, payoutCp: 0, name: "", wish: false });
    expect(row).not.toHaveProperty("uuid");
    expect(getActorState("actor1", "well")).toEqual({ throws: 1 });
    expect(world.actor.writes).toHaveLength(1);
    expect(toCopper(world.actor.system.currency)).toBe(95);
  });

  it("records a win's payout, and a kind with no state writes none", async () => {
    const world = makeWorld();
    await pull(world, () => 0.1);
    const [row] = world.game.settings.get("loot-crates", "pullLog");
    expect(row).toMatchObject({ kind: "well", payoutCp: 300, wish: true, name: "A wish" });
    expect(toCopper(world.actor.system.currency)).toBe(395);

    await world.game.settings.set("loot-crates", "boxes", { flip: { ...GAME, id: "flip", kind: "flip", name: "Coin flip", price: 1 } });
    await world.deliver({ type: "pull", requestId: "f1", boxId: "flip", actorId: "actor1", userId: "p1" });
    expect(world.game.settings.get("loot-crates", "pullLog")).toHaveLength(2);
    expect(world.game.settings.get("loot-crates", "actorState")).toEqual({ "actor1.well": { throws: 1 } });
    expect(toCopper(world.actor.system.currency)).toBe(295);
  });

  it("names the game's noun when a kind's roll breaks, and charges nothing", async () => {
    const world = makeWorld();
    registerKind({ ...WELL, async roll() { throw new Error("the bucket is stuck"); } });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try { await pull(world, () => 0.1); } finally { errors.mockRestore(); }
    expect(world.emitted.find(m => m.type === "error")).toMatchObject({ requestId: "w1", userId: "p1", message: "The well jammed. Check the GM's console." });
    expect(world.actor.writes).toHaveLength(0);
    expect(world.game.settings.get("loot-crates", "pullLog")).toHaveLength(0);
  });
});

describe("the one refund, for a second kind", () => {
  const WIN = { kind: "well", boxId: "well", boxName: "Wishing Well", actorId: "actor1", actorName: "Crate Tester", userId: "p1", itemId: null, name: "A wish", price: 0.05, payoutCp: 300, wish: true };

  async function seed(actor, row, game = GAME, state = { throws: 3 }) {
    const world = makeWorld({ actor });
    await world.game.settings.set("loot-crates", "boxes", { [game.id]: game });
    await world.game.settings.set("loot-crates", "actorState", { [`actor1.${game.id}`]: state });
    await appendLog(row);
    return { world, rowId: getLog()[0].id };
  }

  it("gives the stake back and takes the payout back in one move, deletes nothing, and undoes the kind's state", async () => {
    const actor = makeActor({ gp: 3, sp: 9, cp: 5 });
    const { rowId } = await seed(actor, WIN);
    const plan = describeRefund(rowId);
    expect(plan).toMatchObject({ status: "ready", coins: -295, item: null, state: { before: { throws: 3 }, after: { throws: 2 } } });
    const out = await refundPull(rowId);
    expect(out.status).toBe("refunded");
    expect(out.removedItem).toBeNull();
    expect(toCopper(actor.system.currency)).toBe(100);
    expect(actor.system.currency).toEqual({ pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 });
    expect(getActorState("actor1", "well")).toEqual({ throws: 2 });
    expect(getLog()[0].refunded).toEqual(expect.any(Number));
  });

  it("refuses to take back winnings the character has spent, before marking the row", async () => {
    const actor = makeActor({ cp: 50 });
    const { rowId } = await seed(actor, WIN);
    expect(describeRefund(rowId)).toMatchObject({ status: "short", short: 2.45, message: "Crate Tester has spent 2 gp 4 sp 5 cp of the 3 gp won at Wishing Well (5 sp of the 2 gp 9 sp 5 cp to take back is left). Nothing was refunded; refund it once the purse can cover it." });
    const out = await refundPull(rowId);
    expect(out.status).toBe("short");
    expect(getLog()[0]).not.toHaveProperty("refunded");
    expect(actor.writes).toHaveLength(0);
    expect(toCopper(actor.system.currency)).toBe(50);
  });

  it("counts a row from before payouts as paying nothing, and a miss gives the stake back", async () => {
    expect(refundCoins({ price: 17.35 })).toBe(1735);
    expect(refundCoins({ price: 0.05, payoutCp: 0 })).toBe(5);
    expect(refundCoins({ price: 1, payoutCp: 300 })).toBe(-200);
    const actor = makeActor({ sp: 9, cp: 5 });
    const { rowId } = await seed(actor, { ...WIN, payoutCp: 0, name: "", wish: false });
    await refundPull(rowId);
    expect(actor.system.currency).toEqual({ pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 });
  });

  it("leaves the state alone for a kind this client doesn't know, and still returns the coins", async () => {
    const actor = makeActor({ sp: 9, cp: 5 });
    const { rowId } = await seed(actor, { ...WIN, kind: "slots", payoutCp: 0 }, { ...GAME, id: "well", kind: "slots" }, { spins: 2 });
    const out = await refundPull(rowId);
    expect(out.status).toBe("refunded");
    expect(toCopper(actor.system.currency)).toBe(100);
    expect(getActorState("actor1", "well")).toEqual({ spins: 2 });
  });
});

describe("the chat card is the kind's", () => {
  const reveal = result => ({ type: "reveal", kind: "well", requestId: "w1", userId: "p1", actorId: "actor1", actorName: "Crate Tester", box: { id: "well", name: "Wishing Well", price: 0.05 }, result, itemId: null, itemUuid: null, logId: "L1", purse: {} });

  it("posts none for a miss, and the kind's words for a win, with the row's id and no item or replay", async () => {
    makeWorld();
    expect(await postPullCard(reveal(null))).toBeNull();
    expect(globalThis.ChatMessage.create).not.toHaveBeenCalled();
    const msg = await postPullCard(reveal({ name: "A wish", img: "" }));
    expect(msg.content).toContain("Crate Tester wished at Wishing Well");
    expect(msg.flags["loot-crates"]).toEqual({ boxId: "well", logId: "L1" });
  });

  it("posts nothing for a kind with no card", async () => {
    makeWorld();
    expect(await postPullCard({ ...reveal({ name: "Heads" }), kind: "flip" })).toBeNull();
    expect(globalThis.ChatMessage.create).not.toHaveBeenCalled();
  });
});
