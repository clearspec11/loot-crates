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
    - won: { sourceUuid: n } the unrefunded plays there that drew that
      item, which a refund's no-duplicates undo reads (odds.js undoPull):
      the item stays owned while another play still holds it, whether or
      not that play's row is still in the log. A play whose item was given
      away or sold back after the reveal (`parted`, core/afterplay.js)
      holds it no longer.
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
  - chars[actorId] and games[boxId]: the economy (VIB-218), what the
    manager's Pull log tab reads out to the GM (views/economy.js), in
    copper, every unrefunded row but an auction's house bid (applyEcon):
    - chars: { name, spent (the price paid, a stake as it is placed, and
      what a game took beyond it: the deck's bane), paid (coins a game
      paid out), items (what the items won were worth as granted:
      core/afterplay.js worthCp), sold (coins from selling one back),
      soldWorth (what those were worth), gave (what the items given away
      were worth), got (what the items given to them were worth: counted
      on the receiver, from the giver's row) }.
    - games: { name, plays (every row but a Buy to keep; a ticket's use
      is the play), taken (as `spent`), paid, items }. A table stake is
      taken when placed and its settle adds what it paid; a stake turned
      back is refunded and counts for nothing. A sell back is the
      character's, not the game's: the game paid out the item.
  A table round's open stakes are not counted here: they are their rows,
  and the trim never drops a row of a round that hasn't resolved or a
  stake still open (trimLog), so the round's resolve, its refunds and the
  GM's stale refund always find them.

  A refund (or any patch to a row) moves the tallies by the difference
  between the row before and after (applyRow -1 then +1), in the same
  write, and not at all when the patch changes nothing a tally reads (a
  late cancel's mark, a round's settle: countsChange).

  Every row says whether it is counted (`t`: 1 counted, 0 refunded and
  taken back), stamped in the write that counts it. A row with no stamp
  was written by a build that doesn't keep these tallies (a GM client not
  reloaded since an update), so catchUp counts it the first time it is
  read, and a stamped row an older build refunded is taken back the same
  way; the result is the same as if this build had written it. The
  tallies live under TALLY_KEY in the STATE setting, not the `tally` 1.7.0
  kept: a 1.7.0 client still counts into that one, so nothing it writes is
  counted twice here.

  migrateLog builds the tallies once: from version 2 (this round's first
  build, before the economy), its counts kept as they are (with any row an
  older build wrote caught up) and the economy counted from the rows; from
  1.7.0's (`legacy`), each count
  raised to what the log's rows show where the log shows more (rows an
  older GM wrote after 1.7.0 moved over, which it never counted), or from
  the rows alone in a world from before; the no-duplicates record seeds
  `won` for an item it still holds whose rows are gone. It moves the
  hidden columns off the rows and stamps every row. Either way the economy
  can only be counted from the rows the log still has (no build before
  kept it), and an item granted before 1.8.0 has no price on its row
  (`worth`), so it counts as nothing in what was won. A world whose
  tallies carry TALLY_VERSION is never rebuilt.

  Pure: no Foundry globals.
*/
import { firstParted, rowItems, partOf, worthCp } from "./afterplay.js";

export const TALLY_VERSION = 3;
// Where the tallies are kept in the STATE setting (1.7.0 kept version 1
// under "tally", which a 1.7.0 client may still write).
export const TALLY_KEY = "tallies";
export const LEGACY_KEY = "tally";
// How many rows the Pull log keeps (newest first), past the pinned ones.
export const LOG_CAP = 500;
export const DAYS_KEPT = 30;
export const TIMES_KEPT = 50;
// The columns a kind keeps off its row because a player's client must not
// read them (scratch.js hiddenRow).
export const HIDDEN_COLUMNS = ["tier", "ticketNo", "winners"];

export const emptyTally = () => ({ v: TALLY_VERSION, buyers: {}, rolls: {}, decks: {}, hidden: {}, chars: {}, games: {} });

