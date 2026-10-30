/*
  Scratch tickets: the seventh kind of game (kinds.js, VIB-188), a printed
  roll of tickets with a fixed prize structure. The GM prints N tickets
  with so many of each prize line, the rest duds. A line is what one
  ticket wins, as real games print them: one part (coins, an item at a
  rarity from the pools, or the bonus spot's gem) or several at once
  ("Flame Tongue + 25 gp + the gem", two items). Each Buy draws one
  ticket from what is left of the roll, without replacement, so a ticket
  that pays twice is exactly as rare as the GM printed it; the shop shows
  the tickets and prizes still in it, unless the GM hides what is left
  from players (showsLeft), which keeps the counts out of the reveal
  every player's browser is sent too. Sold out is a real state, and the
  GM's Print a new roll starts the next. Fill the prize list
  (scratchplan.js) builds a prize list from a few numbers for the GM to
  edit.

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
    other symbol at most twice. Every part of a line is laid out: each
    coin and item part on a winning panel of its own (under a lucky
    number of its own; a match 3 card's three of a kind of its own
    symbol), the gem in the bonus spot. cardWins reads a card's wins back
    from its layout alone, and the tests hold it to the decided line.
  - Each item of a line is resolved from the pools at its rarity the
    crate's way (crate.js drawItem, grantData) and granted in the core's
    one creation (`grants`), logged on one row and refunded together;
    coins and the gem through the core's one settle() (payoutCp). A line
    whose items the ticked pools can't give is left in the roll and not
    drawn until they can, so a ticket never promises what it can't hand
    over.
  - The reveal is the scratch (mountScratch, the foil in views/foil.js):
    the buyer rubs the foil off with a coin, panel by panel, and everyone
    else watches the same coin scratch the card by itself; the card lands
    when every panel is open. The result never depends on the scratching.
    Watch again replays it as the table saw it, from the chat card's
    snapshot.
  - The ticket's look is the approved mockup's (.council/fortune-ticket-
    mockup.html, research 5b), the reference scratchies' anatomy in the
    module's own paper and gold: a dark header band in the ticket's colour
    with a holographic sheen, the name in gold chrome between a d20 and a
    potion flask, a chevron ribbon naming the top prize and the roll's
    prizes, caption strips, coin lucky numbers, near-square panels with
    the number centred and the prize as a pill, the bonus spot framed as
    an EXTRA box, ornamented corners and a foot with the roll line, the
    tagline and the guarantee. Four colour themes (THEMES), picked in the
    editor; the card carries its theme and the ribbon's facts, so every
    client and every replay prints the same ticket. CSS and inline SVG
    only, in module.css.

  Record: { kind: "scratch", price, pools, weights, layout: "lucky" |
  "match3", grid: { cols, rows }, bonus: { on, gp } (lucky only), theme
  (THEMES, "hoard" when unset), showLeft (false hides what is left from
  players), roll: { id, size, prizes: [{ count, parts: [{ gp } | { item:
  { rarity } } | { bonus: true }, ...] }] }, rules }; a prize row from
  before lines ({ count, gp } | { count, item } | { count, bonus }) reads
  as a line of its one part (rowParts). A roll's duds are its size less
  its prizes.

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
import { priceTag } from "./ticket.js";
import { t, words, listAnd } from "../core/i18n.js";

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
// The ticket's colours, the mockup's four: each a deep colour and a metal
// (module.css sets them on .lc-scratch[data-theme]). Dragon's hoard is
// crimson and gold, Fey market green and silver, Arcane violet and gold,
// Royal mint navy and gold.
export const THEMES = ["hoard", "fey", "arcane", "mint"];
export const THEME_LABEL = words({ hoard: "LOOTCRATES.Scratch.ThemeHoard", fey: "LOOTCRATES.Scratch.ThemeFey", arcane: "LOOTCRATES.Scratch.ThemeArcane", mint: "LOOTCRATES.Scratch.ThemeMint" });
export const themeOf = game => (THEMES.includes(game?.theme) ? game.theme : "hoard");

/*
  What a New scratch ticket starts as: the approved mockup's Fortune
  Ticket, 5 gp a ticket, lucky numbers on a 4 x 3 grid with a 25 gp bonus
  spot, a roll of 100. Its prize list is Fill the prize list's at its own
  defaults (newgame.js, scratchplan.js generatePrizeLines).
*/
export const SCRATCH_DEFAULTS = {
  price: 5, layout: "lucky", bonusGp: 25, size: 100, theme: "hoard",
};

const clampInt = (v, [lo, hi], fallback) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
};
const toGp = v => Math.round(Math.max(0, Number(v) || 0) * 100) / 100;

/* ---------- The record ---------- */

export const layoutOf = game => (LAYOUTS.includes(game?.layout) ? game.layout : "lucky");

// Whether players see what is left in the roll (the editor's switch, on
// unless the GM turned it off): the tickets left, the prizes left and the
// odds of what is left. The GM always sees them.
export const showsLeft = game => game?.showLeft !== false;

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

// A prize line pays at most this many parts (an item, coins, the gem...).
export const MAX_PARTS = 4;

/*
  A prize row's parts as written: a row is a prize line, { count, parts:
  [{ gp } | { item: { rarity } } | { bonus: true }, ...] }, and one ticket
  of it wins every part. A row from before lines ({ count, gp } | { count,
  item } | { count, bonus }) reads as a line of its one part, and is
  written back as a line only when the GM saves the editor.
*/
export function rowParts(row) {
  if (!row) return [];
  if (Array.isArray(row.parts)) return row.parts.slice(0, MAX_PARTS);
  if (row.bonus) return [{ bonus: true }];
  if (row.item) return [{ item: row.item }];
  return [{ gp: row.gp }];
}

// One part in the shape the roll reads, or null for a part of nothing
// (coins of 0), or false for one the game can't pay (an item at no
// rarity, the gem with no bonus spot), which keeps its whole line out.
function partOf(p, bonus) {
  if (p?.bonus) return bonus.on ? { key: "bonus", kind: "bonus", gp: bonus.gp } : false;
  if (p?.item) return RARITIES.includes(p.item.rarity) ? { key: `item.${p.item.rarity}`, kind: "item", rarity: p.item.rarity } : false;
  return toGp(p?.gp) > 0 ? { key: `gp.${toGp(p.gp)}`, kind: "gp", gp: toGp(p.gp) } : null;
}

// Best first: items by rarity, then coins by amount, then the gem.
const partRank = p => (p.kind === "item" ? 2e9 + rarityRank(p.rarity) : p.kind === "gp" ? p.gp : -1);
const byPart = (a, b) => partRank(b) - partRank(a);

/*
  A row as a prize line: { key, kind, count, parts, items, gp, rarity? },
  or null when it pays nothing or can't be paid. `parts` are best first
  and `key` names them ("gp.25", "item.rare+gp.25+bonus"), so a line of
  one part keeps the key its tier always had and old log rows still
  count. `kind` is the part's kind on a line of one part, else "line";
  `items` the rarities of its items, `gp` its coins with the gem's added.
*/
export function lineOf(row, bonus) {
  const count = Math.max(0, Math.floor(Number(row?.count) || 0));
  if (!count) return null;
  const read = rowParts(row).map(p => partOf(p, bonus));
  if (read.includes(false)) return null;
  const parts = read.filter(Boolean).sort(byPart);
  if (!parts.length) return null;
  const items = parts.filter(p => p.kind === "item").map(p => p.rarity);
  const gp = Math.round(parts.filter(p => p.kind !== "item").reduce((n, p) => n + p.gp, 0) * 100) / 100;
  return { key: parts.map(p => p.key).join("+"), kind: parts.length === 1 ? parts[0].kind : "line", count, parts, items, gp, ...(items.length ? { rarity: items[0] } : {}) };
}

// Lines best first: the best item, then more items, then the coins (a
// line of the gem alone last, as the bonus tier always was).
const lineRank = l => (l.kind === "bonus" ? -1 : l.gp);
const byLine = (a, b) => (b.items.length ? 1 + rarityRank(b.items[0]) : 0) - (a.items.length ? 1 + rarityRank(a.items[0]) : 0) || b.items.length - a.items.length || lineRank(b) - lineRank(a);

/*
  Why the card can't show a line, or "". Lucky numbers put each coin and
  item part on a panel of its own, so a line needs a panel a part (a 3 x 1
  card has three, and a line can pay four). Match 3 makes each part a
  three of a kind of its own symbol, so two parts the same can't be told
  apart, and the card needs room for three panels a part.
*/
export function lineMisfit(line, game) {
  const paying = line.parts.filter(p => p.kind !== "bonus");
  const { cols, rows } = gridOf(game);
  if (layoutOf(game) !== "match3") return paying.length > cols * rows ? "panels" : "";
  if (new Set(paying.map(p => p.key)).size < paying.length) return "twins";
  return paying.length * 3 > cols * rows ? "room" : "";
}

