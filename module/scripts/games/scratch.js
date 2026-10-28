/*
  Scratch tickets: the seventh kind of game (kinds.js, VIB-188), a printed
  roll of tickets with a fixed prize list. The GM prints N tickets with so
  many of each prize (coins, an item at a rarity from the pools, or the
  bonus spot's coins), the rest duds; each Buy draws one ticket from what
  is left of the roll, without replacement, and the shop shows the
  tickets and prizes still in it. Sold out is a real state, and the GM's
  Print a new roll starts the next.

  - Nothing is stored for the roll beyond its definition and its id: the
    tickets sold are the unrefunded log rows at this game for this roll
    id, each naming its prize tier, the way the well's cap and the deck's
    once cards are counted (rollState). So a refund puts the ticket, and
    its prize, back in the roll by itself, and two Buys in the GM's write
    queue never draw the same last ticket.
  - The card is decided in the roll and never by the scratching: the GM
    draws the ticket, then lays the card out from it (layCard) with the
    roll's rng, and the card rides the reveal broadcast so every client
    draws the same one. Two layouts. Lucky numbers: a row of lucky
    numbers and a grid of your numbers, each with a prize under it; any
    of yours that equals a lucky number wins its prize, and wins add up
    (a coin prize is sometimes split across two panels), plus a bonus
    spot that pays on top on a bonus ticket. Match 3: every panel hides a
    symbol, and three the same anywhere win that symbol's prize. The
    layout obeys the lotteries' honesty rules: your numbers are never two
    the same, a number matches a lucky number only where a win was
    decided, the bonus mark shows only on a bonus ticket; on a match 3
    card three of a symbol appear only where a win was decided, and every
    other symbol at most twice. cardWins reads a card's wins back from
    its layout alone, and the tests hold it to the decided payout.
  - One item per ticket at most (the core's one grant), resolved from the
    pools at the prize's rarity the crate's way (crate.js drawItem,
    grantData); coins through the core's one settle() (payoutCp). An item
    prize the ticked pools can't give is left in the roll and not drawn
    until they can, so a ticket never promises what it can't hand over.
  - The reveal is the scratch (mountScratch, the foil in views/foil.js):
    the buyer rubs the foil off with a coin, panel by panel, and everyone
    else watches the same coin scratch the card by itself; the card lands
    when every panel is open. The result never depends on the scratching.
    Watch again replays it as the table saw it, from the chat card's
    snapshot.

  Record: { kind: "scratch", price, pools, weights, layout: "lucky" |
  "match3", grid: { cols, rows }, bonus: { on, gp } (lucky only), roll:
  { id, size, prizes: [{ count, gp } | { count, item: { rarity } } |
  { count, bonus: true }] }, rules }. A roll's duds are its size less its
  prizes.

  No Foundry globals: the core passes the log, the pools and the rng, so
  Vitest runs the ledger, the draw and the card as they are.
*/
import { RARITIES, RARITY_LABEL } from "../core/config.js";
import { weightedPick, flattenPool, rarityRank } from "../core/odds.js";
import { formatPrice, formatGold, canAfford, shortfall, parsePrice } from "../core/currency.js";
import { playReveal, playPlop, playScratch, playFoilTick } from "../foundry/sound.js";
import { resultHTML } from "../views/revealcard.js";
import { mountFoil } from "../views/foil.js";
import { cardShell, shopReason, shortReason, draftBox } from "../views/boxcard.js";
import { drawItem, grantData, crateLogRow } from "./crate.js";
import { PullError, registerKind } from "./kinds.js";
import { t, words } from "../core/i18n.js";

export const LAYOUTS = ["lucky", "match3"];
export const LAYOUT_LABEL = words({ lucky: "LOOTCRATES.Scratch.LayoutLucky", match3: "LOOTCRATES.Scratch.LayoutMatch3" });
// The grid each layout starts at, and how big a card can be: a match 3
// card needs each symbol no more than twice on a losing card, so it stays
// within twice the symbols there are.
export const GRID_DEFAULTS = { lucky: { cols: 4, rows: 3 }, match3: { cols: 3, rows: 2 } };
export const GRID_LIMITS = { lucky: { cols: [2, 6], rows: [1, 5] }, match3: { cols: [2, 5], rows: [1, 4] } };
// A prize list is at most this many rows (a match 3 card has a symbol for each).
export const MAX_PRIZES = 8;
// The symbols a match 3 card is drawn in, best prize first, each named on
// its panel. More than MAX_PRIZES, so a card has symbols that pay nothing too.
export const SYMBOLS = ["crown", "gem", "chalice", "key", "star", "moon", "sun", "shield", "horn", "rose"];
export const SYMBOL_LABEL = words({
  crown: "LOOTCRATES.Scratch.SymCrown", gem: "LOOTCRATES.Scratch.SymGem", chalice: "LOOTCRATES.Scratch.SymChalice", key: "LOOTCRATES.Scratch.SymKey", star: "LOOTCRATES.Scratch.SymStar",
  moon: "LOOTCRATES.Scratch.SymMoon", sun: "LOOTCRATES.Scratch.SymSun", shield: "LOOTCRATES.Scratch.SymShield", horn: "LOOTCRATES.Scratch.SymHorn", rose: "LOOTCRATES.Scratch.SymRose",
});

/*
  What a New scratch ticket starts as: the approved mockup's Fortune
  Ticket, 5 gp a ticket, lucky numbers on a 4 x 3 grid with a 25 gp bonus
  spot, a roll of 100: one Rare item, two 100 gp, five 25 gp, twelve
  10 gp, twenty 5 gp and three bonus tickets, the other 57 duds.
*/
export const SCRATCH_DEFAULTS = {
  price: 5, layout: "lucky", bonusGp: 25, size: 100,
  prizes: [{ count: 1, item: { rarity: "rare" } }, { count: 2, gp: 100 }, { count: 5, gp: 25 }, { count: 12, gp: 10 }, { count: 20, gp: 5 }, { count: 3, bonus: true }],
};

const clampInt = (v, [lo, hi], fallback) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
};
const toGp = v => Math.round(Math.max(0, Number(v) || 0) * 100) / 100;

/* ---------- The record ---------- */

export const layoutOf = game => (LAYOUTS.includes(game?.layout) ? game.layout : "lucky");

// The grid, inside its layout's limits, never fewer than three panels.
export function gridOf(game) {
  const layout = layoutOf(game);
  const lim = GRID_LIMITS[layout], def = GRID_DEFAULTS[layout];
  const cols = clampInt(game?.grid?.cols, lim.cols, def.cols);
  let rows = clampInt(game?.grid?.rows, lim.rows, def.rows);
  while (cols * rows < 3 && rows < lim.rows[1]) rows++;
  return { cols, rows };
}

// The bonus spot: lucky numbers only, and only with a prize.
export function bonusOf(game) {
  const gp = toGp(game?.bonus?.gp);
  return { on: layoutOf(game) === "lucky" && !!game?.bonus?.on && gp > 0, gp };
}

/*
  The prize list in one shape, merged by prize and best first (items by
  rarity, then coins by amount, then the bonus spot): [{ key, kind: "item"
  | "gp" | "bonus", rarity?, gp?, count }]. A row of 0 tickets, an item
  at no rarity, coins of nothing, or a bonus with no bonus spot is left
  out; past MAX_PRIZES rows the rest are too.
*/
export function prizesOf(game) {
  const bonus = bonusOf(game);
  const by = new Map();
  for (const p of game?.roll?.prizes ?? []) {
    const count = Math.max(0, Math.floor(Number(p?.count) || 0));
    if (!count) continue;
    let tier = null;
    if (p.bonus) { if (bonus.on) tier = { key: "bonus", kind: "bonus", gp: bonus.gp }; }
    else if (p.item) { if (RARITIES.includes(p.item.rarity)) tier = { key: `item.${p.item.rarity}`, kind: "item", rarity: p.item.rarity }; }
    else if (toGp(p.gp) > 0) tier = { key: `gp.${toGp(p.gp)}`, kind: "gp", gp: toGp(p.gp) };
    if (!tier) continue;
    const had = by.get(tier.key);
    if (had) had.count += count;
    else by.set(tier.key, { ...tier, count });
  }
  const rank = p => (p.kind === "item" ? 2e9 + rarityRank(p.rarity) : p.kind === "gp" ? p.gp : -1);
  return [...by.values()].sort((a, b) => rank(b) - rank(a)).slice(0, MAX_PRIZES);
}

