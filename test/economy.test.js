/*
  The economy readout (VIB-218): the tallies per character and per game
  (core/tally.js chars, games), written with each row and undone by its
  refund; the move to version 3 that counts them once from the log; and
  the readout over the Pull log (views/economy.js): payback against the
  one a game was set to, This session from the log since the GM's load,
  for a GM alone.
*/
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from "vitest";
import { registerSettings, appendLog, recordPlay, getTally, migrateTallies, updateLog, updateLogRows, recordPart, liftPart } from "../module/scripts/foundry/store.js";
import { TALLY_VERSION, TALLY_KEY, applyRow, applyEcon, econOf, emptyTally, migrateLog, tallyOf, countsChange } from "../module/scripts/core/tally.js";
import { worthCp } from "../module/scripts/core/afterplay.js";
import { rowPatch } from "../module/scripts/core/round.js";
import { seededRng } from "../module/scripts/core/odds.js";
import { charLines, gameLines, economyOf, economyHTML, setText, setPayback } from "../module/scripts/views/economy.js";
import { paybackOf } from "../module/scripts/games/scratch.js";
import { wellPayback } from "../module/scripts/games/well.js";
import { dicePayback, winChance } from "../module/scripts/games/dicegame.js";
import { wheelPayback } from "../module/scripts/games/roulette.js";

vi.mock("../module/scripts/foundry/shop.js", () => ({ refreshShop: vi.fn() }));
vi.mock("../module/scripts/foundry/chat.js", () => ({ postRefundCard: vi.fn() }));

const tick = () => new Promise(r => setTimeout(r, 0));
const W = (value, denomination = "gp", quantity = 1) => ({ value, denomination, quantity });

function makeWorld() {
  const settings = new Map();
  globalThis.game = {
    user: { id: "gm", isGM: true },
    actors: { get: () => null },
    settings: {
      register: (ns, key, { default: def }) => settings.set(`${ns}.${key}`, def),
      get: (ns, key) => settings.get(`${ns}.${key}`),
      async set(ns, key, value) { await tick(); settings.set(`${ns}.${key}`, structuredClone(value)); },
    },
  };
  globalThis.foundry = { utils: { randomID: n => Math.random().toString(36).slice(2, 2 + n), deepClone: v => structuredClone(v) } };
  registerSettings();
  return { put: (key, value) => settings.set(`loot-crates.${key}`, structuredClone(value)), get: key => settings.get(`loot-crates.${key}`) };
}
const cleanup = () => { delete globalThis.game; delete globalThis.foundry; };

const crate = over => ({ id: "p1", at: 10, kind: "crate", boxId: "box", boxName: "Adventurer's Crate", actorId: "tam", actorName: "Tam", userId: "u1", price: 150, payoutCp: 0, itemId: "wand", itemIds: ["wand"], uuid: "Item.wand", worth: { wand: W(400) }, name: "Wand of Webs", ...over });

