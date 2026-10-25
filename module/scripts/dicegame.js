/*
  Dragon's Teeth: the third kind of game (kinds.js), a tavern dice game
  against the house. One variant for now, "beat the dragon": the GM sets
  the formula (2d6 or 3d6), the dragon's number and the payout multiplier;
  the player stakes coins, the dice are rolled, and a total over the
  dragon's number wins the stake times the multiplier, paid through the
  core's one settle(). A total equal to the dragon's is a loss. A perfect
  roll (every die on its top face) can also win an item from the game's
  pools, drawn the crate's way. Push-your-luck and player-against-player
  are not in this version.

  What the skeptic insisted on:
  - The roll is Foundry's own (new Roll(formula)), made on the GM inside
    the write queue with allowInteractive: false, so a GM whose dice are
    set to manual entry is never prompted mid-purchase (the prompt would
    sit until the buyer's GM_TIMEOUT_MS fired and the sale was called
    off). The faces are decided and logged before any client shows a die,
    and they ride in the reveal as the serialised Roll, so every client
    shows the same faces: a client rebuilds them from that data
    (facesOf), never rolls its own.
  - No ChatMessage carries the Roll. A roll posted as a message renders
    its total on every client the instant it is created, which would give
    the result away while the dice are still tumbling here. The dice
    kind posts an ordinary card whose item block the core seals until this
    client's reveal lands; the card shows the faces so the roll is still
    visibly fair.
  - With Dice So Nice active the reveal waits for its 3D roll to finish
    (its promise), with a fallback timeout: its animation runs on
    requestAnimationFrame and stalls in a hidden tab. Without it, the die
    faces tumble in one frame loop and settle left to right.
  - A win's refund takes the payout back through the same settle() the
    core uses for every kind, and a refund the purse can't cover is
    refused naming the shortfall (refund.js), never minted.

  Record: { kind: "dice", price (the stake, gp), dice: { formula, target,
  multiplier }, rules: { prize }, pools, weights (the prize's rarity odds) }.

  No Foundry globals (game, Hooks, ui, foundry, fromUuid). Foundry's Roll
  is reached through globalThis the way pull.js reaches CONFIG, with a pure
  fallback for the harness and Vitest; the 3D dice bridge is injected by
  dicereveal.js (setDice3D), so this file runs anywhere.
*/
import { RARITY_LABEL } from "./config.js";
import { shopOdds, chanceLabel, wholePercents } from "./odds.js";
import { formatPrice, formatGold } from "./currency.js";
import { playTick, playReveal, playCoinBack } from "./sound.js";
import { resultHTML } from "./revealcard.js";
import { cardShell, oddsRibbon, oddsPills, shopReason, shortReason, draftBox } from "./boxcard.js";
import { drawItem, grantData } from "./crate.js";
import { PullError, registerKind } from "./kinds.js";
import { t } from "./i18n.js";

export const DICE_DEFAULTS = { price: 10, formula: "3d6", target: 12, multiplier: 3 };
export const FORMULAS = ["2d6", "3d6"];

// "3d6" as { number, sides, formula }, or null for anything else: the GM
// picks from FORMULAS, so a record holding something else is corrupt and
// the roll says so rather than guessing.
export function parseFormula(formula) {
  const m = /^\s*(\d{1,2})d(\d{1,3})\s*$/i.exec(String(formula ?? ""));
  if (!m) return null;
  const number = Number(m[1]), sides = Number(m[2]);
  if (!(number >= 1 && number <= 20 && sides >= 2 && sides <= 100)) return null;
  return { number, sides, formula: `${number}d${sides}` };
}

export const targetOf = game => Math.max(0, Math.floor(Number(game?.dice?.target) || 0));
export const multiplierOf = game => Math.max(0, Number(game?.dice?.multiplier) || 0);
export const hasPrize = game => !!game?.rules?.prize;

