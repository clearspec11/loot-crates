/*
  The Deck of Many Things (deck.js) on the core: the deck as written (a
  missing weight is 1, weight 0 never draws), the plan that leaves drawn
  once cards out until a reshuffle, the odds as whole percents with no 0%,
  the price that rises per draw in a row from the log and comes back down,
  the roll for every kind of card through performPull (an item granted, coins
  paid, a loss taken in the one settle, an effect's text, a blank), the
  socket path charging the risen price and posting a sealed card for every
  draw, the one refund putting the card and the price step back
  (idempotent), the stage's lift, hold, beats and one turn, and the words:
  head, result, notice, sting, Draw again, the shop card and the editor.
  Real pull.js, socket.js, refund.js, chat.js and store.js on a fake world;
  reveal.js is mocked where the socket path needs it.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDocument } from "./minidom.js";

vi.mock("../module/scripts/reveal.js", () => ({ showReveal: vi.fn(async () => ({ landed: Promise.resolve() })), heldState: () => null, onRelease: () => () => {} }));
vi.mock("../module/scripts/sound.js", () => ({ playTick: vi.fn(), playSlow: vi.fn(), playReveal: vi.fn(), playPlop: vi.fn(), playPlink: vi.fn(), playCoinBack: vi.fn(), playBane: vi.fn() }));

const { DECK, DECK_DEFAULTS, DECK_TIMING, STREAK_MS, cardsOf, drawnIds, deckPlan, deckOdds, streakOf, priceAt, nextPrice, ordinal, mountDeck, deckLandTime, cardsLeftText, streakLine, deckRulesText, draftDeck, deckPreview, deckPreviewHTML, deckSummary, deckOddsHTML } = await import("../module/scripts/deck.js");
const { getKind } = await import("../module/scripts/kinds.js");
const { performPull, PullError } = await import("../module/scripts/pull.js");
const { registerSocket } = await import("../module/scripts/socket.js");
const { registerSettings, appendLog, getLog } = await import("../module/scripts/store.js");
const { refundPull, describeRefund, refundCoins } = await import("../module/scripts/refund.js");
const { postPullCard, postRefundCard } = await import("../module/scripts/chat.js");
// manager.js reads foundry.applications.api when it is imported.
globalThis.foundry = { applications: { api: { ApplicationV2: class {}, DialogV2: class {} } }, utils: { escapeHTML: s => String(s) } };
const { logPayoutNote } = await import("../module/scripts/manager.js");
delete globalThis.foundry;
const { showReveal } = await import("../module/scripts/reveal.js");
const sound = await import("../module/scripts/sound.js");
const { toCopper, isWholeCoins } = await import("../module/scripts/currency.js");
const { seededRng } = await import("../module/scripts/odds.js");

const tick = () => new Promise(r => setTimeout(r, 0));

const POOLS = { p: { id: "p", name: "The hoard", pools: [], entries: [
  { uuid: "Item.a", name: "Lucky Coin", img: "a.webp", rarity: "uncommon", weight: 1 },
  { uuid: "Item.b", name: "Ring of Wishes", img: "b.webp", rarity: "legendary", weight: 1 },
] } };
const CARDS = [
  { id: "fortune", label: "Fortune", kind: "item", weight: 2 },
  { id: "windfall", label: "Windfall", kind: "coins", weight: 2, gp: 50 },
  { id: "ruin", label: "Ruin", kind: "loss", weight: 2, gp: 20 },
  { id: "omen", label: "Omen", kind: "effect", weight: 1, once: true, text: "The next long rest is interrupted." },
  { id: "blank", label: "A blank card", kind: "blank", weight: 3 },
];
// 10 gp a draw, half again for each draw in a row.
const GAME = { id: "deck", kind: "deck", name: "The Deck", price: 10, pools: [{ id: "p", share: 1 }], weights: { uncommon: 75, legendary: 25 }, deck: { step: 1.5, shuffledAt: 0, cards: CARDS }, rules: {} };
const NOW = 1_000_000_000;
const actorOf = (currency = { pp: 0, gp: 100, ep: 0, sp: 0, cp: 0 }) => {
  const actor = {
    id: "a1", name: "Brinn", items: new Map(), writes: [], system: { currency: { ...currency } },
    testUserPermission: () => true,
    async update(data) { await tick(); actor.writes.push(data["system.currency"]); if (data["system.currency"]) actor.system.currency = data["system.currency"]; },
    async createEmbeddedDocuments(_type, [data]) { await tick(); const item = { id: "item1", name: data.name, flags: data.flags, async delete() { await tick(); actor.items.delete("item1"); } }; actor.items.set("item1", item); return [item]; },
  };
  return actor;
};
const source = async uuid => ({ uuid, name: uuid.endsWith(".b") ? "Ring of Wishes" : "Lucky Coin", img: "x.webp", toObject: () => ({ name: uuid.endsWith(".b") ? "Ring of Wishes" : "Lucky Coin", type: "loot", flags: {}, system: { rarities: [] } }) });
// rng: the first call picks the card by weight (fortune < .2, windfall < .4, ruin < .6, omen < .7, blank after), the rest draw the item.
const rngOf = (...values) => { let i = 0; return () => values[Math.min(i++, values.length - 1)]; };
const row = (over = {}) => ({ id: `r${Math.random().toString(36).slice(2, 8)}`, kind: "deck", boxId: "deck", actorId: "a1", cardId: "blank", at: NOW - 1000, ...over });

beforeEach(() => { globalThis.fromUuid = source; });
afterEach(() => { delete globalThis.fromUuid; delete globalThis.game; delete globalThis.foundry; delete globalThis.ChatMessage; delete globalThis.ui; showReveal.mockClear(); for (const fn of Object.values(sound)) fn.mockClear?.(); });

describe("the deck as written", () => {
  it("reads every card in one shape: a missing weight is 1, an unknown kind is a blank, an empty label is the kind's", () => {
    const cards = cardsOf({ deck: { cards: [{ label: "Boon", kind: "coins", gp: "5" }, { id: "x", kind: "slots", weight: "2.9" }, { label: " ", kind: "item", weight: 0, once: 1 }] } });
    expect(cards).toEqual([
      { id: "card0", label: "Boon", kind: "coins", weight: 1, once: false, gp: 5, text: "" },
      { id: "x", label: "Blank", kind: "blank", weight: 2, once: false, gp: 0, text: "" },
      { id: "card2", label: "Item", kind: "item", weight: 0, once: true, gp: 0, text: "" },
    ]);
    expect(cardsOf({})).toEqual([]);
    expect(DECK_DEFAULTS.cards.map(c => c.kind)).toEqual(["item", "coins", "loss", "effect", "blank"]);
  });

  it("plans a draw from the cards that weigh more than 0, leaving out drawn once cards and item cards with nothing to give", () => {
    const plan = deckPlan(GAME, POOLS, []);
    expect(plan).toMatchObject({ size: 5, left: 5, drawn: 0, empty: false, reason: "", canItem: true });
    expect(plan.live.map(c => c.id)).toEqual(["fortune", "windfall", "ruin", "omen", "blank"]);
    // The omen was drawn: out until a reshuffle; a refunded draw doesn't count, nor a draw before the last reshuffle.
    const drawn = deckPlan(GAME, POOLS, [row({ cardId: "omen" }), row({ cardId: "omen", refunded: 1, at: NOW })]);
    expect(drawn).toMatchObject({ left: 4, drawn: 1 });
    expect(drawn.live.map(c => c.id)).toEqual(["fortune", "windfall", "ruin", "blank"]);
    expect(drawnIds(GAME, [row({ cardId: "omen" }), row({ cardId: "windfall" })])).toEqual(new Set(["omen"]));
    expect(deckPlan({ ...GAME, deck: { ...GAME.deck, shuffledAt: NOW } }, POOLS, [row({ cardId: "omen" })])).toMatchObject({ left: 5, drawn: 0 });
    // Weight 0 is not in the deck; no pools: the item card can't be drawn but still counts as left.
    expect(deckPlan({ ...GAME, deck: { ...GAME.deck, cards: CARDS.map(c => (c.id === "ruin" ? { ...c, weight: 0 } : c)) } }, POOLS, []).size).toBe(4);
    const noPools = deckPlan({ ...GAME, pools: [] }, POOLS, []);
    expect(noPools).toMatchObject({ size: 5, left: 5, canItem: false, empty: false });
    expect(noPools.live.map(c => c.id)).toEqual(["windfall", "ruin", "omen", "blank"]);
  });

  it("says why nothing can be drawn: no cards, every card drawn, or only item cards with nowhere to draw from", () => {
    expect(deckPlan({ ...GAME, deck: { cards: [] } }, POOLS, [])).toMatchObject({ empty: true, reason: "The deck has no cards" });
    expect(deckPlan({ ...GAME, deck: { cards: CARDS.map(c => ({ ...c, weight: 0 })) } }, POOLS, [])).toMatchObject({ empty: true, reason: "The deck has no cards" });
    const once = { ...GAME, deck: { ...GAME.deck, cards: CARDS.map(c => ({ ...c, once: true })) } };
    expect(deckPlan(once, POOLS, CARDS.map(c => row({ cardId: c.id })))).toMatchObject({ empty: true, left: 0, reason: "Every card is drawn" });
    expect(deckPlan({ ...GAME, pools: [], deck: { cards: [CARDS[0]] } }, POOLS, [])).toMatchObject({ empty: true, left: 1, reason: "Nothing in the deck can be drawn" });
  });

  it("names the odds by kind of card as whole percents summing to 100, never 0%, a drawn kind dropping out", () => {
    const odds = deckOdds(GAME, POOLS, []);
    expect(odds.rows.map(r => `${r.name} ${r.label}`)).toEqual(["Item 20%", "Coins 20%", "Loss 20%", "Effect 10%", "Blank 30%"]);
    expect(odds.rows.reduce((n, r) => n + Number(r.label.replace("%", "")), 0)).toBe(100);
    const after = deckOdds(GAME, POOLS, [row({ cardId: "omen" })]);
    expect(after.rows.map(r => r.name)).toEqual(["Item", "Coins", "Loss", "Blank"]);
    expect(after.rows.map(r => r.label)).toEqual(["22%", "22%", "22%", "34%"]);
    expect(deckOdds({ ...GAME, deck: { cards: [{ id: "a", kind: "blank", weight: 999 }, { id: "b", kind: "coins", weight: 1, gp: 1 }] } }, POOLS, []).rows.map(r => r.label)).toEqual(["<1%", ">99%"]);
    expect(deckOddsHTML(deckOdds({ ...GAME, deck: { cards: [] } }, POOLS, []))).toBe("");
    const html = deckOddsHTML(odds);
    expect(html).toContain(`<span class="lc-odd lc-rarity-legendary">Item 20%</span>`);
    expect(html).toContain(`<span class="lc-odd lc-rarity-coin">Coins 20%</span>`);
    expect(html).toContain(`<span class="lc-odd lc-rarity-bane">Loss 20%</span>`);
    expect(html).toContain(`<span class="lc-odd lc-rarity-none">Blank 30%</span>`);
  });

  it("never draws a card weighing 0, and draws the others in their weights", async () => {
    const game = { ...GAME, deck: { cards: [{ id: "never", kind: "blank", weight: 0 }, { id: "often", kind: "blank", weight: 3 }, { id: "rare", kind: "blank", weight: 1 }] } };
    const rng = seededRng(5);
    const counts = {};
    for (let i = 0; i < 400; i++) {
      const out = await performPull({ box: game, pools: POOLS, actor: actorOf(), rng, grant: false });
      counts[out.card.id] = (counts[out.card.id] ?? 0) + 1;
    }
    expect(counts.never).toBeUndefined();
    expect(counts.often).toBeGreaterThan(240);
    expect(counts.rare).toBeGreaterThan(60);
  });
});

describe("the rising price", () => {
  it("counts the draws in a row from the log, each within two minutes of the last, and prices the next at base x step^n to the copper", () => {
    const log = [row({ at: NOW - 10_000 }), row({ at: NOW - 100_000 }), row({ at: NOW - 100_000 - STREAK_MS - 1 }), row({ at: NOW - 20_000, actorId: "a2" }), row({ at: NOW - 15_000, boxId: "other" }), row({ at: NOW - 5_000, refunded: 1 })];
    expect(streakOf(log, { boxId: "deck", actorId: "a1", now: NOW })).toBe(2);
    expect(streakOf(log, { boxId: "deck", actorId: "a1", now: NOW + STREAK_MS + 1 })).toBe(0);
    expect(streakOf([], { boxId: "deck", actorId: "a1", now: NOW })).toBe(0);
    expect(priceAt(GAME, 0)).toBe(10);
    expect(priceAt(GAME, 1)).toBe(15);
    expect(priceAt(GAME, 2)).toBe(22.5);
    expect(priceAt(GAME, 3)).toBe(33.75);
    expect(priceAt({ ...GAME, deck: { step: 2 } }, 3)).toBe(80);
    expect(priceAt({ ...GAME, deck: {} }, 1)).toBe(15);
    expect(nextPrice(GAME, log, { actorId: "a1", now: NOW })).toBe(22.5);
    expect(nextPrice(GAME, log, { actorId: "a2", now: NOW })).toBe(15);
    expect(ordinal(1)).toBe("1st"); expect(ordinal(2)).toBe("2nd"); expect(ordinal(3)).toBe("3rd"); expect(ordinal(4)).toBe("4th"); expect(ordinal(11)).toBe("11th"); expect(ordinal(22)).toBe("22nd");
    expect(streakLine(GAME, 1)).toBe("2nd draw in a row: 15 gp (back to 10 gp after two minutes)");
    expect(streakLine(GAME, 0)).toBe("");
  });

  it("is what the core charges: the Buy must name it, and a refund of the last draw takes the step back", async () => {
    const actor = actorOf();
    const log = [row({ at: NOW - 10_000 })];
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    try {
      await expect(performPull({ box: GAME, pools: POOLS, actor, rng: rngOf(0.9), log, expectedPrice: 10 })).rejects.toThrow("The Deck now costs 15 gp (you pressed 10 gp). Nothing was charged.");
      expect(actor.writes).toHaveLength(0);
      const out = await performPull({ box: GAME, pools: POOLS, actor, rng: rngOf(0.9), log, expectedPrice: 15 });
      expect(out).toMatchObject({ price: 15, streak: 2, nextPrice: 22.5, card: { id: "blank" } });
      expect(toCopper(actor.system.currency)).toBe(8500);
      // The last draw refunded: the next is a second draw again, not a third.
      const refunded = [{ ...row({ at: NOW - 2_000 }), refunded: NOW }, ...log];
      expect(await performPull({ box: GAME, pools: POOLS, actor, rng: rngOf(0.9), log: refunded, expectedPrice: 15 })).toMatchObject({ price: 15 });
      // Two minutes on, the first price again.
      Date.now.mockReturnValue(NOW + STREAK_MS + 1);
      expect(await performPull({ box: GAME, pools: POOLS, actor, rng: rngOf(0.9), log, expectedPrice: 10 })).toMatchObject({ price: 10, streak: 1 });
    } finally { vi.restoreAllMocks(); }
  });
});

describe("the roll, through performPull", () => {
  it("an item card draws from the pools at the rarity odds and grants the item", async () => {
    const actor = actorOf();
    const out = await performPull({ box: GAME, pools: POOLS, actor, rng: rngOf(0.1, 0.9, 0, 0), log: [] });
    expect(out).toMatchObject({ kind: "deck", tone: "boon", price: 10, payoutCp: 0, itemId: "item1", card: { id: "fortune", label: "Fortune", kind: "item", once: false }, cardsLeft: 5, size: 5, streak: 1, nextPrice: 15, result: { name: "Ring of Wishes", rarity: "legendary", uuid: "Item.b" } });
    expect(out.state).toBeUndefined();
    expect(actor.items.get("item1").flags["loot-crates"]).toMatchObject({ boxId: "deck", sourceUuid: "Item.b" });
    expect(toCopper(actor.system.currency)).toBe(9000);
    expect(actor.writes).toHaveLength(1);
  });

  it("a coins card pays its gold out in the same write as the stake", async () => {
    const actor = actorOf();
    const out = await performPull({ box: GAME, pools: POOLS, actor, rng: rngOf(0.3), log: [] });
    expect(out).toMatchObject({ tone: "coin", payoutCp: 5000, itemId: null, card: { id: "windfall" }, result: { name: "Windfall", outcome: "coins" } });
    expect(actor.writes).toHaveLength(1);
    expect(actor.system.currency).toEqual({ pp: 0, gp: 140, ep: 0, sp: 0, cp: 0 });
  });

  it("a loss card takes its gold through the one settle, and no more than the purse holds after the stake", async () => {
    const actor = actorOf();
    const out = await performPull({ box: GAME, pools: POOLS, actor, rng: rngOf(0.5), log: [] });
    expect(out).toMatchObject({ tone: "bane", payoutCp: -2000, lossCp: 2000, takenCp: 2000, itemId: null, card: { id: "ruin", kind: "loss" } });
    expect(actor.writes).toHaveLength(1);
    expect(actor.system.currency).toEqual({ pp: 0, gp: 70, ep: 0, sp: 0, cp: 0 });
    expect(isWholeCoins(actor.system.currency)).toBe(true);
    const poor = actorOf({ gp: 15 });
    const short = await performPull({ box: GAME, pools: POOLS, actor: poor, rng: rngOf(0.5), log: [] });
    expect(short).toMatchObject({ payoutCp: -500, lossCp: 2000, takenCp: 500 });
    expect(toCopper(poor.system.currency)).toBe(0);
    const broke = actorOf({ gp: 10 });
    expect(await performPull({ box: GAME, pools: POOLS, actor: broke, rng: rngOf(0.5), log: [] })).toMatchObject({ payoutCp: 0, takenCp: 0 });
  });

  it("an effect card carries its text, a blank gives nothing, and an item card with no pools turns up blank", async () => {
    const effect = await performPull({ box: GAME, pools: POOLS, actor: actorOf(), rng: rngOf(0.65), log: [] });
    expect(effect).toMatchObject({ tone: "effect", payoutCp: 0, text: "The next long rest is interrupted.", card: { id: "omen", once: true }, cardsLeft: 4 });
    const blank = await performPull({ box: GAME, pools: POOLS, actor: actorOf(), rng: rngOf(0.9), log: [] });
    expect(blank).toMatchObject({ tone: "blank", payoutCp: 0, itemId: null, result: { name: "A blank card", outcome: "blank" }, cardsLeft: 5 });
    // A record whose item card can't draw (no pools) skips it in the plan; the pools vanishing mid-roll make it a blank, never a failure.
    const gone = await performPull({ box: { ...GAME, deck: { cards: [CARDS[0]] } }, pools: POOLS, actor: actorOf(), rng: rngOf(0, 0, 0), log: [], onMissing: null, resolveSource: null });
    expect(gone.tone).toBe("boon");
    globalThis.fromUuid = async () => { throw new Error("gone"); };
    await expect(performPull({ box: { ...GAME, deck: { cards: [CARDS[0]] } }, pools: POOLS, actor: actorOf(), rng: rngOf(0, 0, 0), log: [] })).rejects.toThrow(PullError);
  });

  it("refuses a spent deck and one with no cards before anything is charged, and keeps the core's guards", async () => {
    const actor = actorOf();
    const once = { ...GAME, deck: { ...GAME.deck, cards: CARDS.map(c => ({ ...c, once: true })) } };
    await expect(performPull({ box: once, pools: POOLS, actor, log: CARDS.map(c => row({ cardId: c.id })) })).rejects.toThrow("Nothing is left to draw from The Deck.");
    await expect(performPull({ box: { ...GAME, deck: { cards: [] } }, pools: POOLS, actor })).rejects.toThrow("The Deck has no cards. Tell the GM.");
    await expect(performPull({ box: GAME, pools: POOLS, actor: actorOf({ gp: 9 }) })).rejects.toThrow("Brinn can't afford The Deck.");
    expect(actor.writes).toHaveLength(0);
  });
});

/* A fake world for the socket path and the refund. */
const GM = { id: "gm", name: "Gamemaster" };
const PLAYER = { id: "p1", name: "Player" };
function makeWorld({ actor = actorOf() } = {}) {
  const settings = new Map();
  const handlers = [];
  const emitted = [];
  const game = {
    user: GM,
    users: { activeGM: GM, get: id => [GM, PLAYER].find(u => u.id === id) ?? null },
    actors: { get: id => (id === actor.id ? actor : null) },
    items: { get: id => ({ name: id, img: "", system: {} }) },
    settings: {
      register: (ns, key, { default: def }) => settings.set(`${ns}.${key}`, def),
      get: (ns, key) => settings.get(`${ns}.${key}`),
      async set(ns, key, value) { await tick(); settings.set(`${ns}.${key}`, value); },
    },
    socket: { on: (_n, fn) => handlers.push(fn), emit: (_n, msg) => emitted.push(msg) },
    messages: { contents: [] },
  };
  globalThis.game = game;
  globalThis.foundry = { utils: { randomID: n => Math.random().toString(36).slice(2, 2 + n), deepClone: v => structuredClone(v), escapeHTML: s => String(s) } };
  globalThis.ChatMessage = { create: vi.fn(async data => data), getSpeaker: () => ({ actor: actor.id }) };
  registerSettings();
  registerSocket();
  return { game, actor, emitted, deliver: msg => Promise.all(handlers.map(h => h(msg))) };
}
const drawOnce = async (world, rng, { requestId = "d1", price = 10 } = {}) => {
  globalThis.CONFIG = { Dice: { randomUniform: rng } };
  try { await world.deliver({ type: "pull", requestId, boxId: "deck", actorId: "a1", userId: "p1", price }); } finally { delete globalThis.CONFIG; }
};