// The roll as printed: { id, size, prizes, duds }. Its size is never less
// than its prizes (more prizes than tickets makes the roll that big).
export function rollOf(game) {
  const prizes = prizesOf(game);
  const won = prizes.reduce((n, p) => n + p.count, 0);
  const size = Math.max(won, Math.max(0, Math.floor(Number(game?.roll?.size) || 0)));
  return { id: Math.max(1, Math.floor(Number(game?.roll?.id) || 1)), size, prizes, duds: size - won };
}

/* ---------- The ledger, from the log ---------- */

// The unrefunded rows of this roll at this game: the tickets sold.
export const rollRows = (log, { boxId, rollId }) => (log ?? []).filter(r => r?.kind === "scratch" && r.boxId === boxId && Number(r.rollId) === rollId && !r.refunded);
export const ticketsSold = (log, { boxId, rollId }) => rollRows(log, { boxId, rollId }).length;

/*
  What is left of the game's roll now: { id, size, sold, left, soldOut,
  prizes: [{ ...tier, left }], duds: { count, left } }. A tier's left is
  its count less the rows naming it; the duds are whatever tickets are
  left past the prizes. A prize list edited after tickets sold counts
  against what is left (a tier's left never below 0).
*/
export function rollState(game, log = []) {
  const roll = rollOf(game);
  const rows = rollRows(log, { boxId: game?.id, rollId: roll.id });
  const of = key => rows.filter(r => r.tier === key).length;
  const left = Math.max(0, roll.size - rows.length);
  const prizes = roll.prizes.map(p => ({ ...p, left: Math.max(0, p.count - of(p.key)) }));
  const prizeLeft = prizes.reduce((n, p) => n + p.left, 0);
  return { id: roll.id, size: roll.size, sold: rows.length, left, soldOut: left <= 0, prizes, duds: { count: roll.duds, left: Math.max(0, left - prizeLeft) } };
}

// The rarities the game's ticked pools can give an item at (missing entries out).
export function poolRarities(game, pools = {}) {
  const held = new Set();
  for (const ref of game?.pools ?? []) for (const e of flattenPool(ref.id, pools ?? {})) if (e.weight > 0) held.add(e.rarity);
  return held;
}

/*
  The tickets one Buy can be drawn from, as weights by what is left of
  each: every prize still in the roll that can be handed over (an item
  prize only while the pools hold an item at its rarity), and the duds.
  `blocked` counts the tickets left whose item prize the pools can't
  give, which wait in the roll.
*/
export function drawBag(game, pools, log = []) {
  const st = rollState(game, log);
  const held = poolRarities(game, pools);
  const bag = [];
  let blocked = 0;
  for (const p of st.prizes) {
    if (!p.left) continue;
    if (p.kind === "item" && !held.has(p.rarity)) { blocked += p.left; continue; }
    bag.push({ ...p, weight: p.left });
  }
  if (st.duds.left) bag.push({ key: "dud", kind: "dud", weight: st.duds.left, left: st.duds.left });
  return { state: st, bag, blocked };
}

// Why no ticket can be sold now, or "": the roll is empty, or what is left
// waits on an item the pools can't give.
export function rollReason(game, pools, log = []) {
  const { state, bag } = drawBag(game, pools, log);
  if (state.soldOut) return t("LOOTCRATES.Card.SoldOut");
  if (!bag.length) return t("LOOTCRATES.Scratch.Waiting");
  return "";
}

/* ---------- The words for a prize and the odds ---------- */

// "25 gp", "Rare item", "Bonus, 25 gp".
export function prizeText(p) {
  if (p.kind === "item") return t("LOOTCRATES.Scratch.ItemPrize", { rarity: RARITY_LABEL[p.rarity] ?? p.rarity });
  if (p.kind === "bonus") return t("LOOTCRATES.Scratch.BonusPrize", { price: formatPrice(p.gp) });
  return formatPrice(p.gp);
}
const prizeSwatch = p => (p.kind === "item" ? p.rarity : "coin");

// "4.2", "100": one in how many, a decimal under ten.
export function oneIn(total, n) {
  if (!(n > 0) || !(total > 0)) return null;
  const v = total / n;
  return v >= 10 ? String(Math.round(v)) : String(+v.toFixed(1));
}

/*
  The odds of a set of tickets, as the editor (the whole roll as printed)
  and the shop (what is left of it) say them: { tickets, wins, oneIn,
  top, topOneIn, floor }. `top` is the best prize with any left (an item
  over coins); `floor` the least coins any win pays, when every prize
  pays at least the ticket's price (an item counts as more), else null.
*/
export function rollOdds(prizes, tickets, price = 0) {
  const live = prizes.filter(p => (p.left ?? p.count) > 0);
  const n = p => p.left ?? p.count;
  const wins = live.reduce((s, p) => s + n(p), 0);
  const top = live[0] ?? null;
  const coins = live.filter(p => p.kind !== "item").map(p => p.gp);
  const least = coins.length ? Math.min(...coins) : null;
  const floor = live.length && (least == null || least >= price) ? least : null;
  return { tickets, wins, oneIn: oneIn(tickets, wins), top, topOneIn: top ? oneIn(tickets, n(top)) : null, floor };
}

/*
  The readout: "1 in 2.3 tickets wins, the top prize (Rare item) 1 in 100,
  all prizes 5 gp or more". With nothing to win, "Every ticket is a dud".
*/
export function oddsText(odds) {
  if (!odds.tickets) return t("LOOTCRATES.Scratch.NoTickets");
  if (!odds.wins) return t("LOOTCRATES.Scratch.AllDuds");
  const parts = [t("LOOTCRATES.Scratch.OneInWins", { n: odds.oneIn })];
  if (odds.top) parts.push(t("LOOTCRATES.Scratch.TopOneIn", { prize: prizeText(odds.top), n: odds.topOneIn }));
  if (odds.floor != null) parts.push(t("LOOTCRATES.Scratch.Floor", { price: formatPrice(odds.floor) }));
  return parts.join(t("LOOTCRATES.Common.ListComma"));
}

export const ticketsLeftText = (left, size) => t(size === 1 ? "LOOTCRATES.Scratch.TicketsLeftOne" : "LOOTCRATES.Scratch.TicketsLeftMany", { left, size });
export const rollName = id => t("LOOTCRATES.Scratch.RollName", { id });

/* ---------- The card ---------- */

const shuffle = (list, rng) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const pickOne = (list, rng) => list[Math.floor(rng() * list.length)];

// How many lucky numbers a card of `cells` panels has, and the numbers it draws from.
export const luckyCount = cells => (cells <= 9 ? 2 : cells <= 16 ? 3 : cells <= 24 ? 4 : 5);
export const numberRange = cells => Math.max(30, 2 * (cells + luckyCount(cells)));

/*
  The two parts a coin prize is split into across two panels, so wins add
  up: amounts among the roll's own coin prizes that sum to it, or none.
*/
export function splitsOf(gp, coinValues) {
  const vals = [...new Set(coinValues)].filter(v => v < gp);
  const out = [];
  for (const a of vals) {
    const b = Math.round((gp - a) * 100) / 100;
    if (b >= a && vals.includes(b)) out.push([b, a]);
  }
  return out;
}
const SPLIT_CHANCE = 0.4;

/*
  The card for a decided ticket, laid out with `rng` (the roll's, so it is
  the GM's alone and every client is sent the result). `win` is what the
  ticket won: { kind: "dud" } | { kind: "gp", gp } | { kind: "bonus" } |
  { kind: "item", rarity, name, img }. The roll's own prizes dress the
  losing panels, so a dud looks like the tickets around it.

  Lucky numbers: { layout: "lucky", cols, rows, lucky: [n], panels: [{ n,
  prize: { gp } | { item: rarity, name?, img? } }], bonus: { gp, win } or
  null }. Match 3: { layout: "match3", cols, rows, key: [{ symbol, prize
  }], panels: [{ symbol }] }. Which panels win is not written on the card:
  cardWins reads it from the layout, as a player does.
*/
export function layCard(game, win, rng = Math.random) {
  const { cols, rows } = gridOf(game);
  const cells = cols * rows;
  const prizes = prizesOf(game);
  const coinValues = prizes.filter(p => p.kind === "gp").map(p => p.gp);
  const itemRarities = prizes.filter(p => p.kind === "item").map(p => p.rarity);
  return layoutOf(game) === "match3" ? layMatch3(win, { cols, rows, cells, prizes, coinValues, rng }) : layLucky(game, win, { cols, rows, cells, coinValues, itemRarities, rng });
}