/*
  The chance that N dice of S sides total more than `target`, exactly, by
  convolution of the face counts: 3d6 over 12 is 56/216. The shop's pills
  and the editor's preview read this, so what the card says is the odds the
  dice have. 0 when nobody can beat the target, 1 when nobody can fail.
*/
export function winChance(number, sides, target) {
  let counts = [1];
  for (let d = 0; d < number; d++) {
    const next = new Array(counts.length + sides).fill(0);
    for (let s = 0; s < counts.length; s++) {
      if (!counts[s]) continue;
      for (let f = 1; f <= sides; f++) next[s + f] += counts[s];
    }
    counts = next;
  }
  const total = counts.reduce((n, c) => n + c, 0);
  const over = counts.reduce((n, c, sum) => (sum > target ? n + c : n), 0);
  return total ? over / total : 0;
}

/*
  The outcome of a roll, pure: `faces` are the dice as rolled, `rules` the
  game's { target, multiplier, stakeCp, sides }. A total over the target
  wins stakeCp * multiplier (whole copper, so the purse stays whole coins);
  equal to the target is a loss (the dragon keeps ties); `perfect` is every
  die on its top face, which the prize rule reads. Nothing here touches the
  purse: the core's settle() moves payoutCp - stakeCp in one write.
*/
export function resolve(faces, { target, multiplier = DICE_DEFAULTS.multiplier, stakeCp = 0, sides }) {
  const dice = (faces ?? []).map(f => Math.round(Number(f) || 0));
  const total = dice.reduce((n, f) => n + f, 0);
  const win = dice.length > 0 && total > Math.max(0, Math.floor(Number(target) || 0));
  const perfect = dice.length > 0 && Number.isFinite(sides) && dice.every(f => f === sides);
  const payoutCp = win ? Math.max(0, Math.round(Math.max(0, Math.round(Number(stakeCp) || 0)) * Math.max(0, Number(multiplier) || 0))) : 0;
  return { total, win, perfect, payoutCp };
}

// The faces a serialised Roll (roll.toJSON()) shows: every active result
// of every dice term, in order. What each client rebuilds the dice from.
export function facesOf(data) {
  return (data?.terms ?? []).flatMap(term => (Array.isArray(term?.results) ? term.results.filter(r => r?.active !== false).map(r => Number(r.result)) : []));
}

const validFaces = (faces, number, sides) => faces.length === number && faces.every(f => Number.isInteger(f) && f >= 1 && f <= sides);

// Roll data in Foundry's own shape for faces rolled without Foundry (the
// harness, a test), so the reveal and the chat card read one shape.
export function rollData(formula, { number, sides, faces }) {
  return {
    class: "Roll", formula, options: {}, dice: [], evaluated: true,
    total: faces.reduce((n, f) => n + f, 0),
    terms: [{ class: "Die", number, faces: sides, modifiers: [], options: {}, evaluated: true, results: faces.map(result => ({ result, active: true })) }],
  };
}

/*
  The dice, rolled: Foundry's Roll when there is one, evaluated with
  allowInteractive: false so no manual-entry prompt can hold the GM's write
  queue; the faces are read back from its serialised form, the same form
  every client gets. Without Foundry, the core's rng rolls them. A Roll
  that comes back with the wrong count or faces off the die is a bug, not a
  result: it throws and the buyer is told the dice jammed, nothing charged.
*/
export async function rollFaces(formula, { rng = Math.random, number, sides } = {}) {
  const parsed = parseFormula(formula);
  number ??= parsed?.number;
  sides ??= parsed?.sides;
  const R = globalThis.Roll;
  if (typeof R === "function") {
    const roll = new R(formula);
    await roll.evaluate({ allowInteractive: false });
    const data = typeof roll.toJSON === "function" ? roll.toJSON() : roll;
    const faces = facesOf(data);
    if (!validFaces(faces, number, sides)) throw new Error(`loot-crates | ${formula} came back as ${JSON.stringify(faces)}`);
    return { faces, roll: data };
  }
  const faces = Array.from({ length: number }, () => Math.min(sides, Math.floor(rng() * sides) + 1));
  return { faces, roll: rollData(formula, { number, sides, faces }) };
}

