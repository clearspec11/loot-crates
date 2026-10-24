/*
  The Wishing Well: the second kind of game (kinds.js), the opposite of the
  crate. A copper or silver goes in; almost always nothing comes of it, now
  and then the coin comes back, and rarely something from the pool surfaces.
  It is the game a table plays while the GM is in their notes, so nothing
  here needs the GM during play:

  - A throw that gives nothing is a result, not an error: the core's "no
    item" outcome. Every throw writes a log row (so every throw is
    refundable), the Pull log folds a character's misses for a day into one
    line (collapseMisses), and only an item posts a chat card.
  - The cap is "N throws per in-game day", keyed on the world's calendar
    (clock.js dayKeyOf) and counted from the unrefunded log rows that carry
    that day's key: the GM resets nothing, the day rolls over when the party's
    does, and a refund gives a throw back by itself.
  - Pity counts throws since the last item at the pity rarity, in the
    crate's own state shape ({ sinceRare, owned, pulls }), so the crate's
    odds, pity and refund maths (odds.js) run unchanged: when it is due the
    throw is an item, at the guaranteed rarity or better.
  - The reveal is a coin arcing into dark water and its ripples, then a
    quiet plink (nothing), the coin rising again (coin back) or a glow in
    the rarity's colour lifting the find to the surface. One animation
    frame loop, transforms and opacity only; reduced motion and a hidden
    page land at once. The result line goes to the window's live region.

  Record: { kind: "well", price (gp; 0.1 is a silver), pools, weights (the
  item's rarity odds), odds: { nothing, coin, item } (weights), rules: {
  cap, pity, noDuplicates } }.

  No Foundry globals: the core passes the clock's day and the log, so
  Vitest runs the roll and the cap as they are.
*/
import { RARITY_LABEL } from "./config.js";
import { shopOdds, weightedPick, wholePercents, chanceLabel, nextState, undoPull } from "./odds.js";
import { formatPrice, formatGold, COPPER_PER } from "./currency.js";
import { playReveal, playPlop, playPlink, playCoinBack } from "./sound.js";
import { resultHTML } from "./revealcard.js";
import { cardShell, oddsRibbon, oddsPills, pityLine, shopReason, shortReason, draftBox } from "./boxcard.js";
import { drawItem, grantData, crateLogRow } from "./crate.js";
import { PullError, registerKind } from "./kinds.js";

export const WELL_DEFAULTS = { price: 0.1, odds: { nothing: 90, coin: 8, item: 2 }, cap: 3 };
export const OUTCOMES = ["nothing", "coin", "item"];
export const OUTCOME_LABEL = { nothing: "Nothing", coin: "Coin back", item: "Item" };
// The pills' and ribbon's swatch for an outcome that isn't a rarity (module.css).
const OUTCOME_CLASS = { nothing: "lc-rarity-none", coin: "lc-rarity-coin" };

// The cap, as a whole number of throws a day; 0 means none.
export function capOf(game) {
  const n = Math.floor(Number(game?.rules?.cap));
  return n > 0 ? n : 0;
}

// How many throws this character has made at this well today: its unrefunded
// log rows carrying today's key. None when the world has no clock (day null).
export function throwsToday(log, { boxId, actorId, day }) {
  if (!day) return 0;
  return (log ?? []).filter(r => r.boxId === boxId && r.actorId === actorId && r.day === day && !r.refunded).length;
}

export const stillLine = (thrown, cap) => `The well is still until tomorrow (${thrown} of ${cap} today)`;

// The editor's one-line note when the world has no clock (store.js todayKey
// null): the cap is keyed on the in-game day, so without one it never
// applies, and the GM should hear that where they set it. A warning when a
// cap is set and so silently off; a hint otherwise; nothing with a clock.
export function noClockNote({ hasClock, cap } = {}) {
  if (hasClock) return "";
  return `<p class="lc-form__hint${capOf({ rules: { cap } }) ? " lc-form__hint--warn" : ""}">No calendar: the daily cap will not apply.</p>`;
}