function layLucky(game, win, { cols, rows, cells, coinValues, itemRarities, rng }) {
  const nLucky = luckyCount(cells);
  const all = shuffle(Array.from({ length: numberRange(cells) }, (_, i) => i + 1), rng);
  const lucky = all.slice(0, nLucky);
  const others = all.slice(nLucky);
  // The winning panels: the coins (one panel, or two that add up), or the item.
  let wins = [];
  if (win.kind === "gp") {
    const splits = cells >= 2 ? splitsOf(win.gp, coinValues) : [];
    wins = splits.length && rng() < SPLIT_CHANCE ? pickOne(splits, rng).map(gp => ({ gp })) : [{ gp: win.gp }];
  } else if (win.kind === "item") wins = [{ item: win.rarity, name: win.name ?? "", img: win.img ?? "" }];
  const at = shuffle(Array.from({ length: cells }, (_, i) => i), rng).slice(0, wins.length);
  const luckyFor = shuffle(lucky, rng);
  // What a losing panel shows: one of the roll's own prizes, or, on a roll
  // with none, a few times the ticket's price.
  const price = Math.max(1, Number(game?.price) || 1);
  const dress = [...coinValues.map(gp => ({ gp })), ...itemRarities.map(item => ({ item }))];
  const fill = dress.length ? dress : [price, price * 2, price * 5].map(gp => ({ gp: toGp(gp) }));
  let k = 0;
  const panels = Array.from({ length: cells }, (_, i) => {
    const w = at.indexOf(i);
    if (w >= 0) return { n: luckyFor[w], prize: wins[w] };
    return { n: others[k++], prize: { ...pickOne(fill, rng) } };
  });
  const bonus = bonusOf(game);
  return { layout: "lucky", cols, rows, lucky, panels, bonus: bonus.on ? { gp: bonus.gp, win: win.kind === "bonus" } : null };
}

function layMatch3(win, { cols, rows, cells, prizes, rng }) {
  // Each prize a symbol, best first; the symbols left over pay nothing.
  const paying = prizes.filter(p => p.kind !== "bonus");
  const key = paying.map((p, i) => ({ symbol: SYMBOLS[i], prize: p.kind === "item" ? { item: p.rarity } : { gp: p.gp } }));
  const symbolFor = w => key.find(k => (w.kind === "item" ? k.prize.item === w.rarity : k.prize.gp === w.gp))?.symbol;
  // The triples this ticket shows: one for its prize, or two coin prizes
  // that add up to it on a card with room for both.
  let triples = [];
  if (win.kind === "gp" || win.kind === "item") {
    const own = symbolFor(win);
    const splits = win.kind === "gp" && cells >= 6 ? splitsOf(win.gp, key.filter(k => k.prize.gp).map(k => k.prize.gp)).filter(([a, b]) => a !== b) : [];
    if (splits.length && rng() < SPLIT_CHANCE) triples = pickOne(splits, rng).map(gp => symbolFor({ kind: "gp", gp }));
    else if (own) triples = [own];
  }
  const panels = [];
  for (const s of triples) panels.push(s, s, s);
  // Every other symbol at most twice, drawn at random to fill the card.
  const room = shuffle(SYMBOLS.filter(s => !triples.includes(s)).flatMap(s => [s, s]), rng);
  while (panels.length < cells) panels.push(room.pop());
  return { layout: "match3", cols, rows, key, panels: shuffle(panels, rng).map(symbol => ({ symbol })) };
}

/*
  What a card wins, read from its layout alone, as a player reads it:
  { cp (the coins, summed), item (the winning item panel's prize, or
  null), winners (the panels that win), bonus (the bonus spot won) }.
*/
export function cardWins(card) {
  const out = { cp: 0, item: null, winners: [], bonus: false };
  if (!card) return out;
  if (card.layout === "match3") {
    const counts = new Map();
    for (const p of card.panels) counts.set(p.symbol, (counts.get(p.symbol) ?? 0) + 1);
    for (const k of card.key ?? []) {
      if ((counts.get(k.symbol) ?? 0) < 3) continue;
      card.panels.forEach((p, i) => { if (p.symbol === k.symbol) out.winners.push(i); });
      if (k.prize.item) out.item = { item: k.prize.item };
      else out.cp += Math.round(k.prize.gp * 100);
    }
    out.winners.sort((a, b) => a - b);
    return out;
  }
  card.panels.forEach((p, i) => {
    if (!card.lucky.includes(p.n)) return;
    out.winners.push(i);
    if (p.prize.item) out.item = p.prize;
    else out.cp += Math.round((p.prize.gp ?? 0) * 100);
  });
  if (card.bonus?.win) { out.bonus = true; out.cp += Math.round(card.bonus.gp * 100); }
  return out;
}

/* ---------- The roll ---------- */

/*
  The draw, on the GM, before anything is charged: the roll's state from
  the log as it stands inside the write queue, one ticket drawn from what
  is left by weight (each prize as many times as it has tickets left, the
  duds as many), then the card laid out for it. An item prize is drawn
  from the pools at its rarity the crate's way (missing sources reported
  and passed over); the ticket's coins are paid through the core's
  settle(). The ticket's place in the roll and what was left before it
  ride into the reveal and the row.
*/
async function roll(ctx) {
  const { game, rng, log = [] } = ctx;
  const { state, bag } = drawBag(game, ctx.pools, log);
  if (state.soldOut) throw new PullError(t("LOOTCRATES.Scratch.SoldOutError", { name: game.name }));
  if (!bag.length) throw new PullError(t("LOOTCRATES.Scratch.WaitingError", { name: game.name }));
  const tier = weightedPick(bag, p => p.weight, rng) ?? bag[0];
  const ticket = { rollId: state.id, tier: tier.key, no: state.sold + 1, size: state.size };
  const common = { ticket, left: leftOf(state), grant: null };
  if (tier.kind === "item") {
    const only = { ...game, weights: Object.fromEntries(RARITIES.map(r => [r, r === tier.rarity ? 1 : 0])), rules: {} };
    const { result, source, pools } = await drawItem({ ...ctx, game: only, state: {} });
    if (!result || result.rarity !== tier.rarity) throw new PullError(t("LOOTCRATES.Scratch.WaitingError", { name: game.name }));
    const granted = grantData(source, { ...result, pity: false }, game);
    const card = layCard(game, { kind: "item", rarity: tier.rarity, name: granted.result.name, img: granted.result.img }, rng);
    return { ...common, ...granted, outcome: "item", card, pools };
  }
  if (tier.kind === "gp" || tier.kind === "bonus") {
    const card = layCard(game, tier.kind === "bonus" ? { kind: "bonus" } : { kind: "gp", gp: tier.gp }, rng);
    return { ...common, outcome: "coins", card, result: { name: formatPrice(tier.gp), outcome: "coins" }, payoutCp: Math.round(tier.gp * 100) };
  }
  return { ...common, outcome: "nothing", card: layCard(game, { kind: "dud" }, rng), result: null };
}

// What the shop shows of a roll: its counts as they stood, by tier key.
const leftOf = st => ({ rollId: st.id, size: st.size, left: st.left, prizes: Object.fromEntries(st.prizes.map(p => [p.key, p.left])) });

// The row: the roll and the tier it took (what rollState counts), the
// winning panels, and for an item the crate's columns so the one refund
// finds and removes it. A dud is the core's miss (the Pull log folds them).
function logRow(ctx) {
  const { out } = ctx;
  const base = { rollId: out.ticket.rollId, tier: out.ticket.tier, ticketNo: out.ticket.no, winners: cardWins(out.card).winners };
  if (out.outcome === "item") return { ...base, ...crateLogRow(ctx) };
  if (out.outcome === "coins") return { ...base, outcome: "coins", swatch: "coin", name: out.result.name };
  return { ...base, outcome: "nothing", swatch: "none", name: t("LOOTCRATES.Scratch.Dud") };
}

