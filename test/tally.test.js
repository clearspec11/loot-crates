/*
  The tallies (core/tally.js, VIB-213): every count a rule reads is kept
  on its own, written in the same write as its log row (store.js), so the
  Pull log's 500-row trim changes no limit, scratch roll, deck or stake.
  The migration builds them once from whatever rows a world has, with the
  same numbers the log-based counts of 1.6.0 gave, and never again.
*/
import { describe, it, expect, afterEach, vi } from "vitest";
import { registerSettings, appendLog, recordPlay, getLog, getTally, migrateTallies, enqueueWrite, updateLog, updateLogRows } from "../module/scripts/foundry/store.js";
import { refundPull } from "../module/scripts/foundry/refund.js";
import { TALLY_VERSION, TALLY_KEY, DAYS_KEPT, LOG_CAP, tallyOf, migrateLog, trimLog, applyRow, emptyTally, boughtCount, playedOn, rollTally, wonCount, catchUp, countsChange, dayOrder } from "../module/scripts/core/tally.js";
import { boughtBy, limitState } from "../module/scripts/core/limits.js";
import { throwsToday } from "../module/scripts/games/well.js";
import { DECK, drawnIds, streakOf } from "../module/scripts/games/deck.js";
import { rollState } from "../module/scripts/games/scratch.js";
import { hiddenOf } from "../module/scripts/foundry/hidden.js";
import { seededRng, undoPull } from "../module/scripts/core/odds.js";

const tick = () => new Promise(r => setTimeout(r, 0));

/* The counts as 1.6.0 made them from the log, row for row (the reference). */
const old = {
  boughtBy: (log, { boxId, actorId, per = "ever", today = null }) => (per === "day" && !today ? 0 : log.filter(r => r.boxId === boxId && r.actorId === actorId && !r.refunded && !r.roundId && !r.redeem && (per !== "day" || r.day === today)).length),
  throwsToday: (log, { boxId, actorId, day }) => (!day ? 0 : log.filter(r => r.boxId === boxId && r.actorId === actorId && r.day === day && !r.refunded && !r.keep).length),
  rollRows: (log, { boxId, rollId }) => log.filter(r => r?.kind === "scratch" && r.boxId === boxId && Number(r.rollId) === rollId && !r.refunded && !r.keep),
  drawnIds: (log, { boxId, since, once }) => new Set(log.filter(r => r.kind === "deck" && r.boxId === boxId && !r.refunded && !r.keep && (Number(r.at) || 0) > since && r.cardId != null && once.has(String(r.cardId))).map(r => String(r.cardId))),
  streakOf: (log, { boxId, actorId, now, within }) => {
    const rows = log.filter(r => r.kind === "deck" && r.boxId === boxId && !r.refunded && !r.redeem?.kept && r.actorId === actorId).sort((a, b) => b.at - a.at);
    let n = 0, last = now;
    for (const r of rows) { if (last - r.at > within) break; n++; last = r.at; }
    return n;
  },
};

const ACTORS = ["a1", "a2", "a3"];
const DAYS = ["y1d1", "y1d2", "y1d3", "y1d4", "y1d5", "y1d6", "y1d7", "y1d8"];
const TIERS = ["gp.10", "gp.100", "item.rare", "bonus", "dud"];
const CARDS = ["c1", "c2", "c3", "c4"];
const UUIDS = ["Item.a", "Item.b", "Item.c", "Item.d", "Item.e"];

/*
  600 rows of every kind, newest first as the log keeps them: crate buys
  (some kept, some a ticket's play), well throws per day, deck draws (once
  cards, kept tickets, redeems), scratch tickets of two rolls with their
  tiers on the row as 1.6.0 wrote them, table stakes, and refunds.
*/
function fixture(seed = 7, n = 600) {
  const rng = seededRng(seed);
  const pick = list => list[Math.floor(rng() * list.length)];
  const rows = [];
  let at = 1_000_000;
  for (let i = 0; i < n; i++) {
    at += Math.floor(rng() * 200_000);
    const kind = pick(["crate", "well", "deck", "scratch", "roulette"]);
    const row = { id: `r${i}`, at, kind, boxId: kind === "crate" ? pick(["box", "box2"]) : kind, actorId: pick(ACTORS), price: 1, day: pick(DAYS) };
    if (rng() < 0.12) row.refunded = at + 5;
    const extra = kind === "roulette" ? 1 : rng();
    if (extra < 0.08) row.keep = { paid: 1 };
    else if (extra < 0.16) row.redeem = { paid: 1, kept: rng() < 0.5 };
    if (kind === "deck") row.cardId = pick(CARDS);
    if ((kind === "crate" || kind === "well") && !row.keep) row.uuid = pick(UUIDS);
    if (kind === "scratch") Object.assign(row, { rollId: pick([1, 2]), tier: pick(TIERS), ticketNo: i, winners: [0, 2] });
    if (kind === "roulette") Object.assign(row, { roundId: pick(["R1", "R2"]), status: row.refunded ? "refunded" : pick(["open", "settled"]), day: undefined });
    rows.push(row);
  }
  return rows.reverse();
}