describe("the economy tallies, row by row", () => {
  afterEach(cleanup);

  it("count a pull: the character spent the price and won the item at its price; the game took it and paid the item out", () => {
    const t = applyRow(emptyTally(), crate(), 1);
    expect(t.chars.tam).toEqual({ name: "Tam", spent: 15000, items: 40000 });
    expect(t.games.box).toEqual({ name: "Adventurer's Crate", plays: 1, taken: 15000, items: 40000 });
  });

  it("a refund undoes the pull in the write that marks it (store.js)", async () => {
    makeWorld();
    const id = await recordPlay({ row: crate() });
    expect(getTally().chars.tam.spent).toBe(15000);
    await updateLog(id, { refunded: 20 });
    expect(getTally().chars).toEqual({});
    expect(getTally().games).toEqual({});
    // Lifted (a kept ticket already gone), it counts again.
    await updateLog(id, { refunded: null });
    expect(getTally().games.box.plays).toBe(1);
  });

  it("a stake is taken when placed, and its settle adds what it paid and the item it won", async () => {
    makeWorld();
    const stake = { id: "s1", kind: "auction", boxId: "lot", boxName: "The Midnight Lot", actorId: "orla", actorName: "Orla", userId: "u2", itemId: null, price: 55, payoutCp: 0, status: "open", roundId: "R1", stake: { amount: 55 }, name: "Bid 55 gp" };
    await appendLog(stake);
    await appendLog({ id: "h1", kind: "auction", boxId: "lot", boxName: "The Midnight Lot", actorId: null, actorName: "Sir Vane", itemId: null, price: 0, payoutCp: 0, status: "open", roundId: "R1", stake: { amount: 60 }, name: "Bid 60 gp", house: true });
    expect(getTally().games.lot).toEqual({ name: "The Midnight Lot", plays: 1, taken: 5500 });
    expect(getTally().chars.orla.spent).toBe(5500);
    // The gavel: the bid won the Flame Tongue (worth as granted, table.js closeStakes).
    await updateLogRows([["s1", rowPatch({ row: stake, action: "settle", payoutCp: 0, itemId: "ft", worth: W(5000), result: { uuid: "Item.ft", rarity: "rare" }, name: "Flame Tongue" }, 30)]]);
    expect(getTally().games.lot).toEqual({ name: "The Midnight Lot", plays: 1, taken: 5500, items: 500000 });
    expect(getTally().chars.orla).toEqual({ name: "Orla", spent: 5500, items: 500000 });
    // A wheel's bet that won coins, and one turned back (outbid, refunded): nothing for that one.
    const bet = { id: "b1", kind: "roulette", boxId: "wheel", boxName: "Wheel of Fate", actorId: "tam", actorName: "Tam", price: 10, payoutCp: 0, status: "open", roundId: "R2", name: "Red" };
    const back = { ...bet, id: "b2", price: 5 };
    await appendLog(bet);
    await appendLog(back);
    await updateLogRows([["b1", rowPatch({ row: bet, action: "settle", payoutCp: 2000 }, 40)], ["b2", rowPatch({ row: back, action: "refund", reason: "owner", payoutCp: 0 }, 40)]]);
    expect(getTally().games.wheel).toEqual({ name: "Wheel of Fate", plays: 1, taken: 1000, paid: 2000 });
  });

  it("a scratch win with an item: the coins and the item paid out, a deck's bane taken on top of the price", () => {
    const t = emptyTally();
    applyRow(t, { id: "x1", at: 1, kind: "scratch", boxId: "fortune", boxName: "Fortune Ticket", actorId: "bo", actorName: "Bo", price: 5, payoutCp: 2500, rollId: 1, itemId: "ring", itemIds: ["ring"], worth: { ring: W(50, "gp", 2) } }, 1, { tier: "item.rare+gp.25" });
    expect(t.chars.bo).toEqual({ name: "Bo", spent: 500, paid: 2500, items: 10000 });
    expect(t.games.fortune).toEqual({ name: "Fortune Ticket", plays: 1, taken: 500, paid: 2500, items: 10000 });
    applyRow(t, { id: "k1", at: 2, kind: "deck", boxId: "deck", boxName: "Deck", actorId: "bo", actorName: "Bo", price: 10, payoutCp: -2000, cardId: "flames" });
    expect(t.chars.bo.spent).toBe(500 + 3000);
    expect(t.games.deck).toEqual({ name: "Deck", plays: 1, taken: 3000 });
  });

  it("a Buy to keep is spent but not a play; its ticket's use is the play and costs nothing more", () => {
    const t = emptyTally();
    applyRow(t, { id: "k", at: 1, kind: "crate", boxId: "box", boxName: "Crate", actorId: "tam", actorName: "Tam", price: 150, payoutCp: 0, keep: { paid: 150 } });
    applyRow(t, crate({ id: "r", at: 2, price: 0, redeem: { paid: 150 } }));
    expect(t.games.box).toMatchObject({ plays: 1, taken: 15000, items: 40000 });
  });

  it("a sell back and a give (store.js recordPart): coins to the seller, the item's worth to the receiver; lifted, as before", async () => {
    makeWorld();
    await recordPlay({ row: crate({ itemIds: ["wand", "potion"], itemNames: ["Wand of Webs", "Potion"], worth: { wand: W(400), potion: W(50) } }) });
    const before = structuredClone(getTally());
    const mark = await recordPart("p1", "wand", { at: 20, given: { actorId: "saria", actorName: "Saria" } });
    await recordPart("p1", "potion", { at: 21, soldCp: 2500 });
    const t = getTally();
    expect(t.chars.tam).toEqual({ name: "Tam", spent: 15000, items: 45000, gave: 40000, sold: 2500, soldWorth: 5000 });
    expect(t.chars.saria).toEqual({ name: "Saria", got: 40000 });
    // The game paid out the items whatever became of them.
    expect(t.games.box).toEqual(before.games.box);
    // The readout: Tam won 25 gp in coins and nothing left in items; Saria holds the wand.
    const lines = Object.fromEntries(charLines(t.chars).map(l => [l.id, l]));
    expect(lines.tam).toMatchObject({ spent: 15000, coins: 2500, items: 0, net: -12500 });
    expect(lines.saria).toMatchObject({ spent: 0, coins: 0, items: 40000, net: 40000 });
    await liftPart(mark);
    expect(getTally().chars.saria).toBeUndefined();
  });

  it("the parts, the payout and the price are what a tally reads: a patch to them moves it", () => {
    const row = crate();
    expect(countsChange(row, { ...row, parted: { wand: { at: 1, soldCp: 5 } } })).toBe(true);
    expect(countsChange(row, { ...row, worth: { wand: W(10) } })).toBe(true);
    expect(countsChange(row, { ...row, lateCancel: 3 })).toBe(false);
  });

  it("values an item at its dnd5e price times its quantity, rounded to the copper", () => {
    expect(worthCp(W(400))).toBe(40000);
    expect(worthCp(W(5, "sp", 3))).toBe(150);
    expect(worthCp(W(0.5))).toBe(50);
    expect(worthCp(null)).toBe(0);
    expect(worthCp({ value: 3, denomination: "xx" })).toBe(0);
  });
});

