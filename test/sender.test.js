/*
  Who sent it (socket.js): a request reaches the GM by Foundry's query, and
  the GM takes the sender from Foundry, never from the message. A request
  naming someone else, one for a character the real sender doesn't own, one
  still sent over the socket and a cancel from anyone but the buyer are all
  refused with nothing charged. Probed live first (live-forge.cjs): before
  this, a forged pull was charged and a forged cancel marked a real sale.
*/
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../module/scripts/foundry/reveal.js", () => ({ showReveal: vi.fn(async () => ({ landed: Promise.resolve() })) }));
vi.mock("../module/scripts/foundry/chat.js", () => ({ postPullCard: vi.fn(async () => null), postKeptCard: vi.fn(async () => null) }));

const { registerSocket, requestPull, requestKeep, heardRequest, restCompleted, REQUEST_QUERY, SENT_QUERY, GM_TIMEOUT_MS, WAIT_NOTICE_MS } = await import("../module/scripts/foundry/socket.js");
const { showReveal } = await import("../module/scripts/foundry/reveal.js");
const { registerSettings, enqueueWrite, getLog } = await import("../module/scripts/foundry/store.js");
const { withQuery } = await import("./requests.js");

const tick = () => new Promise(r => setTimeout(r, 0));
const GM = { id: "gm", name: "Gamemaster" };
const ANA = { id: "p1", name: "Ana" };
const CY = { id: "p3", name: "Cy" };
const USERS = [GM, ANA, CY];

// Ana's character; the GM owns every one.
function makeActor() {
  const actor = {
    id: "actor1", name: "Crate Tester",
    system: { currency: { pp: 0, gp: 500, ep: 0, sp: 0, cp: 0 } },
    items: [], updates: 0,
    testUserPermission: user => user?.id === "gm" || user?.id === "p1",
    async update(data) { await tick(); actor.updates++; if (data["system.currency"]) actor.system.currency = data["system.currency"]; },
    async createEmbeddedDocuments(_t, docs) { await tick(); const made = docs.map((d, i) => ({ id: `item${actor.items.length + i}`, ...d })); actor.items.push(...made); return made; },
  };
  return actor;
}

function makeWorld({ user = GM, users = USERS } = {}) {
  const settings = new Map();
  const onChange = new Map();
  const handlers = [];
  const emitted = [];
  const queried = [];
  const actor = makeActor();
  const notes = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  const game = {
    user,
    users: { activeGM: withQuery(GM, queried), get: id => users.find(u => u.id === id) ?? null },
    actors: { get: id => (id === actor.id ? actor : null) },
    settings: {
      register: (ns, key, { default: def, onChange: fn }) => { settings.set(`${ns}.${key}`, def); if (fn) onChange.set(`${ns}.${key}`, fn); },
      get: (ns, key) => settings.get(`${ns}.${key}`),
      async set(ns, key, value) { await tick(); settings.set(`${ns}.${key}`, value); onChange.get(`${ns}.${key}`)?.(value); },
    },
    socket: { on: (_n, fn) => handlers.push(fn), emit: (_n, msg) => emitted.push(msg) },
  };
  globalThis.game = game;
  globalThis.ui = { notifications: notes };
  globalThis.CONFIG = { queries: {} };
  globalThis.foundry = { utils: { randomID: n => Math.random().toString(36).slice(2, 2 + n), deepClone: v => structuredClone(v) } };
  globalThis.fromUuid = async uuid => ({ name: `Item ${uuid}`, img: "", toObject: () => ({ name: `Item ${uuid}`, type: "loot", flags: {} }) });
  registerSettings();
  registerSocket();
  const onSocket = msg => Promise.all(handlers.map(h => h(msg)));
  return { game, actor, emitted, queried, notes, onSocket, settings };
}

