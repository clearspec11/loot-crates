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
vi.mock("../module/scripts/foundry/reveal.js", () => ({ showReveal: vi.fn(async () => ({ landed: Promise.resolve() })) }));
vi.mock("../module/scripts/foundry/chat.js", () => ({ postPullCard: vi.fn(async () => null) }));

const { registerSocket, requestPull, restCompleted, owedRests, settleOwedRests, _resetOwedSent, OWED_RESEND_MS, GM_TIMEOUT_MS, WAIT_NOTICE_MS, TIMED_OUT, SLOW_PULL_MS, _resetSlowWarning } = await import("../module/scripts/foundry/socket.js");
const { registerSettings, setStoreListener, appendLog, sweepAllPools, enqueueWrite, updateBox, INDEX_FIELDS, todayKey } = await import("../module/scripts/foundry/store.js");
const { storeRedraw, REDRAW_DELAY_MS } = await import("../module/scripts/core/redraw.js");
const { refundPull } = await import("../module/scripts/foundry/refund.js");
const { PullError } = await import("../module/scripts/foundry/pull.js");
const { seededRng, oddsTable } = await import("../module/scripts/core/odds.js");
const { restocked } = await import("../module/scripts/core/limits.js");
const { showReveal } = await import("../module/scripts/foundry/reveal.js");
const { postPullCard } = await import("../module/scripts/foundry/chat.js");

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
  // Like Foundry, a world setting's onChange runs after its write lands.
  const onChange = new Map();
  const handlers = [];
  const emitted = [];
  const game = {
    user,
    users: { activeGM, get: id => [GM, PLAYER].find(u => u.id === id) ?? null },
    actors: { get: id => (id === actor.id ? actor : null) },
    settings: {
      register: (ns, key, { default: def, onChange: fn }) => { settings.set(`${ns}.${key}`, def); if (fn) onChange.set(`${ns}.${key}`, fn); },
      get: (ns, key) => settings.get(`${ns}.${key}`),
      async set(ns, key, value) { await tick(); settings.set(`${ns}.${key}`, value); onChange.get(`${ns}.${key}`)?.(value); },
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  _resetSlowWarning();
  showReveal.mockReset().mockImplementation(async () => ({ landed: Promise.resolve() }));
  postPullCard.mockClear();
  delete globalThis.game;
  delete globalThis.foundry;
  delete globalThis.fromUuid;
  delete globalThis.ui;
  setStoreListener(null);
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

  it("sends the price on the Buy pressed with the pull, and none when it has none", async () => {
    const { emitted } = makeWorld({ user: PLAYER });
    requestPull({ boxId: "box", actorId: "actor1", price: 10 });
    requestPull({ boxId: "box", actorId: "actor1" });
    expect(emitted[0]).toMatchObject({ type: "pull", boxId: "box", price: 10 });
    expect("price" in emitted[1]).toBe(false);
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

  // The buyer's wait ran out after the GM had charged: the sale stands, once,
  // and the GM is told who, what and where to refund it.
  it("tells the GM and the buyer about a cancel that came after the charge, marks the log row, and charges once", async () => {
    const warnings = [];
    globalThis.ui = { notifications: { warn: (...a) => warnings.push(a) } };
    const { game, actor, emitted, deliver } = makeWorld({ user: GM });
    await seed(game, {});
    // What each pull log write told the open windows: whether the row was
    // marked by then (an open Pull log redraws from it).
    const heard = [];
    setStoreListener(key => { if (key === "pullLog") heard.push(!!game.settings.get("loot-crates", "pullLog")[0]?.lateCancel); });
    const warn = console.warn;
    console.warn = () => {};
    try {
      await deliver({ type: "pull", requestId: "slow", boxId: "box", actorId: "actor1", userId: "p1" });
      await deliver({ type: "cancel", requestId: "slow", userId: "p1" });
      await enqueueWrite(() => {});
      // A second cancel for the same pull says nothing more.
      await deliver({ type: "cancel", requestId: "slow", userId: "p1" });
      await enqueueWrite(() => {});
    } finally { console.warn = warn; }
    expect(actor.system.currency.gp).toBe(490);
    expect(actor.items).toHaveLength(1);
    const item = emitted.find(m => m.type === "reveal").result.name;
    expect(warnings).toHaveLength(1);
    const [text, options] = warnings[0];
    expect(text).toContain("Player gave up waiting on Test Crate");
    expect(text).toContain(`Crate Tester had already been charged and got ${item}.`);
    expect(text).toContain("Refund on the marked row in the Pull log");
    expect(options?.permanent).not.toBe(true);
    expect(emitted.filter(m => m.type === "late")).toEqual([{ type: "late", requestId: "slow", userId: "p1", boxName: "Test Crate", got: `got ${item}`, actorName: "Crate Tester" }]);
    const rows = game.settings.get("loot-crates", "pullLog");
    expect(rows).toHaveLength(1);
    expect(rows[0].lateCancel).toEqual(expect.any(Number));
    expect(rows[0].id).toBe(emitted.find(m => m.type === "reveal").logId);
    // The pull's row, then the late mark: the second write reaches the
    // listener with the mark in place.
    expect(heard).toEqual([false, true]);
  });

  it("answers a cancel that arrives while the coins are being taken as a late one, after the row is written", async () => {
    const warnings = [];
    globalThis.ui = { notifications: { warn: (...a) => warnings.push(a) } };
    const { game, actor, emitted, deliver } = makeWorld({ user: GM });
    await seed(game, {});
    // The cancel lands during the grant: past the last check, before the reveal.
    const create = actor.createEmbeddedDocuments;
    actor.createEmbeddedDocuments = async (...a) => { await deliver({ type: "cancel", requestId: "mid", userId: "p1" }); return create(...a); };
    const warn = console.warn;
    console.warn = () => {};
    try {
      await deliver({ type: "pull", requestId: "mid", boxId: "box", actorId: "actor1", userId: "p1" });
      await enqueueWrite(() => {});
    } finally { console.warn = warn; }
    expect(actor.system.currency.gp).toBe(490);
    expect(emitted.map(m => m.type)).toEqual(["reveal", "late"]);
    expect(warnings).toHaveLength(1);
    expect(game.settings.get("loot-crates", "pullLog")[0].lateCancel).toEqual(expect.any(Number));
  });

  it("tells a buyer whose crate opened after all, and no one else", async () => {
    const infos = [];
    globalThis.ui = { notifications: { info: (...a) => infos.push(a) } };
    const { deliver } = makeWorld({ user: PLAYER });
    await deliver({ type: "late", requestId: "x", userId: "someone-else", boxName: "Test Crate", got: "got Rope", actorName: "Other" });
    expect(infos).toEqual([]);
    await deliver({ type: "late", requestId: "x", userId: "p1", boxName: "Test Crate", got: "got Rope", actorName: "Crate Tester" });
    expect(infos).toHaveLength(1);
    expect(infos[0][0]).toBe("Your Test Crate went through after all: Crate Tester got Rope. Ask the GM if you'd like it refunded.");
    // The dice's phrase travels as the kind wrote it, never as an item name.
    await deliver({ type: "late", requestId: "y", userId: "p1", boxName: "Dragon's Teeth", got: "rolled 4, 6, 5: 15 beats the dragon's 12", actorName: "Crate Tester" });
    expect(infos[1][0]).toBe("Your Dragon's Teeth went through after all: Crate Tester rolled 4, 6, 5: 15 beats the dragon's 12. Ask the GM if you'd like it refunded.");
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

  it("a price changed after the Buy is rejected with nothing charged", async () => {
    // The shop showed 10 gp; the GM's edit is queued ahead of the pull that
    // is already on its way, as store.js updateBox puts it in the write queue.
    const { game, actor, emitted, deliver } = makeWorld({ user: GM });
    await seed(game, { stock: 5 });
    const edit = updateBox("box", b => ({ ...b, price: 200 }));
    await deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1", price: 10 });
    await edit;
    expect(emitted).toEqual([{ type: "error", requestId: "r1", userId: "p1", message: "Test Crate now costs 200 gp (you pressed 10 gp). Nothing was charged." }]);
    expect(actor.system.currency.gp).toBe(500);
    expect(actor.updates).toBe(0);
    expect(actor.items).toHaveLength(0);
    expect(game.settings.get("loot-crates", "pullLog")).toHaveLength(0);
    expect(game.settings.get("loot-crates", "boxes").box.rules.stock).toBe(5);
    expect(showReveal).not.toHaveBeenCalled();

    // Pressed again once the shop shows 200 gp: charged as before.
    await deliver({ type: "pull", requestId: "r2", boxId: "box", actorId: "actor1", userId: "p1", price: 200 });
    expect(emitted.filter(m => m.type === "reveal")).toHaveLength(1);
    expect(emitted.at(-1)).toMatchObject({ type: "reveal", requestId: "r2", box: { price: 200 } });
    expect(actor.system.currency.gp).toBe(300);
    expect(actor.items).toHaveLength(1);
    expect(game.settings.get("loot-crates", "pullLog")).toMatchObject([{ price: 200 }]);
    expect(game.settings.get("loot-crates", "boxes").box.rules.stock).toBe(4);
  });

  it("refuses a pull on a game taken off the shelf after the Buy, moving no coins (shelf.js)", async () => {
    // The player's shop showed the crate; the GM's toggle is queued ahead
    // of the pull already on its way, as updateBox puts it in the write queue.
    const { game, actor, emitted, deliver } = makeWorld({ user: GM });
    await seed(game, { stock: 5 });
    const off = updateBox("box", b => ({ ...b, rules: { ...b.rules, shelved: false } }));
    await deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1", price: 10 });
    await off;
    expect(emitted).toEqual([{ type: "error", requestId: "r1", userId: "p1", message: "Test Crate is no longer on the shelf. Nothing was charged." }]);
    expect(actor.system.currency.gp).toBe(500);
    expect(actor.updates).toBe(0);
    expect(actor.items).toHaveLength(0);
    expect(game.settings.get("loot-crates", "pullLog")).toHaveLength(0);
    expect(game.settings.get("loot-crates", "boxes").box.rules.stock).toBe(5);
    expect(showReveal).not.toHaveBeenCalled();

    // Back on the shelf (the flag dropped), the same press is served.
    await updateBox("box", b => ({ ...b, rules: { stock: b.rules.stock } }));
    await deliver({ type: "pull", requestId: "r2", boxId: "box", actorId: "actor1", userId: "p1", price: 10 });
    expect(emitted.at(-1)).toMatchObject({ type: "reveal", requestId: "r2" });
    expect(actor.system.currency.gp).toBe(490);
  });

  it("serves a pull without a price (an older client) at the box's price", async () => {
    const { game, actor, emitted, deliver } = makeWorld({ user: GM });
    await seed(game, {});
    await updateBox("box", b => ({ ...b, price: 25 }));
    await deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1" });
    expect(emitted.filter(m => m.type === "reveal")).toHaveLength(1);
    expect(actor.system.currency.gp).toBe(475);
  });

  it("refuses the GM's own stale Buy too, in its shop rather than over the socket", async () => {
    const { game, actor, emitted } = makeWorld({ user: GM });
    await seed(game, {});
    const edit = updateBox("box", b => ({ ...b, price: 200 }));
    const mine = requestPull({ boxId: "box", actorId: "actor1", price: 10 });
    await edit;
    await expect(mine).rejects.toThrow(PullError);
    await expect(mine).rejects.toThrow("Test Crate now costs 200 gp (you pressed 10 gp). Nothing was charged.");
    expect(actor.system.currency.gp).toBe(500);
    expect(emitted).toEqual([]);
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

describe("stock and the limit per character on the GM", () => {
  it("refuses the second of two queued buys at the limit with the sentence, charging once", async () => {
    const { game, actor, emitted, deliver } = makeWorld({ user: GM });
    await seed(game, { perCharacter: { max: 1, per: "ever" } });
    await Promise.all([
      deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1" }),
      deliver({ type: "pull", requestId: "r2", boxId: "box", actorId: "actor1", userId: "p1" }),
    ]);
    expect(emitted.filter(m => m.type === "reveal").map(m => m.requestId)).toEqual(["r1"]);
    expect(emitted.filter(m => m.type === "error")).toEqual([{ type: "error", requestId: "r2", userId: "p1", message: "Test Crate: limit reached, 1 of 1 for Crate Tester. Nothing was charged." }]);
    expect(actor.updates).toBe(1);
    expect(actor.system.currency.gp).toBe(490);
    expect(game.settings.get("loot-crates", "pullLog")).toHaveLength(1);
  });

  it("gives the purchase back on a refund, with nothing reset by hand", async () => {
    const { game, actor, emitted, deliver } = makeWorld({ user: GM });
    actor.items.get = () => null;
    await seed(game, { perCharacter: { max: 1, per: "ever" } });
    await deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1" });
    await deliver({ type: "pull", requestId: "r2", boxId: "box", actorId: "actor1", userId: "p1" });
    expect(emitted.filter(m => m.type === "error")).toHaveLength(1);
    const rowId = game.settings.get("loot-crates", "pullLog")[0].id;
    expect((await refundPull(rowId)).status).toBe("refunded");
    await deliver({ type: "pull", requestId: "r3", boxId: "box", actorId: "actor1", userId: "p1" });
    expect(emitted.filter(m => m.type === "reveal").map(m => m.requestId)).toEqual(["r1", "r3"]);
  });

  it("writes the in-game day on every row, and a limit per day opens again the next day", async () => {
    const { game, emitted, deliver } = makeWorld({ user: GM });
    game.time = { components: { year: 1, day: 5 } };
    await seed(game, { perCharacter: { max: 1, per: "day" } });
    await deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1" });
    expect(game.settings.get("loot-crates", "pullLog")[0].day).toBe("y1d5");
    await deliver({ type: "pull", requestId: "r2", boxId: "box", actorId: "actor1", userId: "p1" });
    expect(emitted.find(m => m.type === "error")?.message).toBe("Test Crate: limit reached, 1 of 1 for Crate Tester until tomorrow. Nothing was charged.");
    game.time = { components: { year: 1, day: 6 } };
    await deliver({ type: "pull", requestId: "r3", boxId: "box", actorId: "actor1", userId: "p1" });
    expect(emitted.filter(m => m.type === "reveal").map(m => m.requestId)).toEqual(["r1", "r3"]);
  });

  it("keeps the GM's number as a pull takes one and a refund puts it back, never past it", async () => {
    const { game, actor, deliver } = makeWorld({ user: GM });
    actor.items.get = () => null;
    await seed(game, { stock: 3, stockMax: 3 });
    await deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1" });
    expect(game.settings.get("loot-crates", "boxes").box.rules).toMatchObject({ stock: 2, stockMax: 3 });
    // The GM restocks before refunding: the refund can't push it to 4 of 3.
    await updateBox("box", fresh => ({ ...fresh, rules: restocked(fresh.rules) }));
    await refundPull(game.settings.get("loot-crates", "pullLog")[0].id);
    expect(game.settings.get("loot-crates", "boxes").box.rules).toMatchObject({ stock: 3, stockMax: 3 });
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

  it("says nothing to the buyer or the GM when a hidden tab's pull is quick", async () => {
    const warnings = [];
    globalThis.ui = { notifications: { warn: (...a) => warnings.push(a) } };
    vi.stubGlobal("document", { visibilityState: "hidden" });
    const { game, emitted, deliver } = makeWorld({ user: GM });
    await seed(game, {});
    await deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1" });
    await deliver({ type: "pull", requestId: "r2", boxId: "box", actorId: "actor1", userId: "p1" });
    expect(emitted.map(m => m.type)).toEqual(["reveal", "reveal"]);
    expect(warnings).toEqual([]);
  });

  it("warns the GM once, with the time, and tells the buyer why, when a hidden tab's pull is slow", async () => {
    const warnings = [];
    globalThis.ui = { notifications: { warn: (...a) => warnings.push(a) } };
    vi.stubGlobal("document", { visibilityState: "hidden" });
    // A clock that the source lookup moves on by 2.5 s, as a throttled tab's
    // server round trip might.
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const { game, emitted, deliver } = makeWorld({ user: GM });
    const resolve = globalThis.fromUuid;
    globalThis.fromUuid = async uuid => { clock += SLOW_PULL_MS + 500; return resolve(uuid); };
    await seed(game, {});
    const warn = console.warn;
    console.warn = () => {};
    try {
      await deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1" });
      await deliver({ type: "pull", requestId: "r2", boxId: "box", actorId: "actor1", userId: "p1" });
    } finally { console.warn = warn; }
    // The buyer hears why before the reveal, once per pull.
    expect(emitted.map(m => m.type)).toEqual(["ack", "reveal", "ack", "reveal"]);
    expect(emitted[0]).toEqual({ type: "ack", requestId: "r1", userId: "p1", hidden: true });
    // The GM once per session, in a toast that goes away by itself.
    expect(warnings).toHaveLength(1);
    const [text, options] = warnings[0];
    const secs = Number(text.match(/Crate Tester's crate took (\d+\.\d) s to open/)?.[1]);
    expect(secs).toBeGreaterThan(SLOW_PULL_MS / 1000);
    expect(text).toContain("in the background");
    expect(options?.permanent).not.toBe(true);
  });

  it("tells the buyer as soon as a hidden tab's pull is slow, not when the slow step ends", async () => {
    // Round 6 carried defect (b): the ack was only checked between doPull's
    // steps, so a buyer whose pull sat 20 s in one step (a throttled server
    // round trip) or in the queue behind another pull heard nothing until it
    // ended, which is when the reveal came anyway.
    vi.stubGlobal("document", { visibilityState: "hidden" });
    const { game, emitted, deliver } = makeWorld({ user: GM });
    await seed(game, {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    const resolve = globalThis.fromUuid;
    let release;
    const gate = new Promise(r => { release = r; });
    globalThis.fromUuid = async uuid => { await gate; return resolve(uuid); };
    const warn = console.warn;
    console.warn = () => {};
    try {
      const first = deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1" });
      // A second buyer's pull waits in the queue behind the first.
      const second = deliver({ type: "pull", requestId: "r2", boxId: "box", actorId: "actor1", userId: "p1" });
      await vi.advanceTimersByTimeAsync(SLOW_PULL_MS - 100);
      expect(emitted).toEqual([]);
      await vi.advanceTimersByTimeAsync(200);
      // Both hear why within the slow mark, while the first is still stuck.
      expect(emitted).toEqual([
        { type: "ack", requestId: "r1", userId: "p1", hidden: true },
        { type: "ack", requestId: "r2", userId: "p1", hidden: true },
      ]);
      release();
      await vi.advanceTimersByTimeAsync(SLOW_PULL_MS * 2);
      await Promise.all([first, second]);
    } finally { console.warn = warn; release(); }
    // Once per pull, and never after its reveal.
    expect(emitted.map(m => `${m.type} ${m.requestId}`)).toEqual(["ack r1", "ack r2", "reveal r1", "reveal r2"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends no ack while the tab is visible, sends it once the tab hides mid-pull, never for the GM's own pull", async () => {
    vi.stubGlobal("document", { visibilityState: "visible" });
    const { game, emitted, deliver } = makeWorld({ user: GM });
    await seed(game, {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    const resolve = globalThis.fromUuid;
    let release;
    const gate = new Promise(r => { release = r; });
    globalThis.fromUuid = async uuid => { await gate; return resolve(uuid); };
    const warn = console.warn;
    console.warn = () => {};
    try {
      const first = deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1" });
      const own = deliver({ type: "pull", requestId: "r2", boxId: "box", actorId: "actor1", userId: "gm" });
      await vi.advanceTimersByTimeAsync(SLOW_PULL_MS + 500);
      expect(emitted).toEqual([]);
      // The GM switches tabs while the buyer's pull is still stuck.
      globalThis.document.visibilityState = "hidden";
      await vi.advanceTimersByTimeAsync(1000);
      expect(emitted).toEqual([{ type: "ack", requestId: "r1", userId: "p1", hidden: true }]);
      await vi.advanceTimersByTimeAsync(SLOW_PULL_MS * 2);
      expect(emitted).toHaveLength(1);
      release();
      await vi.advanceTimersByTimeAsync(100);
      await Promise.all([first, own]);
    } finally { console.warn = warn; release(); }
    expect(emitted.map(m => `${m.type} ${m.requestId}`)).toEqual(["ack r1", "reveal r1", "reveal r2"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("posts the chat card with the result, without waiting for its own spin to land", async () => {
    // A hidden GM page: its reveal never lands while nobody looks.
    showReveal.mockImplementation(async () => ({ landed: new Promise(() => {}) }));
    const { game, emitted, deliver } = makeWorld({ user: GM });
    await seed(game, {});
    await deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1" });
    const reveal = emitted.find(m => m.type === "reveal");
    expect(postPullCard).toHaveBeenCalledTimes(1);
    expect(postPullCard).toHaveBeenCalledWith(reveal);
    // The card gets the id of the log row this pull wrote, for the refund.
    const rowId = game.settings.get("loot-crates", "pullLog")[0].id;
    expect(reveal.logId).toBe(rowId);
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
    expect(emitted.find(m => m.type === "reveal").odds.map(o => o.rarity)).toEqual(["common"]);
    expect(events).toEqual(["resolve Item.rare", "resolve Item.common", "charge"]);
    expect(actor.updates).toBe(1);
    expect(actor.system.currency.gp).toBe(490);
    expect(game.settings.get("loot-crates", "pools").loot.entries.find(e => e.uuid === "Item.rare").missing).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Flame Tongue in Treasure");
  });

  it("shows the reveal the odds the re-roll was made at, without the rarity that went missing", async () => {
    const { game, emitted, deliver } = makeWorld({ user: GM });
    game.items = { get: id => ({ id, name: id, img: "", system: {} }) };
    // The rare's document is gone by the roll, and the GM's client can't save
    // the missing flag either: the stored pools still count the rare.
    globalThis.fromUuid = async uuid => (uuid === "Item.rare" ? null : item(uuid));
    globalThis.CONFIG = { Dice: { randomUniform: () => 0.5 } };
    await game.settings.set("loot-crates", "pools", { loot: { id: "loot", name: "Treasure", pools: [], entries: [
      { uuid: "Item.common", name: "Torch", img: "", rarity: "common", weight: 1 },
      { uuid: "Item.rare", name: "Flame Tongue", img: "", rarity: "rare", weight: 1 },
    ] } });
    await game.settings.set("loot-crates", "boxes", { box: { ...BOX, weights: { common: 1, rare: 100 } } });
    const set = game.settings.set;
    game.settings.set = async (ns, key, value) => { if (key === "pools") throw new Error("disk full"); return set(ns, key, value); };

    const warn = console.warn, error = console.error;
    console.warn = () => {};
    console.error = () => {};
    try { await deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1" }); } finally { console.warn = warn; console.error = error; }

    const reveal = emitted.find(m => m.type === "reveal");
    expect(reveal.result.uuid).toBe("Item.common");
    expect(game.settings.get("loot-crates", "pools").loot.entries.some(e => e.missing)).toBe(false);
    expect(reveal.odds).toEqual([{ rarity: "common", chance: 1, label: "100%" }]);
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

describe("open windows after a pull", () => {
  it("redraw once for the three settings a pull writes, after they are all written", async () => {
    const { game, deliver } = makeWorld({ user: GM });
    await seed(game, { stock: 3 });
    const refreshShop = vi.fn();
    const refreshManager = vi.fn();
    const keys = [];
    const redraw = storeRedraw({ refreshShop, refreshManager });
    setStoreListener(key => { keys.push(key); redraw(key); });
    await deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1" });
    expect([...keys].sort()).toEqual(["actorState", "boxes", "pullLog"]);
    expect(refreshShop).not.toHaveBeenCalled();
    await new Promise(r => setTimeout(r, REDRAW_DELAY_MS + 50));
    expect(refreshShop).toHaveBeenCalledTimes(1);
    expect(refreshManager).toHaveBeenCalledTimes(1);
    expect([...refreshManager.mock.calls[0][0]].sort()).toEqual(["actorState", "boxes", "pullLog"]);
    expect(game.settings.get("loot-crates", "boxes").box.rules.stock).toBe(2);
  });
});

describe("the reveal's odds", () => {
  it("are the buyer's, as their shop showed them: pity due, only the guaranteed rarity", async () => {
    const { game, emitted, deliver } = makeWorld({ user: GM });
    const pool = { ...POOL, entries: [...POOL.entries, { uuid: "r", name: "r", img: "", rarity: "rare", weight: 1 }] };
    await game.settings.set("loot-crates", "pools", { pool });
    await game.settings.set("loot-crates", "boxes", { box: { ...box({ pity: { after: 2, minRarity: "rare" } }), weights: { common: 9, rare: 1 } } });
    await game.settings.set("loot-crates", "actorState", { "actor1.box": { sinceRare: 2 } });
    await deliver({ type: "pull", requestId: "due", boxId: "box", actorId: "actor1", userId: "p1" });
    const due = emitted.find(m => m.type === "reveal" && m.requestId === "due");
    expect(due.odds).toEqual([{ rarity: "rare", chance: 1, label: "100%" }]);
    expect(due.result.rarity).toBe("rare");
    // The pity reset after the Rare: the next reveal shows the box's full odds.
    await deliver({ type: "pull", requestId: "next", boxId: "box", actorId: "actor1", userId: "p1" });
    const next = emitted.find(m => m.type === "reveal" && m.requestId === "next");
    expect(next.odds.map(o => `${o.rarity} ${o.label}`)).toEqual(["common 90%", "rare 10%"]);
    // Each row keeps the count it was pulled at and whether it reset it,
    // so a refund can put the count back (odds.js undoPull).
    const [second, first] = game.settings.get("loot-crates", "pullLog");
    expect(first).toMatchObject({ before: { sinceRare: 2, hadItem: false }, resetPity: true });
    expect(second).toMatchObject({ before: { sinceRare: 0 }, resetPity: second.rarity === "rare" });
  });

  it("carry the buyer's state from before the pull, so a spinning client can hold its shop back", async () => {
    const { game, emitted, deliver } = makeWorld({ user: GM });
    await game.settings.set("loot-crates", "pools", { pool: POOL });
    await game.settings.set("loot-crates", "boxes", { box: box({ pity: { after: 8, minRarity: "rare" } }) });
    await game.settings.set("loot-crates", "actorState", { "actor1.box": { sinceRare: 5, owned: ["x"], pulls: 5 } });
    await deliver({ type: "pull", requestId: "s1", boxId: "box", actorId: "actor1", userId: "p1" });
    const reveal = emitted.find(m => m.type === "reveal" && m.requestId === "s1");
    expect(reveal.stateBefore).toEqual({ sinceRare: 5, owned: ["x"], pulls: 5 });
    // The world setting has moved on; the reveal's copy hasn't.
    expect(game.settings.get("loot-crates", "actorState")["actor1.box"]).toMatchObject({ sinceRare: 6, pulls: 6 });
    // A first pull: an empty record, spelled out.
    await deliver({ type: "pull", requestId: "s2", boxId: "box", actorId: "actor1", userId: "p1" });
    await game.settings.set("loot-crates", "actorState", {});
    await deliver({ type: "pull", requestId: "s3", boxId: "box", actorId: "actor1", userId: "p1" });
    expect(emitted.find(m => m.requestId === "s3" && m.type === "reveal").stateBefore).toEqual({ sinceRare: 0, owned: [], pulls: 0 });
  });
});

describe("a day that ends at a long rest, with dnd5e's calendar off", () => {
  const OTHER = { id: "p2", name: "Other player" };
  const WELL_GAME = { id: "well", kind: "well", name: "Wishing Well", price: 0.1, pools: [{ id: "pool", share: 1 }], weights: { common: 1 }, odds: { nothing: 100, coin: 0, item: 0 }, rules: { cap: 3 } };

  // dnd5e 6's default: the calendar off and no daily recovery chosen, so a
  // long rest doesn't move game.time, which stays on one day throughout.
  function restWorld({ user = GM, calendar = { enabled: false, dailyRecovery: "" } } = {}) {
    const world = makeWorld({ user });
    world.settings.set("dnd5e.calendarConfig", calendar);
    world.game.time = { components: { year: 1, day: 5 }, worldTime: 86400 * 5 };
    world.game.users.get = id => [GM, PLAYER, OTHER].find(u => u.id === id) ?? null;
    // Only the GM and Player own Crate Tester.
    world.actor.testUserPermission = u => u.id === GM.id || u.id === PLAYER.id;
    return world;
  }
  const throwAt = (world, requestId) => world.deliver({ type: "pull", requestId, boxId: "well", actorId: "actor1", userId: "p1", price: 0.1 });
  const errorFor = (world, requestId) => world.emitted.find(m => m.type === "error" && m.requestId === requestId)?.message ?? null;
  const revealed = world => world.emitted.filter(m => m.type === "reveal").map(m => m.requestId);

  beforeEach(async () => {
    await import("../module/scripts/games/well.js");
    globalThis.CONFIG = { Dice: { randomUniform: () => 0.5 } };
  });
  afterEach(() => { delete globalThis.CONFIG; });

  it("caps the well at three throws, opens it again when the GM hears the owner's new day, and ignores a non-owner and a short rest", async () => {
    const world = restWorld();
    const { game, deliver } = world;
    await game.settings.set("loot-crates", "pools", { pool: POOL });
    await game.settings.set("loot-crates", "boxes", { well: WELL_GAME });
    for (const id of ["t1", "t2", "t3"]) await throwAt(world, id);
    await throwAt(world, "t4");
    expect(revealed(world)).toEqual(["t1", "t2", "t3"]);
    expect(errorFor(world, "t4")).toBe("The well is still until tomorrow (3 of 3 today).");
    expect(game.settings.get("loot-crates", "pullLog").map(r => r.day)).toEqual(["r0", "r0", "r0"]);

    // Someone who doesn't own Crate Tester can't end its day.
    await deliver({ type: "newDay", actorId: "actor1", userId: "p2" });
    await throwAt(world, "t5");
    expect(errorFor(world, "t5")).toBe("The well is still until tomorrow (3 of 3 today).");
    // A short rest isn't a new day.
    await restCompleted(world.actor, { type: "short", newDay: false }, { type: "short", newDay: false });
    await throwAt(world, "t6");
    expect(errorFor(world, "t6")).toBe("The well is still until tomorrow (3 of 3 today).");
    expect(game.settings.get("loot-crates", "actorState").days).toBeUndefined();

    // The owner's long rest: the fourth throw is taken, with no clock moved.
    await deliver({ type: "newDay", actorId: "actor1", userId: "p1" });
    expect(game.settings.get("loot-crates", "actorState").days).toEqual({ actor1: 1 });
    await throwAt(world, "t7");
    expect(revealed(world)).toEqual(["t1", "t2", "t3", "t7"]);
    expect(game.settings.get("loot-crates", "pullLog")[0].day).toBe("r1");
    expect(game.time.components).toEqual({ year: 1, day: 5 });
  });

  it("opens a crate's limit of 1 per day again after a long rest, and leaves the pity state alone", async () => {
    const world = restWorld();
    const { game, deliver, emitted } = world;
    await seed(game, { perCharacter: { max: 1, per: "day" } });
    await deliver({ type: "pull", requestId: "r1", boxId: "box", actorId: "actor1", userId: "p1" });
    await deliver({ type: "pull", requestId: "r2", boxId: "box", actorId: "actor1", userId: "p1" });
    expect(emitted.find(m => m.type === "error")?.message).toBe("Test Crate: limit reached, 1 of 1 for Crate Tester until tomorrow. Nothing was charged.");
    const stateBefore = game.settings.get("loot-crates", "actorState")["actor1.box"];
    await deliver({ type: "newDay", actorId: "actor1", userId: "p2" });
    await deliver({ type: "pull", requestId: "r3", boxId: "box", actorId: "actor1", userId: "p1" });
    expect(emitted.filter(m => m.type === "error")).toHaveLength(2);
    // The GM's own long rest counts on the GM, no message needed.
    await restCompleted(world.actor, { type: "long", newDay: true }, { type: "long", newDay: true });
    expect(game.settings.get("loot-crates", "actorState")).toMatchObject({ days: { actor1: 1 }, "actor1.box": stateBefore });
    await deliver({ type: "pull", requestId: "r4", boxId: "box", actorId: "actor1", userId: "p1" });
    expect(emitted.filter(m => m.type === "reveal").map(m => m.requestId)).toEqual(["r1", "r4"]);
    expect(game.settings.get("loot-crates", "pullLog").map(r => r.day)).toEqual(["r1", "r0"]);
  });

  it("sends a player's long rest to the GM, and only one that starts a new day", async () => {
    const { actor, emitted } = restWorld({ user: PLAYER });
    restCompleted(actor, { type: "long", newDay: true }, { type: "long", newDay: true });
    restCompleted(actor, { type: "long", newDay: false }, { type: "long", newDay: true });
    restCompleted(actor, { type: "short", newDay: false }, { type: "short" });
    // With the world time the rest began, for the calendar's day (below).
    expect(emitted).toEqual([{ type: "newDay", actorId: "actor1", userId: "p1", at: 86400 * 5 }]);
  });

  it("counts rests when the calendar is on but dnd5e's daily recovery is manual", async () => {
    const { game, deliver } = restWorld({ calendar: { enabled: true, dailyRecovery: "manual" } });
    expect(todayKey("actor1")).toBe("r0");
    await deliver({ type: "newDay", actorId: "actor1", userId: "p1" });
    expect(todayKey("actor1")).toBe("r1");
    expect(game.settings.get("loot-crates", "actorState").days).toEqual({ actor1: 1 });
  });
});

/*
  With dnd5e's calendar on, dnd5e moves the clock for a rest only on a GM's
  client, so a player's own long rest is noted as the day it rested into
  and the character's day is the later of that and the clock's (clock.js).
*/
describe("a day with dnd5e's calendar on", () => {
  const WELL_GAME = { id: "well", kind: "well", name: "Wishing Well", price: 0.1, pools: [{ id: "pool", share: 1 }], weights: { common: 1 }, odds: { nothing: 100, coin: 0, item: 0 }, rules: { cap: 2 } };
  const DAY = 86400;
  // The clock at `hour` of day `day` of year 1, read through a calendar
  // of plain 86400 s days, as Foundry's game.time and its calendar give it.
  const at = (day, hour = 12) => day * DAY + hour * 3600;
  const timeAt = seconds => ({ worldTime: seconds, components: { year: 1, day: Math.floor(seconds / DAY) }, calendar: { timeToComponents: s => ({ year: 1, day: Math.floor(s / DAY) }) } });

  function calendarWorld({ user = GM } = {}) {
    const world = makeWorld({ user });
    world.settings.set("dnd5e.calendarConfig", { enabled: true, dailyRecovery: "" });
    world.game.time = timeAt(at(5));
    world.actor.testUserPermission = u => u.id === GM.id || u.id === PLAYER.id;
    return world;
  }
  const throwAt = (world, requestId) => world.deliver({ type: "pull", requestId, boxId: "well", actorId: "actor1", userId: "p1", price: 0.1 });
  const refusal = (world, requestId) => world.emitted.find(m => m.type === "error" && m.requestId === requestId)?.message ?? null;
  const thrown = world => world.emitted.filter(m => m.type === "reveal").map(m => m.requestId);

  beforeEach(async () => {
    await import("../module/scripts/games/well.js");
    globalThis.CONFIG = { Dice: { randomUniform: () => 0.5 } };
  });
  afterEach(() => { delete globalThis.CONFIG; });

  it("ends the day at a player's long rest though the clock stays, and the clock's move over the same night adds none", async () => {
    const world = calendarWorld();
    const { game, deliver } = world;
    await game.settings.set("loot-crates", "pools", { pool: POOL });
    await game.settings.set("loot-crates", "boxes", { well: WELL_GAME });
    for (const id of ["a1", "a2", "a3"]) await throwAt(world, id);
    expect(refusal(world, "a3")).toBe("The well is still until tomorrow (2 of 2 today).");

    // The player's long rest from their sheet: dnd5e left the clock alone.
    await deliver({ type: "newDay", actorId: "actor1", userId: "p1", at: at(5, 22) });
    expect(game.time.worldTime).toBe(at(5));
    expect(todayKey("actor1")).toBe("y1d6");
    expect(game.settings.get("loot-crates", "actorState").restedInto).toEqual({ actor1: { y: 1, d: 6 } });
    await throwAt(world, "b1");
    expect(thrown(world)).toEqual(["a1", "a2", "b1"]);

    // The GM then moves the clock over that night: the same day, not another.
    game.time = timeAt(at(6, 6));
    expect(todayKey("actor1")).toBe("y1d6");
    await throwAt(world, "b2");
    await throwAt(world, "b3");
    expect(refusal(world, "b3")).toBe("The well is still until tomorrow (2 of 2 today).");

    // A refund gives that use back.
    const row = game.settings.get("loot-crates", "pullLog").find(r => r.day === "y1d6");
    expect((await refundPull(row.id)).status).toBe("refunded");
    await throwAt(world, "b4");
    expect(thrown(world)).toEqual(["a1", "a2", "b1", "b2", "b4"]);

    // The clock's own next day is a new day as before.
    game.time = timeAt(at(7, 9));
    expect(todayKey("actor1")).toBe("y1d7");
    await throwAt(world, "c1");
    expect(thrown(world).at(-1)).toBe("c1");
    expect(game.settings.get("loot-crates", "pullLog").map(r => r.day)).toEqual(["y1d7", "y1d6", "y1d6", "y1d6", "y1d5", "y1d5"]);
  });

  it("counts a GM's rest that moved the clock from when it began, so it ends one day, and caps a player's time at the GM's clock", async () => {
    const world = calendarWorld();
    const { game, actor, deliver } = world;
    game.user = { ...GM, isGM: true };
    // A GM's long rest at 22:00 with advanceTime: dnd5e moved the clock eight hours before the hook.
    game.time = timeAt(at(5, 22) + 8 * 3600);
    await restCompleted(actor, { newDay: true }, { newDay: true, advanceTime: true, duration: 480 });
    expect(game.settings.get("loot-crates", "actorState").restedInto).toEqual({ actor1: { y: 1, d: 6 } });
    expect(todayKey("actor1")).toBe("y1d6");
    // A GM's rest in the morning with the clock left alone ends the day too.
    game.time = timeAt(at(6, 8));
    await restCompleted(actor, { newDay: true }, { newDay: true, advanceTime: false, duration: 480 });
    expect(todayKey("actor1")).toBe("y1d7");
    // The character is a day ahead of the clock now: a player's rest the same
    // calendar day, even one claiming a time far past the GM's clock, ends no further day.
    await deliver({ type: "newDay", actorId: "actor1", userId: "p1", at: at(40) });
    expect(todayKey("actor1")).toBe("y1d7");
    // The clock reaches day 7: the same claim is capped at the GM's clock, one more day.
    game.time = timeAt(at(7, 8));
    await deliver({ type: "newDay", actorId: "actor1", userId: "p1", at: at(40) });
    expect(todayKey("actor1")).toBe("y1d8");
    // A rest heard late (an owed one) ends no further day while the character is ahead.
    await deliver({ type: "newDay", actorId: "actor1", userId: "p1", at: at(2) });
    expect(game.settings.get("loot-crates", "actorState").restedInto).toEqual({ actor1: { y: 1, d: 8 } });
    // Someone who doesn't own the character ends nothing; nor does a short rest.
    actor.testUserPermission = u => u.id === GM.id;
    game.time = timeAt(at(8, 8));
    await deliver({ type: "newDay", actorId: "actor1", userId: "p1", at: at(8, 8) });
    await restCompleted(actor, { newDay: false }, { newDay: false });
    expect(todayKey("actor1")).toBe("y1d8");
    // The rest count of calendar-off mode is never touched.
    expect(game.settings.get("loot-crates", "actorState").days).toBeUndefined();
  });

  it("ends one day for two long rests on the same calendar day (the GM's, then the player's), so the well opens at the next midnight", async () => {
    const world = calendarWorld();
    const { game, actor, deliver } = world;
    await game.settings.set("loot-crates", "pools", { pool: POOL });
    await game.settings.set("loot-crates", "boxes", { well: WELL_GAME });
    await throwAt(world, "a1");
    await throwAt(world, "a2");
    // The GM rests the party at 00:00 with advanceTime: the clock moves to 08:00, still day 5.
    game.time = timeAt(at(5, 0) + 8 * 3600);
    await restCompleted(actor, { newDay: true }, { newDay: true, advanceTime: true, duration: 480 });
    expect(todayKey("actor1")).toBe("y1d6");
    await throwAt(world, "b1");
    await throwAt(world, "b2");
    await throwAt(world, "b3");
    expect(refusal(world, "b3")).toBe("The well is still until tomorrow (2 of 2 today).");
    // The player's own rest at 08:00 the same calendar day: no further day.
    await deliver({ type: "newDay", actorId: "actor1", userId: "p1", at: at(5, 8) });
    expect(todayKey("actor1")).toBe("y1d6");
    expect(game.settings.get("loot-crates", "actorState").restedInto).toEqual({ actor1: { y: 1, d: 6 } });
    await throwAt(world, "b4");
    expect(refusal(world, "b4")).toBe("The well is still until tomorrow (2 of 2 today).");
    // A refund still gives a use back.
    const row = game.settings.get("loot-crates", "pullLog").find(r => r.day === "y1d6");
    expect((await refundPull(row.id)).status).toBe("refunded");
    await throwAt(world, "b5");
    expect(thrown(world)).toEqual(["a1", "a2", "b1", "b2", "b5"]);
    // The clock reaches day 6 (the day already rested into), then day 7: the well opens there.
    game.time = timeAt(at(6, 6));
    await throwAt(world, "c1");
    expect(refusal(world, "c1")).toBe("The well is still until tomorrow (2 of 2 today).");
    game.time = timeAt(at(7, 1));
    await throwAt(world, "d1");
    expect(thrown(world).at(-1)).toBe("d1");
    // The rest count of calendar-off mode is never touched.
    expect(game.settings.get("loot-crates", "actorState").days).toBeUndefined();
  });

  it("keeps the rest count and the day rested into apart, so switching the calendar reads neither as the other", async () => {
    const world = calendarWorld();
    const { game, deliver } = world;
    await deliver({ type: "newDay", actorId: "actor1", userId: "p1", at: at(5) });
    expect(todayKey("actor1")).toBe("y1d6");
    await game.settings.set("dnd5e", "calendarConfig", { enabled: false, dailyRecovery: "" });
    expect(todayKey("actor1")).toBe("r0");
    await deliver({ type: "newDay", actorId: "actor1", userId: "p1", at: at(5) });
    expect(todayKey("actor1")).toBe("r1");
    await game.settings.set("dnd5e", "calendarConfig", { enabled: true, dailyRecovery: "" });
    expect(todayKey("actor1")).toBe("y1d6");
  });
});

/*
  A long rest with no GM online: only a GM client writes, so the player's
  client keeps it in its own browser storage and sends it once a GM can
  hear it (socket.js owedRests).
*/
describe("a long rest taken while no GM is online", () => {
  let stored;
  beforeEach(() => {
    _resetOwedSent();
    stored = new Map();
    vi.stubGlobal("localStorage", { getItem: k => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, String(v)), removeItem: k => stored.delete(k) });
  });

  function playerWorld() {
    const world = makeWorld({ user: PLAYER, activeGM: null });
    world.settings.set("dnd5e.calendarConfig", { enabled: false, dailyRecovery: "" });
    world.game.time = { components: { year: 1, day: 5 }, worldTime: 86400 * 5 };
    world.game.world = { id: "w" };
    return world;
  }

  it("keeps the rest in the player's browser, writing nothing to the world, and sends it when a GM loads and asks", async () => {
    const { game, actor, emitted, deliver } = playerWorld();
    restCompleted(actor, { newDay: true }, { newDay: true });
    restCompleted(actor, { newDay: true }, { newDay: true });
    expect(emitted).toEqual([]);
    expect(game.settings.get("loot-crates", "actorState")).toEqual({});
    // Two rests owed for one character are one.
    expect(owedRests()).toEqual({ actor1: { at: 86400 * 5 } });
    expect([...stored.keys()]).toEqual(["loot-crates.owedRests.w.p1"]);
    // Still no GM: nothing to send to.
    expect(settleOwedRests()).toBe(0);

    // A GM comes online and its load asks.
    game.users.activeGM = GM;
    await deliver({ type: "owedRests" });
    expect(emitted).toEqual([{ type: "newDay", actorId: "actor1", userId: "p1", at: 86400 * 5, owed: true }]);
    // Kept until the GM says it was counted, so a GM that dropped it hears it again.
    expect(owedRests()).toEqual({ actor1: { at: 86400 * 5 } });
    await deliver({ type: "newDayCounted", userId: "someone else", actorId: "actor1", at: 86400 * 5 });
    expect(owedRests()).toEqual({ actor1: { at: 86400 * 5 } });
    await deliver({ type: "newDayCounted", userId: "p1", actorId: "actor1", at: 86400 * 5 });
    expect(owedRests()).toEqual({});
    expect(stored.size).toBe(0);
  });

  it("sends what it owes at its own load when a GM is already online", () => {
    const { game, actor, emitted } = playerWorld();
    restCompleted(actor, { newDay: true }, { newDay: true });
    game.users.activeGM = GM;
    expect(settleOwedRests()).toBe(1);
    expect(emitted).toEqual([{ type: "newDay", actorId: "actor1", userId: "p1", at: 86400 * 5, owed: true }]);
  });

  it("sends a rest once when its own load and the GM's ask fall together, and again only once unanswered for a while", async () => {
    vi.useFakeTimers();
    const { game, actor, emitted, deliver } = playerWorld();
    restCompleted(actor, { newDay: true }, { newDay: true });
    game.users.activeGM = GM;
    // Both clients loading at a session's start: the player's own load
    // sends, and the GM's ask moments later must not make the GM hear the
    // same rest twice (it would end two days).
    expect(settleOwedRests()).toBe(1);
    await deliver({ type: "owedRests" });
    expect(emitted).toEqual([{ type: "newDay", actorId: "actor1", userId: "p1", at: 86400 * 5, owed: true }]);
    // A GM that dropped it asks again later and hears it again.
    vi.advanceTimersByTime(OWED_RESEND_MS);
    await deliver({ type: "owedRests" });
    expect(emitted.length).toBe(2);
    // Once answered and forgotten, a new rest for the character is sent at once.
    await deliver({ type: "newDayCounted", userId: "p1", actorId: "actor1", at: 86400 * 5 });
    expect(owedRests()).toEqual({});
    game.users.activeGM = null;
    game.time = { components: { year: 1, day: 6 }, worldTime: 86400 * 6 };
    restCompleted(actor, { newDay: true }, { newDay: true });
    game.users.activeGM = GM;
    expect(settleOwedRests()).toBe(1);
    expect(emitted.at(-1)).toEqual({ type: "newDay", actorId: "actor1", userId: "p1", at: 86400 * 6, owed: true });
  });

  it("on the GM: asks at its load, counts an owed rest as any rest and answers it, even for a character it can't count", async () => {
    const world = makeWorld({ user: GM });
    world.settings.set("dnd5e.calendarConfig", { enabled: false, dailyRecovery: "" });
    world.game.time = { components: { year: 1, day: 5 }, worldTime: 86400 * 5 };
    const { game, emitted, deliver } = world;
    expect(settleOwedRests()).toBe(0);
    expect(emitted).toEqual([{ type: "owedRests" }]);
    await deliver({ type: "newDay", actorId: "actor1", userId: "p1", at: 86400 * 5, owed: true });
    expect(game.settings.get("loot-crates", "actorState").days).toEqual({ actor1: 1 });
    expect(todayKey("actor1")).toBe("r1");
    expect(emitted.at(-1)).toEqual({ type: "newDayCounted", userId: "p1", actorId: "actor1", at: 86400 * 5 });
    // A character since deleted: nothing counted, still answered, so it isn't sent at every load.
    await deliver({ type: "newDay", actorId: "gone", userId: "p1", at: 86400 * 5, owed: true });
    expect(game.settings.get("loot-crates", "actorState").days).toEqual({ actor1: 1 });
    expect(emitted.at(-1)).toEqual({ type: "newDayCounted", userId: "p1", actorId: "gone", at: 86400 * 5 });
    // A rest sent live (not owed) gets no answer.
    const n = emitted.length;
    await deliver({ type: "newDay", actorId: "actor1", userId: "p1", at: 86400 * 5 });
    expect(emitted.length).toBe(n);
    expect(todayKey("actor1")).toBe("r2");
  });

  it("owes nothing, and throws nothing, where the browser's storage throws", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } });
    const { actor, emitted } = playerWorld();
    expect(() => restCompleted(actor, { newDay: true }, { newDay: true })).not.toThrow();
    expect(owedRests()).toEqual({});
    expect(emitted).toEqual([]);
  });
});
