/*
  Fill the prize list: a scratch roll's prize structure built from a few
  numbers, the way real games are printed (research-scratchies.md), so the
  GM doesn't have to do the maths. Given the ticket's price, the roll's
  size, what share of the coins taken in it pays back, how often a ticket
  wins and the top prize, generatePrizeLines returns prize lines in the
  shape the editor and the roll read ({ count, parts }, scratch.js):

  - about one ticket in `winEvery` wins (size / winEvery winning tickets,
    rounded); the rest of the roll is duds;
  - the coins paid out (coins and the gem; items aren't coins) come within
    a few percent of payback x size x price. Items are counted apart: one
    rare item is worth more than a 100-ticket roll at 5 gp takes in, so
    counting it would leave no roll with an item top prize able to pay
    back 65%. The editor's readout says so ("pays back 65% in coins, plus
    1 item");
  - the lowest prize gives the price back and is the most common; the
    prizes climb in roughly geometric steps (at least half again each
    step, from STEPS: 1x, 2x, 3x, 5x, 10x, 25x ... the price) to the top
    prize, fewer tickets of each the higher they go;
  - the top prize is printed once (or `top.count` times): an item at a
    rarity, coins, or, with neither, an amount worked out from the roll;
  - by `combos`, a share of the middle prizes are combinations of smaller
    parts adding up to the prize: two coin amounts, the gem and coins, or
    an item and coins (an item stands in for its nominal value, config.js
    ITEM_VALUE: "Uncommon item + 25 gp" is a 125 gp prize). Items come
    only at the rarities in `items` (what the ticked pools hold);
  - every line is one the card can show (scratch.js lineMisfit for the
    layout and grid; on match 3 the key's eight symbols hold every part),
    and the counts never add up past the roll's size.

  Deterministic for a given rng: the editor's Fill and Shuffle pass
  Math.random, the tests a seeded one. Nothing here is saved; the lines go
  into the editor's rows, which the GM edits and saves like any other.

  The editor's side is here too: the Fill fields (fillFieldsHTML, inside
  the prize list's fieldset) and their wiring (wireFill), plain DOM so the
  manager and the harness draw and wire the same.
*/
import { RARITIES, RARITY_LABEL, ITEM_VALUE } from "../core/config.js";
import { parsePrice } from "../core/currency.js";
import { t, words } from "../core/i18n.js";
import { lineOf, lineMisfit, prizesOf, bonusOf, gridOf, layoutOf, rowParts, prizeRowHTML, paybackOf, paybackText, MAX_PRIZES, SCRATCH_DEFAULTS } from "./scratch.js";

export const COMBOS = ["none", "some", "lots"];
export const COMBO_LABEL = words({ none: "LOOTCRATES.Scratch.FillCombosNone", some: "LOOTCRATES.Scratch.FillCombosSome", lots: "LOOTCRATES.Scratch.FillCombosLots" });
// The share of the middle prizes made combinations.
const COMBO_SHARE = { none: 0, some: 0.35, lots: 0.7 };
export const FILL_DEFAULTS = { payback: 0.65, winEvery: 3.5, combos: "some" };
// Prize sizes as multiples of the price. Close together, so a small roll
// can still land on its payback; a roll uses those at least RATIO apart.
const STEPS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 75, 100, 125, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 2500, 5000, 10000, 25000];
const RATIO = 1.5;
// Tries at a structure: the first within TOLERANCE of the payback is kept
// (so Shuffle has plenty to choose from), else the closest of them all.
const TRIES = 60;
const TOLERANCE = 0.02;

const r2 = v => Math.round(v * 100) / 100;
const clamp = (v, lo, hi, fallback) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback);
const pick = (list, rng) => list[Math.floor(rng() * list.length)];
const coinsOf = parts => r2(parts.reduce((n, p) => n + (p.gp ?? 0) + (p.bonus ? p.gemGp : 0), 0));
const strip = parts => parts.map(p => (p.bonus ? { bonus: true } : p.item ? { item: { rarity: p.item.rarity } } : { gp: p.gp }));

