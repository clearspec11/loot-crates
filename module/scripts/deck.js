/*
  The Deck of Many Things: the fourth kind of game (kinds.js), one card
  drawn from a deck the GM wrote. Every card is a prize or a cost: an item
  from the deck's pools at rarity odds (the crate's draw), a payout of
  coins, a loss of coins, an effect the GM plays out from its text, or a
  blank. Nothing copyrighted ships: the default deck is five placeholders
  the GM renames or replaces.

  - A card marked "once" leaves the deck when drawn, until the GM
    reshuffles. Which cards are out is read from the pull log, the way the
    well's cap is: the unrefunded rows at this deck since the deck's
    shuffledAt mark name their card, so a refund puts the card back by
    itself and nothing is reset by hand.
  - The price rises with each draw in a row: the first draw costs the
    record's price, the next base x step, then base x step^2, as long as
    each draw follows the last within STREAK_MS (two minutes; the moment
    the table shouts "again"). Waiting longer, or a refund of the last
    draw, brings it back down. The core charges this price (kinds.js
    priceOf), checks the Buy's price against it and writes it to the row,
    so the refund gives back what was paid.
  - A bane takes its coins through the core's one settle(): the roll says
    a negative payout, never touching the purse itself, and takes no more
    than the purse holds after the stake. It is the one result in the
    module that means "you lost something", so it alone gets the cold
    slate token (--lc-bane), a dimmed vault and the falling notes
    (sound.js playBane). Everything else is the crate's hold, seal, wash
    and sting as they were.
  - The reveal is one card: it lifts, holds face-down under three soft
    ticks, then turns once, on one animation frame loop writing one
    transform. Every card posts a chat card (the table should see every
    draw), sealed by the core until this client's card has turned; an
    effect card's text rides in it for the GM to adjudicate.
  - "Draw again for N gp" (the core's again button, reveal.js) is the push
    of the game: the buyer's next draw from the window, at the risen
    price, with the cards left beside it.

  Record: { kind: "deck", price (the first draw, gp), pools, weights (the
  item cards' rarity odds), deck: { step, shuffledAt, cards: [{ id, label,
  kind: item | coins | loss | effect | blank, weight, once, gp, text }] },
  rules: {} }. The deck keeps no per-buyer state.

  No Foundry globals: the core passes the log, the purse and the clock, so
  Vitest runs the plan, the price and the roll as they are.
*/
import { RARITY_LABEL } from "./config.js";
import { shopOdds, weightedPick, wholePercents, chanceLabel } from "./odds.js";
import { formatPrice, formatGold, toCopper, canAfford, shortfall } from "./currency.js";
import { playTick, playReveal, playCoinBack, playPlink, playBane } from "./sound.js";
import { resultHTML } from "./revealcard.js";
import { cardShell, oddsRibbon, oddsPills, shopReason, shortReason, draftBox } from "./boxcard.js";
import { drawItem, grantData, crateLogRow } from "./crate.js";
import { PullError, registerKind } from "./kinds.js";

export const CARD_KINDS = ["item", "coins", "loss", "effect", "blank"];
// The pills' and the editor's names for what a card does.
export const CARD_KIND_LABEL = { item: "Item", coins: "Coins", loss: "Loss", effect: "Effect", blank: "Blank" };
export const CARD_KIND_HINT = { item: "An item from the pools", coins: "Coins into the purse", loss: "Coins out of the purse", effect: "An effect you play out", blank: "Nothing" };
// A result's tone: what the stage, the vault and the sting do with it.
export const TONE_OF = { item: "boon", coins: "coin", loss: "bane", effect: "effect", blank: "blank" };
// The swatch (module.css lc-rarity-*) a non-item card is drawn in: the
// coin's gold rim, the bane's cold slate, mute ink for the rest.
const SWATCH_OF = { coins: "coin", loss: "bane", effect: "none", blank: "none" };
// How long after a draw the next one still counts as "in a row".
export const STREAK_MS = 120000;