/*
  The odds one bet is made at: { rows: [{ key: "win" | "lose", name,
  chance, label }], win, beatable, max, min, number, sides, formula, target,
  multiplier, payoutCp, prize, item }. An outcome with no chance has no row
  (never a "0%" pill); `beatable` is false when the dragon's number is the
  dice's top total or more, which the shop refuses to sell. `item` is the
  prize's rarity odds (the crate's shopOdds) when the game has a prize.
*/
export function diceOdds(game, pools, state = {}) {
  const parsed = parseFormula(game?.dice?.formula) ?? { ...parseFormula(DICE_DEFAULTS.formula), bad: true };
  const { number, sides } = parsed;
  const target = targetOf(game);
  const win = parsed.bad ? 0 : winChance(number, sides, target);
  const chances = [["win", t("LOOTCRATES.Dice.Win"), win], ["lose", t("LOOTCRATES.Dice.Lose"), 1 - win]].filter(([, , c]) => c > 0);
  const pcts = wholePercents(chances.map(([, , c]) => c));
  const prize = hasPrize(game);
  return {
    rows: chances.map(([key, name, chance], i) => ({ key, name, chance, label: chanceLabel(chance, pcts[i]) })),
    win, beatable: win > 0, max: number * sides, min: number, number, sides, formula: parsed.formula, target,
    multiplier: multiplierOf(game), payoutCp: Math.round(Math.round((Number(game?.price) || 0) * 100) * multiplierOf(game)),
    prize, item: prize ? shopOdds(game, pools, state) : { rows: [], top: null },
  };
}

/*
  The roll, on the GM, before anything is charged. The formula and the
  target are checked first (a record the shop would have refused to sell
  costs nothing here either). Then Foundry's dice, the verdict, and on a
  perfect roll with the prize rule the crate's draw from the game's pools.
  The faces, the serialised Roll, the total, the target and the verdict
  ride into the reveal and the row. The dice keep no per-buyer state.
*/
async function roll(ctx) {
  const { game, rng } = ctx;
  const parsed = parseFormula(game.dice?.formula);
  if (!parsed) throw new PullError(t("LOOTCRATES.Dice.NoDice", { name: game.name }));
  const { number, sides, formula } = parsed;
  const target = targetOf(game);
  if (target >= number * sides) throw new PullError(t("LOOTCRATES.Common.Sentence", { text: t("LOOTCRATES.Dice.Unbeatable", { target, formula }) }));
  const { faces, roll: data } = await rollFaces(formula, { rng, number, sides });
  const multiplier = multiplierOf(game);
  const out = resolve(faces, { target, multiplier, stakeCp: Math.round(game.price * 100), sides });
  const common = { faces, roll: data, total: out.total, target, formula, multiplier, win: out.win, perfect: out.perfect, payoutCp: out.payoutCp, result: null, grant: null };
  if (out.perfect && hasPrize(game)) {
    const { result, source, pools } = await drawItem(ctx);
    if (result) return { ...common, ...grantData(source, result, game), prize: true, pools };
  }
  return { ...common, result: out.win ? { name: verdictText(common), outcome: "win" } : null };
}

// "15 beats the dragon's 12", "9 doesn't beat the dragon's 12", "12 ties
// the dragon's 12: the dragon wins". The verdict's own words, everywhere.
export function verdictText({ total, target, win }) {
  if (win) return t("LOOTCRATES.Dice.Beats", { total, target });
  if (total === target) return t("LOOTCRATES.Dice.Ties", { total, target });
  return t("LOOTCRATES.Dice.DoesNotBeat", { total, target });
}

export const facesText = faces => (faces ?? []).join(t("LOOTCRATES.Common.ListComma"));

// What the coins did: "Won 30 gp" or "Lost 10 gp".
export function moneyText({ win, payoutCp, price }) {
  return win ? t("LOOTCRATES.Dice.Won", { price: formatPrice((Number(payoutCp) || 0) / 100) }) : t("LOOTCRATES.Dice.Lost", { price: formatPrice(price) });
}

