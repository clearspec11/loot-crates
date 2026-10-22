/*
  The Wishing Well (well.js) on the core: the odds and the roll (nothing,
  the coin back, a find, pity), the cap per in-game day counted from the
  log, the row and its refund, the shop card's words, the reveal's head,
  result and animation, the chat card only for a find, and the Pull log's
  folded misses. Real pull.js, socket.js, refund.js, chat.js and store.js on
  a fake world; reveal.js is mocked where the socket path needs it.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDocument } from "./minidom.js";

vi.mock("../module/scripts/reveal.js", () => ({ showReveal: vi.fn(async () => ({ landed: Promise.resolve() })), heldState: () => null, onRelease: () => () => {} }));
vi.mock("../module/scripts/sound.js", () => ({ playTick: vi.fn(), playSlow: vi.fn(), playReveal: vi.fn(), playPlop: vi.fn(), playPlink: vi.fn(), playCoinBack: vi.fn() }));

const { WELL, WELL_DEFAULTS, WELL_TIMING, wellOdds, throwsToday, capOf, stillLine, noClockNote, collapseMisses, throwsText, mountWell, wellRulesText, stakeCoins, stakeGp, draftWell, wellPreview, wellPreviewHTML, wellSummary, wellOddsHTML } = await import("../module/scripts/well.js");
const { dayKeyOf } = await import("../module/scripts/clock.js");
const { getKind } = await import("../module/scripts/kinds.js");
const { performPull, PullError } = await import("../module/scripts/pull.js");
const { registerSocket } = await import("../module/scripts/socket.js");
const { registerSettings, appendLog, getLog, getActorState, todayKey } = await import("../module/scripts/store.js");
const { refundPull, describeRefund } = await import("../module/scripts/refund.js");
const { postPullCard, postRefundCard } = await import("../module/scripts/chat.js");
const { showReveal } = await import("../module/scripts/reveal.js");
const sound = await import("../module/scripts/sound.js");
const { toCopper, isWholeCoins } = await import("../module/scripts/currency.js");

const tick = () => new Promise(r => setTimeout(r, 0));

const POOLS = { p: { id: "p", name: "Shrine finds", pools: [], entries: [
  { uuid: "Item.a", name: "Lucky Coin", img: "a.webp", rarity: "uncommon", weight: 1 },
  { uuid: "Item.b", name: "Ring of Wishes", img: "b.webp", rarity: "legendary", weight: 1 },
] } };
// A silver a throw: nothing 90, coin 8, item 2; three throws a day; pity
// Legendary or better after 4 throws.
const GAME = { id: "well", kind: "well", name: "Wishing Well", price: 0.1, pools: [{ id: "p", share: 1 }], weights: { uncommon: 75, legendary: 25 }, odds: { nothing: 90, coin: 8, item: 2 }, rules: { cap: 3, pity: { after: 4, minRarity: "legendary" } } };
const actorOf = (currency = { pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 }) => {
  const actor = {
    id: "a1", name: "Brinn", items: new Map(), writes: [], system: { currency: { ...currency } },
    testUserPermission: () => true,
    async update(data) { await tick(); actor.writes.push(data["system.currency"]); if (data["system.currency"]) actor.system.currency = data["system.currency"]; },
    async createEmbeddedDocuments(_type, [data]) { await tick(); const item = { id: "item1", name: data.name, flags: data.flags, async delete() { await tick(); actor.items.delete("item1"); } }; actor.items.set("item1", item); return [item]; },
  };
  return actor;
};
const source = async uuid => ({ uuid, name: uuid.endsWith(".b") ? "Ring of Wishes" : "Lucky Coin", img: "x.webp", toObject: () => ({ name: uuid.endsWith(".b") ? "Ring of Wishes" : "Lucky Coin", type: "loot", flags: {}, system: { rarities: [] } }) });
// rng: the first call picks the outcome (nothing < .9, coin < .98, item after), the rest draw the item.
const rngOf = (...values) => { let i = 0; return () => values[Math.min(i++, values.length - 1)]; };
const row = (day, over = {}) => ({ id: `r${Math.random().toString(36).slice(2, 8)}`, kind: "well", outcome: "nothing", boxId: "well", actorId: "a1", day, ...over });

beforeEach(() => { globalThis.fromUuid = source; });
afterEach(() => { delete globalThis.fromUuid; delete globalThis.game; delete globalThis.foundry; delete globalThis.ChatMessage; delete globalThis.ui; showReveal.mockClear(); for (const fn of Object.values(sound)) fn.mockClear?.(); });

describe("the in-game day", () => {
  it("is the calendar's year and day, the seconds' day without a calendar, and nothing without a clock", () => {
    expect(dayKeyOf({ components: { year: 1492, day: 207, hour: 23 }, worldTime: 1 })).toBe("y1492d207");
    expect(dayKeyOf({ worldTime: 86400 * 3 + 5 })).toBe("t3");
    expect(dayKeyOf({ worldTime: 86399 })).toBe("t0");
    expect(dayKeyOf(null)).toBeNull();
    expect(dayKeyOf({})).toBeNull();
    expect(todayKey()).toBeNull();
    globalThis.game = { time: { components: { year: 0, day: 1 } } };
    expect(todayKey()).toBe("y0d1");
  });
});

describe("the odds", () => {
  it("names the three outcomes as whole percents that sum to 100, dropping an outcome that weighs 0", () => {
    const odds = wellOdds(GAME, POOLS);
    expect(odds.rows.map(r => `${r.name} ${r.label}`)).toEqual(["Nothing 90%", "Coin back 8%", "Item 2%"]);
    expect(odds.dry).toBe(false);
    expect(wellOdds({ ...GAME, odds: { nothing: 1, coin: 0, item: 0 } }, POOLS).rows.map(r => r.key)).toEqual(["nothing"]);
    expect(wellOdds({ ...GAME, odds: { nothing: 0, coin: 0, item: 0 } }, POOLS)).toMatchObject({ dry: true, rows: [] });
  });

  it("gives the item no chance when the pools can give this buyer nothing, and only the item once pity is due", () => {
    expect(wellOdds({ ...GAME, pools: [] }, POOLS).rows.map(r => r.key)).toEqual(["nothing", "coin"]);
    const due = wellOdds(GAME, POOLS, { sinceRare: 4 });
    expect(due).toMatchObject({ due: true });
    expect(due.rows).toEqual([{ key: "item", name: "Item", chance: 1, label: "100%" }]);
    expect(due.item.rows.map(r => r.rarity)).toEqual(["legendary"]);
    // Pity due but the pools hold nothing for this buyer (owns it all, no duplicates).
    const owned = wellOdds({ ...GAME, rules: { ...GAME.rules, noDuplicates: true } }, POOLS, { sinceRare: 4, owned: POOLS.p.entries.map(e => e.uuid) });
    expect(owned.rows.map(r => r.key)).toEqual(["nothing", "coin"]);
  });
});

describe("the roll, through performPull", () => {
  it("a miss charges the stake, grants nothing, posts no result and counts a throw toward pity", async () => {
    const actor = actorOf();
    const out = await performPull({ box: GAME, pools: POOLS, actor, state: { sinceRare: 1, pulls: 1 }, rng: rngOf(0.5), today: "y1d3", log: [] });
    expect(out).toMatchObject({ kind: "well", result: null, itemId: null, payoutCp: 0, outcome: "nothing", day: "y1d3", thrown: 1, cap: 3, state: { sinceRare: 2, owned: [], pulls: 2 } });
    expect(out).not.toHaveProperty("grant");
    expect(actor.writes).toHaveLength(1);
    expect(actor.system.currency).toEqual({ pp: 0, gp: 0, ep: 0, sp: 9, cp: 0 });
    expect(isWholeCoins(actor.system.currency)).toBe(true);
    expect(getKind("well").chat.card({ ...out, box: GAME, actorName: "Brinn" }, { esc: String, itemLink: String })).toBeNull();
  });

  it("the coin back is the stake as the payout: the purse keeps its copper in one write, and it still counts a throw", async () => {
    const actor = actorOf({ pp: 0, gp: 0, ep: 0, sp: 0, cp: 10 });
    const out = await performPull({ box: GAME, pools: POOLS, actor, state: {}, rng: rngOf(0.95) });
    expect(out).toMatchObject({ outcome: "coin", payoutCp: 10, itemId: null, result: { name: "Coin back", outcome: "coin" }, state: { sinceRare: 1, pulls: 1 } });
    expect(actor.writes).toHaveLength(1);
    expect(toCopper(actor.system.currency)).toBe(10);
    expect(isWholeCoins(actor.system.currency)).toBe(true);
    expect(getKind("well").chat.card({ ...out, box: GAME, actorName: "Brinn" }, { esc: String, itemLink: String })).toBeNull();
  });

  it("a find draws from the pools at the rarity odds, grants the item and resets pity at the guaranteed rarity", async () => {
    const actor = actorOf();
    // 0.99 picks the item; 0.9 lands on the legendary rarity; 0 picks the pool and entry.
    const out = await performPull({ box: GAME, pools: POOLS, actor, state: { sinceRare: 2, pulls: 2 }, rng: rngOf(0.99, 0.9, 0, 0), today: "y1d3" });
    expect(out).toMatchObject({ outcome: "item", itemId: "item1", payoutCp: 0, result: { name: "Ring of Wishes", rarity: "legendary", uuid: "Item.b" }, state: { sinceRare: 0, owned: ["Item.b"], pulls: 3 } });
    expect(actor.items.get("item1").flags["loot-crates"]).toMatchObject({ boxId: "well", sourceUuid: "Item.b" });
    expect(toCopper(actor.system.currency)).toBe(90);
    const card = getKind("well").chat.card({ ...out, box: GAME, actorName: "Brinn", itemUuid: "Actor.a1.Item.item1" }, { esc: String, itemLink: (u, n) => `<a href="${u}">${n}</a>` });
    expect(card).toContain("Brinn threw a coin into <strong>Wishing Well</strong>");
    expect(card).toContain(`<a href="Actor.a1.Item.item1">Ring of Wishes</a>`);
    expect(card).toContain("Legendary");
    // An uncommon find counts toward a legendary pity rather than resetting it.
    const low = await performPull({ box: GAME, pools: POOLS, actor: actorOf(), state: { sinceRare: 2 }, rng: rngOf(0.99, 0.1, 0, 0) });
    expect(low).toMatchObject({ outcome: "item", result: { rarity: "uncommon" }, state: { sinceRare: 3 } });
  });

  it("once pity is due the throw is a find at the guaranteed rarity, whatever the first number says", async () => {
    const out = await performPull({ box: GAME, pools: POOLS, actor: actorOf(), state: { sinceRare: 4 }, rng: rngOf(0.01, 0.01, 0, 0) });
    expect(out).toMatchObject({ outcome: "item", result: { rarity: "legendary", pity: true }, state: { sinceRare: 0 } });
  });

  it("a well whose pools can give nothing never rolls an item, and one with no odds at all is dry, not broken", async () => {
    const out = await performPull({ box: { ...GAME, pools: [] }, pools: POOLS, actor: actorOf(), state: {}, rng: rngOf(0.99) });
    expect(out).toMatchObject({ outcome: "coin", itemId: null });
    expect(await performPull({ box: { ...GAME, pools: [] }, pools: POOLS, actor: actorOf(), state: {}, rng: rngOf(0.5) })).toMatchObject({ outcome: "nothing", result: null, itemId: null });
    await expect(performPull({ box: { ...GAME, odds: { nothing: 0, coin: 0, item: 0 } }, pools: POOLS, actor: actorOf(), state: {} })).rejects.toThrow("Wishing Well is dry");
  });

  it("keeps the core's guards: a stale price and an empty purse cost nothing", async () => {
    const actor = actorOf({ cp: 9 });
    await expect(performPull({ box: GAME, pools: POOLS, actor })).rejects.toThrow("Brinn can't afford Wishing Well.");
    await expect(performPull({ box: GAME, pools: POOLS, actor: actorOf(), expectedPrice: 0.05 })).rejects.toThrow("Nothing was charged.");
    expect(actor.writes).toHaveLength(0);
  });
});

describe("the cap per in-game day", () => {
  const today = "y1d7";
  const log = [row(today), row(today), row(today, { refunded: 1 }), row("y1d6"), row(today, { actorId: "a2" }), row(today, { boxId: "other" })];

  it("counts this character's unrefunded throws at this well with today's key, and nothing without a clock", () => {
    expect(throwsToday(log, { boxId: "well", actorId: "a1", day: today })).toBe(2);
    expect(throwsToday(log, { boxId: "well", actorId: "a1", day: "y1d6" })).toBe(1);
    expect(throwsToday(log, { boxId: "well", actorId: "a1", day: null })).toBe(0);
    expect(capOf(GAME)).toBe(3);
    expect(capOf({ rules: {} })).toBe(0);
    expect(capOf({ rules: { cap: "2.7" } })).toBe(2);
  });

  it("blocks the throw past the cap on the same day before anything is charged, and allows it on another day, after a refund, or with no cap", async () => {
    const actor = actorOf();
    const three = [row(today), row(today), row(today)];
    const blocked = performPull({ box: GAME, pools: POOLS, actor, state: {}, rng: rngOf(0.5), today, log: three });
    await expect(blocked).rejects.toBeInstanceOf(PullError);
    await expect(blocked).rejects.toThrow("The well is still until tomorrow (3 of 3 today).");
    expect(actor.writes).toHaveLength(0);
    expect(stillLine(3, 3)).toBe("The well is still until tomorrow (3 of 3 today)");
    await expect(performPull({ box: GAME, pools: POOLS, actor, state: {}, rng: rngOf(0.5), today: "y1d8", log: three })).resolves.toMatchObject({ thrown: 1 });
    await expect(performPull({ box: GAME, pools: POOLS, actor, state: {}, rng: rngOf(0.5), today, log: [...three.slice(0, 2), { ...three[2], refunded: 5 }] })).resolves.toMatchObject({ thrown: 3 });
    await expect(performPull({ box: { ...GAME, rules: {} }, pools: POOLS, actor, state: {}, rng: rngOf(0.5), today, log: three })).resolves.toMatchObject({ cap: 0 });
    // No clock: nothing is counted, so nothing is capped.
    await expect(performPull({ box: GAME, pools: POOLS, actor, state: {}, rng: rngOf(0.5), today: null, log: three })).resolves.toMatchObject({ day: null, thrown: 1 });
  });
});

/* A fake world for the socket path and the refund. */
const GM = { id: "gm", name: "Gamemaster" };
const PLAYER = { id: "p1", name: "Player" };
function makeWorld({ actor = actorOf(), time = { components: { year: 1, day: 7 } } } = {}) {
  const settings = new Map();
  const handlers = [];
  const emitted = [];
  const game = {
    user: GM, time,
    users: { activeGM: GM, get: id => [GM, PLAYER].find(u => u.id === id) ?? null },
    actors: { get: id => (id === actor.id ? actor : null) },
    // World items, so the GM's pre-roll sweep finds the pool's sources.
    items: { get: id => ({ name: id, img: "", system: {} }) },
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
const throwOnce = async (world, rng, requestId = "t1") => {
  globalThis.CONFIG = { Dice: { randomUniform: rng } };
  try { await world.deliver({ type: "pull", requestId, boxId: "well", actorId: "a1", userId: "p1", price: 0.1 }); } finally { delete globalThis.CONFIG; }
};

describe("the GM's socket path", () => {
  it("writes a row for a miss with the day and no chat card, and the cap reads those rows", async () => {
    const world = makeWorld();
    await world.game.settings.set("loot-crates", "boxes", { well: GAME });
    await world.game.settings.set("loot-crates", "pools", POOLS);
    for (let n = 1; n <= 3; n++) await throwOnce(world, rngOf(0.5), `t${n}`);
    const log = world.game.settings.get("loot-crates", "pullLog");
    expect(log).toHaveLength(3);
    expect(log[0]).toMatchObject({ kind: "well", outcome: "nothing", day: "y1d7", name: "Nothing", price: 0.1, payoutCp: 0, itemId: null, before: { sinceRare: 2, hadItem: false }, resetPity: false });
    expect(log[0]).not.toHaveProperty("uuid");
    expect(globalThis.ChatMessage.create).not.toHaveBeenCalled();
    expect(toCopper(world.actor.system.currency)).toBe(70);
    expect(getActorState("a1", "well")).toEqual({ sinceRare: 3, owned: [], pulls: 3 });
    const reveals = world.emitted.filter(m => m.type === "reveal");
    expect(reveals).toHaveLength(3);
    expect(reveals[2]).toMatchObject({ kind: "well", outcome: "nothing", result: null, thrown: 3, cap: 3, day: "y1d7" });
    expect(showReveal).toHaveBeenCalledTimes(3);
    // The fourth is refused by the well itself, before the charge.
    await throwOnce(world, rngOf(0.5), "t4");
    expect(world.emitted.find(m => m.type === "error")).toMatchObject({ requestId: "t4", message: "The well is still until tomorrow (3 of 3 today)." });
    expect(toCopper(world.actor.system.currency)).toBe(70);
    expect(world.game.settings.get("loot-crates", "pullLog")).toHaveLength(3);
    // The next day the well takes a coin again.
    world.game.time = { components: { year: 1, day: 8 } };
    await throwOnce(world, rngOf(0.5), "t5");
    expect(world.game.settings.get("loot-crates", "pullLog")[0]).toMatchObject({ day: "y1d8" });
    expect(toCopper(world.actor.system.currency)).toBe(60);
  });

  it("posts the card for a find only", async () => {
    const world = makeWorld();
    await world.game.settings.set("loot-crates", "boxes", { well: GAME });
    await world.game.settings.set("loot-crates", "pools", POOLS);
    await throwOnce(world, rngOf(0.99, 0.9, 0, 0));
    const reveal = world.emitted.find(m => m.type === "reveal");
    expect(reveal).toMatchObject({ outcome: "item", itemId: "item1", itemUuid: "Actor.a1.Item.item1", result: { name: "Ring of Wishes", rarity: "legendary" } });
    const msg = await postPullCard(reveal);
    expect(msg.content).toContain("Brinn threw a coin into <strong>Wishing Well</strong>");
    expect(msg.flags["loot-crates"]).toEqual({ boxId: "well", uuid: "Item.b", logId: reveal.logId });
    const [row] = world.game.settings.get("loot-crates", "pullLog");
    expect(row).toMatchObject({ outcome: "item", day: "y1d7", name: "Ring of Wishes", uuid: "Item.b", rarity: "legendary", resetPity: true, before: { sinceRare: 0, hadItem: false } });
  });
});

describe("the one refund, for a throw", () => {
  async function seed(actor, rows, state = { sinceRare: 3, owned: [], pulls: 3 }) {
    const world = makeWorld({ actor });
    await world.game.settings.set("loot-crates", "boxes", { well: GAME });
    await world.game.settings.set("loot-crates", "actorState", { "actor1.well": {}, "a1.well": state });
    for (const r of rows) await appendLog(r);
    return world;
  }
  const MISS = { kind: "well", outcome: "nothing", day: "y1d7", boxId: "well", boxName: "Wishing Well", actorId: "a1", actorName: "Brinn", userId: "p1", itemId: null, name: "Nothing", price: 0.1, payoutCp: 0, before: { sinceRare: 2, hadItem: false }, resetPity: false };

  it("a miss: the stake comes back, the pity count steps back, no item is touched, and the day's count has a throw again", async () => {
    const actor = actorOf({ gp: 0, sp: 9, cp: 0 });
    await seed(actor, [MISS]);
    const rowId = getLog()[0].id;
    const plan = describeRefund(rowId);
    expect(plan).toMatchObject({ status: "ready", coins: 10, item: null, state: { before: { sinceRare: 3 }, after: { sinceRare: 2, pulls: 2, owned: [] } } });
    const out = await refundPull(rowId);
    expect(out).toMatchObject({ status: "refunded", removedItem: null });
    expect(actor.system.currency).toEqual({ pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 });
    expect(getActorState("a1", "well")).toEqual({ sinceRare: 2, owned: [], pulls: 2 });
    expect(throwsToday(getLog(), { boxId: "well", actorId: "a1", day: "y1d7" })).toBe(0);
    const card = await postRefundCard({ row: getLog()[0], actor, removedItem: null });
    expect(card.content).toContain("1 sp went back into their purse.");
    expect(card.content).toContain("lc-rarity-none");
    // A row that paid nothing out keeps the stake in the head.
    expect(card.content).toContain('was refunded <span class="lc-chat__price">1 sp</span>');
  });

  it("a coin back: nothing moves, the pity count steps back", async () => {
    const actor = actorOf({ gp: 1 });
    await seed(actor, [{ ...MISS, outcome: "coin", name: "Coin back", payoutCp: 10 }]);
    const rowId = getLog()[0].id;
    expect(describeRefund(rowId)).toMatchObject({ status: "ready", coins: 0 });
    await refundPull(rowId);
    expect(toCopper(actor.system.currency)).toBe(100);
    expect(getActorState("a1", "well")).toMatchObject({ sinceRare: 2, pulls: 2 });
    const card = await postRefundCard({ row: getLog()[0], actor, removedItem: null });
    expect(card.content).toContain("The coin had already come back, so nothing moved.");
    // The coin came back, so the head doesn't show the stake as if it moved.
    expect(card.content).toContain("<strong>Wishing Well</strong> was refunded</div>");
    expect(card.content).not.toContain("lc-chat__price");
  });
});

describe("the Pull log's folded misses", () => {
  it("folds a character's misses at a well per day, refunded ones apart, each group where its newest row stood", () => {
    const log = [
      row("y1d8", { id: "n1", at: 8, actorName: "Brinn", boxName: "Wishing Well", price: 0.1 }),
      { id: "w1", kind: "well", outcome: "coin", actorId: "a1", boxId: "well", day: "y1d7", at: 7 },
      row("y1d7", { id: "n2", at: 6 }),
      row("y1d7", { id: "n3", at: 5, refunded: 9 }),
      { id: "c1", boxId: "crate", actorId: "a1", name: "Wand", at: 4 },
      row("y1d7", { id: "n4", at: 3 }),
      row("y1d7", { id: "n5", at: 2, actorId: "a2" }),
    ];
    const items = collapseMisses(log);
    expect(items.map(x => (x.group ? `${x.actorId}:${x.day}:${x.refunded ? "refunded" : "live"}:${x.rows.map(r => r.id)}` : x.row.id)))
      .toEqual(["a1:y1d8:live:n1", "w1", "a1:y1d7:live:n2,n4", "a1:y1d7:refunded:n3", "c1", "a2:y1d7:live:n5"]);
    expect(items[0]).toMatchObject({ actorName: "Brinn", boxName: "Wishing Well", price: 0.1, boxId: "well" });
    expect(throwsText(1)).toBe("1 throw, nothing");
    expect(throwsText(7)).toBe("7 throws, nothing");
    expect(collapseMisses([])).toEqual([]);
  });
});

describe("the shop card", () => {
  const esc = s => String(s ?? "");
  const ctx = (over = {}) => ({ purse: { gp: 1 }, hasActor: true, actorId: "a1", actorName: "Brinn", open: true, gmOnline: true, esc, stateOf: () => ({}), today: "y1d7", log: [], held: () => false, ...over });
  const card = (over, game = GAME) => getKind("well").shop.card(game, POOLS, ctx(over));
  const why = html => html.match(/<div class="lc-box__why"[^>]*>([^<]*)<\/div>/)?.[1] ?? "";

  it("names the odds, counts today's throws, and says Throw with the stake", () => {
    const html = card({ log: [row("y1d7")] });
    expect(html).toContain(`<span class="lc-odd lc-rarity-none">Nothing 90%</span>`);
    expect(html).toContain(`<span class="lc-odd lc-rarity-coin">Coin back 8%</span>`);
    expect(html).toContain(`<span class="lc-odd lc-rarity-legendary">Item 2%</span>`);
    expect(html).toContain(`title="Nothing 90%"`);
    expect(html).toContain(`<div class="lc-box__stock">1 of 3 throws today</div>`);
    expect(html).toContain(`Throw 1 sp`);
    expect(html).toContain(`data-box="well"`);
    expect(html).toContain(`data-price="0.1"`);
    expect(html).not.toContain("aria-disabled");
    expect(html).toContain("Legendary or better within 5 throws");
  });

  it("at the cap the Buy is off with the still line as its visible reason, and the next day it is on again", () => {
    const three = [row("y1d7"), row("y1d7"), row("y1d7")];
    const html = card({ log: three });
    expect(html).toContain(`aria-disabled="true"`);
    expect(html).toContain(`aria-describedby="lc-why-well"`);
    expect(why(html)).toBe("The well is still until tomorrow (3 of 3 today)");
    expect(html).not.toContain("throws today</div>");
    expect(card({ log: three, today: "y1d8" })).toContain("0 of 3 throws today");
    expect(why(card({ log: three, today: "y1d8" }))).toBe("");
    // A refunded throw gives one back.
    expect(why(card({ log: [...three.slice(0, 2), { ...three[2], refunded: 1 }] }))).toBe("");
    // No clock: no cap, no count.
    expect(card({ log: three, today: null })).not.toContain("throws today");
    expect(why(card({ log: three, today: null }))).toBe("");
  });

  it("says Still rippling while a throw is in the water here, dry with no odds, and the shortfall last", () => {
    expect(why(card({ held: id => id === "well" }))).toBe("Still rippling");
    expect(why(card({}, { ...GAME, odds: { nothing: 0, coin: 0, item: 0 } }))).toBe("The well is dry");
    expect(why(card({ purse: { cp: 3 } }))).toBe("Needs 7 cp more");
    const reason = getKind("well").shop.reason;
    expect(reason(GAME, POOLS, ctx({ open: false }))).toBe("The GM has closed the shop.");
    expect(reason(GAME, POOLS, ctx({ log: [row("y1d7"), row("y1d7"), row("y1d7")] }))).toBe("The well is still until tomorrow (3 of 3 today)");
    expect(reason(GAME, POOLS, ctx())).toBe("");
  });
});

describe("the reveal", () => {
  const esc = s => String(s ?? "");
  const kind = getKind("well").reveal;
  const reveal = over => ({ kind: "well", userId: "p1", actorName: "Brinn", box: { id: "well", name: "Wishing Well", price: 0.1 }, result: null, outcome: "nothing", purse: { gp: 0, sp: 9 }, thrown: 2, cap: 3, ...over });

  it("heads the window with the throw, and reads the result quietly for nothing and the coin back, the crate's way for a find", () => {
    expect(kind.title).toBe("A coin in the well");
    expect(kind.replayable).toBe(false);
    expect(kind.head(reveal(), { esc }).replace(/\s+/g, " ")).toBe(`<span class="lc-reveal__who">Brinn</span> throws a coin into <strong class="lc-reveal__crate">Wishing Well</strong> <span class="lc-reveal__price">1 sp</span>`);
    const miss = kind.result(reveal(), { esc, canSee: true });
    expect(miss).toContain(`<div class="lc-reveal__quiet">The coin sinks. Nothing.</div>`);
    expect(miss).toContain("9 sp left");
    expect(miss).toContain("2 of 3 throws today");
    expect(kind.result(reveal(), { esc, canSee: false })).toBe(`<div class="lc-reveal__quiet">The coin sinks. Nothing.</div>`);
    const coin = kind.result(reveal({ outcome: "coin", result: { name: "Coin back", outcome: "coin" } }), { esc, canSee: false });
    expect(coin).toContain("The coin comes back.");
    expect(coin).toContain("1 sp back in Brinn's purse");
    const find = kind.result(reveal({ outcome: "item", result: { name: "Ring of Wishes", rarity: "legendary" }, itemUuid: "Actor.a1.Item.i" }), { esc, canSee: true });
    expect(find).toContain(`<div class="lc-reveal__name">Ring of Wishes</div>`);
    expect(find).toContain("Added to Brinn's inventory");
    expect(find).toContain("9 sp left</span> · 2 of 3 throws today");
    expect(kind.notice(reveal())).toBe("Wishing Well: the coin sinks. Nothing.");
    expect(kind.notice(reveal({ outcome: "coin" }))).toBeNull();
  });

  it("stings for the outcome: a plink, the coin's notes, or the rarity", () => {
    kind.sting(reveal());
    expect(sound.playPlink).toHaveBeenCalledOnce();
    kind.sting(reveal({ outcome: "coin" }));
    expect(sound.playCoinBack).toHaveBeenCalledOnce();
    kind.sting(reveal({ outcome: "item", result: { rarity: "rare" } }));
    expect(sound.playReveal).toHaveBeenCalledWith("rare");
  });

  it("plays the coin into the water in one frame loop, transforms only, with the plop at the splash, and lands on time", async () => {
    const doc = createDocument();
    const host = doc.createElement("div");
    const frames = [];
    vi.stubGlobal("requestAnimationFrame", cb => { frames.push(cb); return frames.length; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    try {
      let landed = 0;
      const spin = kind.play(host, reveal({ outcome: "coin", result: { name: "Coin back" } }), { sound: true, pageHidden: () => false, onLand: () => landed++ });
      expect(spin.reducedMotion).toBe(false);
      expect(host.classList.contains("lc-well")).toBe(true);
      expect(host.dataset.outcome).toBe("coin");
      const stage = host.querySelector(".lc-well__stage");
      expect(stage.getAttribute("aria-hidden")).toBe("true");
      const coin = host.querySelector(".lc-well__coin");
      const playing = spin.play();
      // Frames at 0, mid-flight, past the splash, and past the landing.
      frames.shift()(1000);
      expect(coin.style.transform).toContain("translate(-120px, -110px)");
      frames.shift()(1000 + WELL_TIMING.splash / 2);
      expect(coin.style.transform).toMatch(/translate\(-60px, -[\d.]+px\)/);
      expect(sound.playPlop).not.toHaveBeenCalled();
      frames.shift()(1000 + WELL_TIMING.splash + 1);
      expect(sound.playPlop).toHaveBeenCalledOnce();
      expect(landed).toBe(0);
      frames.shift()(1000 + WELL_TIMING.land.coin + 1);
      await playing;
      expect(landed).toBe(1);
      expect(host.classList.contains("lc-well--landed")).toBe(true);
      // The coin came back: over the water, opaque; the last ring stays faint.
      expect(coin.style.opacity).toBe("1");
      expect(coin.style.transform).toContain("translate(0, -46px)");
      expect(host.querySelectorAll(".lc-well__ring")[2].style.opacity).toBe("0.25");
      // One loop: no frame was asked for after the landing.
      expect(frames).toHaveLength(0);
      // Nothing but transform and opacity was written.
      for (const el of host.querySelectorAll(".lc-well__stage > *")) expect(Object.keys(el.style).filter(k => el.style[k] !== undefined).every(k => ["transform", "opacity"].includes(k))).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });

  it("lands at once under reduced motion or a skip, in the final pose, with the find surfaced", () => {
    const doc = createDocument();
    const host = doc.createElement("div");
    vi.stubGlobal("requestAnimationFrame", () => { throw new Error("no frames under reduced motion"); });
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    try {
      let landed = 0;
      const spin = mountWell(host, { outcome: "item", img: "ring.webp", rarity: "legendary", onLand: () => landed++ });
      expect(spin.reducedMotion).toBe(true);
      spin.play();
      expect(landed).toBe(1);
      expect(host.classList.contains("lc-rarity-legendary")).toBe(true);
      expect(host.querySelector(".lc-well__prize img").getAttribute("src")).toBe("ring.webp");
      expect(host.querySelector(".lc-well__prize").style.opacity).toBe("1");
      expect(host.querySelector(".lc-well__glow").style.opacity).toBe("0.85");
      expect(host.querySelector(".lc-well__coin").style.opacity).toBe("0");
      spin.play();
      expect(landed).toBe(1);
      // A skip mid-flight lands the same way, once.
      vi.stubGlobal("matchMedia", () => ({ matches: false }));
      vi.stubGlobal("requestAnimationFrame", () => 1);
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      const other = doc.createElement("div");
      let n = 0;
      const s2 = mountWell(other, { outcome: "nothing", onLand: () => n++ });
      s2.play();
      expect(n).toBe(0);
      s2.skip();
      s2.skip();
      expect(n).toBe(1);
      expect(s2.skipped).toBe(true);
      expect(globalThis.cancelAnimationFrame).toHaveBeenCalled();
      expect(other.classList.contains("lc-well--landed")).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("the manager's words", () => {
  it("names the rules, the stake in its coin, and previews the odds for the editor", () => {
    expect(wellRulesText(GAME)).toBe("3 a day, Legendary or better after 4 throws");
    expect(wellRulesText({ ...GAME, rules: { noDuplicates: true } })).toBe("no dupes");
    expect(stakeCoins(0.1)).toEqual({ amount: 1, coin: "sp" });
    expect(stakeCoins(0.05)).toEqual({ amount: 5, coin: "cp" });
    expect(stakeCoins(2)).toEqual({ amount: 2, coin: "gp" });
    expect(stakeGp(5, "cp")).toBe(0.05);
    expect(stakeGp("3", "sp")).toBe(0.3);
    expect(stakeGp(-1, "gp")).toBe(0);
    const draft = draftWell(GAME, { "pool.p": true, "share.p": "2", "w.uncommon": "1", "w.legendary": "1", "o.nothing": "50", "o.coin": "", "o.item": "50" }, ["p"]);
    expect(draft).toMatchObject({ pools: [{ id: "p", share: 2 }], odds: { nothing: 50, coin: 0, item: 50 } });
    const preview = wellPreview(draft, POOLS);
    expect(wellSummary(preview)).toBe("Nothing 50%, Item 50%. If an item: Uncommon 50%, Legendary 50%");
    expect(wellPreviewHTML(preview)).toContain("Nothing 50%");
    expect(wellPreviewHTML(preview)).toContain("If an item:");
    const dry = wellPreview({ ...draft, odds: { nothing: 0, coin: 0, item: 0 } }, POOLS);
    expect(dry.note).toBe("This well is dry: every outcome weighs 0.");
    expect(wellPreviewHTML(dry)).toContain("lc-form__hint--warn");
    expect(wellPreview({ ...draft, pools: [] }, POOLS).note).toBe("No pool is ticked, so a throw can never find an item.");
    expect(wellOddsHTML(wellOdds({ ...GAME, odds: { nothing: 0, coin: 0, item: 0 } }, POOLS))).toBe("");
    expect(WELL_DEFAULTS).toEqual({ price: 0.1, odds: { nothing: 90, coin: 8, item: 2 }, cap: 3 });
  });

  it("tells the editor when the world has no clock, since the cap is keyed on the in-game day", () => {
    expect(noClockNote({ hasClock: true, cap: 3 })).toBe("");
    expect(noClockNote({ hasClock: false, cap: null })).toBe('<p class="lc-form__hint">No calendar: the daily cap will not apply.</p>');
    // A cap that is set and silently off is a warning, not a hint.
    expect(noClockNote({ hasClock: false, cap: 3 })).toBe('<p class="lc-form__hint lc-form__hint--warn">No calendar: the daily cap will not apply.</p>');
    expect(noClockNote({ hasClock: false, cap: 0 })).not.toContain("--warn");
    // What the throw came to, for the late-cancel line.
    expect(WELL.gotText({ outcome: "nothing", result: null })).toBe("got nothing");
    expect(WELL.gotText({ outcome: "coin", result: { name: "Coin back" } })).toBe("got the coin back");
    expect(WELL.gotText({ outcome: "item", result: { name: "Sling +2" } })).toBe("got Sling +2");
    expect(WELL.id).toBe("well");
  });
});