/*
  The prize list as prize lines, merged by what they pay and best first:
  [{ key, kind: "item" | "gp" | "bonus" | "line", count, parts, items,
  gp, rarity? }]. A row of 0 tickets, a line paying nothing, an item at no
  rarity, the gem with no bonus spot, or a line the card can't show
  (lineMisfit) is left out; past MAX_PRIZES lines the rest are, and on a
  match 3 card any line whose parts would need more symbols than the key
  has room for (MAX_PRIZES).
*/
export function prizesOf(game) {
  const bonus = bonusOf(game);
  const by = new Map();
  for (const row of game?.roll?.prizes ?? []) {
    const line = lineOf(row, bonus);
    if (!line || lineMisfit(line, game)) continue;
    const had = by.get(line.key);
    if (had) had.count += line.count;
    else by.set(line.key, line);
  }
  const lines = [...by.values()].sort(byLine);
  if (layoutOf(game) !== "match3") return lines.slice(0, MAX_PRIZES);
  const keys = new Set();
  return lines.filter(l => {
    const more = l.parts.filter(p => !keys.has(p.key));
    if (keys.size + more.length > MAX_PRIZES) return false;
    for (const p of more) keys.add(p.key);
    return true;
  }).slice(0, MAX_PRIZES);
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

// The unrefunded rows of this roll at this game: the tickets sold. A
// ticket bought to keep (row.keep) is drawn from the roll when it is used,
// not when it is bought.
export const rollRows = (log, { boxId, rollId }) => (log ?? []).filter(r => r?.kind === "scratch" && r.boxId === boxId && Number(r.rollId) === rollId && !r.refunded && !r.keep);
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
  each: every prize line still in the roll that can be handed over (a
  line with items only while the pools hold an item at each of their
  rarities), and the duds. `blocked` counts the tickets left whose items
  the pools can't give, which wait in the roll.
*/
export function drawBag(game, pools, log = []) {
  const st = rollState(game, log);
  const held = poolRarities(game, pools);
  const bag = [];
  let blocked = 0;
  for (const p of st.prizes) {
    if (!p.left) continue;
    if (p.items.some(r => !held.has(r))) { blocked += p.left; continue; }
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

// One part's words: "25 gp", "Rare item", and the gem "Bonus, 25 gp" on
// its own or "the gem (25 gp)" beside other parts.
const partText = (p, alone = true) => {
  if (p.kind === "item") return t("LOOTCRATES.Scratch.ItemPrize", { rarity: RARITY_LABEL[p.rarity] ?? p.rarity });
  if (p.kind === "bonus") return t(alone ? "LOOTCRATES.Scratch.BonusPrize" : "LOOTCRATES.Scratch.GemPart", { price: formatPrice(p.gp) });
  return formatPrice(p.gp);
};

// A prize line's words: "25 gp", "Rare item", "Bonus, 25 gp", or its
// parts joined, "Rare item + 25 gp + the gem (25 gp)".
export function prizeText(p) {
  const parts = p.parts ?? [p];
  return parts.map(q => partText(q, parts.length === 1)).join(t("LOOTCRATES.Scratch.Plus"));
}
// A line's colour: its best item's rarity, else the coin.
const prizeSwatch = p => (p.items?.[0] ?? (p.kind === "item" ? p.rarity : "coin"));
const hasItem = p => (p.items ? p.items.length > 0 : p.kind === "item");

// "4.2", "100": one in how many, a decimal under ten.
export function oneIn(total, n) {
  if (!(n > 0) || !(total > 0)) return null;
  const v = total / n;
  return v >= 10 ? String(Math.round(v)) : String(+v.toFixed(1));
}

/*
  The odds of a set of tickets, as the editor (the whole roll as printed)
  and the shop (what is left of it) say them: { tickets, wins, oneIn,
  top, topOneIn, floor }. A ticket wins one line, so `wins` counts lines.
  `top` is the best line with any left (an item over coins); `floor` the
  least coins any winning line pays in all, when every line pays at least
  the ticket's price (a line with an item counts as more), else null.
*/
export function rollOdds(prizes, tickets, price = 0) {
  const live = prizes.filter(p => (p.left ?? p.count) > 0);
  const n = p => p.left ?? p.count;
  const wins = live.reduce((s, p) => s + n(p), 0);
  const top = live[0] ?? null;
  const coins = live.filter(p => !hasItem(p)).map(p => p.gp);
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
  The parts a decided ticket won, whatever shape `win` came in: a prize
  line { kind: "line", parts: [{ kind: "gp", gp } | { kind: "item",
  rarity, name?, img? } | { kind: "bonus" }] }, or one prize as it always
  was: { kind: "dud" } | { kind: "gp", gp } | { kind: "bonus" } | { kind:
  "item", rarity, name, img }.
*/
export function winParts(win) {
  if (!win || win.kind === "dud") return [];
  if (win.kind === "line") return (win.parts ?? []).filter(p => ["gp", "item", "bonus"].includes(p?.kind));
  return [win];
}

/*
  The card for a decided ticket, laid out with `rng` (the roll's, so it is
  the GM's alone and every client is sent the result). `win` is what the
  ticket won (winParts): every part of its line is laid out, each coin
  and item part on a winning panel of its own, the gem in the bonus spot.
  The roll's own prizes dress the losing panels, so a dud looks like the
  tickets around it.

  Lucky numbers: { layout: "lucky", cols, rows, lucky: [n], panels: [{ n,
  prize: { gp } | { item: rarity, name?, img? } }], bonus: { gp, win } or
  null }. Match 3: { layout: "match3", cols, rows, key: [{ symbol, prize
  }], panels: [{ symbol }] }. Which panels win is not written on the card:
  cardWins reads it from the layout, as a player does. Every card also
  carries its print: `theme` and `prizes` (rollPrizes), what the ribbon
  and the foot say of the roll.
*/
export function layCard(game, win, rng = Math.random) {
  const { cols, rows } = gridOf(game);
  const cells = cols * rows;
  const prizes = prizesOf(game);
  const parts = prizes.flatMap(l => l.parts);
  const coinValues = [...new Set(parts.filter(p => p.kind === "gp").map(p => p.gp))];
  const itemRarities = [...new Set(parts.filter(p => p.kind === "item").map(p => p.rarity))];
  const won = winParts(win);
  const card = layoutOf(game) === "match3" ? layMatch3(won, { cols, rows, cells, prizes, rng }) : layLucky(game, won, { cols, rows, cells, coinValues, itemRarities, rng });
  return { ...card, theme: themeOf(game), prizes: rollPrizes(game) };
}

/*
  What the ticket prints of its roll: { top: { gp } | { item: rarity } |
  { parts: [{ gp } | { item: rarity } | { bonus: gp }] } (a line of
  several) | null (the best prize), gp (every coin and gem the roll pays,
  added up), items (the items it pays), floor (the least any win pays,
  when every prize pays the ticket's price or more, else null) }.
*/
export function rollPrizes(game) {
  const roll = rollOf(game);
  const top = roll.prizes[0] ?? null;
  const gp = Math.round(roll.prizes.reduce((n, p) => n + p.gp * p.count, 0) * 100) / 100;
  const items = roll.prizes.reduce((n, p) => n + p.items.length * p.count, 0);
  const printed = !top ? null
    : top.parts.length > 1 ? { parts: top.parts.map(p => (p.kind === "item" ? { item: p.rarity } : p.kind === "bonus" ? { bonus: p.gp } : { gp: p.gp })) }
    : top.kind === "item" ? { item: top.rarity } : { gp: top.gp };
  return { top: printed, gp, items, floor: rollOdds(roll.prizes, roll.size, Number(game?.price) || 0).floor };
}

// "620 gp and 1 item in prizes in this roll": the ribbon's second line, or "" on a roll with none.
export function ribbonTotalText(prizes) {
  const gp = Number(prizes?.gp) || 0, items = Math.max(0, Math.floor(Number(prizes?.items) || 0));
  const price = formatPrice(gp);
  if (gp > 0 && items > 0) return t(items === 1 ? "LOOTCRATES.Scratch.TotalGpItem" : "LOOTCRATES.Scratch.TotalGpItems", { price, count: items });
  if (gp > 0) return t("LOOTCRATES.Scratch.TotalGp", { price });
  if (items > 0) return t(items === 1 ? "LOOTCRATES.Scratch.TotalItem" : "LOOTCRATES.Scratch.TotalItems", { count: items });
  return "";
}

/*
  What a roll pays back: { pct (the coins and the gem it pays out, as a
  share of the coins it takes in, the price times its size), paid, taken
  (gp), items (the items it pays, counted apart: they aren't coins) },
  or null for a roll that takes nothing in.
*/
export function paybackOf(game) {
  const taken = toGp((Number(game?.price) || 0) * rollOf(game).size);
  if (!(taken > 0)) return null;
  const { gp, items } = rollPrizes(game);
  return { pct: Math.round((gp / taken) * 100), paid: gp, taken, items };
}

// "Pays back 65% in coins: 325 gp of the 500 gp the roll takes in, plus 1 item".
export function paybackText(pb) {
  if (!pb) return "";
  const data = { pct: pb.pct, paid: formatPrice(pb.paid), taken: formatPrice(pb.taken), count: pb.items };
  if (!pb.items) return t("LOOTCRATES.Scratch.Payback", data);
  return t(pb.items === 1 ? "LOOTCRATES.Scratch.PaybackItem" : "LOOTCRATES.Scratch.PaybackItems", data);
}

function layLucky(game, won, { cols, rows, cells, coinValues, itemRarities, rng }) {
  const nLucky = luckyCount(cells);
  const all = shuffle(Array.from({ length: numberRange(cells) }, (_, i) => i + 1), rng);
  const lucky = all.slice(0, nLucky);
  const others = all.slice(nLucky);
  // The winning panels: a coin prize alone on one panel or split across
  // two that add up; every other part on a panel of its own.
  const shown = won.filter(p => p.kind !== "bonus");
  let wins;
  if (won.length === 1 && won[0].kind === "gp") {
    const splits = cells >= 2 ? splitsOf(won[0].gp, coinValues) : [];
    wins = splits.length && rng() < SPLIT_CHANCE ? pickOne(splits, rng).map(gp => ({ gp })) : [{ gp: won[0].gp }];
  } else wins = shown.map(p => (p.kind === "gp" ? { gp: p.gp } : { item: p.rarity, name: p.name ?? "", img: p.img ?? "" }));
  const at = shuffle(Array.from({ length: cells }, (_, i) => i), rng).slice(0, wins.length);
  // Each win under a lucky number of its own; only a line with more wins
  // than the card has lucky numbers shares one.
  const luckyFor = shuffle(lucky, rng);
  // What a losing panel shows: one of the roll's own prizes, or, on a roll
  // with none, a few times the ticket's price.
  const price = Math.max(1, Number(game?.price) || 1);
  const dress = [...coinValues.map(gp => ({ gp })), ...itemRarities.map(item => ({ item }))];
  const fill = dress.length ? dress : [price, price * 2, price * 5].map(gp => ({ gp: toGp(gp) }));
  let k = 0;
  const panels = Array.from({ length: cells }, (_, i) => {
    const w = at.indexOf(i);
    if (w >= 0) return { n: luckyFor[w % luckyFor.length], prize: wins[w] };
    return { n: others[k++], prize: { ...pickOne(fill, rng) } };
  });
  const bonus = bonusOf(game);
  return { layout: "lucky", cols, rows, lucky, panels, bonus: bonus.on ? { gp: bonus.gp, win: won.some(p => p.kind === "bonus") } : null };
}

// The match 3 card's key: every coin amount and item rarity the roll's
// lines pay, best first, a symbol each; the symbols left over pay nothing.
export function keyOf(prizes) {
  const seen = new Map();
  for (const line of prizes) for (const p of line.parts) if (p.kind !== "bonus" && !seen.has(p.key)) seen.set(p.key, p);
  return [...seen.values()].sort(byPart).slice(0, MAX_PRIZES).map((p, i) => ({ symbol: SYMBOLS[i], prize: p.kind === "item" ? { item: p.rarity } : { gp: p.gp } }));
}

function layMatch3(won, { cols, rows, cells, prizes, rng }) {
  const key = keyOf(prizes);
  const symbolFor = w => key.find(k => (w.kind === "item" ? k.prize.item === w.rarity : k.prize.gp === w.gp))?.symbol;
  // The triples this ticket shows: one for each part of its line, or, for
  // a coin prize alone, two coin prizes that add up to it on a card with
  // room for both.
  const paying = won.filter(p => p.kind === "gp" || p.kind === "item");
  let triples = [];
  if (paying.length === 1) {
    const [w] = paying;
    const own = symbolFor(w);
    const splits = won.length === 1 && w.kind === "gp" && cells >= 6 ? splitsOf(w.gp, key.filter(k => k.prize.gp).map(k => k.prize.gp)).filter(([a, b]) => a !== b) : [];
    if (splits.length && rng() < SPLIT_CHANCE) triples = pickOne(splits, rng).map(gp => symbolFor({ kind: "gp", gp }));
    else if (own) triples = [own];
  } else triples = paying.map(symbolFor).filter(Boolean);
  const panels = [];
  for (const s of triples) panels.push(s, s, s);
  // Every other symbol at most twice, drawn at random to fill the card.
  const room = shuffle(SYMBOLS.filter(s => !triples.includes(s)).flatMap(s => [s, s]), rng);
  while (panels.length < cells) panels.push(room.pop());
  return { layout: "match3", cols, rows, key, panels: shuffle(panels, rng).map(symbol => ({ symbol })) };
}

/*
  What a card wins, read from its layout alone, as a player reads it:
  { cp (the coins, summed, the gem's included), items (each winning item
  panel's prize, or each matched item symbol's), item (the first, or
  null), winners (the panels that win), bonus (the bonus spot won) }.
*/
export function cardWins(card) {
  const out = { cp: 0, items: [], item: null, winners: [], bonus: false };
  if (!card) return out;
  if (card.layout === "match3") {
    const counts = new Map();
    for (const p of card.panels) counts.set(p.symbol, (counts.get(p.symbol) ?? 0) + 1);
    for (const k of card.key ?? []) {
      if ((counts.get(k.symbol) ?? 0) < 3) continue;
      card.panels.forEach((p, i) => { if (p.symbol === k.symbol) out.winners.push(i); });
      if (k.prize.item) out.items.push({ item: k.prize.item });
      else out.cp += Math.round(k.prize.gp * 100);
    }
    out.winners.sort((a, b) => a - b);
    out.item = out.items[0] ?? null;
    return out;
  }
  card.panels.forEach((p, i) => {
    if (!card.lucky.includes(p.n)) return;
    out.winners.push(i);
    if (p.prize.item) out.items.push(p.prize);
    else out.cp += Math.round((p.prize.gp ?? 0) * 100);
  });
  if (card.bonus?.win) { out.bonus = true; out.cp += Math.round(card.bonus.gp * 100); }
  out.item = out.items[0] ?? null;
  return out;
}

/* ---------- The roll ---------- */

/*
  The draw, on the GM, before anything is charged: the roll's state from
  the log as it stands inside the write queue, one ticket drawn from what
  is left by weight (each prize line as many times as it has tickets
  left, the duds as many), then the card laid out for it. A line wins
  every one of its parts: each item drawn from the pools at its rarity
  the crate's way (missing sources reported and passed over) and granted
  in the core's one creation (`grants` when there are several), the coins
  and the gem added up into the one settle(). The ticket's place in the
  roll and what was left before it ride into the reveal and the row; a
  game whose players don't see what is left (showsLeft) marks the ticket
  hidden and keeps the counts off the reveal (revealExtra), so no
  player's browser is sent them.
*/
async function roll(ctx) {
  const { game, rng, log = [] } = ctx;
  const { state, bag } = drawBag(game, ctx.pools, log);
  if (state.soldOut) throw new PullError(t("LOOTCRATES.Scratch.SoldOutError", { name: game.name }));
  if (!bag.length) throw new PullError(t("LOOTCRATES.Scratch.WaitingError", { name: game.name }));
  const line = weightedPick(bag, p => p.weight, rng) ?? bag[0];
  const shown = showsLeft(game);
  const ticket = { rollId: state.id, tier: line.key, no: state.sold + 1, size: state.size, ...(shown ? {} : { hidden: true }) };
  const common = { ticket, ...(shown ? { left: leftOf(state) } : {}), grant: null };
  if (line.kind === "dud") return { ...common, outcome: "nothing", card: layCard(game, { kind: "dud" }, rng), result: null };
  let pools = ctx.pools;
  const granted = [];
  for (const rarity of line.items) {
    const only = { ...game, weights: Object.fromEntries(RARITIES.map(r => [r, r === rarity ? 1 : 0])), rules: {} };
    const drawn = await drawItem({ ...ctx, pools, game: only, state: {} });
    if (!drawn.result || drawn.result.rarity !== rarity) throw new PullError(t("LOOTCRATES.Scratch.WaitingError", { name: game.name }));
    pools = drawn.pools;
    granted.push(grantData(drawn.source, { ...drawn.result, pity: false }, game));
  }
  // The line's parts as won, each item named for its panel.
  let next = 0;
  const parts = line.parts.map(p => {
    if (p.kind !== "item") return p.kind === "gp" ? { kind: "gp", gp: p.gp } : { kind: "bonus" };
    const r = granted[next++].result;
    return { kind: "item", rarity: p.rarity, name: r.name, img: r.img };
  });
  const card = layCard(game, { kind: "line", parts }, rng);
  const payoutCp = Math.round(line.gp * 100);
  if (granted.length) {
    const wonItems = granted.map(g => ({ uuid: g.result.uuid, name: g.result.name, img: g.result.img, rarity: g.result.rarity }));
    return {
      ...common, ...granted[0], outcome: "item", card, pools, wonItems,
      ...(granted.length > 1 ? { grants: granted.map(g => g.grant) } : {}),
      ...(payoutCp ? { payoutCp } : {}),
    };
  }
  return { ...common, outcome: "coins", card, result: { name: formatPrice(line.gp), outcome: "coins" }, payoutCp };
}

// What the shop shows of a roll: its counts as they stood, by tier key.
const leftOf = st => ({ rollId: st.id, size: st.size, left: st.left, prizes: Object.fromEntries(st.prizes.map(p => [p.key, p.left])) });

// The row: the roll and the tier it took (what rollState counts), the
// winning panels, and for an item the crate's columns so the one refund
// finds and removes it; a line of several items is named by them all
// ("Flame Tongue and Lucky Coin"), so the Pull log says what was won.
// A dud is the core's miss (the Pull log folds them).
function logRow(ctx) {
  const { out } = ctx;
  const base = { rollId: out.ticket.rollId, tier: out.ticket.tier, ticketNo: out.ticket.no, winners: cardWins(out.card).winners };
  const names = itemsWon(out).map(i => i.name);
  if (out.outcome === "item") return { ...base, ...crateLogRow(ctx), ...(names.length > 1 ? { name: listAnd(names) } : {}) };
  if (out.outcome === "coins") return { ...base, outcome: "coins", swatch: "coin", name: out.result.name };
  return { ...base, outcome: "nothing", swatch: "none", name: t("LOOTCRATES.Scratch.Dud") };
}

/*
  The card and what the roll held before this ticket: the shop holds its
  counts there until this client's card is open (reveal.js heldState), so
  a top prize going from the list doesn't tell the table first. A game
  whose players don't see what is left sends no counts at all, since the
  broadcast reaches every player's browser: the ticket by its roll alone
  (no place in the roll, no size, no prize line) and nothing for a shop to
  hold, which a hidden card doesn't show anyway.
*/
function revealExtra({ state = {}, out }) {
  if (out.ticket?.hidden) return { card: out.card, ticket: { rollId: out.ticket.rollId, hidden: true } };
  return { card: out.card, ticket: out.ticket, stateBefore: { ...state, scratch: out.left } };
}

// The items a ticket won, { name, rarity, img, uuid? } each: a line's
// several, or the one item a ticket from before lines names.
export const itemsWon = r => (Array.isArray(r?.wonItems) && r.wonItems.length ? r.wonItems : r?.outcome === "item" && r.result?.name ? [r.result] : []);

// "won 25 gp", "won Sling +2", "won Flame Tongue and 25 gp", "scratched a
// dud": the late-cancel line.
function gotText(out) {
  const names = itemsWon(out).map(i => i.name);
  const cp = Math.max(0, Math.round(Number(out?.payoutCp) || 0));
  if (out?.outcome === "item" && names.length) return t("LOOTCRATES.Scratch.GotItem", { name: listAnd([...names, ...(cp ? [formatPrice(cp / 100)] : [])]) });
  if (out?.outcome === "coins") return t("LOOTCRATES.Scratch.GotCoins", { price: formatPrice((out.payoutCp ?? 0) / 100) });
  return t("LOOTCRATES.Scratch.GotDud");
}

/* ---------- The ticket as markup ---------- */

const symbolText = s => SYMBOL_LABEL[s] ?? s;
// A panel's prize, or the ribbon's top prize: an item by name (or its
// rarity), coins, or a line of several joined ("Rare item + 25 gp + the gem (25 gp)").
const panelPrizeText = prize => {
  if (Array.isArray(prize?.parts)) return prize.parts.map(p => (p.bonus != null ? t("LOOTCRATES.Scratch.GemPart", { price: formatPrice(p.bonus) }) : panelPrizeText(p))).join(t("LOOTCRATES.Scratch.Plus"));
  return prize?.item ? (prize.name || t("LOOTCRATES.Scratch.ItemPrize", { rarity: RARITY_LABEL[prize.item] ?? prize.item })) : formatPrice(prize?.gp ?? 0);
};

// The band's emblems, the mockup's: a d20 on the left, a potion flask on
// the right, gold with a dark outline (the flask's draught in the ticket's
// deep colour). Inline SVG; nothing to load.
const EMBLEM_D20 = `<span class="lc-scratch__emblem" aria-hidden="true"><svg viewBox="0 0 48 48"><polygon points="24,3 43,14 43,34 24,45 5,34 5,14" class="lc-scratch__gold" stroke-width="2" stroke-linejoin="round"/><polygon points="24,12 36,31 12,31" class="lc-scratch__gold lc-scratch__gold--lite" stroke-width="1.6" stroke-linejoin="round"/><path d="M24 3 L24 12 M43 14 L36 31 M5 14 L12 31 M43 34 L36 31 M5 34 L12 31 M24 45 L24 31" class="lc-scratch__line" stroke-width="1.4"/><text x="24" y="27.5" text-anchor="middle" class="lc-scratch__emblem-text" font-weight="800" font-size="11">20</text></svg></span>`;
const EMBLEM_FLASK = `<span class="lc-scratch__emblem" aria-hidden="true"><svg viewBox="0 0 48 48"><path d="M10 30 C8 18 16 10 24 8 C32 10 40 18 38 30 L34 40 L14 40 Z" class="lc-scratch__gold" stroke-width="2" stroke-linejoin="round"/><path d="M14 40 L34 40 M12 26 C20 23 28 23 36 26" class="lc-scratch__line" stroke-width="1.6" fill="none"/><ellipse cx="24" cy="31" rx="5" ry="3.5" class="lc-scratch__draught" stroke-width="1.2"/><path d="M24 8 L22 3 M24 8 L26 3" class="lc-scratch__line" stroke-width="1.4"/></svg></span>`;
// The bonus spot's mark: the gem on a bonus ticket, a dashed ring on the rest.
const MARK_GEM = `<span class="lc-scratch__mark lc-scratch__mark--gem" aria-hidden="true"><svg viewBox="0 0 40 40"><path d="M8 14 L14 6 H26 L32 14 L20 34 Z" class="lc-scratch__gem" stroke-width="2" stroke-linejoin="round"/><path d="M8 14 H32 M14 6 L20 14 L26 6 M20 14 L20 34" class="lc-scratch__gold-line" stroke-width="1.5" fill="none"/></svg></span>`;
const MARK_NONE = `<span class="lc-scratch__mark" aria-hidden="true"><svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="12" fill="none" class="lc-scratch__gold-line" stroke-width="2" stroke-dasharray="4 3"/></svg></span>`;
const CORNERS = `<span class="lc-scratch__corner lc-scratch__corner--tl" aria-hidden="true"></span><span class="lc-scratch__corner lc-scratch__corner--tr" aria-hidden="true"></span><span class="lc-scratch__corner lc-scratch__corner--bl" aria-hidden="true"></span><span class="lc-scratch__corner lc-scratch__corner--br" aria-hidden="true"></span>`;

/*
  The ticket, open, as the mockup prints it: the corners, the band with
  the name between its emblems, the ribbon with the top prize and the
  roll's prizes, the caption strips, the lucky numbers as coins (or the
  symbols' key), the grid, the bonus spot in its EXTRA box, and the foot
  with the roll line, the tagline and the guarantee. The winning panels
  carry lc-scratch__panel--win; an item prize's pill carries its rarity.
  Every panel names itself for a screen reader. The scratch draws its
  foil over this markup. The ticket's theme rides on data-theme.
*/
export function ticketHTML(reveal, { esc = s => String(s ?? "") } = {}) {
  const card = reveal.card;
  if (!card) return "";
  const won = cardWins(card);
  const win = new Set(won.winners);
  const prizes = card.prizes ?? (card.layout === "match3" && card.key?.[0] ? { top: card.key[0].prize, gp: 0, items: 0, floor: null } : null);
  // A game whose players don't see what is left prints the roll's name
  // alone: "ticket 44 of 100" would tell them.
  const rollLine = !reveal.ticket ? "" : reveal.ticket.hidden ? rollName(reveal.ticket.rollId) : t("LOOTCRATES.Scratch.TicketOf", { roll: rollName(reveal.ticket.rollId), no: reveal.ticket.no, size: reveal.ticket.size });
  const grid = `style="--lc-cols:${Number(card.cols) || 1}"`;
  const cap = (a, b) => `<div class="lc-scratch__cap"><span>${a}</span>${b ? `<span>${b}</span>` : ""}</div>`;
  let body;
  if (card.layout === "match3") {
    const legend = (card.key ?? []).map(k => `<li class="lc-scratch__key-row lc-rarity-${esc(k.prize.item ?? "coin")}"><span class="lc-scratch__sym" data-symbol="${esc(k.symbol)}">${esc(symbolText(k.symbol))}</span> ${esc(panelPrizeText(k.prize))}</li>`).join("");
    body = `${cap(t("LOOTCRATES.Scratch.Match3Cap"))}
      <ul class="lc-scratch__key">${legend}</ul>
      ${cap(t("LOOTCRATES.Scratch.YoursCap"))}
      <div class="lc-scratch__grid" ${grid} role="list">${card.panels.map((p, i) => `<div class="lc-scratch__panel${win.has(i) ? " lc-scratch__panel--win" : ""}" role="listitem" data-panel="${i}" aria-label="${esc(t(win.has(i) ? "LOOTCRATES.Scratch.PanelSymbolWin" : "LOOTCRATES.Scratch.PanelSymbol", { n: i + 1, symbol: symbolText(p.symbol) }))}"><span class="lc-scratch__sym" data-symbol="${esc(p.symbol)}">${esc(symbolText(p.symbol))}</span></div>`).join("")}</div>`;
  } else {
    body = `${cap(t("LOOTCRATES.Scratch.LuckyCap"), t("LOOTCRATES.Scratch.LuckyHint"))}
      <div class="lc-scratch__lucky" role="list" aria-label="${esc(t("LOOTCRATES.Scratch.LuckyCap"))}">${card.lucky.map(n => `<span class="lc-scratch__ball" role="listitem">${esc(n)}</span>`).join("")}</div>
      ${cap(t("LOOTCRATES.Scratch.YoursCap"), t("LOOTCRATES.Scratch.WinsAddUp"))}
      <div class="lc-scratch__grid" ${grid} role="list">${card.panels.map((p, i) => `<div class="lc-scratch__panel${win.has(i) ? " lc-scratch__panel--win" : ""}${p.prize?.item ? ` lc-rarity-${esc(p.prize.item)}` : ""}" role="listitem" data-panel="${i}" aria-label="${esc(t(win.has(i) ? "LOOTCRATES.Scratch.PanelNumberWin" : "LOOTCRATES.Scratch.PanelNumber", { n: i + 1, number: p.n, prize: panelPrizeText(p.prize) }))}"><span class="lc-scratch__num">${esc(p.n)}</span><span class="lc-scratch__prize${p.prize?.item ? " lc-scratch__prize--item" : ""}">${esc(panelPrizeText(p.prize))}</span></div>`).join("")}</div>
      ${card.bonus ? `<div class="lc-scratch__bonus"><div class="lc-scratch__panel lc-scratch__spot${card.bonus.win ? " lc-scratch__panel--win" : ""}" data-panel="bonus" aria-label="${esc(card.bonus.win ? t("LOOTCRATES.Scratch.BonusSpotWin", { price: formatPrice(card.bonus.gp) }) : t("LOOTCRATES.Scratch.BonusSpot"))}">${card.bonus.win ? MARK_GEM : MARK_NONE}</div><div><div class="lc-scratch__extra">${esc(t("LOOTCRATES.Scratch.Extra", { price: formatPrice(card.bonus.gp) }))}</div><p>${esc(t("LOOTCRATES.Scratch.BonusHint"))}</p></div></div>` : ""}`;
  }
  const total = prizes ? ribbonTotalText(prizes) : "";
  const ribbon = prizes?.top || total
    ? `<div class="lc-scratch__ribbon">${prizes.top ? `<span>${esc(t("LOOTCRATES.Scratch.TopPrize"))}</span><strong>${esc(panelPrizeText(prizes.top))}</strong>` : ""}${total ? `<span>${esc(total)}</span>` : ""}</div>`
    : "";
  const foot = [
    rollLine ? `<span class="lc-scratch__roll">${esc(rollLine)}</span>` : "",
    `<span class="lc-scratch__tag">${esc(t("LOOTCRATES.Scratch.Tagline"))}</span>`,
    prizes?.floor != null ? `<span class="lc-scratch__guarantee">${esc(t("LOOTCRATES.Scratch.Guarantee", { price: formatPrice(prizes.floor) }))}</span>` : "",
  ].filter(Boolean).join("");
  return `<div class="lc-scratch__ticket" data-layout="${esc(card.layout)}" data-theme="${esc(THEMES.includes(card.theme) ? card.theme : "hoard")}">
      ${CORNERS}
      <div class="lc-scratch__band">${EMBLEM_D20}<span class="lc-scratch__title">${esc(reveal.box?.name ?? "")}</span>${EMBLEM_FLASK}</div>
      ${ribbon}
      ${body}
      <div class="lc-scratch__foot">${foot}</div>
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
  host.dataset.theme = THEMES.includes(card?.theme) ? card.theme : "hoard";
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
    ...(reveal.redeem ? { redeem: true } : {}),
    actorName: String(reveal.actorName ?? ""),
    result: outcome === "item" && r ? { name: String(r.name ?? ""), rarity: RARITIES.includes(r.rarity) ? r.rarity : "common", img: String(r.img ?? "") } : outcome === "coins" ? { name: String(r?.name ?? ""), outcome: "coins" } : null,
    ...(outcome === "item" && itemsWon(reveal).length > 1 ? { wonItems: cleanItems(itemsWon(reveal)) } : {}),
  };
}

// A line's items as a replay keeps them: name, rarity and art, no uuid.
const cleanItems = list => (Array.isArray(list) ? list.slice(0, MAX_PARTS) : []).filter(i => i?.name).map(i => ({ name: String(i.name), rarity: RARITIES.includes(i.rarity) ? i.rarity : "common", img: String(i.img ?? "") }));

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
    ...(s.redeem ? { redeem: {} } : {}),
    actorName: String(s.actorName ?? ""),
    result: outcome === "item" && r?.name ? { name: String(r.name), rarity: RARITIES.includes(r.rarity) ? r.rarity : "common", img: String(r.img ?? "") } : outcome === "coins" ? { name: String(r?.name ?? ""), outcome: "coins" } : null,
    ...(outcome === "item" && cleanItems(s.wonItems).length > 1 ? { wonItems: cleanItems(s.wonItems) } : {}),
  };
}

const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
// A hidden game's ticket names its roll alone (revealExtra), and keeps no count if it had one.
const cleanTicket = tk => (tk?.hidden && int(tk.rollId, 1, 1e9) ? { rollId: tk.rollId, hidden: true }
  : tk && int(tk.rollId, 1, 1e9) && int(tk.no, 1, 1e9) && int(tk.size, 1, 1e9) ? { rollId: tk.rollId, no: tk.no, size: tk.size } : null);
const cleanPrize = p => (p?.item ? (RARITIES.includes(p.item) ? { item: p.item, ...(p.name ? { name: String(p.name) } : {}), ...(p.img ? { img: String(p.img) } : {}) } : null) : Number.isFinite(p?.gp) && p.gp >= 0 ? { gp: p.gp } : null);

/*
  A card as layCard makes it, checked field by field and copied, or null:
  a known layout, a grid inside its limits with a panel for every cell,
  whole numbers and coin or item prizes on lucky numbers, known symbols
  on match 3; its print (a known theme, the ribbon's facts) kept where it
  is sound, else the default print.
*/
export function cleanCard(card) {
  if (!card || !LAYOUTS.includes(card.layout)) return null;
  const lim = GRID_LIMITS[card.layout];
  const cols = int(card.cols, lim.cols[0], lim.cols[1]), rows = int(card.rows, lim.rows[0], lim.rows[1]);
  if (!cols || !rows || !Array.isArray(card.panels) || card.panels.length !== cols * rows) return null;
  // A card from before the print carries no prizes: left null, so the
  // ticket falls back on its key for the top prize rather than printing
  // an empty ribbon.
  const print = { theme: THEMES.includes(card.theme) ? card.theme : "hoard", prizes: card.prizes ? cleanPrizes(card.prizes) : null };
  if (card.layout === "match3") {
    if (!Array.isArray(card.key) || card.key.length > MAX_PRIZES) return null;
    const key = card.key.map(k => (SYMBOLS.includes(k?.symbol) ? { symbol: k.symbol, prize: cleanPrize(k.prize) } : null));
    const panels = card.panels.map(p => (SYMBOLS.includes(p?.symbol) ? { symbol: p.symbol } : null));
    if (key.some(k => !k?.prize) || panels.some(p => !p)) return null;
    return { layout: "match3", cols, rows, key, panels, ...print };
  }
  if (!Array.isArray(card.lucky) || !card.lucky.length || card.lucky.length > 8 || card.lucky.some(n => !int(n, 1, 999))) return null;
  const panels = card.panels.map(p => (int(p?.n, 1, 999) && cleanPrize(p.prize) ? { n: p.n, prize: cleanPrize(p.prize) } : null));
  if (panels.some(p => !p)) return null;
  const bonus = card.bonus && Number.isFinite(card.bonus.gp) ? { gp: card.bonus.gp, win: !!card.bonus.win } : null;
  return { layout: "lucky", cols, rows, lucky: [...card.lucky], panels, bonus, ...print };
}

// The ribbon's facts as rollPrizes makes them, each checked, a doubtful one emptied.
const gpOf = v => (Number.isFinite(v) && v >= 0 ? v : 0);
const cleanTop = top => {
  if (Array.isArray(top?.parts)) {
    const parts = top.parts.slice(0, MAX_PARTS).map(p => (p?.bonus != null ? (Number.isFinite(p.bonus) && p.bonus >= 0 ? { bonus: p.bonus } : null) : cleanTop(p)));
    return parts.length && !parts.some(p => !p) ? { parts } : null;
  }
  return top?.item ? (RARITIES.includes(top.item) ? { item: top.item } : null) : Number.isFinite(top?.gp) && top.gp >= 0 ? { gp: top.gp } : null;
};
const cleanPrizes = p => ({
  top: cleanTop(p?.top),
  gp: gpOf(p?.gp), items: Math.max(0, Math.floor(Number(p?.items) || 0)), floor: Number.isFinite(p?.floor) && p.floor >= 0 ? p.floor : null,
});

// "Tam scratches Fortune Ticket 5 gp".
function head(reveal, { esc }) {
  return t("LOOTCRATES.Scratch.Head", {
    who: `<span class="lc-reveal__who">${esc(reveal.actorName)}</span>`,
    crate: `<strong class="lc-reveal__crate">${esc(reveal.box.name)}</strong>`,
    price: `<span class="lc-reveal__price">${esc(priceTag(reveal))}</span>`,
  });
}

// "Won 25 gp across 2 panels" / "Won 25 gp": what the card paid in coins.
// A win is counted once: on lucky numbers each matching panel is one (a
// split prize is two), on a match 3 card the three panels of a symbol are
// one match, so three gems read "Won 5 gp", never "across 3 panels".
// A line that pays an item too counts only its coin panels here.
const coinsLine = reveal => {
  const card = reveal.card;
  const winners = cardWins(card).winners.filter(i => (card.layout === "match3" ? card.key?.find(k => k.symbol === card.panels[i]?.symbol)?.prize.gp != null : !card.panels[i]?.prize?.item));
  const price = formatPrice((reveal.payoutCp ?? 0) / 100);
  if (card?.layout === "match3") {
    const matches = new Set(winners.map(i => card.panels[i]?.symbol)).size;
    return matches > 1 ? t("LOOTCRATES.Scratch.WonMatches", { price, count: matches }) : t("LOOTCRATES.Scratch.Won", { price });
  }
  return winners.length > 1 ? t("LOOTCRATES.Scratch.WonAcross", { price, count: winners.length }) : t("LOOTCRATES.Scratch.Won", { price });
};
const leftAfter = reveal => (reveal.ticket && !reveal.ticket.hidden ? ticketsLeftText(Math.max(0, reveal.ticket.size - reveal.ticket.no), reveal.ticket.size) : "");
const intoPurse = (reveal, esc) => t("LOOTCRATES.Scratch.IntoPurse", { price: esc(formatPrice((reveal.payoutCp ?? 0) / 100)), name: esc(reveal.actorName) });

/*
  What the window says once the card is open, into its live region: an
  item the crate's way; a line of several, every item it won by name with
  their rarities and the coins it paid into the purse; coins as a line
  with where they went; a dud as a quiet line. The buyer and GMs see the
  gold left; everyone the tickets left in the roll (the roll's state, not
  the purse's), unless the GM hides what is left from players.
*/
function result(reveal, { esc = String, canSee = false } = {}) {
  const outcome = outcomeOf(reveal);
  const left = leftAfter(reveal) ? [esc(leftAfter(reveal))] : [];
  const items = itemsWon(reveal);
  const coins = (reveal.payoutCp ?? 0) > 0;
  if (outcome === "item" && reveal.result?.rarity && items.length <= 1 && !coins) return resultHTML(reveal, { esc, canSee, extra: left });
  if (outcome === "item" && items.length) {
    const where = [];
    if (reveal.itemUuid) where.push(t("LOOTCRATES.Reveal.AddedTo", { name: esc(reveal.actorName) }));
    if (coins) where.push(intoPurse(reveal, esc));
    if (canSee && reveal.purse) where.push(`<span class="lc-reveal__gold">${t("LOOTCRATES.Reveal.GoldLeft", { gold: esc(formatGold(reveal.purse)) })}</span>`);
    where.push(...left);
    const rarities = [...new Set(items.map(i => RARITY_LABEL[i.rarity] ?? i.rarity))];
    return `<div class="lc-reveal__name">${esc(listAnd(items.map(i => i.name)))}</div>`
      + `<div class="lc-reveal__rarity">${esc(listAnd(rarities))}</div>`
      + (where.length ? `<div class="lc-reveal__where">${where.join(" · ")}</div>` : "");
  }
  const where = [];
  if (outcome === "coins") where.push(intoPurse(reveal, esc));
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
  winning panels marked, and what it paid: a line of several names each
  item it won, each linked to the copy on the sheet, and the coins.
*/
function chatCard(reveal, { esc, itemLink }) {
  const outcome = outcomeOf(reveal);
  const r = reveal.result ?? {};
  const swatch = outcome === "item" ? r.rarity ?? "common" : outcome === "coins" ? "coin" : "none";
  const items = outcome === "item" ? itemsWon(reveal) : [];
  const uuids = Array.isArray(reveal.itemUuids) ? reveal.itemUuids : [];
  const coins = (reveal.payoutCp ?? 0) > 0 ? [esc(formatPrice(reveal.payoutCp / 100))] : [];
  const name = items.length ? listAnd([...items.map((i, k) => itemLink(uuids[k] ?? (k === 0 ? reveal.itemUuid ?? r.uuid : i.uuid), i.name)), ...coins])
    : esc(outcome === "coins" ? formatPrice((reveal.payoutCp ?? 0) / 100) : t("LOOTCRATES.Scratch.Dud"));
  const line = items.length ? esc(listAnd([...new Set(items.map(i => RARITY_LABEL[i.rarity] ?? i.rarity ?? ""))])) : esc(outcome === "coins" ? coinsLine(reveal) : t("LOOTCRATES.Scratch.DudLine"));
  return `
    <div class="loot-crates lc-chat lc-rarity-${esc(swatch)}">
      <div class="lc-chat__head">${t("LOOTCRATES.Scratch.ChatHead", { actor: esc(reveal.actorName), box: `<strong>${esc(reveal.box.name)}</strong>`, price: `<span class="lc-chat__price">${esc(priceTag(reveal))}</span>` })}</div>
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

/*
  The shop's card. While players see what is left (showsLeft), and always
  for a GM: the tickets left, a row per prize line with what is left of
  it, and the odds of what is left. With the switch off a player's card
  says only what a printed ticket says, the top prize of the roll as
  printed and its guarantee, and the GM's says what players don't see.
*/
function card(game, pools, ctx) {
  const esc = ctx.esc ?? (s => String(s ?? ""));
  const st = shownState(game, ctx);
  const odds = rollOdds(st.prizes, st.left, Number(game.price) || 0);
  const reason = scratchState(game, pools, ctx) || shortReason(game, ctx);
  const label = t("LOOTCRATES.Scratch.BuyFor", { price: esc(formatPrice(game.price)) });
  const soldOutLine = `<div class="lc-box__stock">${esc(t("LOOTCRATES.Scratch.RollSoldOut", { roll: rollName(st.id) }))}</div>`;
  if (!showsLeft(game) && !ctx.isGM) {
    const printed = rollPrizes(game);
    const first = rollOf(game).prizes[0];
    const middle = [
      st.soldOut ? soldOutLine : "",
      printed.top ? `<div class="lc-box__rule">${esc(t("LOOTCRATES.Scratch.TopPrizeLine", { prize: panelPrizeText(printed.top) }))}</div>` : "",
      printed.floor != null ? `<div class="lc-box__rule">${esc(t("LOOTCRATES.Scratch.Guarantee", { price: formatPrice(printed.floor) }))}</div>` : "",
    ].filter(Boolean);
    return cardShell(game, ctx, { rarityClass: first?.items.length ? `lc-rarity-${first.items[0]}` : "lc-box--scratch", art: TICKET_ART, middle, reason, label });
  }
  const top = odds.top;
  const middle = [
    st.soldOut ? soldOutLine : `<div class="lc-box__stock">${esc(ticketsLeftText(st.left, st.size))}</div>`,
    prizeListHTML(st, esc),
    !st.soldOut ? `<div class="lc-box__rule">${esc(oddsText(odds))}</div>` : "",
    showsLeft(game) ? "" : `<div class="lc-box__rule lc-scratch__unseen">${esc(t("LOOTCRATES.Scratch.LeftHidden"))}</div>`,
  ].filter(Boolean);
  return cardShell(game, ctx, { rarityClass: top?.items?.length ? `lc-rarity-${top.items[0]}` : "lc-box--scratch", art: TICKET_ART, middle, reason, label });
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
    showsLeft(game) ? "" : t("LOOTCRATES.Scratch.RuleHidden"),
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

// What a part's choice is: coins, an item at a rarity, or the bonus spot.
const whatOf = p => (p?.bonus ? "bonus" : p?.item ? `item.${p.item.rarity}` : "gp");
const whatClass = what => (what.startsWith("item.") ? "item" : what);
// A prize's fields, named by its number; on a line of several parts, by
// the part's number in it too.
export const PRIZE_FIELDS = {
  count: n => t("LOOTCRATES.Scratch.PrizeCount", { n }),
  what: (n, k = 0) => (k ? t("LOOTCRATES.Scratch.PartWhat", { n, k }) : t("LOOTCRATES.Scratch.PrizeWhat", { n })),
  gp: (n, k = 0) => (k ? t("LOOTCRATES.Scratch.PartGp", { n, k }) : t("LOOTCRATES.Scratch.PrizeGp", { n })),
};

/*
  One part of prize n: [Coins | Rare item | The bonus spot] [10] gp, and
  its remove while the line has more than one. `k` is the part's number
  when the line has several, else 0.
*/
export function prizePartHTML(part, n, k, id, pid, esc = s => String(s ?? "")) {
  const what = whatOf(part);
  const options = [["gp", t("LOOTCRATES.Scratch.WhatCoins")], ...RARITIES.map(r => [`item.${r}`, t("LOOTCRATES.Scratch.ItemPrize", { rarity: RARITY_LABEL[r] })]), ["bonus", t("LOOTCRATES.Scratch.WhatBonus")]];
  return `<div class="lc-prize-part" data-part="${esc(pid)}" data-what="${esc(whatClass(what))}">
        <input type="hidden" name="z.${esc(id)}.parts" value="${esc(pid)}">
        <select class="lc-prize-row__what" name="z.${esc(id)}.${esc(pid)}.what" aria-label="${esc(PRIZE_FIELDS.what(n, k))}">${options.map(([v, l]) => `<option value="${v}"${v === what ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>
        <input class="lc-prize-row__gp" name="z.${esc(id)}.${esc(pid)}.gp" type="number" min="0" step="1" value="${esc(part?.gp ?? "")}" placeholder="${t("LOOTCRATES.Manager.GpPlaceholder")}" aria-label="${esc(PRIZE_FIELDS.gp(n, k))}">
        <button type="button" class="lc-prize-part__remove"${k ? "" : " hidden"} aria-label="${esc(t("LOOTCRATES.Scratch.RemovePart", { n, k: k || 1 }))}" data-tooltip="${t("LOOTCRATES.Pools.Remove")}"><i class="fas fa-minus" inert></i></button>
      </div>`;
}

/*
  One row of the prize list, a prize line: "[1] tickets win [Rare item]
  + [Coins] [25] gp + [The bonus spot]", Add a part under its parts (up to
  MAX_PARTS), and its remove. `p` is the row as stored, a line or a row
  from before lines.
*/
export function prizeRowHTML(p, n, id, esc = s => String(s ?? "")) {
  const parts = rowParts(p);
  const list = parts.length ? parts : [{ gp: "" }];
  const many = list.length > 1;
  const full = list.length >= MAX_PARTS;
  return `<div class="lc-prize-row" data-prize="${esc(id)}">
      <input type="hidden" name="prizes" value="${esc(id)}">
      <input class="lc-prize-row__count" name="z.${esc(id)}.count" type="number" min="0" step="1" value="${esc(p?.count ?? 1)}" aria-label="${esc(PRIZE_FIELDS.count(n))}">
      <div class="lc-prize-row__parts">
        ${list.map((part, i) => prizePartHTML(part, n, many ? i + 1 : 0, id, `${id}q${i}`, esc)).join("")}
        <button type="button" class="lc-prize-row__and" aria-label="${esc(t("LOOTCRATES.Scratch.AddPartTo", { n }))}"${full ? ` aria-disabled="true" title="${esc(t("LOOTCRATES.Scratch.PartsFull", { max: MAX_PARTS }))}"` : ""}><i class="fas fa-plus" inert></i> ${t("LOOTCRATES.Scratch.AddPart")}</button>
      </div>
      <button type="button" class="lc-prize-row__remove" aria-label="${esc(t("LOOTCRATES.Scratch.RemovePrize", { n }))}" data-tooltip="${t("LOOTCRATES.Pools.Remove")}"><i class="fas fa-xmark" inert></i></button>
    </div>`;
}

/*
  The editor's own fields, between the price and the pools: the layout,
  the grid, the bonus spot (lucky numbers only), the ticket's colours
  (Printed in, one of THEMES), the roll's size, the Fill the prize list
  fields when given (`fill`, scratchplan.js fillFieldsHTML) and the prize
  list as rows (Add prize, a remove on each), then the readout the live
  preview fills.
  The manager and the harness draw this one copy and wire it with
  wireScratchEditor.
*/
export function scratchFieldsHTML(game, { esc = s => String(s ?? ""), sold = 0, fill = "" } = {}) {
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
        <label class="lc-row lc-scratch-form__theme">${t("LOOTCRATES.Scratch.ThemeField")} <select name="theme">${THEMES.map(th => `<option value="${th}"${th === themeOf(game) ? " selected" : ""}>${esc(THEME_LABEL[th])}</option>`).join("")}</select></label>
      </fieldset>
      <fieldset class="lc-prizes"><legend>${t("LOOTCRATES.Scratch.RollLegend")}</legend>
        <label class="lc-row">${t("LOOTCRATES.Scratch.RollSize", { input: `<input name="size" type="number" min="1" step="1" value="${esc(rollOf(game).size)}">` })}</label>
        ${sold ? `<p class="lc-form__hint">${t("LOOTCRATES.Scratch.LiveRoll", { roll: rollName(rollOf(game).id), sold })}</p>` : ""}
        <div class="lc-scratch-form__left"><label class="lc-field"><input type="checkbox" name="showLeft"${showsLeft(game) ? " checked" : ""} aria-describedby="lc-left-${id}"> ${t("LOOTCRATES.Scratch.ShowLeftField")}</label>
          <p class="lc-form__hint" id="lc-left-${id}">${t("LOOTCRATES.Scratch.ShowLeftHint")}</p></div>
        ${fill}
        <div class="lc-prizes__head" aria-hidden="true"><span>${t("LOOTCRATES.Scratch.HeadTickets")}</span><span>${t("LOOTCRATES.Scratch.HeadPrize")}</span><span>${t("LOOTCRATES.Manager.GoldHead")}</span><span></span></div>
        <div class="lc-prizes__rows">${(roll.prizes ?? []).map((p, i) => prizeRowHTML(p, i + 1, `p${i}`, esc)).join("")}</div>
        <div class="lc-prizes__foot"><button type="button" class="lc-prizes__add"><i class="fas fa-plus"></i> ${t("LOOTCRATES.Scratch.AddPrize")}</button></div>
        <p class="lc-form__hint">${t("LOOTCRATES.Scratch.PrizesHint")}</p>
      </fieldset>`;
}

// A part as the editor's fields say it: the gem, an item at a rarity, or coins.
const partFrom = (what, gp) => {
  const w = String(what ?? "gp");
  if (w === "bonus") return { bonus: true };
  if (w.startsWith("item.")) return { item: { rarity: w.slice(5) } };
  return { gp: toGp(gp) };
};

/*
  The editor's values as a record: the layout, the grid, the bonus spot,
  the theme, whether players see what is left, and the roll, its rows
  written as prize lines ({ count, parts }). A row's parts are named by
  z.<row>.parts; a form from before lines (z.<row>.what, z.<row>.gp)
  reads as a line of one part.
*/
export function draftScratch(game, values, poolIds) {
  const layout = LAYOUTS.includes(values.layout) ? values.layout : layoutOf(game);
  const theme = THEMES.includes(values.theme) ? values.theme : themeOf(game);
  const ids = [].concat(values.prizes ?? []).map(String).filter(Boolean);
  const prizes = ids.map(id => {
    const count = Math.max(0, Math.floor(Number(values[`z.${id}.count`]) || 0));
    const pids = [].concat(values[`z.${id}.parts`] ?? []).map(String).filter(Boolean).slice(0, MAX_PARTS);
    const parts = pids.length ? pids.map(pid => partFrom(values[`z.${id}.${pid}.what`], values[`z.${id}.${pid}.gp`])) : [partFrom(values[`z.${id}.what`], values[`z.${id}.gp`])];
    return { count, parts };
  });
  const on = v => v === true || v === "on";
  const grid = gridOf({ layout, grid: { cols: values.cols, rows: values.rows } });
  return {
    ...draftBox(game, values, poolIds),
    kind: "scratch",
    price: parsePrice(values.price) ?? Math.max(0, Number(values.price) || 0),
    layout, grid, theme,
    bonus: { on: on(values.bonusOn), gp: toGp(values.bonusGp) },
    showLeft: "showLeft" in values ? on(values.showLeft) : showsLeft(game),
    roll: { ...(game.roll ?? {}), id: rollOf(game).id, size: Math.max(0, Math.floor(Number(values.size) || 0)), prizes },
  };
}

/*
  The live readout beside the prize list: the odds of the roll as printed
  ("1 in 2.3 tickets wins, the top prize (Rare item) 1 in 100, all prizes
  5 gp or more"), what it pays back (paybackOf), the duds, and what would stop a ticket being sold: more
  prizes than tickets (the roll grows to fit), an item prize with no pool
  ticked or none at its rarity, a bonus prize with no bonus spot. A line
  the card can't show (more winning parts than a lucky numbers card has
  panels; a match 3 card: two parts the same, no room for a three of a
  kind a part, more prizes than its key has symbols) is named
  by its number and `refused` is true: the editor keeps Save off until it
  fits, so no roll is printed that a card would show wrong.
*/
export function scratchPreview(game, pools = {}) {
  const roll = rollOf(game);
  const odds = rollOdds(roll.prizes, roll.size, Number(game.price) || 0);
  const notes = [];
  const asked = Math.max(0, Math.floor(Number(game?.roll?.size) || 0));
  if (roll.size > asked) notes.push({ text: t("LOOTCRATES.Scratch.RollGrows", { count: roll.size, size: asked }) });
  const rarities = [...new Set(roll.prizes.flatMap(p => p.items))];
  const held = poolRarities(game, pools);
  if (rarities.length && !game.pools?.length) notes.push({ text: t("LOOTCRATES.Scratch.NoPool"), warn: true });
  else for (const r of rarities) if (!held.has(r)) notes.push({ text: t("LOOTCRATES.Scratch.NoneAtRarity", { rarity: RARITY_LABEL[r] ?? r }), warn: true });
  const rows = game?.roll?.prizes ?? [];
  if (rows.some(p => Number(p?.count) > 0 && rowParts(p).some(q => q?.bonus)) && !bonusOf(game).on) notes.push({ text: t("LOOTCRATES.Scratch.BonusOff"), warn: true });
  const misfits = [];
  const match3 = layoutOf(game) === "match3";
  const { cols, rows: down } = gridOf(game);
  // The lines the roll prints; one that fits the card but isn't among
  // them is past what the match 3 key has symbols for.
  const kept = new Set(roll.prizes.map(l => l.key));
  rows.forEach((row, i) => {
    const line = lineOf(row, bonusOf(game));
    if (!line) return;
    const why = lineMisfit(line, game);
    const count = line.parts.filter(p => p.kind !== "bonus").length;
    if (why === "panels") misfits.push(t("LOOTCRATES.Scratch.LineNoPanels", { n: i + 1, count, cols, rows: down }));
    else if (why === "twins") misfits.push(t("LOOTCRATES.Scratch.LineTwins", { n: i + 1 }));
    else if (why === "room") misfits.push(t("LOOTCRATES.Scratch.LineNoRoom", { n: i + 1, count, cols, rows: down }));
    else if (match3 && !kept.has(line.key)) misfits.push(t("LOOTCRATES.Scratch.KeyFull", { n: i + 1, max: MAX_PRIZES }));
  });
  for (const text of misfits) notes.push({ text, warn: true });
  if (misfits.length) notes.push({ text: t("LOOTCRATES.Scratch.SaveOff"), warn: true });
  return { roll, odds, payback: paybackOf(game), notes, held, refused: misfits.length > 0 };
}

export function scratchPreviewHTML(preview, esc = s => String(s ?? "")) {
  const { roll, odds, notes } = preview;
  const duds = roll.size ? `<p class="lc-form__hint">${esc(t(roll.duds === 1 ? "LOOTCRATES.Scratch.DudsOne" : "LOOTCRATES.Scratch.DudsMany", { count: roll.duds, size: roll.size }))}</p>` : "";
  const payback = preview.payback ? `<p class="lc-scratch-form__payback">${esc(paybackText(preview.payback))}</p>` : "";
  return `<p class="lc-scratch-form__readout">${esc(oddsText(odds))}</p>${payback}${duds}${notes.map(n => `<p class="lc-form__hint${n.warn ? " lc-form__hint--warn" : ""}">${esc(n.text)}</p>`).join("")}`;
}

export const scratchSummary = preview => [oddsText(preview.odds), ...(preview.payback ? [paybackText(preview.payback)] : []), ...preview.notes.map(n => n.text)].join(". ");

/*
  The editor's moving parts, plain DOM so the harness wires the same:
  Add prize puts a row at the foot (its count focused; no more than
  MAX_PRIZES, the button off with the reason), a row's remove takes it
  (focus to the next row, else Add prize) and renumbers the rest; a row's
  Add a part puts another part on its line (its choice focused; no more
  than MAX_PARTS), a part's remove takes it (focus to the part before,
  else Add a part), and a line of one part has no part remove; a part's
  choice shows its gold field only for coins, and the layout shows the
  bonus spot for lucky numbers only and moves a grid still at the other
  layout's default to its own; rows written all at once (Fill, an
  "lc:prizes" event on the rows) are renumbered. `newId()` names a new row
  or part; `paint()` redraws the readout.
*/
export function wireScratchEditor(form, { newId, paint = () => {} } = {}) {
  const rows = form.querySelector(".lc-prizes__rows");
  const add = form.querySelector(".lc-prizes__add");
  if (!rows || !add) return;
  const off = (btn, full, why) => {
    if (full) { btn.setAttribute("aria-disabled", "true"); btn.title = why; }
    else { btn.removeAttribute("aria-disabled"); btn.removeAttribute("title"); }
  };
  const renumber = () => {
    [...rows.children].forEach((row, i) => {
      const n = i + 1;
      row.querySelector(".lc-prize-row__count")?.setAttribute("aria-label", PRIZE_FIELDS.count(n));
      row.querySelector(".lc-prize-row__remove")?.setAttribute("aria-label", t("LOOTCRATES.Scratch.RemovePrize", { n }));
      const parts = [...row.querySelectorAll(".lc-prize-part")];
      parts.forEach((part, j) => {
        const k = parts.length > 1 ? j + 1 : 0;
        part.querySelector(".lc-prize-row__what")?.setAttribute("aria-label", PRIZE_FIELDS.what(n, k));
        part.querySelector(".lc-prize-row__gp")?.setAttribute("aria-label", PRIZE_FIELDS.gp(n, k));
        const remove = part.querySelector(".lc-prize-part__remove");
        if (remove) { remove.hidden = !k; remove.setAttribute("aria-label", t("LOOTCRATES.Scratch.RemovePart", { n, k: k || 1 })); }
      });
      const and = row.querySelector(".lc-prize-row__and");
      if (and) { and.setAttribute("aria-label", t("LOOTCRATES.Scratch.AddPartTo", { n })); off(and, parts.length >= MAX_PARTS, t("LOOTCRATES.Scratch.PartsFull", { max: MAX_PARTS })); }
    });
    off(add, rows.childElementCount >= MAX_PRIZES, t("LOOTCRATES.Scratch.PrizesFull", { max: MAX_PRIZES }));
  };
  add.addEventListener("click", () => {
    if (rows.childElementCount >= MAX_PRIZES) return;
    const id = newId();
    rows.insertAdjacentHTML("beforeend", prizeRowHTML({ count: 1, parts: [{ gp: "" }] }, rows.childElementCount + 1, id));
    rows.lastElementChild.querySelector(".lc-prize-row__count")?.focus();
    renumber();
    paint();
  });
  form.addEventListener("click", e => {
    const and = e.target.closest?.(".lc-prize-row__and");
    if (and) {
      const row = and.closest(".lc-prize-row");
      if (!row || and.getAttribute("aria-disabled") === "true") return;
      const n = [...rows.children].indexOf(row) + 1;
      and.insertAdjacentHTML("beforebegin", prizePartHTML({ gp: "" }, n, 0, row.dataset.prize, newId()));
      renumber();
      and.previousElementSibling?.querySelector(".lc-prize-row__what")?.focus();
      paint();
      return;
    }
    const drop = e.target.closest?.(".lc-prize-part__remove");
    if (drop) {
      const part = drop.closest(".lc-prize-part");
      const row = part?.closest(".lc-prize-row");
      if (!part || !row || row.querySelectorAll(".lc-prize-part").length < 2) return;
      const next = part.previousElementSibling ?? part.nextElementSibling;
      part.remove();
      renumber();
      (next?.classList.contains("lc-prize-part") ? next.querySelector(".lc-prize-row__what") : row.querySelector(".lc-prize-row__and"))?.focus();
      paint();
      return;
    }
    const btn = e.target.closest?.(".lc-prize-row__remove");
    if (!btn) return;
    const row = btn.closest(".lc-prize-row");
    const next = row.nextElementSibling ?? row.previousElementSibling;
    row.remove();
    renumber();
    (next?.querySelector(".lc-prize-row__count") ?? add).focus();
    paint();
  });
  // Rows written all at once (scratchplan.js wireFill): number them, and the readout follows.
  rows.addEventListener("lc:prizes", () => { renumber(); paint(); });
  form.addEventListener("change", e => {
    const what = e.target.closest?.(".lc-prize-row__what");
    if (what) what.closest(".lc-prize-part").dataset.what = whatClass(what.value);
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
