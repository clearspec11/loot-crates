/*
  Scratch tickets (scratch.js) on the core: the record as the editor saves
  it (the prize list merged and best first, the roll never smaller than
  its prizes, the grid in its layout's limits), the roll's ledger read
  from the log (tickets sold, prizes left, sold out, a refund putting a
  ticket back), the draw without replacement over a whole roll through
  performPull (every prize exactly its count of times, then Sold out
  before anything is charged), the honest card for thousands of seeded
  tickets of both layouts (the wins read back from the layout equal the
  decided payout, and every lottery rule holds), the readout's numbers,
  the socket path's reveal, row and chat card, the one refund, and the
  words: the shop card with tickets left and sold out, the held counts,
  Another ticket, the Boxes row.
  Real pull.js, socket.js, refund.js, chat.js and store.js on a fake world;
  reveal.js is mocked where the socket path needs it.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../module/scripts/foundry/reveal.js", () => ({ showReveal: vi.fn(async () => ({ landed: Promise.resolve() })), heldState: () => null, heldBefore: () => null, boxHeld: () => false, onHold: () => () => {}, onRelease: () => () => {} }));
vi.mock("../module/scripts/foundry/sound.js", () => ({ playTick: vi.fn(), playSlow: vi.fn(), playReveal: vi.fn(), playPlop: vi.fn(), playPlink: vi.fn(), playCoinBack: vi.fn(), playBane: vi.fn(), playScratch: vi.fn(), playFoilTick: vi.fn() }));

const scratch = await import("../module/scripts/games/scratch.js");
const { SCRATCH, SCRATCH_DEFAULTS, SYMBOLS, THEMES, MAX_PRIZES, rowParts, showsLeft, themeOf, prizesOf, rollOf, gridOf, bonusOf, layoutOf, rollState, ticketsSold, drawBag, rollReason, layCard, cardWins, cleanCard, splitsOf, luckyCount, rollOdds, rollPrizes, ribbonTotalText, oddsText, oneIn, prizeText, ticketsLeftText, scratchRulesText, scratchOddsHTML, nextRoll, draftScratch, scratchFieldsHTML, scratchPreview, scratchPreviewHTML, ticketHTML, miniHTML, shownState, prizeListHTML } = scratch;
const { getKind, gotText } = await import("../module/scripts/games/kinds.js");
const { performPull, PullError } = await import("../module/scripts/foundry/pull.js");
const { registerSocket } = await import("../module/scripts/foundry/socket.js");
const { registerSettings, getLog } = await import("../module/scripts/foundry/store.js");
const { refundPull } = await import("../module/scripts/foundry/refund.js");
const { NEW_DEFAULTS, copyOf } = await import("../module/scripts/views/newgame.js");
const { boxesTableHTML } = await import("../module/scripts/views/boxestable.js");
const sound = await import("../module/scripts/foundry/sound.js");
const { toCopper } = await import("../module/scripts/core/currency.js");
const { seededRng } = await import("../module/scripts/core/odds.js");
const { RARITIES } = await import("../module/scripts/core/config.js");

const tick = () => new Promise(r => setTimeout(r, 0));
const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const POOLS = { p: { id: "p", name: "The hoard", pools: [], entries: [
  { uuid: "Item.a", name: "Lucky Coin", img: "a.webp", rarity: "uncommon", weight: 1 },
  { uuid: "Item.b", name: "Flame Tongue", img: "b.webp", rarity: "rare", weight: 1 },
] } };
// The mockup's Fortune Ticket on the hoard: 5 gp, lucky numbers, roll 1 of 100.
const GAME = { ...NEW_DEFAULTS.scratch(), id: "fortune", name: "Fortune Ticket", pools: [{ id: "p", share: 1 }] };
// A small roll for walking through whole: 1 rare, 2 x 10 gp, 1 bonus, 2 duds.
const SMALL = { ...GAME, id: "small", name: "Small Ticket", roll: { id: 1, size: 6, prizes: [{ count: 1, item: { rarity: "rare" } }, { count: 2, gp: 10 }, { count: 1, bonus: true }] } };
const MATCH3 = { ...GAME, id: "m3", name: "Market Scratchie", price: 1, layout: "match3", grid: { cols: 3, rows: 2 }, bonus: { on: false, gp: 0 }, roll: { id: 1, size: 50, prizes: [{ count: 1, item: { rarity: "uncommon" } }, { count: 4, gp: 5 }, { count: 10, gp: 1 }] } };

const actorOf = (currency = { pp: 0, gp: 100, ep: 0, sp: 0, cp: 0 }) => {
  const actor = {
    id: "a1", name: "Tam", items: new Map(), writes: [], system: { currency: { ...currency } },
    testUserPermission: () => true,
    async update(data) { await tick(); actor.writes.push(data["system.currency"]); if (data["system.currency"]) actor.system.currency = data["system.currency"]; },
    async createEmbeddedDocuments(_type, [data]) { await tick(); const id = `item${actor.items.size + 1}`; const item = { id, name: data.name, flags: data.flags, async delete() { await tick(); actor.items.delete(id); } }; actor.items.set(id, item); return [item]; },
  };
  return actor;
};
const source = async uuid => ({ uuid, name: uuid.endsWith(".b") ? "Flame Tongue" : "Lucky Coin", img: "x.webp", toObject: () => ({ name: uuid.endsWith(".b") ? "Flame Tongue" : "Lucky Coin", type: "weapon", flags: {}, system: { rarities: [] } }) });
const row = (over = {}) => ({ id: `r${Math.random().toString(36).slice(2, 8)}`, kind: "scratch", boxId: "fortune", actorId: "a1", rollId: 1, tier: "dud", at: 1, ...over });

beforeEach(() => { globalThis.fromUuid = source; });
afterEach(() => { delete globalThis.fromUuid; delete globalThis.game; delete globalThis.foundry; delete globalThis.ChatMessage; delete globalThis.ui; for (const fn of Object.values(sound)) fn.mockClear?.(); });

describe("the record", () => {
  it("is registered as a kind that is bought, not staked, with a noun of its own", () => {
    expect(getKind("scratch")).toBe(SCRATCH);
    expect(SCRATCH.table).toBeUndefined();
    expect(SCRATCH.chat.conditional).toBeUndefined();
  });

  it("reads the prize list merged by prize and best first, leaving out empty rows, items at no rarity and a bonus with no bonus spot", () => {
    const game = { layout: "lucky", bonus: { on: true, gp: 25 }, roll: { prizes: [{ count: 5, gp: 10 }, { count: 2, gp: "100" }, { count: 3, gp: 10 }, { count: 1, item: { rarity: "rare" } }, { count: 1, item: { rarity: "mythic" } }, { count: 0, gp: 50 }, { count: 2, bonus: true }, { count: 1, item: { rarity: "legendary" } }, { count: 4, gp: 0 }] } };
    expect(prizesOf(game).map(p => `${p.key}x${p.count}`)).toEqual(["item.legendaryx1", "item.rarex1", "gp.100x2", "gp.10x8", "bonusx2"]);
    expect(prizesOf({ ...game, bonus: { on: false, gp: 25 } }).some(p => p.kind === "bonus")).toBe(false);
    expect(prizesOf({ ...game, layout: "match3" }).some(p => p.kind === "bonus")).toBe(false);
    // Past eight rows the rest are left out.
    expect(prizesOf({ roll: { prizes: Array.from({ length: 10 }, (_, i) => ({ count: 1, gp: i + 1 })) } })).toHaveLength(8);
  });

  it("prints the roll at its size, or at its prizes when they need more tickets; the duds are the rest", () => {
    expect(rollOf(GAME)).toMatchObject({ id: 1, size: 100, duds: 57 });
    expect(rollOf({ roll: { id: 3, size: 4, prizes: [{ count: 6, gp: 1 }] } })).toMatchObject({ id: 3, size: 6, duds: 0 });
    expect(rollOf({})).toMatchObject({ id: 1, size: 0, duds: 0, prizes: [] });
  });

  it("keeps the grid in its layout's limits, never under three panels, and the bonus spot to lucky numbers with a prize", () => {
    expect(gridOf({})).toEqual({ cols: 4, rows: 3 });
    expect(gridOf({ layout: "match3" })).toEqual({ cols: 3, rows: 2 });
    expect(gridOf({ layout: "lucky", grid: { cols: 99, rows: 0 } })).toEqual({ cols: 6, rows: 1 });
    expect(gridOf({ layout: "match3", grid: { cols: 9, rows: 9 } })).toEqual({ cols: 5, rows: 4 });
    expect(gridOf({ layout: "lucky", grid: { cols: 2, rows: 1 } })).toEqual({ cols: 2, rows: 2 });
    expect(layoutOf({ layout: "slots" })).toBe("lucky");
    expect(bonusOf({ layout: "lucky", bonus: { on: true, gp: 25 } })).toEqual({ on: true, gp: 25 });
    expect(bonusOf({ layout: "lucky", bonus: { on: true, gp: 0 } }).on).toBe(false);
    expect(bonusOf({ layout: "match3", bonus: { on: true, gp: 25 } }).on).toBe(false);
  });

  it("starts a New as the mockup's Fortune Ticket, and a Print a new roll moves to the next roll with the same prizes", () => {
    const d = NEW_DEFAULTS.scratch();
    expect(d).toMatchObject({ kind: "scratch", name: "New scratch ticket", price: 5, layout: "lucky", grid: { cols: 4, rows: 3 }, bonus: { on: true, gp: 25 }, roll: { id: 1, size: 100 } });
    expect(d.roll.prizes).toEqual(SCRATCH_DEFAULTS.prizes);
    expect(d.roll.prizes).not.toBe(SCRATCH_DEFAULTS.prizes);
    expect(nextRoll(GAME)).toEqual({ ...GAME.roll, id: 2 });
    expect(copyOf({ ...GAME, roll: { ...GAME.roll, id: 4 } }, { id: "x" }).roll.id).toBe(1);
  });
});

describe("the ledger, from the log", () => {
  it("counts the tickets sold as the unrefunded rows of this roll at this game, and what is left of each prize", () => {
    const log = [row({ tier: "gp.100" }), row({ tier: "gp.5" }), row({ tier: "dud" }), row({ tier: "gp.100", refunded: 9 }), row({ tier: "gp.100", rollId: 2 }), row({ tier: "gp.100", boxId: "other" }), row({ tier: "gp.100", kind: "deck" })];
    expect(ticketsSold(log, { boxId: "fortune", rollId: 1 })).toBe(3);
    const st = rollState(GAME, log);
    expect(st).toMatchObject({ id: 1, size: 100, sold: 3, left: 97, soldOut: false, duds: { count: 57, left: 56 } });
    expect(Object.fromEntries(st.prizes.map(p => [p.key, `${p.left}/${p.count}`]))).toEqual({ "item.rare": "1/1", "gp.100": "1/2", "gp.25": "5/5", "gp.10": "12/12", "gp.5": "19/20", bonus: "3/3" });
    // The next roll starts whole; the old roll's rows stay where they are.
    expect(rollState({ ...GAME, roll: nextRoll(GAME) }, log)).toMatchObject({ id: 2, sold: 1, left: 99 });
  });

  it("is sold out when every ticket is sold, and a refund puts a ticket back by itself", () => {
    const sold = Array.from({ length: 6 }, (_, i) => row({ boxId: "small", tier: ["item.rare", "gp.10", "gp.10", "bonus", "dud", "dud"][i] }));
    expect(rollState(SMALL, sold)).toMatchObject({ sold: 6, left: 0, soldOut: true });
    expect(rollReason(SMALL, POOLS, sold)).toBe("Sold out");
    sold[1].refunded = 5;
    const back = rollState(SMALL, sold);
    expect(back).toMatchObject({ sold: 5, left: 1, soldOut: false });
    expect(back.prizes.find(p => p.key === "gp.10").left).toBe(1);
    expect(drawBag(SMALL, POOLS, sold).bag.map(b => `${b.key}:${b.weight}`)).toEqual(["gp.10:1"]);
  });

  it("leaves an item prize the pools can't give in the roll, undrawn, and says why when nothing else is left", () => {
    const noRare = { p: { ...POOLS.p, entries: [POOLS.p.entries[0]] } };
    const { bag, blocked } = drawBag(SMALL, noRare, []);
    expect(bag.map(b => b.key)).toEqual(["gp.10", "bonus", "dud"]);
    expect(blocked).toBe(1);
    const allButRare = ["gp.10", "gp.10", "bonus", "dud", "dud"].map(tier => row({ boxId: "small", tier }));
    expect(rollReason(SMALL, noRare, allButRare)).toBe("The prizes left need items the pools don't hold");
    expect(rollReason(SMALL, POOLS, allButRare)).toBe("");
  });
});

describe("the draw without replacement, through performPull", () => {
  // One whole roll, one Buy at a time, each row as the socket path writes it.
  async function buyAll(game, seed) {
    const rng = seededRng(seed);
    const actor = actorOf({ gp: 10000 });
    const log = [];
    const outs = [];
    for (let i = 0; i < rollOf(game).size; i++) {
      const out = await performPull({ box: game, pools: POOLS, actor, rng, log });
      outs.push(out);
      log.unshift({ id: `r${i}`, kind: "scratch", boxId: game.id, actorId: actor.id, ...SCRATCH.logRow({ game, state: {}, out }) });
    }
    return { outs, log, actor };
  }

  it("deals every prize of a whole roll exactly its count of times, then refuses the next Buy as sold out before anything is charged", async () => {
    for (const [game, seed] of [[GAME, 1], [GAME, 2], [MATCH3, 3], [SMALL, 4]]) {
      const { outs, log, actor } = await buyAll(game, seed);
      const roll = rollOf(game);
      const counts = {};
      for (const r of log) counts[r.tier] = (counts[r.tier] ?? 0) + 1;
      expect(counts).toEqual({ ...Object.fromEntries(roll.prizes.map(p => [p.key, p.count])), ...(roll.duds ? { dud: roll.duds } : {}) });
      // The ticket numbers run 1 to the size, each the roll's.
      expect(outs.map(o => o.ticket.no)).toEqual(Array.from({ length: roll.size }, (_, i) => i + 1));
      const paid = outs.reduce((n, o) => n + o.payoutCp, 0);
      expect(paid).toBe(roll.prizes.filter(p => p.kind !== "item").reduce((n, p) => n + p.gp * p.count * 100, 0));
      expect(outs.filter(o => o.itemId).length).toBe(roll.prizes.filter(p => p.kind === "item").reduce((n, p) => n + p.count, 0));
      const writes = actor.writes.length;
      await expect(performPull({ box: game, pools: POOLS, actor, rng: seededRng(9), log })).rejects.toThrow(`${game.name} is sold out. Ask the GM to print a new roll.`);
      expect(actor.writes).toHaveLength(writes);
    }
  });

  it("pays coins through the one settle, grants one item at the prize's rarity, and gives nothing on a dud", async () => {
    const { outs, actor } = await buyAll(SMALL, 7);
    const item = outs.find(o => o.outcome === "item");
    expect(item.result).toMatchObject({ name: "Flame Tongue", rarity: "rare", pity: false });
    expect(actor.items.get(item.itemId).flags["loot-crates"]).toMatchObject({ boxId: "small", sourceUuid: "Item.b" });
    expect(actor.items.size).toBe(1);
    expect(item.payoutCp).toBe(0);
    const bonus = outs.find(o => o.ticket.tier === "bonus");
    expect(bonus).toMatchObject({ outcome: "coins", payoutCp: 2500, result: { name: "25 gp", outcome: "coins" }, itemId: null });
    const dud = outs.find(o => o.outcome === "nothing");
    expect(dud).toMatchObject({ result: null, payoutCp: 0, itemId: null });
    // The roll keeps no per-buyer state: nothing is written for one.
    expect(outs.every(o => o.state === undefined)).toBe(true);
  });

  it("refuses a roll whose last tickets need items the pools don't hold, before anything is charged", async () => {
    const actor = actorOf();
    const log = ["gp.10", "gp.10", "bonus", "dud", "dud"].map(tier => row({ boxId: "small", tier }));
    await expect(performPull({ box: { ...SMALL, pools: [] }, pools: POOLS, actor, rng: seededRng(1), log })).rejects.toThrow("Small Ticket's last tickets need items its pools don't hold. Tell the GM.");
    expect(actor.writes).toHaveLength(0);
  });
});

describe("the honest card", () => {
  const COIN_ROLL = { roll: { size: 100, prizes: [{ count: 2, gp: 100 }, { count: 5, gp: 25 }, { count: 12, gp: 10 }, { count: 20, gp: 5 }, { count: 10, gp: 15 }, { count: 3, bonus: true }, { count: 1, item: { rarity: "rare" } }] } };
  const wins = [{ kind: "dud" }, { kind: "gp", gp: 5 }, { kind: "gp", gp: 10 }, { kind: "gp", gp: 15 }, { kind: "gp", gp: 25 }, { kind: "gp", gp: 100 }, { kind: "bonus" }, { kind: "item", rarity: "rare", name: "Flame Tongue", img: "b.webp" }];
  const decidedCp = (game, w) => (w.kind === "gp" ? Math.round(w.gp * 100) : w.kind === "bonus" ? Math.round(bonusOf(game).gp * 100) : 0);

  it("lucky numbers, thousands of seeded tickets: the wins read back from the layout are the decided ones, and the lottery's rules hold", () => {
    let splits = 0;
    for (let seed = 1; seed <= 3000; seed++) {
      const rng = seededRng(seed);
      const grid = [{ cols: 4, rows: 3 }, { cols: 3, rows: 3 }, { cols: 6, rows: 5 }, { cols: 2, rows: 2 }][seed % 4];
      const game = { ...COIN_ROLL, price: 5, layout: "lucky", grid, bonus: { on: seed % 3 !== 0, gp: 25 } };
      const w = wins[seed % wins.length].kind === "bonus" && !bonusOf(game).on ? { kind: "dud" } : wins[seed % wins.length];
      const card = layCard(game, w, rng);
      const read = cardWins(card);
      const cells = grid.cols * grid.rows;
      expect(card.panels).toHaveLength(cells);
      expect(card.lucky).toHaveLength(luckyCount(cells));
      expect(read.cp).toBe(decidedCp(game, w));
      expect(read.item ? read.item.item : null).toBe(w.kind === "item" ? w.rarity : null);
      // Your numbers are never two the same, and the lucky numbers neither.
      expect(new Set(card.panels.map(p => p.n)).size).toBe(cells);
      expect(new Set(card.lucky).size).toBe(card.lucky.length);
      // A number matches only where a win was decided: none on a dud or a bonus ticket.
      if (w.kind === "dud" || w.kind === "bonus") expect(read.winners).toEqual([]);
      if (w.kind === "item") expect(read.winners).toHaveLength(1);
      if (w.kind === "gp") {
        expect([1, 2]).toContain(read.winners.length);
        if (read.winners.length === 2) splits++;
        // Each winning panel's prize is one of the roll's own coin prizes.
        for (const i of read.winners) expect([100, 25, 10, 5, 15]).toContain(card.panels[i].prize.gp);
      }
      // The bonus mark only on a bonus ticket; no spot without a bonus spot.
      expect(card.bonus ? card.bonus.win : false).toBe(w.kind === "bonus");
      if (!bonusOf(game).on) expect(card.bonus).toBeNull();
      // A losing panel shows one of the roll's prizes, never a match.
      for (const [i, p] of card.panels.entries()) if (!read.winners.includes(i)) { expect(card.lucky).not.toContain(p.n); expect(p.prize.gp ?? p.prize.item).toBeTruthy(); }
    }
    // Wins add up: a coin prize is sometimes split across two panels.
    expect(splits).toBeGreaterThan(50);
  });

  it("match 3, thousands of seeded tickets: three the same only where a win was decided, every other symbol at most twice", () => {
    const game0 = { price: 1, layout: "match3", roll: { size: 50, prizes: [{ count: 1, item: { rarity: "uncommon" } }, { count: 4, gp: 5 }, { count: 6, gp: 3 }, { count: 10, gp: 2 }, { count: 10, gp: 1 }] } };
    const m3wins = [{ kind: "dud" }, { kind: "gp", gp: 1 }, { kind: "gp", gp: 2 }, { kind: "gp", gp: 3 }, { kind: "gp", gp: 5 }, { kind: "item", rarity: "uncommon", name: "Lucky Coin" }];
    let splits = 0;
    for (let seed = 1; seed <= 3000; seed++) {
      const rng = seededRng(seed);
      const grid = [{ cols: 3, rows: 2 }, { cols: 3, rows: 1 }, { cols: 4, rows: 3 }, { cols: 5, rows: 4 }][seed % 4];
      const game = { ...game0, grid };
      const w = m3wins[seed % m3wins.length];
      const card = layCard(game, w, rng);
      const read = cardWins(card);
      expect(card.panels).toHaveLength(grid.cols * grid.rows);
      expect(card.key.map(k => k.symbol)).toEqual(SYMBOLS.slice(0, 5));
      expect(read.cp).toBe(decidedCp(game, w));
      expect(read.item ? read.item.item : null).toBe(w.kind === "item" ? w.rarity : null);
      const counts = new Map();
      for (const p of card.panels) counts.set(p.symbol, (counts.get(p.symbol) ?? 0) + 1);
      const triples = [...counts].filter(([, n]) => n >= 3);
      if (w.kind === "dud") expect(triples).toEqual([]);
      else {
        // Exactly three of each winning symbol, never four.
        expect(triples.length === 1 || triples.length === 2).toBe(true);
        for (const [, n] of triples) expect(n).toBe(3);
        if (triples.length === 2) splits++;
      }
      for (const [s, n] of counts) if (!triples.some(([t]) => t === s)) expect(n).toBeLessThanOrEqual(2);
    }
    expect(splits).toBeGreaterThan(20);
  });

  it("splits a coin prize only into amounts the roll itself pays", () => {
    expect(splitsOf(25, [100, 25, 10, 5, 15])).toEqual([[15, 10]]);
    expect(splitsOf(10, [10, 5])).toEqual([[5, 5]]);
    expect(splitsOf(5, [5, 1])).toEqual([]);
  });

  it("dresses a dud on a roll with no prizes in amounts of the ticket's price, never a match", () => {
    const card = layCard({ price: 2, layout: "lucky", roll: { size: 10, prizes: [] } }, { kind: "dud" }, seededRng(3));
    expect(cardWins(card)).toEqual({ cp: 0, items: [], item: null, winners: [], bonus: false });
    for (const p of card.panels) expect([2, 4, 10]).toContain(p.prize.gp);
  });
});

describe("the readout", () => {
  it("says the odds of the roll as printed: 1 in N wins, the top prize 1 in M, all prizes X or more", () => {
    const roll = rollOf(GAME);
    expect(oddsText(rollOdds(roll.prizes, roll.size, GAME.price))).toBe("1 in 2.3 tickets wins, the top prize (Rare item) 1 in 100, all prizes 5 gp or more");
    expect(oddsText(rollOdds(rollOf(MATCH3).prizes, 50, 1))).toBe("1 in 3.3 tickets wins, the top prize (Uncommon item) 1 in 50, all prizes 1 gp or more");
    // A prize under the ticket's price: no guarantee to make.
    expect(oddsText(rollOdds(prizesOf({ roll: { prizes: [{ count: 10, gp: 1 }, { count: 1, gp: 50 }] } }), 44, 2))).toBe("1 in 4 tickets wins, the top prize (50 gp) 1 in 44");
    expect(oddsText(rollOdds([], 10, 1))).toBe("Every ticket is a dud");
    expect(oddsText(rollOdds([], 0, 1))).toBe("No tickets printed");
    expect(oneIn(100, 43)).toBe("2.3");
    expect(oneIn(100, 24)).toBe("4.2");
    expect(oneIn(100, 1)).toBe("100");
    expect(oneIn(10, 0)).toBeNull();
  });

  it("says what the editor's draft would print, and what would keep a ticket from being sold", () => {
    const values = { price: "5 gp", layout: "lucky", cols: "4", rows: "3", bonusOn: false, bonusGp: "25", size: "10", prizes: ["a", "b", "c"], "z.a.count": "1", "z.a.what": "item.legendary", "z.b.count": "12", "z.b.what": "gp", "z.b.gp": "5", "z.c.count": "2", "z.c.what": "bonus", "pool.p": true, "share.p": "1" };
    const draft = draftScratch(GAME, values, ["p"]);
    expect(draft).toMatchObject({ kind: "scratch", price: 5, layout: "lucky", grid: { cols: 4, rows: 3 }, bonus: { on: false, gp: 25 }, theme: "hoard", roll: { id: 1, size: 10, prizes: [{ count: 1, parts: [{ item: { rarity: "legendary" } }] }, { count: 12, parts: [{ gp: 5 }] }, { count: 2, parts: [{ bonus: true }] }] } });
    const preview = scratchPreview(draft, POOLS);
    expect(preview.notes.map(n => n.text)).toEqual([
      "The prizes need 13 tickets, more than 10: the roll is printed at 13.",
      "The ticked pools hold no Legendary item: those tickets wait in the roll until they do.",
      "The bonus spot is off, so its tickets are left out of the roll.",
    ]);
    const html = scratchPreviewHTML(preview, esc);
    expect(html).toContain("1 in 1 tickets wins, the top prize (Legendary item) 1 in 13, all prizes 5 gp or more");
    expect(html).toContain("0 duds of 13 tickets");
    expect(scratchPreview({ ...draft, pools: [] }, POOLS).notes.map(n => n.text)).toContain("Tick a pool for the item prizes, or those tickets can't be sold.");
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
const buyOnce = async (world, seed, { requestId = "s1", boxId = "small", price = 5 } = {}) => {
  globalThis.CONFIG = { Dice: { randomUniform: seededRng(seed) } };
  try { await world.deliver({ type: "pull", requestId, boxId, actorId: "a1", userId: "p1", price }); } finally { delete globalThis.CONFIG; }
};

describe("the GM's socket path and the one refund", () => {
  it("broadcasts the card and the ticket, writes the roll's row, posts a sealed card for every ticket, and a refund puts the ticket back", async () => {
    const world = makeWorld();
    await world.game.settings.set("loot-crates", "boxes", { small: SMALL });
    await world.game.settings.set("loot-crates", "pools", POOLS);
    for (let i = 0; i < 6; i++) await buyOnce(world, 10 + i, { requestId: `s${i}` });
    const reveals = world.emitted.filter(m => m.type === "reveal");
    expect(reveals).toHaveLength(6);
    for (const k of ["grant", "state", "pools"]) expect(reveals[0]).not.toHaveProperty(k);
    expect(reveals[0]).toMatchObject({ kind: "scratch", box: { id: "small", price: 5 }, ticket: { rollId: 1, no: 1, size: 6 }, stateBefore: { scratch: { rollId: 1, size: 6, left: 6, prizes: { "item.rare": 1, "gp.10": 2, bonus: 1 } } } });
    expect(reveals[5].ticket.no).toBe(6);
    // Each reveal's card wins exactly what its row says it paid.
    const log = getLog();
    for (const r of reveals) {
      const row = log.find(l => l.id === r.logId);
      expect(cardWins(r.card).cp).toBe(row.payoutCp);
      expect(row.winners).toEqual(cardWins(r.card).winners);
      expect(row).toMatchObject({ kind: "scratch", rollId: 1, ticketNo: r.ticket.no, tier: r.ticket.tier });
    }
    expect(log.filter(r => r.tier === "dud").every(r => r.outcome === "nothing" && r.name === "A dud")).toBe(true);
    expect(log.find(r => r.tier === "gp.10")).toMatchObject({ outcome: "coins", swatch: "coin", name: "10 gp", payoutCp: 1000 });
    expect(log.find(r => r.tier === "item.rare")).toMatchObject({ name: "Flame Tongue", uuid: "Item.b", rarity: "rare" });
    // Every ticket posts a card, a dud too.
    expect(globalThis.ChatMessage.create).toHaveBeenCalledTimes(6);
    expect(rollState(SMALL, getLog())).toMatchObject({ sold: 6, soldOut: true });
    // The seventh Buy is refused as sold out, nothing charged.
    const purse = toCopper(world.actor.system.currency);
    await buyOnce(world, 99, { requestId: "s7" });
    expect(world.emitted.find(m => m.type === "error" && m.requestId === "s7")).toMatchObject({ message: "Small Ticket is sold out. Ask the GM to print a new roll." });
    expect(toCopper(world.actor.system.currency)).toBe(purse);
    // A refund of a coin ticket: the stake back less what it paid, and the ticket and its prize back in the roll.
    const coin = getLog().find(r => r.tier === "gp.10");
    world.actor.system.currency = { pp: 0, gp: 500, ep: 0, sp: 0, cp: 0 };
    expect((await refundPull(coin.id)).status).toBe("refunded");
    expect(toCopper(world.actor.system.currency)).toBe(50000 + 500 - 1000);
    const back = rollState(SMALL, getLog());
    expect(back).toMatchObject({ sold: 5, left: 1, soldOut: false });
    expect(back.prizes.find(p => p.key === "gp.10").left).toBe(1);
    // An item ticket's refund removes the item it granted.
    const item = getLog().find(r => r.tier === "item.rare");
    const out = await refundPull(item.id);
    expect(out).toMatchObject({ status: "refunded", removedItem: "Flame Tongue" });
    expect(rollState(SMALL, getLog()).prizes.find(p => p.key === "item.rare").left).toBe(1);
  });

  it("chat: the small card with the winning panels marked and what it paid, inside the block the core seals", async () => {
    const world = makeWorld();
    await world.game.settings.set("loot-crates", "boxes", { small: SMALL });
    await world.game.settings.set("loot-crates", "pools", POOLS);
    for (let i = 0; i < 6; i++) await buyOnce(world, 30 + i, { requestId: `s${i}` });
    const cards = globalThis.ChatMessage.create.mock.calls.map(c => c[0].content);
    const reveals = world.emitted.filter(m => m.type === "reveal");
    for (const [i, html] of cards.entries()) {
      expect(html).toContain("Tam scratched <strong>Small Ticket</strong> <span class=\"lc-chat__price\">5 gp</span>");
      expect(html.indexOf("lc-chat__item")).toBeLessThan(html.indexOf("lc-scratch__mini"));
      void i;
    }
    const byTier = tier => cards[reveals.findIndex(r => r.ticket.tier === tier)];
    expect(byTier("dud")).toContain(`<div class="lc-chat__name">A dud</div>`);
    expect(byTier("dud")).toContain("A dud. Nothing this time.");
    expect(byTier("dud")).toContain("lc-rarity-none");
    expect(byTier("gp.10")).toContain(`<div class="lc-chat__name">10 gp</div>`);
    expect(byTier("gp.10")).toMatch(/Won 10 gp( across 2 panels)?/);
    expect(byTier("bonus")).toContain("Won 25 gp");
    expect(byTier("item.rare")).toContain("lc-rarity-rare");
    expect(byTier("item.rare")).toContain("<div class=\"lc-chat__rarity\">Rare</div>");
    // The mini card marks exactly the winning panels.
    const coinReveal = reveals.find(r => r.ticket.tier === "gp.10");
    const marked = (byTier("gp.10").match(/lc-scratch__mini--win/g) ?? []).length;
    expect(marked).toBe(cardWins(coinReveal.card).winners.length);
  });
});

describe("the words", () => {
  const reveal = (over = {}) => ({ kind: "scratch", actorName: "Tam", actorId: "a1", userId: "p1", box: { id: "fortune", name: "Fortune Ticket", price: 5 }, purse: { gp: 95 }, ticket: { rollId: 1, no: 44, size: 100 }, ...over });

  it("gotText: won 25 gp, won the item, scratched a dud", () => {
    expect(gotText(SCRATCH, { outcome: "coins", payoutCp: 2500, result: { name: "25 gp" } })).toBe("won 25 gp");
    expect(gotText(SCRATCH, { outcome: "item", result: { name: "Sling +2" } })).toBe("won Sling +2");
    expect(gotText(SCRATCH, { outcome: "nothing", result: null })).toBe("scratched a dud");
  });

  it("the window: its head, the card open, the result and the sting by outcome", () => {
    const k = SCRATCH.reveal;
    expect(k.title).toBe("A scratch ticket");
    expect(k.head(reveal(), { esc })).toBe(`<span class="lc-reveal__who">Tam</span> scratches <strong class="lc-reveal__crate">Fortune Ticket</strong> <span class="lc-reveal__price">5 gp</span>`);
    const card = layCard(GAME, { kind: "gp", gp: 25 }, seededRng(4));
    const coins = reveal({ card, outcome: "coins", payoutCp: 2500, result: { name: "25 gp", outcome: "coins" } });
    expect(k.result(coins, { esc, canSee: true })).toContain("25 gp into Tam's purse");
    expect(k.result(coins, { esc, canSee: false })).toContain("56 of 100 tickets left");
    // On a match 3 card the three panels of a symbol are one win, so the
    // line never says "across 3 panels"; two symbols matched are two matches.
    const key = [{ symbol: "crown", prize: { gp: 5 } }, { symbol: "gem", prize: { gp: 1 } }];
    const three = { layout: "match3", cols: 3, rows: 2, key, panels: ["crown", "gem", "crown", "horn", "crown", "gem"].map(symbol => ({ symbol })) };
    const six = { layout: "match3", cols: 3, rows: 2, key, panels: ["crown", "gem", "crown", "gem", "crown", "gem"].map(symbol => ({ symbol })) };
    expect(k.result(reveal({ card: three, outcome: "coins", payoutCp: 500, result: { name: "5 gp", outcome: "coins" } }), { esc })).toContain(`<div class="lc-reveal__quiet">Won 5 gp</div>`);
    expect(k.result(reveal({ card: six, outcome: "coins", payoutCp: 600, result: { name: "6 gp", outcome: "coins" } }), { esc })).toContain(`<div class="lc-reveal__quiet">Won 6 gp from 2 matches</div>`);
    const split = layCard(GAME, { kind: "gp", gp: 10 }, seededRng(2));
    const n = cardWins(split).winners.length;
    expect(k.result(reveal({ card: split, outcome: "coins", payoutCp: 1000, result: { name: "10 gp", outcome: "coins" } }), { esc })).toContain(n > 1 ? `Won 10 gp across ${n} panels` : `<div class="lc-reveal__quiet">Won 10 gp</div>`);
    expect(k.result(reveal({ card: layCard(GAME, { kind: "dud" }, seededRng(4)), outcome: "nothing", result: null }), { esc })).toContain("A dud. Nothing this time.");
    const html = ticketHTML({ ...coins, box: { name: "Fortune Ticket" } }, { esc });
    expect(html).toContain("Roll 1, ticket 44 of 100");
    expect((html.match(/lc-scratch__panel--win/g) ?? []).length).toBe(cardWins(card).winners.length);
    expect(html).toContain('<div class="lc-scratch__extra">Extra 25 gp</div><p>Reveal the gem to win it on top of the card.</p>');
    expect(miniHTML(card).match(/<i/g)).toHaveLength(12);
    // A coin win's four rising notes (the rarity sting at Rare), a dud's two falling ones.
    k.sting(coins); expect(sound.playReveal).toHaveBeenLastCalledWith("rare");
    k.sting(reveal({ outcome: "nothing", result: null })); expect(sound.playPlop).toHaveBeenCalledTimes(1);
    expect(sound.playCoinBack).not.toHaveBeenCalled();
    expect(sound.playPlink).not.toHaveBeenCalled();
    k.sting(reveal({ outcome: "item", result: { name: "Flame Tongue", rarity: "rare" } })); expect(sound.playReveal).toHaveBeenCalledWith("rare");
    expect(k.notice(reveal({ outcome: "nothing", result: null }))).toBe("Fortune Ticket: a dud.");
    expect(k.notice(coins)).toBeNull();
    // Watch again replays the scratch (test/scratchplay.test.js plays it).
    expect(k.replayable).toBe(true);
  });

  it("Another ticket for 5 gp while the roll has tickets, off with the reason when it is sold out or the purse is short", () => {
    const again = SCRATCH.reveal.again;
    expect(again(reveal(), { game: GAME, log: [], purse: { gp: 50 } })).toEqual({ price: 5, label: "Another ticket for 5 gp", off: "" });
    expect(again(reveal(), { game: GAME, log: [], purse: { gp: 2 } }).off).toBe("Needs 3 gp more");
    // The last ticket of the roll, before the log has caught up.
    expect(again(reveal({ ticket: { rollId: 1, no: 100, size: 100 } }), { game: GAME, log: [], purse: { gp: 50 } }).off).toBe("Sold out");
    expect(again(reveal(), { game: GAME, log: [], purse: { gp: 50 }, open: false, gmOnline: true }).off).toBe("The GM has closed the shop.");
    expect(again(reveal({ replay: true }), { game: GAME })).toBeNull();
    expect(again(reveal(), { game: null })).toBeNull();
  });

  it("the shop card: the price, the tickets and each prize left, the odds of what is left and the guarantee; struck through when gone", () => {
    const log = [row({ tier: "gp.100" }), row({ tier: "gp.100" }), row({ tier: "dud" })];
    const ctx = { esc, purse: { gp: 50 }, hasActor: true, actorId: "a1", log, open: true, gmOnline: true };
    const html = SCRATCH.shop.card(GAME, POOLS, ctx);
    expect(html).toContain("97 of 100 tickets left");
    expect(html).toContain("<span class=\"lc-sr-only\">Fortune Ticket: </span>Buy a ticket for 5 gp");
    expect(html).toContain("<s>100 gp</s>");
    expect(html).toContain("0 of 2");
    expect(html).toContain("Rare item");
    expect(html).toContain("1 in 2.4 tickets wins, the top prize (Rare item) 1 in 97, all prizes 5 gp or more");
    expect(html).toContain("lc-rarity-rare");
    expect(html).not.toContain("aria-disabled");
    expect(SCRATCH.shop.reason(GAME, POOLS, ctx)).toBe("");
    expect(prizeListHTML(rollState(GAME, log), esc).match(/<li class="lc-scratch__tier/g)).toHaveLength(6);
  });

  it("the shop card sold out: Sold out under an off Buy, the roll said sold out, no odds", () => {
    const log = Array.from({ length: 6 }, (_, i) => row({ boxId: "small", tier: ["item.rare", "gp.10", "gp.10", "bonus", "dud", "dud"][i] }));
    const ctx = { esc, purse: { gp: 50 }, hasActor: true, actorId: "a1", log, open: true, gmOnline: true };
    const html = SCRATCH.shop.card(SMALL, POOLS, ctx);
    expect(html).toContain("Roll 1 is sold out");
    expect(html).toContain(`<div class="lc-box__why" id="lc-why-small">Sold out</div>`);
    expect(html).toContain(`aria-disabled="true"`);
    expect(html).not.toContain("tickets wins");
    expect(SCRATCH.shop.reason(SMALL, POOLS, ctx)).toBe("Sold out");
  });

  it("holds the counts from before a ticket still being opened here, whoever bought it, and the buyer's Buy says Still scratching", () => {
    const log = [row({ tier: "item.rare" })];
    const before = { rollId: 1, size: 100, left: 100, prizes: { "item.rare": 1, "gp.100": 2 } };
    expect(shownState(GAME, { log }).prizes[0].left).toBe(0);
    const spectator = shownState(GAME, { log, heldBefore: () => ({ scratch: before }) });
    expect(spectator.prizes[0].left).toBe(1);
    expect(spectator.left).toBe(100);
    // A hold from an older roll is no hold.
    expect(shownState({ ...GAME, roll: nextRoll(GAME) }, { log, heldBefore: () => ({ scratch: before }) }).left).toBe(100);
    const buyer = { esc, log, purse: { gp: 50 }, hasActor: true, actorId: "a1", held: () => true, stateOf: () => ({ scratch: before }) };
    const html = SCRATCH.shop.card(GAME, POOLS, buyer);
    expect(html).toContain("Still scratching");
    expect(html).toContain("1 of 1");
  });

  it("the Boxes row: each prize left of its count, the layout and the roll, and Print a new roll", () => {
    const log = [row({ tier: "gp.100" })];
    expect(scratchRulesText(GAME, log)).toBe("Lucky numbers 4 × 3, bonus 25 gp, Roll 1: 99 of 100 tickets left");
    expect(scratchRulesText(MATCH3, [])).toBe("Match 3 3 × 2, Roll 1: 50 of 50 tickets left");
    expect(scratchOddsHTML(GAME, log)).toContain(`<span class="lc-odd lc-rarity-coin">100 gp 1/2</span>`);
    // An item or bonus prize's pill wraps inside itself, so the table never widens past where its rows stack.
    expect(scratchOddsHTML(GAME, log)).toContain(`<span class="lc-odd lc-odd--wrap lc-rarity-rare">Rare item 1/1</span>`);
    expect(scratchOddsHTML(GAME, log)).toContain(`<span class="lc-odd lc-odd--wrap lc-rarity-coin">Bonus, 25 gp 3/3</span>`);
    const html = boxesTableHTML({ boxes: [GAME], pools: POOLS, log, esc });
    expect(html).toContain(`data-action="printRoll" data-box="fortune" aria-label="Print a new roll of Fortune Ticket">Print a new roll</button>`);
    expect(html).toContain(`<span class="lc-kind">Scratch</span>`);
    expect(html).toContain(`aria-label="Ticket price at Fortune Ticket"`);
    expect(ticketsLeftText(1, 1)).toBe("1 of 1 ticket left");
    expect(prizeText({ kind: "bonus", gp: 25 })).toBe("Bonus, 25 gp");
    expect(RARITIES.every(r => prizeText({ kind: "item", rarity: r }).endsWith(" item"))).toBe(true);
  });
});

/*
  Prize lines (round 28, B2): a ticket wins one line of the printed roll,
  and a line can pay several parts at once, as real games print "$25 +
  $10" or "$50 + bonus": an item and coins and the gem, or two items. The
  draw stays one line per ticket, so a ticket that pays twice is exactly
  as rare as the GM printed it.
*/
describe("prize lines: tickets that pay like real ones", () => {
  // A roll of 6: one "Rare item + 5 gp + the gem (10 gp)", one "Rare item
  // + Uncommon item", two of 10 gp, two duds.
  const LINES = { ...GAME, id: "lines", name: "Lines Ticket", bonus: { on: true, gp: 10 }, roll: { id: 1, size: 6, prizes: [
    { count: 1, parts: [{ gp: 5 }, { item: { rarity: "rare" } }, { bonus: true }] },
    { count: 1, parts: [{ item: { rarity: "uncommon" } }, { item: { rarity: "rare" } }] },
    { count: 2, gp: 10 },
  ] } };
  const COMBO = "item.rare+gp.5+bonus", PAIR = "item.rare+item.uncommon";
  // An actor that creates every item of one creation, as Foundry does.
  const actorMany = (currency = { pp: 0, gp: 100, ep: 0, sp: 0, cp: 0 }) => {
    const actor = actorOf(currency);
    actor.creations = [];
    actor.createEmbeddedDocuments = async (_type, datas) => {
      await tick();
      actor.creations.push(datas.length);
      return datas.map(data => {
        const id = `item${actor.items.size + 1}`;
        const item = { id, name: data.name, flags: data.flags, async delete() { await tick(); actor.items.delete(id); } };
        actor.items.set(id, item);
        return item;
      });
    };
    actor.deleteEmbeddedDocuments = async (_type, ids) => { await tick(); for (const id of ids) actor.items.delete(id); };
    return actor;
  };

  it("reads a row from before lines as a line of its one part, keeping its key, and never writes it back", () => {
    const legacy = { layout: "lucky", bonus: { on: true, gp: 25 }, roll: { id: 1, size: 10, prizes: [{ count: 2, gp: 10 }, { count: 1, item: { rarity: "rare" } }, { count: 3, bonus: true }] } };
    const before = structuredClone(legacy);
    expect(rowParts({ count: 2, gp: 10 })).toEqual([{ gp: 10 }]);
    expect(rowParts({ count: 1, item: { rarity: "rare" } })).toEqual([{ item: { rarity: "rare" } }]);
    expect(rowParts({ count: 3, bonus: true })).toEqual([{ bonus: true }]);
    const lines = prizesOf(legacy);
    expect(lines.map(l => l.key)).toEqual(["item.rare", "gp.10", "bonus"]);
    expect(lines[1]).toMatchObject({ key: "gp.10", kind: "gp", gp: 10, count: 2, parts: [{ kind: "gp", gp: 10 }], items: [] });
    expect(lines[0]).toMatchObject({ kind: "item", rarity: "rare", items: ["rare"], gp: 0 });
    expect(lines[2]).toMatchObject({ kind: "bonus", gp: 25 });
    // The same rows written as lines read the same.
    expect(prizesOf({ ...legacy, roll: { ...legacy.roll, prizes: [{ count: 2, parts: [{ gp: 10 }] }, { count: 1, parts: [{ item: { rarity: "rare" } }] }, { count: 3, parts: [{ bonus: true }] }] } })).toEqual(lines);
    // Reading changed nothing on the record, and an old row of the log still counts against its line.
    expect(legacy).toEqual(before);
    expect(rollState({ ...legacy, id: "fortune" }, [row({ tier: "gp.10" })]).prizes.find(p => p.key === "gp.10").left).toBe(1);
  });

  it("names a line by its parts best first, merges lines that pay the same, and ranks lines by their best item, then items, then coins", () => {
    const lines = prizesOf(LINES);
    expect(lines.map(l => `${l.key} x${l.count}`)).toEqual([`${PAIR} x1`, `${COMBO} x1`, "gp.10 x2"]);
    expect(lines[1]).toMatchObject({ kind: "line", items: ["rare"], gp: 15, rarity: "rare" });
    expect(lines[0]).toMatchObject({ kind: "line", items: ["rare", "uncommon"], gp: 0 });
    expect(lines.map(prizeText)).toEqual(["Rare item + Uncommon item", "Rare item + 5 gp + the gem (10 gp)", "10 gp"]);
    // The same parts in another order are the same line.
    const twice = { ...LINES, roll: { ...LINES.roll, prizes: [...LINES.roll.prizes, { count: 2, parts: [{ bonus: true }, { item: { rarity: "rare" } }, { gp: 5 }] }] } };
    expect(prizesOf(twice).find(l => l.key === COMBO).count).toBe(3);
    // The gem with the bonus spot off keeps its whole line out; a coin part of nothing is dropped.
    expect(prizesOf({ ...LINES, bonus: { on: false, gp: 10 } }).map(l => l.key)).toEqual([PAIR, "gp.10"]);
    expect(prizesOf({ roll: { prizes: [{ count: 1, parts: [{ gp: 0 }, { item: { rarity: "rare" } }] }] } }).map(l => l.key)).toEqual(["item.rare"]);
    expect(prizesOf({ roll: { prizes: [{ count: 1, parts: [{ gp: 5 }, { item: { rarity: "mythic" } }] }] } })).toEqual([]);
  });

  it("match 3: each part is a three of a kind of its own, so a line of two the same or more sets than the grid holds is left out, and the editor says why with Save off", () => {
    const m3 = { ...MATCH3, roll: { id: 1, size: 20, prizes: [{ count: 1, parts: [{ item: { rarity: "uncommon" } }, { gp: 5 }] }, { count: 1, parts: [{ gp: 5 }, { gp: 5 }] }, { count: 2, parts: [{ gp: 1 }, { gp: 5 }, { gp: 2 }] }, { count: 4, gp: 1 }] } };
    expect(prizesOf(m3).map(l => l.key)).toEqual(["item.uncommon+gp.5", "gp.1"]);
    const preview = scratchPreview(m3, POOLS);
    expect(preview.refused).toBe(true);
    expect(preview.notes.map(n => n.text)).toEqual(expect.arrayContaining([
      "Prize 2 pays two parts the same, which a match 3 card can't tell apart. Make them one part.",
      "Prize 3 needs 3 sets of three, more than a 3 × 2 card has room for. Add panels or take a part off.",
      "Save is off until every prize fits the card.",
    ]));
    // A card with room shows the three-part line; lucky numbers show any line.
    expect(prizesOf({ ...m3, grid: { cols: 3, rows: 3 } }).map(l => l.key)).toContain("gp.5+gp.2+gp.1");
    expect(scratchPreview({ ...m3, layout: "lucky" }, POOLS).refused).toBe(false);
    expect(scratchPreview(MATCH3, POOLS).refused).toBe(false);
    // The key has a symbol for MAX_PRIZES prizes: a line that needs more is left out, and named.
    const many = { ...MATCH3, grid: { cols: 5, rows: 4 }, roll: { id: 1, size: 50, prizes: [{ count: 1, parts: [{ gp: 9 }] }, { count: 1, parts: [{ gp: 1 }, { gp: 2 }, { gp: 3 }, { gp: 4 }] }, { count: 1, parts: [{ gp: 5 }, { gp: 6 }, { gp: 7 }, { gp: 8 }] }] } };
    expect(MAX_PRIZES).toBe(8);
    expect(prizesOf(many).map(l => l.key)).toEqual(["gp.8+gp.7+gp.6+gp.5", "gp.4+gp.3+gp.2+gp.1"]);
    expect(scratchPreview(many, POOLS).notes.map(n => n.text)).toContain("A match 3 card has symbols for 8 different prizes, and prize 1 needs more.");
  });

  it("lucky numbers: a line needs a winning panel a part, so a 3 x 1 card leaves out a line of four and the editor says why with Save off", () => {
    const four = [{ item: { rarity: "rare" } }, { item: { rarity: "uncommon" } }, { gp: 25 }, { gp: 10 }];
    const small = { price: 1, layout: "lucky", grid: { cols: 3, rows: 1 }, bonus: { on: true, gp: 10 }, pools: [{ id: "p" }], roll: { id: 1, size: 10, prizes: [{ count: 1, parts: four }, { count: 1, parts: [{ gp: 5 }, { gp: 5 }, { gp: 5 }, { bonus: true }] }] } };
    // Three paying parts and the gem fit three panels; four paying parts don't.
    expect(prizesOf(small).map(l => l.key)).toEqual(["gp.5+gp.5+gp.5+bonus"]);
    const preview = scratchPreview(small, POOLS);
    expect(preview.refused).toBe(true);
    expect(preview.notes.map(n => n.text)).toEqual(expect.arrayContaining([
      "Prize 1 needs 4 winning panels, more than a 3 × 1 card has. Add panels or take a part off.",
      "Save is off until every prize fits the card.",
    ]));
    // With a panel more the line is printed, and every part reads back from the card.
    const room = { ...small, grid: { cols: 4, rows: 1 } };
    expect(prizesOf(room).map(l => l.key)).toContain("item.rare+item.uncommon+gp.25+gp.10");
    expect(scratchPreview(room, POOLS).refused).toBe(false);
    for (let seed = 1; seed <= 50; seed++) {
      const read = cardWins(layCard(room, { kind: "line", parts: [{ kind: "item", rarity: "rare" }, { kind: "item", rarity: "uncommon" }, { kind: "gp", gp: 25 }, { kind: "gp", gp: 10 }] }, seededRng(seed)));
      expect(read.cp).toBe(3500);
      expect(read.items.map(i => i.item).sort()).toEqual(["rare", "uncommon"]);
    }
  });

  it("thousands of seeded tickets of both layouts: every part of a combination line reads back from the card exactly, and the honesty rules hold", () => {
    const luckyLines = [
      [{ kind: "gp", gp: 5 }, { kind: "item", rarity: "rare", name: "Flame Tongue" }, { kind: "bonus" }],
      [{ kind: "item", rarity: "rare", name: "Flame Tongue" }, { kind: "item", rarity: "uncommon", name: "Lucky Coin" }],
      [{ kind: "gp", gp: 25 }, { kind: "gp", gp: 10 }],
      [{ kind: "gp", gp: 5 }, { kind: "gp", gp: 5 }, { kind: "item", rarity: "rare" }, { kind: "bonus" }],
      [{ kind: "gp", gp: 10 }, { kind: "bonus" }],
    ];
    const game0 = { price: 5, layout: "lucky", bonus: { on: true, gp: 10 }, roll: { size: 100, prizes: [{ count: 1, parts: [{ gp: 5 }, { item: { rarity: "rare" } }, { bonus: true }] }, { count: 5, gp: 25 }, { count: 10, gp: 10 }, { count: 1, item: { rarity: "uncommon" } }] } };
    let shared = 0;
    for (let seed = 1; seed <= 2000; seed++) {
      const rng = seededRng(seed);
      const grid = [{ cols: 4, rows: 3 }, { cols: 3, rows: 3 }, { cols: 6, rows: 5 }, { cols: 2, rows: 2 }][seed % 4];
      const game = { ...game0, grid };
      const parts = luckyLines[seed % luckyLines.length];
      const card = layCard(game, { kind: "line", parts }, rng);
      const read = cardWins(card);
      const cells = grid.cols * grid.rows;
      const shown = parts.filter(p => p.kind !== "bonus");
      expect(read.cp).toBe(parts.reduce((n, p) => n + (p.kind === "gp" ? p.gp * 100 : p.kind === "bonus" ? 1000 : 0), 0));
      expect(read.items.map(i => i.item).sort()).toEqual(shown.filter(p => p.kind === "item").map(p => p.rarity).sort());
      expect(read.winners).toHaveLength(shown.length);
      expect(read.bonus).toBe(parts.some(p => p.kind === "bonus"));
      // Each winning panel shows its own part; an item panel names its item.
      for (const p of shown.filter(q => q.name)) expect(read.items.some(i => i.name === p.name)).toBe(true);
      // Losing panels: never a lucky number, never two the same, never a winner's number.
      const losing = card.panels.filter((_, i) => !read.winners.includes(i)).map(p => p.n);
      expect(new Set(losing).size).toBe(losing.length);
      for (const n of losing) expect(card.lucky).not.toContain(n);
      // Winners each under a lucky number of their own, unless the card has fewer lucky numbers than wins.
      const winNums = read.winners.map(i => card.panels[i].n);
      if (shown.length <= card.lucky.length) expect(new Set(winNums).size).toBe(winNums.length);
      else shared++;
      expect(card.panels).toHaveLength(cells);
    }
    expect(shared).toBeGreaterThan(0);

    const m3game = { price: 1, layout: "match3", roll: { size: 50, prizes: [{ count: 1, parts: [{ item: { rarity: "uncommon" } }, { gp: 5 }] }, { count: 1, parts: [{ gp: 1 }, { gp: 2 }, { gp: 5 }] }, { count: 10, gp: 1 }] } };
    const m3Lines = [[{ kind: "item", rarity: "uncommon", name: "Lucky Coin" }, { kind: "gp", gp: 5 }], [{ kind: "gp", gp: 1 }, { kind: "gp", gp: 2 }, { kind: "gp", gp: 5 }]];
    for (let seed = 1; seed <= 2000; seed++) {
      const rng = seededRng(seed);
      const parts = m3Lines[seed % 2];
      const grid = parts.length === 3 ? [{ cols: 3, rows: 3 }, { cols: 5, rows: 4 }][seed % 4 >> 1] : [{ cols: 3, rows: 2 }, { cols: 4, rows: 3 }][seed % 4 >> 1];
      const card = layCard({ ...m3game, grid }, { kind: "line", parts }, rng);
      const read = cardWins(card);
      expect(read.cp).toBe(parts.reduce((n, p) => n + (p.kind === "gp" ? p.gp * 100 : 0), 0));
      expect(read.items.map(i => i.item)).toEqual(parts.filter(p => p.kind === "item").map(p => p.rarity));
      const counts = new Map();
      for (const p of card.panels) counts.set(p.symbol, (counts.get(p.symbol) ?? 0) + 1);
      const triples = [...counts].filter(([, n]) => n >= 3);
      expect(triples).toHaveLength(parts.length);
      for (const [, n] of triples) expect(n).toBe(3);
      expect(read.winners).toHaveLength(parts.length * 3);
    }
  });

  it("the readout counts lines: 1 in N wins and the top prize stay true, and all prizes X or more compares each line's total", () => {
    const roll = rollOf(LINES);
    expect(oddsText(rollOdds(roll.prizes, roll.size, 5))).toBe("1 in 1.5 tickets wins, the top prize (Rare item + Uncommon item) 1 in 6, all prizes 10 gp or more");
    // Two 3 gp parts make a 6 gp line: over a 5 gp ticket, though each part is under it.
    const pairs = prizesOf({ roll: { prizes: [{ count: 4, parts: [{ gp: 3 }, { gp: 3 }] }, { count: 2, gp: 8 }] } });
    expect(rollOdds(pairs, 20, 5)).toMatchObject({ wins: 6, oneIn: "3.3", floor: 6 });
    expect(rollOdds(prizesOf({ roll: { prizes: [{ count: 4, parts: [{ gp: 3 }, { gp: 1 }] }] } }), 20, 5).floor).toBeNull();
    // The ribbon: the top line in full, and every coin, gem and item the roll pays.
    expect(rollPrizes(LINES)).toEqual({ top: { parts: [{ item: "rare" }, { item: "uncommon" }] }, gp: 35, items: 3, floor: 10 });
    const card = layCard(LINES, { kind: "dud" }, seededRng(1));
    expect(ticketHTML({ card, box: { name: "Lines Ticket" } }, { esc })).toContain('<div class="lc-scratch__ribbon"><span>Top prize</span><strong>Rare item + Uncommon item</strong><span>35 gp and 3 items in prizes in this roll</span></div>');
    expect(cleanCard(card).prizes.top).toEqual({ parts: [{ item: "rare" }, { item: "uncommon" }] });
    expect(cleanCard({ ...card, prizes: { ...card.prizes, top: { parts: [{ item: "mythic" }] } } }).prizes.top).toBeNull();
    // The shop's rows and the Boxes pills name each line in full.
    expect(prizeListHTML(rollState(LINES, []), esc)).toContain("Rare item + 5 gp + the gem (10 gp)");
    expect(scratchOddsHTML(LINES, [])).toContain(`<span class="lc-odd lc-odd--wrap lc-rarity-rare">Rare item + Uncommon item 1/1</span>`);
  });

  it("deals every line of a whole roll exactly its count, pays a line's coins and gem in one settle, and grants a line's two items in one creation", async () => {
    const twoPools = { p: { ...POOLS.p } };
    for (const seed of [1, 2, 3]) {
      const rng = seededRng(seed);
      const actor = actorMany({ gp: 1000 });
      const log = [];
      const outs = [];
      for (let i = 0; i < 6; i++) {
        const out = await performPull({ box: LINES, pools: twoPools, actor, rng, log });
        outs.push(out);
        log.unshift({ id: `r${i}`, kind: "scratch", boxId: LINES.id, actorId: actor.id, ...SCRATCH.logRow({ game: LINES, state: {}, out }) });
      }
      const counts = {};
      for (const r of log) counts[r.tier] = (counts[r.tier] ?? 0) + 1;
      expect(counts).toEqual({ [PAIR]: 1, [COMBO]: 1, "gp.10": 2, dud: 2 });
      const combo = outs.find(o => o.ticket.tier === COMBO);
      expect(combo).toMatchObject({ outcome: "item", payoutCp: 1500, result: { name: "Flame Tongue", rarity: "rare" }, wonItems: [{ name: "Flame Tongue", rarity: "rare" }] });
      expect(combo.itemIds).toHaveLength(1);
      expect(cardWins(combo.card)).toMatchObject({ cp: 1500, bonus: true, items: [{ item: "rare", name: "Flame Tongue" }] });
      const pair = outs.find(o => o.ticket.tier === PAIR);
      expect(pair.itemIds).toHaveLength(2);
      expect(pair.itemNames).toEqual(["Flame Tongue", "Lucky Coin"]);
      expect(pair.wonItems.map(i => i.rarity)).toEqual(["rare", "uncommon"]);
      expect(pair.payoutCp).toBe(0);
      expect(cardWins(pair.card).items.map(i => i.item)).toEqual(expect.arrayContaining(["rare", "uncommon"]));
      // Never broadcast: the Item data.
      for (const o of outs) { expect(o).not.toHaveProperty("grant"); expect(o).not.toHaveProperty("grants"); }
      // Three items in two creations, the pair's in one.
      expect(actor.creations.sort()).toEqual([1, 2]);
      expect(actor.items.size).toBe(3);
      expect(outs.reduce((n, o) => n + o.payoutCp, 0)).toBe(1500 + 2000);
      expect(toCopper(actor.system.currency)).toBe(100000 - 6 * 500 + 3500);
      expect(gotText(SCRATCH, combo)).toBe("won Flame Tongue and 15 gp");
      expect(gotText(SCRATCH, pair)).toBe("won Flame Tongue and Lucky Coin");
    }
  });

  it("the socket path logs a line's items on one row, the reveal and the chat card name every part, and one refund takes them all back", async () => {
    const world = makeWorld({ actor: actorMany({ pp: 0, gp: 500, ep: 0, sp: 0, cp: 0 }) });
    await world.game.settings.set("loot-crates", "boxes", { lines: LINES });
    await world.game.settings.set("loot-crates", "pools", POOLS);
    for (let i = 0; i < 6; i++) await buyOnce(world, 40 + i, { requestId: `l${i}`, boxId: "lines" });
    const reveals = world.emitted.filter(m => m.type === "reveal");
    expect(reveals).toHaveLength(6);
    const log = getLog();
    const pairRow = log.find(r => r.tier === PAIR);
    const comboRow = log.find(r => r.tier === COMBO);
    expect(pairRow).toMatchObject({ name: "Flame Tongue", itemNames: ["Flame Tongue", "Lucky Coin"] });
    expect(pairRow.itemIds).toHaveLength(2);
    expect(comboRow).toMatchObject({ name: "Flame Tongue", rarity: "rare", payoutCp: 1500 });
    for (const r of reveals) expect(cardWins(r.card).cp).toBe(log.find(l => l.id === r.logId).payoutCp);
    // The reveal: every item by name, the coins into the purse.
    const pairReveal = reveals.find(r => r.ticket.tier === PAIR);
    const comboReveal = reveals.find(r => r.ticket.tier === COMBO);
    expect(pairReveal.itemUuids).toHaveLength(2);
    for (const r of reveals) { expect(r).not.toHaveProperty("grant"); expect(r).not.toHaveProperty("grants"); }
    const said = SCRATCH.reveal.result(pairReveal, { esc, canSee: true });
    expect(said).toContain(`<div class="lc-reveal__name">Flame Tongue and Lucky Coin</div>`);
    expect(said).toContain(`<div class="lc-reveal__rarity">Rare and Uncommon</div>`);
    const comboSaid = SCRATCH.reveal.result(comboReveal, { esc, canSee: true });
    expect(comboSaid).toContain(`<div class="lc-reveal__name">Flame Tongue</div>`);
    expect(comboSaid).toContain("15 gp into Tam's purse");
    expect(comboSaid).toContain("Added to Tam's inventory");
    // The chat card: each item linked, the coins after.
    const cards = globalThis.ChatMessage.create.mock.calls.map(c => c[0].content);
    const pairCard = cards[reveals.indexOf(pairReveal)];
    const comboCard = cards[reveals.indexOf(comboReveal)];
    for (const uuid of pairReveal.itemUuids) expect(pairCard).toContain(uuid);
    expect(comboCard).toContain(comboReveal.itemUuid);
    expect(comboCard).toMatch(/Flame Tongue.*and 15 gp/s);
    // Watch again keeps every item, display only.
    const snap = SCRATCH.reveal.snapshot(pairReveal);
    expect(snap.wonItems.map(i => i.name)).toEqual(["Flame Tongue", "Lucky Coin"]);
    expect(JSON.stringify(snap)).not.toContain("Item.");
    expect(SCRATCH.reveal.fromSnapshot(JSON.parse(JSON.stringify(snap))).wonItems).toEqual(snap.wonItems);
    // One refund of the pair takes both items back and puts the line back in the roll.
    const before = world.actor.items.size;
    const done = await refundPull(pairRow.id);
    expect(done).toMatchObject({ status: "refunded", removedItems: ["Flame Tongue", "Lucky Coin"] });
    expect(world.actor.items.size).toBe(before - 2);
    // The combo's refund removes its item and takes its coins back: the stake back less 15 gp.
    const purse = toCopper(world.actor.system.currency);
    expect((await refundPull(comboRow.id)).status).toBe("refunded");
    expect(toCopper(world.actor.system.currency)).toBe(purse + 500 - 1500);
    expect(world.actor.items.size).toBe(before - 3);
    const st = rollState(LINES, getLog());
    expect(st.prizes.find(p => p.key === PAIR).left).toBe(1);
    expect(st.prizes.find(p => p.key === COMBO).left).toBe(1);
  });

  it("a GM can hide what is left from players: a player's card keeps the price, the top prize and the guarantee; the GM's card and Boxes row show everything and say it is hidden", async () => {
    const hidden = { ...GAME, showLeft: false };
    expect([showsLeft(GAME), showsLeft(hidden), showsLeft({ showLeft: true })]).toEqual([true, false, true]);
    const log = [row({ tier: "gp.100" }), row({ tier: "gp.100" }), row({ tier: "dud" })];
    const ctx = { esc, purse: { gp: 50 }, hasActor: true, actorId: "a1", log, open: true, gmOnline: true };
    const player = SCRATCH.shop.card(hidden, POOLS, { ...ctx, isGM: false });
    for (const gone of ["tickets left", "0 of 2", "lc-scratch__prizes", "tickets wins", "Players don't see"]) expect(player).not.toContain(gone);
    expect(player).toContain(`<div class="lc-box__rule">Top prize: Rare item</div>`);
    expect(player).toContain(`<div class="lc-box__rule">All prizes 5 gp or more</div>`);
    expect(player).toContain("Buy a ticket for 5 gp");
    expect(player).toContain("lc-rarity-rare");
    const gm = SCRATCH.shop.card(hidden, POOLS, { ...ctx, isGM: true });
    expect(gm).toContain("97 of 100 tickets left");
    expect(gm).toContain("0 of 2");
    expect(gm).toContain("1 in 2.4 tickets wins");
    expect(gm).toContain("Players don't see what is left in the roll");
    // With the switch on (the default) a player sees it all, and no note.
    const shown = SCRATCH.shop.card(GAME, POOLS, { ...ctx, isGM: false });
    expect(shown).toContain("97 of 100 tickets left");
    expect(shown).not.toContain("Players don't see");
    // Sold out still says so; the counts still don't show.
    const allSold = Array.from({ length: 6 }, (_, i) => row({ boxId: "small", tier: ["item.rare", "gp.10", "gp.10", "bonus", "dud", "dud"][i] }));
    const soldOut = SCRATCH.shop.card({ ...SMALL, showLeft: false }, POOLS, { ...ctx, log: allSold, isGM: false });
    expect(soldOut).toContain("Roll 1 is sold out");
    expect(soldOut).toContain(`aria-disabled="true"`);
    expect(soldOut).not.toContain("of 1");
    expect(scratchRulesText(hidden, log)).toBe("Lucky numbers 4 × 3, bonus 25 gp, Roll 1: 97 of 100 tickets left, hidden from players");
    // The ticket and the reveal say no counts either: the roll by name alone.
    const out = await performPull({ box: { ...SMALL, showLeft: false }, pools: POOLS, actor: actorOf(), rng: seededRng(5), log: [] });
    expect(out.ticket).toMatchObject({ rollId: 1, no: 1, size: 6, hidden: true });
    const rv = { kind: "scratch", actorName: "Tam", box: { id: "small", name: "Small Ticket", price: 5 }, ...out };
    expect(ticketHTML(rv, { esc })).toContain(`<span class="lc-scratch__roll">Roll 1</span>`);
    expect(SCRATCH.reveal.result(rv, { esc, canSee: true })).not.toContain("tickets left");
    expect(SCRATCH.reveal.fromSnapshot(SCRATCH.reveal.snapshot(rv)).ticket.hidden).toBe(true);
    // The editor: the switch, on by default; the draft keeps the GM's pick, or the game's when the form has none.
    expect(scratchFieldsHTML(GAME, { esc })).toMatch(/<input type="checkbox" name="showLeft" checked[^>]*> Players see what is left in the roll/);
    expect(scratchFieldsHTML(hidden, { esc })).toMatch(/<input type="checkbox" name="showLeft" aria-describedby/);
    const values = { price: "5 gp", layout: "lucky", cols: "4", rows: "3", bonusOn: true, bonusGp: "25", size: "100", prizes: [] };
    expect(draftScratch(GAME, { ...values, showLeft: false }, []).showLeft).toBe(false);
    expect(draftScratch(hidden, { ...values, showLeft: true }, []).showLeft).toBe(true);
    expect(draftScratch(hidden, values, []).showLeft).toBe(false);
  });

  it("the editor writes a row of several parts as one line, and a form from before lines as a line of one", () => {
    const values = { price: "5 gp", layout: "lucky", cols: "4", rows: "3", bonusOn: true, bonusGp: "10", size: "6", prizes: ["a", "b"],
      "z.a.count": "1", "z.a.parts": ["x", "y", "z"], "z.a.x.what": "item.rare", "z.a.y.what": "gp", "z.a.y.gp": "5", "z.a.z.what": "bonus",
      "z.b.count": "2", "z.b.what": "gp", "z.b.gp": "10" };
    expect(draftScratch(GAME, values, []).roll.prizes).toEqual([{ count: 1, parts: [{ item: { rarity: "rare" } }, { gp: 5 }, { bonus: true }] }, { count: 2, parts: [{ gp: 10 }] }]);
    const html = scratchFieldsHTML(LINES, { esc });
    // The combination row: three parts, each named by its number in the line, each removable; Add a part under them.
    expect(html).toContain(`aria-label="What part 2 of prize 1 is"`);
    expect(html).toContain(`aria-label="Remove part 3 of prize 1"`);
    expect(html).toContain(`aria-label="Add a part to prize 1"`);
    // A row from before lines: one part, named as the prize, no part remove shown.
    expect(html).toContain(`aria-label="What prize 3 is"`);
    expect(html).toMatch(/class="lc-prize-part__remove" hidden aria-label="Remove part 1 of prize 3"/);
  });
});