/*
  The settings as numbers, in range: price and size from the ticket; the
  payback a share (0.65), winEvery how many tickets to a win; top { item:
  { rarity } } | { gp } | null (worked out), with its count; combos one of
  COMBOS; bonus { gp } when the card has a bonus spot; items the rarities
  a combination may use; layout and grid the card's.
*/
export function fillSettings(o = {}) {
  const layout = layoutOf(o);
  const game = { layout, grid: gridOf({ layout, grid: o.grid }), bonus: { on: Number(o.bonus?.gp) > 0, gp: Number(o.bonus?.gp) || 0 } };
  const rarity = o.top?.item?.rarity;
  const gp = r2(Number(o.top?.gp) || 0);
  return {
    price: r2(Math.max(0, Number(o.price) || 0)),
    size: Math.max(0, Math.floor(Number(o.size) || 0)),
    payback: clamp(Number(o.payback ?? FILL_DEFAULTS.payback), 0.05, 2, FILL_DEFAULTS.payback),
    winEvery: clamp(Number(o.winEvery ?? FILL_DEFAULTS.winEvery), 1, 100, FILL_DEFAULTS.winEvery),
    top: RARITIES.includes(rarity) ? { item: rarity, value: ITEM_VALUE[rarity], coins: 0 } : gp > 0 ? { gp, value: gp, coins: gp } : null,
    topCount: Math.max(1, Math.floor(Number(o.top?.count) || 1)),
    combos: COMBOS.includes(o.combos) ? o.combos : FILL_DEFAULTS.combos,
    game,
    gem: bonusOf(game),
    items: RARITIES.filter(r => (o.items ?? []).includes(r)),
  };
}

/*
  The prize lines for the settings (fillSettings), best first: [{ count,
  parts }]. An empty list when there is nothing to build from (no price
  or no tickets).
*/
export function generatePrizeLines(opts = {}) {
  const rng = opts.rng ?? Math.random;
  const s = fillSettings(opts);
  if (!(s.price > 0) || s.size < 1) return [];
  const wins = Math.max(1, Math.min(s.size, Math.round(s.size / s.winEvery)));
  const topCount = Math.min(s.topCount, wins);
  const lower = wins - topCount;
  const target = s.payback * s.size * s.price;
  let best = null;
  for (let i = 0; i < TRIES; i++) {
    const top = s.top ?? autoTop(s, target, lower, rng);
    const built = buildTry(s, { top, topCount, lower, target }, rng);
    if (!built) continue;
    // Nearest the payback, a structure with fewer steps than there is room
    // for, or a cliff between two steps' counts, counting as further off.
    const score = built.error + 0.01 * built.short + 0.01 * built.cliffs;
    if (!best || score < best.score) best = { ...built, score };
    if (score <= TOLERANCE) break;
  }
  return best ? best.lines : [];
}

// A top prize worked out from the roll: coins, a step of the price
// between about a sixth and two fifths of what the roll pays back, with
// room left for every other win to give the price back.
function autoTop(s, target, lower, rng) {
  const room = target - lower * s.price;
  const fits = STEPS.map(k => r2(k * s.price)).filter(v => v >= 2 * s.price && v <= room);
  const near = fits.filter(v => v >= target / 6 && v <= target * 0.4);
  const gp = near.length ? pick(near.slice(-3), rng) : fits.length ? fits[fits.length - 1] : r2(2 * s.price);
  return { gp, value: gp, coins: gp };
}