// Placeholders, not a published deck: the GM renames or replaces them.
export const DECK_DEFAULTS = {
  price: 10, step: 1.5,
  cards: [
    { id: "fortune", label: "Fortune", kind: "item", weight: 2 },
    { id: "windfall", label: "Windfall", kind: "coins", weight: 2, gp: 50 },
    { id: "ruin", label: "Ruin", kind: "loss", weight: 2, gp: 20 },
    { id: "omen", label: "Omen", kind: "effect", weight: 1, once: true, text: "Something is set in motion. The GM says what." },
    { id: "blank", label: "A blank card", kind: "blank", weight: 3 },
  ],
};

/* ---------- The deck as written ---------- */

// Every card of the record in one shape: a missing weight is 1, a weight of
// 0 never draws, an unknown kind is a blank, an empty label is the kind's.
export function cardsOf(game) {
  return (game?.deck?.cards ?? []).map((c, i) => {
    const kind = CARD_KINDS.includes(c?.kind) ? c.kind : "blank";
    return {
      id: String(c?.id ?? `card${i}`),
      label: String(c?.label ?? "").trim() || CARD_KIND_LABEL[kind],
      kind,
      weight: c?.weight == null ? 1 : Math.max(0, Math.floor(Number(c.weight)) || 0),
      once: !!c?.once,
      gp: Math.max(0, Number(c?.gp) || 0),
      text: String(c?.text ?? "").trim(),
    };
  });
}

export const stepOf = game => (Number(game?.deck?.step) > 0 ? Number(game.deck.step) : DECK_DEFAULTS.step);
export const shuffledAt = game => Math.max(0, Number(game?.deck?.shuffledAt) || 0);

const at = r => Number(r?.at) || 0;
const deckRows = (log, boxId) => (log ?? []).filter(r => r.kind === "deck" && r.boxId === boxId && !r.refunded);

// The once cards out of the deck now: named by an unrefunded row since the
// last reshuffle. A card the GM has since set to draw every time is back in.
export function drawnIds(game, log = []) {
  const since = shuffledAt(game);
  const once = new Set(cardsOf(game).filter(c => c.once).map(c => c.id));
  return new Set(deckRows(log, game.id).filter(r => at(r) > since && r.cardId != null && once.has(String(r.cardId))).map(r => String(r.cardId)));
}

/*
  What one draw can turn up, for one buyer: { cards (the deck, weight > 0),
  live (what this draw can land on), size, left, drawn, item (the item
  cards' rarity odds, the crate's shopOdds), empty, reason }. A once card
  already drawn is out; an item card is out while the pools can give this
  buyer nothing, so the odds stay honest. `left` is the deck's own count
  ("3 of 5 cards left"): the cards not yet drawn, item cards included.
*/
export function deckPlan(game, pools, log = [], state = {}) {
  const cards = cardsOf(game).filter(c => c.weight > 0);
  const drawn = drawnIds(game, log);
  const item = shopOdds(game, pools ?? {}, state);
  const canItem = item.rows.length > 0;
  const held = cards.filter(c => !(c.once && drawn.has(c.id)));
  const live = held.filter(c => c.kind !== "item" || canItem);
  let reason = "";
  if (!cards.length) reason = "The deck has no cards";
  else if (!held.length) reason = "Every card is drawn";
  else if (!live.length) reason = "Nothing in the deck can be drawn";
  return { cards, live, size: cards.length, left: held.length, drawn: cards.length - held.length, item, canItem, empty: !live.length, reason };
}

/*
  The odds one draw is made at, as the shop and the editor show them: one
  row per kind of card still in the deck ({ key, name, chance, label }),
  labels whole percents summing to 100, never "0%" (a kind with no live
  card has no row), plus the plan. The roll draws on the same live cards.
*/
export function deckOdds(game, pools, log = [], state = {}) {
  const plan = deckPlan(game, pools, log, state);
  const weights = CARD_KINDS.map(k => [k, plan.live.filter(c => c.kind === k).reduce((n, c) => n + c.weight, 0)]).filter(([, w]) => w > 0);
  const total = weights.reduce((n, [, w]) => n + w, 0);
  const pcts = wholePercents(weights.map(([, w]) => w / total));
  return { ...plan, rows: weights.map(([key, w], i) => ({ key, name: CARD_KIND_LABEL[key], chance: w / total, label: chanceLabel(w / total, pcts[i]) })) };
}

