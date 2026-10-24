/*
  The shared table window's words and markup, with no Foundry in them, so
  the window (tablewindow.js), the harness and Vitest draw one thing. Any
  table kind (kinds.js `table: true`) plugs its pieces in through
  kind.tableView: the title, the bet fields and how to read them, the stage
  (the wheel) and the rail (the chips), the result and the sting.

  The window is one room for the whole table: the head names the game, how
  many bets are down and what the round is doing (a clock, "Bets are open
  until the GM spins", "Bets are closed", "The wheel is turning"); the vault
  holds the kind's stage with every character's chips placed as bets
  arrive; the result lands in the vault's live region. Under the vault a
  player's bet form (the character, the kind's fields, one button that says
  what it does) and, for the GM, Spin. The one close button reads Skip
  while the stage plays, as the reveal's does.

  Screen readers hear the table in words: the chips are decorative, so a
  visually hidden list names every bet, and a status line says each new one
  as it lands and the round's state as it changes (tablewindow.js says it
  there after each change of phase). The head's state line is a status
  region too, except while it is the clock: that ticks once a second, and
  a live region read every second would drown the table, so the clock is
  a timer (role="timer": live, but silent until the user reads it).
*/
import { formatPrice } from "./currency.js";
import { isOpenStake, stakeReason, roundState, ROUND_WORDS } from "./round.js";
import { onShelf, shelfBetsClosed } from "./shelf.js";

// "Orla Vane bets 5 gp on Red", for the status line and the list; a kind
// with its own sentence (the Auction's "Orla Vane bids 55 gp") says it.
export function stakeSentence(row, verb = "bets", view = null) {
  if (typeof view?.sentence === "function") return view.sentence(row);
  return `${row.actorName} ${verb} ${formatPrice(row.price)} on ${row.name ?? row.stake?.label ?? "the table"}`;
}

// The head's count: the kind's own from every stake of the round, the
// beaten ones included (the Auction's "5 bids from 3 bidders"), else the
// live stakes counted below.
export function countFor(view, stakes = [], history = null) {
  return typeof view?.count === "function" ? view.count(history ?? stakes) : countText(stakes);
}

// The bet button's words: the kind's (the Auction's "Bid 55 gp", the next
// legal bid), else "Place a bet".
export function betLabelFor(view, game, { stakes = [], values = {} } = {}) {
  return typeof view?.betLabel === "function" ? view.betLabel(game, { stakes, values }) : "Place a bet";
}

/*
  Why the bet button is off, or "": the game was taken off the shelf while
  its round is open. The GM refuses any stake on it then (pull.js
  guardPlay), so the window never offers one; the round itself still runs
  to its resolve. gateBet keeps an open form in step as the shelf changes
  (tablewindow.js, on every redraw): the button aria-disabled (it keeps
  focus) with the sentence in the form's status line, and both back once
  the game is on the shelf again.
*/
export const betClosedText = (game, view = null) => (game && !onShelf(game) ? shelfBetsClosed(game, view?.verb ?? "bets") : "");

export function gateBet(form, game, view = null) {
  const btn = form?.querySelector?.(".lc-table__bet");
  const why = form?.querySelector?.(".lc-table__why");
  if (!btn) return "";
  const text = betClosedText(game, view);
  const was = btn.dataset.closed ?? "";
  if (text) {
    btn.setAttribute("aria-disabled", "true");
    btn.dataset.closed = text;
    if (why && why.textContent !== text) why.textContent = text;
  } else if (was) {
    btn.removeAttribute("aria-disabled");
    delete btn.dataset.closed;
    if (why && why.textContent === was) why.textContent = "";
  }
  return text;
}

// "3 bets from 2 characters", "1 bet", "No bets yet".
export function countText(stakes = []) {
  const live = stakes.filter(r => isOpenStake(r) || r.status === "settled");
  if (!live.length) return "No bets yet";
  const who = new Set(live.map(r => r.actorId)).size;
  const bets = `${live.length} bet${live.length === 1 ? "" : "s"}`;
  return who > 1 ? `${bets} from ${who} characters` : bets;
}

/*
  The shop card's ticking line (data-lc-countdown, tablewindow.js tick) in
  the kind's own words (tableView.words, else round.js ROUND_WORDS): the
  clock while time is left, then the closed words. { text, done }.
*/
export function countdownText(kind, closesAt, now = Date.now()) {
  const w = { ...ROUND_WORDS, ...(kind?.tableView?.words ?? {}) };
  const left = Number(closesAt) - now;
  return left > 0 ? { text: w.clock(left), done: false } : { text: w.closed, done: true };
}

/*
  Which controls the viewer gets: the bet form while the round takes bets
  and they have a character to bet with; Spin for the GM until the round
  resolves. `phase` is "betting" | "waiting" (closed, not spun) | "spinning"
  | "landed" | "void".
*/
export function phaseOf(round, { reveal = null, landed = false, now = Date.now(), voided = false } = {}) {
  if (landed) return "landed";
  if (reveal) return "spinning";
  if (!round || round.voided || voided) return "void";
  if (round.status === "resolved") return "spinning";
  return stakeReason(round, now) ? "waiting" : "betting";
}