// PullError is the core's, re-exported: a refusal reads as one sentence.
void PullError;

/*
  The print: the look the approved mockup settled (research 5b), carried
  on the card so every client and every replay prints the same ticket.
*/
describe("the print", () => {
  it("every card carries its theme and the roll's facts; the theme is the editor's, Dragon's hoard when unset", () => {
    expect(THEMES).toEqual(["hoard", "fey", "arcane", "mint"]);
    expect([themeOf(GAME), themeOf({ theme: "fey" }), themeOf({ theme: "neon" }), themeOf(null)]).toEqual(["hoard", "fey", "hoard", "hoard"]);
    const card = layCard(GAME, { kind: "gp", gp: 25 }, seededRng(4));
    expect(card.theme).toBe("hoard");
    // 2 x 100 + 5 x 25 + 12 x 10 + 20 x 5 + 3 x 25 (the bonus) = 620 gp, and the Rare.
    expect(card.prizes).toEqual({ top: { item: "rare" }, gp: 620, items: 1, floor: 5 });
    expect(layCard({ ...GAME, theme: "fey" }, { kind: "dud" }, seededRng(1)).theme).toBe("fey");
    expect(rollPrizes(MATCH3)).toEqual({ top: { item: "uncommon" }, gp: 30, items: 1, floor: 1 });
    // A coin top prize; a prize under the price makes no floor; no prizes, no top.
    expect(rollPrizes({ price: 2, roll: { size: 10, prizes: [{ count: 1, gp: 50 }, { count: 4, gp: 1 }] } })).toEqual({ top: { gp: 50 }, gp: 54, items: 0, floor: null });
    expect(rollPrizes({ price: 1, roll: { size: 10, prizes: [] } })).toEqual({ top: null, gp: 0, items: 0, floor: null });
  });

  it("the ribbon's second line adds the roll up in words, one key a shape", () => {
    expect(ribbonTotalText({ gp: 620, items: 1 })).toBe("620 gp and 1 item in prizes in this roll");
    expect(ribbonTotalText({ gp: 620, items: 2 })).toBe("620 gp and 2 items in prizes in this roll");
    expect(ribbonTotalText({ gp: 30, items: 0 })).toBe("30 gp in prizes in this roll");
    expect(ribbonTotalText({ gp: 0, items: 1 })).toBe("1 item in prizes in this roll");
    expect(ribbonTotalText({ gp: 0, items: 3 })).toBe("3 items in prizes in this roll");
    expect(ribbonTotalText({ gp: 0, items: 0 })).toBe("");
    expect(ribbonTotalText(null)).toBe("");
  });

  it("the ticket prints its theme, the corners, the band with an emblem each side, the ribbon, the coins, the EXTRA box and the foot with the tagline and the guarantee", () => {
    const card = layCard(GAME, { kind: "gp", gp: 25 }, seededRng(4));
    const html = ticketHTML({ card, box: { name: "Fortune Ticket" }, ticket: { rollId: 1, no: 44, size: 100 } }, { esc });
    expect(html).toContain('<div class="lc-scratch__ticket" data-layout="lucky" data-theme="hoard">');
    expect((html.match(/lc-scratch__corner--/g) ?? []).length).toBe(4);
    expect((html.match(/class="lc-scratch__emblem"/g) ?? []).length).toBe(2);
    expect(html).toContain('<span class="lc-scratch__title">Fortune Ticket</span>');
    expect(html).toContain('<div class="lc-scratch__ribbon"><span>Top prize</span><strong>Rare item</strong><span>620 gp and 1 item in prizes in this roll</span></div>');
    expect((html.match(/class="lc-scratch__ball"/g) ?? []).length).toBe(card.lucky.length);
    expect(html).toContain('<div class="lc-scratch__cap"><span>Lucky numbers</span><span>Match any of yours to win its prize</span></div>');
    expect(html).toContain('<div class="lc-scratch__extra">Extra 25 gp</div>');
    expect(html).toContain('<div class="lc-scratch__foot"><span class="lc-scratch__roll">Roll 1, ticket 44 of 100</span><span class="lc-scratch__tag">Fortune favours the bold</span><span class="lc-scratch__guarantee">All prizes 5 gp or more</span></div>');
    // An item prize's pill is marked, so its rarity edges it.
    const item = layCard(GAME, { kind: "item", rarity: "rare", name: "Flame Tongue" }, seededRng(4));
    expect(ticketHTML({ card: item, box: { name: "Fortune Ticket" } }, { esc })).toContain('<span class="lc-scratch__prize lc-scratch__prize--item">Flame Tongue</span>');
    // A card from before the print (no theme, no prizes) still prints: hoard, no ribbon, the tagline alone in the foot.
    const { theme: _theme, prizes: _prizes, ...old } = card;
    const bare = ticketHTML({ card: old, box: { name: "Old" } }, { esc });
    expect(bare).toContain('data-theme="hoard"');
    expect(bare).not.toContain("lc-scratch__ribbon");
    expect(bare).toContain('<div class="lc-scratch__foot"><span class="lc-scratch__tag">Fortune favours the bold</span></div>');
    // Match 3: its own captions; a card without prizes still names the top prize from its key.
    const m3 = layCard(MATCH3, { kind: "gp", gp: 5 }, seededRng(2));
    const m3html = ticketHTML({ card: { ...m3, theme: "fey" }, box: { name: "Market Scratchie" } }, { esc });
    expect(m3html).toContain('data-layout="match3" data-theme="fey"');
    expect(m3html).toContain('<span>Top prize</span><strong>Uncommon item</strong><span>30 gp and 1 item in prizes in this roll</span>');
    expect(m3html).toContain('<div class="lc-scratch__cap"><span>Your numbers</span></div>');
    const { prizes: _p, ...m3old } = m3;
    expect(ticketHTML({ card: m3old, box: { name: "Market Scratchie" } }, { esc })).toContain('<div class="lc-scratch__ribbon"><span>Top prize</span><strong>Uncommon item</strong></div>');
  });

  it("the editor's theme field: a select of the four, the draft keeps the pick, an unknown one keeps the game's; a copy and a new ticket start right", () => {
    const html = scratchFieldsHTML({ ...GAME, theme: "arcane" }, { esc });
    const select = html.match(/<select name="theme">(.*?)<\/select>/s)?.[1] ?? "";
    expect(select.match(/<option value="(\w+)"/g)?.map(o => o.slice(15, -1))).toEqual(["hoard", "fey", "arcane", "mint"]);
    expect(select).toContain('<option value="arcane" selected>Arcane (violet and gold)</option>');
    expect(select).toContain(">Dragon&#39;s hoard (crimson and gold)<".replace("&#39;", "'"));
    expect(html).toContain("Printed in <select");
    const values = { price: "5 gp", layout: "lucky", cols: "4", rows: "3", bonusOn: true, bonusGp: "25", size: "100", prizes: [], "pool.p": true, "share.p": "1" };
    expect(draftScratch(GAME, { ...values, theme: "mint" }, ["p"]).theme).toBe("mint");
    expect(draftScratch({ ...GAME, theme: "fey" }, { ...values, theme: "neon" }, ["p"]).theme).toBe("fey");
    expect(draftScratch(GAME, values, ["p"]).theme).toBe("hoard");
    expect(copyOf({ ...GAME, theme: "mint" }, { id: "x" }).theme).toBe("mint");
    expect(NEW_DEFAULTS.scratch().theme).toBe("hoard");
  });

  it("cleanCard keeps a sound print and gives a doubtful one the default", () => {
    const card = layCard({ ...GAME, theme: "fey" }, { kind: "gp", gp: 25 }, seededRng(4));
    expect(cleanCard(card)).toMatchObject({ theme: "fey", prizes: { top: { item: "rare" }, gp: 620, items: 1, floor: 5 } });
    expect(cleanCard({ ...card, theme: "neon", prizes: { top: { item: "mythic" }, gp: -4, items: "x", floor: "y" } })).toMatchObject({ theme: "hoard", prizes: { top: null, gp: 0, items: 0, floor: null } });
    expect(cleanCard({ ...card, prizes: { top: { gp: 50 }, gp: 54.5, items: 2.7, floor: 2 } }).prizes).toEqual({ top: { gp: 50 }, gp: 54.5, items: 2, floor: 2 });
    const { theme: _theme, prizes: _prizes, ...old } = card;
    expect(cleanCard(old)).toMatchObject({ theme: "hoard", prizes: null });
    // An old match 3 snapshot replayed (Watch again cleans it) still names its top prize from its key.
    const { prizes: _m3p, theme: _m3t, ...oldM3 } = layCard(MATCH3, { kind: "gp", gp: 5 }, seededRng(2));
    expect(ticketHTML({ card: cleanCard(oldM3), box: { name: "Market Scratchie" } }, { esc })).toContain('<div class="lc-scratch__ribbon"><span>Top prize</span><strong>Uncommon item</strong></div>');
  });
});