/* ---------- The move to version 3 ---------- */

const ACTORS = ["a1", "a2", "a3"];
// 600 rows of every kind with prices, payouts, items' worth, gifts and sales.
function fixture(seed = 5, n = 600) {
  const rng = seededRng(seed);
  const pick = list => list[Math.floor(rng() * list.length)];
  const rows = [];
  let at = 1_000_000;
  for (let i = 0; i < n; i++) {
    at += Math.floor(rng() * 200_000);
    const kind = pick(["crate", "well", "dice", "deck", "scratch", "roulette"]);
    const row = { id: `r${i}`, at, kind, boxId: kind, boxName: `Game ${kind}`, actorId: pick(ACTORS), actorName: "", price: pick([0.1, 1, 10, 150]), payoutCp: 0, day: "y1d1" };
    row.actorName = `Name ${row.actorId}`;
    if (rng() < 0.12) row.refunded = at + 5;
    if (kind === "dice" && rng() < 0.4) row.payoutCp = Math.round(row.price * 300);
    if (kind === "deck" && rng() < 0.2) row.payoutCp = -1000;
    if (kind === "scratch") Object.assign(row, { rollId: 1, tier: "dud", payoutCp: rng() < 0.3 ? 500 : 0 });
    if (kind === "roulette") Object.assign(row, { roundId: "R1", status: row.refunded ? "refunded" : "settled", payoutCp: rng() < 0.4 ? 2000 : 0 });
    if ((kind === "crate" || kind === "well") && rng() < 0.6) {
      Object.assign(row, { itemId: `i${i}`, itemIds: [`i${i}`], uuid: `Item.${i % 7}`, worth: { [`i${i}`]: W(pick([1, 25, 400]), pick(["gp", "sp"])) } });
      if (!row.refunded && rng() < 0.2) row.parted = { [`i${i}`]: rng() < 0.5 ? { at: at + 1, soldCp: 500 } : { at: at + 1, given: { actorId: pick(ACTORS), actorName: "Gift" } } };
    }
    if (rng() < 0.05 && kind !== "roulette") row.keep = { paid: row.price };
    rows.push(row);
  }
  return rows.reverse();
}

