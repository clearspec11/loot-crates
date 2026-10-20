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

const { registerSocket, requestPull, GM_TIMEOUT_MS, WAIT_NOTICE_MS, TIMED_OUT } = await import("../module/scripts/socket.js");
const { registerSettings, appendLog, sweepAllPools, enqueueWrite, INDEX_FIELDS } = await import("../module/scripts/store.js");
const { refundPull } = await import("../module/scripts/refund.js");
const { PullError } = await import("../module/scripts/pull.js");
const { seededRng, oddsTable } = await import("../module/scripts/odds.js");
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
    // Still pending: the 30 s timeout and the wait notice.
    expect(vi.getTimerCount()).toBe(2);
    vi.advanceTimersByTime(GM_TIMEOUT_MS + 1);
    await expect(promise).rejects.toThrow(TIMED_OUT);
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
    await expect(promise).rejects.toThrow(TIMED_OUT);
    // The buyer calls the purchase off, so a GM that gets to it later doesn't charge.
    expect(emitted[1]).toEqual({ type: "cancel", requestId: emitted[0].requestId, userId: "p1" });
    await deliver({ type: "reveal", requestId: emitted[0].requestId, userId: "p1" });
  });

  it("tells the shop it is waiting after WAIT_NOTICE_MS, and why once the GM says its tab is hidden", async () => {
    const { emitted, deliver } = makeWorld({ user: PLAYER });
    const waits = [];
    const promise = requestPull({ boxId: "box", actorId: "actor1" }, { onWait: w => waits.push(w) });
    const { requestId } = emitted[0];
    vi.advanceTimersByTime(WAIT_NOTICE_MS - 1);
    expect(waits).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(waits).toEqual(["gm"]);
    await deliver({ type: "ack", requestId, userId: "p1", hidden: true });
    expect(waits).toEqual(["gm", "hidden"]);
    await deliver({ type: "reveal", requestId, userId: "p1" });
    await expect(promise).resolves.toMatchObject({ requestId });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("says nothing when the reveal comes quickly, and a hidden ack before the notice waits for it", async () => {
    const { emitted, deliver } = makeWorld({ user: PLAYER });
    const waits = [];
    const fast = requestPull({ boxId: "box", actorId: "actor1" }, { onWait: w => waits.push(w) });
    await deliver({ type: "reveal", requestId: emitted[0].requestId, userId: "p1" });
    await fast;
    vi.advanceTimersByTime(GM_TIMEOUT_MS + 1);
    expect(waits).toEqual([]);

    const slow = requestPull({ boxId: "box", actorId: "actor1" }, { onWait: w => waits.push(w) });
    await deliver({ type: "ack", requestId: emitted[1].requestId, userId: "p1", hidden: true });
    expect(waits).toEqual([]);
    vi.advanceTimersByTime(WAIT_NOTICE_MS);
    expect(waits).toEqual(["hidden"]);
    await deliver({ type: "error", requestId: emitted[1].requestId, userId: "p1", message: "Sold out." });
    await expect(slow).rejects.toThrow("Sold out.");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is refused outright with no GM online", async () => {
    makeWorld({ user: PLAYER, activeGM: null });
    await expect(requestPull({ boxId: "box", actorId: "actor1" })).rejects.toThrow("The shop is closed until a GM is online.");
  });
});