// The row: the faces and the verdict, so the Pull log reads the roll, and
// for a prize the item the crate's refund looks for (uuid, rarity).
function logRow({ out }) {
  const base = { faces: out.faces, total: out.total, target: out.target, formula: out.formula, win: !!out.win, name: verdictText(out) };
  if (out.prize && out.result) return { ...base, prize: true, name: out.result.name, uuid: out.result.uuid, rarity: out.result.rarity };
  return base;
}

/* ---------- The reveal ---------- */

// The timeline, in ms: the dice tumble, then settle one after another from
// the left, then the total shows. With Dice So Nice the 3D roll stands in
// for the tumble: its end (or threeTimeout) tells the total, and the stage
// lands on the next frame, or after tellFallback where frames have stopped.
export const DICE_TIMING = { tumble: 900, settleGap: 150, total: 350, flip: 90, threeTimeout: 6000, tellFallback: 500 };
export const landTime = n => DICE_TIMING.tumble + DICE_TIMING.settleGap * Math.max(0, n - 1) + DICE_TIMING.total;

// The 3D dice bridge (dicereveal.js): (rollData) -> Promise<boolean> that
// resolves when the 3D roll has finished, false when it wasn't shown, or
// null when Dice So Nice isn't there. Nothing until something sets it.
let dice3d = null;
export function setDice3D(fn) { dice3d = typeof fn === "function" ? fn : null; }