// The economy counted the plain way, straight from the rows: the reference.
function recount(log) {
  const chars = {}, games = {};
  const add = (map, key, field, n) => { if (n) { map[key] ??= {}; map[key][field] = (map[key][field] ?? 0) + n; } };
  for (const r of log) {
    if (r.refunded || r.house) continue;
    const taken = Math.round(r.price * 100) + Math.max(0, -r.payoutCp);
    const value = (r.itemIds ?? []).reduce((n, id) => n + worthCp(r.worth?.[id]), 0);
    add(games, r.boxId, "plays", r.keep ? 0 : 1);
    add(games, r.boxId, "taken", taken);
    add(games, r.boxId, "paid", Math.max(0, r.payoutCp));
    add(games, r.boxId, "items", value);
    add(chars, r.actorId, "spent", taken);
    add(chars, r.actorId, "paid", Math.max(0, r.payoutCp));
    add(chars, r.actorId, "items", value);
    for (const [id, part] of Object.entries(r.parted ?? {})) {
      if (part.given) { add(chars, r.actorId, "gave", worthCp(r.worth[id])); add(chars, part.given.actorId, "got", worthCp(r.worth[id])); }
      else { add(chars, r.actorId, "sold", part.soldCp); add(chars, r.actorId, "soldWorth", worthCp(r.worth[id])); }
    }
  }
  return { chars, games };
}
const numbers = map => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([f]) => f !== "name"))]));

describe("the move to version 3", () => {
  afterEach(cleanup);

  it("counts the economy from a 600-row log as a recount does, keeps version 2's counts, and is a no-op the second time", () => {
    expect(TALLY_VERSION).toBe(3);
    for (const seed of [5, 6, 7]) {
      const log = fixture(seed);
      const want = recount(log);
      expect(Object.keys(want.chars)).toHaveLength(3);
      // A version 2 world: its rows stamped, its counts as that build left them, no economy.
      const first = migrateLog({ log, tally: undefined });
      const v2 = first.tally;
      delete v2.chars;
      delete v2.games;
      v2.v = 2;
      // ... and a count only it holds (a row the trim dropped since).
      v2.buyers["a1.crate"] = { ...(v2.buyers["a1.crate"] ?? {}), bought: 999 };
      const moved = migrateLog({ log: first.log, tally: v2 });
      expect(moved.tally.v).toBe(TALLY_VERSION);
      expect(numbers(moved.tally.chars)).toEqual(want.chars);
      expect(numbers(moved.tally.games)).toEqual(want.games);
      expect(moved.tally.buyers["a1.crate"].bought).toBe(999);
      expect(moved.tally.rolls).toEqual(v2.rolls);
      // The same from 1.7.0 or before: built from the rows.
      const fresh = migrateLog({ log, tally: undefined }).tally;
      expect(numbers(fresh.chars)).toEqual(want.chars);
      expect(fresh.games).toEqual(tallyOf(log).games);
      // Run again, it does nothing.
      expect(migrateLog({ log: moved.log, tally: moved.tally })).toBeNull();
    }
  });

  it("catches up a row an older build wrote into a version 2 world, once", () => {
    const log = fixture(9, 50);
    const v2 = migrateLog({ log, tally: undefined });
    const tally = { ...v2.tally, v: 2 };
    delete tally.chars;
    delete tally.games;
    const late = { id: "late", at: 99_999_999, kind: "crate", boxId: "crate", boxName: "Game crate", actorId: "a2", actorName: "Name a2", price: 10, payoutCp: 0 };
    const rows = [late, ...v2.log];
    const moved = migrateLog({ log: rows, tally });
    expect(numbers(moved.tally.games)).toEqual(recount(rows).games);
    expect(moved.log[0].t).toBe(1);
    expect(moved.tally.buyers["a2.crate"].bought).toBe((tally.buyers["a2.crate"]?.bought ?? 0) + 1);
  });

  it("from the store: a version 2 world moves once on the active GM's load", async () => {
    const w = makeWorld();
    const log = fixture(3, 120);
    const v2 = migrateLog({ log, tally: undefined });
    const tally = { ...v2.tally, v: 2 };
    delete tally.chars;
    delete tally.games;
    w.put("pullLog", v2.log);
    w.put("actorState", { [TALLY_KEY]: tally });
    // Not moved yet, every client reads the economy from the rows.
    expect(numbers(getTally().games)).toEqual(recount(log).games);
    expect(await migrateTallies({ isActiveGM: () => true })).toBe(true);
    expect(w.get("actorState")[TALLY_KEY].v).toBe(3);
    expect(numbers(getTally().chars)).toEqual(recount(log).chars);
    expect(await migrateTallies({ isActiveGM: () => true })).toBe(false);
  });
});