/*
  One try: prize sizes below the top (the price first, then sizes at
  least RATIO apart, the gem's own size among them when the card has a
  bonus spot), some made combinations, then the tickets of each counted
  to land on the payback. { lines, error (off the payback, a share),
  short (steps fewer than there is room for), cliffs } or null when the
  try can't be built.
*/
function buildTry(s, { top, topCount, lower, target }, rng) {
  const budget = target - topCount * top.coins;
  const price = s.price;
  // The sizes a prize below the top can be: a step of the price, or the gem.
  const sizes = STEPS.slice(1).map(k => ({ value: r2(k * price) }));
  if (s.gem.on && !sizes.some(x => x.value === s.gem.gp)) sizes.push({ value: s.gem.gp, gem: true });
  else if (s.gem.on) sizes.find(x => x.value === s.gem.gp).gem = true;
  // A prize below the top pays no more than half what the rest of the roll pays back.
  const open = sizes.filter(x => x.value >= price * RATIO && x.value * RATIO <= top.value && x.value <= budget / 2).sort((a, b) => a.value - b.value);
  // How many prizes below the top: up to the list's room, one ticket of
  // each at least as many as the top's, and a step for about each
  // doubling of the wins (a roll of 28 wins has six), so the counts can
  // thin out step by step instead of a row of ones.
  const most = Math.min(MAX_PRIZES - 1, Math.floor(lower / topCount), 1 + open.length, 1 + Math.ceil(Math.log2(Math.max(1, lower / topCount))));
  if (most < 1) return lower === 0 ? { lines: [topLine(top, topCount)], error: Math.abs(topCount * top.coins - target) / target, short: 0, cliffs: 0 } : null;
  // Most tries print as many prizes as there is room for; some fewer,
  // which a small roll with a big budget needs.
  const k = Math.max(1, most - Math.floor(rng() ** 3 * most));
  const chosen = spaced(open, k - 1, rng);
  if (!chosen) return null;
  const tiers = [{ value: price, parts: [{ gp: price }] }, ...chosen.map(x => ({ value: x.value, parts: x.gem && rng() < 0.5 ? [{ bonus: true, gemGp: s.gem.gp }] : [{ gp: x.value }] }))];
  // The sizes settled first, as plain coins; a combination of coins or the
  // gem pays what its prize did, so only an item in one moves the counts.
  let counts = nudge(tiers, open, { lower, budget, topCount, top, price });
  if (!counts) return null;
  if (makeCombos(tiers, s, top, rng)) counts = solveCounts(tiers.map(x => coinsOf(x.parts)), lower, budget, topCount);
  if (!counts) return null;
  const paid = counts.reduce((n, c, i) => n + c * coinsOf(tiers[i].parts), 0) + topCount * top.coins;
  const lines = [topLine(top, topCount), ...tiers.map((x, i) => ({ count: counts[i], parts: strip(x.parts) })).reverse()];
  if (!showsAll(lines, s)) return null;
  // Real rolls thin out step by step: more than four times as many of a
  // prize as of the next one up is a cliff.
  const cliffs = counts.slice(1).reduce((n, c, i) => n + Math.max(0, Math.log2(counts[i] / c) - 2), 0);
  return { lines, error: Math.abs(paid - target) / target, short: Math.max(0, Math.min(5, most, Math.ceil(lower / 2)) - tiers.length), cliffs };
}

/*
  The counts for the tiers, and while they miss the budget, a plain coin
  prize moved a step up or down (still RATIO from its neighbours and the
  top) when that brings the coins nearer. Changes `tiers` in place.
*/
function nudge(tiers, open, { lower, budget, topCount, top, price }) {
  const solve = () => {
    const coins = tiers.map(x => coinsOf(x.parts));
    const c = solveCounts(coins, lower, budget, topCount);
    return c && { c, e: Math.abs(c.reduce((n, x, i) => n + x * coins[i], 0) - budget) };
  };
  let best = solve();
  for (let round = 0; best && round < 6 && best.e > TOLERANCE * budget; round++) {
    let moved = false;
    for (let i = 1; i < tiers.length; i++) {
      const parts = tiers[i].parts;
      if (parts.length !== 1 || !parts[0].gp) continue;
      const lo = i > 1 ? tiers[i - 1].value * RATIO : price * RATIO;
      const hi = i + 1 < tiers.length ? tiers[i + 1].value / RATIO : top.value / RATIO;
      const at = open.findIndex(x => x.value === tiers[i].value);
      for (const j of [at - 1, at + 1]) {
        const v = open[j]?.value;
        if (!(v >= lo - 1e-9 && v <= hi + 1e-9) || open[j].gem) continue;
        const was = tiers[i];
        tiers[i] = { value: v, parts: [{ gp: v }] };
        const got = solve();
        if (got && got.e < best.e) { best = got; moved = true; break; }
        tiers[i] = was;
      }
    }
    if (!moved) break;
  }
  return best?.c ?? null;
}

const topLine = (top, count) => ({ count, parts: [top.item ? { item: { rarity: top.item } } : { gp: top.gp }] });