// Every count the rules read, for every game and character: one object to compare.
function counts(read, log) {
  const out = {};
  for (const boxId of ["box", "box2", "well", "deck", "scratch"]) {
    for (const actorId of ACTORS) {
      out[`${boxId}.${actorId}.ever`] = read.bought({ boxId, actorId });
      for (const day of DAYS) {
        out[`${boxId}.${actorId}.${day}.bought`] = read.bought({ boxId, actorId, per: "day", today: day });
        out[`${boxId}.${actorId}.${day}.thrown`] = read.thrown({ boxId, actorId, day });
      }
    }
  }
  for (const rollId of [1, 2]) {
    const rows = read.roll({ boxId: "scratch", rollId });
    out[`roll${rollId}`] = rows;
  }
  const once = new Set(["c1", "c3"]);
  const end = Math.max(...log.map(r => r.at));
  for (const since of [0, end / 2, end - 2_000_000]) out[`drawn.${since}`] = [...read.drawn({ boxId: "deck", since, once })].sort();
  for (const actorId of ACTORS) for (const now of [end, end + 60_000, end - 3_000_000]) out[`streak.${actorId}.${now}`] = read.streak({ boxId: "deck", actorId, now, within: 300_000 });
  return out;
}
const fromLog = log => ({
  bought: o => old.boughtBy(log, o),
  thrown: o => old.throwsToday(log, o),
  roll: o => { const rows = old.rollRows(log, o); return { sold: rows.length, tiers: Object.fromEntries(TIERS.map(t => [t, rows.filter(r => r.tier === t).length]).filter(([, n]) => n)) }; },
  drawn: o => old.drawnIds(log, o),
  streak: o => old.streakOf(log, o),
});
const DECK_GAME = (since, once) => ({ id: "deck", deck: { shuffledAt: since, cards: CARDS.map(id => ({ id, kind: "blank", weight: 1, once: once.has(id) })) } });
const fromTally = tally => ({
  bought: o => boughtBy(tally, o),
  thrown: o => throwsToday(tally, o),
  roll: o => rollTally(tally, o),
  drawn: o => drawnIds(DECK_GAME(o.since, o.once), tally),
  streak: o => streakOf(tally, o),
});

function makeWorld({ actor = null } = {}) {
  const settings = new Map();
  const sets = [];
  globalThis.game = {
    user: { id: "gm" },
    actors: { get: id => (actor && id === actor.id ? actor : null) },
    settings: {
      register: (ns, key, { default: def }) => settings.set(`${ns}.${key}`, def),
      get: (ns, key) => settings.get(`${ns}.${key}`),
      async set(ns, key, value) { await tick(); sets.push(key); settings.set(`${ns}.${key}`, structuredClone(value)); },
    },
  };
  globalThis.foundry = { utils: { randomID: n => Math.random().toString(36).slice(2, 2 + n), deepClone: v => structuredClone(v) } };
  registerSettings();
  return { settings, sets, put: (key, value) => settings.set(`loot-crates.${key}`, structuredClone(value)) };
}

afterEach(() => { delete globalThis.game; delete globalThis.foundry; delete globalThis.CONFIG; });

