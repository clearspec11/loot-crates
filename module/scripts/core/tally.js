/*
  The tallies: every count a rule reads, kept on its own and written in the
  same write as the Pull log row it comes from (store.js), so the log is
  for reading and nothing a player relies on changes when old rows fall off
  it (VIB-213). The log keeps its newest LOG_CAP rows (trimLog); a count
  lives here, not in the rows.

  What is counted, and for what (each the rule's unrefunded rows, as the
  rule used to count them from the log):
  - buyers["actorId.boxId"]: one character at one game.
    - bought: their purchases there (no table stake, no ticket's play: a
      Buy to keep counts on the day it was bought), the limit per
      character "N in all" (limits.js).
    - days[day]: per in-game day (clock.js key), `bought` for the limit
      "N a day" and `played` (every play but a Buy to keep) for the
      well's daily cap (well.js). The newest DAYS_KEPT days are kept.
    - priced: { rowId: at } of their draws at a deck that set the next
      price (deck.js streakOf: not the later use of a kept ticket), the
      newest TIMES_KEPT.
  - rolls["boxId.rollId"]: a scratch roll, { sold, tiers: { tier: n } },
    the tickets sold and the prize lines paid (scratch.js rollState). A
    Buy to keep draws nothing until it is used.
  - decks[boxId]: { cardId: { rowId: at } }, the draws naming each card
    (deck.js drawnIds reads the once cards since the last reshuffle), the
    newest TIMES_KEPT per card.
  - hidden: { rowId: columns } a row's GM-only columns (a scratch ticket's
    tier, number and winning panels), off the row; foundry/hidden.js is
    the one accessor, so where they are kept is one decision. Kept while
    the row is in the log (a refund needs the tier back).
  A table round's open stakes are not counted here: they are their rows,
  and the trim never drops a row of a round that hasn't resolved or a
  stake still open (trimLog), so the round's resolve, its refunds and the
  GM's stale refund always find them.

  A refund (or any patch to a row) moves the tallies by the difference
  between the row before and after (applyRow -1 then +1), in the same
  write. migrateLog builds the tallies once from whatever rows a world
  has, with the same filters as the old log-based counts, and moves the
  hidden columns off them; a world whose tallies carry TALLY_VERSION is
  never rebuilt.

  Pure: no Foundry globals.
*/

export const TALLY_VERSION = 1;
// How many rows the Pull log keeps (newest first), past the pinned ones.
export const LOG_CAP = 500;
export const DAYS_KEPT = 30;
export const TIMES_KEPT = 50;
// The columns a kind keeps off its row because a player's client must not
// read them (scratch.js hiddenRow).
export const HIDDEN_COLUMNS = ["tier", "ticketNo", "winners"];

export const emptyTally = () => ({ v: TALLY_VERSION, buyers: {}, rolls: {}, decks: {}, hidden: {} });

const buyerKey = (actorId, boxId) => `${actorId}.${boxId}`;
const rollKey = (boxId, rollId) => `${boxId}.${Number(rollId)}`;
const at = r => Number(r?.at) || 0;
const bump = (obj, key, by) => {
  const n = Math.max(0, (Number(obj[key]) || 0) + by);
  if (n) obj[key] = n;
  else delete obj[key];
};

// The newest `keep` entries of a { rowId: at } map.
function newest(map, keep) {
  const ids = Object.keys(map);
  if (ids.length <= keep) return map;
  return Object.fromEntries(Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, keep));
}

const shape = tally => {
  const t = tally ?? emptyTally();
  t.buyers ??= {};
  t.rolls ??= {};
  t.decks ??= {};
  t.hidden ??= {};
  return t;
};

/*
  Adds one row to the tallies (`sign` 1), or takes it out (-1). A refunded
  row counts for nothing either way. `hidden` is the row's GM-only columns
  (the scratch tier); a row from before they left the log carries them.
  Changes `tally` and returns it.
*/
export function applyRow(tally, row, sign = 1, hidden = null) {
  const t = shape(tally);
  if (!row || row.refunded || !row.boxId) return t;
  const cols = hidden ?? row;
  if (row.actorId) {
    const key = buyerKey(row.actorId, row.boxId);
    const b = (t.buyers[key] ??= {});
    const bought = !row.roundId && !row.redeem;
    if (bought) bump(b, "bought", sign);
    if (row.day) {
      b.days ??= {};
      const d = (b.days[row.day] ??= {});
      if (bought) bump(d, "bought", sign);
      if (!row.keep) bump(d, "played", sign);
      if (!Object.keys(d).length) delete b.days[row.day];
      const days = Object.keys(b.days);
      for (const old of days.slice(0, Math.max(0, days.length - DAYS_KEPT))) delete b.days[old];
      if (!Object.keys(b.days).length) delete b.days;
    }
    if (row.kind === "deck" && !row.redeem?.kept) {
      b.priced ??= {};
      if (sign > 0) b.priced = newest({ ...b.priced, [row.id]: at(row) }, TIMES_KEPT);
      else delete b.priced[row.id];
      if (!Object.keys(b.priced).length) delete b.priced;
    }
    if (!Object.keys(b).length) delete t.buyers[key];
  }
  if (row.kind === "scratch" && !row.keep && row.rollId != null) {
    const key = rollKey(row.boxId, row.rollId);
    const r = (t.rolls[key] ??= { sold: 0, tiers: {} });
    r.tiers ??= {};
    r.sold = Math.max(0, (Number(r.sold) || 0) + sign);
    if (cols?.tier != null) bump(r.tiers, cols.tier, sign);
    if (!r.sold && !Object.keys(r.tiers).length) delete t.rolls[key];
  }
  if (row.kind === "deck" && !row.keep && row.cardId != null) {
    const deck = (t.decks[row.boxId] ??= {});
    const card = String(row.cardId);
    const times = { ...(deck[card] ?? {}) };
    if (sign > 0) times[row.id] = at(row);
    else delete times[row.id];
    if (Object.keys(times).length) deck[card] = newest(times, TIMES_KEPT);
    else delete deck[card];
    if (!Object.keys(deck).length) delete t.decks[row.boxId];
  }
  return t;
}