/*
  The odds one throw is made at, for one buyer: { rows: [{ key, name,
  chance, label }], item, dry, due }. The item outcome is only as likely as
  the record says when the pools can give this buyer something (item.rows,
  the crate's shopOdds with their pity and no-duplicates state); with
  nothing to give, its weight is 0. Once the pity is due the throw is an
  item and nothing else. Labels are whole percents summing to 100, never
  "0%" (an outcome weighing 0 has no row). `dry` when every outcome weighs
  0. The roll draws on these same rows, so the shop's words are the odds.
*/
export function wellOdds(game, pools, state = {}) {
  const item = shopOdds(game, pools, state);
  const canItem = item.rows.length > 0;
  const w = { ...WELL_DEFAULTS.odds, ...(game.odds ?? {}) };
  const weightOf = k => Math.max(0, Number(w[k]) || 0);
  const due = canItem && !!item.pity?.due;
  const weights = due ? { nothing: 0, coin: 0, item: 1 } : { nothing: weightOf("nothing"), coin: weightOf("coin"), item: canItem ? weightOf("item") : 0 };
  const total = OUTCOMES.reduce((n, k) => n + weights[k], 0);
  const kept = OUTCOMES.filter(k => weights[k] > 0);
  const pcts = wholePercents(kept.map(k => weights[k] / total));
  return {
    rows: kept.map((k, i) => ({ key: k, name: OUTCOME_LABEL[k], chance: weights[k] / total, label: chanceLabel(weights[k] / total, pcts[i]) })),
    item, dry: total <= 0, due,
  };
}

/*
  The throw, on the GM. The cap is checked first, from the log as it stands
  inside the write queue, so two quick throws can't both pass. Then the
  outcome: nothing (the state counts a throw toward pity), the coin back
  (the stake is the payout, so the one settle() moves nothing), or an item
  drawn and resolved the crate's way (crate.js drawItem, grantData), with
  the crate's state so its pity and no-duplicates rules apply. A draw that
  finds nothing after all (the pools emptied since the odds were read) is a
  miss, never an error. `day` and `thrown` ride into the row and the reveal.
*/
async function roll(ctx) {
  const { game, actor, state = {}, rng, log = [], today = null } = ctx;
  const cap = capOf(game);
  const thrown = throwsToday(log, { boxId: game.id, actorId: actor.id, day: today });
  if (cap && today && thrown >= cap) throw new PullError(`${stillLine(thrown, cap)}.`);
  const odds = wellOdds(game, ctx.pools, state);
  if (odds.dry) throw new PullError(`${game.name} is dry: the GM has given it no odds.`);
  const pick = weightedPick(odds.rows, r => r.chance, rng)?.key ?? "nothing";
  const common = { outcome: "nothing", day: today, thrown: thrown + 1, cap };
  const quiet = { sinceRare: (state.sinceRare ?? 0) + 1, owned: [...(state.owned ?? [])], pulls: (state.pulls ?? 0) + 1 };
  if (pick === "item") {
    const { result, source, pools } = await drawItem(ctx);
    if (result) return { ...grantData(source, result, game), ...common, outcome: "item", state: nextState(game, state, result), pools };
  }
  if (pick === "coin") return { ...common, outcome: "coin", result: { name: OUTCOME_LABEL.coin, outcome: "coin" }, grant: null, payoutCp: Math.round(game.price * 100), state: quiet };
  return { ...common, result: null, grant: null, state: quiet };
}

// The row: the outcome and the day it counts toward, plus what a refund
// needs to undo the pity count (odds.js undoPull reads before and
// resetPity). An item row is the crate's row, so the one refund undoes it
// the same way.
function logRow(ctx) {
  const { state, out } = ctx;
  const base = { outcome: out.outcome, day: out.day ?? null };
  if (out.outcome === "item") return { ...base, ...crateLogRow(ctx) };
  return { ...base, name: out.result?.name ?? OUTCOME_LABEL.nothing, before: { sinceRare: state.sinceRare ?? 0, hadItem: false }, resetPity: false };
}

/*
  The Pull log with a character's misses folded into one line per game and
  day ("Brinn, 7 throws, nothing"): a miss is any pulled game's row that
  found nothing (outcome "nothing": the well's quiet throw, a crate's
  "Nothing" from a roll table's text results), one rule for every kind; a
  table stake (a round's row) never folds. The log newest first comes back
  as a list of { row } and { group, rows, noun, ... } in the same order,
  each group standing where its newest row stood. Refunded misses fold
  separately from live ones, so a group's Refund always has a play to give
  back (its newest row, rows[0]). Every other row passes through alone.
*/
export const isMiss = r => r?.outcome === "nothing" && !r.roundId;
// What one play is called on a folded line: a throw at the well, a pull elsewhere.
export const missNoun = kind => (kind === "well" ? "throw" : "pull");