/* ---------- The rising price ---------- */

/*
  How many draws in a row this character has made at this deck, counted
  back from `now` through the unrefunded rows: each within STREAK_MS of the
  one after it. A refund of the newest draw takes the streak down with it.
*/
export function streakOf(log, { boxId, actorId, now, within = STREAK_MS }) {
  const rows = deckRows(log, boxId).filter(r => r.actorId === actorId).sort((a, b) => at(b) - at(a));
  let n = 0, last = now;
  for (const r of rows) {
    if (last - at(r) > within) break;
    n++;
    last = at(r);
  }
  return n;
}

// The price of the (n + 1)th draw in a row: base x step^n, to the copper.
export function priceAt(game, n) {
  const base = Math.round((Number(game?.price) || 0) * 100);
  return Math.round(base * Math.pow(stepOf(game), Math.max(0, n))) / 100;
}

export const nextPrice = (game, log, { actorId, now = Date.now() }) => priceAt(game, streakOf(log, { boxId: game.id, actorId, now }));

// kinds.js priceOf: what the core charges for this play.
const priceOf = ({ game, actor, log = [], now = Date.now() }) => nextPrice(game, log, { actorId: actor?.id, now });

// "3rd draw in a row": the ordinal the card and the result use.
export const ordinal = n => `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;

/* ---------- The roll ---------- */

/*
  The draw, on the GM, before anything is charged: the plan from the log as
  it stands inside the write queue (so two quick draws of the last once
  card can't both land on it), one weighted pick, then the card's outcome.
  An item card draws from the pools the crate's way and grants the item; a
  coins card pays its gold out; a loss card takes its gold, or what the
  purse has left after the stake if that is less; an effect card carries
  its text; a blank gives nothing. The card, the cards left after this
  draw, the draw's place in the streak and the price of the next one ride
  into the reveal and the row. An item card whose pools emptied since the
  odds were read turns up blank rather than failing: the deck keeps no
  per-buyer state, so nothing is written for the pity rules.
*/
async function roll(ctx) {
  const { game, actor, state = {}, rng, log = [], now = Date.now(), price = game.price } = ctx;
  const plan = deckPlan(game, ctx.pools, log, state);
  if (plan.empty) throw new PullError(plan.reason === "The deck has no cards" ? `${game.name} has no cards. Tell the GM.` : `Nothing is left to draw from ${game.name}.`);
  const card = weightedPick(plan.live, c => c.weight, rng) ?? plan.live[0];
  const streak = streakOf(log, { boxId: game.id, actorId: actor.id, now }) + 1;
  const common = {
    card: { id: card.id, label: card.label, kind: card.kind, once: card.once },
    tone: TONE_OF[card.kind], cardsLeft: plan.left - (card.once ? 1 : 0), size: plan.size, streak, nextPrice: priceAt(game, streak),
    result: { name: card.label, outcome: card.kind }, grant: null,
  };
  if (card.kind === "item") {
    const { result, source, pools } = await drawItem({ ...ctx, state: {} });
    if (result) return { ...common, ...grantData(source, result, game), pools };
    return { ...common, tone: "blank", result: { name: card.label, outcome: "blank" }, note: "its pools held nothing" };
  }
  if (card.kind === "coins") return { ...common, payoutCp: Math.round(card.gp * 100) };
  if (card.kind === "loss") {
    const lossCp = Math.round(card.gp * 100);
    const have = Math.max(0, toCopper(actor.system?.currency ?? {}) - Math.round(price * 100));
    return { ...common, lossCp, takenCp: Math.min(lossCp, have), payoutCp: -Math.min(lossCp, have) };
  }
  if (card.kind === "effect") return { ...common, text: card.text };
  return common;
}

// The row: the card (its id is what drawnIds reads), its kind and tone,
// the draw's place in its streak, and for an item the crate's columns so
// the one refund finds and removes it; for a loss what the card took, for
// an effect its text; `swatch` colours the Pull log's dot.
function logRow(ctx) {
  const { out } = ctx;
  const base = { cardId: out.card.id, card: out.card.label, cardKind: out.card.kind, once: out.card.once, tone: out.tone, streak: out.streak, name: out.result?.name ?? out.card.label };
  if (out.tone === "boon" && out.result?.uuid) return { ...base, ...crateLogRow(ctx) };
  const row = { ...base, swatch: SWATCH_OF[out.card.kind] ?? "none" };
  if (out.tone === "bane") Object.assign(row, { lossCp: out.lossCp, takenCp: out.takenCp });
  if (out.tone === "effect") row.text = out.text ?? "";
  return row;
}

/* ---------- The reveal ---------- */

// The timeline, in ms: the card lifts, holds face-down under the ticks,
// then turns once.
export const DECK_TIMING = { lift: 300, hold: 900, flip: 420, beats: 3 };
export const deckLandTime = () => DECK_TIMING.lift + DECK_TIMING.hold + DECK_TIMING.flip;

const clamp01 = x => Math.max(0, Math.min(1, x));
const ease = p => 1 - Math.pow(1 - p, 3);

/*
  One card in `host`: its back up, lifting, then one rotateY on one
  requestAnimationFrame loop writing the card's transform and nothing else
  (the faces are placed by CSS; backface-visibility hides whichever is
  turned away). Returns the controller the core expects of a kind's play:
  play() (resolves on landing), skip() (lands now, through the same path),
  skipped, reducedMotion. `duration` scales the whole timeline (the harness
  lands at 0); reduced motion or 0 lands at once in the final pose. onBeat(i)
  fires on each of the hold's beats (the ticks). `freezeAt` (ms, unscaled)
  poses the card there and stops, for a mid-hold screenshot; skip() lands it.
*/
export function mountDeck(host, { tone = "blank", swatch = "none", label = "", kindLabel = "", img = "", duration, reducedMotion, freezeAt = null, onBeat = null, onLand = null } = {}) {
  const total = duration ?? deckLandTime();
  const reduced = reducedMotion ?? (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const scale = total / deckLandTime();
  const T = ms => ms * scale;
  host.classList.add("lc-deck", `lc-rarity-${swatch}`);
  host.classList.remove("lc-deck--landed");
  host.dataset.tone = tone;
  host.innerHTML = `<div class="lc-deck__stage" aria-hidden="true">
      <div class="lc-deck__card">
        <div class="lc-deck__face lc-deck__face--back"></div>
        <div class="lc-deck__face lc-deck__face--front">
          <div class="lc-deck__art">${img ? `<img src="${img}" alt="" draggable="false">` : `<span class="lc-deck__glyph"></span>`}</div>
          <div class="lc-deck__label"></div>
          <div class="lc-deck__kind"></div>
        </div>
      </div>
    </div>`;
  const card = host.querySelector(".lc-deck__card");
  // Text goes in as text: the card's label is the GM's.
  host.querySelector(".lc-deck__label").textContent = label;
  host.querySelector(".lc-deck__kind").textContent = kindLabel;

  const { lift, hold, flip, beats } = DECK_TIMING;
  const pose = t => {
    if (!card?.style) return;
    const up = ease(clamp01(t / T(lift)));
    const turn = t < T(lift + hold) ? 0 : ease(clamp01((t - T(lift + hold)) / T(flip)));
    card.style.transform = `translateY(${(-14 * up).toFixed(2)}px) scale(${(1 + 0.06 * Math.sin(Math.PI * turn)).toFixed(3)}) rotateY(${(180 * turn).toFixed(1)}deg)`;
  };
  const beatAt = i => T(lift + (i * hold) / beats);

  let landed = false, frame = null, t0 = null, resolveDone = null, beat = 0;
  const land = () => {
    if (landed) return;
    landed = true;
    if (frame != null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    pose(Infinity);
    host.classList.add("lc-deck--landed");
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
        if (freezeAt != null) { pose(T(freezeAt)); return; }
        const step = now => {
          if (landed) return;
          t0 ??= now;
          const t = now - t0;
          pose(t);
          while (beat < beats && t >= beatAt(beat)) {
            try { onBeat?.(beat); } catch (err) { console.error("loot-crates | the deck's beat cue failed", err); }
            beat++;
          }
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

export const toneOf = reveal => reveal.tone ?? TONE_OF[reveal.card?.kind] ?? "blank";
const swatchOf = reveal => (toneOf(reveal) === "boon" ? reveal.result?.rarity ?? "common" : SWATCH_OF[reveal.card?.kind] ?? "none");
// What the turned card says under its name: the item's rarity, else the kind.
const kindLabelOf = reveal => (toneOf(reveal) === "boon" ? RARITY_LABEL[reveal.result?.rarity] ?? reveal.result?.rarity ?? "" : CARD_KIND_LABEL[reveal.card?.kind] ?? "");

function play(host, reveal, { sound = false, pageHidden = () => false, onLand }) {
  const tone = toneOf(reveal);
  return mountDeck(host, {
    tone, swatch: swatchOf(reveal), label: reveal.card?.label ?? reveal.result?.name ?? "", kindLabel: kindLabelOf(reveal),
    img: tone === "boon" ? reveal.result?.img ?? "" : "",
    // Three soft ticks through the hold, falling as the strip's do at its end.
    onBeat: sound ? i => { if (!pageHidden()) playTick(i / Math.max(1, DECK_TIMING.beats - 1)); } : null,
    onLand,
  });
}

// "Tam draws from The Deck 15 gp · 2nd in a row": the window's head line.
function head(reveal, { esc }) {
  const again = reveal.streak > 1 ? ` <span class="lc-reveal__streak">· ${esc(ordinal(reveal.streak))} in a row</span>` : "";
  return `<span class="lc-reveal__who">${esc(reveal.actorName)}</span> draws from
        <strong class="lc-reveal__crate">${esc(reveal.box.name)}</strong>
        <span class="lc-reveal__price">${esc(formatPrice(reveal.box.price))}</span>${again}`;
}

export const cardsLeftText = (left, size) => `${left} of ${size} card${size === 1 ? "" : "s"} left`;
// " (it asked 20 gp; the purse had no more)" when the card took less than it named.
const shortNote = reveal => (reveal.takenCp < reveal.lossCp ? ` (it asked ${formatPrice(reveal.lossCp / 100)}; the purse had no more)` : "");
const takesText = reveal => `The card takes ${formatPrice((reveal.takenCp ?? 0) / 100)}${shortNote(reveal)}`;

/*
  What the window says once the card has turned, into its live region: an
  item the crate's way; otherwise the card's name as the quiet line, then
  one line with what it did, the gold left (the buyer and GMs) and the
  cards left (everyone: it is the deck's state, not the purse's). An effect
  card shows its text, for the GM to play out.
*/
function result(reveal, { esc = String, canSee = false } = {}) {
  const tone = toneOf(reveal);
  const left = reveal.cardsLeft != null && reveal.size != null ? [esc(cardsLeftText(reveal.cardsLeft, reveal.size))] : [];
  if (tone === "boon" && reveal.result?.rarity) return resultHTML(reveal, { esc, canSee, extra: left });
  const where = [];
  if (tone === "coin") where.push(`${esc(formatPrice((reveal.payoutCp ?? 0) / 100))} into ${esc(reveal.actorName)}'s purse`);
  if (tone === "bane") where.push(esc(takesText(reveal)));
  if (tone === "effect") where.push("The GM plays it out");
  if (tone === "blank") where.push(reveal.note ? `Nothing happens: ${esc(reveal.note)}` : "Nothing happens");
  if (canSee && reveal.purse) where.push(`<span class="lc-reveal__gold">${esc(formatGold(reveal.purse))} left</span>`);
  where.push(...left);
  const text = tone === "effect" && reveal.text ? `<div class="lc-deck__text">${esc(reveal.text)}</div>` : "";
  return `<div class="lc-reveal__quiet${tone === "bane" ? " lc-deck__bane" : ""}">${esc(reveal.card?.label ?? reveal.result?.name ?? "")}</div>${text}`
    + (where.length ? `<div class="lc-reveal__where">${where.join(" · ")}</div>` : "");
}

