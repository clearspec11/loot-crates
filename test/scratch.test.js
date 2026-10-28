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
vi.mock("../module/scripts/foundry/sound.js", () => ({ playTick: vi.fn(), playSlow: vi.fn(), playReveal: vi.fn(), playPlop: vi.fn(), playPlink: vi.fn(), playCoinBack: vi.fn(), playBane: vi.fn() }));

const scratch = await import("../module/scripts/games/scratch.js");
const { SCRATCH, SCRATCH_DEFAULTS, SYMBOLS, prizesOf, rollOf, gridOf, bonusOf, layoutOf, rollState, ticketsSold, drawBag, rollReason, layCard, cardWins, splitsOf, luckyCount, rollOdds, oddsText, oneIn, prizeText, ticketsLeftText, scratchRulesText, scratchOddsHTML, nextRoll, draftScratch, scratchPreview, scratchPreviewHTML, ticketHTML, miniHTML, shownState, prizeListHTML } = scratch;
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
    expect(cardWins(card)).toEqual({ cp: 0, item: null, winners: [], bonus: false });
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
    expect(draft).toMatchObject({ kind: "scratch", price: 5, layout: "lucky", grid: { cols: 4, rows: 3 }, bonus: { on: false, gp: 25 }, roll: { id: 1, size: 10, prizes: [{ count: 1, item: { rarity: "legendary" } }, { count: 12, gp: 5 }, { count: 2, bonus: true }] } });
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
    expect(k.result(reveal({ card: layCard(GAME, { kind: "dud" }, seededRng(4)), outcome: "nothing", result: null }), { esc })).toContain("A dud. Nothing this time.");
    const html = ticketHTML({ ...coins, box: { name: "Fortune Ticket" } }, { esc });
    expect(html).toContain("Roll 1, ticket 44 of 100");
    expect((html.match(/lc-scratch__panel--win/g) ?? []).length).toBe(cardWins(card).winners.length);
    expect(html).toContain("Reveal the gem to win <strong>25 gp</strong> on top.");
    expect(miniHTML(card).match(/<i/g)).toHaveLength(12);
    k.sting(coins); expect(sound.playCoinBack).toHaveBeenCalledTimes(1);
    k.sting(reveal({ outcome: "nothing", result: null })); expect(sound.playPlink).toHaveBeenCalledTimes(1);
    k.sting(reveal({ outcome: "item", result: { name: "Flame Tongue", rarity: "rare" } })); expect(sound.playReveal).toHaveBeenCalledWith("rare");
    expect(k.notice(reveal({ outcome: "nothing", result: null }))).toBe("Fortune Ticket: a dud.");
    expect(k.notice(coins)).toBeNull();
    expect(k.replayable).toBe(false);
  });

  it("the stand-in play draws the card open and lands at once, with nothing to replay", () => {
    const host = { classList: { add: vi.fn() }, dataset: {}, innerHTML: "" };
    const onLand = vi.fn();
    const ctrl = SCRATCH.reveal.play(host, reveal({ card: layCard(MATCH3, { kind: "gp", gp: 5 }, seededRng(2)), outcome: "coins", payoutCp: 500, box: { name: "Market Scratchie", price: 1 } }), { onLand });
    expect(ctrl.reducedMotion).toBe(true);
    ctrl.play(); ctrl.skip();
    expect(onLand).toHaveBeenCalledTimes(1);
    expect(host.innerHTML).toContain("Three the same win that prize");
    expect((host.innerHTML.match(/lc-scratch__panel--win/g) ?? []).length).toBe(3);
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
    const html = boxesTableHTML({ boxes: [GAME], pools: POOLS, log, esc });
    expect(html).toContain(`data-action="printRoll" data-box="fortune" aria-label="Print a new roll of Fortune Ticket">Print a new roll</button>`);
    expect(html).toContain(`<span class="lc-kind">Scratch</span>`);
    expect(html).toContain(`aria-label="Ticket price at Fortune Ticket"`);
    expect(ticketsLeftText(1, 1)).toBe("1 of 1 ticket left");
    expect(prizeText({ kind: "bonus", gp: 25 })).toBe("Bonus, 25 gp");
    expect(RARITIES.every(r => prizeText({ kind: "item", rarity: r }).endsWith(" item"))).toBe(true);
  });
});

// PullError is the core's, re-exported: a refusal reads as one sentence.
void PullError;