describe("the tallies, against the log-based counts of 1.6.0", () => {
  it("count what the log did, row for row, on a 600-row log of every kind", () => {
    for (const seed of [7, 8, 9]) {
      const log = fixture(seed);
      expect(log).toHaveLength(600);
      const want = counts(fromLog(log), log);
      expect(counts(fromTally(tallyOf(log)), log)).toEqual(want);
      // The migration's tallies (the hidden columns moved off the rows) are the same numbers.
      const moved = migrateLog({ log, tally: undefined });
      expect(moved.tally.v).toBe(TALLY_VERSION);
      expect(moved.log.some(r => "tier" in r || "ticketNo" in r || "winners" in r)).toBe(false);
      expect(counts(fromTally(moved.tally), log)).toEqual(want);
      // A scratch row's tier, number and winners are kept by row id.
      const ticket = log.find(r => r.kind === "scratch");
      expect(hiddenOf(moved.tally, ticket.id)).toEqual({ tier: ticket.tier, ticketNo: ticket.ticketNo, winners: ticket.winners });
      // Run again, it does nothing.
      expect(migrateLog({ log: moved.log, tally: moved.tally })).toBeNull();
    }
  });

  it("read from the tally alone: a tally with no log counts, a log with no tally counts nothing", () => {
    const log = fixture(3, 100);
    const tally = tallyOf(log);
    const someone = log.find(r => r.kind === "crate" && !r.refunded && !r.redeem && !r.roundId);
    const by = { boxId: someone.boxId, actorId: someone.actorId };
    expect(boughtBy(tally, by)).toBe(old.boughtBy(log, by));
    expect(boughtBy(tally, by)).toBeGreaterThan(0);
    expect(boughtBy(null, by)).toBe(0);
    expect(limitState({ id: by.boxId, rules: { perCharacter: { max: 1 } } }, { tally, actorId: by.actorId })).toMatchObject({ reached: true });
    expect(limitState({ id: by.boxId, rules: { perCharacter: { max: 1 } } }, { log, actorId: by.actorId })).toMatchObject({ bought: 0, reached: false });
    expect(rollState({ id: "scratch", roll: { id: 1, size: 1000 } }, { log }).sold).toBe(0);
  });

  it("migrate an empty or missing log to empty tallies", () => {
    expect(migrateLog({ log: [], tally: undefined }).tally).toEqual(emptyTally());
    expect(migrateLog({ log: undefined, tally: null }).tally).toEqual(emptyTally());
  });

  it("move by the difference a patch makes: a refund takes the row out, lifting it puts it back", () => {
    const row = { id: "x", kind: "scratch", boxId: "s", actorId: "a", rollId: 1, day: "y1d1", at: 5 };
    const t = applyRow(emptyTally(), row, 1, { tier: "gp.10" });
    expect(rollTally(t, { boxId: "s", rollId: 1 })).toEqual({ sold: 1, tiers: { "gp.10": 1 } });
    expect(boughtCount(t, { boxId: "s", actorId: "a", per: "day", today: "y1d1" })).toBe(1);
    applyRow(t, row, -1, { tier: "gp.10" });
    expect(t).toEqual(emptyTally());
  });
});

describe("the trim", () => {
  const rounds = { R1: { id: "R1", status: "open" }, R2: { id: "R2", status: "resolved" } };
  it("keeps the newest rows, and past them every open stake and every row of a round not yet resolved", () => {
    const log = [
      { id: "new" },
      { id: "open-stake", roundId: "R1", status: "open" },
      { id: "outbid", roundId: "R1", status: "refunded", refunded: 1 },
      { id: "settled", roundId: "R2", status: "settled" },
      { id: "orphan", roundId: "gone", status: "open" },
      { id: "old" },
    ];
    expect(trimLog(log, { cap: 1, rounds })).toEqual({ log: [log[0], log[1], log[2], log[4]], dropped: ["settled", "old"] });
    expect(trimLog(log, { cap: 0, rounds }).log.map(r => r.id)).toEqual(["open-stake", "outbid", "orphan"]);
    expect(trimLog(log, { cap: 10, rounds }).dropped).toEqual([]);
    expect(LOG_CAP).toBe(500);
  });
});