export function collapseMisses(log = []) {
  const groups = new Map();
  const out = [];
  for (const r of log) {
    if (!isMiss(r)) { out.push({ row: r }); continue; }
    const key = [r.actorId, r.boxId, r.day ?? "", r.refunded ? "refunded" : "live"].join("|");
    let g = groups.get(key);
    if (!g) {
      g = { group: true, key, rows: [], noun: missNoun(r.kind), actorName: r.actorName, boxName: r.boxName, boxId: r.boxId, actorId: r.actorId, day: r.day ?? null, price: r.price, refunded: !!r.refunded };
      groups.set(key, g);
      out.push(g);
    }
    g.rows.push(r);
  }
  return out;
}

// "7 throws, nothing", "1 pull, nothing".
export const throwsText = (n, noun = "throw") => `${n} ${noun}${n === 1 ? "" : "s"}, nothing`;

// The misses a log folded, counted in their own words: "3 throws", "2
// pulls", "3 throws and 2 pulls".
export function missCountText(groups = []) {
  const by = new Map();
  for (const g of groups) by.set(g.noun ?? "throw", (by.get(g.noun ?? "throw") ?? 0) + g.rows.length);
  return [...by].map(([noun, n]) => `${n} ${noun}${n === 1 ? "" : "s"}`).join(" and ");
}

/* ---------- The reveal ---------- */

// The timeline, in ms: the coin flies, hits the water, the ripples run;
// then nothing more, the coin rising again, or the glow and the find.
export const WELL_TIMING = { splash: 700, settle: 1300, ring: 900, land: { nothing: 1800, coin: 2200, item: 2600 } };

const clamp01 = x => Math.max(0, Math.min(1, x));
const ease = p => 1 - Math.pow(1 - p, 3);