// The head's state words: the round's (round.js roundState, in the kind's
// own words, tableView.words), or while the stage plays, that. `onReload`:
// the spin failed and couldn't be undone (table.js undoResolve), so the
// stakes come back on the GM's next load, not now.
export const VOID_WORDS = {
  now: "The round was called off; every stake came back",
  onReload: "The spin failed and the round was called off; every stake comes back when the GM reloads",
};
export function stateText(round, phase, { now = Date.now(), kind = null, onReload = false } = {}) {
  const words = kind?.tableView?.words ?? {};
  if (phase === "spinning") return roundState(round, { held: true, words });
  if (phase === "landed") return { key: "landed", text: "Settled" };
  if (phase === "void") return { key: "void", text: onReload ? VOID_WORDS.onReload : words.void ?? VOID_WORDS.now };
  if (phase === "waiting") return { key: "closed", text: words.waiting ?? ROUND_WORDS.waiting };
  return roundState(round, { now, words });
}

/*
  The window's body. `viewer`: { isGM, actors: [{ id, name }] (the
  characters this user may bet with), actorIds }. `values` are the form's
  last values, kept across a redraw. `history` is every stake of the
  round, the ones refunded since included (the Auction's beaten bids), for
  a kind that counts them. `esc` escapes for the page. The GM's buttons
  are the kind's words (the Auction's "Bring the gavel down" for Spin),
  and a kind with a cancelLabel gives the GM a way to call the round off.
*/
export function tableBodyHTML({ kind, game, round, stakes = [], history = null, viewer = {}, phase = "betting", now = Date.now(), esc = s => String(s ?? ""), values = {}, onReload = false }) {
  const view = kind.tableView;
  const state = stateText(round, phase, { now, kind, onReload });
  const actors = viewer.actors ?? [];
  const canBet = phase === "betting" && actors.length > 0;
  const who = actors.length > 1
    ? `<label class="lc-table__field"><span class="lc-label">Character</span><select name="actorId" class="lc-table__actor">${actors.map(a => `<option value="${esc(a.id)}"${a.id === (values.actorId ?? actors[0].id) ? " selected" : ""}>${esc(a.name)}</option>`).join("")}</select></label>`
    : actors.length ? `<input type="hidden" name="actorId" value="${esc(actors[0].id)}">` : "";
  const closed = betClosedText(game, view);
  const form = canBet ? `
      <form class="lc-table__form" autocomplete="off" novalidate>
        ${who}
        ${view.fields(game, { esc, values, stakes })}
        <button type="submit" class="lc-table__bet" data-action="placeBet"${closed ? ` aria-disabled="true" data-closed="${esc(closed)}"` : ""}>${esc(betLabelFor(view, game, { stakes, values }))}</button>
        <span class="lc-table__why" role="status">${esc(closed)}</span>
      </form>` : "";
  const gmLive = viewer.isGM && (phase === "betting" || phase === "waiting");
  const spin = gmLive ? `<button type="button" class="lc-table__spin" data-action="spin">${esc(view.spinLabel ?? "Spin")}</button>` : "";
  const cancel = gmLive && view.cancelLabel ? `<button type="button" class="lc-table__cancel" data-action="cancelRound">${esc(view.cancelLabel)}</button>` : "";
  const closeLabel = phase === "spinning" ? "Skip" : "Close";
  return `
      <div class="lc-table__head lc-reveal__head">
        <strong class="lc-reveal__crate">${esc(game?.name ?? "")}</strong>
        <span class="lc-table__count">${esc(countFor(view, stakes, history))}</span>
        <span class="lc-table__state" role="${state.key === "clock" ? "timer" : "status"}" data-state="${esc(state.key)}"${state.closesAt ? ` data-lc-countdown="${esc(state.closesAt)}"` : ""}>${esc(state.text)}</span>
      </div>
      <div class="lc-vault lc-rarity-none">
        <div class="lc-table__host"></div>
        <div class="lc-reveal__result lc-table__result" aria-live="polite"></div>
      </div>
      <p class="lc-table__live lc-sr-only" role="status"></p>
      <ul class="lc-table__list lc-sr-only" aria-label="${esc(view.words?.list ?? "Bets on the table")}">${stakes.filter(r => isOpenStake(r) || r.status === "settled").map(r => `<li>${esc(stakeSentence(r, view.verb, view))}</li>`).join("")}</ul>
      ${form}
      <div class="lc-reveal__actions">
        ${spin}${cancel}
        <button type="button" class="lc-reveal__close" data-action="${phase === "spinning" ? "skip" : "dismiss"}">${closeLabel}</button>
      </div>`;
}