const buyerKey = (actorId, boxId) => `${actorId}.${boxId}`;
const rollKey = (boxId, rollId) => `${boxId}.${Number(rollId)}`;
const at = r => Number(r?.at) || 0;
const bump = (obj, key, by) => {
  const n = Math.max(0, (Number(obj[key]) || 0) + by);
  if (n) obj[key] = n;
  else delete obj[key];
};

/*
  A day key's place in time (clock.js keyOfDay: y<year>d<day>, t<days>,
  or r<rests>), so the newest days are kept by date, not by when a key was
  last written (a refund lifted on an old row writes its day again). A
  world that changed how it tells a day has keys of two shapes: ordered
  r, then t, then y, then by number.
*/
const SHAPES = { r: 1, t: 2, y: 3 };
export function dayOrder(key) {
  const s = String(key ?? "");
  let m = /^y(-?\d+)d(-?\d+)$/.exec(s);
  if (m) return [SHAPES.y, Number(m[1]), Number(m[2])];
  m = /^([rt])(-?\d+)$/.exec(s);
  if (m) return [SHAPES[m[1]], Number(m[2]), 0];
  return [0, 0, 0];
}
const byDay = (a, b) => {
  const x = dayOrder(a);
  const y = dayOrder(b);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || (a < b ? -1 : a > b ? 1 : 0);
};

// The newest DAYS_KEPT days of a { day: counts } map, by date.
function newestDays(days) {
  const keys = Object.keys(days);
  if (keys.length <= DAYS_KEPT) return days;
  const keep = new Set(keys.sort(byDay).slice(-DAYS_KEPT));
  return Object.fromEntries(Object.entries(days).filter(([k]) => keep.has(k)));
}

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
  t.chars ??= {};
  t.games ??= {};
  return t;
};

/*
  The economy's part of a row (see the header), added (`sign` 1) or taken
  out (-1). A row the caller has already found counted (not refunded, with
  a game). `name` is kept as the newest row wrote it, for the readout.
*/
const cpOf = gp => Math.round((Number(gp) || 0) * 100);
function entry(map, key, name) {
  const e = (map[key] ??= {});
  if (name) e.name = String(name);
  return e;
}
function tidy(map, key) {
  if (map[key] && !Object.keys(map[key]).some(k => k !== "name")) delete map[key];
}
export function applyEcon(tally, row, sign = 1) {
  const t = shape(tally);
  if (!row || row.refunded || !row.boxId || row.house) return t;
  const payout = Math.round(Number(row.payoutCp) || 0);
  const taken = Math.max(0, cpOf(row.price)) + Math.max(0, -payout);
  const paid = Math.max(0, payout);
  const items = rowItems(row);
  const worth = id => worthCp(row.worth?.[id]);
  const value = items.reduce((n, i) => n + worth(i.id), 0);
  const g = entry(t.games, row.boxId, row.boxName);
  if (!row.keep) bump(g, "plays", sign);
  bump(g, "taken", sign * taken);
  bump(g, "paid", sign * paid);
  bump(g, "items", sign * value);
  tidy(t.games, row.boxId);
  if (!row.actorId) return t;
  const c = entry(t.chars, row.actorId, row.actorName);
  bump(c, "spent", sign * taken);
  bump(c, "paid", sign * paid);
  bump(c, "items", sign * value);
  for (const i of items) {
    const part = partOf(row, i.id);
    if (!part) continue;
    if (part.given?.actorId) {
      bump(c, "gave", sign * worth(i.id));
      const to = entry(t.chars, part.given.actorId, part.given.actorName);
      bump(to, "got", sign * worth(i.id));
      tidy(t.chars, part.given.actorId);
    } else {
      bump(c, "sold", sign * Math.max(0, Math.round(Number(part.soldCp) || 0)));
      bump(c, "soldWorth", sign * worth(i.id));
    }
  }
  tidy(t.chars, row.actorId);
  return t;
}

