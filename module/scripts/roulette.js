/*
  Roulette, the Wheel of Fate: the first table kind (kinds.js `table: true`),
  played in rounds on the core's escrow (round.js, table.js). The whole
  table bets at once, on a colour, odd or even, one number or a rarity band,
  and one spin on the GM settles every bet.

  - The wheel is the GM's: N pockets (12 by default: 5 common, 4 uncommon,
    2 rare, 1 legendary), each numbered 1..N around the wheel, in one of two
    colours the GM names ("Red" and "Black", or "Evocation red" and
    "Abjuration black") and in one rarity. The rim of the wheel is the odds
    ribbon bent into a circle: each pocket's outer arc is its rarity's
    colour, so the table reads the rarity odds off the wheel itself.
  - The odds are exact and named, per bet type, from the pocket list
    (betOdds): a colour's share of the pockets, odd or even's, one number's
    (1 in N), a rarity band's. An option no pocket holds has no row, so
    nothing ever reads "0%". The pocket is rolled with Foundry's own dice
    (1dN through dicegame.js rollFaces: allowInteractive false, inside the
    GM's write queue, decided and logged before anything is shown; every
    client rebuilds the landing from the serialised Roll).
  - Payouts are the GM's coin multipliers per bet type (a stake of 10 gp on
    a colour paying 2x comes back as 20 gp: the stake and as much again).
    The core took the stake at the bet, so the kind's settle() says what
    comes back and never touches the purse. Optionally a bet on a rarity
    band that wins also draws an item of that rarity from the game's pools,
    granted by the core at the resolve (table.js) and taken back by the
    ordinary Refund.
  - Stakes are the core's: the record's price is the least a bet can be,
    the GM caps the stake and the bets per character per round, and a bet
    the round can't take throws a PullError before anything is charged.
  - The reveal is a top-down wheel in the vault: the disc turns and the ball
    runs the other way and slows into the pocket, both as one rotation
    transform each on one requestAnimationFrame clock; ticks slow with the
    ball, one soft drop as it dips, then the winners light and every
    character's net goes to the window's live region. Reduced motion and a
    hidden page land at once. The shared table window (tablewindow.js,
    tableview.js) shows the chips as bets arrive and the clock.

  Record: { kind: "roulette", price (the least stake, gp), pools, weights
  (unused: the item draw is from the band's own rarity), roulette: {
  colours: [a, b], pockets: [{ colour: 0 | 1, rarity }], payouts: { colour,
  parity, number, rarity }, itemOnRarity, maxStake (gp or null), maxBets
  (per character per round), windowSec (0: until the GM spins) } }.

  No Foundry globals: the core passes the pools, the source resolver and
  the log; Foundry's Roll is reached as the dice reach it.
*/
import { RARITIES, RARITY_LABEL, RARITY_SHORT } from "./config.js";
import { wholePercents, chanceLabel, flattenPool, normalizeRarity, weightedPick } from "./odds.js";
import { formatPrice, canAfford, shortfall } from "./currency.js";
import { playTick, playDrop, playCoinBack, playReveal } from "./sound.js";
import { cardShell, shopReason } from "./boxcard.js";
import { grantData } from "./crate.js";
import { rollFaces } from "./dicegame.js";
import { liveRoundOf, isOpenStake, roundState as tableRoundState } from "./round.js";
import { PullError, registerKind } from "./kinds.js";
import { t, words } from "./i18n.js";

export const BET_TYPES = ["colour", "parity", "number", "rarity"];
export const BET_TYPE_LABEL = words({ colour: "LOOTCRATES.Roulette.Colour", parity: "LOOTCRATES.Roulette.OddOrEven", number: "LOOTCRATES.Roulette.Number", rarity: "LOOTCRATES.Roulette.Rarity" });
export const PARITY_LABEL = words({ odd: "LOOTCRATES.Roulette.Odd", even: "LOOTCRATES.Roulette.Even" });

// Six of each colour laid so that colour and parity are different bets
// (a plain alternation would make "Red" and "Odd" the same wager).
const DEFAULT_COLOURS = [0, 1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0];
const DEFAULT_RARITIES = ["common", "uncommon", "common", "uncommon", "rare", "common", "uncommon", "common", "legendary", "uncommon", "common", "rare"];
export const ROULETTE_DEFAULTS = {
  price: 5, maxStake: 50, maxBets: 3, windowSec: 45, itemOnRarity: false,
  colours: words(["LOOTCRATES.Roulette.Red", "LOOTCRATES.Roulette.Black"]),
  payouts: { colour: 2, parity: 2, number: 12, rarity: 3 },
  pockets: DEFAULT_RARITIES.map((rarity, i) => ({ colour: DEFAULT_COLOURS[i], rarity })),
};

/* ---------- The wheel as written ---------- */

// The two colour names, each a non-empty trimmed string.
export function coloursOf(game) {
  const raw = game?.roulette?.colours ?? [];
  return [0, 1].map(i => String(raw[i] ?? "").trim() || ROULETTE_DEFAULTS.colours[i]);
}

// Every pocket in one shape, numbered 1..N by its place on the wheel: an
// unknown colour is the first, an unknown rarity is common.
export function pocketsOf(game) {
  const list = Array.isArray(game?.roulette?.pockets) ? game.roulette.pockets : [];
  const names = coloursOf(game);
  return list.map((p, i) => {
    const colour = Number(p?.colour) === 1 ? 1 : 0;
    return { n: i + 1, colour, colourName: names[colour], rarity: normalizeRarity(p?.rarity) };
  });
}

export const payoutOf = (game, type) => Math.max(0, Number(game?.roulette?.payouts?.[type] ?? ROULETTE_DEFAULTS.payouts[type]) || 0);
export const maxStakeOf = game => { const n = Number(game?.roulette?.maxStake); return n > 0 ? n : null; };
export const maxBetsOf = game => { const n = Math.floor(Number(game?.roulette?.maxBets)); return n > 0 ? n : 0; };
export const windowMsOf = game => Math.max(0, Math.round(Number(game?.roulette?.windowSec) || 0)) * 1000;
export const itemOnRarity = game => !!game?.roulette?.itemOnRarity;
export const minStakeOf = game => Math.max(0, Number(game?.price) || 0);