const POOL = { id: "pool", name: "Pool", pools: [], entries: ["a", "b"].map(u => ({ uuid: u, name: u, img: "", rarity: "common", weight: 1 })) };
async function seed(game) {
  await game.settings.set("loot-crates", "pools", { pool: POOL });
  await game.settings.set("loot-crates", "boxes", { box: { id: "box", name: "Test Crate", price: 10, pools: [{ id: "pool", share: 1 }], weights: { common: 1 }, rules: {} } });
  await game.settings.set("loot-crates", "shopOpen", true);
}
const pull = (requestId, userId) => ({ type: "pull", requestId, boxId: "box", actorId: "actor1", userId, price: 10 });
const unchanged = ({ actor }) => {
  expect(actor.updates).toBe(0);
  expect(actor.system.currency.gp).toBe(500);
  expect(actor.items).toHaveLength(0);
  expect(getLog()).toHaveLength(0);
};

afterEach(() => {
  vi.useRealTimers();
  for (const k of ["game", "ui", "CONFIG", "foundry", "fromUuid"]) delete globalThis[k];
});

describe("the GM takes the sender from Foundry", () => {
  it("registers the request and the did-you-send-it queries under the module's name", () => {
    makeWorld();
    expect(REQUEST_QUERY).toBe("loot-crates.request");
    expect(SENT_QUERY).toBe("loot-crates.sent");
    expect(Object.keys(globalThis.CONFIG.queries).sort()).toEqual([REQUEST_QUERY, SENT_QUERY]);
  });

  it.each(["pull", "redeem", "keep", "stake"])("refuses a %s that names another player as its sender, tells the GM, and charges nothing", async type => {
    const world = makeWorld();
    await seed(world.game);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const forged = { ...pull(`forged-${type}`, "p1"), type, itemId: "t1", roundId: "r", bet: null };
    await expect(heardRequest(forged, { user: CY })).rejects.toThrow("That request named someone other than the player who sent it, so the GM refused it. Nothing was charged.");
    unchanged(world);
    expect(world.emitted).toEqual([]);
    expect(world.notes.warn).toHaveBeenCalledWith("Loot Crates: Cy sent a request in Ana's name. It was refused and nothing was charged.");
    expect(warn.mock.calls.flat().join(" ")).toContain(`refused a ${type} from Cy that named Ana as its sender`);
  });

  it("answers a 1.7.0 client's query (no replyBy) with Foundry's rejection, or true, as that build expects", async () => {
    const world = makeWorld();
    await seed(world.game);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const query = globalThis.CONFIG.queries[REQUEST_QUERY];
    await expect(query(pull("q1", "p1"), { user: CY })).rejects.toThrow("Nothing was charged.");
    unchanged(world);
    await expect(query(pull("q2", "p1"), { user: ANA })).resolves.toBe(true);
    expect(world.actor.system.currency.gp).toBe(490);
    expect(world.emitted.filter(m => m.type === "reveal").map(m => m.userId)).toEqual(["p1"]);
  });

  it("refuses a character the real sender doesn't own, even named honestly, charging nothing", async () => {
    const world = makeWorld();
    await seed(world.game);
    await expect(heardRequest(pull("r1", "p3"), { user: CY })).rejects.toThrow("You don't own that character.");
    await expect(heardRequest({ type: "redeem", requestId: "r2", actorId: "actor1", itemId: "t1", userId: "p3" }, { user: CY })).rejects.toThrow("You don't own that character.");
    unchanged(world);
    // Said on the socket only because these name no replyBy (a 1.7.0 client).
    expect(world.emitted).toEqual([
      { type: "error", requestId: "r1", userId: "p3", message: "You don't own that character." },
      { type: "error", requestId: "r2", userId: "p3", message: "You don't own that character." },
    ]);
  });

  it("takes a request with no named sender as the real sender's", async () => {
    const world = makeWorld();
    await seed(world.game);
    const { userId: _drop, ...bare } = pull("r1", "p1");
    await heardRequest(bare, { user: ANA });
    expect(world.actor.system.currency.gp).toBe(490);
    expect(getLog()[0]).toMatchObject({ userId: "p1", actorId: "actor1" });
  });

  it("counts a long rest only for the real sender's own character", async () => {
    const world = makeWorld();
    world.settings.set("dnd5e.calendarConfig", { enabled: false, dailyRecovery: "" });
    world.game.time = { components: { year: 1, day: 5 }, worldTime: 86400 * 5 };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(heardRequest({ type: "newDay", requestId: "d1", actorId: "actor1", userId: "p1" }, { user: CY })).rejects.toThrow();
    await heardRequest({ type: "newDay", requestId: "d2", actorId: "actor1", userId: "p3" }, { user: CY });
    expect(world.game.settings.get("loot-crates", "actorState").days ?? {}).toEqual({});
    await heardRequest({ type: "newDay", requestId: "d3", actorId: "actor1", userId: "p1" }, { user: ANA });
    expect(world.game.settings.get("loot-crates", "actorState").days).toEqual({ actor1: 1 });
  });

  it("refuses a request that still comes over the socket, telling the player it names to reload", async () => {
    const world = makeWorld();
    await seed(world.game);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await world.onSocket(pull("old", "p1"));
    await world.onSocket({ type: "cancel", requestId: "old", userId: "p1" });
    await world.onSocket({ type: "newDay", actorId: "actor1", userId: "p1" });
    await enqueueWrite(() => {});
    unchanged(world);
    expect(world.emitted).toEqual([{ type: "error", requestId: "old", userId: "p1", message: "Your Loot Crates is out of date. Reload Foundry (F5), then try again." }]);
    expect(warn.mock.calls.flat().join(" ")).toContain("refused a pull that came over the socket naming Ana");
  });

  it("ignores requests on the socket on a client that isn't the active GM", async () => {
    const world = makeWorld({ user: ANA });
    await world.onSocket(pull("x", "p3"));
    expect(world.emitted).toEqual([]);
  });
});