function sting(reveal) {
  const tone = toneOf(reveal);
  if (tone === "boon") playReveal(reveal.result?.rarity);
  else if (tone === "coin") playCoinBack();
  else if (tone === "bane") playBane();
  else playPlink();
}

// The buyer's own word for a card the room hears little of, in case the
// window sits behind the shop: the bane and the blank. Not an error.
function notice(reveal) {
  const tone = toneOf(reveal);
  if (tone === "bane") return `${reveal.box.name}: ${reveal.card?.label}. ${takesText(reveal)}.`;
  if (tone === "blank") return `${reveal.box.name}: ${reveal.card?.label}. Nothing happens.`;
  return null;
}

/*
  The next draw from the window (the core's again button, reveal.js): its
  price from the log as it stands, "Draw again for 15 gp", and why it is
  off: the deck is spent, the shop is shut, or the purse is short. null
  when there is no deck to draw from (its record is gone, or a replay).
*/
function again(reveal, { game = null, log = [], pools = {}, purse = {}, now = Date.now(), open = true, gmOnline = true } = {}) {
  if (!game || reveal.replay) return null;
  const price = nextPrice(game, log, { actorId: reveal.actorId, now });
  const plan = deckPlan(game, pools, log);
  const off = (plan.empty ? plan.reason : "") || shopReason({ hasActor: true, open, gmOnline }) || (!canAfford(purse, price) ? `Needs ${formatPrice(shortfall(purse, price))} more` : "");
  return { price, label: `Draw again for ${formatPrice(price)}`, off };
}