/*
  The coin's flight and what follows, in `host`: one requestAnimationFrame
  loop setting transforms and opacity from the time since the first frame,
  nothing else animated. Returns the controller the core expects of a kind's
  play: play() (resolves on landing), skip() (lands now, through the same
  path), skipped, reducedMotion. `duration` scales the whole timeline (the
  harness lands at 0); reduced motion or 0 lands at once in the final pose.
  onSplash fires on the frame the coin meets the water (the plop).
*/
export function mountWell(host, { outcome = "nothing", img = "", rarity = "none", duration, reducedMotion, onSplash = null, onLand = null } = {}) {
  const total = duration ?? WELL_TIMING.land[outcome] ?? WELL_TIMING.land.nothing;
  const reduced = reducedMotion ?? (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const scale = total / (WELL_TIMING.land[outcome] ?? WELL_TIMING.land.nothing);
  const T = ms => ms * scale;
  host.classList.add("lc-well", `lc-rarity-${rarity}`);
  host.classList.remove("lc-well--landed");
  host.dataset.outcome = outcome;
  host.innerHTML = `<div class="lc-well__stage" aria-hidden="true">
      <div class="lc-well__water"></div>
      <div class="lc-well__ring"></div><div class="lc-well__ring"></div><div class="lc-well__ring"></div>
      <div class="lc-well__glow"></div>
      <div class="lc-well__prize">${img ? `<img src="${img}" alt="" draggable="false">` : ""}</div>
      <div class="lc-well__coin"></div>
    </div>`;
  const q = sel => host.querySelector(sel);
  const el = { coin: q(".lc-well__coin"), rings: host.querySelectorAll(".lc-well__ring"), glow: q(".lc-well__glow"), prize: q(".lc-well__prize") };
  const set = (node, transform, opacity) => { if (!node?.style) return; node.style.transform = transform; node.style.opacity = String(opacity); };

  const pose = t => {
    const { splash, settle, ring, land } = WELL_TIMING;
    // The coin: an arc from the top left to the water, tumbling; then it
    // sinks; for a coin back it rises again and hangs over the water.
    if (t < T(splash)) {
      const p = clamp01(t / T(splash));
      const x = -120 + 120 * p, y = -110 * (1 - p) - 200 * p * (1 - p);
      set(el.coin, `translate(${x}px, ${y}px) rotate(${p * 540}deg) scaleX(${Math.max(0.15, Math.abs(Math.cos(p * Math.PI * 3)))})`, 1);
    } else if (t < T(settle) || outcome !== "coin") {
      const p = clamp01((t - T(splash)) / T(settle - splash));
      set(el.coin, `translate(0, ${14 * p}px) scale(${1 - 0.3 * p})`, 1 - p);
    } else {
      const p = ease(clamp01((t - T(settle)) / T(land.coin - settle)));
      set(el.coin, `translate(0, ${14 - 60 * p}px) rotate(${p * 360}deg) scale(${0.7 + 0.3 * p})`, p);
    }
    // Three ripples from the splash, each a beat after the last. The last
    // one stays faint on the water once everything has settled: the mark
    // the throw left.
    [...el.rings].forEach((r, i) => {
      const p = clamp01((t - T(splash + i * 140)) / T(ring));
      const last = i === el.rings.length - 1 && t >= T(land[outcome] ?? land.nothing);
      set(r, `scale(${0.2 + 1.6 * ease(p)})`, last ? 0.25 : 0.9 * (1 - p));
    });
    // An item: the glow rises in the rarity's colour and lifts the find.
    const g = outcome === "item" ? ease(clamp01((t - T(settle)) / T(land.item - settle))) : 0;
    set(el.glow, `translate(0, ${10 - 24 * g}px) scale(${1.3 * g})`, 0.85 * Math.min(1, g * 1.4));
    const f = outcome === "item" ? ease(clamp01((t - T(settle + 300)) / T(land.item - settle - 300))) : 0;
    set(el.prize, `translate(0, ${36 - 56 * f}px) scale(${0.6 + 0.4 * f})`, f);
  };

  let landed = false, splashed = false, frame = null, t0 = null, resolveDone = null;
  const land = () => {
    if (landed) return;
    landed = true;
    if (frame != null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    pose(Infinity);
    host.classList.add("lc-well--landed");
    onLand?.();
    resolveDone?.();
  };
  const ctrl = {
    skipped: false,
    reducedMotion: reduced,
    play() {
      if (landed) return Promise.resolve();
      if (reduced || total <= 0) { land(); return Promise.resolve(); }
      return new Promise(resolve => {
        resolveDone = resolve;
        const step = now => {
          t0 ??= now;
          const t = now - t0;
          pose(t);
          if (!splashed && t >= T(WELL_TIMING.splash)) { splashed = true; try { onSplash?.(); } catch (err) { console.error("loot-crates | the well's splash cue failed", err); } }
          if (t >= total) land();
          else frame = requestAnimationFrame(step);
        };
        frame = requestAnimationFrame(step);
      });
    },
    skip() { ctrl.skipped = true; land(); },
  };
  return ctrl;
}

const outcomeOf = reveal => reveal.outcome ?? (reveal.result ? "item" : "nothing");

function play(host, reveal, { sound = false, pageHidden = () => false, onLand }) {
  const outcome = outcomeOf(reveal);
  return mountWell(host, {
    outcome,
    img: outcome === "item" ? reveal.result?.img ?? "" : "",
    rarity: outcome === "item" ? reveal.result?.rarity ?? "common" : "none",
    onSplash: sound ? () => { if (!pageHidden()) playPlop(); } : null,
    onLand,
  });
}

// "Tam throws a coin into Wishing Well, 1 sp": the window's head line.
function head(reveal, { esc }) {
  return `<span class="lc-reveal__who">${esc(reveal.actorName)}</span> throws a coin into
        <strong class="lc-reveal__crate">${esc(reveal.box.name)}</strong>
        <span class="lc-reveal__price">${esc(formatPrice(reveal.box.price))}</span>`;
}

// What the window says once the water settles, into its live region: a quiet
// line for nothing and for the coin back, the crate's item block for a find.
// The buyer and GMs also see the gold left and the day's count.
function result(reveal, { esc = String, canSee = false } = {}) {
  const outcome = outcomeOf(reveal);
  const count = canSee && reveal.cap && reveal.thrown != null ? [`${esc(reveal.thrown)} of ${esc(reveal.cap)} throws today`] : [];
  if (outcome === "item") return resultHTML(reveal, { esc, canSee, extra: count });
  const where = [];
  if (outcome === "coin") where.push(`${esc(formatPrice(reveal.box.price))} back in ${esc(reveal.actorName)}'s purse`);
  if (canSee && reveal.purse) where.push(`<span class="lc-reveal__gold">${esc(formatGold(reveal.purse))} left</span>`);
  where.push(...count);
  return `<div class="lc-reveal__quiet">${outcome === "coin" ? "The coin comes back." : "The coin sinks. Nothing."}</div>`
    + (where.length ? `<div class="lc-reveal__where">${where.join(" · ")}</div>` : "");
}

function sting(reveal) {
  const outcome = outcomeOf(reveal);
  if (outcome === "item") playReveal(reveal.result.rarity);
  else if (outcome === "coin") playCoinBack();
  else playPlink();
}

// The buyer's own quiet word on a miss (the core shows it to them alone),
// so a player whose window sits behind the shop still learns the throw is
// done. Not an error: nothing went wrong.
function notice(reveal) {
  return outcomeOf(reveal) === "nothing" ? `${reveal.box.name}: the coin sinks. Nothing.` : null;
}

// Only a find posts a card; a miss and a coin back keep the chat quiet.
function chatCard(reveal, { esc, itemLink }) {
  const r = reveal.result;
  if (outcomeOf(reveal) !== "item" || !r) return null;
  return `
    <div class="loot-crates lc-chat lc-rarity-${esc(r.rarity)}">
      <div class="lc-chat__head">${esc(reveal.actorName)} threw a coin into <strong>${esc(reveal.box.name)}</strong> <span class="lc-chat__price">${esc(formatPrice(reveal.box.price))}</span></div>
      <div class="lc-chat__item">
        <img src="${esc(r.img)}" alt="">
        <div>
          <div class="lc-chat__name">${itemLink(reveal.itemUuid ?? r.uuid, r.name)}</div>
          <div class="lc-chat__rarity">${esc(RARITY_LABEL[r.rarity] ?? r.rarity)}${r.pity ? " · pity" : ""}</div>
        </div>
      </div>
    </div>`;
}

/* ---------- The shop card ---------- */

const WELL_ART = `<svg class="lc-well__icon" viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="5.5" r="2.6"/><path d="M12 8.5v3.2"/><path d="M4 15c2.2 1.5 5 2.3 8 2.3s5.8-.8 8-2.3M6.5 18.8c1.6.9 3.4 1.3 5.5 1.3s3.9-.4 5.5-1.3"/></svg>`;

const outcomeClass = (row, odds) => (row.key === "item" ? `lc-rarity-${odds.item.top ?? "common"}` : OUTCOME_CLASS[row.key]);

// The three outcomes as the shop's pills and ribbon: nothing in mute ink,
// the coin back in the rim's gold, the item in the best rarity it can be.
export function wellOddsHTML(odds) {
  if (!odds.rows.length) return "";
  const segs = odds.rows.map(row => `<span class="lc-ribbon__seg ${outcomeClass(row, odds)}" style="flex-grow:${+row.chance.toFixed(4)}" title="${row.name} ${row.label}"></span>`).join("");
  const pills = odds.rows.map(row => `<span class="lc-odd ${outcomeClass(row, odds)}">${row.name} ${row.label}</span>`).join("");
  return `<div class="lc-ribbon" aria-hidden="true">${segs}</div><div class="lc-box__odds">${pills}</div>`;
}

// Why this well in particular can't take a coin now, or "": the coin from
// the last throw is still in the water on this client (the shop holds the
// result; reveal.js), it has no odds at all, or this character has thrown
// today's share. The shop's own reasons (closed, no GM, no character) are
// said once in its header, and being short is the card's last word.
function wellState(game, odds, ctx) {
  if (ctx.held?.(game.id)) return "Still rippling";
  if (odds.dry) return "The well is dry";
  const cap = capOf(game);
  const thrown = throwsToday(ctx.log, { boxId: game.id, actorId: ctx.actorId, day: ctx.today });
  if (cap && ctx.today && thrown >= cap) return stillLine(thrown, cap);
  return "";
}

function card(game, pools, ctx) {
  const esc = ctx.esc ?? (s => String(s ?? ""));
  const state = ctx.stateOf?.(game.id) ?? {};
  const odds = wellOdds(game, pools, state);
  const reason = wellState(game, odds, ctx) || shortReason(game, ctx);
  const pity = pityLine(odds.item, "throws");
  const cap = capOf(game);
  const thrown = throwsToday(ctx.log, { boxId: game.id, actorId: ctx.actorId, day: ctx.today });
  const middle = [
    wellOddsHTML(odds),
    pity ? `<div class="lc-box__pity lc-rarity-${odds.item.pity.minRarity}${odds.item.pity.due ? " lc-box__pity--due" : ""}">${esc(pity)}</div>` : "",
    cap && ctx.today && thrown < cap ? `<div class="lc-box__stock">${esc(thrown)} of ${esc(cap)} throws today</div>` : "",
  ];
  return cardShell(game, ctx, { rarityClass: odds.item.top ? `lc-rarity-${odds.item.top}` : "lc-box--well", art: WELL_ART, middle, reason, label: `Throw ${esc(formatPrice(game.price))}` });
}

const reason = (game, pools, ctx) => wellState(game, wellOdds(game, pools, ctx.stateOf?.(game.id) ?? {}), ctx) || shopReason(ctx) || shortReason(game, ctx);

/* ---------- The manager's words ---------- */

// "3 a day, Rare or better after 10 throws, no dupes": the Boxes table's rules cell.
export function wellRulesText(game) {
  const cap = capOf(game);
  const pity = game.rules?.pity;
  return [
    cap ? `${cap} a day` : "",
    pity?.after && pity.minRarity ? `${RARITY_LABEL[pity.minRarity] ?? pity.minRarity} or better after ${pity.after} throws` : "",
    game.rules?.noDuplicates ? "no dupes" : "",
  ].filter(Boolean).join(", ");
}

// The stake as the editor shows it: the largest coin it is a whole number of.
export function stakeCoins(priceGp) {
  const cp = Math.max(0, Math.round((Number(priceGp) || 0) * 100));
  for (const coin of ["gp", "sp", "cp"]) if (cp % COPPER_PER[coin] === 0) return { amount: cp / COPPER_PER[coin], coin };
  return { amount: cp, coin: "cp" };
}
export const stakeGp = (amount, coin) => Math.max(0, Math.floor(Number(amount) || 0)) * (COPPER_PER[coin] ?? 1) / 100;

// The well as the editor's form would save it (boxcard.js draftBox, plus the
// outcome weights `o.nothing`, `o.coin`, `o.item`), for the live preview.
export function draftWell(game, values, poolIds) {
  const num = v => Math.max(0, Number(v) || 0);
  return { ...draftBox(game, values, poolIds), odds: { nothing: num(values["o.nothing"]), coin: num(values["o.coin"]), item: num(values["o.item"]) } };
}

// The editor's preview: the outcome pills and ribbon, the item's rarity pills
// under them, and a line when the well is dry or can give no item.
export function wellPreview(game, pools) {
  const odds = wellOdds(game, pools);
  let note = "";
  if (odds.dry) note = "This well is dry: every outcome weighs 0.";
  else if (!game.pools?.length) note = "No pool is ticked, so a throw can never find an item.";
  else if (!odds.item.rows.length) note = "Its pools have no item that can drop, so a throw can never find one.";
  return { odds, note, dry: odds.dry };
}

export function wellPreviewHTML(preview, esc = s => String(s ?? "")) {
  const { odds, note, dry } = preview;
  const items = odds.item.rows.length ? `<div class="lc-form__hint">If an item: ${oddsRibbon(odds.item.rows)}<div class="lc-odds">${oddsPills(odds.item.rows)}</div></div>` : "";
  return `${wellOddsHTML(odds)}${items}${note ? `<p class="lc-form__hint${dry ? " lc-form__hint--warn" : ""}">${esc(note)}</p>` : ""}`;
}

export function wellSummary(preview) {
  const odds = preview.odds.rows.map(r => `${r.name} ${r.label}`).join(", ");
  const items = preview.odds.item.rows.map(r => `${RARITY_LABEL[r.rarity] ?? r.rarity} ${r.label}`).join(", ");
  return [odds, items ? `If an item: ${items}` : "", preview.note].filter(Boolean).join(". ");
}

export const WELL = registerKind({
  id: "well",
  noun: "well",
  roll,
  logRow,
  // The late-cancel line (socket.js): the coin back isn't a thing one "got".
  gotText: out => (out.outcome === "coin" ? "got the coin back" : `got ${out.result?.name || "nothing"}`),
  undo: undoPull,
  reveal: {
    title: "A coin in the well",
    head,
    play,
    result,
    sting,
    notice,
    replayable: false,
  },
  // Only a find posts a card: hidden whole while sealed, or its arrival would tell.
  chat: { card: chatCard, conditional: true },
  shop: { card, reason },
});