// The card and what the roll held before this ticket: the shop holds its
// counts there until this client's card is open (reveal.js heldState), so
// a top prize going from the list doesn't tell the table first.
function revealExtra({ state = {}, out }) {
  return { card: out.card, ticket: out.ticket, stateBefore: { ...state, scratch: out.left } };
}

// "won 25 gp", "won Sling +2", "scratched a dud": the late-cancel line.
function gotText(out) {
  if (out?.outcome === "item" && out.result?.name) return t("LOOTCRATES.Scratch.GotItem", { name: out.result.name });
  if (out?.outcome === "coins") return t("LOOTCRATES.Scratch.GotCoins", { price: formatPrice((out.payoutCp ?? 0) / 100) });
  return t("LOOTCRATES.Scratch.GotDud");
}

/* ---------- The ticket as markup ---------- */

const symbolText = s => SYMBOL_LABEL[s] ?? s;
const panelPrizeText = prize => (prize?.item ? (prize.name || t("LOOTCRATES.Scratch.ItemPrize", { rarity: RARITY_LABEL[prize.item] ?? prize.item })) : formatPrice(prize?.gp ?? 0));

/*
  The ticket, open: the title band with the top prize, the lucky numbers
  (or the symbols' key), the grid, the bonus spot and the roll line. The
  winning panels carry lc-scratch__panel--win. Every panel names itself
  for a screen reader. The scratch draws its foil over this markup.
*/
export function ticketHTML(reveal, { esc = s => String(s ?? "") } = {}) {
  const card = reveal.card;
  if (!card) return "";
  const won = cardWins(card);
  const win = new Set(won.winners);
  const top = card.layout === "match3" ? card.key?.[0]?.prize : null;
  const foot = reveal.ticket ? t("LOOTCRATES.Scratch.TicketOf", { roll: rollName(reveal.ticket.rollId), no: reveal.ticket.no, size: reveal.ticket.size }) : "";
  const grid = `style="--lc-cols:${Number(card.cols) || 1}"`;
  let body;
  if (card.layout === "match3") {
    const legend = (card.key ?? []).map(k => `<li class="lc-scratch__key-row lc-rarity-${esc(k.prize.item ?? "coin")}"><span class="lc-scratch__sym" data-symbol="${esc(k.symbol)}">${esc(symbolText(k.symbol))}</span> ${esc(panelPrizeText(k.prize))}</li>`).join("");
    body = `<div class="lc-scratch__cap"><span>${t("LOOTCRATES.Scratch.Match3Cap")}</span></div>
      <ul class="lc-scratch__key">${legend}</ul>
      <div class="lc-scratch__grid" ${grid} role="list">${card.panels.map((p, i) => `<div class="lc-scratch__panel${win.has(i) ? " lc-scratch__panel--win" : ""}" role="listitem" data-panel="${i}" aria-label="${esc(t(win.has(i) ? "LOOTCRATES.Scratch.PanelSymbolWin" : "LOOTCRATES.Scratch.PanelSymbol", { n: i + 1, symbol: symbolText(p.symbol) }))}"><span class="lc-scratch__sym" data-symbol="${esc(p.symbol)}">${esc(symbolText(p.symbol))}</span></div>`).join("")}</div>`;
  } else {
    body = `<div class="lc-scratch__cap"><span>${t("LOOTCRATES.Scratch.LuckyCap")}</span><span>${t("LOOTCRATES.Scratch.LuckyHint")}</span></div>
      <div class="lc-scratch__lucky" role="list" aria-label="${esc(t("LOOTCRATES.Scratch.LuckyCap"))}">${card.lucky.map(n => `<span class="lc-scratch__ball" role="listitem">${esc(n)}</span>`).join("")}</div>
      <div class="lc-scratch__cap"><span>${t("LOOTCRATES.Scratch.YoursCap")}</span><span>${t("LOOTCRATES.Scratch.WinsAddUp")}</span></div>
      <div class="lc-scratch__grid" ${grid} role="list">${card.panels.map((p, i) => `<div class="lc-scratch__panel${win.has(i) ? " lc-scratch__panel--win" : ""}${p.prize?.item ? ` lc-rarity-${esc(p.prize.item)}` : ""}" role="listitem" data-panel="${i}" aria-label="${esc(t(win.has(i) ? "LOOTCRATES.Scratch.PanelNumberWin" : "LOOTCRATES.Scratch.PanelNumber", { n: i + 1, number: p.n, prize: panelPrizeText(p.prize) }))}"><span class="lc-scratch__num">${esc(p.n)}</span><span class="lc-scratch__prize${p.prize?.item ? " lc-scratch__prize--item" : ""}">${esc(panelPrizeText(p.prize))}</span></div>`).join("")}</div>
      ${card.bonus ? `<div class="lc-scratch__bonus"><div class="lc-scratch__panel lc-scratch__spot${card.bonus.win ? " lc-scratch__panel--win" : ""}" data-panel="bonus" aria-label="${esc(card.bonus.win ? t("LOOTCRATES.Scratch.BonusSpotWin", { price: formatPrice(card.bonus.gp) }) : t("LOOTCRATES.Scratch.BonusSpot"))}"><span class="lc-scratch__mark${card.bonus.win ? " lc-scratch__mark--gem" : ""}" aria-hidden="true"></span></div><p>${t("LOOTCRATES.Scratch.BonusHint", { price: `<strong>${esc(formatPrice(card.bonus.gp))}</strong>` })}</p></div>` : ""}`;
  }
  const topLine = top ? `<span class="lc-scratch__top">${t("LOOTCRATES.Scratch.TopPrize", { prize: esc(panelPrizeText(top)) })}</span>` : "";
  return `<div class="lc-scratch__ticket" data-layout="${esc(card.layout)}">
      <div class="lc-scratch__band"><span class="lc-scratch__title">${esc(reveal.box?.name ?? "")}</span>${topLine}</div>
      ${body}
      ${foot ? `<div class="lc-scratch__foot">${esc(foot)}</div>` : ""}
    </div>`;
}

// The small card for chat: one square per panel, the winners filled.
export function miniHTML(card) {
  if (!card) return "";
  const win = new Set(cardWins(card).winners);
  return `<span class="lc-scratch__mini" style="--lc-cols:${Number(card.cols) || 1}" aria-hidden="true">${card.panels.map((_, i) => `<i${win.has(i) ? ' class="lc-scratch__mini--win"' : ""}></i>`).join("")}</span>`;
}

/* ---------- The reveal: the scratch ---------- */

const outcomeOf = reveal => reveal.outcome ?? (reveal.result?.rarity ? "item" : reveal.payoutCp > 0 ? "coins" : "nothing");
const escHTML = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// A panel's lit and rarity classes, held back while it is covered: either
// would show through the foil's edge and tell the card before it is read.
const TELLS = /^(lc-scratch__panel--win|lc-rarity-.+)$/;

