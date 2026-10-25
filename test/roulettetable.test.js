/*
  Roulette on the core's table round (table.js, socket.js, refund.js) with
  the real kind: bets are stakes charged once each, the GM's one spin
  settles every bet with its multiplier and grants a rarity band's item,
  the Pull log rows carry what the refund needs, the guards run again at
  the spin (a character that changed hands gets its stake back, not paid;
  a deleted one's row is closed), a fourth bet and a stake out of bounds
  are refused unpaid, and Foundry's Roll is evaluated with allowInteractive
  false.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../module/scripts/foundry/reveal.js", () => ({ showReveal: vi.fn(async () => ({ landed: Promise.resolve() })), showRound: vi.fn(() => ({ landed: Promise.resolve(), instant: true })), boxHeld: vi.fn(() => false) }));
vi.mock("../module/scripts/foundry/chat.js", () => ({ postPullCard: vi.fn(async () => null) }));
vi.mock("../module/scripts/foundry/sound.js", () => ({ playTick: vi.fn(), playSlow: vi.fn(), playReveal: vi.fn(), playPlop: vi.fn(), playPlink: vi.fn(), playCoinBack: vi.fn(), playBane: vi.fn(), playDrop: vi.fn() }));

const { registerSocket } = await import("../module/scripts/foundry/socket.js");
const { registerSettings, getLog, getRounds } = await import("../module/scripts/foundry/store.js");
const { openRound, resolveRound } = await import("../module/scripts/foundry/table.js");
const { refundPull, describeRefund } = await import("../module/scripts/foundry/refund.js");
const { ROULETTE_DEFAULTS } = await import("../module/scripts/games/roulette.js");
const { rowStatus } = await import("../module/scripts/core/round.js");
const { postPullCard } = await import("../module/scripts/foundry/chat.js");
const { toCopper } = await import("../module/scripts/core/currency.js");

const tick = () => new Promise(r => setTimeout(r, 0));
const GM = { id: "gm", name: "Gamemaster" };
const USERS = [GM, { id: "p1", name: "Ana" }, { id: "p2", name: "Bo" }, { id: "p3", name: "Cy" }];

const WHEEL = { id: "wheel", kind: "roulette", name: "Live wheel", price: 5, pools: [{ id: "p", share: 1 }], weights: {}, roulette: { colours: ["Red", "Black"], pockets: ROULETTE_DEFAULTS.pockets, payouts: { colour: 2, parity: 2, number: 12, rarity: 3 }, itemOnRarity: true, maxStake: 50, maxBets: 3, windowSec: 0 } };
const POOLS = { p: { id: "p", name: "P", pools: [], entries: [{ uuid: "Item.rare1", name: "Rare Wand", img: "w.webp", rarity: "rare", weight: 1 }] } };
const SOURCE = { uuid: "Item.rare1", name: "Rare Wand", img: "w.webp", toObject: () => ({ name: "Rare Wand", type: "weapon", img: "w.webp", system: { rarity: "rare" } }) };

let face = 5;
const evaluated = [];

function makeActor(id, owner, gp = 100) {
  const items = new Map();
  let n = 0;
  const actor = {
    id, name: `Char ${id}`, owners: new Set([owner, "gm"]),
    system: { currency: { pp: 0, gp, ep: 0, sp: 0, cp: 0 } },
    items: { get: itemId => items.get(itemId) ?? null, get size() { return items.size; } },
    updates: 0,
    testUserPermission(user) { return actor.owners.has(user?.id); },
    async update(data) {
      await tick();
      actor.updates++;
      if (data["system.currency"]) actor.system.currency = data["system.currency"];
    },
    async createEmbeddedDocuments(_type, [data]) {
      await tick();
      const item = { id: `${id}-item${++n}`, name: data.name, flags: data.flags, async delete() { items.delete(item.id); } };
      items.set(item.id, item);
      return [item];
    },
  };
  return actor;
}

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
      async set(ns, key, value) { await tick(); settings.set(`${ns}.${key}`, value); },
    },
    socket: { on: (_n, fn) => handlers.push(fn), emit: (_n, msg) => emitted.push(msg) },
  };
  globalThis.game = game;
  globalThis.ui = { notifications: notes };
  globalThis.foundry = { utils: { randomID: n => Math.random().toString(36).slice(2, 2 + n), deepClone: v => structuredClone(v), escapeHTML: s => String(s) } };
  globalThis.fromUuid = async uuid => (uuid === "Item.rare1" ? SOURCE : null);
  globalThis.Roll = class {
    constructor(formula) { this.formula = formula; }
    async evaluate(opts) { evaluated.push(opts); return this; }
    toJSON() { return { class: "Roll", formula: this.formula, evaluated: true, total: face, terms: [{ class: "Die", number: 1, faces: 12, results: [{ result: face, active: true }] }] }; }
  };
  registerSettings();
  registerSocket();
  return { game, actors, emitted, deliver: msg => Promise.all(handlers.map(h => h(msg))), notes };
}

const stakeMsg = (round, actorId, userId, bet, stake = 10) => ({ type: "stake", requestId: `r-${actorId}-${Math.random()}`, boxId: "wheel", roundId: round.id, actorId, userId, price: stake, bet: { ...bet, stake } });
const gp = actor => toCopper(actor.system.currency) / 100;

let world;
beforeEach(async () => {
  world = makeWorld();
  await world.game.settings.set("loot-crates", "boxes", { wheel: WHEEL });
  await world.game.settings.set("loot-crates", "pools", POOLS);
  face = 5;
  evaluated.length = 0;
  postPullCard.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ["game", "ui", "foundry", "fromUuid", "Roll"]) delete globalThis[k];
});

// Ana on black, Bo on the rare band, Cy on the number 5: pocket 5 is black and rare.
async function threeBets() {
  const round = await openRound("wheel");
  await world.deliver(stakeMsg(round, "a1", "p1", { type: "colour", pick: 1 }));
  await world.deliver(stakeMsg(round, "a2", "p2", { type: "rarity", pick: "rare" }));
  await world.deliver(stakeMsg(round, "a3", "p3", { type: "number", pick: 5 }));
  return round;
}

describe("bets on the wheel", () => {
  it("are stakes: charged once each, written as open rows named by the bet", async () => {
    const round = await threeBets();
    const log = getLog();
    expect(log.map(r => r.name).sort()).toEqual(["5", "Black", "Rare"]);
    for (const r of log) expect(r).toMatchObject({ status: "open", roundId: round.id, kind: "roulette", price: 10 });
    expect(log.find(r => r.actorId === "a2").stake).toEqual({ label: "Rare", type: "rarity", pick: "rare", swatch: "rare" });
    for (const a of world.actors.values()) { expect(gp(a)).toBe(90); expect(a.updates).toBe(1); }
    expect(world.emitted.filter(m => m.type === "staked")).toHaveLength(3);
  });

  it("refuses a fourth bet, a stake out of bounds, a bad pick and a mismatched price, charging nothing", async () => {
    const round = await openRound("wheel");
    for (const n of [1, 2, 3]) await world.deliver(stakeMsg(round, "a1", "p1", { type: "number", pick: n }, 5));
    await world.deliver(stakeMsg(round, "a1", "p1", { type: "number", pick: 4 }, 5));
    await world.deliver(stakeMsg(round, "a2", "p2", { type: "colour", pick: 0 }, 2));
    await world.deliver(stakeMsg(round, "a2", "p2", { type: "colour", pick: 0 }, 60));
    await world.deliver(stakeMsg(round, "a2", "p2", { type: "colour", pick: 7 }, 5));
    await world.deliver({ ...stakeMsg(round, "a2", "p2", { type: "colour", pick: 0 }, 5), price: 7 });
    const errors = world.emitted.filter(m => m.type === "error").map(m => m.message);
    expect(errors).toEqual([
      "Char a1 has placed 3 of 3 bets this round.",
      "The least stake at Live wheel is 5 gp.",
      "The most you can stake at Live wheel is 50 gp.",
      "Pick a colour, odd or even, a number or a rarity.",
      "Live wheel now costs 5 gp (you pressed 7 gp). Nothing was charged.",
    ]);
    expect(getLog()).toHaveLength(3);
    expect(gp(world.actors.get("a1"))).toBe(85);
    expect(gp(world.actors.get("a2"))).toBe(100);
  });
});

describe("the spin", () => {
  it("rolls Foundry's die once with allowInteractive false and settles every bet: the multipliers, and the band's item on the sheet and the row", async () => {
    const round = await threeBets();
    const out = await resolveRound(round.id);
    expect(out.status).toBe("resolved");
    expect(evaluated).toEqual([{ allowInteractive: false }]);
    expect(getRounds()[round.id].outcome).toMatchObject({ index: 4, number: 5, colour: 1, rarity: "rare" });
    // Ana: black at 2x; Bo: rare at 3x and the item; Cy: the number at 12x.
    expect(gp(world.actors.get("a1"))).toBe(110);
    expect(gp(world.actors.get("a2"))).toBe(120);
    expect(gp(world.actors.get("a3"))).toBe(210);
    const bo = world.actors.get("a2");
    expect(bo.items.size).toBe(1);
    const row = getLog().find(r => r.actorId === "a2");
    expect(row).toMatchObject({ status: "settled", payoutCp: 3000, name: "Rare: Rare Wand", itemId: "a2-item1", uuid: "Item.rare1", rarity: "rare" });
    expect(bo.items.get(row.itemId).flags["loot-crates"]).toMatchObject({ sourceUuid: "Item.rare1", boxId: "wheel" });
    expect(getLog().find(r => r.actorId === "a1")).toMatchObject({ status: "settled", payoutCp: 2000, name: "Black", itemId: null });
    const reveal = world.emitted.find(m => m.type === "round" && m.event === "resolve");
    expect(reveal.outcome.number).toBe(5);
    expect(reveal.grants).toBeUndefined();
    expect(reveal.pockets).toHaveLength(12);
    expect(reveal.stakes.find(s => s.actorId === "a2")).toMatchObject({ action: "settle", payoutCp: 3000, itemId: "a2-item1", result: { name: "Rare Wand", rarity: "rare" } });
    expect(reveal.stakes.find(s => s.actorId === "a1").itemId).toBeNull();
    // One card for the round, tied to the round's id, posted after the resolve.
    expect(postPullCard).toHaveBeenCalledOnce();
    expect(postPullCard.mock.calls[0][0]).toMatchObject({ logId: round.id, outcome: { number: 5 } });
  });

  it("pays a losing bet nothing and says so on its row", async () => {
    face = 7;
    const round = await threeBets();
    await resolveRound(round.id);
    for (const a of world.actors.values()) expect(gp(a)).toBe(90);
    expect(getLog().every(r => r.status === "settled" && r.payoutCp === 0 && !r.itemId)).toBe(true);
    for (const a of world.actors.values()) expect(a.items.size).toBe(0);
  });

  it("gives a stake back, not winnings, when the character changed hands, and closes one whose character is gone", async () => {
    const round = await threeBets();
    world.actors.get("a1").owners.delete("p1");
    world.actors.delete("a3");
    await resolveRound(round.id);
    expect(gp(world.actors.get("a1"))).toBe(100);
    const by = Object.fromEntries(getLog().map(r => [r.actorId, r]));
    expect(by.a1).toMatchObject({ status: "refunded", refundReason: "owner", payoutCp: 0 });
    expect(by.a3).toMatchObject({ status: "refunded", refundReason: "gone" });
    expect(by.a2).toMatchObject({ status: "settled", payoutCp: 3000 });
    expect(getLog().filter(r => rowStatus(r) === "open")).toHaveLength(0);
    expect(world.notes.warn).toHaveBeenCalledWith(expect.stringContaining("1 stake was refunded, not paid"));
  });

  // The band's item goes on the sheet before the log write; if that write
  // fails, the rollback takes it back, so the retried spin grants it once.
  it("takes back the band's item when the spin rolls back, and the retry grants it once", async () => {
    const round = await threeBets();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const set = world.game.settings.set;
    let failLog = true;
    world.game.settings.set = async (ns, key, value) => {
      if (key === "pullLog" && failLog) { failLog = false; throw new Error("disk full"); }
      return set.call(world.game.settings, ns, key, value);
    };
    await expect(resolveRound(round.id)).rejects.toThrow("nothing was paid: press Spin to try again");
    const bo = world.actors.get("a2");
    expect(bo.items.size).toBe(0);
    expect(getRounds()[round.id].status).toBe("closed");
    await resolveRound(round.id);
    expect(bo.items.size).toBe(1);
    expect(getLog().find(r => r.actorId === "a2")).toMatchObject({ status: "settled", itemId: "a2-item2" });
    expect(gp(bo)).toBe(120);
    error.mockRestore();
  });

  it("pays coins only when the item can't be put on the sheet", async () => {
    const round = await threeBets();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    world.actors.get("a2").createEmbeddedDocuments = async () => { throw new Error("no room"); };
    await resolveRound(round.id);
    expect(gp(world.actors.get("a2"))).toBe(120);
    expect(getLog().find(r => r.actorId === "a2")).toMatchObject({ status: "settled", payoutCp: 3000, itemId: null });
    expect(getLog().find(r => r.actorId === "a2").uuid).toBeUndefined();
    expect(world.notes.error).toHaveBeenCalledWith(expect.stringContaining("couldn't be added to their sheet"));
    error.mockRestore();
  });
});

describe("the refund", () => {
  it("takes a settled win back less the stake and removes the band's item", async () => {
    const round = await threeBets();
    await resolveRound(round.id);
    const bo = world.actors.get("a2");
    const row = getLog().find(r => r.actorId === "a2");
    const plan = describeRefund(row.id);
    expect(plan.status).toBe("ready");
    expect(plan.coins).toBe(-2000);
    expect(plan.item?.name).toBe("Rare Wand");
    const done = await refundPull(row.id);
    expect(done).toMatchObject({ status: "refunded", removedItem: "Rare Wand" });
    expect(gp(bo)).toBe(100);
    expect(bo.items.size).toBe(0);
    expect(rowStatus(getLog().find(r => r.id === row.id))).toBe("refunded");
  });

  it("returns an open bet before the spin, which then passes it by", async () => {
    const round = await threeBets();
    const row = getLog().find(r => r.actorId === "a3");
    await refundPull(row.id);
    expect(gp(world.actors.get("a3"))).toBe(100);
    await resolveRound(round.id);
    expect(gp(world.actors.get("a3"))).toBe(100);
    expect(world.emitted.find(m => m.event === "resolve").stakes).toHaveLength(2);
  });
});