/* ---------- Bets ---------- */

// A bet as the player sends it and the row keeps it: { type, pick }.
// colour: 0 | 1; parity: "odd" | "even"; number: 1..N; rarity: a key.
export function normalizeBet(game, bet) {
  const type = BET_TYPES.includes(bet?.type) ? bet.type : null;
  if (!type) return null;
  const pockets = pocketsOf(game);
  if (type === "colour") { const c = Number(bet.pick); return c === 0 || c === 1 ? { type, pick: c } : null; }
  if (type === "parity") return bet.pick === "odd" || bet.pick === "even" ? { type, pick: bet.pick } : null;
  if (type === "number") { const n = Math.floor(Number(bet.pick)); return n >= 1 && n <= pockets.length ? { type, pick: n } : null; }
  const r = normalizeRarity(bet.pick);
  return RARITIES.includes(r) && pockets.some(p => p.rarity === r) ? { type, pick: r } : null;
}

export function betWins(bet, pocket) {
  if (!bet || !pocket) return false;
  if (bet.type === "colour") return pocket.colour === bet.pick;
  if (bet.type === "parity") return (pocket.n % 2 === 1) === (bet.pick === "odd");
  if (bet.type === "number") return pocket.n === bet.pick;
  if (bet.type === "rarity") return pocket.rarity === bet.pick;
  return false;
}

// "Red", "Odd", "7", "Rare": the bet's name, as the chip, the row and the
// verdict say it.
export function betName(game, bet) {
  if (!bet) return "";
  if (bet.type === "colour") return coloursOf(game)[bet.pick] ?? "";
  if (bet.type === "parity") return PARITY_LABEL[bet.pick] ?? "";
  if (bet.type === "number") return String(bet.pick);
  return RARITY_LABEL[bet.pick] ?? String(bet.pick);
}

// The swatch (module.css lc-rarity-*) a bet's chip and row dot read: a
// rarity bet its rarity, everything else the coin's gold.
export const betSwatch = bet => (bet?.type === "rarity" ? bet.pick : "coin");

// One key per spot on the rail: "colour:0", "parity:odd", "number:7", "rarity:rare".
export const spotKey = bet => (bet ? `${bet.type}:${bet.pick}` : "");

/*
  The options of one bet type with how many pockets each covers: [{ pick,
  name, count, swatch }]. Options no pocket holds are left out (a wheel with
  one colour has no bet on the other; a rarity no pocket carries isn't offered).
*/
export function optionsOf(game, type) {
  const pockets = pocketsOf(game);
  const count = fn => pockets.filter(fn).length;
  if (type === "colour") return [0, 1].map(c => ({ pick: c, name: coloursOf(game)[c], count: count(p => p.colour === c), swatch: "coin" })).filter(o => o.count);
  if (type === "parity") return ["odd", "even"].map(k => ({ pick: k, name: PARITY_LABEL[k], count: count(p => (p.n % 2 === 1) === (k === "odd")), swatch: "coin" })).filter(o => o.count);
  if (type === "number") return pockets.map(p => ({ pick: p.n, name: String(p.n), count: 1, swatch: "coin", colour: p.colour, rarity: p.rarity }));
  return RARITIES.map(r => ({ pick: r, name: RARITY_LABEL[r], short: RARITY_SHORT[r], count: count(p => p.rarity === r), swatch: r })).filter(o => o.count);
}

/*
  The exact odds per bet type, from the pockets: { colour, parity, number,
  rarity }, each a list of { pick, name, count, chance, label, swatch, pays
  } whose whole-percent labels sum to 100 (wholePercents), never "0%" (an
  option with no pocket has no row), and `pays` the type's multiplier. The
  roll lands on one of N pockets with equal chance, so these are the odds
  the wheel has. `pockets` is N; `payouts` the multipliers as read.
*/
export function betOdds(game) {
  const n = pocketsOf(game).length;
  const out = { pockets: n, payouts: Object.fromEntries(BET_TYPES.map(type => [type, payoutOf(game, type)])) };
  for (const type of BET_TYPES) {
    const options = n ? optionsOf(game, type) : [];
    const pcts = wholePercents(options.map(o => o.count / n));
    // Twelve numbers at 8.33% each can't all read the same whole percent and
    // still sum to 100, so a number's pick is said as "1 in 12" instead.
    out[type] = options.map((o, i) => ({ ...o, chance: o.count / n, label: chanceLabel(o.count / n, pcts[i]), ...(type === "number" ? { fraction: t("LOOTCRATES.Roulette.OneIn", { n }) } : {}), pays: out.payouts[type] }));
  }
  return out;
}

/*
  What every bet gets back when the ball lands in `pocket`: [{ bet, stakeCp,
  win, payoutCp }]. `bets` carry their stake in copper; a win pays stakeCp x
  the type's multiplier, whole copper; a loss pays nothing (the stake was
  taken at the bet). Pure, so the test table runs every bet on every pocket.
*/
export function resolve(pocket, bets, game) {
  return (bets ?? []).map(b => {
    const bet = normalizeBet(game, b);
    const win = betWins(bet, pocket);
    const stakeCp = Math.max(0, Math.round(Number(b.stakeCp) || 0));
    return { bet, stakeCp, win, payoutCp: win ? Math.round(stakeCp * payoutOf(game, bet.type)) : 0 };
  });
}

/* ---------- The kind's contract ---------- */

// What this stake costs: the amount the player chose, else the least stake.
const priceOf = ({ game, bet }) => {
  const n = Number(bet?.stake);
  return n > 0 ? Math.round(n * 100) / 100 : minStakeOf(game);
};