describe("the GM's socket path", () => {
  it("charges the first draw at the base price and the second in a row at the risen one, writing each to the row and the reveal", async () => {
    const world = makeWorld();
    await world.game.settings.set("loot-crates", "boxes", { deck: GAME });
    await world.game.settings.set("loot-crates", "pools", POOLS);
    await drawOnce(world, rngOf(0.9), { requestId: "d1", price: 10 });
    await drawOnce(world, rngOf(0.9), { requestId: "d2", price: 10 });
    expect(world.emitted.find(m => m.type === "error")).toMatchObject({ requestId: "d2", message: "The Deck now costs 15 gp (you pressed 10 gp). Nothing was charged." });
    await drawOnce(world, rngOf(0.9), { requestId: "d3", price: 15 });
    const reveals = world.emitted.filter(m => m.type === "reveal");
    expect(reveals).toHaveLength(2);
    expect(reveals[0]).toMatchObject({ kind: "deck", box: { id: "deck", name: "The Deck", price: 10 }, streak: 1, nextPrice: 15, cardsLeft: 5, size: 5, tone: "blank" });
    expect(reveals[1]).toMatchObject({ box: { price: 15 }, streak: 2, nextPrice: 22.5 });
    for (const k of ["grant", "state", "pools"]) expect(reveals[1]).not.toHaveProperty(k);
    const log = world.game.settings.get("loot-crates", "pullLog");
    expect(log.map(r => r.price)).toEqual([15, 10]);
    expect(log[0]).toMatchObject({ kind: "deck", cardId: "blank", card: "A blank card", cardKind: "blank", once: false, tone: "blank", streak: 2, swatch: "none", name: "A blank card", payoutCp: 0, itemId: null });
    expect(toCopper(world.actor.system.currency)).toBe(7500);
    expect(world.game.settings.get("loot-crates", "actorState")).toEqual({});
    // Every draw posts a card, with the deck's words and the row's id.
    expect(globalThis.ChatMessage.create).toHaveBeenCalledTimes(2);
    const [msg] = globalThis.ChatMessage.create.mock.calls[1];
    expect(msg.content).toContain("Brinn drew from <strong>The Deck</strong> <span class=\"lc-chat__price\">15 gp</span>");
    expect(msg.content).toContain(`<div class="lc-chat__name">A blank card</div>`);
    expect(msg.flags["loot-crates"]).toEqual({ boxId: "deck", logId: reveals[1].logId });
  });

  it("two pulls pressed at the same risen price (Draw again and the shop's Buy, before either redraws) charge once: the queue prices the second after the first's row and refuses it", async () => {
    const world = makeWorld();
    await world.game.settings.set("loot-crates", "boxes", { deck: GAME });
    await world.game.settings.set("loot-crates", "pools", POOLS);
    await drawOnce(world, rngOf(0.9), { requestId: "d1", price: 10 });
    expect(toCopper(world.actor.system.currency)).toBe(9000);
    // Both arrive at the GM before the first is handled: the write queue runs them in turn.
    globalThis.CONFIG = { Dice: { randomUniform: rngOf(0.9) } };
    try {
      await Promise.all([
        world.deliver({ type: "pull", requestId: "again", boxId: "deck", actorId: "a1", userId: "p1", price: 15 }),
        world.deliver({ type: "pull", requestId: "buy", boxId: "deck", actorId: "a1", userId: "p1", price: 15 }),
      ]);
    } finally { delete globalThis.CONFIG; }
    expect(world.emitted.filter(m => m.type === "reveal")).toHaveLength(2);
    expect(world.emitted.filter(m => m.type === "error")).toEqual([expect.objectContaining({ requestId: "buy", message: "The Deck now costs 22 gp 5 sp (you pressed 15 gp). Nothing was charged." })]);
    expect(toCopper(world.actor.system.currency)).toBe(7500);
    expect(world.game.settings.get("loot-crates", "pullLog").map(r => r.price)).toEqual([15, 10]);
  });

  it("a once card drawn is out of the deck for the next draw, back after its refund, and the row carries what each card did", async () => {
    const world = makeWorld();
    await world.game.settings.set("loot-crates", "boxes", { deck: GAME });
    await world.game.settings.set("loot-crates", "pools", POOLS);
    await drawOnce(world, rngOf(0.65), { requestId: "d1", price: 10 });
    const [reveal] = world.emitted.filter(m => m.type === "reveal");
    expect(reveal).toMatchObject({ tone: "effect", text: "The next long rest is interrupted.", cardsLeft: 4, card: { id: "omen", once: true } });
    const [omen] = world.game.settings.get("loot-crates", "pullLog");
    expect(omen).toMatchObject({ cardId: "omen", once: true, text: "The next long rest is interrupted.", swatch: "none" });
    expect(deckOdds(GAME, POOLS, getLog()).rows.map(r => r.name)).toEqual(["Item", "Coins", "Loss", "Blank"]);
    // The effect card's text rides in the chat card, inside the block the core seals.
    const [msg] = globalThis.ChatMessage.create.mock.calls[0];
    expect(msg.content).toContain(`<div class="lc-chat__text">The next long rest is interrupted.</div>`);
    expect(msg.content.indexOf("lc-chat__item")).toBeLessThan(msg.content.indexOf("lc-chat__text"));
    // 0.68 would be the omen again; with it out, the same number lands on the blank.
    await drawOnce(world, rngOf(0.68), { requestId: "d2", price: 15 });
    expect(world.emitted.filter(m => m.type === "reveal")[1]).toMatchObject({ tone: "blank", cardsLeft: 4 });
    await refundPull(omen.id);
    expect(deckOdds(GAME, POOLS, getLog()).rows.map(r => r.name)).toEqual(["Item", "Coins", "Loss", "Effect", "Blank"]);
  });

  it("a loss card's row says what the card took, and an item card's row is the crate's", async () => {
    const world = makeWorld();
    await world.game.settings.set("loot-crates", "boxes", { deck: GAME });
    await world.game.settings.set("loot-crates", "pools", POOLS);
    await drawOnce(world, rngOf(0.5), { requestId: "d1", price: 10 });
    const [loss] = world.game.settings.get("loot-crates", "pullLog");
    expect(loss).toMatchObject({ cardId: "ruin", tone: "bane", payoutCp: -2000, lossCp: 2000, takenCp: 2000, swatch: "bane", price: 10 });
    expect(logPayoutNote(loss)).toContain("Loss card · took 20 gp");
    expect(toCopper(world.actor.system.currency)).toBe(7000);
    const [msg] = globalThis.ChatMessage.create.mock.calls[0];
    expect(msg.content).toContain("lc-rarity-bane");
    expect(msg.content).toContain("Loss · 20 gp taken");
    await drawOnce(world, rngOf(0.1, 0.9, 0, 0), { requestId: "d2", price: 15 });
    const [item] = world.game.settings.get("loot-crates", "pullLog");
    expect(item).toMatchObject({ cardId: "fortune", tone: "boon", name: "Ring of Wishes", uuid: "Item.b", rarity: "legendary", itemId: "item1", price: 15 });
    expect(item).not.toHaveProperty("swatch");
    expect(globalThis.ChatMessage.create.mock.calls[1][0].content).toContain("Fortune · Legendary");
  });
});