// Every card posts one: the table should see every draw. The card's words
// sit in the item block the core seals until this client's card turns,
// so the sealed card says only "Tam drew from The Deck 10 gp · Opening…".
function chatCard(reveal, { esc, itemLink }) {
  const tone = toneOf(reveal);
  const r = reveal.result ?? {};
  const label = reveal.card?.label ?? r.name ?? "";
  const art = tone === "boon" && r.img ? `<img src="${esc(r.img)}" alt="">` : `<span class="lc-deck__mark" aria-hidden="true"></span>`;
  const name = tone === "boon" && r.rarity ? itemLink(reveal.itemUuid ?? r.uuid, r.name) : esc(label);
  const line = tone === "boon" ? `${esc(label)} · ${esc(RARITY_LABEL[r.rarity] ?? r.rarity ?? "")}`
    : tone === "coin" ? `Coins · ${esc(formatPrice((reveal.payoutCp ?? 0) / 100))} into the purse`
    : tone === "bane" ? `Loss · ${esc(formatPrice((reveal.takenCp ?? 0) / 100))} taken${esc(shortNote(reveal))}`
    : tone === "effect" ? "Effect · the GM plays it out"
    : "Blank";
  const text = tone === "effect" && reveal.text ? `<div class="lc-chat__text">${esc(reveal.text)}</div>` : "";
  return `
    <div class="loot-crates lc-chat lc-rarity-${esc(swatchOf(reveal))}">
      <div class="lc-chat__head">${esc(reveal.actorName)} drew from <strong>${esc(reveal.box.name)}</strong> <span class="lc-chat__price">${esc(formatPrice(reveal.box.price))}</span></div>
      <div class="lc-chat__item">
        ${art}
        <div>
          <div class="lc-chat__name">${name}</div>
          <div class="lc-chat__rarity">${line}</div>
          ${text}
        </div>
      </div>
    </div>`;
}