describe("the store: one write for the row and its tallies", () => {
  const LIMITED = { id: "box", name: "Limited", price: 1, rules: { perCharacter: { max: 1, per: "ever" } } };

  it("moves a 1.6.0 world once, on the active GM, keeps the counts of rows the trim drops, and is a no-op the second time", async () => {
    const { sets, put } = makeWorld();
    const log = fixture(11);
    put("pullLog", log);
    const want = counts(fromLog(log), log);
    // A world not moved yet reads the same counts, from its log.
    expect(counts(fromTally(getTally()), log)).toEqual(want);
    expect(await migrateTallies({ isActiveGM: () => false })).toBe(false);
    expect(sets).toEqual([]);
    expect(await migrateTallies({ isActiveGM: () => true })).toBe(true);
    // The log is trimmed to 500, every rule still counts all 600 rows.
    expect(getLog().length).toBeLessThanOrEqual(LOG_CAP + log.filter(r => r.status === "open").length);
    expect(getLog().length).toBeLessThan(600);
    expect(getLog().some(r => "tier" in r)).toBe(false);
    expect(counts(fromTally(getTally()), log)).toEqual(want);
    const written = sets.length;
    expect(await migrateTallies({ isActiveGM: () => true })).toBe(false);
    expect(sets).toHaveLength(written);
  });

  it("two GMs loading together write the move once", async () => {
    const { sets, put } = makeWorld();
    put("pullLog", fixture(12, 50));
    const results = await Promise.all([migrateTallies({ isActiveGM: () => true }), migrateTallies({ isActiveGM: () => true })]);
    expect(results.sort()).toEqual([false, true]);
    expect(sets.filter(k => k === "actorState")).toHaveLength(1);
  });

  it("is safe on a world with no log at all", async () => {
    makeWorld();
    expect(await migrateTallies()).toBe(true);
    expect(getTally()).toEqual(emptyTally());
    expect(getLog()).toEqual([]);
  });

  it("a log trimmed to nothing changes no limit, scratch roll, deck or stake", async () => {
    const { put } = makeWorld();
    put("tableRounds", { R1: { id: "R1", boxId: "wheel", status: "open" } });
    await appendLog({ kind: "crate", boxId: "box", actorId: "a1", price: 1, day: "y1d1" });
    await appendLog({ kind: "well", boxId: "well", actorId: "a1", price: 0.1, day: "y1d1" });
    await appendLog({ kind: "scratch", boxId: "scratch", actorId: "a1", price: 5, rollId: 1 }, { hidden: { tier: "gp.100", ticketNo: 1, winners: [3] } });
    await appendLog({ kind: "deck", boxId: "deck", actorId: "a1", price: 10, cardId: "c1" });
    await appendLog({ kind: "roulette", boxId: "wheel", actorId: "a1", price: 2, status: "open", roundId: "R1" });
    const before = getTally();
    const scratch = getLog().find(r => r.kind === "scratch");
    expect(scratch).not.toHaveProperty("tier");
    expect(hiddenOf(before, scratch.id)).toEqual({ tier: "gp.100", ticketNo: 1, winners: [3] });
    // Every row falls off but the stake.
    expect(trimLog(getLog(), { cap: 0, rounds: { R1: { status: "open" } } }).log.map(r => r.kind)).toEqual(["roulette"]);
    put("pullLog", trimLog(getLog(), { cap: 0, rounds: { R1: { status: "open" } } }).log);
    const after = getTally();
    expect(boughtBy(after, { boxId: "box", actorId: "a1" })).toBe(1);
    expect(limitState(LIMITED, { tally: after, actorId: "a1" })).toMatchObject({ reached: true });
    expect(playedOn(after, { boxId: "well", actorId: "a1", day: "y1d1" })).toBe(1);
    expect(rollTally(after, { boxId: "scratch", rollId: 1 })).toEqual({ sold: 1, tiers: { "gp.100": 1 } });
    expect(drawnIds(DECK_GAME(0, new Set(["c1"])), after)).toEqual(new Set(["c1"]));
    expect(getLog().filter(r => r.status === "open")).toHaveLength(1);
    // The next row keeps them as they were.
    await appendLog({ kind: "crate", boxId: "box2", actorId: "a2", price: 1 });
    expect(boughtBy(getTally(), { boxId: "box", actorId: "a1" })).toBe(1);
    expect(boughtBy(getTally(), { boxId: "box2", actorId: "a2" })).toBe(1);
    // A row trimmed off takes its hidden columns with it.
    expect(hiddenOf(getTally(), scratch.id)).toBeNull();
  });

  it("keeps 500 rows past the cap, the counts of the rest kept", async () => {
    makeWorld();
    const many = Array.from({ length: LOG_CAP + 20 }, (_, i) => ({ id: `r${i}`, at: i, kind: "crate", boxId: "box", actorId: "a1", price: 1 }));
    globalThis.game.settings.set("loot-crates", "pullLog", []);
    for (const r of many) await appendLog(r);
    expect(getLog()).toHaveLength(LOG_CAP);
    expect(boughtBy(getTally(), { boxId: "box", actorId: "a1" })).toBe(LOG_CAP + 20);
  });

  it("writes the row, its tallies, the buyer's state and the stock in one Setting update", async () => {
    const { settings } = makeWorld();
    // Stored documents for each setting, as a world that has written them has.
    const docs = new Map();
    for (const key of ["pullLog", "actorState", "boxes"]) docs.set(`id-${key}`, { _id: `id-${key}`, key });
    globalThis.game.settings.get = (ns, key, { document = false } = {}) => (document ? { _id: `id-${key}` } : settings.get(`${ns}.${key}`));
    globalThis.game.settings.storage = new Map([["world", docs]]);
    const updateDocuments = vi.fn(async updates => { for (const u of updates) settings.set(`loot-crates.${docs.get(u._id).key}`, JSON.parse(u.value)); });
    globalThis.CONFIG = { Setting: { documentClass: { updateDocuments } } };
    settings.set("loot-crates.boxes", { box: { ...LIMITED, rules: { ...LIMITED.rules, stock: 3 } } });
    await recordPlay({ row: { id: "p1", kind: "crate", boxId: "box", actorId: "a1", price: 1 }, state: { pulls: 1 }, box: { ...LIMITED, rules: { ...LIMITED.rules, stock: 3 } }, stock: 2 });
    expect(updateDocuments).toHaveBeenCalledTimes(1);
    expect(updateDocuments.mock.calls[0][0].map(u => u._id).sort()).toEqual(["id-actorState", "id-boxes", "id-pullLog"]);
    expect(settings.get("loot-crates.actorState")["a1.box"]).toEqual({ pulls: 1 });
    expect(boughtBy(settings.get("loot-crates.actorState").tallies, { boxId: "box", actorId: "a1" })).toBe(1);
    expect(settings.get("loot-crates.boxes").box.rules.stock).toBe(2);
  });
});