// `n` sizes from `open` (sorted), each at least RATIO above the one
// before, the first at least RATIO above the price (open is already).
function spaced(open, n, rng) {
  if (!n) return [];
  for (let attempt = 0; attempt < 30; attempt++) {
    const skew = 0.4 + rng() * 1.6;
    const out = [];
    let i = 0;
    for (let left = n; left > 0; left--) {
      const room = open.length - i - (left - 1);
      if (room <= 0) break;
      // Skewed toward the near end or the far one by the try.
      const j = i + Math.floor(rng() ** skew * room);
      const prev = out[out.length - 1];
      let at = j;
      while (prev && at < open.length && open[at].value < prev.value * RATIO) at++;
      if (at >= open.length) break;
      out.push(open[at]);
      i = at + 1;
    }
    if (out.length === n) return out;
  }
  // Greedy from the bottom: every size RATIO above the last.
  const out = [];
  for (const x of open) if (!out.length || x.value >= out[out.length - 1].value * RATIO) out.push(x);
  return out.length >= n ? out.slice(0, n) : null;
}

/*
  A share of the middle prizes (not the price, not the top) made
  combinations adding up to the prize: two smaller coin amounts the roll
  already pays, the gem and coins (lucky numbers with a bonus spot), an
  item worth less than the prize and coins, and on "lots" a card with
  room sometimes three parts. Each must be a line the card can show.
  True when an item went into one (its coins are then less than the
  prize's, and the counts are worked out again).
*/
function makeCombos(tiers, s, top, rng) {
  const share = COMBO_SHARE[s.combos] ?? 0;
  const middle = tiers.map((x, i) => i).filter(i => i > 0 && !tiers[i].parts[0].bonus);
  if (!share || !middle.length) return false;
  let items = false;
  const n = Math.max(1, Math.round(share * middle.length));
  const match3 = s.game.layout === "match3";
  const coinsPaid = () => new Set([...tiers.filter(x => x.parts.length === 1 && x.parts[0].gp).map(x => x.parts[0].gp), ...(top.gp ? [top.gp] : [])]);
  for (const i of shuffled(middle, rng).slice(0, n)) {
    const v = tiers[i].value;
    const paid = [...coinsPaid()].filter(a => a < v);
    const opts = [];
    for (const a of paid) {
      const b = r2(v - a);
      if (b > 0 && b < a && (paid.includes(b) || (!match3 && b >= s.price))) opts.push([{ gp: a }, { gp: b }]);
    }
    if (s.gem.on && s.gem.gp < v) {
      const b = r2(v - s.gem.gp);
      if (b >= s.price) opts.push([{ bonus: true, gemGp: s.gem.gp }, { gp: b }]);
    }
    for (const r of s.items) {
      const b = r2(v - ITEM_VALUE[r]);
      if (b > 0 && (!match3 || paid.includes(b))) opts.push([{ item: { rarity: r } }, { gp: b }]);
      if (s.combos === "lots" && s.gem.on && b - s.gem.gp >= s.price) opts.push([{ item: { rarity: r } }, { bonus: true, gemGp: s.gem.gp }, { gp: r2(b - s.gem.gp) }]);
    }
    // A match 3 key has a symbol for MAX_PRIZES amounts and rarities: a
    // combination may not need more than are left.
    const keys = match3 ? new Set([...tiers, { parts: [top.item ? { item: { rarity: top.item } } : { gp: top.gp }] }].flatMap(x => x.parts.map(partKey))) : null;
    const fit = opts.filter(parts => {
      const line = lineOf({ count: 1, parts: strip(parts) }, s.gem);
      if (!line || lineMisfit(line, s.game)) return false;
      return !keys || keys.size + parts.filter(p => !keys.has(partKey(p))).length <= MAX_PRIZES;
    });
    if (!fit.length) continue;
    tiers[i].parts = pick(fit, rng);
    items ||= tiers[i].parts.some(p => p.item);
  }
  return items;
}

const partKey = p => (p.bonus ? "bonus" : p.item ? `item.${p.item.rarity}` : `gp.${p.gp}`);