/* ---------- The shop card ---------- */

const DECK_ART = `<svg class="lc-deck__icon" viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="4" width="11" height="15" rx="1.5" transform="rotate(8 12.5 11.5)"/><rect x="5" y="5" width="11" height="15" rx="1.5" fill="var(--lc-card)"/><path d="M10.5 10.3 12 8.5l1.5 1.8-1.5 1.8z" fill="currentColor" stroke="none"/><path d="M8.5 16.5h4"/></svg>`;

const OUTCOME_CLASS = { coins: "lc-rarity-coin", loss: "lc-rarity-bane", effect: "lc-rarity-none", blank: "lc-rarity-none" };
const outcomeClass = (row, odds) => (row.key === "item" ? `lc-rarity-${odds.item.top ?? "common"}` : OUTCOME_CLASS[row.key]);

// The cards still in the deck, by kind, as the shop's pills and ribbon.
export function deckOddsHTML(odds) {
  if (!odds.rows.length) return "";
  const segs = odds.rows.map(row => `<span class="lc-ribbon__seg ${outcomeClass(row, odds)}" style="flex-grow:${+row.chance.toFixed(4)}" title="${row.name} ${row.label}"></span>`).join("");
  const pills = odds.rows.map(row => `<span class="lc-odd ${outcomeClass(row, odds)}">${row.name} ${row.label}</span>`).join("");
  return `<div class="lc-ribbon" aria-hidden="true">${segs}</div><div class="lc-box__odds">${pills}</div>`;
}