describe("only the buyer calls a purchase off", () => {
  it("still sells a pull another player tried to call off before it was charged", async () => {
    const world = makeWorld();
    await seed(world.game);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let release;
    const held = enqueueWrite(() => new Promise(r => { release = r; }));
    const sale = heardRequest(pull("r1", "p1"), { user: ANA });
    // Cy names Ana (refused at the door), then cancels as himself (not his request).
    await expect(heardRequest({ type: "cancel", requestId: "r1", userId: "p1" }, { user: CY })).rejects.toThrow();
    await heardRequest({ type: "cancel", requestId: "r1", userId: "p3" }, { user: CY });
    while (!release) await tick();
    release();
    await held;
    await sale;
    expect(world.actor.system.currency.gp).toBe(490);
    expect(world.emitted.filter(m => m.type === "reveal")).toHaveLength(1);
    // And Ana's own cancel, after Cy's, still drops her next one.
    let again;
    const held2 = enqueueWrite(() => new Promise(r => { again = r; }));
    const next = heardRequest(pull("r2", "p1"), { user: ANA });
    await heardRequest({ type: "cancel", requestId: "r2", userId: "p1" }, { user: ANA });
    while (!again) await tick();
    again();
    await held2;
    await next;
    expect(world.actor.system.currency.gp).toBe(490);
  });

  it("marks no sale as called off for a cancel from anyone but its buyer, after the charge", async () => {
    const world = makeWorld();
    await seed(world.game);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await heardRequest(pull("r1", "p1"), { user: ANA });
    await heardRequest({ type: "cancel", requestId: "r1", userId: "p3" }, { user: CY });
    await enqueueWrite(() => {});
    expect(getLog()[0].lateCancel).toBeUndefined();
    expect(world.emitted.filter(m => m.type === "late")).toEqual([]);
    expect(world.notes.warn).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(" ")).toContain("refused Cy's cancel of r1, which Ana sent");
    // The buyer's own late cancel still marks it, once.
    await heardRequest({ type: "cancel", requestId: "r1", userId: "p1" }, { user: ANA });
    await enqueueWrite(() => {});
    expect(getLog()[0].lateCancel).toEqual(expect.any(Number));
    expect(world.emitted.filter(m => m.type === "late").map(m => m.userId)).toEqual(["p1"]);
  });
});