/*
  The ticket in `host` under its foil (foil.js), as the reveal plays it:
  the buyer scratches by hand (`buyer`), with Reveal all and the keys
  under the ticket; everyone else watches the coin scratch it by itself.
  Each panel says only "Panel 3, covered" until it opens, then what it
  shows; a winner is lit as it opens (on a match 3 card, once the third of
  its symbol is open, so a lit panel never tells the rest). `duration` 0
  opens the card at once (the harness). Returns the foil's controller, the
  one the core expects of a kind's play: play(), skip(), skipped,
  reducedMotion, plus open(i), revealAll() and opened().
*/
export function mountScratch(host, { reveal, buyer = false, reducedMotion, duration, sounds = {}, onPanel = null, onLand = null } = {}) {
  host.classList.add("lc-scratch");
  host.classList.remove("lc-scratch--landed");
  host.dataset.outcome = outcomeOf(reveal);
  const card = reveal?.card;
  const tools = buyer ? `<div class="lc-scratch__tools"><button type="button" class="lc-scratch__all">${escHTML(t("LOOTCRATES.Scratch.RevealAll"))}</button><p class="lc-scratch__help">${escHTML(t("LOOTCRATES.Scratch.Help"))}</p></div>` : "";
  host.innerHTML = `<div class="lc-scratch__stage">${ticketHTML(reveal ?? {}, { esc: escHTML })}${tools}</div>`;
  const ticket = host.querySelector(".lc-scratch__ticket");
  const done = () => { host.classList.add("lc-scratch--landed"); host.querySelector(".lc-scratch__tools")?.remove(); onLand?.(); };
  const els = ticket ? [...ticket.querySelectorAll("[data-panel]")] : [];
  const held = els.map((el, i) => {
    const keep = el.className.split(/\s+/).filter(c => TELLS.test(c));
    if (keep.length) el.classList.remove(...keep);
    const label = el.getAttribute("aria-label") ?? "";
    el.setAttribute("aria-label", el.dataset.panel === "bonus" ? t("LOOTCRATES.Scratch.BonusCovered") : t("LOOTCRATES.Scratch.PanelCovered", { n: i + 1 }));
    return { keep, label, role: el.getAttribute("role") };
  });
  const grid = ticket?.querySelector(".lc-scratch__grid");
  if (buyer) {
    grid?.setAttribute("role", "group");
    grid?.setAttribute("aria-label", t("LOOTCRATES.Scratch.PanelsLabel", { name: reveal?.box?.name ?? "" }));
    for (const el of els) el.setAttribute("role", "button");
  }
  // On a match 3 card the panels of each winning symbol, lit together.
  const winners = new Set(card ? cardWins(card).winners : []);
  const groupOf = i => (card?.layout === "match3" && winners.has(i) ? [...winners].filter(k => card.panels[k]?.symbol === card.panels[i]?.symbol) : [i]);
  const isOpen = new Set();
  const light = i => { if (held[i]?.keep.length) els[i].classList.add(...held[i].keep); };
  const onOpen = (i, info) => {
    isOpen.add(i);
    els[i].setAttribute("aria-label", held[i].label);
    const group = groupOf(i);
    if (group.every(k => isOpen.has(k))) group.forEach(light);
    try { onPanel?.(i, info); } catch (err) { console.error("loot-crates | a scratch panel's cue failed", err); }
  };
  const land = () => {
    // The card is still and whole: a list again, read as it is printed.
    if (buyer) {
      grid?.setAttribute("role", "list");
      grid?.removeAttribute("aria-label");
      els.forEach((el, i) => { if (held[i].role) el.setAttribute("role", held[i].role); else el.removeAttribute("role"); });
    }
    done();
  };
  const foil = mountFoil(ticket ?? host, { cols: Number(card?.cols) || 1, buyer, reducedMotion, duration, sounds, onOpen, onLand: land });
  host.querySelector(".lc-scratch__all")?.addEventListener("click", () => foil.revealAll());
  return foil;
}

// The coin win's sting: the four rising notes the approved mockup plays,
// which are the rarity sting's at Rare.
const COIN_STING = "rare";

/*
  The kind's play: the buyer (this client's user bought it, and this isn't
  a replay) scratches; the table, and every replay, watches it scratch
  itself. The rasp and the panel's tick play on the interface channel
  while the setting is on and the page is in view.
*/
function play(host, reveal, { sound = false, pageHidden = () => false, onLand, buyer = false, replay = false } = {}) {
  const hear = () => sound && !pageHidden();
  return mountScratch(host, {
    reveal,
    buyer: buyer && !replay && !reveal.replay,
    sounds: { scratch: speed => (hear() ? playScratch(speed) : null), tick: () => { if (hear()) playFoilTick(); } },
    onLand,
  });
}

/*
  What the chat card keeps for Watch again (revealcard.js replaySnapshot):
  the card, its place in the roll, who scratched which game and what it
  paid. Display only: no uuid, no purse, so a replay can neither open the
  item nor say what gold is left. A few hundred bytes.
*/
function snapshot(reveal) {
  const card = cleanCard(reveal?.card);
  if (!card) return null;
  const outcome = outcomeOf(reveal);
  const r = reveal.result ?? null;
  return {
    card, outcome, payoutCp: Math.max(0, Math.round(Number(reveal.payoutCp) || 0)),
    ticket: cleanTicket(reveal.ticket),
    box: { name: String(reveal.box?.name ?? ""), price: Number(reveal.box?.price) || 0 },
    actorName: String(reveal.actorName ?? ""),
    result: outcome === "item" && r ? { name: String(r.name ?? ""), rarity: RARITIES.includes(r.rarity) ? r.rarity : "common", img: String(r.img ?? "") } : outcome === "coins" ? { name: String(r?.name ?? ""), outcome: "coins" } : null,
  };
}

// The reveal a replay plays from a stored snapshot (anything can be in a
// message's flags), or null when it can't be played.
function fromSnapshot(s) {
  const card = cleanCard(s?.card);
  if (!card) return null;
  const outcome = ["item", "coins", "nothing"].includes(s.outcome) ? s.outcome : "nothing";
  const r = s.result;
  return {
    card, outcome, payoutCp: Math.max(0, Math.round(Number(s.payoutCp) || 0)),
    ticket: cleanTicket(s.ticket),
    box: { name: String(s.box?.name ?? ""), price: Number(s.box?.price) || 0 },
    actorName: String(s.actorName ?? ""),
    result: outcome === "item" && r?.name ? { name: String(r.name), rarity: RARITIES.includes(r.rarity) ? r.rarity : "common", img: String(r.img ?? "") } : outcome === "coins" ? { name: String(r?.name ?? ""), outcome: "coins" } : null,
  };
}

const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
const cleanTicket = tk => (tk && int(tk.rollId, 1, 1e9) && int(tk.no, 1, 1e9) && int(tk.size, 1, 1e9) ? { rollId: tk.rollId, no: tk.no, size: tk.size } : null);
const cleanPrize = p => (p?.item ? (RARITIES.includes(p.item) ? { item: p.item, ...(p.name ? { name: String(p.name) } : {}), ...(p.img ? { img: String(p.img) } : {}) } : null) : Number.isFinite(p?.gp) && p.gp >= 0 ? { gp: p.gp } : null);

/*
  A card as layCard makes it, checked field by field and copied, or null:
  a known layout, a grid inside its limits with a panel for every cell,
  whole numbers and coin or item prizes on lucky numbers, known symbols
  on match 3.
*/
export function cleanCard(card) {
  if (!card || !LAYOUTS.includes(card.layout)) return null;
  const lim = GRID_LIMITS[card.layout];
  const cols = int(card.cols, lim.cols[0], lim.cols[1]), rows = int(card.rows, lim.rows[0], lim.rows[1]);
  if (!cols || !rows || !Array.isArray(card.panels) || card.panels.length !== cols * rows) return null;
  if (card.layout === "match3") {
    if (!Array.isArray(card.key) || card.key.length > MAX_PRIZES) return null;
    const key = card.key.map(k => (SYMBOLS.includes(k?.symbol) ? { symbol: k.symbol, prize: cleanPrize(k.prize) } : null));
    const panels = card.panels.map(p => (SYMBOLS.includes(p?.symbol) ? { symbol: p.symbol } : null));
    if (key.some(k => !k?.prize) || panels.some(p => !p)) return null;
    return { layout: "match3", cols, rows, key, panels };
  }
  if (!Array.isArray(card.lucky) || !card.lucky.length || card.lucky.length > 8 || card.lucky.some(n => !int(n, 1, 999))) return null;
  const panels = card.panels.map(p => (int(p?.n, 1, 999) && cleanPrize(p.prize) ? { n: p.n, prize: cleanPrize(p.prize) } : null));
  if (panels.some(p => !p)) return null;
  const bonus = card.bonus && Number.isFinite(card.bonus.gp) ? { gp: card.bonus.gp, win: !!card.bonus.win } : null;
  return { layout: "lucky", cols, rows, lucky: [...card.lucky], panels, bonus };
}

// "Tam scratches Fortune Ticket 5 gp".
function head(reveal, { esc }) {
  return t("LOOTCRATES.Scratch.Head", {
    who: `<span class="lc-reveal__who">${esc(reveal.actorName)}</span>`,
    crate: `<strong class="lc-reveal__crate">${esc(reveal.box.name)}</strong>`,
    price: `<span class="lc-reveal__price">${esc(formatPrice(reveal.box.price))}</span>`,
  });
}