/* ---------- The readout ---------- */

const SCRATCH_GAME = { id: "fortune", kind: "scratch", name: "Fortune Ticket", price: 5, roll: { id: 1, size: 100, prizes: [{ count: 10, gp: 10 }, { count: 2, gp: 50 }] } };

describe("payback, actual against set", () => {
  it("for a scratch roll: the plan's coins over what the roll takes in, against what its tickets paid", () => {
    expect(paybackOf(SCRATCH_GAME).pct).toBe(40);
    expect(setPayback(SCRATCH_GAME)).toEqual({ pct: 40, items: false });
    const games = { fortune: { name: "Fortune Ticket", plays: 20, taken: 10000, paid: 3000, items: 1500 } };
    const [line] = gameLines(games, { fortune: SCRATCH_GAME });
    expect(line).toMatchObject({ name: "Fortune Ticket", plays: 20, actual: 45, set: { pct: 40, items: false } });
    expect(setText(line.set)).toBe("40%");
    const html = economyHTML({ tally: { chars: {}, games }, boxes: { fortune: SCRATCH_GAME } });
    expect(html).toMatch(/Fortune Ticket<\/th><td class="lc-econ__num">20<\/td><td class="lc-econ__num">100 gp<\/td><td class="lc-econ__num">30 gp<\/td><td class="lc-econ__num">15 gp<\/td><td class="lc-econ__num">45%<\/td><td class="lc-econ__num">40%<\/td>/);
  });

  it("a roll that pays items says so; a well, the dice and a wheel state theirs; a crate or a deleted game is blank", () => {
    expect(setText(setPayback({ ...SCRATCH_GAME, roll: { id: 1, size: 100, prizes: [{ count: 10, gp: 10 }, { count: 1, item: { rarity: "rare" } }] } }))).toBe("20% + items");
    expect(wellPayback({ odds: { nothing: 90, coin: 8, item: 2 } })).toEqual({ pct: 8, items: true });
    expect(wellPayback({ odds: { nothing: 90, coin: 10, item: 0 } })).toEqual({ pct: 10, items: false });
    expect(dicePayback({ dice: { formula: "3d6", target: 12, multiplier: 3 }, rules: {} })).toEqual({ pct: Math.round(winChance(3, 6, 12) * 300), items: false });
    // Twelve pockets, colour and number paying evenly (100%); a rarity band
    // of 5 pockets at 3x pays 125%, the lone legendary 25%; items on top.
    const pockets = ["common", "uncommon", "common", "uncommon", "rare", "common", "uncommon", "common", "legendary", "uncommon", "common", "rare"].map((rarity, i) => ({ colour: i % 2, rarity }));
    const wheel = { kind: "roulette", roulette: { colours: ["Red", "Black"], pockets, payouts: { colour: 2, parity: 2, number: 12, rarity: 3 }, itemOnRarity: true } };
    expect(wheelPayback(wheel)).toEqual({ min: 25, max: 125, items: true });
    const even = { kind: "roulette", roulette: { colours: ["Red", "Black"], pockets: pockets.map(p => ({ ...p, rarity: "common" })), payouts: { colour: 2, parity: 2, number: 12, rarity: 1 }, itemOnRarity: false } };
    expect(wheelPayback(even)).toEqual({ pct: 100, items: false });
    expect(setText({ min: 25, max: 125, items: true })).toBe("25–125% + items");
    expect(setPayback({ id: "c", name: "Crate", price: 10 })).toBeNull();
    const [gone] = gameLines({ old: { name: "Old Crate", plays: 1, taken: 100 } }, {});
    expect(gone).toMatchObject({ name: "Old Crate", actual: 0, set: null });
    expect(gameLines({ t: { name: "Tickets", plays: 2 } }, {})[0].actual).toBeNull();
  });
});

