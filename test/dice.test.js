/*
  Dragon's Teeth (dicegame.js) on the core: the verdict table (a tie is a
  loss, a perfect roll, the multiplier to the copper), the exact win odds
  the card shows, Foundry's Roll made with allowInteractive: false and its
  faces read back from the serialised form every client gets, the money
  through the one settle() (a win pays, a loss costs the stake, a refund
  takes a win back and refuses when the winnings are spent), the chat card
  that never carries the Roll, and the stage that waits for Dice So Nice or
  falls back after its timeout. Real pull.js, socket.js, refund.js, chat.js
  and store.js on a fake world; reveal.js is mocked where the socket path
  needs it.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { createDocument } from "./minidom.js";

vi.mock("../module/scripts/reveal.js", () => ({ showReveal: vi.fn(async () => ({ landed: Promise.resolve() })), heldState: () => null, onRelease: () => () => {} }));
vi.mock("../module/scripts/sound.js", () => ({ playTick: vi.fn(), playSlow: vi.fn(), playReveal: vi.fn(), playPlop: vi.fn(), playPlink: vi.fn(), playCoinBack: vi.fn() }));

const { DICE, parseFormula, winChance, resolve, facesOf, rollData, rollFaces, diceOdds, mountDice, landTime, DICE_TIMING, verdictText, diceRulesText, draftDice, dicePreview, dicePreviewHTML, diceSummary, setDice3D } = await import("../module/scripts/dicegame.js");
const { getKind } = await import("../module/scripts/kinds.js");
const { performPull, PullError } = await import("../module/scripts/pull.js");
const { registerSocket } = await import("../module/scripts/socket.js");
const { registerSettings, appendLog, getLog } = await import("../module/scripts/store.js");
const { refundPull, describeRefund, refundCoins, shortMessage } = await import("../module/scripts/refund.js");
const { showReveal } = await import("../module/scripts/reveal.js");
const sound = await import("../module/scripts/sound.js");
const { settle, toCopper, isWholeCoins } = await import("../module/scripts/currency.js");

const tick = () => new Promise(r => setTimeout(r, 0));

const POOLS = { p: { id: "p", name: "Dragon's hoard", pools: [], entries: [
  { uuid: "Item.a", name: "Dragon Scale", img: "a.webp", rarity: "uncommon", weight: 1 },
  { uuid: "Item.b", name: "Dragon's Tooth", img: "b.webp", rarity: "legendary", weight: 1 },
] } };
// 10 gp to roll 3d6 over the dragon's 12, paying three times the stake; a
// perfect 18 also wins an item from the hoard.
const GAME = { id: "dice", kind: "dice", name: "Dragon's Teeth", price: 10, pools: [{ id: "p", share: 1 }], weights: { uncommon: 75, legendary: 25 }, dice: { formula: "3d6", target: 12, multiplier: 3 }, rules: { prize: true } };
const GM = { id: "gm", name: "Gamemaster" };
const PLAYER = { id: "p1", name: "Player" };

const actorOf = (currency = { pp: 0, gp: 1000, ep: 0, sp: 0, cp: 0 }) => {
  const actor = {
    id: "actor1", name: "Crate Tester", items: new Map(), writes: [], system: { currency: { ...currency } },
    testUserPermission: () => true,
    async update(data) { await tick(); actor.writes.push(data["system.currency"]); if (data["system.currency"]) actor.system.currency = data["system.currency"]; },
    async createEmbeddedDocuments(_type, [data]) { await tick(); const item = { id: "item1", name: data.name, flags: data.flags, async delete() { await tick(); actor.items.delete("item1"); } }; actor.items.set("item1", item); return [item]; },
  };
  return actor;
};
const source = async uuid => ({ uuid, name: uuid.endsWith(".b") ? "Dragon's Tooth" : "Dragon Scale", img: "x.webp", toObject: () => ({ name: uuid.endsWith(".b") ? "Dragon's Tooth" : "Dragon Scale", type: "loot", flags: {}, system: { rarities: [] } }) });

// Foundry's Roll, stubbed: evaluate records its options, toJSON gives the
// faces asked for in Foundry's own shape.
function stubRoll(faces) {
  const evaluate = vi.fn();
  class FakeRoll {
    constructor(formula) { this.formula = formula; this.p = parseFormula(formula); }
    async evaluate(opts) { evaluate(opts); return this; }
    toJSON() { return rollData(this.formula, { number: this.p.number, sides: this.p.sides, faces }); }
  }
  globalThis.Roll = FakeRoll;
  return evaluate;
}

function makeWorld({ user = GM, actor = actorOf() } = {}) {
  const settings = new Map();
  const handlers = [];
  const emitted = [];
  globalThis.game = {
    user,
    users: { activeGM: GM, get: id => [GM, PLAYER].find(u => u.id === id) ?? null },
    actors: { get: id => (id === actor.id ? actor : null) },
    settings: {
      register: (ns, key, { default: def }) => settings.set(`${ns}.${key}`, def),
      get: (ns, key) => settings.get(`${ns}.${key}`),
      async set(ns, key, value) { await tick(); settings.set(`${ns}.${key}`, value); },
    },
    socket: { on: (_n, fn) => handlers.push(fn), emit: (_n, msg) => emitted.push(msg) },
    messages: { contents: [] },
  };
  globalThis.foundry = { utils: { randomID: n => Math.random().toString(36).slice(2, 2 + n), deepClone: v => structuredClone(v), escapeHTML: s => String(s) } };
  globalThis.ChatMessage = { create: vi.fn(async data => data), getSpeaker: () => ({ actor: actor.id }) };
  registerSettings();
  registerSocket();
  return { actor, emitted, deliver: msg => Promise.all(handlers.map(h => h(msg))) };
}

beforeEach(() => { globalThis.fromUuid = source; });
afterEach(() => {
  delete globalThis.fromUuid; delete globalThis.Roll; delete globalThis.game; delete globalThis.foundry; delete globalThis.ChatMessage; delete globalThis.ui; delete globalThis.CONFIG;
  showReveal.mockClear();
  for (const fn of Object.values(sound)) fn.mockClear?.();
  setDice3D(null);
  vi.useRealTimers();
});

describe("the formula and the odds", () => {
  it("reads 2d6 and 3d6 (and any NdS), and nothing else", () => {
    expect(parseFormula("3d6")).toEqual({ number: 3, sides: 6, formula: "3d6" });
    expect(parseFormula(" 2D6 ")).toEqual({ number: 2, sides: 6, formula: "2d6" });
    for (const bad of ["d6", "3d6+1", "0d6", "3d1", "", null, 12, "3d6kh2"]) expect(parseFormula(bad)).toBeNull();
  });

  it("knows the exact chance the dice beat the dragon", () => {
    expect(winChance(3, 6, 12)).toBeCloseTo(56 / 216, 12);
    expect(winChance(2, 6, 6)).toBeCloseTo(21 / 36, 12);
    expect(winChance(3, 6, 17)).toBeCloseTo(1 / 216, 12);
    expect(winChance(1, 6, 3)).toBe(0.5);
    // The edges: nobody beats the top total; everybody beats less than the bottom.
    expect(winChance(3, 6, 18)).toBe(0);
    expect(winChance(2, 6, 12)).toBe(0);
    expect(winChance(3, 6, 2)).toBe(1);
    expect(winChance(2, 6, 1)).toBe(1);
    expect(winChance(2, 6, 0)).toBe(1);
  });

  it("names win and lose as whole percents, drops an outcome with no chance, and says when the dragon can't be beaten", () => {
    const odds = diceOdds(GAME, POOLS);
    expect(odds.rows.map(r => `${r.name} ${r.label}`)).toEqual(["Win 26%", "Lose 74%"]);
    expect(odds).toMatchObject({ beatable: true, max: 18, min: 3, formula: "3d6", target: 12, multiplier: 3, payoutCp: 3000, prize: true });
    expect(odds.item.top).toBe("legendary");
    const wall = diceOdds({ ...GAME, dice: { ...GAME.dice, target: 18 } }, POOLS);
    expect(wall.rows.map(r => `${r.name} ${r.label}`)).toEqual(["Lose 100%"]);
    expect(wall.beatable).toBe(false);
    const sure = diceOdds({ ...GAME, dice: { formula: "2d6", target: 1, multiplier: 1.5 } }, POOLS);
    expect(sure.rows.map(r => `${r.name} ${r.label}`)).toEqual(["Win 100%"]);
    expect(sure.payoutCp).toBe(1500);
    // A record with no readable formula shows as unbeatable rather than throwing.
    expect(diceOdds({ ...GAME, dice: { formula: "d20", target: 5 } }, POOLS).beatable).toBe(false);
    // The near-miss chance never reads 0%.
    expect(diceOdds({ ...GAME, dice: { ...GAME.dice, target: 17 } }, POOLS).rows.map(r => r.label)).toEqual(["<1%", ">99%"]);
  });
});

describe("resolve", () => {
  const rules = { target: 12, multiplier: 3, stakeCp: 1000, sides: 6 };
  it.each([
    ["beats the dragon", [4, 6, 5], { total: 15, win: true, perfect: false, payoutCp: 3000 }],
    ["ties the dragon and loses", [4, 4, 4], { total: 12, win: false, perfect: false, payoutCp: 0 }],
    ["falls short", [2, 3, 4], { total: 9, win: false, perfect: false, payoutCp: 0 }],
    ["rolls a perfect 18", [6, 6, 6], { total: 18, win: true, perfect: true, payoutCp: 3000 }],
    ["is one short of perfect", [6, 6, 5], { total: 17, win: true, perfect: false, payoutCp: 3000 }],
    ["rolls the lowest", [1, 1, 1], { total: 3, win: false, perfect: false, payoutCp: 0 }],
  ])("%s", (_name, faces, want) => {
    expect(resolve(faces, rules)).toEqual(want);
  });

  it("holds at every formula and target edge", () => {
    // 2d6: the bottom beats a target under it, ties the target, and a top roll is perfect.
    expect(resolve([1, 1], { target: 1, multiplier: 2, stakeCp: 100, sides: 6 })).toEqual({ total: 2, win: true, perfect: false, payoutCp: 200 });
    expect(resolve([1, 1], { target: 2, multiplier: 2, stakeCp: 100, sides: 6 })).toMatchObject({ win: false });
    expect(resolve([6, 6], { target: 11, multiplier: 2, stakeCp: 100, sides: 6 })).toEqual({ total: 12, win: true, perfect: true, payoutCp: 200 });
    expect(resolve([6, 6], { target: 12, multiplier: 2, stakeCp: 100, sides: 6 })).toMatchObject({ win: false, perfect: true });
    // 3d6 against a target of 0 always wins; against 2 the lowest roll wins; against 3 it ties.
    expect(resolve([1, 1, 1], { ...rules, target: 0 })).toMatchObject({ win: true });
    expect(resolve([1, 1, 1], { ...rules, target: 2 })).toMatchObject({ win: true });
    expect(resolve([1, 1, 1], { ...rules, target: 3 })).toMatchObject({ win: false });
    // No dice is no win and no perfect.
    expect(resolve([], rules)).toEqual({ total: 0, win: false, perfect: false, payoutCp: 0 });
  });

  it("pays the stake times the multiplier to the copper, never a fraction or a negative", () => {
    expect(resolve([6, 6, 6], { ...rules, multiplier: 1.5 })).toMatchObject({ payoutCp: 1500 });
    expect(resolve([6, 6, 6], { ...rules, multiplier: 1.5, stakeCp: 333 })).toMatchObject({ payoutCp: 500 });
    expect(resolve([6, 6, 6], { ...rules, multiplier: 0 })).toMatchObject({ win: true, payoutCp: 0 });
    expect(resolve([6, 6, 6], { ...rules, multiplier: -2 })).toMatchObject({ payoutCp: 0 });
    expect(resolve([6, 6, 6], { ...rules, stakeCp: 5, multiplier: 3 })).toMatchObject({ payoutCp: 15 });
    expect(Number.isInteger(resolve([6, 6, 6], { ...rules, multiplier: 2.333, stakeCp: 1234 }).payoutCp)).toBe(true);
  });

  it("puts the verdict in words", () => {
    expect(verdictText({ total: 15, target: 12, win: true })).toBe("15 beats the dragon's 12");
    expect(verdictText({ total: 12, target: 12, win: false })).toBe("12 ties the dragon's 12: the dragon wins");
    expect(verdictText({ total: 9, target: 12, win: false })).toBe("9 doesn't beat the dragon's 12");
  });
});

describe("the roll", () => {
  it("makes Foundry's Roll with allowInteractive false and reads the faces back from its serialised form", async () => {
    const evaluate = stubRoll([4, 6, 5]);
    const out = await rollFaces("3d6");
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledWith({ allowInteractive: false });
    expect(out.faces).toEqual([4, 6, 5]);
    expect(out.roll).toMatchObject({ class: "Roll", formula: "3d6", total: 15, evaluated: true });
    expect(facesOf(out.roll)).toEqual([4, 6, 5]);
  });

  it("rebuilds the faces a client shows from the serialised Roll, skipping dropped dice and non-dice terms", () => {
    const data = { class: "Roll", formula: "2d6 + 1d4kh", terms: [
      { class: "Die", number: 2, faces: 6, results: [{ result: 3, active: true }, { result: 5, active: true }] },
      { class: "OperatorTerm", operator: "+" },
      { class: "Die", number: 1, faces: 4, results: [{ result: 1, active: false, discarded: true }, { result: 4, active: true }] },
    ] };
    expect(facesOf(data)).toEqual([3, 5, 4]);
    expect(facesOf(null)).toEqual([]);
    expect(facesOf({ terms: [{ class: "NumericTerm", number: 2 }] })).toEqual([]);
    // Through JSON, as the socket carries it.
    expect(facesOf(JSON.parse(JSON.stringify(rollData("3d6", { number: 3, sides: 6, faces: [2, 2, 6] }))))).toEqual([2, 2, 6]);
  });

  it("rolls with the core's rng when there is no Roll, in the same shape", async () => {
    const rng = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0.5).mockReturnValueOnce(0.999);
    const out = await rollFaces("3d6", { rng });
    expect(out.faces).toEqual([1, 4, 6]);
    expect(out.roll).toEqual(rollData("3d6", { number: 3, sides: 6, faces: [1, 4, 6] }));
    expect(facesOf(out.roll)).toEqual([1, 4, 6]);
  });

  it("treats a Roll that comes back with the wrong dice as a bug, not a result", async () => {
    stubRoll([4, 6]);
    await expect(rollFaces("3d6")).rejects.toThrow(/came back as/);
    stubRoll([4, 6, 7]);
    await expect(rollFaces("3d6")).rejects.toThrow(/came back as/);
  });
});

describe("the bet, through performPull", () => {
  it("a win charges the stake and pays the winnings in one write, grants nothing and keeps no state", async () => {
    const evaluate = stubRoll([4, 6, 5]);
    const actor = actorOf();
    const out = await performPull({ box: GAME, pools: POOLS, actor, state: {} });
    expect(evaluate).toHaveBeenCalledWith({ allowInteractive: false });
    expect(out).toMatchObject({ kind: "dice", win: true, total: 15, faces: [4, 6, 5], target: 12, formula: "3d6", multiplier: 3, payoutCp: 3000, itemId: null, perfect: false, result: { name: "15 beats the dragon's 12", outcome: "win" } });
    expect(out.roll).toMatchObject({ formula: "3d6", total: 15 });
    expect(out.state).toBeUndefined();
    expect(out).not.toHaveProperty("grant");
    expect(actor.writes).toHaveLength(1);
    expect(toCopper(actor.system.currency)).toBe(100000 - 1000 + 3000);
    expect(actor.system.currency).toEqual({ pp: 0, gp: 1020, ep: 0, sp: 0, cp: 0 });
    expect(isWholeCoins(actor.system.currency)).toBe(true);
  });

  it("a loss and a tie cost the stake and nothing else", async () => {
    stubRoll([2, 3, 4]);
    const lost = actorOf();
    const out = await performPull({ box: GAME, pools: POOLS, actor: lost });
    expect(out).toMatchObject({ win: false, total: 9, payoutCp: 0, result: null, itemId: null });
    expect(toCopper(lost.system.currency)).toBe(99000);
    stubRoll([4, 4, 4]);
    const tied = actorOf();
    expect(await performPull({ box: GAME, pools: POOLS, actor: tied })).toMatchObject({ win: false, total: 12, payoutCp: 0, result: null });
    expect(toCopper(tied.system.currency)).toBe(99000);
  });

  it("a perfect 18 with the prize rule also grants an item from the pools at the rarity odds", async () => {
    stubRoll([6, 6, 6]);
    const actor = actorOf();
    // 0.9 lands on the legendary rarity; 0 picks the pool and entry.
    const out = await performPull({ box: GAME, pools: POOLS, actor, rng: () => 0.9 });
    expect(out).toMatchObject({ win: true, perfect: true, prize: true, total: 18, payoutCp: 3000, itemId: "item1", result: { name: "Dragon's Tooth", rarity: "legendary", uuid: "Item.b" } });
    expect(actor.items.get("item1").flags["loot-crates"]).toMatchObject({ boxId: "dice", sourceUuid: "Item.b" });
    expect(toCopper(actor.system.currency)).toBe(102000);
    // Without the rule a perfect roll is a plain win.
    stubRoll([6, 6, 6]);
    const plain = actorOf();
    expect(await performPull({ box: { ...GAME, rules: { prize: false } }, pools: POOLS, actor: plain })).toMatchObject({ win: true, perfect: true, itemId: null, result: { name: "18 beats the dragon's 12" } });
    expect(plain).not.toHaveProperty("prize");
  });

  it("refuses a dragon the dice can't beat, and a record with no dice, before anything is charged", async () => {
    stubRoll([6, 6, 6]);
    const actor = actorOf();
    await expect(performPull({ box: { ...GAME, dice: { ...GAME.dice, target: 18 } }, pools: POOLS, actor })).rejects.toThrow("Nobody can beat the dragon's 18 on 3d6.");
    await expect(performPull({ box: { ...GAME, dice: { formula: "d20", target: 5 } }, pools: POOLS, actor })).rejects.toThrow(PullError);
    await expect(performPull({ box: { ...GAME, dice: { formula: "d20", target: 5 } }, pools: POOLS, actor })).rejects.toThrow("has no dice to roll");
    expect(actor.writes).toHaveLength(0);
  });

  it("keeps the core's guards: a stale price and an empty purse cost nothing", async () => {
    stubRoll([6, 6, 6]);
    const actor = actorOf({ gp: 9, sp: 9, cp: 9 });
    await expect(performPull({ box: GAME, pools: POOLS, actor })).rejects.toThrow("Crate Tester can't afford Dragon's Teeth.");
    await expect(performPull({ box: GAME, pools: POOLS, actor: actorOf(), expectedPrice: 5 })).rejects.toThrow("Nothing was charged.");
    expect(actor.writes).toHaveLength(0);
  });
});

describe("the GM's socket path", () => {
  async function pull(world) {
    await globalThis.game.settings.set("loot-crates", "boxes", { dice: GAME });
    await world.deliver({ type: "pull", requestId: "d1", boxId: "dice", actorId: "actor1", userId: "p1", price: 10 });
  }

  it("broadcasts the faces and the serialised Roll, writes the row with payoutCp, and posts a card without the Roll", async () => {
    stubRoll([4, 6, 5]);
    const world = makeWorld();
    await pull(world);
    const reveal = world.emitted.find(m => m.type === "reveal");
    expect(reveal).toMatchObject({ kind: "dice", requestId: "d1", userId: "p1", actorId: "actor1", box: { id: "dice", name: "Dragon's Teeth", price: 10 }, faces: [4, 6, 5], total: 15, target: 12, formula: "3d6", win: true, payoutCp: 3000, itemId: null, result: { name: "15 beats the dragon's 12" } });
    expect(facesOf(reveal.roll)).toEqual([4, 6, 5]);
    for (const k of ["grant", "state", "pools"]) expect(reveal).not.toHaveProperty(k);
    expect(showReveal).toHaveBeenCalledWith(reveal);
    const [row] = globalThis.game.settings.get("loot-crates", "pullLog");
    expect(row).toMatchObject({ id: reveal.logId, kind: "dice", boxId: "dice", actorId: "actor1", itemId: null, price: 10, payoutCp: 3000, faces: [4, 6, 5], total: 15, target: 12, formula: "3d6", win: true, name: "15 beats the dragon's 12" });
    expect(row).not.toHaveProperty("uuid");
    expect(globalThis.game.settings.get("loot-crates", "actorState")).toEqual({});
    expect(toCopper(world.actor.system.currency)).toBe(102000);
    // The card: the faces and the verdict, sealed by the core until the
    // dice land here; never a Roll in the message.
    expect(globalThis.ChatMessage.create).toHaveBeenCalledTimes(1);
    const [msg] = globalThis.ChatMessage.create.mock.calls[0];
    expect(msg).not.toHaveProperty("rolls");
    expect(msg.content).toContain(`<span class="lc-dice__face lc-dice__face--small">4</span>`);
    expect(msg.content).toContain(`<div class="lc-chat__name">15 beats the dragon's 12</div>`);
    expect(msg.content).toContain("Won 30 gp");
    expect(msg.content).toContain("rolled 3d6 against the dragon's 12 at <strong>Dragon's Teeth</strong>");
    expect(msg.flags["loot-crates"]).toEqual({ boxId: "dice", logId: reveal.logId });
  });

  it("a loss is logged and charged but posts no card", async () => {
    stubRoll([2, 3, 4]);
    const world = makeWorld();
    await pull(world);
    const reveal = world.emitted.find(m => m.type === "reveal");
    expect(reveal).toMatchObject({ win: false, total: 9, payoutCp: 0, result: null, faces: [2, 3, 4] });
    expect(globalThis.ChatMessage.create).not.toHaveBeenCalled();
    expect(globalThis.game.settings.get("loot-crates", "pullLog")[0]).toMatchObject({ payoutCp: 0, win: false, name: "9 doesn't beat the dragon's 12" });
    expect(toCopper(world.actor.system.currency)).toBe(99000);
  });

  it("says the dice jammed and charges nothing when the Roll comes back wrong", async () => {
    stubRoll([4, 6]);
    const world = makeWorld();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try { await pull(world); } finally { errors.mockRestore(); }
    expect(world.emitted.find(m => m.type === "error")).toMatchObject({ requestId: "d1", userId: "p1", message: "The dice jammed. Check the GM's console." });
    expect(world.actor.writes).toHaveLength(0);
    expect(globalThis.game.settings.get("loot-crates", "pullLog")).toHaveLength(0);
  });

  it("never puts a Roll in a ChatMessage: the dice path has no message of its own", () => {
    // The code, with its comments taken out (they explain why).
    const code = file => readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const src = code("../module/scripts/dicegame.js");
    expect(src).not.toMatch(/ChatMessage/);
    expect(src).not.toMatch(/toMessage\(/);
    expect(src).not.toMatch(/\brolls\s*:/);
    const bridge = code("../module/scripts/dicereveal.js");
    expect(bridge).not.toMatch(/ChatMessage/);
    expect(bridge).toMatch(/showForRoll\(roll, game\.user, false\)/);
  });
});

describe("the money, both ways", () => {
  it("settle() round-trips a stake and a payout to the copper over a sweep of purses, in whole coins, and refuses what the purse can't cover", () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const int = n => Math.floor(rnd() * n);
    let covered = 0, refused = 0;
    for (let i = 0; i < 400; i++) {
      const purse = { pp: int(3), gp: int(200), ep: int(2), sp: int(12), cp: int(12) };
      const stake = int(5000), payout = rnd() < 0.5 ? 0 : int(20000);
      const after = settle(purse, payout - stake);
      if (!after) { expect(toCopper(purse)).toBeLessThan(stake - payout); refused++; continue; }
      expect(isWholeCoins(after)).toBe(true);
      expect(toCopper(after)).toBe(toCopper(purse) + payout - stake);
      const back = settle(after, stake - payout);
      if (!back) { expect(toCopper(after)).toBeLessThan(payout - stake); refused++; continue; }
      expect(isWholeCoins(back)).toBe(true);
      expect(toCopper(back)).toBe(toCopper(purse));
      covered++;
    }
    expect(covered).toBeGreaterThan(200);
    expect(refused).toBeGreaterThan(10);
    expect(settle({ gp: 10 }, -1001)).toBeNull();
    expect(settle({ gp: 10 }, -1000)).toEqual({ pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 });
    expect(settle({}, 0)).toEqual({ pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 });
  });

  function makeRefundWorld(actor) {
    const settings = new Map();
    globalThis.game = {
      actors: { get: id => (id === actor.id ? actor : null) },
      settings: {
        register: (ns, key, { default: def }) => settings.set(`${ns}.${key}`, def),
        get: (ns, key) => settings.get(`${ns}.${key}`),
        async set(ns, key, value) { await tick(); settings.set(`${ns}.${key}`, value); },
      },
      messages: { contents: [] },
    };
    globalThis.foundry = { utils: { randomID: n => Math.random().toString(36).slice(2, 2 + n), deepClone: v => structuredClone(v), escapeHTML: s => String(s) } };
    registerSettings();
  }
  const WIN = { kind: "dice", boxId: "dice", boxName: "Dragon's Teeth", actorId: "actor1", actorName: "Crate Tester", userId: "p1", itemId: null, name: "15 beats the dragon's 12", price: 10, payoutCp: 3000, faces: [4, 6, 5], total: 15, target: 12, win: true };
  const LOSS = { ...WIN, name: "9 doesn't beat the dragon's 12", payoutCp: 0, faces: [2, 3, 4], total: 9, win: false };
  async function seed(actor, row) {
    makeRefundWorld(actor);
    await globalThis.game.settings.set("loot-crates", "boxes", { dice: GAME });
    await appendLog(row);
    return getLog()[0].id;
  }

  it("a win's refund takes the winnings back less the stake, in whole coins", async () => {
    const actor = actorOf({ pp: 0, gp: 1020, ep: 0, sp: 0, cp: 0 });
    const rowId = await seed(actor, WIN);
    expect(refundCoins(WIN)).toBe(-2000);
    expect(describeRefund(rowId)).toMatchObject({ status: "ready", coins: -2000, item: null });
    const out = await refundPull(rowId);
    expect(out.status).toBe("refunded");
    expect(actor.system.currency).toEqual({ pp: 0, gp: 1000, ep: 0, sp: 0, cp: 0 });
    expect(isWholeCoins(actor.system.currency)).toBe(true);
    expect(getLog()[0].refunded).toBeTypeOf("number");
    expect((await refundPull(rowId)).status).toBe("already");
    expect(actor.writes).toHaveLength(1);
    // The player's refund card says what left the purse, not that nothing moved.
    const { postRefundCard } = await import("../module/scripts/chat.js");
    globalThis.ChatMessage = { create: async data => data, getSpeaker: () => ({ actor: actor.id }) };
    const card = await postRefundCard({ row: getLog()[0], actor, removedItem: null });
    expect(card.content).toContain("20 gp was taken back from their purse: the 30 gp won, less the 10 gp stake.");
    expect(card.content).not.toContain("nothing moved");
    // The head says "was refunded" alone: the stake isn't what moved.
    expect(card.content).toContain("<strong>Dragon's Teeth</strong> was refunded</div>");
    expect(card.content).not.toContain("lc-chat__price");
  });

  it("a losing row refunds the stake only", async () => {
    const actor = actorOf({ pp: 0, gp: 990, ep: 0, sp: 0, cp: 0 });
    const rowId = await seed(actor, LOSS);
    expect(describeRefund(rowId)).toMatchObject({ status: "ready", coins: 1000 });
    await refundPull(rowId);
    expect(actor.system.currency).toEqual({ pp: 0, gp: 1000, ep: 0, sp: 0, cp: 0 });
    expect(actor.writes).toHaveLength(1);
  });

  it("a win whose winnings were spent is refused as 'short', naming the shortfall, and writes nothing", async () => {
    const actor = actorOf({ pp: 0, gp: 15, ep: 0, sp: 0, cp: 0 });
    const rowId = await seed(actor, WIN);
    const plan = describeRefund(rowId);
    expect(plan).toMatchObject({ status: "short", short: 5 });
    expect(plan.message).toBe("Crate Tester has spent 5 gp of the 30 gp won at Dragon's Teeth (15 gp of the 20 gp to take back is left). Nothing was refunded; refund it once the purse can cover it.");
    expect(shortMessage(WIN, actor)).toBe(plan.message);
    expect((await refundPull(rowId)).status).toBe("short");
    expect(actor.writes).toHaveLength(0);
    expect(actor.system.currency).toEqual({ pp: 0, gp: 15, ep: 0, sp: 0, cp: 0 });
    expect(getLog()[0]).not.toHaveProperty("refunded");
    // One copper more and it goes through.
    await actor.update({ "system.currency": { pp: 0, gp: 20, ep: 0, sp: 0, cp: 0 } });
    expect(describeRefund(rowId).status).toBe("ready");
    await refundPull(rowId);
    expect(toCopper(actor.system.currency)).toBe(0);
  });
});

describe("the stage", () => {
  let doc, frames;
  beforeEach(() => {
    doc = createDocument();
    frames = [];
    vi.stubGlobal("document", doc);
    vi.stubGlobal("requestAnimationFrame", cb => { frames.push(cb); return frames.length; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
  });
  afterEach(() => vi.unstubAllGlobals());
  const host = () => doc.createElement("div");
  const faceTexts = h => h.querySelectorAll(".lc-dice__tray .lc-dice__face").map(f => f.textContent);
  // Runs the frame loop to time t (ms since the first frame), one frame at a time.
  const runTo = t => { let now = 0; while (frames.length && now <= t) { const cb = frames.shift(); cb(now); now += 50; } };

  it("waits for the 3D dice and lands when their promise resolves, showing the GM's faces", async () => {
    const h = host();
    let resolve3d;
    const three = vi.fn(() => new Promise(r => { resolve3d = r; }));
    const onLand = vi.fn();
    const ctrl = mountDice(h, { faces: [4, 6, 5], sides: 6, target: 12, outcome: "win", rarity: "coin", three, onLand });
    const played = ctrl.play();
    expect(three).toHaveBeenCalledTimes(1);
    expect(h.classList.contains("lc-dice--three")).toBe(true);
    expect(h.classList.contains("lc-dice--landed")).toBe(false);
    expect(frames).toHaveLength(0);
    expect(onLand).not.toHaveBeenCalled();
    resolve3d(true);
    await played;
    expect(h.classList.contains("lc-dice--landed")).toBe(true);
    expect(h.classList.contains("lc-dice--three")).toBe(false);
    expect(faceTexts(h)).toEqual(["4", "6", "5"]);
    expect(h.querySelector(".lc-dice__total").textContent).toBe("15");
    expect(h.querySelector(".lc-dice__dragon").textContent).toBe("The dragon's 12");
    expect(h.dataset.outcome).toBe("win");
    expect(onLand).toHaveBeenCalledTimes(1);
  });

  it("falls back after the timeout when the 3D dice never report", async () => {
    vi.useFakeTimers();
    const h = host();
    const onLand = vi.fn();
    const ctrl = mountDice(h, { faces: [2, 3, 4], sides: 6, target: 12, outcome: "lose", three: () => new Promise(() => {}), onLand });
    const played = ctrl.play();
    vi.advanceTimersByTime(DICE_TIMING.threeTimeout - 1);
    expect(onLand).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await played;
    expect(onLand).toHaveBeenCalledTimes(1);
    expect(faceTexts(h)).toEqual(["2", "3", "4"]);
    expect(h.querySelector(".lc-dice__total").textContent).toBe("9");
  });

  it("tumbles the faces in one frame loop when the 3D dice say they weren't shown, settling left to right", async () => {
    const h = host();
    const onSettle = vi.fn();
    const onLand = vi.fn();
    const rng = () => 0.5;
    const ctrl = mountDice(h, { faces: [4, 6, 5], sides: 6, target: 12, outcome: "win", three: () => Promise.resolve(false), rng, onSettle, onLand });
    const played = ctrl.play();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.classList.contains("lc-dice--three")).toBe(false);
    expect(frames).toHaveLength(1);
    runTo(400);
    // Tumbling: every die shows a face, none its final one, no total.
    const mid = faceTexts(h);
    expect(mid.every(f => /^[1-6]$/.test(f))).toBe(true);
    expect(mid).not.toEqual(["4", "6", "5"]);
    expect(h.querySelector(".lc-dice__total").textContent).toBe("");
    expect(onSettle).not.toHaveBeenCalled();
    runTo(950);
    expect(onSettle.mock.calls.map(c => c[0])).toEqual([0]);
    expect(h.querySelectorAll(".lc-dice__die--set")).toHaveLength(1);
    expect(faceTexts(h)[0]).toBe("4");
    runTo(1100);
    expect(onSettle.mock.calls.map(c => c[0])).toEqual([0, 1]);
    runTo(1250);
    expect(onSettle.mock.calls.map(c => c[0])).toEqual([0, 1, 2]);
    expect(faceTexts(h)).toEqual(["4", "6", "5"]);
    // Every die has settled and the total is still 90 ms off: the stage
    // hasn't told it, so the feet keep the vault's line (module.css colours
    // them from lc-dice--told alone) and the first die to land says nothing.
    expect(h.querySelector(".lc-dice__total").textContent).toBe("");
    expect(h.classList.contains("lc-dice--told")).toBe(false);
    runTo(1350);
    expect(h.querySelector(".lc-dice__total").textContent).toBe("15");
    expect(h.classList.contains("lc-dice--told")).toBe(true);
    expect(onLand).not.toHaveBeenCalled();
    runTo(landTime(3) + 50);
    await played;
    expect(onLand).toHaveBeenCalledTimes(1);
    expect(h.classList.contains("lc-dice--landed")).toBe(true);
    expect(h.classList.contains("lc-dice--told")).toBe(true);
    expect(h.querySelector(".lc-dice__total").textContent).toBe("15");
    expect(frames).toHaveLength(0);
  });

  it("lands at once under reduced motion, at zero duration, and on skip, without the 3D dice", async () => {
    const three = vi.fn(() => new Promise(() => {}));
    const a = host();
    await mountDice(a, { faces: [1, 1, 1], sides: 6, reducedMotion: true, three }).play();
    expect(a.classList.contains("lc-dice--landed")).toBe(true);
    expect(a.classList.contains("lc-dice--told")).toBe(true);
    expect(faceTexts(a)).toEqual(["1", "1", "1"]);
    expect(three).not.toHaveBeenCalled();
    const b = host();
    await mountDice(b, { faces: [6, 6], sides: 6, duration: 0, three }).play();
    expect(b.querySelector(".lc-dice__total").textContent).toBe("12");
    const c = host();
    const ctrl = mountDice(c, { faces: [6, 6, 6], sides: 6, three });
    const played = ctrl.play();
    ctrl.skip();
    await played;
    expect(ctrl.skipped).toBe(true);
    expect(c.classList.contains("lc-dice--landed")).toBe(true);
    expect(c.classList.contains("lc-dice--three")).toBe(false);
  });

  it("the kind's play rebuilds the faces from the serialised Roll and asks the bridge for the 3D roll", async () => {
    const h = host();
    const bridge = vi.fn(() => Promise.resolve(true));
    setDice3D(bridge);
    const roll = rollData("3d6", { number: 3, sides: 6, faces: [4, 6, 5] });
    const reveal = { kind: "dice", roll, total: 15, target: 12, formula: "3d6", win: true, payoutCp: 3000, box: { name: "Dragon's Teeth", price: 10 }, actorName: "Tam", purse: { gp: 1020 } };
    const onLand = vi.fn();
    const ctrl = getKind("dice").reveal.play(h, reveal, { sound: true, pageHidden: () => false, onLand });
    await ctrl.play();
    expect(bridge).toHaveBeenCalledWith(roll);
    expect(faceTexts(h)).toEqual(["4", "6", "5"]);
    expect(onLand).toHaveBeenCalledTimes(1);
  });
});

describe("the words", () => {
  const reveal = (extra = {}) => ({ kind: "dice", faces: [4, 6, 5], total: 15, target: 12, formula: "3d6", win: true, payoutCp: 3000, box: { id: "dice", name: "Dragon's Teeth", price: 10 }, actorName: "Tam", purse: { pp: 0, gp: 1020, ep: 0, sp: 0, cp: 0 }, result: { name: "15 beats the dragon's 12", outcome: "win" }, ...extra });
  const kind = getKind("dice");

  it("the reveal's head names the dice and the dragon, never the faces", () => {
    const head = kind.reveal.head(reveal(), { esc: String }).replace(/\s+/g, " ");
    expect(head).toContain("Tam</span> rolls 3d6 to beat the dragon's 12 at <strong class=\"lc-reveal__crate\">Dragon's Teeth</strong>");
    expect(head).toContain("10 gp");
    expect(head).not.toMatch(/4, 6, 5|15/);
  });

  it("the result says the verdict, the faces and the coins, and the purse to the buyer alone", () => {
    const own = kind.reveal.result(reveal(), { esc: String, canSee: true });
    expect(own).toContain(`15 beats the dragon's 12</div>`);
    expect(own).toContain("Rolled 4, 6, 5 on 3d6 · Won 30 gp · ");
    expect(own).toContain("1020 gp in the purse");
    expect(own).toContain(`data-tooltip="3d6: 4, 6, 5"`);
    const table = kind.reveal.result(reveal(), { esc: String, canSee: false });
    expect(table).not.toContain("in the purse");
    const lost = kind.reveal.result(reveal({ faces: [2, 3, 4], total: 9, win: false, payoutCp: 0, result: null }), { esc: String, canSee: true });
    expect(lost).toContain("9 doesn't beat the dragon's 12");
    expect(lost).toContain("Lost 10 gp");
    const prize = kind.reveal.result(reveal({ faces: [6, 6, 6], total: 18, perfect: true, prize: true, result: { name: "Dragon's Tooth", rarity: "legendary", uuid: "Item.b" }, itemUuid: "Actor.a.Item.i" }), { esc: String, canSee: true });
    expect(prize).toContain(`<div class="lc-reveal__name">Dragon's Tooth</div>`);
    expect(prize).toContain("A perfect 18: 18 beats the dragon's 12");
    expect(prize).toContain("Added to Tam's inventory");
  });

  it("a loss is quiet: no chat card, a word for the buyer alone, no sting; a win chimes", () => {
    const lost = reveal({ faces: [2, 3, 4], total: 9, win: false, payoutCp: 0, result: null });
    expect(kind.chat.card(lost, { esc: String, itemLink: String })).toBeNull();
    expect(kind.reveal.notice(lost)).toBe("Dragon's Teeth: 9 doesn't beat the dragon's 12. Lost 10 gp.");
    expect(kind.reveal.notice(reveal())).toBeNull();
    kind.reveal.sting(lost);
    expect(sound.playCoinBack).not.toHaveBeenCalled();
    expect(sound.playReveal).not.toHaveBeenCalled();
    kind.reveal.sting(reveal());
    expect(sound.playCoinBack).toHaveBeenCalledTimes(1);
    kind.reveal.sting(reveal({ prize: true, result: { name: "Dragon's Tooth", rarity: "legendary" } }));
    expect(sound.playReveal).toHaveBeenCalledWith("legendary");
  });

  it("a prize's card links the item and says the roll", () => {
    const card = kind.chat.card(reveal({ faces: [6, 6, 6], total: 18, prize: true, result: { name: "Dragon's Tooth", rarity: "legendary", uuid: "Item.b" }, itemUuid: "Actor.a1.Item.item1" }), { esc: String, itemLink: (u, n) => `<a href="${u}">${n}</a>` });
    expect(card).toContain(`<a href="Actor.a1.Item.item1">Dragon's Tooth</a>`);
    expect(card).toContain("Legendary · a perfect 18 · Won 30 gp");
    expect(card).toContain("lc-rarity-legendary");
    expect(card).not.toMatch(/\brolls\b/);
  });

  it("the shop card names the rule, the honest odds, the payout and the prize, and says why it is off", () => {
    const ctx = { esc: String, purse: { gp: 1000 }, hasActor: true, actorName: "Tam", open: true, gmOnline: true, stateOf: () => ({}) };
    const card = kind.shop.card(GAME, POOLS, ctx);
    expect(card).toContain(`<div class="lc-box__rule">Roll 3d6 over the dragon's 12</div>`);
    expect(card).toContain(`<span class="lc-odd lc-rarity-coin">Win 26%</span><span class="lc-odd lc-rarity-none">Lose 74%</span>`);
    expect(card).toContain("Pays 3× the stake: 30 gp");
    expect(card).toContain(`<div class="lc-box__prize lc-rarity-legendary">A perfect 18 also wins an item</div>`);
    expect(card).toContain("Bet 10 gp");
    expect(card).toContain(`class="lc-box lc-rarity-legendary"`);
    expect(card).not.toContain("aria-disabled");
    expect(kind.shop.reason(GAME, POOLS, ctx)).toBe("");
    const wall = { ...GAME, dice: { ...GAME.dice, target: 18 } };
    expect(kind.shop.card(wall, POOLS, ctx)).toContain(`aria-disabled="true"`);
    expect(kind.shop.reason(wall, POOLS, ctx)).toBe("Nobody can beat the dragon's 18 on 3d6");
    expect(kind.shop.reason(GAME, POOLS, { ...ctx, held: () => true })).toBe("Still rolling");
    expect(kind.shop.reason(GAME, POOLS, { ...ctx, purse: { gp: 5 } })).toBe("Needs 5 gp more");
    expect(kind.shop.reason(GAME, POOLS, { ...ctx, open: false })).toBe("The GM has closed the shop.");
    // No prize: no prize line, the card in no rarity.
    const plain = kind.shop.card({ ...GAME, rules: { prize: false } }, POOLS, ctx);
    expect(plain).not.toContain("lc-box__prize");
    expect(plain).toContain(`class="lc-box lc-box--dice"`);
  });

  it("the manager's words: the rules cell, the editor's draft, preview and summary", () => {
    expect(diceRulesText(GAME)).toBe("3d6 over 12, pays 3×, item on 18");
    expect(diceRulesText({ ...GAME, dice: { formula: "2d6", target: 7, multiplier: 1.5 }, rules: {} })).toBe("2d6 over 7, pays 1.5×");
    const draft = draftDice(GAME, { formula: "2d6", target: "8", multiplier: "2.5", prize: false, "pool.p": "on", "share.p": "2", "w.uncommon": "10", "w.legendary": "0" }, ["p"]);
    expect(draft.dice).toEqual({ formula: "2d6", target: 8, multiplier: 2.5 });
    expect(draft.rules).toEqual({ prize: false });
    expect(draft.pools).toEqual([{ id: "p", share: 2 }]);
    expect(draft.weights.uncommon).toBe(10);
    // A formula the form doesn't offer keeps the record's; nonsense numbers floor at 0.
    expect(draftDice(GAME, { formula: "1d20", target: "-4", multiplier: "x" }, []).dice).toEqual({ formula: "3d6", target: 0, multiplier: 0 });
    const ok = dicePreview(GAME, POOLS);
    expect(ok.note).toBe("");
    expect(dicePreviewHTML(ok, String)).toContain("Win 26%");
    expect(dicePreviewHTML(ok, String)).toContain("A perfect 18 also wins an item: ");
    expect(diceSummary(ok)).toBe("Win 26%, Lose 74%. Pays 3× the stake: 30 gp. A perfect 18 also wins an item: Uncommon 75%, Legendary 25%");
    const wall = dicePreview({ ...GAME, dice: { ...GAME.dice, target: 18 } }, POOLS);
    expect(wall).toMatchObject({ warn: true, note: "Nobody can beat 18 on 3d6: the shop won't sell this. The dice total 18 at most." });
    expect(dicePreviewHTML(wall, String)).toContain("lc-form__hint--warn");
    expect(dicePreview({ ...GAME, pools: [] }, POOLS).note).toBe("The perfect-roll prize has no pool ticked, so it can never be won.");
    expect(dicePreview({ ...GAME, dice: { formula: "2d6", target: 1, multiplier: 2 } }, POOLS).note).toBe("Every roll beats 1 on 2d6.");
  });

  it("registers as the dice kind with no replay, a loss word and a win card", () => {
    expect(DICE.id).toBe("dice");
    expect(getKind("dice")).toBe(DICE);
    expect(DICE.reveal.replayable).toBe(false);
    expect(DICE.reveal.title).toBe("Dragon's Teeth");
    expect(DICE.noun).toBe("dice");
    expect(DICE.undo).toBeUndefined();
    // The late-cancel line: the verdict is a roll, not a thing one got.
    expect(DICE.gotText({ faces: [4, 6, 5], total: 15, target: 12, win: true })).toBe("rolled 4, 6, 5: 15 beats the dragon's 12");
    expect(DICE.gotText({ faces: [2, 3, 4], total: 9, target: 12, win: false })).toBe("rolled 2, 3, 4: 9 doesn't beat the dragon's 12");
    // Only a win posts a card, so the seal must hide the whole message (reveal.js).
    expect(DICE.chat.conditional).toBe(true);
  });
});