// "Won 25 gp across 2 panels" / "Won 25 gp": what the card paid in coins.
const coinsLine = reveal => {
  const n = cardWins(reveal.card).winners.length;
  const price = formatPrice((reveal.payoutCp ?? 0) / 100);
  return n > 1 ? t("LOOTCRATES.Scratch.WonAcross", { price, count: n }) : t("LOOTCRATES.Scratch.Won", { price });
};
const leftAfter = reveal => (reveal.ticket ? ticketsLeftText(Math.max(0, reveal.ticket.size - reveal.ticket.no), reveal.ticket.size) : "");

/*
  What the window says once the card is open, into its live region: an
  item the crate's way; coins as a line with where they went; a dud as a
  quiet line. The buyer and GMs see the gold left; everyone the tickets
  left in the roll (the roll's state, not the purse's).
*/
function result(reveal, { esc = String, canSee = false } = {}) {
  const outcome = outcomeOf(reveal);
  const left = leftAfter(reveal) ? [esc(leftAfter(reveal))] : [];
  if (outcome === "item" && reveal.result?.rarity) return resultHTML(reveal, { esc, canSee, extra: left });
  const where = [];
  if (outcome === "coins") where.push(t("LOOTCRATES.Scratch.IntoPurse", { price: esc(formatPrice((reveal.payoutCp ?? 0) / 100)), name: esc(reveal.actorName) }));
  if (canSee && reveal.purse) where.push(`<span class="lc-reveal__gold">${t("LOOTCRATES.Reveal.GoldLeft", { gold: esc(formatGold(reveal.purse)) })}</span>`);
  where.push(...left);
  return `<div class="lc-reveal__quiet">${esc(outcome === "coins" ? coinsLine(reveal) : t("LOOTCRATES.Scratch.DudLine"))}</div>`
    + (where.length ? `<div class="lc-reveal__where">${where.join(" · ")}</div>` : "");
}

// The card's sting once every panel is open: an item's rarity sting, a
// coin win's four rising notes, a dud's two low falling ones (the plop),
// as the mockup ends a win and a dud.
function sting(reveal) {
  const outcome = outcomeOf(reveal);
  if (outcome === "item") playReveal(reveal.result?.rarity);
  else if (outcome === "coins") playReveal(COIN_STING);
  else playPlop();
}

// The buyer's own word on a dud, in case the window sits behind the shop.
const notice = reveal => (outcomeOf(reveal) === "nothing" && !reveal.replay ? t("LOOTCRATES.Scratch.DudNotice", { name: reveal.box.name }) : null);

/*
  Another ticket from the window (the core's again button): "Another ticket
  for 5 gp" while the roll has tickets, off with the reason when it is sold
  out, the shop is shut or the purse is short. The tickets left are the
  log's, or this reveal's own count when the log hasn't caught up yet.
*/
function again(reveal, { game = null, log = [], pools = {}, purse = {}, open = true, gmOnline = true } = {}) {
  if (!game || reveal.replay) return null;
  const st = rollState(game, log);
  const sameRoll = reveal.ticket && reveal.ticket.rollId === st.id;
  const soldOut = st.soldOut || (sameRoll && reveal.ticket.no >= reveal.ticket.size);
  const why = soldOut ? t("LOOTCRATES.Card.SoldOut") : rollReason(game, pools, log);
  const price = Number(game.price) || 0;
  const off = why || shopReason({ hasActor: true, open, gmOnline }) || (!canAfford(purse, price) ? t("LOOTCRATES.Card.Needs", { price: formatPrice(shortfall(purse, price)) }) : "");
  return { price, label: t("LOOTCRATES.Scratch.AnotherFor", { price: formatPrice(price) }), off };
}

/*
  Every ticket posts a card, a dud too (a dud is still a ticket, and the
  card turning up tells nobody anything). Its words sit in the block the
  core seals until this client's card is open: the small card with the
  winning panels marked, and what it paid.
*/
function chatCard(reveal, { esc, itemLink }) {
  const outcome = outcomeOf(reveal);
  const r = reveal.result ?? {};
  const swatch = outcome === "item" ? r.rarity ?? "common" : outcome === "coins" ? "coin" : "none";
  const name = outcome === "item" ? itemLink(reveal.itemUuid ?? r.uuid, r.name) : esc(outcome === "coins" ? formatPrice((reveal.payoutCp ?? 0) / 100) : t("LOOTCRATES.Scratch.Dud"));
  const line = outcome === "item" ? esc(RARITY_LABEL[r.rarity] ?? r.rarity ?? "") : esc(outcome === "coins" ? coinsLine(reveal) : t("LOOTCRATES.Scratch.DudLine"));
  return `
    <div class="loot-crates lc-chat lc-rarity-${esc(swatch)}">
      <div class="lc-chat__head">${t("LOOTCRATES.Scratch.ChatHead", { actor: esc(reveal.actorName), box: `<strong>${esc(reveal.box.name)}</strong>`, price: `<span class="lc-chat__price">${esc(formatPrice(reveal.box.price))}</span>` })}</div>
      <div class="lc-chat__item">
        ${outcome === "item" && r.img ? `<img src="${esc(r.img)}" alt="">` : ""}${miniHTML(reveal.card)}
        <div>
          <div class="lc-chat__name">${name}</div>
          <div class="lc-chat__rarity">${line}</div>
        </div>
      </div>
    </div>`;
}

/* ---------- The shop card ---------- */

const TICKET_ART = `<svg class="lc-scratch__icon" viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.5h18v3a1.6 1.6 0 0 0 0 3v3H3v-3a1.6 1.6 0 0 0 0-3z"/><path d="M8 10h3M8 14h3" stroke-linecap="round"/><path d="M14 9.5h4v5h-4z" fill="currentColor" fill-opacity=".35"/></svg>`;

/*
  The roll as the shop shows it, a row per prize: its name, a bar of what
  is left of it and "2 of 5"; a prize gone from the roll struck through.
  The tickets left lead, and the odds of what is left and the guarantee
  follow. `st` is rollState's (or the counts held from before a draw).
*/
export function prizeListHTML(st, esc = s => String(s ?? "")) {
  const row = (name, left, count, cls = "") => {
    const gone = !left;
    const pct = count ? Math.round((left / count) * 100) : 0;
    return `<li class="lc-scratch__tier${gone ? " lc-scratch__tier--gone" : ""}${cls ? ` ${cls}` : ""}"><span class="lc-scratch__tier-name">${gone ? `<s>${esc(name)}</s>` : esc(name)}</span><span class="lc-scratch__bar" aria-hidden="true"><i style="width:${pct}%"></i></span><span class="lc-scratch__count">${esc(t("LOOTCRATES.Scratch.LeftOf", { left, count }))}</span></li>`;
  };
  if (!st.prizes.length) return "";
  return `<ul class="lc-scratch__prizes" aria-label="${esc(t("LOOTCRATES.Scratch.PrizesLeft"))}">${st.prizes.map(p => row(prizeText(p), p.left, p.count, `lc-rarity-${prizeSwatch(p)}`)).join("")}</ul>`;
}

// The roll's state as this client should show it: the log's, or the
// counts from before the oldest ticket of it still being opened here,
// whoever bought it (reveal.js heldBefore: the shop's hold), so the table's
// shops don't strike a prize from the list before the card is open.
export function shownState(game, ctx = {}) {
  const st = rollState(game, ctx.log ?? []);
  const held = ctx.heldBefore?.(game.id)?.scratch ?? (ctx.held?.(game.id) ? ctx.stateOf?.(game.id)?.scratch : null);
  if (!held || held.rollId !== st.id) return st;
  return { ...st, left: held.left, soldOut: held.left <= 0, prizes: st.prizes.map(p => ({ ...p, left: held.prizes?.[p.key] ?? p.left })) };
}

// Why this ticket game can't be bought now, or "": a ticket of it still
// being opened here, the roll sold out, or what is left waiting on items.
function scratchState(game, pools, ctx) {
  if (ctx.held?.(game.id)) return t("LOOTCRATES.Scratch.StillScratching");
  return rollReason(game, pools, ctx.log ?? []);
}