describe("a Foundry that gives the query no sender", () => {
  const users = answer => [GM, { ...ANA, query: vi.fn(async (name, data) => answer(name, data)) }, CY];

  it("asks the named player's own client, and handles it as theirs only on a yes", async () => {
    const yes = users(name => name === SENT_QUERY);
    const world = makeWorld({ users: yes });
    await seed(world.game);
    await heardRequest(pull("r1", "p1"), {});
    expect(yes[1].query).toHaveBeenCalledWith(SENT_QUERY, { requestId: "r1" }, { timeout: 5000 });
    expect(world.actor.system.currency.gp).toBe(490);
  });

  it("refuses a pull or a cancel replaying an id the named player's client already vouched for", async () => {
    const world = makeWorld({ user: ANA });
    const answer = globalThis.CONFIG.queries[SENT_QUERY];
    const ana = { ...ANA, query: vi.fn(async (name, data) => answer(data)) };
    requestPull({ boxId: "box", actorId: "actor1", price: 10 }).catch(() => {});
    const id = world.queried[0].requestId;
    // The GM's client: the same CONFIG.queries, Ana's client answering.
    const gm = makeWorld({ users: [GM, ana, CY] });
    globalThis.CONFIG.queries[SENT_QUERY] = answer;
    await seed(gm.game);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await heardRequest(pull(id, "p1"), {});
    expect(gm.actor.system.currency.gp).toBe(490);
    // Cy heard the id on the reveal and sends it again in Ana's name.
    await expect(heardRequest(pull(id, "p1"), {})).rejects.toThrow("so the GM refused it");
    await expect(heardRequest({ type: "cancel", requestId: id, userId: "p1" }, {})).rejects.toThrow("so the GM refused it");
    expect(gm.actor.system.currency.gp).toBe(490);
    expect(getLog()).toHaveLength(1);
    expect(getLog()[0].lateCancel).toBeUndefined();
  });

  it.each([["says no", () => false], ["throws", () => { throw new Error("gone"); }]])("refuses it when the named player's client %s", async (_w, answer) => {
    const world = makeWorld({ users: users(answer) });
    await seed(world.game);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(heardRequest(pull("r1", "p1"), {})).rejects.toThrow("so the GM refused it");
    unchanged(world);
  });
});

describe("a player's client", () => {
  it("sends its request to the active GM by query, never on the socket, and answers did-you-send-it only for its own", async () => {
    vi.useFakeTimers();
    const world = makeWorld({ user: ANA });
    const promise = requestPull({ boxId: "box", actorId: "actor1", price: 10 });
    expect(world.emitted).toEqual([]);
    expect(world.queried).toEqual([{ type: "pull", requestId: expect.any(String), boxId: "box", actorId: "actor1", userId: "p1", price: 10, replyBy: "query" }]);
    const sent = globalThis.CONFIG.queries[SENT_QUERY];
    expect(sent({ requestId: world.queried[0].requestId })).toBe(true);
    // Once: an id asked about again (a replay of it) gets no.
    expect(sent({ requestId: world.queried[0].requestId })).toBe(false);
    expect(sent({ requestId: "someone-elses" })).toBe(false);
    // Its wait running out calls it off the same way.
    vi.advanceTimersByTime(GM_TIMEOUT_MS + 1);
    await expect(promise).rejects.toThrow();
    expect(world.queried.at(-1)).toEqual({ type: "cancel", requestId: world.queried[0].requestId, userId: "p1", replyBy: "query" });
    expect(world.emitted).toEqual([]);
  });

  it("ends the wait with the GM's refusal", async () => {
    const world = makeWorld({ user: ANA });
    world.game.users.activeGM = { ...GM, query: async () => { throw new Error("That request named someone other than the player who sent it, so the GM refused it. Nothing was charged."); } };
    await expect(requestPull({ boxId: "box", actorId: "actor1", price: 10 })).rejects.toThrow("so the GM refused it");
  });

  it("says so, sending nothing, when Foundry's Query Users permission is off for its role", async () => {
    const world = makeWorld({ user: { ...ANA, hasPermission: p => p !== "QUERY_USER" } });
    await expect(requestPull({ boxId: "box", actorId: "actor1", price: 10 })).rejects.toThrow("The GM can turn on Query Users for your role in Configure Permissions.");
    expect(world.queried).toEqual([]);
    expect(world.emitted).toEqual([]);
  });
});