// "Crate Tester has placed 3 of 3 bets this round." and the other refusals.
export function stakeCheck(game, { actor, bet, stakes = [], price }) {
  if (pocketsOf(game).length < 2) throw new PullError(t("LOOTCRATES.Roulette.NoWheel", { name: game.name }));
  const b = normalizeBet(game, bet);
  if (!b) throw new PullError(t("LOOTCRATES.Roulette.PickBet"));
  const min = minStakeOf(game), max = maxStakeOf(game);
  if (price < min) throw new PullError(t("LOOTCRATES.Roulette.LeastStake", { name: game.name, price: formatPrice(min) }));
  if (max != null && price > max) throw new PullError(t("LOOTCRATES.Roulette.MostStake", { name: game.name, price: formatPrice(max) }));
  const cap = maxBetsOf(game);
  const mine = stakes.filter(r => r.actorId === actor?.id && isOpenStake(r)).length;
  if (cap && mine >= cap) throw new PullError(t("LOOTCRATES.Roulette.CapReached", { name: actor?.name ?? t("LOOTCRATES.Roulette.ThisCharacter"), mine, cap }));
  return b;
}

// kinds.js stake: what the open row keeps of the bet, named for the log.
function stake(ctx) {
  const b = stakeCheck(ctx.game, ctx);
  return { label: betName(ctx.game, b), type: b.type, pick: b.pick, swatch: betSwatch(b) };
}

// The number of bets a character has open on a round, for the shop's cap line.
export const betsPlaced = (stakes = [], actorId) => stakes.filter(r => r.actorId === actorId && isOpenStake(r)).length;

/*
  The item a winning rarity bet draws: one entry of that rarity from the
  game's pools, picked by weight (the weights setting plays no part: the
  band is the rarity). Null when the pools hold none of that rarity.
*/
export function drawOfRarity(game, pools, rarity, rng = Math.random) {
  const entries = (game.pools ?? []).flatMap(ref => flattenPool(ref.id, pools ?? {})).filter(e => e.rarity === rarity);
  const entry = weightedPick(entries, e => e.weight, rng);
  return entry ? { entry, rarity, poolId: entry.poolId, pity: false } : null;
}

/*
  The spin, on the GM at the resolve, once per round, before anything is
  written: Foundry's 1dN picks the pocket. With the item rule on, every open
  rarity bet on the landing band draws its item here (resolved to its
  source, so a dead entry gives coins only), handed to the core as
  `grants` by row id; the core grants them and never broadcasts them.
*/
async function roll(ctx) {
  const { game, stakes = [], rng, pools = {}, resolveSource = null } = ctx;
  const pockets = pocketsOf(game);
  if (pockets.length < 2) throw new PullError(t("LOOTCRATES.Roulette.NoWheel", { name: game.name }));
  const n = pockets.length;
  const { faces, roll: data } = await rollFaces(`1d${n}`, { rng, number: 1, sides: n });
  const pocket = pockets[faces[0] - 1];
  const outcome = { index: faces[0] - 1, number: pocket.n, colour: pocket.colour, colourName: pocket.colourName, rarity: pocket.rarity };
  const grants = {};
  if (itemOnRarity(game) && typeof resolveSource === "function") {
    for (const row of stakes) {
      const bet = normalizeBet(game, row.stake);
      if (bet?.type !== "rarity" || !betWins(bet, pocket)) continue;
      const drawn = drawOfRarity(game, pools, pocket.rarity, rng);
      const source = drawn && await resolveSource(drawn.entry.uuid);
      if (source) grants[row.id] = grantData(source, drawn, game);
    }
  }
  return { outcome, roll: data, pockets: pockets.map(p => ({ colour: p.colour, rarity: p.rarity })), colours: coloursOf(game), grants };
}

// kinds.js settle: the coins back for one stake that passed the guards, and
// the item the roll drew for it, if any.
function settle({ game, outcome, row, stake: kept, grants = {} }) {
  const pocket = pocketsOf(game)[outcome?.index] ?? null;
  const bet = normalizeBet(game, kept);
  const [line] = resolve(pocket, [{ ...(bet ?? {}), stakeCp: Math.round((Number(row.price) || 0) * 100) }], game);
  const granted = grants[row.id] ?? null;
  const out = { payoutCp: line?.payoutCp ?? 0 };
  if (granted?.grant) Object.assign(out, { result: granted.result, grant: granted.grant, name: `${betName(game, bet)}: ${granted.result.name}` });
  return out;
}

/* ---------- Words ---------- */

// "The ball lands on 7, red, Rare." The verdict, everywhere.
export function verdictText(outcome, colours = ROULETTE_DEFAULTS.colours) {
  if (!outcome) return "";
  const colour = String(colours[outcome.colour] ?? outcome.colourName ?? "").toLowerCase();
  return t("LOOTCRATES.Roulette.Verdict", { number: outcome.number, colour, rarity: RARITY_LABEL[outcome.rarity] ?? outcome.rarity });
}

/*
  Each character's net across their bets this round, from the resolve's
  stakes: [{ actorId, actorName, net (cp), won: [names], lost: [names],
  items: [names], refunded: n }]. A refunded stake (the character changed
  hands) counts as neither.
*/
export function netByActor(stakes = []) {
  const by = new Map();
  for (const s of stakes) {
    let a = by.get(s.actorId);
    if (!a) by.set(s.actorId, (a = { actorId: s.actorId, actorName: s.actorName, net: 0, won: [], lost: [], items: [], refunded: 0 }));
    if (s.action !== "settle") { a.refunded++; continue; }
    const stakeCp = Math.round((Number(s.price) || 0) * 100);
    a.net += (Number(s.payoutCp) || 0) - stakeCp;
    const name = s.stake?.label ?? "";
    (s.payoutCp > 0 ? a.won : a.lost).push(name);
    if (s.result?.name) a.items.push(s.result.name);
  }
  return [...by.values()];
}