/*
  The dice in `host`: one requestAnimationFrame loop setting each die's
  face, transform and opacity from the time since the first frame. Returns
  the controller the core expects of a kind's play: play() (resolves on
  landing), skip() (lands now), skipped, reducedMotion. `duration` scales
  the whole timeline (the harness lands at 0); reduced motion or 0 lands at
  once in the final pose. `three` is the 3D bridge for this roll: when it
  gives a promise the stage waits on it (or `timeout`), and when it
  resolves tells the total, then lands on the next frame; a bridge that
  says the roll wasn't shown (false) hands over to the tumble. onSettle(i) fires as die i lands (a tick); the sting is the
  core's call once the result is shown.
*/
export function mountDice(host, { faces = [], sides = 6, target = 0, outcome = "lose", rarity = "none", duration, reducedMotion, rng = Math.random, three = null, timeout = DICE_TIMING.threeTimeout, onSettle = null, onLand = null } = {}) {
  const n = faces.length;
  const total = duration ?? landTime(n);
  const reduced = reducedMotion ?? (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const scale = total / landTime(n);
  const T = ms => ms * scale;
  host.classList.add("lc-dice", `lc-rarity-${rarity}`);
  host.classList.remove("lc-dice--landed", "lc-dice--three", "lc-dice--told");
  host.dataset.outcome = outcome;
  host.innerHTML = `<div class="lc-dice__stage" aria-hidden="true">
      <div class="lc-dice__dragon">${t("LOOTCRATES.Dice.TheDragons", { target: `<strong>${Math.floor(Number(target) || 0)}</strong>` })}</div>
      <div class="lc-dice__tray">${faces.map((_, i) => `<div class="lc-dice__die" data-die="${i}"><span class="lc-dice__face"></span></div>`).join("")}</div>
      <div class="lc-dice__total"></div>
    </div>`;
  const dice = host.querySelectorAll(".lc-dice__die");
  const totalEl = host.querySelector(".lc-dice__total");
  const sum = faces.reduce((a, f) => a + f, 0);
  // The faces each die shows while tumbling, drawn once so a replayed
  // frame shows the same thing (never the die's final face, so no frame
  // gives the result away early by chance).
  const flips = faces.map(f => Array.from({ length: 24 }, () => { const r = Math.floor(rng() * (sides - 1)) + 1; return r >= f ? r + 1 : r; }));
  const settleAt = i => DICE_TIMING.tumble + i * DICE_TIMING.settleGap;
  const set = (el, props) => { if (!el?.style) return; for (const [k, v] of Object.entries(props)) el.style[k] = v; };
  const settled = new Set();
  // Whether the stage has told the total: the feet take the outcome's
  // colour only from then (module.css lc-dice--told), so the first die to
  // settle, 440 ms before the total, says nothing about the win.
  let told = false;

  const pose = at => {
    for (let i = 0; i < n; i++) {
      const die = dice[i];
      const face = die?.querySelector?.(".lc-dice__face");
      if (at < T(settleAt(i))) {
        const k = Math.floor(at / T(DICE_TIMING.flip)) % flips[i].length;
        const p = at / T(DICE_TIMING.tumble);
        if (face) face.textContent = String(flips[i][k]);
        set(die, { transform: `translateY(${-10 - 8 * Math.abs(Math.sin(p * Math.PI * 4 + i))}px) rotate(${(k % 2 ? 1 : -1) * (9 + 6 * (1 - Math.min(1, p)))}deg)`, opacity: "0.92" });
      } else {
        if (face) face.textContent = String(faces[i]);
        set(die, { transform: "none", opacity: "1" });
        if (!settled.has(i)) {
          settled.add(i);
          die?.classList?.add("lc-dice__die--set");
          if (at !== Infinity) try { onSettle?.(i); } catch (err) { console.error("loot-crates | a die's settle cue failed", err); }
        }
      }
    }
    const shown = at >= T(settleAt(n - 1) + DICE_TIMING.total * 0.4);
    if (totalEl) { totalEl.textContent = shown ? String(sum) : ""; set(totalEl, { opacity: shown ? "1" : "0", transform: shown ? "none" : "translateY(4px)" }); }
    if (shown !== told) { told = shown; host.classList[shown ? "add" : "remove"]("lc-dice--told"); }
  };

  let landed = false, telling = false, frame = null, t0 = null, resolveDone = null, timer = null;
  const land = () => {
    if (landed) return;
    landed = true;
    if (frame != null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    if (timer != null) clearTimeout(timer);
    host.classList.remove("lc-dice--three");
    pose(Infinity);
    host.classList.add("lc-dice--landed");
    onLand?.();
    resolveDone?.();
  };
  /*
    The 3D roll is over, or never reported: the settled dice and the total,
    told (the feet in the outcome's colour) on this frame, and the landing
    (the seal lifts, onLand) on the next, so a viewer sees the total before
    the landing as the tumble shows it. A hidden tab runs no frames, so the
    timer lands it there.
  */
  const tellThenLand = () => {
    if (landed || telling) return;
    telling = true;
    if (timer != null) clearTimeout(timer);
    host.classList.remove("lc-dice--three");
    pose(Infinity);
    if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(() => land());
    timer = setTimeout(land, DICE_TIMING.tellFallback);
  };
  const tumble = () => {
    const step = now => {
      if (landed) return;
      t0 ??= now;
      const at = now - t0;
      pose(at);
      if (at >= total) land();
      else frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  };
  const ctrl = {
    skipped: false,
    reducedMotion: reduced,
    play() {
      if (landed) return Promise.resolve();
      if (reduced || total <= 0) { land(); return Promise.resolve(); }
      return new Promise(resolve => {
        resolveDone = resolve;
        // Dice So Nice: its dice are the show; this stage waits, blank,
        // and tells the total then lands with them, or after `timeout` if
        // they never report.
        let shown;
        try { shown = three?.(); } catch (err) { console.error("loot-crates | the 3D dice failed to start", err); shown = null; }
        if (shown && typeof shown.then === "function") {
          host.classList.add("lc-dice--three");
          pose(0);
          const done = ok => { if (landed || telling) return; if (ok === false) { host.classList.remove("lc-dice--three"); tumble(); } else tellThenLand(); };
          timer = setTimeout(() => done(true), timeout);
          shown.then(done, err => { console.error("loot-crates | the 3D dice failed", err); done(false); });
          return;
        }
        tumble();
      });
    },
    skip() { ctrl.skipped = true; land(); },
  };
  return ctrl;
}

const rarityOf = reveal => (reveal.prize && reveal.result?.rarity ? reveal.result.rarity : reveal.win ? "coin" : "none");
const facesIn = reveal => (Array.isArray(reveal.faces) && reveal.faces.length ? reveal.faces : facesOf(reveal.roll));

function play(host, reveal, { sound = false, pageHidden = () => false, onLand }) {
  const faces = facesIn(reveal);
  const sides = parseFormula(reveal.formula)?.sides ?? Math.max(6, ...faces);
  return mountDice(host, {
    faces, sides, target: reveal.target, outcome: reveal.win ? "win" : "lose", rarity: rarityOf(reveal),
    three: dice3d && reveal.roll ? () => dice3d(reveal.roll) : null,
    onSettle: sound ? i => { if (!pageHidden()) playTick(i / Math.max(1, faces.length - 1)); } : null,
    onLand,
  });
}

// "Tam rolls 3d6 to beat the dragon's 12 at Dragon's Teeth, 10 gp": the
// window's head line. The formula and the target are no secret; the faces are.
function head(reveal, { esc }) {
  return t("LOOTCRATES.Dice.Head", {
    who: `<span class="lc-reveal__who">${esc(reveal.actorName)}</span>`,
    formula: esc(reveal.formula ?? ""),
    target: esc(reveal.target ?? 0),
    crate: `<strong class="lc-reveal__crate">${esc(reveal.box.name)}</strong>`,
    price: `<span class="lc-reveal__price">${esc(formatPrice(reveal.box.price))}</span>`,
  });
}

/*
  What the window says once the dice are still, into its live region: the
  verdict, then one quiet line with the faces, the coins and (for the buyer
  and GMs) the purse. A prize shows the crate's item block with the roll
  under it.
*/
function result(reveal, { esc = String, canSee = false } = {}) {
  const faces = facesIn(reveal);
  const lines = [t("LOOTCRATES.Dice.RolledOn", { faces: esc(facesText(faces)), formula: esc(reveal.formula ?? "") }), esc(moneyText({ win: reveal.win, payoutCp: reveal.payoutCp, price: reveal.box.price }))];
  if (canSee && reveal.purse) lines.push(`<span class="lc-reveal__gold">${t("LOOTCRATES.Dice.InPurse", { gold: esc(formatGold(reveal.purse)) })}</span>`);
  if (reveal.prize && reveal.result?.rarity) return resultHTML(reveal, { esc, canSee: false, extra: [t("LOOTCRATES.Dice.PerfectVerdict", { total: esc(reveal.total), verdict: esc(verdictText(reveal)) }), ...lines] });
  return `<div class="lc-reveal__quiet lc-dice__verdict" data-tooltip="${esc(reveal.formula ?? "")}: ${esc(facesText(faces))}">${esc(verdictText(reveal))}</div>`
    + `<div class="lc-reveal__where">${lines.join(" · ")}</div>`;
}

function sting(reveal) {
  if (reveal.prize && reveal.result?.rarity) playReveal(reveal.result.rarity);
  else if (reveal.win) playCoinBack();
}

// A loss is quiet in the room; the buyer alone is told, in case the window
// sits behind the shop. Not an error: the dragon won.
function notice(reveal) {
  return reveal.win ? null : t("LOOTCRATES.Dice.LossNotice", { name: reveal.box.name, verdict: verdictText(reveal), money: moneyText({ win: false, price: reveal.box.price }) });
}

// Only a win posts a card: the faces (so the roll is visibly fair) and the
// verdict in the item block the core seals while this client's dice still
// tumble. The Roll itself is never put in a message.
function chatCard(reveal, { esc, itemLink }) {
  if (!reveal.win) return null;
  const faces = facesIn(reveal);
  const dice = `<span class="lc-chat__dice" aria-label="${esc(reveal.formula ?? "")}: ${esc(facesText(faces))}">${faces.map(f => `<span class="lc-dice__face lc-dice__face--small">${esc(f)}</span>`).join("")}</span>`;
  const r = reveal.result;
  const prize = reveal.prize && r?.rarity;
  const name = prize ? itemLink(reveal.itemUuid ?? r.uuid, r.name) : esc(verdictText(reveal));
  const line = prize ? `${esc(RARITY_LABEL[r.rarity] ?? r.rarity)} · ${t("LOOTCRATES.Dice.APerfect", { total: esc(reveal.total) })} · ${esc(moneyText(reveal))}` : esc(moneyText({ win: true, payoutCp: reveal.payoutCp }));
  return `
    <div class="loot-crates lc-chat lc-rarity-${esc(rarityOf(reveal))}">
      <div class="lc-chat__head">${t("LOOTCRATES.Dice.ChatHead", { actor: esc(reveal.actorName), formula: esc(reveal.formula ?? ""), target: esc(reveal.target ?? 0), box: `<strong>${esc(reveal.box.name)}</strong>`, price: `<span class="lc-chat__price">${esc(formatPrice(reveal.box.price))}</span>` })}</div>
      <div class="lc-chat__item">
        ${dice}
        <div>
          <div class="lc-chat__name">${name}</div>
          <div class="lc-chat__rarity">${line}</div>
        </div>
      </div>
    </div>`;
}

/* ---------- The shop card ---------- */

const DICE_ART = `<svg class="lc-dice__icon" viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none"/><circle cx="16" cy="8" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="8" cy="16" r="1.3" fill="currentColor" stroke="none"/><circle cx="16" cy="16" r="1.3" fill="currentColor" stroke="none"/></svg>`;

// The win in the rim's gold, the loss in mute ink (module.css swatches).
const OUTCOME_CLASS = { win: "lc-rarity-coin", lose: "lc-rarity-none" };

// Win and lose as the shop's pills and ribbon.
export function diceOddsHTML(odds) {
  if (!odds.rows.length) return "";
  const segs = odds.rows.map(row => `<span class="lc-ribbon__seg ${OUTCOME_CLASS[row.key]}" style="flex-grow:${+row.chance.toFixed(4)}" title="${row.name} ${row.label}"></span>`).join("");
  const pills = odds.rows.map(row => `<span class="lc-odd ${OUTCOME_CLASS[row.key]}">${row.name} ${row.label}</span>`).join("");
  return `<div class="lc-ribbon" aria-hidden="true">${segs}</div><div class="lc-box__odds">${pills}</div>`;
}

// "Pays 3× the stake: 30 gp".
export const paysText = odds => t("LOOTCRATES.Dice.Pays", { multiplier: +odds.multiplier.toFixed(2), price: formatPrice(odds.payoutCp / 100) });
export const prizeText = odds => t("LOOTCRATES.Dice.PrizeText", { max: odds.max });

// Why this game in particular can't be bet on now, or "": its last roll is
// still tumbling on this client (the shop holds the result; reveal.js), or
// the dragon's number is one the dice can't beat. Being short is the
// card's last word, as for every kind.
function diceState(game, odds, ctx) {
  if (ctx.held?.(game.id)) return t("LOOTCRATES.Dice.StillRolling");
  if (!odds.beatable) return t("LOOTCRATES.Dice.Unbeatable", { target: odds.target, formula: odds.formula });
  return "";
}

function card(game, pools, ctx) {
  const esc = ctx.esc ?? (s => String(s ?? ""));
  const odds = diceOdds(game, pools, ctx.stateOf?.(game.id) ?? {});
  const reason = diceState(game, odds, ctx) || shortReason(game, ctx);
  const top = odds.prize ? odds.item.top : null;
  const middle = [
    `<div class="lc-box__rule">${t("LOOTCRATES.Dice.Rule", { formula: esc(odds.formula), target: esc(odds.target) })}</div>`,
    diceOddsHTML(odds),
    `<div class="lc-box__stock">${esc(paysText(odds))}</div>`,
    odds.prize ? `<div class="lc-box__prize lc-rarity-${top ?? "none"}">${top ? esc(prizeText(odds)) : t("LOOTCRATES.Dice.PrizeEmpty", { prize: esc(prizeText(odds)) })}</div>` : "",
  ];
  return cardShell(game, ctx, { rarityClass: top ? `lc-rarity-${top}` : "lc-box--dice", art: DICE_ART, middle, reason, label: t("LOOTCRATES.Dice.Bet", { price: esc(formatPrice(game.price)) }) });
}

const reason = (game, pools, ctx) => diceState(game, diceOdds(game, pools, ctx.stateOf?.(game.id) ?? {}), ctx) || shopReason(ctx) || shortReason(game, ctx);

/* ---------- The manager's words ---------- */

// "3d6 over 12, pays 3×, item on 18": the Boxes table's rules cell.
export function diceRulesText(game) {
  const odds = diceOdds(game, {});
  return [t("LOOTCRATES.Dice.RuleOver", { formula: odds.formula, target: odds.target }), t("LOOTCRATES.Dice.RulePays", { multiplier: +odds.multiplier.toFixed(2) }), odds.prize ? t("LOOTCRATES.Dice.RuleItemOn", { max: odds.max }) : ""].filter(Boolean).join(", ");
}

// The game as the editor's form would save it (boxcard.js draftBox for the
// pools and weights, plus the dice fields), for the live preview.
export function draftDice(game, values, poolIds) {
  return {
    ...draftBox(game, values, poolIds),
    dice: {
      formula: FORMULAS.includes(values.formula) ? values.formula : game.dice?.formula ?? DICE_DEFAULTS.formula,
      target: Math.max(0, Math.floor(Number(values.target) || 0)),
      multiplier: Math.max(0, Number(values.multiplier) || 0),
    },
    rules: { ...(game.rules ?? {}), prize: values.prize === true || values.prize === "on" },
  };
}

// The editor's preview: the win and lose pills, the payout, the prize's
// rarity pills, and a warning when the dragon can't be beaten or the prize
// has no pools to draw from.
export function dicePreview(game, pools) {
  const odds = diceOdds(game, pools);
  let note = "";
  if (!odds.beatable) note = t("LOOTCRATES.Dice.PreviewUnbeatable", { target: odds.target, formula: odds.formula, max: odds.max });
  else if (odds.win >= 1) note = t("LOOTCRATES.Dice.PreviewAlwaysWins", { target: odds.target, formula: odds.formula });
  else if (odds.prize && !game.pools?.length) note = t("LOOTCRATES.Dice.PreviewNoPool");
  else if (odds.prize && !odds.item.rows.length) note = t("LOOTCRATES.Dice.PreviewNoItem");
  return { odds, note, warn: !odds.beatable };
}

export function dicePreviewHTML(preview, esc = s => String(s ?? "")) {
  const { odds, note, warn } = preview;
  const prize = odds.prize && odds.item.rows.length ? `<div class="lc-form__hint">${esc(prizeText(odds))}: ${oddsRibbon(odds.item.rows)}<div class="lc-odds">${oddsPills(odds.item.rows)}</div></div>` : "";
  return `${diceOddsHTML(odds)}<p class="lc-form__hint">${esc(paysText(odds))}</p>${prize}${note ? `<p class="lc-form__hint${warn ? " lc-form__hint--warn" : ""}">${esc(note)}</p>` : ""}`;
}

export function diceSummary(preview) {
  const odds = preview.odds.rows.map(r => `${r.name} ${r.label}`).join(", ");
  const items = preview.odds.prize ? preview.odds.item.rows.map(r => `${RARITY_LABEL[r.rarity] ?? r.rarity} ${r.label}`).join(", ") : "";
  return [odds, paysText(preview.odds), items ? `${prizeText(preview.odds)}: ${items}` : "", preview.note].filter(Boolean).join(". ");
}

export const DICE = registerKind({
  id: "dice",
  noun: "dice",
  roll,
  logRow,
  // "rolled 4, 6, 5: 15 beats the dragon's 12", for the late-cancel line
  // (socket.js), where "got <verdict>" read as if the verdict were an item.
  gotText: out => t("LOOTCRATES.Dice.GotText", { faces: facesText(out.faces), verdict: verdictText(out) }),
  reveal: {
    get title() { return t("LOOTCRATES.Dice.Title"); },
    head,
    play,
    result,
    sting,
    notice,
    replayable: false,
  },
  // Only a win posts a card: hidden whole while sealed, or its arrival would tell.
  chat: { card: chatCard, conditional: true },
  shop: { card, reason },
});