/*
  The answer comes back the way the request went (VIB-217). Anything on the
  module socket can be forged by a player who heard the request id (it
  rides the slow-pull ack every client hears): a forged "error" made the
  buyer's shop say a pull had failed while the GM went on charging, and a
  second press charged again. So a request's answer, refusal and late
  notice are the query's own result, and a client of 1.8.0 takes nothing
  the socket says about its own requests.
*/
describe("answers come back by the query, never the socket", () => {
  const reply = { replyBy: "query" };
  const deferredGM = () => {
    const calls = [];
    const gm = { ...GM, query: (_n, data) => new Promise(resolve => calls.push({ data, resolve })) };
    return { gm, calls };
  };

  it("ignores a forged socket error for a pending pull, and resolves from the query with the reveal", async () => {
    vi.useFakeTimers();
    const world = makeWorld({ user: ANA });
    const { gm, calls } = deferredGM();
    world.game.users.activeGM = gm;
    let settled = null;
    const promise = requestPull({ boxId: "box", actorId: "actor1", price: 10 }).then(v => (settled = { ok: v }), err => (settled = { err }));
    const { requestId } = calls[0].data;
    expect(calls[0].data.replyBy).toBe("query");
    // Cy heard the id (a slow pull's ack) and says it failed.
    await world.onSocket({ type: "ack", requestId, userId: "p1", hidden: true });
    await world.onSocket({ type: "error", requestId, userId: "p1", message: "Test Crate is sold out." });
    await world.onSocket({ type: "kept", requestId, userId: "p1" });
    await world.onSocket({ type: "reveal", requestId, userId: "p1", box: { id: "box", name: "Forged" }, result: { name: "Vorpal Sword" } });
    await vi.advanceTimersByTimeAsync(WAIT_NOTICE_MS);
    expect(settled).toBeNull();
    expect(showReveal).not.toHaveBeenCalled();
    // The GM's real answer.
    const reveal = { type: "reveal", requestId, userId: "p1", actorId: "actor1", box: { id: "box", name: "Test Crate", price: 10 }, result: { name: "a" }, sold: { boxName: "Test Crate", actorName: "Crate Tester", got: "got a" } };
    calls[0].resolve(reveal);
    await promise;
    expect(settled).toEqual({ ok: reveal });
    expect(showReveal).toHaveBeenCalledTimes(1);
    expect(showReveal).toHaveBeenCalledWith(reveal);
    expect(vi.getTimerCount()).toBe(0);
    showReveal.mockClear();
  });

  it("still shows another player's reveal from the socket, for the table to watch", async () => {
    const world = makeWorld({ user: ANA });
    await world.onSocket({ type: "reveal", requestId: "theirs", userId: "p3", box: { id: "box" } });
    expect(showReveal).toHaveBeenCalledTimes(1);
    showReveal.mockClear();
  });

  it("on the GM: a refusal is the query's answer, with its stale price, nothing charged and nothing on the socket", async () => {
    const world = makeWorld();
    await seed(world.game);
    const query = globalThis.CONFIG.queries[REQUEST_QUERY];
    await expect(query({ ...pull("s1", "p1"), price: 5, ...reply }, { user: ANA })).resolves.toEqual({ type: "error", message: "Test Crate now costs 10 gp (you pressed 5 gp). Nothing was charged.", stalePrice: 10 });
    await expect(query({ ...pull("s2", "p1"), ...reply, actorId: "nobody" }, { user: ANA })).resolves.toEqual({ type: "error", message: "You don't own that character." });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(query({ ...pull("s3", "p1"), ...reply }, { user: CY })).resolves.toMatchObject({ type: "error", message: expect.stringContaining("Nothing was charged.") });
    unchanged(world);
    expect(world.emitted).toEqual([]);
  });

  it("on the GM: a pull's answer is the reveal, sent as soon as it is out, before the row is written", async () => {
    const world = makeWorld();
    await seed(world.game);
    const query = globalThis.CONFIG.queries[REQUEST_QUERY];
    const answer = await query({ ...pull("q1", "p1"), ...reply }, { user: ANA });
    expect(answer).toMatchObject({ type: "reveal", requestId: "q1", userId: "p1", box: { id: "box", name: "Test Crate", price: 10 }, sold: { boxName: "Test Crate", actorName: "Crate Tester", got: expect.stringMatching(/^got /) } });
    expect(world.emitted.map(m => m.type)).toEqual(["reveal"]);
    // The row follows in the same queued task.
    await enqueueWrite(() => {});
    expect(getLog().map(r => r.id)).toEqual([answer.logId]);
    expect(world.actor.system.currency.gp).toBe(490);
  });

  it("a refusal reaches the player's request as its rejection, with the stale price, and nothing charged", async () => {
    const world = makeWorld({ user: ANA });
    world.game.users.activeGM = { ...GM, query: async () => ({ type: "error", message: "Test Crate now costs 10 gp (you pressed 5 gp). Nothing was charged.", stalePrice: 10 }) };
    await expect(requestPull({ boxId: "box", actorId: "actor1", price: 5 })).rejects.toMatchObject({ message: "Test Crate now costs 10 gp (you pressed 5 gp). Nothing was charged.", stalePrice: 10 });
    world.game.users.activeGM = { ...GM, query: async (_n, data) => ({ type: "kept", requestId: data.requestId, userId: "p1", boxName: "Test Crate", actorName: "Crate Tester", count: 1 }) };
    await expect(requestKeep({ boxId: "box", actorId: "actor1", price: 10 })).resolves.toMatchObject({ type: "kept", count: 1 });
    expect(world.actor.updates).toBe(0);
    expect(world.emitted).toEqual([]);
  });

  it("from a GM of 1.7.0 (its query says true), takes the answer that came on the socket", async () => {
    const world = makeWorld({ user: ANA });
    const { gm, calls } = deferredGM();
    world.game.users.activeGM = gm;
    const promise = requestPull({ boxId: "box", actorId: "actor1", price: 10 });
    const { requestId } = calls[0].data;
    await world.onSocket({ type: "error", requestId, userId: "p1", message: "Test Crate is sold out." });
    calls[0].resolve(true);
    await expect(promise).rejects.toThrow("Test Crate is sold out.");
  });

  it("answers did-you-send-it only to the active GM, where Foundry names who asks", () => {
    const world = makeWorld({ user: ANA });
    const ids = [];
    world.game.users.activeGM = { ...GM, query: (_n, data) => { ids.push(data.requestId); return new Promise(() => {}); } };
    requestPull({ boxId: "box", actorId: "actor1", price: 10 });
    requestPull({ boxId: "box", actorId: "actor1", price: 10 });
    const sent = globalThis.CONFIG.queries[SENT_QUERY];
    // Cy asks: no, and the GM's one yes is still there.
    expect(sent({ requestId: ids[0] }, { user: CY })).toBe(false);
    expect(sent({ requestId: ids[0] }, { user: GM })).toBe(true);
    // A Foundry that names no one (13): as before, one yes.
    expect(sent({ requestId: ids[1] }, {})).toBe(true);
    expect(sent({ requestId: ids[1] }, {})).toBe(false);
  });

  it("keeps a long rest for the next GM when the query is refused", async () => {
    const world = makeWorld({ user: ANA });
    world.game.world = { id: "w" };
    world.game.time = { worldTime: 86400 * 3 };
    const kept = new Map();
    vi.stubGlobal("localStorage", { getItem: k => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)), removeItem: k => kept.delete(k) });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    world.game.users.activeGM = { ...GM, query: async () => { throw new Error("User [gm] is not active"); } };
    restCompleted(world.actor, { newDay: true }, { newDay: true });
    await tick();
    expect(JSON.parse(kept.get("loot-crates.owedRests.w.p1"))).toEqual({ actor1: { at: 86400 * 3 } });
    vi.unstubAllGlobals();
  });
});