describe("the GM client", () => {
  it("drops a pull its buyer called off before it was charged, and still sells the next", async () => {
    const { game, actor, emitted, deliver } = makeWorld({ user: GM });
    await seed(game, {});
    // A slow write ahead in the queue holds the pull past the buyer's timeout.
    let release;
    const held = enqueueWrite(() => new Promise(r => { release = r; }));
    const pull = deliver({ type: "pull", requestId: "late", boxId: "box", actorId: "actor1", userId: "p1" });
    await deliver({ type: "cancel", requestId: "late", userId: "p1" });
    release();
    await held;
    await pull;
    expect(actor.system.currency.gp).toBe(500);
    expect(actor.items).toHaveLength(0);
    expect(emitted.filter(m => m.type === "reveal")).toHaveLength(0);
    expect(game.settings.get("loot-crates", "pullLog")).toHaveLength(0);

    await deliver({ type: "pull", requestId: "next", boxId: "box", actorId: "actor1", userId: "p1" });
    expect(actor.system.currency.gp).toBe(490);
    expect(emitted.filter(m => m.type === "reveal")).toHaveLength(1);
  });

  it("fulfils a player's pull over the socket and broadcasts the reveal", async () => {
    const { game, actor, emitted, deliver } = makeWorld({ user: GM });
    await seed(game, {});
    await deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1" });
    const reveal = emitted.find(m => m.type === "reveal");
    expect(reveal).toMatchObject({ requestId: "r1", userId: "p1", actorId: "actor1", box: { id: "box", price: 10 } });
    expect(actor.system.currency.gp).toBe(490);
    expect(actor.items).toHaveLength(1);
    // Where the item went, for the reveal's Open item and the chat card's link.
    expect(reveal.itemId).toBe(actor.items[0].id);
    expect(reveal.itemUuid).toBe(`Actor.actor1.Item.${actor.items[0].id}`);
    expect(reveal.purse).toMatchObject({ gp: 490 });
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
    // The card gets the id of the log row this pull wrote, for the refund.
    const rowId = game.settings.get("loot-crates", "pullLog")[0].id;
    expect(postPullCard.mock.calls[0][0].logId).toBe(rowId);
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

describe("how quickly the GM answers", () => {
  afterEach(() => { delete globalThis.ui; delete globalThis.document; });

  it("broadcasts the reveal before writing the state and log, and still writes them once, before the next pull", async () => {
    const { game, actor, emitted, deliver } = makeWorld({ user: GM });
    await seed(game, { stock: 3 });
    const events = [];
    const set = game.settings.set;
    game.settings.set = async (ns, key, value) => { events.push(`set ${key}`); return set(ns, key, value); };
    const emit = game.socket.emit;
    game.socket.emit = (name, msg) => { events.push(msg.type); return emit(name, msg); };
    const first = deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1" });
    const second = deliver({ type: "pull", requestId: "r2", boxId: "box", actorId: "actor1", userId: "p1" });
    await Promise.all([first, second]);
    // r1: reveal, then its three writes; only then r2's reveal.
    const firstReveal = events.indexOf("reveal");
    const secondReveal = events.lastIndexOf("reveal");
    expect(events.slice(firstReveal + 1, secondReveal).sort()).toEqual(["set actorState", "set boxes", "set pullLog"]);
    expect(events.indexOf("set pullLog")).toBeGreaterThan(firstReveal);
    // One charge and one grant per request; the stock and log count both.
    expect(actor.updates).toBe(2);
    expect(actor.items).toHaveLength(2);
    expect(actor.system.currency.gp).toBe(480);
    expect(game.settings.get("loot-crates", "boxes").box.rules.stock).toBe(1);
    const log = game.settings.get("loot-crates", "pullLog");
    expect(log).toHaveLength(2);
    // The reveal named the row before it existed; the row has that id.
    const reveals = emitted.filter(m => m.type === "reveal");
    expect(log.map(r => r.id)).toEqual([reveals[1].logId, reveals[0].logId]);
    expect(log.every(r => typeof r.at === "number")).toBe(true);
    // The chat card still goes out, carrying that id.
    await tick();
    expect(postPullCard.mock.calls.map(c => c[0].logId)).toEqual(reveals.map(r => r.logId));
  });

  it("keeps the reveal when the log can't be written, and tells the GM", async () => {
    const errors = [];
    globalThis.ui = { notifications: { error: m => errors.push(m), warn: () => {} } };
    const { game, actor, emitted, deliver } = makeWorld({ user: GM });
    await seed(game, {});
    const set = game.settings.set;
    game.settings.set = async (ns, key, value) => { if (key === "pullLog") throw new Error("disk full"); return set(ns, key, value); };
    const err = console.error;
    console.error = () => {};
    try { await deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1" }); } finally { console.error = err; }
    expect(emitted.map(m => m.type)).toEqual(["reveal"]);
    expect(actor.updates).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("wasn't saved");
  });

  it("refuses a drawn entry whose source is gone without a charge, a log row or a reveal", async () => {
    const actor = makeActor();
    const { game, emitted, deliver } = makeWorld({ user: GM, actor });
    globalThis.ui = { notifications: { warn: () => {} } };
    // The sweep sees it (a world item), but the document is gone when rolled.
    game.items = { get: id => ({ id, name: id, img: "", system: {} }) };
    globalThis.fromUuid = async () => null;
    await game.settings.set("loot-crates", "pools", { pool: { ...POOL, entries: [{ uuid: "Item.gone", name: "Gone", img: "", rarity: "common", weight: 1 }] } });
    await game.settings.set("loot-crates", "boxes", { box: box({}) });
    const warn = console.warn;
    console.warn = () => {};
    try { await deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1" }); } finally { console.warn = warn; }
    expect(emitted).toEqual([{ type: "error", requestId: "r1", userId: "p1", message: "Gone is missing from its compendium. Tell the GM." }]);
    expect(actor.updates).toBe(0);
    expect(actor.items).toHaveLength(0);
    expect(game.settings.get("loot-crates", "pullLog")).toHaveLength(0);
    expect(game.settings.get("loot-crates", "pools").pool.entries[0].missing).toBe(true);
  });

  it("doesn't hold a pull behind the load-time sweep's source check", async () => {
    globalThis.ui = { notifications: { warn: () => {} } };
    const { game, emitted, deliver } = makeWorld({ user: GM });
    await seed(game, {});
    // A second pool on a pack whose index takes as long as we like.
    let release;
    const slowIndex = new Promise(r => { release = r; });
    game.packs = { get: () => ({ getIndex: () => slowIndex }) };
    const pools = game.settings.get("loot-crates", "pools");
    await game.settings.set("loot-crates", "pools", { ...pools, big: { id: "big", name: "Big", pools: [], entries: [{ uuid: "Compendium.x.y.Item.dead", name: "Dead", img: "", rarity: "rare", weight: 1 }] } });
    const sweep = sweepAllPools();
    await tick();
    await deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1" });
    expect(emitted.filter(m => m.type === "reveal")).toHaveLength(1);
    // The sweep finishes afterwards and its write still lands, in the queue.
    const debug = console.debug, warn = console.warn;
    console.debug = () => {}; console.warn = () => {};
    try {
      release(new Map());
      await sweep;
      await enqueueWrite(() => null);
    } finally { console.debug = debug; console.warn = warn; }
    expect(game.settings.get("loot-crates", "pools").big.entries[0].missing).toBe(true);
    expect(game.settings.get("loot-crates", "pullLog")).toHaveLength(1);
  });

  it("tells the buyer and the GM (once) when the GM's tab is in the background", async () => {
    const warnings = [];
    globalThis.ui = { notifications: { warn: m => warnings.push(m) } };
    const listeners = [];
    globalThis.document = { visibilityState: "hidden", addEventListener: (type, fn) => listeners.push({ type, fn }) };
    const { game, emitted, deliver } = makeWorld({ user: GM });
    await seed(game, {});
    const warn = console.warn;
    console.warn = () => {};
    try {
      await deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1" });
      await deliver({ type: "pull", requestId: "r2", boxId: "box", actorId: "actor1", userId: "p1" });
    } finally { console.warn = warn; }
    expect(emitted.map(m => m.type)).toEqual(["ack", "reveal", "ack", "reveal"]);
    expect(emitted[0]).toEqual({ type: "ack", requestId: "r1", userId: "p1", hidden: true });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("in the background");
    // Shown again after the tab has been visible and hidden again.
    listeners.find(l => l.type === "visibilitychange").fn();
    console.warn = () => {};
    try { await deliver({ type: "pull", requestId: "r3", boxId: "box", actorId: "actor1", userId: "p1" }); } finally { console.warn = warn; }
    expect(warnings).toHaveLength(2);
  });

  it("sends no ack from a visible tab", async () => {
    globalThis.document = { visibilityState: "visible", addEventListener: () => {} };
    const { game, emitted, deliver } = makeWorld({ user: GM });
    await seed(game, {});
    await deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1" });
    expect(emitted.map(m => m.type)).toEqual(["reveal"]);
  });
});

describe("a pool entry whose source is gone", () => {
  const PACK = "Compendium.dnd5e.items.Item.";
  const entry = (id, name, rarity) => ({ uuid: PACK + id, name, img: "", rarity, weight: 1 });
  const POOLS = { loot: { id: "loot", name: "Treasure", pools: [], entries: [
    entry("c1", "Torch", "common"), entry("c2", "Rope", "common"),
    entry("r1", "Flame Tongue", "rare"), entry("l1", "Vorpal Sword", "legendary"),
  ] } };
  const BOX = { id: "box", name: "Test Crate", price: 10, pools: [{ id: "loot", share: 1 }], weights: { common: 60, rare: 30, legendary: 10 }, rules: {} };
  const item = uuid => ({ name: uuid, img: "", toObject: () => ({ name: uuid, type: "loot", flags: {} }) });
  // A pack Foundry has already indexed with the module's fields, as it is
  // once the load sweep (or anything else) has read it.
  const warmPack = ids => {
    const index = new Map([...ids].map(k => [k, { _id: k }]));
    return { indexed: true, indexFields: new Set(INDEX_FIELDS), index, getIndex: async () => index };
  };

  let warnings;
  beforeEach(() => {
    warnings = [];
    globalThis.ui = { notifications: { warn: m => warnings.push(m) } };
  });
  afterEach(() => { delete globalThis.ui; delete globalThis.CONFIG; });

  it("is never drawn: 1000 seeded pulls with a dead rare and legendary all succeed, and both get flagged", async () => {
    const actor = makeActor(1000 * 10);
    const { game, emitted, deliver } = makeWorld({ user: GM, actor });
    const live = new Set(["c1", "c2"]);
    game.packs = { get: id => (id === "dnd5e.items" ? warmPack(live) : undefined) };
    globalThis.fromUuid = async uuid => (live.has(uuid.slice(PACK.length)) ? item(uuid) : null);
    globalThis.CONFIG = { Dice: { randomUniform: seededRng(1) } };
    await game.settings.set("loot-crates", "pools", structuredClone(POOLS));
    await game.settings.set("loot-crates", "boxes", { box: BOX });
    // Before any sweep the shop still advertises the dead rarities: that's the bug.
    expect(oddsTable(BOX, game.settings.get("loot-crates", "pools")).map(o => o.rarity)).toEqual(["common", "rare", "legendary"]);

    const warn = console.warn;
    console.warn = () => {};
    try {
      for (let i = 0; i < 1000; i++) await deliver({ type: "pull", requestId: `r${i}`, boxId: "box", actorId: "actor1", userId: "p1" });
    } finally { console.warn = warn; }

    expect(emitted.filter(m => m.type === "error")).toEqual([]);
    const reveals = emitted.filter(m => m.type === "reveal");
    expect(reveals).toHaveLength(1000);
    for (const r of reveals) {
      expect(r.result.rarity).toBe("common");
      for (const c of r.strip.cards) expect(live.has(c.uuid.slice(PACK.length))).toBe(true);
    }
    expect(actor.system.currency.gp).toBe(0);
    expect(actor.items).toHaveLength(1000);

    const saved = game.settings.get("loot-crates", "pools").loot.entries;
    expect(saved.filter(e => e.missing).map(e => e.name)).toEqual(["Flame Tongue", "Vorpal Sword"]);
    expect(oddsTable(BOX, game.settings.get("loot-crates", "pools"))).toEqual([{ rarity: "common", chance: 1 }]);
    // Reported once, naming the pool and the entries, not once per pull.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Flame Tongue in Treasure");
    expect(warnings[0]).toContain("Vorpal Sword in Treasure");
  }, 60000);

  it("clears the flag when the source comes back", async () => {
    const { game, deliver } = makeWorld({ user: GM });
    const live = new Set(["c1", "c2", "r1", "l1"]);
    game.packs = { get: () => warmPack(live) };
    const pools = structuredClone(POOLS);
    pools.loot.entries[2].missing = true;
    await game.settings.set("loot-crates", "pools", pools);
    await game.settings.set("loot-crates", "boxes", { box: BOX });
    const info = console.info;
    console.info = () => {};
    try { await deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1" }); } finally { console.info = info; }
    expect(game.settings.get("loot-crates", "pools").loot.entries.some(e => e.missing)).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("doesn't fetch a cold pack's index before the roll, and still never draws a dead entry from it", async () => {
    const actor = makeActor(100 * 10);
    const { game, emitted, deliver } = makeWorld({ user: GM, actor });
    const live = new Set(["c1", "c2"]);
    let fetches = 0;
    game.packs = { get: () => ({ indexed: false, getIndex: async () => { fetches++; return new Map(); } }) };
    globalThis.fromUuid = async uuid => (live.has(uuid.slice(PACK.length)) ? item(uuid) : null);
    globalThis.CONFIG = { Dice: { randomUniform: seededRng(5) } };
    await game.settings.set("loot-crates", "pools", structuredClone(POOLS));
    await game.settings.set("loot-crates", "boxes", { box: BOX });
    const warn = console.warn;
    console.warn = () => {};
    try {
      for (let i = 0; i < 100; i++) await deliver({ type: "pull", requestId: `r${i}`, boxId: "box", actorId: "actor1", userId: "p1" });
    } finally { console.warn = warn; }
    expect(fetches).toBe(0);
    const reveals = emitted.filter(m => m.type === "reveal");
    expect(reveals).toHaveLength(100);
    expect(reveals.every(r => r.result.rarity === "common")).toBe(true);
    // One charge per sale, never one for a dead draw.
    expect(actor.items).toHaveLength(100);
    expect(actor.system.currency.gp).toBe(0);
    // The dead ones were drawn at some point and flagged by the roll itself.
    const saved = game.settings.get("loot-crates", "pools").loot.entries;
    expect(saved.filter(e => e.missing).map(e => e.name)).toEqual(["Flame Tongue", "Vorpal Sword"]);
  }, 30000);

  it("leaves the flags alone when a pack's index can't be read", async () => {
    const actor = makeActor();
    const { game, emitted, deliver } = makeWorld({ user: GM, actor });
    game.packs = { get: () => ({ getIndex: async () => { throw new Error("socket closed"); } }) };
    globalThis.fromUuid = async uuid => item(uuid);
    globalThis.CONFIG = { Dice: { randomUniform: seededRng(3) } };
    const pools = structuredClone(POOLS);
    pools.loot.entries[3].missing = true; // the legendary, flagged by an earlier sweep
    await game.settings.set("loot-crates", "pools", pools);
    await game.settings.set("loot-crates", "boxes", { box: BOX });
    const warn = console.warn;
    console.warn = () => {};
    try { await deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1" }); } finally { console.warn = warn; }
    // Nothing newly flagged, nothing revived, no warning to the GM; the sale goes ahead.
    const saved = game.settings.get("loot-crates", "pools").loot.entries;
    expect(saved.filter(e => e.missing).map(e => e.name)).toEqual(["Vorpal Sword"]);
    expect(warnings).toEqual([]);
    expect(emitted.filter(m => m.type === "reveal")).toHaveLength(1);
  });

  it("re-rolls once when a source vanishes after the sweep, and charges only for a live one", async () => {
    const actor = makeActor();
    const events = [];
    const origUpdate = actor.update;
    actor.update = async data => { events.push("charge"); return origUpdate(data); };
    const { game, emitted, deliver } = makeWorld({ user: GM, actor });
    // The sweep sees every world item as present...
    game.items = { get: id => ({ id, name: id, img: "", system: {} }) };
    // ...but the rare's document is gone by the time the roll resolves it.
    globalThis.fromUuid = async uuid => { events.push(`resolve ${uuid}`); return uuid === "Item.rare" ? null : item(uuid); };
    globalThis.CONFIG = { Dice: { randomUniform: () => 0.5 } };
    const pools = { loot: { id: "loot", name: "Treasure", pools: [], entries: [
      { uuid: "Item.common", name: "Torch", img: "", rarity: "common", weight: 1 },
      { uuid: "Item.rare", name: "Flame Tongue", img: "", rarity: "rare", weight: 1 },
    ] } };
    await game.settings.set("loot-crates", "pools", pools);
    await game.settings.set("loot-crates", "boxes", { box: { ...BOX, weights: { common: 1, rare: 100 } } });

    const warn = console.warn, error = console.error;
    const errors = [];
    console.warn = () => {};
    console.error = (...a) => errors.push(a.join(" "));
    try { await deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1" }); } finally { console.warn = warn; console.error = error; }

    // The sweep itself ran and saw the rare as live (a failed sweep would
    // also reach the re-roll, and prove nothing about the race).
    expect(errors).toEqual([]);
    expect(emitted.filter(m => m.type === "error")).toEqual([]);
    expect(emitted.find(m => m.type === "reveal").result.uuid).toBe("Item.common");
    expect(events).toEqual(["resolve Item.rare", "resolve Item.common", "charge"]);
    expect(actor.updates).toBe(1);
    expect(actor.system.currency.gp).toBe(490);
    expect(game.settings.get("loot-crates", "pools").loot.entries.find(e => e.uuid === "Item.rare").missing).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Flame Tongue in Treasure");
  });
});

describe("the pull log and a GM's rarity", () => {
  const entry = over => ({ uuid: "rope", name: "Rope", img: "", rarity: "uncommon", sourceRarity: "uncommon", weight: 1, ...over });
  async function pullWith(e, sourceRarities) {
    const { game, deliver } = makeWorld({ user: GM });
    globalThis.fromUuid = async uuid => ({ name: "Rope", img: "", uuid, toObject: () => ({ name: "Rope", type: "loot", flags: {}, system: { rarities: sourceRarities } }) });
    await game.settings.set("loot-crates", "pools", { pool: { ...POOL, entries: [e] } });
    await game.settings.set("loot-crates", "boxes", { box: { ...box({}), weights: { [e.rarityOverride ?? e.rarity]: 1 } } });
    await deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1" });
    return game.settings.get("loot-crates", "pullLog")[0];
  }

  it("records the source's rarity when the GM's differs from it", async () => {
    const row = await pullWith(entry({ rarityOverride: "legendary" }), ["uncommon"]);
    expect(row.rarity).toBe("legendary");
    expect(row.sourceRarity).toEqual(["uncommon"]);
  });

  it("leaves it off a row drawn at the source's own rarity", async () => {
    expect(await pullWith(entry(), ["uncommon"])).not.toHaveProperty("sourceRarity");
    expect(await pullWith(entry({ rarityOverride: "uncommon" }), ["uncommon"])).not.toHaveProperty("sourceRarity");
  });

  it("records an empty set when the source had no rarity", async () => {
    const row = await pullWith(entry({ rarity: "common", sourceRarity: "", rarityOverride: "rare" }), []);
    expect(row.sourceRarity).toEqual([]);
  });
});