// The economy counted from these rows alone: { chars, games }. The
// readout's This session (rows since the GM's load) and the migration's.
export function econOf(rows = []) {
  const t = { chars: {}, games: {} };
  for (const row of Array.isArray(rows) ? rows : []) applyEcon(t, row, 1);
  return { chars: t.chars, games: t.games };
}

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
      b.days = newestDays(b.days);
      if (!Object.keys(b.days).length) delete b.days;
    }
    if (row.uuid && !row.keep && !firstParted(row)) {
      b.won ??= {};
      bump(b.won, row.uuid, sign);
      if (!Object.keys(b.won).length) delete b.won;
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
  applyEcon(t, row, sign);
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
  What a row counts for, as one string: the columns applyRow reads (and
  its hidden tier). A patch that leaves it the same moves no tally.
*/
const COUNTED_COLUMNS = ["boxId", "actorId", "roundId", "day", "kind", "cardId", "rollId", "uuid", "at", "price", "payoutCp", "house", "itemId", "itemIds", "worth", "parted"];
export function countsOf(row, hidden = null) {
  if (!row) return "";
  return JSON.stringify([!!row.refunded, !!row.redeem, !!row.redeem?.kept, !!row.keep, firstParted(row), (hidden ?? row)?.tier ?? null, ...COUNTED_COLUMNS.map(c => row[c] ?? null)]);
}
export const countsChange = (before, after, hidden = null) => countsOf(before, hidden) !== countsOf(after, hidden);

// The stamp a counted row carries: 1 counted, 0 refunded (nothing counted).
export const stampOf = row => (row?.refunded ? 0 : 1);
export function stamp(row) {
  if (row) row.t = stampOf(row);
  return row;
}

/*
  Counts the rows another build wrote or refunded since this one last
  wrote (see the header), and stamps them: a row with no stamp is counted
  as it stands (its hidden columns, still on a 1.6 row or in 1.7.0's
  `legacy` tally, moved to `tally.hidden`); a row stamped counted that is
  now refunded is taken back, and one stamped refunded that is live again
  put back. Changes `tally` and the rows; returns how many it changed.
*/
export function catchUp(tally, log, legacy = null) {
  if (!Array.isArray(log)) return 0;
  let changed = 0;
  for (const row of log) {
    if (!row?.id) continue;
    const want = stampOf(row);
    if (row.t === want) continue;
    if (row.t == null) {
      const split = splitHidden(row);
      if (split.hidden) for (const c of HIDDEN_COLUMNS) delete row[c];
      const hidden = tally.hidden?.[row.id] ?? legacy?.hidden?.[row.id] ?? split.hidden;
      if (hidden) tally.hidden = { ...(tally.hidden ?? {}), [row.id]: { ...hidden } };
      applyRow(tally, row, 1, hidden);
    } else {
      const hidden = tally.hidden?.[row.id] ?? null;
      const live = { ...row, refunded: null };
      applyRow(tally, live, want ? 1 : -1, hidden);
    }
    row.t = want;
    changed++;
  }
  return changed;
}

// Whether any row needs catchUp (a cheap look before copying anything).
export const needsCatchUp = log => Array.isArray(log) && log.some(r => r?.id && r.t !== stampOf(r));

/*
  The larger of two tallies, count by count (a { rowId: at } map is the
  union of both), then each trimmed as applyRow trims it. Hidden columns
  are not counts and are left to the caller.
*/
function deepMax(a, b) {
  if (typeof a === "number" || typeof b === "number") return Math.max(Number(a) || 0, Number(b) || 0);
  const out = {};
  for (const k of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
    const x = a?.[k];
    const y = b?.[k];
    out[k] = x === undefined ? structuredCopy(y) : y === undefined ? structuredCopy(x) : deepMax(x, y);
  }
  return out;
}
const structuredCopy = v => (v && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v);

function trimAll(t) {
  for (const b of Object.values(t.buyers)) {
    if (b.days) b.days = newestDays(b.days);
    if (b.priced) b.priced = newest(b.priced, TIMES_KEPT);
  }
  for (const deck of Object.values(t.decks)) for (const card of Object.keys(deck)) deck[card] = newest(deck[card], TIMES_KEPT);
  return t;
}

/*
  The one-time move to these tallies: { log, tally } with the hidden
  columns off every row (kept in tally.hidden by row id), every row
  stamped, and the counts built as the header says: 1.7.0's tallies
  (`legacy`, version 1) raised to the log's own count where that is more,
  or the log's alone. `states` is the STATE setting, whose no-duplicates
  records ({ owned }) seed `won` for an item still held whose rows the
  log no longer has. Null when `tally` is already at TALLY_VERSION (so a
  second run, or a second GM's, changes nothing). An empty or missing log
  gives empty tallies.
*/
export function migrateLog({ log, tally, legacy = null, states = null } = {}) {
  if (Number(tally?.v) >= TALLY_VERSION) return null;
  if (Number(tally?.v) === 2) return fromVersion2({ log, tally, legacy });
  const hidden = { ...(legacy?.hidden ?? {}), ...(tally?.hidden ?? {}) };
  const rows = (Array.isArray(log) ? log : []).filter(Boolean).map(r => {
    const split = splitHidden(r);
    if (split.hidden) hidden[r.id] = { ...split.hidden, ...(hidden[r.id] ?? {}) };
    return stamp({ ...split.row });
  });
  const recount = tallyOf(rows, hidden);
  const base = Number(legacy?.v) >= 1 ? legacy : null;
  const next = base ? trimAll({ ...emptyTally(), ...deepMax({ buyers: base.buyers, rolls: base.rolls, decks: base.decks }, { buyers: recount.buyers, rolls: recount.rolls, decks: recount.decks }), chars: recount.chars, games: recount.games }) : recount;
  for (const [key, st] of Object.entries(states ?? {})) {
    if (!key.includes(".") || !Array.isArray(st?.owned) || !st.owned.length) continue;
    const b = (next.buyers[key] ??= {});
    b.won ??= {};
    for (const uuid of st.owned) if (uuid && !b.won[uuid]) b.won[uuid] = 1;
  }
  const ids = new Set(rows.map(r => r.id));
  next.v = TALLY_VERSION;
  next.hidden = Object.fromEntries(Object.entries(hidden).filter(([id]) => ids.has(id)));
  return { log: rows, tally: next };
}

/*
  From version 2 to this one: the economy is new, so it is counted from
  the rows (econOf); every other count is version 2's own, which holds what
  rows the trim has dropped since. A row another build wrote meanwhile is
  caught up first (catchUp, which stamps it), so it counts once like any.
*/
function fromVersion2({ log, tally, legacy }) {
  const rows = (Array.isArray(log) ? log : []).filter(Boolean).map(r => ({ ...r }));
  const next = shape(JSON.parse(JSON.stringify(tally)));
  catchUp(next, rows, legacy);
  Object.assign(next, econOf(rows), { v: TALLY_VERSION });
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

// How many of this character's unrefunded plays at this game drew `uuid`.
export const wonCount = (tally, { boxId, actorId, uuid }) => Number(buyerTally(tally, { boxId, actorId })?.won?.[uuid]) || 0;

// A deck's draws by card id: { cardId: [at, ...] }.
export function deckDraws(tally, boxId) {
  return Object.fromEntries(Object.entries(tally?.decks?.[boxId] ?? {}).map(([card, times]) => [card, Object.values(times).map(Number)]));
}

// The economy, per character and per game: { chars, games } (see the header).
export const econTally = tally => ({ chars: { ...(tally?.chars ?? {}) }, games: { ...(tally?.games ?? {}) } });