describe("a refund, and Draw again, undo the tally", () => {
  const DECK_RISE = { id: "deck", kind: "deck", name: "The Deck", price: 10, pools: [], deck: { step: 2, streakMinutes: 5, cards: [{ id: "c1", label: "Blank", kind: "blank", weight: 1, once: true }, { id: "c2", label: "Blank", kind: "blank", weight: 1 }] } };
  const actorOf = () => {
    const actor = { id: "a1", name: "Brinn", items: new Map(), system: { currency: { pp: 0, gp: 100, ep: 0, sp: 0, cp: 0 } }, async update(d) { await tick(); if (d["system.currency"]) actor.system.currency = d["system.currency"]; } };
    return actor;
  };

  it("a refund takes the row's count back in the write that marks it", async () => {
    const actor = actorOf();
    const { sets, put } = makeWorld({ actor });
    put("boxes", { box: { id: "box", name: "Limited", price: 1, rules: { perCharacter: { max: 1 } } } });
    await recordPlay({ row: { id: "p1", kind: "crate", boxId: "box", boxName: "Limited", actorId: "a1", actorName: "Brinn", price: 1, itemId: null, day: "y1d1" }, state: { pulls: 1 } });
    expect(boughtBy(getTally(), { boxId: "box", actorId: "a1" })).toBe(1);
    sets.length = 0;
    expect((await refundPull("p1")).status).toBe("refunded");
    // The mark is the first write: the log and the tallies together.
    expect(sets.slice(0, 2).sort()).toEqual(["actorState", "pullLog"]);
    expect(boughtBy(getTally(), { boxId: "box", actorId: "a1" })).toBe(0);
    expect(boughtBy(getTally(), { boxId: "box", actorId: "a1", per: "day", today: "y1d1" })).toBe(0);
  });

  it("Draw again offers the risen price from the tally, and the base again once the draw is refunded", async () => {
    const actor = actorOf();
    const { put } = makeWorld({ actor });
    put("boxes", { deck: DECK_RISE });
    const now = Date.now();
    await recordPlay({ row: { id: "d1", at: now - 1000, kind: "deck", boxId: "deck", boxName: "The Deck", actorId: "a1", actorName: "Brinn", price: 10, payoutCp: 0, itemId: null, cardId: "c1" } });
    const offer = () => DECK.reveal.again({ actorId: "a1", userId: "p1" }, { game: DECK_RISE, tally: getTally(), purse: { gp: 100 }, now });
    expect(offer()).toMatchObject({ price: 20, off: "" });
    expect(drawnIds(DECK_RISE, getTally())).toEqual(new Set(["c1"]));
    expect((await refundPull("d1")).status).toBe("refunded");
    expect(offer()).toMatchObject({ price: 10, off: "" });
    expect(drawnIds(DECK_RISE, getTally())).toEqual(new Set());
  });

  it("a patch that lifts a refund (a kept ticket already gone) puts the count back", async () => {
    makeWorld();
    await appendLog({ id: "k", kind: "crate", boxId: "box", actorId: "a1", price: 1 });
    await enqueueWrite(() => updateLog("k", { refunded: 5 }));
    expect(boughtBy(getTally(), { boxId: "box", actorId: "a1" })).toBe(0);
    await enqueueWrite(() => updateLog("k", { refunded: null }));
    expect(boughtBy(getTally(), { boxId: "box", actorId: "a1" })).toBe(1);
  });
});

/* ---------- VIB-217: counts that survive mixed builds, patches and the trim ---------- */