const shuffled = (list, rng) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/*
  How many tickets win each prize (lowest first), adding up to `wins`,
  each at least `least` (the top's count), never more of a bigger prize
  than a smaller one and the price's the most of all, so that the coins
  they pay come as near `budget` as the sizes allow. A spread falling by
  a steady ratio starts it, the best of a range of ratios; then single
  tickets move from prize to prize while that brings the coins nearer.
*/
export function solveCounts(coins, wins, budget, least = 1) {
  const k = coins.length;
  if (!k || k * least > wins) return null;
  const strict = k > 1 && wins > k * least;
  const ok = c => c.every((n, i) => n >= least && (i === 0 || n <= c[i - 1])) && (!strict || c[0] > c[1]);
  const value = c => c.reduce((n, x, i) => n + x * coins[i], 0);
  let best = null;
  for (let r = 0.1; r <= 1.0001; r += 0.05) {
    const c = spread(k, wins, least, r);
    if (!ok(c)) continue;
    const e = Math.abs(value(c) - budget);
    if (!best || e < best.e) best = { c, e };
  }
  if (!best) return null;
  const c = best.c;
  for (let step = 0; step < 4000; step++) {
    const now = value(c);
    let move = null;
    let gap = Math.abs(now - budget);
    for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) {
      if (i === j || c[i] <= least) continue;
      const e = Math.abs(now + coins[j] - coins[i] - budget);
      if (e >= gap - 1e-9) continue;
      c[i]--; c[j]++;
      if (ok(c)) { move = [i, j]; gap = e; }
      c[i]++; c[j]--;
    }
    if (!move) break;
    c[move[0]]--; c[move[1]]++;
  }
  return c;
}

function spread(k, wins, least, r) {
  const extra = wins - k * least;
  const w = Array.from({ length: k }, (_, i) => r ** i);
  const sum = w.reduce((a, b) => a + b, 0);
  const c = w.map(x => least + Math.floor((extra * x) / sum));
  c[0] += wins - c.reduce((a, b) => a + b, 0);
  return c;
}

// Every line printed as it was built: none left out or merged (scratch.js prizesOf).
function showsAll(lines, s) {
  const game = { ...s.game, roll: { size: Infinity, prizes: lines } };
  const kept = prizesOf(game);
  return kept.length === lines.length && lines.every(l => {
    const line = lineOf(l, s.gem);
    return line && kept.some(p => p.key === line.key && p.count === l.count);
  });
}

/* ---------- The editor's Fill ---------- */

// What the top prize field starts at, the same in a New and an Edit: the
// roll's own top prize when it is one item or one coin amount, else a
// Rare item (FILL_TOP), as a new ticket's list has it. An emptied list
// used to start the field at coins worked out, which quietly gave a
// 125 gp top prize where the GM had an item before.
export const FILL_TOP = "item.rare";
export function topOf(game) {
  const [first] = [...(game?.roll?.prizes ?? [])].map(p => lineOf(p, bonusOf(game))).filter(Boolean).sort((a, b) => (b.items.length ? 1e9 : b.gp) - (a.items.length ? 1e9 : a.gp));
  if (first?.parts.length === 1 && first.kind === "item") return { what: `item.${first.rarity}`, gp: "" };
  if (first?.parts.length === 1 && first.kind === "gp") return { what: "gp", gp: first.gp };
  return { what: FILL_TOP, gp: "" };
}