// A row with its GM-only columns taken off, and those columns (null when it had none).
export function splitHidden(row) {
  if (!row || !HIDDEN_COLUMNS.some(c => c in row)) return { row, hidden: null };
  const out = { ...row };
  const hidden = {};
  for (const c of HIDDEN_COLUMNS) {
    if (c in out) {
      hidden[c] = out[c];
      delete out[c];
    }
  }
  return { row: out, hidden };
}

/*
  The tallies counted from these rows (any order), with each row's hidden
  columns from `hidden` (by row id) or the row itself. This is the count
  the rules made from the log before the tallies, row for row.
*/
export function tallyOf(log, hidden = {}) {
  const t = emptyTally();
  const rows = (Array.isArray(log) ? log : []).filter(Boolean).slice().sort((a, b) => at(a) - at(b));
  for (const row of rows) applyRow(t, row, 1, hidden?.[row.id] ?? null);
  return t;
}

/*
  The one-time move to the tallies: { log, tally } with the hidden columns
  off every row (kept in tally.hidden by row id) and the tallies built
  from the rows as they stand, or null when `tally` is already at
  TALLY_VERSION (so a second run, or a second GM's, changes nothing). An
  empty or missing log gives empty tallies.
*/
export function migrateLog({ log, tally } = {}) {
  if (Number(tally?.v) >= TALLY_VERSION) return null;
  const hidden = { ...(tally?.hidden ?? {}) };
  const rows = (Array.isArray(log) ? log : []).filter(Boolean).map(r => {
    const split = splitHidden(r);
    if (split.hidden) hidden[r.id] = { ...split.hidden, ...(hidden[r.id] ?? {}) };
    return split.row;
  });
  const next = tallyOf(rows, hidden);
  const ids = new Set(rows.map(r => r.id));
  next.hidden = Object.fromEntries(Object.entries(hidden).filter(([id]) => ids.has(id)));
  return { log: rows, tally: next };
}

/*
  The log after a write: its newest `cap` rows, and past them every row a
  table round still needs (a stake still open, or any stake of a round
  that hasn't resolved: its resolve, the GM's refunds and the stale
  recovery read them). { log, dropped: the ids that left }.
*/
export function trimLog(log, { cap = LOG_CAP, rounds = {} } = {}) {
  const rows = Array.isArray(log) ? log : [];
  if (rows.length <= cap) return { log: rows, dropped: [] };
  const pinned = r => (r?.status === "open" && !r.refunded) || (r?.roundId && rounds?.[r.roundId] && rounds[r.roundId].status !== "resolved");
  const kept = rows.slice(0, cap);
  const dropped = [];
  for (const r of rows.slice(cap)) {
    if (pinned(r)) kept.push(r);
    else dropped.push(r?.id);
  }
  return { log: kept, dropped };
}

/* ---------- Reading them ---------- */

export const buyerTally = (tally, { boxId, actorId }) => tally?.buyers?.[buyerKey(actorId, boxId)] ?? null;

// This character's purchases at this game: in all, or on `today` (none
// in a world with no day).
export function boughtCount(tally, { boxId, actorId, per = "ever", today = null }) {
  const b = buyerTally(tally, { boxId, actorId });
  if (per === "day") return today ? Number(b?.days?.[today]?.bought) || 0 : 0;
  return Number(b?.bought) || 0;
}

// This character's plays at this game on `day` (a Buy to keep isn't one).
export function playedOn(tally, { boxId, actorId, day }) {
  if (!day) return 0;
  return Number(buyerTally(tally, { boxId, actorId })?.days?.[day]?.played) || 0;
}

// The draw times that set this character's next price at this deck, newest first.
export function pricedTimes(tally, { boxId, actorId }) {
  return Object.values(buyerTally(tally, { boxId, actorId })?.priced ?? {}).map(Number).sort((a, b) => b - a);
}

// A scratch roll's tickets sold and prize lines paid, { sold, tiers }.
export function rollTally(tally, { boxId, rollId }) {
  const r = tally?.rolls?.[rollKey(boxId, rollId)];
  return { sold: Number(r?.sold) || 0, tiers: { ...(r?.tiers ?? {}) } };
}

// A deck's draws by card id: { cardId: [at, ...] }.
export function deckDraws(tally, boxId) {
  return Object.fromEntries(Object.entries(tally?.decks?.[boxId] ?? {}).map(([card, times]) => [card, Object.values(times).map(Number)]));
}