// The plays holding each item, per character and game, counted from the log.
const wonFromLog = log => {
  const out = {};
  for (const r of log) if (r.uuid && !r.refunded && !r.keep && r.actorId && r.boxId) out[`${r.actorId}.${r.boxId}.${r.uuid}`] = (out[`${r.actorId}.${r.boxId}.${r.uuid}`] ?? 0) + 1;
  return out;
};
const wonFromTally = (tally, log) => {
  const out = {};
  for (const r of log) {
    if (!r.uuid || !r.actorId || !r.boxId) continue;
    const n = wonCount(tally, { actorId: r.actorId, boxId: r.boxId, uuid: r.uuid });
    if (n) out[`${r.actorId}.${r.boxId}.${r.uuid}`] = n;
  }
  return out;
};
// 1.7.0's tallies for a log: the same counts, no `won`, version 1.
const legacyOf = log => {
  const t = tallyOf(log);
  for (const b of Object.values(t.buyers)) delete b.won;
  for (const [k, b] of Object.entries(t.buyers)) if (!Object.keys(b).length) delete t.buyers[k];
  return { ...t, v: 1 };
};

describe("the owned tally (won) and the move to version 2", () => {
  it("matches the log on a 600-row fixture, stamps every row, and is a no-op the second time", () => {
    for (const seed of [7, 8, 9]) {
      const log = fixture(seed);
      const moved = migrateLog({ log, tally: undefined });
      expect(moved.tally.v).toBe(TALLY_VERSION);
      expect(wonFromTally(moved.tally, log)).toEqual(wonFromLog(log));
      expect(Object.keys(wonFromLog(log)).length).toBeGreaterThan(20);
      expect(moved.log.every(r => r.t === (r.refunded ? 0 : 1))).toBe(true);
      expect(migrateLog({ log: moved.log, tally: moved.tally, legacy: legacyOf(log) })).toBeNull();
      // From 1.7.0's tallies: the same counts, and the same won from the rows.
      const fromLegacy = migrateLog({ log, tally: undefined, legacy: legacyOf(log) });
      expect(counts(fromTally(fromLegacy.tally), log)).toEqual(counts(fromLog(log), log));
      expect(wonFromTally(fromLegacy.tally, log)).toEqual(wonFromLog(log));
    }
  });

  it("raises 1.7.0's counts to the log's where an older GM wrote rows 1.7.0 never counted", () => {
    const log = fixture(21);
    // A 1.6 GM, not reloaded, wrote the newest 5 rows after 1.7.0 moved over.
    const legacy = legacyOf(log.slice(5));
    const moved = migrateLog({ log, tally: undefined, legacy });
    expect(counts(fromTally(moved.tally), log)).toEqual(counts(fromLog(log), log));
    // And keeps what 1.7.0 counted from rows the log has since dropped.
    const trimmed = migrateLog({ log: log.slice(0, 100), tally: undefined, legacy: legacyOf(log) });
    expect(counts(fromTally(trimmed.tally), log)).toEqual(counts(fromLog(log), log));
  });

  it("seeds won from the no-duplicates record for an item whose rows the log no longer has", () => {
    const moved = migrateLog({ log: [], tally: undefined, states: { "a1.box": { owned: ["Item.x"], sinceRare: 0 }, tally: { v: 1 } } });
    expect(wonCount(moved.tally, { actorId: "a1", boxId: "box", uuid: "Item.x" })).toBe(1);
  });
});