describe("the one refund, for a card", () => {
  async function seed(actor, rows) {
    const world = makeWorld({ actor });
    await world.game.settings.set("loot-crates", "boxes", { deck: GAME });
    await world.game.settings.set("loot-crates", "actorState", {});
    for (const r of rows) await appendLog(r);
    return world;
  }
  const LOSS = { kind: "deck", boxId: "deck", boxName: "The Deck", actorId: "a1", actorName: "Brinn", userId: "p1", itemId: null, cardId: "ruin", card: "Ruin", cardKind: "loss", once: false, tone: "bane", streak: 1, name: "Ruin", price: 10, payoutCp: -2000, lossCp: 2000, takenCp: 2000, swatch: "bane" };

  it("a loss: the stake and what the card took come back in one move, once; nothing else is touched", async () => {
    const actor = actorOf({ gp: 70 });
    await seed(actor, [LOSS]);
    const rowId = getLog()[0].id;
    expect(refundCoins(LOSS)).toBe(3000);
    expect(describeRefund(rowId)).toMatchObject({ status: "ready", coins: 3000, item: null });
    const out = await refundPull(rowId);
    expect(out).toMatchObject({ status: "refunded", removedItem: null });
    expect(actor.system.currency).toEqual({ pp: 0, gp: 100, ep: 0, sp: 0, cp: 0 });
    expect(actor.writes).toHaveLength(1);
    expect((await refundPull(rowId)).status).toBe("already");
    expect(actor.writes).toHaveLength(1);
    const card = await postRefundCard({ row: getLog()[0], actor, removedItem: null });
    expect(card.content).toContain("30 gp went back into their purse: the 10 gp stake and the 20 gp the card took.");
    expect(card.content).toContain("lc-rarity-none");
    // The head says "was refunded" alone: 10 gp isn't what moved.
    expect(card.content).toContain("<strong>The Deck</strong> was refunded</div>");
    expect(card.content).not.toContain("lc-chat__price");
  });

  it("a coins card gives the stake back less the payout, and refuses when the winnings are spent", async () => {
    const actor = actorOf({ gp: 140 });
    await seed(actor, [{ ...LOSS, cardId: "windfall", card: "Windfall", cardKind: "coins", tone: "coin", name: "Windfall", payoutCp: 5000, swatch: "coin", lossCp: undefined, takenCp: undefined }]);
    const rowId = getLog()[0].id;
    expect(describeRefund(rowId)).toMatchObject({ status: "ready", coins: -4000 });
    await refundPull(rowId);
    expect(toCopper(actor.system.currency)).toBe(10000);
    const poor = actorOf({ gp: 30 });
    await seed(poor, [{ ...LOSS, cardId: "windfall", cardKind: "coins", tone: "coin", payoutCp: 5000 }]);
    expect(describeRefund(getLog()[0].id)).toMatchObject({ status: "short", short: 10 });
  });

  it("an item card's refund removes the item, as a crate's does, and the second draw's price comes back with it", async () => {
    const actor = actorOf({ gp: 85 });
    const item = { id: "item1", name: "Ring of Wishes", flags: { "loot-crates": { sourceUuid: "Item.b" } }, async delete() { await tick(); actor.items.delete("item1"); } };
    actor.items.set("item1", item);
    const at = NOW - 5000;
    await seed(actor, [{ ...LOSS, at: NOW - 60_000, payoutCp: 0, lossCp: undefined, takenCp: undefined, cardId: "blank", cardKind: "blank", tone: "blank", name: "A blank card", swatch: "none" }, { ...LOSS, at, cardId: "fortune", card: "Fortune", cardKind: "item", tone: "boon", name: "Ring of Wishes", uuid: "Item.b", rarity: "legendary", itemId: "item1", price: 15, payoutCp: 0, swatch: undefined, lossCp: undefined, takenCp: undefined, streak: 2 }]);
    const [second] = getLog();
    expect(nextPrice(GAME, getLog(), { actorId: "a1", now: NOW })).toBe(22.5);
    const out = await refundPull(second.id);
    expect(out).toMatchObject({ status: "refunded", removedItem: "Ring of Wishes" });
    expect(actor.items.has("item1")).toBe(false);
    expect(toCopper(actor.system.currency)).toBe(10000);
    expect(nextPrice(GAME, getLog(), { actorId: "a1", now: NOW })).toBe(15);
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
  const turn = h => Number(h.querySelector(".lc-deck__card").style.transform.match(/rotateY\(([\d.]+)deg\)/)[1]);
  const lift = h => Number(h.querySelector(".lc-deck__card").style.transform.match(/translateY\((-?[\d.]+)px\)/)[1]);
  const runTo = t => { let now = 0; while (frames.length && now <= t) { const cb = frames.shift(); cb(now); now += 50; } };

  it("lifts the card, holds it face-down through three beats, turns it once in one frame loop, and lands", async () => {
    const h = host();
    const onBeat = vi.fn(), onLand = vi.fn();
    const ctrl = mountDeck(h, { tone: "coin", swatch: "coin", label: "Windfall", kindLabel: "Coins", onBeat, onLand });
    expect(h.classList.contains("lc-deck")).toBe(true);
    expect(h.classList.contains("lc-rarity-coin")).toBe(true);
    expect(h.dataset.tone).toBe("coin");
    expect(h.querySelector(".lc-deck__stage").getAttribute("aria-hidden")).toBe("true");
    expect(h.querySelector(".lc-deck__label").textContent).toBe("Windfall");
    expect(h.querySelector(".lc-deck__kind").textContent).toBe("Coins");
    expect(h.querySelector(".lc-deck__glyph")).not.toBeNull();
    const played = ctrl.play();
    runTo(0);
    expect(turn(h)).toBe(0);
    expect(lift(h)).toBe(0);
    runTo(DECK_TIMING.lift);
    expect(lift(h)).toBeLessThan(-13);
    expect(turn(h)).toBe(0);
    expect(onBeat.mock.calls.map(c => c[0])).toEqual([0]);
    runTo(DECK_TIMING.lift + DECK_TIMING.hold - 1);
    expect(turn(h)).toBe(0);
    expect(onBeat.mock.calls.map(c => c[0])).toEqual([0, 1, 2]);
    runTo(DECK_TIMING.lift + DECK_TIMING.hold + DECK_TIMING.flip / 2);
    expect(turn(h)).toBeGreaterThan(90);
    expect(turn(h)).toBeLessThan(180);
    expect(onLand).not.toHaveBeenCalled();
    runTo(deckLandTime() + 50);
    await played;
    expect(onLand).toHaveBeenCalledTimes(1);
    expect(turn(h)).toBe(180);
    expect(lift(h)).toBe(-14);
    expect(h.classList.contains("lc-deck--landed")).toBe(true);
    expect(frames).toHaveLength(0);
    // Only the card's transform was written.
    expect(Object.keys(h.querySelector(".lc-deck__card").style)).toEqual(["transform"]);
    for (const el of h.querySelectorAll(".lc-deck__face, .lc-deck__art, .lc-deck__label")) expect(Object.keys(el.style)).toEqual([]);
  });

  it("lands at once under reduced motion, at zero duration and on skip, turned; freezeAt holds the pose", async () => {
    const a = host();
    await mountDeck(a, { tone: "boon", swatch: "legendary", label: "Fortune", img: "ring.webp", reducedMotion: true }).play();
    expect(a.classList.contains("lc-deck--landed")).toBe(true);
    expect(turn(a)).toBe(180);
    expect(a.querySelector(".lc-deck__art img").getAttribute("src")).toBe("ring.webp");
    const b = host();
    await mountDeck(b, { duration: 0 }).play();
    expect(b.classList.contains("lc-deck--landed")).toBe(true);
    const c = host();
    const ctrl = mountDeck(c, { label: "Ruin" });
    const played = ctrl.play();
    runTo(100);
    ctrl.skip();
    ctrl.skip();
    await played;
    expect(ctrl.skipped).toBe(true);
    expect(turn(c)).toBe(180);
    frames.length = 0;
    const d = host();
    const onLand = vi.fn();
    const held = mountDeck(d, { label: "Windfall", freezeAt: DECK_TIMING.lift + DECK_TIMING.hold / 2, onLand });
    held.play();
    expect(frames).toHaveLength(0);
    expect(turn(d)).toBe(0);
    expect(lift(d)).toBe(-14);
    expect(onLand).not.toHaveBeenCalled();
    held.skip();
    expect(onLand).toHaveBeenCalledTimes(1);
  });

  it("the kind's play names the card, shows an item's art and ticks softly through the hold", async () => {
    const h = host();
    const reveal = { kind: "deck", card: { id: "fortune", label: "Fortune", kind: "item" }, tone: "boon", result: { name: "Ring of Wishes", rarity: "legendary", img: "ring.webp" }, box: { name: "The Deck", price: 10 }, actorName: "Tam" };
    const onLand = vi.fn();
    const ctrl = getKind("deck").reveal.play(h, reveal, { sound: true, pageHidden: () => false, onLand });
    const played = ctrl.play();
    runTo(deckLandTime() + 50);
    await played;
    expect(h.classList.contains("lc-rarity-legendary")).toBe(true);
    expect(h.dataset.tone).toBe("boon");
    expect(h.querySelector(".lc-deck__label").textContent).toBe("Fortune");
    expect(h.querySelector(".lc-deck__kind").textContent).toBe("Legendary");
    expect(h.querySelector(".lc-deck__art img").getAttribute("src")).toBe("ring.webp");
    expect(sound.playTick.mock.calls.map(c => c[0])).toEqual([0, 0.5, 1]);
    expect(onLand).toHaveBeenCalledTimes(1);
    const bane = host();
    getKind("deck").reveal.play(bane, { kind: "deck", card: { id: "ruin", label: "Ruin", kind: "loss" }, tone: "bane", result: { name: "Ruin" }, box: {} }, { sound: false, onLand() {} });
    expect(bane.classList.contains("lc-rarity-bane")).toBe(true);
    expect(bane.querySelector(".lc-deck__kind").textContent).toBe("Loss");
  });
});

describe("the words", () => {
  const esc = s => String(s ?? "");
  const kind = getKind("deck");
  const reveal = (over = {}) => ({ kind: "deck", userId: "p1", actorId: "a1", actorName: "Brinn", box: { id: "deck", name: "The Deck", price: 10 }, card: { id: "windfall", label: "Windfall", kind: "coins", once: false }, tone: "coin", result: { name: "Windfall", outcome: "coins" }, payoutCp: 5000, cardsLeft: 5, size: 5, streak: 1, nextPrice: 15, purse: { gp: 140 }, ...over });

  it("heads the window with the draw and its place in a row, and reads each card's result", () => {
    expect(kind.reveal.title).toBe("A card from the deck");
    expect(kind.reveal.replayable).toBe(false);
    expect(kind.noun).toBe("deck");
    expect(kind.gotText({ card: { label: "Ruin" }, result: { name: "Ruin" } })).toBe("drew Ruin");
    expect(kind.chat.conditional).toBeUndefined();
    expect(kind.reveal.head(reveal(), { esc }).replace(/\s+/g, " ")).toBe(`<span class="lc-reveal__who">Brinn</span> draws from <strong class="lc-reveal__crate">The Deck</strong> <span class="lc-reveal__price">10 gp</span>`);
    expect(kind.reveal.head(reveal({ streak: 3, box: { name: "The Deck", price: 22.5 } }), { esc })).toContain(`22 gp 5 sp</span> <span class="lc-reveal__streak">· 3rd in a row</span>`);
    const coin = kind.reveal.result(reveal(), { esc, canSee: true });
    expect(coin).toContain(`<div class="lc-reveal__quiet">Windfall</div>`);
    expect(coin).toContain("50 gp into Brinn's purse · <span class=\"lc-reveal__gold\">140 gp left</span> · 5 of 5 cards left");
    expect(kind.reveal.result(reveal(), { esc, canSee: false })).not.toContain("left</span>");
    const bane = kind.reveal.result(reveal({ card: { label: "Ruin", kind: "loss" }, tone: "bane", payoutCp: -2000, lossCp: 2000, takenCp: 2000 }), { esc, canSee: false });
    expect(bane).toContain(`<div class="lc-reveal__quiet lc-deck__bane">Ruin</div>`);
    expect(bane).toContain("The card takes 20 gp · 5 of 5 cards left");
    expect(kind.reveal.result(reveal({ card: { label: "Ruin", kind: "loss" }, tone: "bane", lossCp: 2000, takenCp: 500 }), { esc })).toContain("The card takes 5 gp (it asked 20 gp; the purse had no more)");
    const effect = kind.reveal.result(reveal({ card: { label: "Omen", kind: "effect", once: true }, tone: "effect", text: "The next long rest is interrupted.", cardsLeft: 4 }), { esc });
    expect(effect).toContain(`<div class="lc-deck__text">The next long rest is interrupted.</div>`);
    expect(effect).toContain("The GM plays it out · 4 of 5 cards left");
    expect(kind.reveal.result(reveal({ card: { label: "A blank card", kind: "blank" }, tone: "blank" }), { esc })).toContain("Nothing happens · 5 of 5 cards left");
    expect(kind.reveal.result(reveal({ card: { label: "Fortune", kind: "item" }, tone: "blank", note: "its pools held nothing" }), { esc })).toContain("Nothing happens: its pools held nothing");
    const boon = kind.reveal.result(reveal({ card: { label: "Fortune", kind: "item" }, tone: "boon", result: { name: "Ring of Wishes", rarity: "legendary" }, itemUuid: "Actor.a1.Item.i" }), { esc, canSee: true });
    expect(boon).toContain(`<div class="lc-reveal__name">Ring of Wishes</div>`);
    expect(boon).toContain("Added to Brinn's inventory · <span class=\"lc-reveal__gold\">140 gp left</span> · 5 of 5 cards left");
    expect(cardsLeftText(1, 1)).toBe("1 of 1 card left");
  });

  it("tells the buyer alone of a bane and a blank, and stings for the tone: the one falling sound is the bane's", () => {
    expect(kind.reveal.notice(reveal({ card: { label: "Ruin", kind: "loss" }, tone: "bane", lossCp: 2000, takenCp: 2000 }))).toBe("The Deck: Ruin. The card takes 20 gp.");
    expect(kind.reveal.notice(reveal({ card: { label: "A blank card", kind: "blank" }, tone: "blank" }))).toBe("The Deck: A blank card. Nothing happens.");
    expect(kind.reveal.notice(reveal())).toBeNull();
    kind.reveal.sting(reveal());
    expect(sound.playCoinBack).toHaveBeenCalledOnce();
    kind.reveal.sting(reveal({ tone: "bane" }));
    expect(sound.playBane).toHaveBeenCalledOnce();
    kind.reveal.sting(reveal({ tone: "boon", result: { rarity: "rare" } }));
    expect(sound.playReveal).toHaveBeenCalledWith("rare");
    kind.reveal.sting(reveal({ tone: "effect" }));
    kind.reveal.sting(reveal({ tone: "blank" }));
    expect(sound.playPlink).toHaveBeenCalledTimes(2);
  });

  it("offers the next draw from the window at the price the log says now, and says why it is off", () => {
    const log = [row({ at: NOW - 3000, actorId: "a1" })];
    const ctx = { game: GAME, log, pools: POOLS, purse: { gp: 100 }, now: NOW, open: true, gmOnline: true };
    expect(kind.reveal.again(reveal(), ctx)).toEqual({ price: 15, label: "Draw again for 15 gp", off: "" });
    expect(kind.reveal.again(reveal(), { ...ctx, log: [] })).toMatchObject({ price: 10, label: "Draw again for 10 gp" });
    expect(kind.reveal.again(reveal(), { ...ctx, purse: { gp: 12 } })).toMatchObject({ price: 15, off: "Needs 3 gp more" });
    expect(kind.reveal.again(reveal(), { ...ctx, open: false })).toMatchObject({ off: "The GM has closed the shop." });
    expect(kind.reveal.again(reveal(), { ...ctx, open: false, gmOnline: false })).toMatchObject({ off: "Closed until a GM is online." });
    const once = { ...GAME, deck: { ...GAME.deck, cards: CARDS.map(c => ({ ...c, once: true })) } };
    expect(kind.reveal.again(reveal(), { ...ctx, game: once, log: CARDS.map(c => row({ cardId: c.id })) })).toMatchObject({ off: "Every card is drawn" });
    expect(kind.reveal.again(reveal(), { ...ctx, game: null })).toBeNull();
    expect(kind.reveal.again(reveal({ replay: true }), ctx)).toBeNull();
  });

  it("the chat card: every draw posts one, its words in the block the core seals, in the card's swatch", async () => {
    const link = (u, n) => `<a href="${u}">${n}</a>`;
    const coin = kind.chat.card(reveal(), { esc, itemLink: link });
    expect(coin).toContain(`lc-chat lc-rarity-coin`);
    expect(coin).toContain("Brinn drew from <strong>The Deck</strong>");
    expect(coin).toContain(`<div class="lc-chat__name">Windfall</div>`);
    expect(coin).toContain("Coins · 50 gp into the purse");
    expect(coin).toContain(`<span class="lc-deck__mark" aria-hidden="true"></span>`);
    const boon = kind.chat.card(reveal({ card: { label: "Fortune", kind: "item" }, tone: "boon", result: { name: "Ring of Wishes", rarity: "legendary", img: "r.webp", uuid: "Item.b" }, itemUuid: "Actor.a1.Item.i" }), { esc, itemLink: link });
    expect(boon).toContain(`<a href="Actor.a1.Item.i">Ring of Wishes</a>`);
    expect(boon).toContain(`<img src="r.webp" alt="">`);
    expect(boon).toContain("Fortune · Legendary");
    expect(kind.chat.card(reveal({ card: { label: "A blank card", kind: "blank" }, tone: "blank" }), { esc, itemLink: link })).toContain(`<div class="lc-chat__rarity">Blank</div>`);
    expect(kind.chat.card(reveal({ card: { label: "Omen", kind: "effect" }, tone: "effect", text: "<b>x</b>" }), { esc: s => String(s).replace(/</g, "&lt;"), itemLink: link })).toContain("&lt;b>x&lt;/b>");
    // Through postPullCard: posted for a miss-like card too, with the row's id.
    makeWorld();
    const msg = await postPullCard({ ...reveal({ card: { label: "A blank card", kind: "blank" }, tone: "blank", result: { name: "A blank card" } }), logId: "L1" });
    expect(msg.flags["loot-crates"]).toEqual({ boxId: "deck", logId: "L1" });
  });

  it("the shop card names the kinds of card, counts the cards left, prices the draw by the streak and says why it is off", () => {
    const ctx = (over = {}) => ({ esc, purse: { gp: 100 }, hasActor: true, actorId: "a1", actorName: "Brinn", open: true, gmOnline: true, stateOf: () => ({}), log: [], now: NOW, held: () => false, ...over });
    const why = html => html.match(/<div class="lc-box__why"[^>]*>([^<]*)<\/div>/)?.[1] ?? "";
    const html = kind.shop.card(GAME, POOLS, ctx());
    expect(html).toContain(`<span class="lc-odd lc-rarity-legendary">Item 20%</span><span class="lc-odd lc-rarity-coin">Coins 20%</span><span class="lc-odd lc-rarity-bane">Loss 20%</span><span class="lc-odd lc-rarity-none">Effect 10%</span><span class="lc-odd lc-rarity-none">Blank 30%</span>`);
    expect(html).toContain(`<div class="lc-box__stock">5 of 5 cards left</div>`);
    expect(html).toContain("Draw for 10 gp");
    expect(html).toContain(`data-price="10"`);
    expect(html).toContain(`class="lc-box lc-rarity-legendary"`);
    expect(html).not.toContain("lc-box__rule");
    expect(html).not.toContain("aria-disabled");
    const again = kind.shop.card(GAME, POOLS, ctx({ log: [row({ at: NOW - 1000 }), row({ at: NOW - 30_000, cardId: "omen" })] }));
    expect(again).toContain("Draw for 22 gp 5 sp");
    expect(again).toContain(`data-price="22.5"`);
    expect(again).toContain(`<div class="lc-box__rule">3rd draw in a row: 22 gp 5 sp (back to 10 gp after two minutes)</div>`);
    expect(again).toContain("4 of 5 cards left");
    expect(why(kind.shop.card(GAME, POOLS, ctx({ held: id => id === "deck" })))).toBe("Still turning");
    expect(why(kind.shop.card(GAME, POOLS, ctx({ purse: { gp: 12 }, log: [row({ at: NOW - 1000 })] })))).toBe("Needs 3 gp more");
    const once = { ...GAME, deck: { ...GAME.deck, cards: CARDS.map(c => ({ ...c, once: true })) } };
    const spent = kind.shop.card(once, POOLS, ctx({ log: CARDS.map(c => row({ cardId: c.id, at: NOW - 500_000 })) }));
    expect(why(spent)).toBe("Every card is drawn");
    expect(spent).toContain("0 of 5 cards left");
    expect(kind.shop.card({ ...GAME, pools: [] }, POOLS, ctx())).toContain(`class="lc-box lc-box--deck"`);
    expect(kind.shop.reason(GAME, POOLS, ctx())).toBe("");
    expect(kind.shop.reason(GAME, POOLS, ctx({ open: false }))).toBe("The GM has closed the shop.");
    expect(kind.shop.reason(GAME, POOLS, ctx({ purse: { gp: 14 }, log: [row({ at: NOW - 1000 })] }))).toBe("Needs 1 gp more");
    expect(kind.shop.reason({ ...GAME, deck: { cards: [] } }, POOLS, ctx())).toBe("The deck has no cards");
  });

  it("the manager's words: the rules cell, the editor's draft, preview and summary", () => {
    expect(deckRulesText(GAME)).toBe("5 cards, ×1.5 a draw in a row");
    expect(deckRulesText(GAME, [row({ cardId: "omen" })])).toBe("5 cards, 1 drawn, ×1.5 a draw in a row");
    expect(deckRulesText({ ...GAME, deck: { step: 2, cards: [CARDS[0]] } })).toBe("1 card, ×2 a draw in a row");
    const draft = draftDeck(GAME, { name: "x", price: "12", step: "2", cards: ["a", "b"], "c.a.label": "Gift", "c.a.kind": "coins", "c.a.weight": "3", "c.a.once": true, "c.a.gp": "7", "c.a.text": "", "c.b.label": "", "c.b.kind": "effect", "c.b.weight": "", "c.b.once": false, "c.b.gp": "", "c.b.text": " Rains. ", "pool.p": "on", "share.p": "2", "w.uncommon": "1", "w.legendary": "0" }, ["p"]);
    expect(draft.price).toBe(12);
    expect(draft.deck.step).toBe(2);
    expect(draft.deck.shuffledAt).toBe(0);
    expect(draft.deck.cards).toEqual([
      { id: "a", label: "Gift", kind: "coins", weight: 3, once: true, gp: 7, text: "" },
      { id: "b", label: "Effect", kind: "effect", weight: 0, once: false, gp: 0, text: "Rains." },
    ]);
    expect(draft.pools).toEqual([{ id: "p", share: 2 }]);
    // One card: the form gives a string, not a list; no step keeps the record's.
    expect(draftDeck(GAME, { cards: "a", "c.a.kind": "blank", step: "" }, []).deck).toMatchObject({ step: 1.5, cards: [{ id: "a", kind: "blank", weight: 1 }] });
    expect(draftDeck(GAME, {}, []).deck.cards).toEqual([]);
    const ok = deckPreview(GAME, POOLS);
    expect(ok.note).toBe("");
    expect(deckPreviewHTML(ok)).toContain("Item 20%");
    expect(deckPreviewHTML(ok)).toContain("If an item:");
    expect(deckPreviewHTML(ok)).toContain("5 of 5 cards left");
    expect(deckSummary(ok)).toBe("Item 20%, Coins 20%, Loss 20%, Effect 10%, Blank 30%. If an item: Uncommon 75%, Legendary 25%. 5 of 5 cards left");
    expect(deckPreview({ ...GAME, deck: { cards: [] } }, POOLS)).toMatchObject({ warn: true, note: "This deck has no cards." });
    expect(deckPreview({ ...GAME, deck: { cards: CARDS.map(c => ({ ...c, weight: 0 })) } }, POOLS).note).toBe("Every card weighs 0, so nothing can be drawn.");
    expect(deckPreview({ ...GAME, pools: [] }, POOLS).note).toBe("The item cards have no pool ticked, so they can never be drawn; the other cards still can.");
    expect(deckPreview({ ...GAME, pools: [{ id: "empty", share: 1 }] }, { ...POOLS, empty: { id: "empty", entries: [] } }).note).toBe("The item cards' pools have no item that can drop, so they can never be drawn; the other cards still can.");
    const once = { ...GAME, deck: { ...GAME.deck, cards: CARDS.map(c => ({ ...c, once: true })) } };
    const spent = deckPreview(once, POOLS, CARDS.map(c => row({ cardId: c.id })));
    expect(spent).toMatchObject({ warn: true, note: "Every card is drawn: reshuffle to put them back." });
    expect(deckPreviewHTML(spent)).toContain("lc-form__hint--warn");
    expect(DECK.id).toBe("deck");
    expect(getKind("deck")).toBe(DECK);
    expect(DECK.undo).toBeUndefined();
  });
});