// "2nd draw in a row: 15 gp (back to 10 gp after two minutes)".
export function streakLine(game, n) {
  if (n < 1) return "";
  return `${ordinal(n + 1)} draw in a row: ${formatPrice(priceAt(game, n))} (back to ${formatPrice(game.price)} after two minutes)`;
}

// Why this deck in particular can't be drawn from now, or "": its last
// card is still turning on this client (the shop holds the result;
// reveal.js), or it is spent. Being short is the card's last word.
function deckState(game, odds, ctx) {
  if (ctx.held?.(game.id)) return "Still turning";
  if (odds.empty) return odds.reason;
  return "";
}

function card(game, pools, ctx) {
  const esc = ctx.esc ?? (s => String(s ?? ""));
  const state = ctx.stateOf?.(game.id) ?? {};
  const log = ctx.log ?? [];
  const odds = deckOdds(game, pools, log, state);
  const n = streakOf(log, { boxId: game.id, actorId: ctx.actorId, now: ctx.now ?? Date.now() });
  const price = priceAt(game, n);
  const reason = deckState(game, odds, ctx) || shortReason({ price }, ctx);
  const middle = [
    deckOddsHTML(odds),
    odds.size ? `<div class="lc-box__stock">${esc(cardsLeftText(odds.left, odds.size))}</div>` : "",
    n ? `<div class="lc-box__rule">${esc(streakLine(game, n))}</div>` : "",
  ];
  return cardShell(game, ctx, { rarityClass: odds.item.top && odds.canItem ? `lc-rarity-${odds.item.top}` : "lc-box--deck", art: DECK_ART, middle, reason, label: `Draw for ${esc(formatPrice(price))}`, price });
}

function reason(game, pools, ctx) {
  const log = ctx.log ?? [];
  const odds = deckOdds(game, pools, log, ctx.stateOf?.(game.id) ?? {});
  const price = priceAt(game, streakOf(log, { boxId: game.id, actorId: ctx.actorId, now: ctx.now ?? Date.now() }));
  return deckState(game, odds, ctx) || shopReason(ctx) || shortReason({ price }, ctx);
}

/* ---------- The manager's words ---------- */