describe("a row another build wrote or refunded is counted once (catchUp)", () => {
  it("counts an unstamped row once, and a refund of an older row leaves the right count (S2)", async () => {
    const { put } = makeWorld();
    await appendLog({ id: "old", at: 1, kind: "crate", boxId: "box", actorId: "a1", price: 1, day: "y1d1", uuid: "Item.a" });
    await appendLog({ id: "mid", at: 2, kind: "crate", boxId: "box", actorId: "a1", price: 1, day: "y1d1", uuid: "Item.a" });
    expect(boughtBy(getTally(), { boxId: "box", actorId: "a1" })).toBe(2);
    // A GM client of 1.6 (or 1.7.0), not reloaded, appends a row with no stamp.
    put("pullLog", [{ id: "stray", at: 3, kind: "crate", boxId: "box", actorId: "a1", price: 1, day: "y1d1", uuid: "Item.a" }, ...getLog()]);
    expect(boughtBy(getTally(), { boxId: "box", actorId: "a1" })).toBe(3);
    expect(boughtBy(getTally(), { boxId: "box", actorId: "a1" })).toBe(3);
    // The next write counts it once and stamps it.
    await appendLog({ id: "new", at: 4, kind: "crate", boxId: "box", actorId: "a1", price: 1, day: "y1d1" });
    expect(getLog().find(r => r.id === "stray").t).toBe(1);
    expect(boughtBy(getTally(), { boxId: "box", actorId: "a1" })).toBe(4);
    expect(boughtBy(getTally(), { boxId: "box", actorId: "a1", per: "day", today: "y1d1" })).toBe(4);
    // A refund of an older row takes back exactly one.
    await enqueueWrite(() => updateLog("old", { refunded: 9 }));
    expect(boughtBy(getTally(), { boxId: "box", actorId: "a1" })).toBe(3);
    expect(wonCount(getTally(), { boxId: "box", actorId: "a1", uuid: "Item.a" })).toBe(2);
  });

  it("takes back a counted row an older build refunded, once", async () => {
    const { put } = makeWorld();
    await appendLog({ id: "x", at: 1, kind: "crate", boxId: "box", actorId: "a1", price: 1 });
    // A 1.7.0 GM refunds it: the mark is on the row, the stamp still says counted.
    put("pullLog", getLog().map(r => ({ ...r, refunded: 5 })));
    expect(boughtBy(getTally(), { boxId: "box", actorId: "a1" })).toBe(0);
    await appendLog({ id: "y", at: 2, kind: "crate", boxId: "box2", actorId: "a1", price: 1 });
    expect(boughtBy(getTally(), { boxId: "box", actorId: "a1" })).toBe(0);
    expect(getLog().find(r => r.id === "x").t).toBe(0);
  });

  it("doesn't count twice what a 1.7.0 GM counted into its own tally", async () => {
    const { settings, put } = makeWorld();
    await appendLog({ id: "x", at: 1, kind: "crate", boxId: "box", actorId: "a1", price: 1 });
    // 1.7.0 keeps counting into `tally` (version 1), never into ours.
    const state = settings.get("loot-crates.actorState");
    put("actorState", { ...state, tally: { v: 1, buyers: { "a1.box": { bought: 7 } }, rolls: {}, decks: {}, hidden: {} } });
    put("pullLog", [{ id: "z", at: 2, kind: "crate", boxId: "box", actorId: "a1", price: 1 }, ...getLog()]);
    expect(boughtBy(getTally(), { boxId: "box", actorId: "a1" })).toBe(2);
    await appendLog({ id: "w", at: 3, kind: "crate", boxId: "box", actorId: "a1", price: 1 });
    expect(boughtBy(getTally(), { boxId: "box", actorId: "a1" })).toBe(3);
    expect(Object.keys(settings.get("loot-crates.actorState"))).toEqual(expect.arrayContaining([TALLY_KEY, "tally"]));
  });

  it("is pure and idempotent: a second catchUp changes nothing", () => {
    const tally = emptyTally();
    const log = [{ id: "a", kind: "crate", boxId: "b", actorId: "x" }, { id: "r", kind: "crate", boxId: "b", actorId: "x", refunded: 1 }];
    expect(catchUp(tally, log)).toBe(2);
    expect(boughtCount(tally, { boxId: "b", actorId: "x" })).toBe(1);
    expect(catchUp(tally, log)).toBe(0);
    expect(boughtCount(tally, { boxId: "b", actorId: "x" })).toBe(1);
  });
});