// "Crate Tester wins 10 gp on Red", "Orla loses 5 gp", "Bo breaks even";
// "Someone wins 10 gp" for a stake whose name is gone.
export function netText(a) {
  const name = a.actorName || t("LOOTCRATES.Auction.Someone");
  const on = a.won.length ? t("LOOTCRATES.Roulette.OnBets", { bets: a.won.join(", ") }) : "";
  const item = a.items.length ? t("LOOTCRATES.Roulette.AndFinds", { items: a.items.join(", ") }) : "";
  if (a.net > 0) return t("LOOTCRATES.Roulette.Wins", { name, price: formatPrice(a.net / 100), on, item });
  if (a.net < 0) return t("LOOTCRATES.Roulette.Loses", { name, price: formatPrice(-a.net / 100), item });
  if (!a.won.length && !a.lost.length) return t("LOOTCRATES.Roulette.StakeBack", { name });
  return t("LOOTCRATES.Roulette.BreaksEven", { name, on, item });
}

export const netLines = stakes => netByActor(stakes).map(netText);

// The pockets a resolve message carries, as the wheel draws them.
export function pocketsIn(reveal) {
  const names = reveal?.colours ?? ROULETTE_DEFAULTS.colours;
  return (reveal?.pockets ?? []).map((p, i) => ({ n: i + 1, colour: p.colour === 1 ? 1 : 0, colourName: names[p.colour === 1 ? 1 : 0], rarity: normalizeRarity(p.rarity) }));
}

/* ---------- The wheel ---------- */

// The spin's length, and when the ball dips into the rim (the drop).
export const WHEEL_TIMING = { spin: 5600, dropAt: 0.78, wheelTurns: 2, ballTurns: 6 };

const RIM = { outer: 97, rim: 86, inner: 84, hub: 26, label: 60, ball: 90, ballIn: 70 };
const DEG = Math.PI / 180;
const pt = (r, a) => `${(r * Math.sin(a * DEG)).toFixed(2)} ${(-r * Math.cos(a * DEG)).toFixed(2)}`;