// "5 cards, 1 drawn, x1.5 a draw in a row": the Boxes table's rules cell.
export function deckRulesText(game, log = []) {
  const plan = deckPlan(game, {}, log);
  return [`${plan.size} card${plan.size === 1 ? "" : "s"}`, plan.drawn ? `${plan.drawn} drawn` : "", `×${+stepOf(game).toFixed(2)} a draw in a row`].filter(Boolean).join(", ");
}

/*
  The deck as the editor's form would save it (boxcard.js draftBox for the
  pools and weights, plus the price, the step and the cards: the form lists
  each card's id in `cards`, and its fields as c.<id>.label, kind, weight,
  once, gp, text), for the live preview and for Save.
*/
export function draftDeck(game, values, poolIds) {
  const ids = [].concat(values.cards ?? []).map(String).filter(Boolean);
  const cards = cardsOf({ deck: { cards: ids.map(id => ({
    id, label: values[`c.${id}.label`], kind: values[`c.${id}.kind`], weight: values[`c.${id}.weight`],
    once: values[`c.${id}.once`] === true || values[`c.${id}.once`] === "on", gp: values[`c.${id}.gp`], text: values[`c.${id}.text`],
  })) } });
  const step = Number(values.step);
  return {
    ...draftBox(game, values, poolIds),
    price: Math.max(0, Number(values.price) || 0),
    deck: { ...(game.deck ?? {}), step: step > 0 ? step : stepOf(game), cards },
  };
}

// The editor's preview: the kinds' pills and ribbon, the item cards'
// rarity pills under them, the cards left, and a line when nothing can be
// drawn or the item cards have nowhere to draw from.
export function deckPreview(game, pools, log = []) {
  const odds = deckOdds(game, pools, log);
  const items = odds.cards.some(c => c.kind === "item");
  let note = "";
  if (!odds.cards.length) note = cardsOf(game).length ? "Every card weighs 0, so nothing can be drawn." : "This deck has no cards.";
  else if (odds.left === 0) note = "Every card is drawn: reshuffle to put them back.";
  else if (items && !game.pools?.length) note = "The item cards have no pool ticked, so they can never be drawn; the other cards still can.";
  else if (items && !odds.canItem) note = "The item cards' pools have no item that can drop, so they can never be drawn; the other cards still can.";
  return { odds, note, warn: odds.empty };
}

export function deckPreviewHTML(preview, esc = s => String(s ?? "")) {
  const { odds, note, warn } = preview;
  const items = odds.canItem && odds.cards.some(c => c.kind === "item") ? `<div class="lc-form__hint">If an item: ${oddsRibbon(odds.item.rows)}<div class="lc-odds">${oddsPills(odds.item.rows)}</div></div>` : "";
  const left = odds.size ? `<p class="lc-form__hint">${esc(cardsLeftText(odds.left, odds.size))}</p>` : "";
  return `${deckOddsHTML(odds)}${items}${left}${note ? `<p class="lc-form__hint${warn ? " lc-form__hint--warn" : ""}">${esc(note)}</p>` : ""}`;
}

export function deckSummary(preview) {
  const odds = preview.odds.rows.map(r => `${r.name} ${r.label}`).join(", ");
  const items = preview.odds.canItem && preview.odds.cards.some(c => c.kind === "item") ? preview.odds.item.rows.map(r => `${RARITY_LABEL[r.rarity] ?? r.rarity} ${r.label}`).join(", ") : "";
  const left = preview.odds.size ? cardsLeftText(preview.odds.left, preview.odds.size) : "";
  return [odds, items ? `If an item: ${items}` : "", left, preview.note].filter(Boolean).join(". ");
}

export const DECK = registerKind({
  id: "deck",
  noun: "deck",
  priceOf,
  roll,
  logRow,
  // The late-cancel line (socket.js): a card is drawn, not got.
  gotText: out => `drew ${out.card?.label ?? out.result?.name ?? "a card"}`,
  reveal: {
    title: "A card from the deck",
    head,
    play,
    result,
    sting,
    notice,
    again,
    replayable: false,
  },
  // Every card posts one, so the seal shows its head with "Opening…".
  chat: { card: chatCard },
  shop: { card, reason },
});