/*
  Fill the prize list, closed until the GM opens it: pays back [65] % of
  what the roll takes in, wins about 1 in [3.5] tickets, the top prize
  ([Coins, worked out for you | Coins [ ] gp | Rare item ...]), the
  combinations (None, Some, Lots), then Fill and Shuffle (off until the
  first Fill) and a status line. It sits in the prize list's fieldset,
  above the rows it fills (scratch.js scratchFieldsHTML `fill`).
*/
export function fillFieldsHTML(game, { esc = s => String(s ?? "") } = {}) {
  const id = esc(game?.id ?? "new");
  const top = topOf(game);
  const options = [["auto", t("LOOTCRATES.Scratch.FillTopAuto")], ["gp", t("LOOTCRATES.Scratch.WhatCoins")], ...RARITIES.map(r => [`item.${r}`, t("LOOTCRATES.Scratch.ItemPrize", { rarity: RARITY_LABEL[r] })])];
  return `<div class="lc-fill">
        <button type="button" class="lc-fill__toggle" aria-expanded="false" aria-controls="lc-fill-${id}"><i class="fas fa-wand-magic-sparkles" inert></i> ${t("LOOTCRATES.Scratch.FillToggle")}</button>
        <div class="lc-fill__body" id="lc-fill-${id}" hidden>
          <p class="lc-form__hint">${t("LOOTCRATES.Scratch.FillHint")}</p>
          <div class="lc-fill__fields">
            <label class="lc-row">${t("LOOTCRATES.Scratch.FillPayback", { input: `<input name="fillPayback" type="number" min="5" max="200" step="1" value="${Math.round(FILL_DEFAULTS.payback * 100)}">` })}</label>
            <label class="lc-row">${t("LOOTCRATES.Scratch.FillWinEvery", { input: `<input name="fillWinEvery" type="number" min="1" max="100" step="0.5" value="${FILL_DEFAULTS.winEvery}">` })}</label>
            <div class="lc-row lc-row--wrap lc-fill__top" data-what="${top.what === "gp" ? "gp" : "other"}">
              <label class="lc-row">${t("LOOTCRATES.Scratch.FillTop")} <select name="fillTop">${options.map(([v, l]) => `<option value="${v}"${v === top.what ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
              <span class="lc-fill__gp"${top.what === "gp" ? "" : " hidden"}><input name="fillTopGp" type="number" min="0" step="1" value="${esc(top.gp)}" aria-label="${t("LOOTCRATES.Scratch.FillTopGp")}"> gp</span>
            </div>
            <div class="lc-row lc-row--wrap lc-fill__combos" role="radiogroup" aria-labelledby="lc-fill-combos-${id}"><span id="lc-fill-combos-${id}">${t("LOOTCRATES.Scratch.FillCombos")}</span>
              <span class="lc-fill__picks">${COMBOS.map(c => `<label class="lc-field"><input type="radio" name="fillCombos" value="${c}"${c === FILL_DEFAULTS.combos ? " checked" : ""}> ${COMBO_LABEL[c]}</label>`).join("")}</span>
            </div>
          </div>
          <div class="lc-row lc-fill__go">
            <button type="button" class="lc-fill__fill">${t("LOOTCRATES.Scratch.FillGo")}</button>
            <button type="button" class="lc-fill__shuffle" aria-disabled="true" title="${t("LOOTCRATES.Scratch.FillShuffleOff")}"><i class="fas fa-shuffle" inert></i> ${t("LOOTCRATES.Scratch.FillShuffle")}</button>
          </div>
          <p class="lc-form__hint lc-fill__said" role="status" aria-live="polite"></p>
        </div>
      </div>`;
}

// The Fill fields' settings with the card's own (the price, the size, the
// layout, the grid, the bonus spot) as the form has them now.
export function fillFrom(values) {
  const what = String(values.fillTop ?? "auto");
  const top = what.startsWith("item.") ? { item: { rarity: what.slice(5) } } : what === "gp" && Number(values.fillTopGp) > 0 ? { gp: Number(values.fillTopGp) } : null;
  const on = v => v === true || v === "on";
  const layout = values.layout === "match3" ? "match3" : "lucky";
  return {
    price: parsePrice(values.price) ?? (Number(values.price) || 0),
    size: Math.floor(Number(values.size) || 0),
    payback: (Number(values.fillPayback) || FILL_DEFAULTS.payback * 100) / 100,
    winEvery: Number(values.fillWinEvery) || FILL_DEFAULTS.winEvery,
    top,
    combos: COMBOS.includes(values.fillCombos) ? values.fillCombos : FILL_DEFAULTS.combos,
    layout,
    grid: { cols: values.cols, rows: values.rows },
    bonus: layout === "lucky" && on(values.bonusOn) ? { gp: Number(values.bonusGp) || 0 } : null,
  };
}

// The prize rows' values in order, to tell rows the GM typed from the ones Fill wrote.
const rowsSig = rows => [...rows.querySelectorAll(".lc-prize-row")].map(r => [r.querySelector(".lc-prize-row__count")?.value, ...[...r.querySelectorAll(".lc-prize-part")].map(p => `${p.querySelector(".lc-prize-row__what")?.value}:${p.querySelector(".lc-prize-row__gp")?.value}`)].join(" ")).join("|");

// Scrolls `el` into view in the dialog, where there is one to scroll.
const reveal = (el, block) => el?.scrollIntoView?.({ block, behavior: "instant" });

/*
  The Fill fields' moving parts. The toggle opens and closes them; the top
  prize shows its gold field for coins only. Fill builds a prize list
  from the fields and the card's own (read(): the form's values as
  manager.js readForm reads them; items(): the rarities the ticked pools
  hold, which a combination may use), and writes it into the prize rows,
  replacing them, after `confirm(text)` when the rows hold anything Fill
  didn't write itself. Shuffle does the same with a fresh draw, and never
  gives back the list it replaces. The rows' editor (wireScratchEditor)
  renumbers them and the readout follows; the status line says what
  happened, and that nothing is saved until Save.
*/
export function wireFill(form, { read, items = () => [], newId, confirm = async () => true, rng = Math.random } = {}) {
  const box = form.querySelector(".lc-fill");
  const rows = form.querySelector(".lc-prizes__rows");
  if (!box || !rows) return;
  const toggle = box.querySelector(".lc-fill__toggle");
  const body = box.querySelector(".lc-fill__body");
  const shuffle = box.querySelector(".lc-fill__shuffle");
  const said = box.querySelector(".lc-fill__said");
  let mine = null;
  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(open));
    body.hidden = !open;
    if (!open) return;
    body.querySelector('input[name="fillPayback"]')?.focus({ preventScroll: true });
    // The whole panel, down to Fill and Shuffle, clear of the pinned
    // readout (the dialog's scroll padding is the readout's height).
    reveal(box.querySelector(".lc-fill__go"), "nearest");
  });
  box.addEventListener("change", e => {
    if (!e.target.matches?.('select[name="fillTop"]')) return;
    const coins = e.target.value === "gp";
    box.querySelector(".lc-fill__top").dataset.what = coins ? "gp" : "other";
    box.querySelector(".lc-fill__gp").hidden = !coins;
    if (coins) box.querySelector('input[name="fillTopGp"]')?.focus();
  });
  const fill = async again => {
    const values = read();
    const settings = { ...fillFrom(values), items: [...items(values)] };
    if (!(settings.price > 0)) { said.textContent = t("LOOTCRATES.Scratch.FillNoPrice"); return; }
    if (!(settings.size > 0)) settings.size = SCRATCH_DEFAULTS.size;
    let lines = generatePrizeLines({ ...settings, rng });
    const sig = list => list.map(l => `${l.count}:${JSON.stringify(rowParts(l))}`).join("|");
    const before = mine?.lines ? sig(mine.lines) : null;
    for (let n = 0; again && before && sig(lines) === before && n < 8; n++) lines = generatePrizeLines({ ...settings, rng });
    if (!lines.length) { said.textContent = t("LOOTCRATES.Scratch.FillNone"); return; }
    const count = rows.childElementCount;
    if (count && rowsSig(rows) !== mine?.sig) {
      const ok = await confirm(count === 1 ? t("LOOTCRATES.Scratch.FillReplaceOne") : t("LOOTCRATES.Scratch.FillReplace", { count }));
      if (!ok) { said.textContent = t("LOOTCRATES.Scratch.FillKept"); return; }
    }
    rows.innerHTML = lines.map((l, i) => prizeRowHTML(l, i + 1, newId())).join("");
    // The roll's size goes in too when the field was empty.
    const size = form.querySelector('input[name="size"]');
    if (size && !(Number(size.value) > 0)) size.value = settings.size;
    rows.dispatchEvent(new Event("lc:prizes", { bubbles: true }));
    mine = { lines, sig: rowsSig(rows) };
    shuffle.removeAttribute("aria-disabled");
    shuffle.removeAttribute("title");
    const pb = paybackOf({ price: settings.price, roll: { size: Number(size?.value) || settings.size, prizes: lines }, layout: settings.layout, grid: settings.grid, bonus: { on: !!settings.bonus, gp: settings.bonus?.gp ?? 0 } });
    said.textContent = t(again ? "LOOTCRATES.Scratch.FillShuffled" : "LOOTCRATES.Scratch.FillDone", { count: lines.length, payback: paybackText(pb) });
    // Focus on the first new prize, and the line saying what Fill did at
    // the top of the view with the new rows under it, not under the readout.
    rows.firstElementChild?.querySelector(".lc-prize-row__count")?.focus({ preventScroll: true });
    reveal(said, "start");
  };
  box.querySelector(".lc-fill__fill").addEventListener("click", () => fill(false));
  shuffle.addEventListener("click", () => {
    if (shuffle.getAttribute("aria-disabled") === "true") return;
    return fill(true);
  });
}