describe("day tallies trimmed by date (S5)", () => {
  const day = n => `y1d${n}`;
  it("keeps today when late cancels and a lifted refund touch rows on older days", async () => {
    makeWorld();
    // Day 1's row was refunded; days 2 to 30 have a play each; today is day 31.
    await appendLog({ id: "d1", at: 1, kind: "well", boxId: "well", actorId: "a1", price: 1, day: day(1), refunded: 2 });
    for (let n = 2; n <= 30; n++) await appendLog({ id: `d${n}`, at: n, kind: "well", boxId: "well", actorId: "a1", price: 1, day: day(n) });
    const today = day(31);
    await appendLog({ id: "today", at: 31, kind: "well", boxId: "well", actorId: "a1", price: 1, day: today });
    expect(Object.keys(getTally().buyers["a1.well"].days)).toHaveLength(DAYS_KEPT);
    // Late cancels marked on every older day's row (a mark that changes no
    // count): written as days by insertion, they put today first in line.
    await enqueueWrite(() => updateLogRows(Array.from({ length: 29 }, (_, i) => [`d${i + 2}`, { lateCancel: 99 }])));
    expect(playedOn(getTally(), { boxId: "well", actorId: "a1", day: today })).toBe(1);
    // Day 1's refund is lifted: a 31st day. The oldest goes, not today.
    await enqueueWrite(() => updateLog("d1", { refunded: null }));
    const t = getTally();
    expect(playedOn(t, { boxId: "well", actorId: "a1", day: today })).toBe(1);
    expect(playedOn(t, { boxId: "well", actorId: "a1", day: day(2) })).toBe(1);
    expect(playedOn(t, { boxId: "well", actorId: "a1", day: day(1) })).toBe(0);
    expect(Object.keys(t.buyers["a1.well"].days)).toHaveLength(DAYS_KEPT);
    // The purchase count, which isn't per day, has it.
    expect(boughtBy(t, { boxId: "well", actorId: "a1" })).toBe(31);
  });

  it("orders day keys by the day, not as text or as written", () => {
    expect([day(10), day(9), "y2d1", "y1d100"].sort((a, b) => { const x = dayOrder(a), y = dayOrder(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; })).toEqual([day(9), day(10), "y1d100", "y2d1"]);
    let t = emptyTally();
    for (let n = DAYS_KEPT + 5; n >= 1; n--) t = applyRow(t, { id: `r${n}`, kind: "well", boxId: "w", actorId: "a", day: day(n) });
    const kept = Object.keys(t.buyers["a.w"].days);
    expect(kept).toHaveLength(DAYS_KEPT);
    expect(kept).toContain(day(DAYS_KEPT + 5));
    expect(kept).not.toContain(day(5));
  });

  it("says a patch that changes nothing a tally reads changes nothing", () => {
    const row = { id: "x", kind: "crate", boxId: "b", actorId: "a", day: "y1d1", at: 3 };
    expect(countsChange(row, { ...row, lateCancel: 5, status: "settled" })).toBe(false);
    // A settle's payout moves the economy (VIB-218).
    expect(countsChange(row, { ...row, status: "settled", payoutCp: 10 })).toBe(true);
    expect(countsChange(row, { ...row, refunded: 5 })).toBe(true);
  });
});

describe("a refund's no-duplicates undo reads the tally (odds.js undoPull)", () => {
  const row = { id: "r2", at: 2, kind: "crate", boxId: "box", actorId: "a1", uuid: "Item.a", before: { sinceRare: 0, hadItem: true }, resetPity: false };
  it("keeps an item another live play still holds, with the log trimmed to nothing", () => {
    const tally = tallyOf([row, { ...row, id: "r1", at: 1 }]);
    expect(wonCount(tally, { boxId: "box", actorId: "a1", uuid: "Item.a" })).toBe(2);
    // The log has lost both rows; the tally still knows r1 holds it.
    expect(undoPull({ owned: ["Item.a"], pulls: 2, sinceRare: 1 }, row, [], tally).owned).toEqual(["Item.a"]);
    // With only this play holding it, it leaves the record.
    expect(undoPull({ owned: ["Item.a"], pulls: 1, sinceRare: 1 }, row, [], tallyOf([row])).owned).toEqual([]);
    // Read again after the refund is written (the row marked, the tally moved).
    const after = tallyOf([{ ...row, refunded: 5 }, { ...row, id: "r1", at: 1 }]);
    expect(undoPull({ owned: ["Item.a"], pulls: 2 }, row, [{ ...row, refunded: 5 }], after).owned).toEqual(["Item.a"]);
    expect(undoPull({ owned: ["Item.a"], pulls: 1 }, row, [{ ...row, refunded: 5 }], tallyOf([{ ...row, refunded: 5 }])).owned).toEqual([]);
  });

  it("from the store: a refund of a play whose sibling was trimmed keeps the item owned", async () => {
    const actor = { id: "a1", name: "Brinn", items: new Map(), system: { currency: { pp: 0, gp: 100, ep: 0, sp: 0, cp: 0 } }, async update(d) { await tick(); if (d["system.currency"]) actor.system.currency = d["system.currency"]; } };
    const { put } = makeWorld({ actor });
    put("boxes", { box: { id: "box", name: "Unique", price: 1, rules: { noDuplicates: true } } });
    await recordPlay({ row: { ...row, id: "r1", at: 1, boxName: "Unique", actorName: "Brinn", price: 1, itemId: null }, state: { owned: ["Item.a"], pulls: 1, sinceRare: 1 } });
    await recordPlay({ row: { ...row, boxName: "Unique", actorName: "Brinn", price: 1, itemId: null }, state: { owned: ["Item.a"], pulls: 2, sinceRare: 2 } });
    // r1 falls off the log.
    put("pullLog", getLog().filter(r => r.id !== "r1"));
    const out = await refundPull("r2");
    expect(out.status).toBe("refunded");
    expect(out.state.after.owned).toEqual(["Item.a"]);
  });
});