describe("the periods", () => {
  it("This session counts only the rows since the GM's load, from the log; All time the tallies", () => {
    const since = 1000;
    const log = [crate({ id: "new", at: 1500 }), crate({ id: "edge", at: 1000, actorId: "bo", actorName: "Bo" }), crate({ id: "old", at: 900, actorId: "orla", actorName: "Orla" })];
    const session = economyOf({ period: "session", log, since });
    expect(Object.keys(session.chars).sort()).toEqual(["bo", "tam"]);
    expect(session.games.box.plays).toBe(2);
    const tally = tallyOf(log);
    expect(economyOf({ period: "all", tally, log, since }).games.box.plays).toBe(3);
    // Trimmed off the log, a play still counts in All time.
    expect(economyOf({ period: "all", tally, log: [], since }).games.box.plays).toBe(3);
    const html = economyHTML({ tally, log, since, period: "session" });
    expect(html).toContain('data-period="session" aria-pressed="true"');
    expect(html).toContain("This session counts the plays since you loaded the world, read from the Pull log.");
    expect(html).toContain("By character, this session");
    expect(html).not.toContain("Orla");
  });

  it("sorts characters by Spent and games by Taken, Net below nothing with a minus", () => {
    const chars = { a: { name: "Ann", spent: 100 }, b: { name: "Bo", spent: 5000, paid: 1000 }, c: { name: "Cy", spent: 100, items: 900 } };
    expect(charLines(chars).map(l => l.name)).toEqual(["Bo", "Ann", "Cy"]);
    const html = economyHTML({ tally: { chars, games: { g1: { name: "Small", taken: 10 }, g2: { name: "Big", taken: 900 } } } });
    expect(html.indexOf("Big")).toBeLessThan(html.indexOf("Small"));
    expect(html).toContain("−40 gp");
    expect(html).toContain('data-period="all" aria-pressed="true"');
  });

  it("an empty world's readout says what will show, with no table", () => {
    const html = economyHTML({ tally: emptyTally(), log: [] });
    expect(html).toContain("No plays yet.");
    expect(html).not.toContain("<table");
    expect(economyHTML({ tally: emptyTally(), log: [], period: "session" })).toContain("No plays this session yet.");
  });

  it("escapes names", () => {
    const html = economyHTML({ tally: { chars: { a: { name: "<b>x</b>", spent: 1 } }, games: {} }, esc: s => String(s).replace(/</g, "&lt;") });
    expect(html).not.toContain("<b>x");
  });
});

describe("on the manager's Pull log tab", () => {
  let CrateManager;
  let isGM = true;
  const log = [crate({ t: 1 })];
  beforeAll(async () => {
    vi.stubGlobal("foundry", { utils: { escapeHTML: s => String(s), deepClone: v => structuredClone(v) }, applications: { api: { ApplicationV2: class {}, DialogV2: class {} } } });
    vi.stubGlobal("game", { get user() { return { id: "u", isGM }; }, settings: { get: (_m, key) => (key === "pullLog" ? log : key === "actorState" ? { [TALLY_KEY]: tallyOf(log) } : {}) } });
    ({ CrateManager } = await import("../module/scripts/foundry/manager.js"));
  });
  afterAll(() => vi.unstubAllGlobals());

  it("sits at the top for a GM, and isn't there for anyone else", () => {
    isGM = true;
    const html = new CrateManager()._log();
    expect(html.trimStart().startsWith('<section class="lc-econ"')).toBe(true);
    expect(html.indexOf("lc-econ")).toBeLessThan(html.indexOf("lc-table--log"));
    expect(html).toContain("<th scope=\"row\">Adventurer's Crate</th>");
    isGM = false;
    expect(new CrateManager()._log()).not.toContain("lc-econ");
  });

  it("switches period from its buttons (view state only)", () => {
    isGM = true;
    const m = new CrateManager();
    m.render = vi.fn();
    const action = CrateManager.DEFAULT_OPTIONS.actions.econPeriod;
    action.call(m, null, { dataset: { period: "session" } });
    expect(m.econPeriod).toBe("session");
    expect(m.render).toHaveBeenCalled();
    expect(m._log()).toContain('data-period="session" aria-pressed="true"');
    action.call(m, null, { dataset: { period: "bogus" } });
    expect(m.econPeriod).toBe("all");
  });
});

describe("econOf and applyEcon", () => {
  it("count nothing for a refunded row or a house bid, and take a row back to empty", () => {
    expect(econOf([crate({ refunded: 5 }), { id: "h", boxId: "lot", house: true, price: 0 }])).toEqual({ chars: {}, games: {} });
    const t = applyEcon(emptyTally(), crate(), 1);
    applyEcon(t, crate(), -1);
    expect(t).toEqual(emptyTally());
  });
});