// An annular sector from angle a0 to a1 (degrees clockwise from the top).
export function arcPath(r0, r1, a0, a1) {
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${pt(r1, a0)} A${r1} ${r1} 0 ${large} 1 ${pt(r1, a1)} L${pt(r0, a1)} A${r0} ${r0} 0 ${large} 0 ${pt(r0, a0)} Z`;
}

// The disc: N pocket wedges in the two colour tones, the rarity rim arcs
// (the odds ribbon, bent round), and each pocket's number. Static SVG; the
// loop turns the whole disc.
export function wheelSVG(pockets, esc = s => String(s ?? "")) {
  const n = pockets.length || 1;
  const step = 360 / n;
  const parts = pockets.map((p, i) => {
    const a0 = i * step, a1 = (i + 1) * step, mid = a0 + step / 2;
    return `<path class="lc-wheel__pocket lc-wheel__pocket--${p.colour}" d="${arcPath(RIM.hub, RIM.inner, a0, a1)}"></path>`
      + `<path class="lc-wheel__rim lc-rarity-${esc(p.rarity)}" d="${arcPath(RIM.rim, RIM.outer, a0 + 0.6, a1 - 0.6)}"></path>`
      + `<text class="lc-wheel__n" transform="rotate(${mid.toFixed(2)}) translate(0 ${-RIM.label})" text-anchor="middle" dominant-baseline="central">${esc(p.n)}</text>`;
  }).join("");
  return `<svg class="lc-wheel__disc" viewBox="-100 -100 200 200" aria-hidden="true"><circle class="lc-wheel__ground" r="99"></circle>${parts}<circle class="lc-wheel__hub" r="${RIM.hub}"></circle><rect class="lc-wheel__pip" x="-4" y="-4" width="8" height="8" transform="rotate(45)"></rect></svg>`;
}

const easeOut3 = p => 1 - Math.pow(1 - p, 3);
const easeOut4 = p => 1 - Math.pow(1 - p, 4);
const clamp01 = x => Math.max(0, Math.min(1, x));

/*
  Where the disc and the ball are at progress p (0..1) of a spin landing in
  pocket `index` of n: { wheel, ball, radius }. The disc turns clockwise
  wheelTurns and comes to rest with the pocket's centre under the pin at
  the top; the ball runs anticlockwise ballTurns and stops at the pin, so
  at p = 1 it sits in the pocket. Both ease out, the ball harder, and the
  ball dips from the rim to the pocket's floor from dropAt on. The pocket
  under the ball at any moment is pocketUnder(pose, n), for the ticks.
*/
export function wheelPose(p, index, n, timing = WHEEL_TIMING) {
  const q = clamp01(p);
  const step = 360 / Math.max(1, n);
  const wheelTotal = timing.wheelTurns * 360 - (index + 0.5) * step;
  const ballTotal = -timing.ballTurns * 360;
  const dip = clamp01((q - timing.dropAt) / (1 - timing.dropAt));
  return { wheel: wheelTotal * easeOut3(q), ball: ballTotal * easeOut4(q), radius: RIM.ball - (RIM.ball - RIM.ballIn) * easeOut3(dip) };
}

// The index of the pocket under the ball for a pose.
export function pocketUnder(pose, n) {
  const rel = (((pose.ball - pose.wheel) % 360) + 360) % 360;
  return Math.floor(rel / (360 / Math.max(1, n))) % Math.max(1, n);
}

/*
  The wheel in `host`, with the rail beside it (the chips are the caller's,
  tableview.js railHTML, placed through rail()). Returns { rail(html),
  spin({ index, onTick, onDrop, onLand, duration, reducedMotion }) ->
  controller, landed }: spin() runs one requestAnimationFrame loop writing
  the disc's rotation and the ball's rotation and radius from the time
  since its first frame, and lands with the ball in the pocket, the host
  marked lc-table__stage--landed and data-pocket set. The controller is
  the one the core expects of a kind's play: play() (resolves on landing),
  skip() (lands now), skipped, reducedMotion. onTick(progress) fires as
  the ball crosses into another pocket (a tick), onDrop once as it dips.
*/
export function mountWheel(host, { pockets = [], esc = s => String(s ?? "") } = {}) {
  host.classList.add("lc-table__stage");
  host.classList.remove("lc-table__stage--spinning", "lc-table__stage--landed");
  host.innerHTML = `<div class="lc-wheel" aria-hidden="true">
      <div class="lc-wheel__turn">${wheelSVG(pockets, esc)}</div>
      <div class="lc-wheel__orbit"><div class="lc-wheel__ball"></div></div>
      <div class="lc-wheel__pin"></div>
    </div>
    <div class="lc-rail" aria-hidden="true"></div>`;
  const disc = host.querySelector(".lc-wheel__turn");
  const orbit = host.querySelector(".lc-wheel__orbit");
  const ball = host.querySelector(".lc-wheel__ball");
  const railEl = host.querySelector(".lc-rail");
  const set = (el, props) => { if (!el?.style) return; for (const [k, v] of Object.entries(props)) el.style[k] = v; };
  const n = pockets.length;
  const pose = (p, index) => {
    const at = wheelPose(p, index, n);
    set(disc, { transform: `rotate(${at.wheel.toFixed(2)}deg)` });
    set(orbit, { transform: `rotate(${at.ball.toFixed(2)}deg)` });
    set(ball, { transform: `translateY(${(-at.radius).toFixed(2)}px)`, opacity: "1" });
    return at;
  };
  const out = {
    landed: false,
    rail(html) { if (railEl) railEl.innerHTML = html; },
    spin({ index = 0, onTick = null, onDrop = null, onLand = null, duration = WHEEL_TIMING.spin, reducedMotion } = {}) {
      const reduced = reducedMotion ?? (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
      host.classList.add("lc-table__stage--spinning");
      host.dataset.pocket = "";
      let landed = false, frame = null, t0 = null, resolveDone = null, last = null, dropped = false;
      const land = () => {
        if (landed) return;
        landed = true;
        if (frame != null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
        pose(1, index);
        host.classList.remove("lc-table__stage--spinning");
        host.classList.add("lc-table__stage--landed");
        host.dataset.pocket = String(index + 1);
        out.landed = true;
        onLand?.();
        resolveDone?.();
      };
      const step = now => {
        if (landed) return;
        t0 ??= now;
        const p = (now - t0) / duration;
        const at = pose(p, index);
        const under = pocketUnder(at, n);
        if (last != null && under !== last) { try { onTick?.(clamp01(p)); } catch (err) { console.error("loot-crates | the wheel's tick failed", err); } }
        last = under;
        if (!dropped && p >= WHEEL_TIMING.dropAt) { dropped = true; try { onDrop?.(); } catch (err) { console.error("loot-crates | the wheel's drop cue failed", err); } }
        if (p >= 1) land();
        else frame = requestAnimationFrame(step);
      };
      const ctrl = {
        skipped: false,
        reducedMotion: reduced,
        play() {
          if (landed) return Promise.resolve();
          if (reduced || duration <= 0) { land(); return Promise.resolve(); }
          return new Promise(resolve => { resolveDone = resolve; frame = requestAnimationFrame(step); });
        },
        skip() { ctrl.skipped = true; land(); },
      };
      return ctrl;
    },
  };
  pose(0, 0);
  set(ball, { opacity: "0" });
  return out;
}

/* ---------- The table window's pieces (tableview.js calls these) ---------- */

/*
  The bet form's fields: what to bet on, the pick (its options follow the
  type), the stake within the GM's bounds. tableview.js wraps them in the
  form with the character and the one button; readBet below reads them.
*/
export function betFields(game, { esc = s => String(s ?? ""), values = {} } = {}) {
  const type = BET_TYPES.includes(values.type) ? values.type : "colour";
  const odds = betOdds(game);
  const min = minStakeOf(game), max = maxStakeOf(game);
  const stake = Number(values.stake) >= min ? Number(values.stake) : min;
  const types = BET_TYPES.filter(k => odds[k].length).map(k => `<option value="${k}"${k === type ? " selected" : ""}>${t("LOOTCRATES.Roulette.TypePays", { type: esc(BET_TYPE_LABEL[k]), pays: esc(+odds.payouts[k].toFixed(2)) })}</option>`).join("");
  return `<label class="lc-table__field"><span class="lc-label">${t("LOOTCRATES.Roulette.BetOn")}</span><select name="type" class="lc-table__type">${types}</select></label>
      <label class="lc-table__field"><span class="lc-label">${t("LOOTCRATES.Roulette.Pick")}</span><select name="pick" class="lc-table__pick">${pickOptions(game, type, values.pick, esc)}</select></label>
      <label class="lc-table__field lc-table__field--stake"><span class="lc-label">${t("LOOTCRATES.Roulette.StakeGp")}</span><input name="stake" type="number" min="${esc(min)}"${max != null ? ` max="${esc(max)}"` : ""} step="1" value="${esc(stake)}" class="lc-table__stake"></label>`;
}

// The pick select's options for a bet type, each naming its odds.
export function pickOptions(game, type, picked = null, esc = s => String(s ?? "")) {
  const rows = betOdds(game)[type] ?? [];
  return rows.map(o => `<option value="${esc(o.pick)}"${String(o.pick) === String(picked) ? " selected" : ""}>${esc(o.name)}, ${esc(o.fraction ?? o.label)}</option>`).join("");
}

// The bet the form's values describe, with the stake the Buy carries, or a
// PullError saying what is wrong, before anything is sent.
export function readBet(game, values) {
  const type = values.type;
  let pick = values.pick;
  if (type === "colour" || type === "number") pick = Number(pick);
  const bet = normalizeBet(game, { type, pick });
  if (!bet) throw new PullError(t("LOOTCRATES.Roulette.PickBet"));
  const stake = Number(values.stake);
  const min = minStakeOf(game), max = maxStakeOf(game);
  if (!(stake >= min)) throw new PullError(t("LOOTCRATES.Roulette.StakeAtLeast", { price: formatPrice(min) }));
  if (max != null && stake > max) throw new PullError(t("LOOTCRATES.Roulette.StakeAtMost", { price: formatPrice(max) }));
  return { bet: { ...bet, stake }, price: stake };
}

// The window's result, once the ball is still, into its live region: the
// verdict in the slab face, then each character's net.
function tableResult(reveal, { esc = String } = {}) {
  const lines = netLines(reveal.stakes ?? []);
  return `<div class="lc-reveal__quiet lc-table__verdict">${esc(verdictText(reveal.outcome, reveal.colours))}</div>`
    + (lines.length ? `<div class="lc-reveal__where">${lines.map(esc).join(" · ")}</div>` : `<div class="lc-reveal__where">${t("LOOTCRATES.Roulette.NobodyBet")}</div>`);
}

// The sting, by what the viewer's own characters did: a win rises, an item
// plays its rarity; otherwise the landing is the drop that already played.
function tableSting(reveal, { actorIds = [] } = {}) {
  const mine = netByActor(reveal.stakes ?? []).filter(a => actorIds.includes(a.actorId));
  const item = (reveal.stakes ?? []).find(s => actorIds.includes(s.actorId) && s.result?.rarity);
  if (item) playReveal(item.result.rarity);
  else if (mine.some(a => a.net > 0)) playCoinBack();
}

/* ---------- The chat card ---------- */

// One card per round, after the landing: the pocket and every character's
// net, in the item block the core seals until this client's wheel stops.
function chatCard(reveal, { esc }) {
  const o = reveal.outcome;
  if (!o) return null;
  const n = (reveal.stakes ?? []).filter(s => s.action === "settle").length;
  const lines = netLines(reveal.stakes ?? []);
  return `
    <div class="loot-crates lc-chat lc-rarity-${esc(o.rarity)}">
      <div class="lc-chat__head">${t("LOOTCRATES.Roulette.ChatHead", { box: `<strong>${esc(reveal.box?.name ?? "")}</strong>`, bets: `<span class="lc-chat__price">${esc(t(n === 1 ? "LOOTCRATES.Table.BetsOne" : "LOOTCRATES.Table.BetsMany", { count: n }))}</span>` })}</div>
      <div class="lc-chat__item">
        <span class="lc-chat__pocket lc-wheel__pocket--${esc(o.colour)}" aria-hidden="true">${esc(o.number)}</span>
        <div>
          <div class="lc-chat__name">${esc(verdictText(o, reveal.colours))}</div>
          <div class="lc-chat__rarity">${esc(RARITY_LABEL[o.rarity] ?? o.rarity)} · ${esc(String(reveal.colours?.[o.colour] ?? o.colourName ?? ""))}</div>
          ${lines.length ? `<div class="lc-chat__text">${t("LOOTCRATES.Common.Sentence", { text: lines.map(esc).join(". ") })}</div>` : ""}
        </div>
      </div>
    </div>`;
}

/* ---------- The shop card ---------- */

const WHEEL_ART = `<svg class="lc-wheel__icon" viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 3v6M12 15v6M3 12h6M15 12h6M5.6 5.6l4.3 4.3M14.1 14.1l4.3 4.3M5.6 18.4l4.3-4.3M14.1 9.9l4.3-4.3"/><circle cx="12" cy="5.5" r="1.2" fill="currentColor" stroke="none"/></svg>`;

// The wheel's words for what the round is doing (round.js roundState), on
// the shop card and in the table window's head.
export const WHEEL_WORDS = words({ open: "LOOTCRATES.Roulette.WordsOpen", waiting: "LOOTCRATES.Roulette.WordsWaiting", held: "LOOTCRATES.Roulette.WordsHeld" });
export const roundState = (round, opts = {}) => tableRoundState(round, { ...opts, words: WHEEL_WORDS });
export { clockText } from "./round.js";

// The rarity bands as the ribbon and pills; the other bets as one line each.
export function rouletteOddsHTML(odds, esc = s => String(s ?? "")) {
  if (!odds.pockets) return "";
  const segs = odds.rarity.map(r => `<span class="lc-ribbon__seg lc-rarity-${r.pick}" style="flex-grow:${+r.chance.toFixed(4)}" title="${esc(r.name)} ${esc(r.label)}"></span>`).join("");
  const pills = odds.rarity.map(r => `<span class="lc-odd lc-rarity-${r.pick}">${esc(r.short ?? r.name)} ${esc(r.label)}</span>`).join("");
  return `<div class="lc-ribbon" aria-hidden="true">${segs}</div><div class="lc-box__odds">${pills}</div>`;
}

// "Red or Black 1 in 2, pays 2×": the three plain bets in one line each.
export function betLines(odds) {
  const lines = [];
  const half = t("LOOTCRATES.Roulette.OneIn", { n: 2 });
  if (odds.colour.length) lines.push(t("LOOTCRATES.Roulette.LineColour", { names: odds.colour.map(o => o.name).join(t("LOOTCRATES.Common.Or")), odds: odds.colour.length === 2 && odds.colour[0].count === odds.colour[1].count ? half : odds.colour.map(o => `${o.name} ${o.label}`).join(", "), pays: +odds.payouts.colour.toFixed(2) }));
  if (odds.parity.length) lines.push(t("LOOTCRATES.Roulette.LineParity", { odds: odds.parity.length === 2 && odds.parity[0].count === odds.parity[1].count ? half : odds.parity.map(o => `${o.name} ${o.label}`).join(", "), pays: +odds.payouts.parity.toFixed(2) }));
  if (odds.pockets) lines.push(t("LOOTCRATES.Roulette.LineNumber", { odds: t("LOOTCRATES.Roulette.OneIn", { n: odds.pockets }), pays: +odds.payouts.number.toFixed(2) }));
  if (odds.rarity.length) lines.push(t("LOOTCRATES.Roulette.LineRarity", { pays: +odds.payouts.rarity.toFixed(2) }));
  return lines.map(l => l.replace(/\s+/g, " "));
}

/* ---------- The rail (the felt's bet spots and chips) ---------- */

// The chip's letter: a character's initial.
const initialOf = name => (String(name ?? "").trim()[0] ?? "?").toUpperCase();

/*
  The bet spots with every character's chips on them, as bets arrive: the
  two colours and odd or even on the first row, the numbers, then the
  rarity bands (each spot in the rarity's swatch, its bar along the foot
  as a strip card's). A chip is a gold-rimmed disc with the character's
  initial; `fresh` (log ids) marks chips that just landed. Once the ball
  is down (`outcome`), the winning spots are lit and the rest step back.
  Decorative to assistive tech: tableview.js lists the stakes in words.
*/
export function railHTML(game, stakes = [], { esc = s => String(s ?? ""), outcome = null, fresh = [], actorIds = [] } = {}) {
  const pockets = pocketsOf(game);
  const pocket = outcome ? pockets[outcome.index] ?? null : null;
  const live = stakes.filter(r => isOpenStake(r) || r.status === "settled");
  const chipsOn = key => live.filter(r => spotKey(normalizeBet(game, r.stake)) === key).map(r => `<span class="lc-token lc-rarity-${esc(betSwatch(normalizeBet(game, r.stake)))}${fresh.includes(r.id) ? " lc-token--new" : ""}${actorIds.includes(r.actorId) ? " lc-token--mine" : ""}" title="${t("LOOTCRATES.Roulette.ChipTitle", { name: esc(r.actorName || t("LOOTCRATES.Auction.Someone")), price: esc(formatPrice(r.price)), on: esc(r.name ?? "") })}">${esc(initialOf(r.actorName))}</span>`).join("");
  const spot = (bet, label, extra = "") => {
    const key = spotKey(bet);
    const won = pocket ? betWins(bet, pocket) : false;
    const chips = chipsOn(key);
    return `<div class="lc-spot ${extra}${won ? " lc-spot--won" : ""}${pocket && !won ? " lc-spot--out" : ""}" data-spot="${esc(key)}"><span class="lc-spot__label">${esc(label)}</span><span class="lc-spot__chips">${chips}</span></div>`;
  };
  const colours = optionsOf(game, "colour").map(o => spot({ type: "colour", pick: o.pick }, o.name, `lc-spot--colour lc-wheel__pocket--${o.pick}`));
  const parity = optionsOf(game, "parity").map(o => spot({ type: "parity", pick: o.pick }, o.name, "lc-spot--parity"));
  const numbers = pockets.map(p => spot({ type: "number", pick: p.n }, String(p.n), `lc-spot--number lc-wheel__pocket--${p.colour} lc-rarity-${esc(p.rarity)}`));
  const bands = optionsOf(game, "rarity").map(o => spot({ type: "rarity", pick: o.pick }, o.short ?? o.name, `lc-spot--rarity lc-rarity-${esc(o.pick)}`));
  return `<div class="lc-rail__row lc-rail__row--outside">${colours.join("")}${parity.join("")}</div>
      <div class="lc-rail__row lc-rail__row--numbers">${numbers.join("")}</div>
      <div class="lc-rail__row lc-rail__row--bands">${bands.join("")}</div>`;
}

// Why this player can't bet now, or "": the wheel still turning here, no
// round, bets closed, the cap reached; being short of the least stake is
// the card's last word, as for every kind. The GM's card is off only for a
// wheel with no pockets and while the last round still turns here: Open a
// round waits for it (table.js openRound refuses it too).
function wheelState(game, odds, ctx) {
  if (!odds.pockets || odds.pockets < 2) return t("LOOTCRATES.Roulette.NoPockets");
  const round = liveRoundOf(ctx.rounds ?? {}, game.id);
  const state = roundState(round, { now: ctx.now ?? Date.now(), held: !!ctx.held?.(game.id) });
  if (state.key === "spinning") return t("LOOTCRATES.Card.StillSpinning");
  if (ctx.isGM) return "";
  if (state.key === "none") return t("LOOTCRATES.Round.WordsNone");
  if (state.key === "closed") return t("LOOTCRATES.Round.WordsClosed");
  const cap = maxBetsOf(game);
  const mine = betsPlaced(ctx.log?.filter?.(r => r.roundId === round?.id) ?? [], ctx.actorId);
  if (cap && mine >= cap) return t("LOOTCRATES.Roulette.BetsPlaced", { mine, cap });
  return "";
}

function card(game, pools, ctx) {
  const esc = ctx.esc ?? (s => String(s ?? ""));
  const odds = betOdds(game);
  const round = liveRoundOf(ctx.rounds ?? {}, game.id);
  const state = roundState(round, { now: ctx.now ?? Date.now(), held: !!ctx.held?.(game.id) });
  const reason = wheelState(game, odds, ctx) || (ctx.hasActor && !canAfford(ctx.purse ?? {}, minStakeOf(game)) ? t("LOOTCRATES.Card.Needs", { price: formatPrice(shortfall(ctx.purse ?? {}, minStakeOf(game))) }) : "");
  const bounds = [maxStakeOf(game) != null ? t("LOOTCRATES.Roulette.StakeRange", { min: formatPrice(minStakeOf(game)), max: formatPrice(maxStakeOf(game)) }) : t("LOOTCRATES.Roulette.StakeOrMore", { min: formatPrice(minStakeOf(game)) }), maxBetsOf(game) ? t(maxBetsOf(game) === 1 ? "LOOTCRATES.Roulette.BetsARoundOne" : "LOOTCRATES.Roulette.BetsARoundMany", { count: maxBetsOf(game) }) : ""].filter(Boolean).join(", ");
  const middle = [
    rouletteOddsHTML(odds, esc),
    `<div class="lc-box__rule">${betLines(odds).map(esc).join("<br>")}</div>`,
    `<div class="lc-box__stock">${esc(bounds)}</div>`,
    `<div class="lc-box__round" data-round="${esc(state.key)}"${state.closesAt ? ` data-lc-countdown="${esc(state.closesAt)}"` : ""}>${esc(state.text)}</div>`,
  ];
  const label = ctx.isGM ? (round ? t("LOOTCRATES.Boxes.GoToTable") : t("LOOTCRATES.Boxes.OpenRound")) : t("LOOTCRATES.Table.PlaceBet");
  const top = odds.rarity.at(-1)?.pick;
  return cardShell(game, ctx, { rarityClass: top ? `lc-rarity-${top}` : "lc-box--wheel", art: WHEEL_ART, middle, reason, label, price: minStakeOf(game) });
}

const reason = (game, pools, ctx) => wheelState(game, betOdds(game), ctx) || shopReason(ctx) || (ctx.hasActor && !ctx.isGM && !canAfford(ctx.purse ?? {}, minStakeOf(game)) ? t("LOOTCRATES.Card.Needs", { price: formatPrice(shortfall(ctx.purse ?? {}, minStakeOf(game))) }) : "");

/* ---------- The manager's words ---------- */

// "12 pockets, 2 colours, bets 5 gp to 50 gp, 3 a round, 45 s": the Boxes table's rules cell.
export function rouletteRulesText(game) {
  const n = pocketsOf(game).length;
  const max = maxStakeOf(game);
  return [t(n === 1 ? "LOOTCRATES.Roulette.PocketsOne" : "LOOTCRATES.Roulette.PocketsMany", { count: n }), max != null ? t("LOOTCRATES.Roulette.RuleBetsRange", { min: formatPrice(minStakeOf(game)), max: formatPrice(max) }) : t("LOOTCRATES.Roulette.RuleBetsOrMore", { min: formatPrice(minStakeOf(game)) }), maxBetsOf(game) ? t("LOOTCRATES.Roulette.RuleARound", { count: maxBetsOf(game) }) : "", windowMsOf(game) ? t("LOOTCRATES.Roulette.RuleSeconds", { count: windowMsOf(game) / 1000 }) : t("LOOTCRATES.Roulette.RuleUntilSpin"), itemOnRarity(game) ? t("LOOTCRATES.Roulette.RuleItemOnRarity") : ""].filter(Boolean).join(", ");
}

/*
  The wheel as the editor's form would save it: the form lists each
  pocket's id in `pockets` with p.<id>.colour and p.<id>.rarity; the two
  colours, the four payouts, the bounds and the item rule by name.
*/
export function draftRoulette(game, values, poolIds) {
  const ids = [].concat(values.pockets ?? []).map(String).filter(Boolean);
  const pockets = ids.map(id => ({ colour: Number(values[`p.${id}.colour`]) === 1 ? 1 : 0, rarity: normalizeRarity(values[`p.${id}.rarity`]) }));
  const num = (v, d) => (Number.isFinite(Number(v)) && String(v).trim() !== "" ? Math.max(0, Number(v)) : d);
  const colours = [values.colourA, values.colourB].map((c, i) => String(c ?? "").trim() || ROULETTE_DEFAULTS.colours[i]);
  return {
    ...game,
    pools: poolIds.filter(id => values[`pool.${id}`] === true || values[`pool.${id}`] === "on").map(id => ({ id, share: 1 })),
    price: num(values.price, ROULETTE_DEFAULTS.price),
    roulette: {
      ...(game.roulette ?? {}),
      colours,
      pockets: pockets.length ? pockets : pocketsOf(game).map(p => ({ colour: p.colour, rarity: p.rarity })),
      payouts: Object.fromEntries(BET_TYPES.map(type => [type, num(values[`pay.${type}`], payoutOf(game, type))])),
      maxStake: values.maxStake === "" || values.maxStake == null ? null : num(values.maxStake, null),
      maxBets: Math.floor(num(values.maxBets, 0)),
      windowSec: Math.floor(num(values.windowSec, 0)),
      itemOnRarity: values.itemOnRarity === true || values.itemOnRarity === "on",
    },
  };
}

// The editor's preview: the ribbon and rarity pills, the bet lines, and a
// warning when a rarity band's item has nowhere to draw from.
export function roulettePreview(game, pools) {
  const odds = betOdds(game);
  let note = "", warn = false;
  if (odds.pockets < 2) { note = t("LOOTCRATES.Roulette.PreviewTwoPockets"); warn = true; }
  else if (itemOnRarity(game)) {
    const dry = odds.rarity.filter(r => !drawOfRarity(game, pools, r.pick, () => 0)).map(r => r.name);
    if (!game.pools?.length) note = t("LOOTCRATES.Roulette.PreviewNoPool");
    else if (dry.length) note = t(dry.length === 1 ? "LOOTCRATES.Roulette.PreviewDryOne" : "LOOTCRATES.Roulette.PreviewDryMany", { bands: dry.join(", ") });
  }
  return { odds, note, warn };
}

export function roulettePreviewHTML(preview, esc = s => String(s ?? "")) {
  const { odds, note, warn } = preview;
  return `${rouletteOddsHTML(odds, esc)}<p class="lc-form__hint">${betLines(odds).map(esc).join("<br>")}</p>${note ? `<p class="lc-form__hint${warn ? " lc-form__hint--warn" : ""}">${esc(note)}</p>` : ""}`;
}

export function rouletteSummary(preview) {
  const bands = preview.odds.rarity.map(r => `${r.name} ${r.label}`).join(", ");
  return [bands, ...betLines(preview.odds), preview.note].filter(Boolean).join(". ");
}

export const ROULETTE = registerKind({
  id: "roulette",
  noun: "wheel",
  table: true,
  priceOf,
  stake,
  roll,
  settle,
  gotText: out => t("LOOTCRATES.Roulette.GotText", { on: out?.stake?.label ?? t("LOOTCRATES.Roulette.TheWheel") }),
  // The shared table window's pieces (tableview.js, tablewindow.js).
  tableView: {
    title: game => t("LOOTCRATES.Roulette.Title", { name: game?.name ?? t("LOOTCRATES.Table.TheTable") }),
    get verb() { return t("LOOTCRATES.Shelf.Bets"); },
    words: WHEEL_WORDS,
    fields: betFields,
    pickOptions,
    readBet,
    mount: mountWheel,
    rail: railHTML,
    pockets: pocketsOf,
    pocketsIn,
    outcomeIndex: reveal => reveal?.outcome?.index ?? 0,
    result: tableResult,
    sting: tableSting,
    sounds: { tick: progress => playTick(progress), drop: () => playDrop() },
    spotKey, betSwatch,
    windowMs: windowMsOf,
    rarityOf: reveal => reveal?.outcome?.rarity ?? "none",
  },
  chat: { card: chatCard },
  shop: { card, reason },
});
