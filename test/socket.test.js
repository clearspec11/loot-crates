/*
  The socket flow with a mocked socket and a fake `game`: the buyer's promise
  settles on the reveal broadcast, and the GM client runs pulls one at a time
  so a stock-1 box can only ever sell one.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// reveal.js reads foundry.applications.api at module top level and chat.js
// needs ChatMessage, so both are mocked rather than stubbed.
// showReveal resolves to the window, whose `landed` settles when the spin
// ends; tests swap it for a window that never lands when that matters.
vi.mock("../module/scripts/reveal.js", () => ({ showReveal: vi.fn(async () => ({ landed: Promise.resolve() })) }));
vi.mock("../module/scripts/chat.js", () => ({ postPullCard: vi.fn(async () => null) }));

const { registerSocket, requestPull, GM_TIMEOUT_MS } = await import("../module/scripts/socket.js");
const { registerSettings, appendLog } = await import("../module/scripts/store.js");
const { refundPull } = await import("../module/scripts/refund.js");
const { PullError } = await import("../module/scripts/pull.js");
const { showReveal } = await import("../module/scripts/reveal.js");
const { postPullCard } = await import("../module/scripts/chat.js");

const tick = () => new Promise(r => setTimeout(r, 0));

const GM = { id: "gm", name: "Gamemaster" };
const PLAYER = { id: "p1", name: "Player" };

function makeActor(gp = 500) {
  const actor = {
    id: "actor1",
    name: "Crate Tester",
    system: { currency: { pp: 0, gp, ep: 0, sp: 0, cp: 0 } },
    items: [],
    updates: 0,
    testUserPermission: () => true,
    async update(data) {
      // Reads before this await see the old purse, like a real document update.
      await tick();
      actor.updates++;
      if (data["system.currency"]) actor.system.currency = data["system.currency"];
    },
    async createEmbeddedDocuments(_type, docs) {
      await tick();
      const made = docs.map((d, i) => ({ id: `item${actor.items.length + i}`, ...d }));
      actor.items.push(...made);
      return made;
    },
  };
  return actor;
}

// A fake Foundry world. `user` is who this client is; `activeGM` is who the
// world says is running it. The socket records emits and lets a test deliver
// a message to the registered handler.
function makeWorld({ user, activeGM = GM, actor = makeActor() }) {
  const settings = new Map();
  const handlers = [];
  const emitted = [];
  const game = {
    user,
    users: { activeGM, get: id => [GM, PLAYER].find(u => u.id === id) ?? null },
    actors: { get: id => (id === actor.id ? actor : null) },
    settings: {
      register: (ns, key, { default: def }) => settings.set(`${ns}.${key}`, def),
      get: (ns, key) => settings.get(`${ns}.${key}`),
      async set(ns, key, value) { await tick(); settings.set(`${ns}.${key}`, value); },
    },
    socket: {
      on: (_name, fn) => handlers.push(fn),
      emit: (_name, msg) => emitted.push(msg),
    },
  };
  globalThis.game = game;
  globalThis.foundry = { utils: { randomID: n => Math.random().toString(36).slice(2, 2 + n), deepClone: v => structuredClone(v) } };
  globalThis.fromUuid = async uuid => ({ name: `Item ${uuid}`, img: "", toObject: () => ({ name: `Item ${uuid}`, type: "loot", flags: {} }) });
  registerSettings();
  registerSocket();
  const deliver = msg => Promise.all(handlers.map(h => h(msg)));
  return { game, actor, emitted, deliver, settings };
}

const POOL = { id: "pool", name: "Pool", pools: [], entries: ["a", "b", "c"].map(u => ({ uuid: u, name: u, img: "", rarity: "common", weight: 1 })) };
const box = rules => ({ id: "box", name: "Test Crate", price: 10, pools: [{ id: "pool", share: 1 }], weights: { common: 1 }, rules });

async function seed(game, rules) {
  await game.settings.set("loot-crates", "pools", { pool: POOL });
  await game.settings.set("loot-crates", "boxes", { box: box(rules) });
}

afterEach(() => {
  vi.useRealTimers();
  showReveal.mockReset().mockImplementation(async () => ({ landed: Promise.resolve() }));
  postPullCard.mockClear();
  delete globalThis.game;
  delete globalThis.foundry;
  delete globalThis.fromUuid;
});

describe("a player's requestPull", () => {
  beforeEach(() => vi.useFakeTimers());

  it("resolves on the reveal broadcast and clears the timeout", async () => {
    const { emitted, deliver } = makeWorld({ user: PLAYER });
    const promise = requestPull({ boxId: "box", actorId: "actor1" });
    const sent = emitted[0];
    expect(sent).toMatchObject({ type: "pull", boxId: "box", actorId: "actor1", userId: "p1" });

    const reveal = { type: "reveal", requestId: sent.requestId, userId: "p1", actorId: "actor1", box: { id: "box" }, result: { name: "a" } };
    await deliver(reveal);
    await expect(promise).resolves.toBe(reveal);
    expect(showReveal).toHaveBeenCalledWith(reveal);

    // The 30 s timer is gone: nothing fires later.
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(GM_TIMEOUT_MS + 1);
    await expect(promise).resolves.toBe(reveal);
  });

  it("ignores someone else's reveal and still shows it", async () => {
    const { emitted, deliver } = makeWorld({ user: PLAYER });
    const promise = requestPull({ boxId: "box", actorId: "actor1" });
    const other = { type: "reveal", requestId: emitted[0].requestId, userId: "p2" };
    await deliver(other);
    expect(showReveal).toHaveBeenCalledWith(other);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(GM_TIMEOUT_MS + 1);
    await expect(promise).rejects.toThrow("The GM didn't answer in time.");
  });

  it("rejects with the GM's error message", async () => {
    const { emitted, deliver } = makeWorld({ user: PLAYER });
    const promise = requestPull({ boxId: "box", actorId: "actor1" });
    await deliver({ type: "error", requestId: emitted[0].requestId, userId: "p1", message: "Test Crate is sold out." });
    await expect(promise).rejects.toThrow(PullError);
    await expect(promise).rejects.toThrow("Test Crate is sold out.");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out when the GM never answers, and a late reveal is harmless", async () => {
    const { emitted, deliver } = makeWorld({ user: PLAYER });
    const promise = requestPull({ boxId: "box", actorId: "actor1" });
    vi.advanceTimersByTime(GM_TIMEOUT_MS + 1);
    await expect(promise).rejects.toThrow("The GM didn't answer in time.");
    await deliver({ type: "reveal", requestId: emitted[0].requestId, userId: "p1" });
  });

  it("is refused outright with no GM online", async () => {
    makeWorld({ user: PLAYER, activeGM: null });
    await expect(requestPull({ boxId: "box", actorId: "actor1" })).rejects.toThrow("The shop is closed until a GM is online.");
  });
});

describe("the GM client", () => {
  it("fulfils a player's pull over the socket and broadcasts the reveal", async () => {
    const { game, actor, emitted, deliver } = makeWorld({ user: GM });
    await seed(game, {});
    await deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1" });
    const reveal = emitted.find(m => m.type === "reveal");
    expect(reveal).toMatchObject({ requestId: "r1", userId: "p1", actorId: "actor1", box: { id: "box", price: 10 } });
    expect(actor.system.currency.gp).toBe(490);
    expect(actor.items).toHaveLength(1);
    expect(game.settings.get("loot-crates", "pullLog")).toHaveLength(1);
    expect(showReveal).toHaveBeenCalledWith(reveal);
  });

  it("replies with an error to the buyer when the box is sold out", async () => {
    const { game, actor, emitted, deliver } = makeWorld({ user: GM });
    await seed(game, { stock: 0 });
    await deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1" });
    expect(emitted).toEqual([{ type: "error", requestId: "r1", userId: "p1", message: "Test Crate is sold out." }]);
    expect(actor.system.currency.gp).toBe(500);
  });

  it("sells exactly one from a stock-1 box to two pulls arriving together", async () => {
    const { game, actor, emitted, deliver } = makeWorld({ user: GM });
    await seed(game, { stock: 1 });
    await Promise.all([
      deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1" }),
      deliver({ type: "pull", requestId: "r2", boxId: "box", actorId: "actor1", userId: "p1" }),
    ]);
    const reveals = emitted.filter(m => m.type === "reveal");
    const errors = emitted.filter(m => m.type === "error");
    expect(reveals).toHaveLength(1);
    expect(errors).toEqual([{ type: "error", requestId: "r2", userId: "p1", message: "Test Crate is sold out." }]);
    expect(game.settings.get("loot-crates", "boxes").box.rules.stock).toBe(0);
    expect(game.settings.get("loot-crates", "pullLog")).toHaveLength(1);
    expect(actor.updates).toBe(1);
    expect(actor.system.currency.gp).toBe(490);
    expect(actor.items).toHaveLength(1);
  });

  it("refuses a player who doesn't own the character, without charging", async () => {
    const actor = makeActor();
    actor.testUserPermission = (user, level) => level === "OWNER" && user.id === "gm";
    const { game, emitted, deliver } = makeWorld({ user: GM, actor });
    await seed(game, {});
    await deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1" });
    expect(emitted).toEqual([{ type: "error", requestId: "r1", userId: "p1", message: "You don't own that character." }]);
    expect(actor.updates).toBe(0);
    expect(actor.items).toHaveLength(0);
    expect(game.settings.get("loot-crates", "pullLog")).toHaveLength(0);
  });

  it("does not hold the next pull behind the previous reveal's spin", async () => {
    // On Foundry v14 render() resolves only once the spin has landed, so a
    // queue that awaited the reveal would stall every later buyer.
    showReveal.mockImplementation(async () => ({ landed: new Promise(() => {}) }));
    const { game, actor, emitted, deliver } = makeWorld({ user: GM });
    await seed(game, { stock: 2 });
    await deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1" });
    await deliver({ type: "pull", requestId: "r2", boxId: "box", actorId: "actor1", userId: "p1" });
    expect(emitted.filter(m => m.type === "reveal").map(m => m.requestId)).toEqual(["r1", "r2"]);
    expect(actor.items).toHaveLength(2);
    expect(actor.system.currency.gp).toBe(480);
  });

  it("posts the chat card only once the reveal has landed, so chat never spoils the spin", async () => {
    let land;
    showReveal.mockImplementation(async () => ({ landed: new Promise(r => { land = r; }) }));
    const { game, deliver } = makeWorld({ user: GM });
    await seed(game, {});
    await deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1" });
    await tick();
    expect(postPullCard).not.toHaveBeenCalled();
    land();
    await tick();
    expect(postPullCard).toHaveBeenCalledTimes(1);
    expect(postPullCard.mock.calls[0][0]).toMatchObject({ type: "reveal", requestId: "r1" });
  });

  it("runs a refund and a pull on the same character one after the other, losing neither write", async () => {
    const { game, actor, emitted, deliver } = makeWorld({ user: GM });
    await seed(game, { stock: 5 });
    await appendLog({ boxId: "box", boxName: "Test Crate", actorId: "actor1", itemId: null, name: "a", uuid: "a", rarity: "common", price: 10 });
    const rowId = game.settings.get("loot-crates", "pullLog")[0].id;
    const [, refund] = await Promise.all([
      deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1" }),
      refundPull(rowId),
    ]);
    expect(refund.status).toBe("refunded");
    expect(emitted.filter(m => m.type === "reveal")).toHaveLength(1);
    // 500 - 10 (the pull) + 10 (the refund): with separate queues the refund
    // read the purse before the charge landed and the item went out free.
    expect(actor.system.currency.gp).toBe(500);
    expect(game.settings.get("loot-crates", "boxes").box.rules.stock).toBe(5);
  });

  it("queues its own buy behind a player's so the second one is refused", async () => {
    const { game, actor, emitted, deliver } = makeWorld({ user: GM });
    await seed(game, { stock: 1 });
    const theirs = deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1" });
    const mine = requestPull({ boxId: "box", actorId: "actor1" });
    await theirs;
    await expect(mine).rejects.toThrow("Test Crate is sold out.");
    expect(emitted.filter(m => m.type === "reveal")).toHaveLength(1);
    expect(actor.items).toHaveLength(1);
    // The GM's own failure is thrown to its shop, never sent over the socket.
    expect(emitted.filter(m => m.type === "error")).toHaveLength(0);
  });
});