function card(game, pools, ctx) {
  const esc = ctx.esc ?? (s => String(s ?? ""));
  const st = shownState(game, ctx);
  const odds = rollOdds(st.prizes, st.left, Number(game.price) || 0);
  const reason = scratchState(game, pools, ctx) || shortReason(game, ctx);
  const top = odds.top;
  const middle = [
    `<div class="lc-box__stock">${esc(st.soldOut ? t("LOOTCRATES.Scratch.RollSoldOut", { roll: rollName(st.id) }) : ticketsLeftText(st.left, st.size))}</div>`,
    prizeListHTML(st, esc),
    !st.soldOut ? `<div class="lc-box__rule">${esc(oddsText(odds))}</div>` : "",
  ].filter(Boolean);
  return cardShell(game, ctx, { rarityClass: top?.kind === "item" ? `lc-rarity-${top.rarity}` : "lc-box--scratch", art: TICKET_ART, middle, reason, label: t("LOOTCRATES.Scratch.BuyFor", { price: esc(formatPrice(game.price)) }) });
}

const reason = (game, pools, ctx) => scratchState(game, pools, ctx) || shopReason(ctx) || shortReason(game, ctx);

/* ---------- The manager's words ---------- */

// "Lucky numbers 4 × 3, bonus 25 gp, roll 2: 43 of 100 left": the rules cell.
export function scratchRulesText(game, log = []) {
  const { cols, rows } = gridOf(game);
  const st = rollState(game, log);
  const bonus = bonusOf(game);
  return [
    t("LOOTCRATES.Scratch.RuleLayout", { layout: LAYOUT_LABEL[layoutOf(game)], cols, rows }),
    bonus.on ? t("LOOTCRATES.Scratch.RuleBonus", { price: formatPrice(bonus.gp) }) : "",
    st.soldOut ? t("LOOTCRATES.Scratch.RollSoldOut", { roll: rollName(st.id) }) : t("LOOTCRATES.Scratch.RuleRoll", { roll: rollName(st.id), left: ticketsLeftText(st.left, st.size) }),
  ].filter(Boolean).join(", ");
}

// The Boxes table's odds cell: each prize left as a pill, "25 gp 3/5". An
// item or bonus prize's pill ("Very rare item 1/1", "Bonus, 25 gp 3/3")
// wraps inside itself, as an auction's lot does, so it never widens the
// table past where its rows stack.
export function scratchOddsHTML(game, log = []) {
  const st = rollState(game, log);
  if (!st.prizes.length) return "";
  return `<div class="lc-box__odds">${st.prizes.map(p => `<span class="lc-odd${p.kind === "gp" ? "" : " lc-odd--wrap"} lc-rarity-${prizeSwatch(p)}">${prizeText(p)} ${p.left}/${p.count}</span>`).join("")}</div>`;
}

// The roll that Print a new roll starts: the next id, the same prize list.
export const nextRoll = game => ({ ...(game.roll ?? {}), id: rollOf(game).id + 1 });

/* ---------- The editor ---------- */

// What a prize row's choice is: coins, an item at a rarity, or the bonus spot.
const whatOf = p => (p.bonus ? "bonus" : p.item ? `item.${p.item.rarity}` : "gp");
export const PRIZE_FIELDS = {
  count: n => t("LOOTCRATES.Scratch.PrizeCount", { n }),
  what: n => t("LOOTCRATES.Scratch.PrizeWhat", { n }),
  gp: n => t("LOOTCRATES.Scratch.PrizeGp", { n }),
};

// One row of the prize list: "[12] tickets win [Coins] [10] gp", remove.
export function prizeRowHTML(p, n, id, esc = s => String(s ?? "")) {
  const what = whatOf(p);
  const options = [["gp", t("LOOTCRATES.Scratch.WhatCoins")], ...RARITIES.map(r => [`item.${r}`, t("LOOTCRATES.Scratch.ItemPrize", { rarity: RARITY_LABEL[r] })]), ["bonus", t("LOOTCRATES.Scratch.WhatBonus")]];
  return `<div class="lc-prize-row" data-prize="${esc(id)}" data-what="${esc(what.startsWith("item.") ? "item" : what)}">
      <input type="hidden" name="prizes" value="${esc(id)}">
      <input class="lc-prize-row__count" name="z.${esc(id)}.count" type="number" min="0" step="1" value="${esc(p.count ?? 1)}" aria-label="${esc(PRIZE_FIELDS.count(n))}">
      <select class="lc-prize-row__what" name="z.${esc(id)}.what" aria-label="${esc(PRIZE_FIELDS.what(n))}">${options.map(([v, l]) => `<option value="${v}"${v === what ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>
      <input class="lc-prize-row__gp" name="z.${esc(id)}.gp" type="number" min="0" step="1" value="${esc(p.gp ?? "")}" placeholder="${t("LOOTCRATES.Manager.GpPlaceholder")}" aria-label="${esc(PRIZE_FIELDS.gp(n))}">
      <button type="button" class="lc-prize-row__remove" aria-label="${esc(t("LOOTCRATES.Scratch.RemovePrize", { n }))}" data-tooltip="${t("LOOTCRATES.Pools.Remove")}"><i class="fas fa-xmark" inert></i></button>
    </div>`;
}

/*
  The editor's own fields, between the price and the pools: the layout,
  the grid, the bonus spot (lucky numbers only), the roll's size and its
  prize list as rows (Add prize, a remove on each), then the readout the
  live preview fills. The manager and the harness draw this one copy and
  wire it with wireScratchEditor.
*/
export function scratchFieldsHTML(game, { esc = s => String(s ?? ""), sold = 0 } = {}) {
  const layout = layoutOf(game);
  const { cols, rows } = gridOf(game);
  const bonus = { on: !!game?.bonus?.on, gp: toGp(game?.bonus?.gp) || SCRATCH_DEFAULTS.bonusGp };
  const roll = game?.roll ?? {};
  const id = esc(game?.id ?? "new");
  const lim = GRID_LIMITS[layout];
  return `
      <fieldset class="lc-scratch-form__layout"><legend>${t("LOOTCRATES.Scratch.LayoutLegend")}</legend>
        ${LAYOUTS.map(l => `<div class="lc-mode"><label class="lc-row lc-mode__pick"><input type="radio" name="layout" value="${l}"${l === layout ? " checked" : ""} aria-describedby="lc-layout-${id}-${l}"> ${LAYOUT_LABEL[l]}</label>
          <p class="lc-form__hint lc-mode__hint" id="lc-layout-${id}-${l}">${t(l === "lucky" ? "LOOTCRATES.Scratch.LayoutLuckyHint" : "LOOTCRATES.Scratch.LayoutMatch3Hint")}</p></div>`).join("")}
        <div class="lc-row lc-row--wrap">${t("LOOTCRATES.Scratch.GridRow", {
          cols: `<input name="cols" type="number" min="${lim.cols[0]}" max="${lim.cols[1]}" step="1" value="${cols}" aria-label="${t("LOOTCRATES.Scratch.GridCols")}">`,
          rows: `<input name="rows" type="number" min="${lim.rows[0]}" max="${lim.rows[1]}" step="1" value="${rows}" aria-label="${t("LOOTCRATES.Scratch.GridRows")}">`,
        })}</div>
        <div class="lc-row lc-row--wrap lc-scratch-form__bonus"${layout === "lucky" ? "" : " hidden"}><label class="lc-field"><input type="checkbox" name="bonusOn"${bonus.on ? " checked" : ""}> ${t("LOOTCRATES.Scratch.BonusField")}</label> <input name="bonusGp" type="number" min="0" step="1" value="${esc(bonus.gp)}" aria-label="${t("LOOTCRATES.Scratch.BonusGp")}"> gp</div>
      </fieldset>
      <fieldset class="lc-prizes"><legend>${t("LOOTCRATES.Scratch.RollLegend")}</legend>
        <label class="lc-row">${t("LOOTCRATES.Scratch.RollSize", { input: `<input name="size" type="number" min="1" step="1" value="${esc(rollOf(game).size)}">` })}</label>
        ${sold ? `<p class="lc-form__hint">${t("LOOTCRATES.Scratch.LiveRoll", { roll: rollName(rollOf(game).id), sold })}</p>` : ""}
        <div class="lc-prizes__head" aria-hidden="true"><span>${t("LOOTCRATES.Scratch.HeadTickets")}</span><span>${t("LOOTCRATES.Scratch.HeadPrize")}</span><span>${t("LOOTCRATES.Manager.GoldHead")}</span><span></span></div>
        <div class="lc-prizes__rows">${(roll.prizes ?? []).map((p, i) => prizeRowHTML(p, i + 1, `p${i}`, esc)).join("")}</div>
        <div class="lc-prizes__foot"><button type="button" class="lc-prizes__add"><i class="fas fa-plus"></i> ${t("LOOTCRATES.Scratch.AddPrize")}</button></div>
        <p class="lc-form__hint">${t("LOOTCRATES.Scratch.PrizesHint")}</p>
      </fieldset>`;
}

// The editor's values as a record: the layout, the grid, the bonus spot and the roll.
export function draftScratch(game, values, poolIds) {
  const layout = LAYOUTS.includes(values.layout) ? values.layout : layoutOf(game);
  const ids = [].concat(values.prizes ?? []).map(String).filter(Boolean);
  const prizes = ids.map(id => {
    const what = String(values[`z.${id}.what`] ?? "gp");
    const count = Math.max(0, Math.floor(Number(values[`z.${id}.count`]) || 0));
    if (what === "bonus") return { count, bonus: true };
    if (what.startsWith("item.")) return { count, item: { rarity: what.slice(5) } };
    return { count, gp: toGp(values[`z.${id}.gp`]) };
  });
  const on = v => v === true || v === "on";
  const grid = gridOf({ layout, grid: { cols: values.cols, rows: values.rows } });
  return {
    ...draftBox(game, values, poolIds),
    kind: "scratch",
    price: parsePrice(values.price) ?? Math.max(0, Number(values.price) || 0),
    layout, grid,
    bonus: { on: on(values.bonusOn), gp: toGp(values.bonusGp) },
    roll: { ...(game.roll ?? {}), id: rollOf(game).id, size: Math.max(0, Math.floor(Number(values.size) || 0)), prizes },
  };
}

/*
  The live readout beside the prize list: the odds of the roll as printed
  ("1 in 2.3 tickets wins, the top prize (Rare item) 1 in 100, all prizes
  5 gp or more"), the duds, and what would stop a ticket being sold: more
  prizes than tickets (the roll grows to fit), an item prize with no pool
  ticked or none at its rarity, a bonus prize with no bonus spot.
*/
export function scratchPreview(game, pools = {}) {
  const roll = rollOf(game);
  const odds = rollOdds(roll.prizes, roll.size, Number(game.price) || 0);
  const notes = [];
  const asked = Math.max(0, Math.floor(Number(game?.roll?.size) || 0));
  if (roll.size > asked) notes.push({ text: t("LOOTCRATES.Scratch.RollGrows", { count: roll.size, size: asked }) });
  const items = roll.prizes.filter(p => p.kind === "item");
  const held = poolRarities(game, pools);
  if (items.length && !game.pools?.length) notes.push({ text: t("LOOTCRATES.Scratch.NoPool"), warn: true });
  else for (const p of items) if (!held.has(p.rarity)) notes.push({ text: t("LOOTCRATES.Scratch.NoneAtRarity", { rarity: RARITY_LABEL[p.rarity] ?? p.rarity }), warn: true });
  if ((game?.roll?.prizes ?? []).some(p => p?.bonus && Number(p.count) > 0) && !bonusOf(game).on) notes.push({ text: t("LOOTCRATES.Scratch.BonusOff"), warn: true });
  return { roll, odds, notes, held };
}

export function scratchPreviewHTML(preview, esc = s => String(s ?? "")) {
  const { roll, odds, notes } = preview;
  const duds = roll.size ? `<p class="lc-form__hint">${esc(t(roll.duds === 1 ? "LOOTCRATES.Scratch.DudsOne" : "LOOTCRATES.Scratch.DudsMany", { count: roll.duds, size: roll.size }))}</p>` : "";
  return `<p class="lc-scratch-form__readout">${esc(oddsText(odds))}</p>${duds}${notes.map(n => `<p class="lc-form__hint${n.warn ? " lc-form__hint--warn" : ""}">${esc(n.text)}</p>`).join("")}`;
}

export const scratchSummary = preview => [oddsText(preview.odds), ...preview.notes.map(n => n.text)].join(". ");

/*
  The editor's moving parts, plain DOM so the harness wires the same:
  Add prize puts a row at the foot (its count focused; no more than
  MAX_PRIZES, the button off with the reason), a row's remove takes it
  (focus to the next row, else Add prize) and renumbers the rest, a row's
  choice shows its gold field only for coins, and the layout shows the
  bonus spot for lucky numbers only and moves a grid still at the other
  layout's default to its own. `newId()` names a new row; `paint()`
  redraws the readout.
*/
export function wireScratchEditor(form, { newId, paint = () => {} } = {}) {
  const rows = form.querySelector(".lc-prizes__rows");
  const add = form.querySelector(".lc-prizes__add");
  if (!rows || !add) return;
  const renumber = () => {
    [...rows.children].forEach((row, i) => {
      for (const key of Object.keys(PRIZE_FIELDS)) row.querySelector(`.lc-prize-row__${key}`)?.setAttribute("aria-label", PRIZE_FIELDS[key](i + 1));
      row.querySelector(".lc-prize-row__remove")?.setAttribute("aria-label", t("LOOTCRATES.Scratch.RemovePrize", { n: i + 1 }));
    });
    const full = rows.childElementCount >= MAX_PRIZES;
    if (full) { add.setAttribute("aria-disabled", "true"); add.title = t("LOOTCRATES.Scratch.PrizesFull", { max: MAX_PRIZES }); }
    else { add.removeAttribute("aria-disabled"); add.removeAttribute("title"); }
  };
  add.addEventListener("click", () => {
    if (rows.childElementCount >= MAX_PRIZES) return;
    rows.insertAdjacentHTML("beforeend", prizeRowHTML({ count: 1, gp: "" }, rows.childElementCount + 1, newId()));
    rows.lastElementChild.querySelector(".lc-prize-row__count")?.focus();
    renumber();
    paint();
  });
  form.addEventListener("click", e => {
    const btn = e.target.closest?.(".lc-prize-row__remove");
    if (!btn) return;
    const row = btn.closest(".lc-prize-row");
    const next = row.nextElementSibling ?? row.previousElementSibling;
    row.remove();
    renumber();
    (next?.querySelector(".lc-prize-row__count") ?? add).focus();
    paint();
  });
  form.addEventListener("change", e => {
    const what = e.target.closest?.(".lc-prize-row__what");
    if (what) what.closest(".lc-prize-row").dataset.what = what.value.startsWith("item.") ? "item" : what.value;
    if (e.target.matches?.('input[name="layout"]')) {
      const layout = e.target.value;
      const bonus = form.querySelector(".lc-scratch-form__bonus");
      if (bonus) bonus.hidden = layout !== "lucky";
      const other = GRID_DEFAULTS[layout === "lucky" ? "match3" : "lucky"];
      const cols = form.querySelector('input[name="cols"]'), rowsIn = form.querySelector('input[name="rows"]');
      if (cols && rowsIn && Number(cols.value) === other.cols && Number(rowsIn.value) === other.rows) { cols.value = GRID_DEFAULTS[layout].cols; rowsIn.value = GRID_DEFAULTS[layout].rows; }
      const lim = GRID_LIMITS[layout];
      cols?.setAttribute("max", lim.cols[1]);
      rowsIn?.setAttribute("max", lim.rows[1]);
      paint();
    }
  });
  renumber();
}

export const SCRATCH = registerKind({
  id: "scratch",
  noun: "scratch",
  roll,
  logRow,
  revealExtra,
  gotText,
  reveal: {
    get title() { return t("LOOTCRATES.Scratch.Title"); },
    head,
    play,
    result,
    sting,
    notice,
    again,
    snapshot,
    fromSnapshot,
    replayable: true,
  },
  // Every ticket posts one, a dud too, so the seal shows its head with "Opening…".
  chat: { card: chatCard },
  shop: { card, reason },
});
