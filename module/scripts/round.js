/*
  The table round: the state every game played at the table shares (a kind
  with `table: true`, kinds.js), pure so Vitest runs it as it is. Roulette
  is the first; the Auction is meant to fit too.

  A round is one betting window on one game: the GM opens it, players stake
  while it is open, and one queued resolve on the GM settles or refunds every
  stake at once (table.js). The coins live in one place only, the pull log:

  - A stake is a log row written at charge time with `status: "open"` and
    the round's `roundId`. It has exactly one way out: the resolve settles
    it (`status: "settled"`, its `payoutCp`) or refunds it, or the GM's
    Refund closes it early, or the GM's load refunds it once its round is
    stale (staleStakes below). Nothing else holds coins.
  - A row's status is read through rowStatus: a refunded row is "refunded"
    whatever it says, and a row with no status (every row before rounds,
    and every pull of a kind that isn't a table) is "settled". No migration.
  - A round record (the `tableRounds` setting, by id) says only when bets
    are taken and whether it has resolved: { id, boxId, kind, status:
    "open" | "closed" | "resolved", opensAt, closesAt (null: until the GM
    spins), closedAt?, resolvedAt?, outcome?, voided? }. Who staked what is
    counted from the log, never copied onto the round, so a refund is seen
    by the round as soon as the row is marked.
  - A round resolves at most once: "resolved" is written before any coin
    moves, and a resolve that finds it so does nothing.
  What a round is doing, in words (roundState, clockText), is here too, so
  a table game's shop card and the shared table window say one thing; a
  kind puts it in its own voice (kinds.js tableView.words).
*/

// How long an "until the GM spins" round may sit open before a GM's load
// refunds its stakes. A reload mid-round keeps the round; one left for
// longer than that does not.
export const ROUND_WINDOW_MS = 10 * 60 * 1000;
// How long a closed round (by the GM, or its clock running out) waits for
// its spin before a GM's load refunds its stakes. One constant, so the
// grace is easy to change: a GM who reloads a minute after a short round
// closed still gets to spin it.
export const ROUND_GRACE_MS = 10 * 60 * 1000;
// Resolved rounds kept for the log's group headers; open ones are never dropped.
export const ROUNDS_KEPT = 50;

export const STATUS = { OPEN: "open", CLOSED: "closed", RESOLVED: "resolved" };

// A log row's status. Refunded wins; a row without one is settled.
export function rowStatus(row) {
  if (row?.refunded) return "refunded";
  return row?.status === "open" ? "open" : "settled";
}

export const isOpenStake = row => rowStatus(row) === "open";

// Every live stake of a round (open or settled, not refunded), newest first
// as the log keeps them.
export function stakesOf(log = [], roundId) {
  return log.filter(r => r?.roundId && r.roundId === roundId && rowStatus(r) !== "refunded");
}

export const openStakesOf = (log, roundId) => stakesOf(log, roundId).filter(isOpenStake);

// The round record a GM opens. `windowMs` 0 or absent: open until the GM spins.
export function newRound({ id, game, now = Date.now(), windowMs = 0 }) {
  const ms = Math.max(0, Math.round(Number(windowMs) || 0));
  return { id, boxId: game.id, kind: game.kind, status: STATUS.OPEN, opensAt: now, closesAt: ms ? now + ms : null };
}

// The round of this game that hasn't resolved, if any (one at a time per game).
export function liveRoundOf(rounds = {}, boxId) {
  return Object.values(rounds).find(r => r?.boxId === boxId && r.status !== STATUS.RESOLVED) ?? null;
}

// Why a stake on this round can't be taken now, or "" when it can.
export function stakeReason(round, now = Date.now()) {
  if (!round) return "There is no round open at this table.";
  if (round.status === STATUS.RESOLVED) return "That round has already been settled.";
  if (round.status === STATUS.CLOSED || (round.closesAt != null && now >= round.closesAt)) return "Bets are closed for this round.";
  return "";
}

// When a round's open stakes become the GM's load's to refund: the grace
// after it closed (by the GM, or its clock, whichever came first), or the
// window after it opened for a round with no clock still open. A resolved
// round's open rows are orphans (the resolve marked the round and stopped):
// stale at once.
export function staleAt(round) {
  if (!round) return -Infinity;
  if (round.status === STATUS.RESOLVED) return round.resolvedAt ?? -Infinity;
  const closed = Math.min(round.closedAt ?? Infinity, round.closesAt ?? Infinity);
  return Number.isFinite(closed) ? closed + ROUND_GRACE_MS : (round.opensAt ?? 0) + ROUND_WINDOW_MS;
}

// The open stakes a GM's load refunds: every open row whose round is gone
// or stale. Rows of a live round inside its window are left for its spin.
export function staleStakes(log = [], rounds = {}, now = Date.now()) {
  return log.filter(r => isOpenStake(r) && r.roundId && now >= staleAt(rounds[r.roundId]));
}

// The soonest moment an unresolved round goes stale, for the GM's timer;
// null when none is open.
export function nextStaleAt(rounds = {}) {
  const times = Object.values(rounds).filter(r => r && r.status !== STATUS.RESOLVED).map(staleAt);
  return times.length ? Math.min(...times) : null;
}

/*
  What the resolve does with each open stake, decided before anything is
  written. `check(row)` is the GM's guard as it stands at resolve time:
  "ok", "gone" (the character is deleted: the stake went with it, the row
  is closed and the GM told) or "owner" (the staking user no longer owns
  the character, or is gone: the stake goes back to the character, not
  paid). `settle(row)` is the kind's payoff for a stake that passed: {
  payoutCp, name?, result?, grant? }. A payout is coins back to the
  character, never below 0: the stake was already taken, so a table game
  can't take more. `grant` is Item data the core puts on the character's
  sheet at the resolve (the wheel's item on a rarity band), with `result`
  naming it ({ name, uuid, rarity }) so the row carries what the refund
  needs. Returns [{ row, action: "settle" | "refund" | "void", reason?,
  payoutCp, name?, result?, grant? }].
*/
export function planResolve(rows, { check, settle }) {
  return rows.map(row => {
    const guard = check(row);
    if (guard === "gone") return { row, action: "void", reason: "gone", payoutCp: 0 };
    if (guard !== "ok") return { row, action: "refund", reason: guard || "owner", payoutCp: 0 };
    const out = settle(row) ?? {};
    const payoutCp = Math.max(0, Math.round(Number(out.payoutCp) || 0));
    return { row, action: "settle", payoutCp, name: out.name ?? null, result: out.result ?? null, grant: out.grant ?? null };
  });
}

// Coins each plan line returns to its character, in copper: the payout of a
// settled stake, the stake of a refunded one, nothing for a void one.
export function coinsBack(line) {
  if (line.action === "settle") return line.payoutCp;
  if (line.action === "refund") return Math.round((Number(line.row.price) || 0) * 100);
  return 0;
}

// The copper each character gets back from a set of plan lines, summed per
// character so each purse is written once.
export function coinsByActor(lines) {
  const by = new Map();
  for (const l of lines) {
    const cp = coinsBack(l);
    if (!cp) continue;
    by.set(l.row.actorId, (by.get(l.row.actorId) ?? 0) + cp);
  }
  return by;
}

// The log row patch for each plan line. A settled stake that won an item
// carries it as a crate's row does (itemId, uuid, rarity), so the one
// Refund finds and removes it.
export function rowPatch(line, now = Date.now()) {
  if (line.action === "settle") {
    const item = line.itemId ? { itemId: line.itemId, uuid: line.result?.uuid ?? null, rarity: line.result?.rarity ?? null } : {};
    return { status: "settled", payoutCp: line.payoutCp, settledAt: now, ...(line.name ? { name: line.name } : {}), ...item };
  }
  return { status: "refunded", payoutCp: 0, refunded: now, refundReason: line.reason };
}

// Keeps every unresolved round and the newest ROUNDS_KEPT resolved ones.
export function pruneRounds(rounds = {}, keep = ROUNDS_KEPT) {
  const all = Object.values(rounds).filter(Boolean);
  const done = all.filter(r => r.status === STATUS.RESOLVED).sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
  const kept = new Set([...all.filter(r => r.status !== STATUS.RESOLVED), ...done.slice(0, keep)].map(r => r.id));
  return Object.fromEntries(Object.entries(rounds).filter(([id]) => kept.has(id)));
}

/*
  The Pull log's items with each round's rows folded under the round: the
  round's header sits where its newest row was, and its rows follow it.
  Takes the items collapseMisses (well.js) makes ({ row } or a misses
  group) and gives back the same items, with { round: true, roundId,
  boxName, rows, open, staked } in place of the round's rows.
*/
export function groupRounds(items = [], rounds = {}) {
  const groups = new Map();
  const out = [];
  for (const item of items) {
    const r = item.row;
    if (!r?.roundId) { out.push(item); continue; }
    let g = groups.get(r.roundId);
    if (!g) {
      g = { round: true, roundId: r.roundId, boxName: r.boxName, at: r.at, rows: [], status: rounds[r.roundId]?.status ?? null };
      groups.set(r.roundId, g);
      out.push(g);
    }
    g.rows.push(r);
  }
  for (const g of groups.values()) {
    const live = g.rows.filter(r => rowStatus(r) !== "refunded");
    g.open = live.filter(isOpenStake).length;
    g.staked = live.reduce((n, r) => n + Math.round((Number(r.price) || 0) * 100), 0) / 100;
  }
  return out;
}

// "3 stakes, 2 open" for a round's header line.
export function roundLine(g) {
  const n = g.rows.filter(r => rowStatus(r) !== "refunded").length;
  const stakes = `${n} stake${n === 1 ? "" : "s"}`;
  if (g.open) return `${stakes}, ${g.open} waiting on the spin`;
  return g.status === STATUS.RESOLVED ? `${stakes}, settled` : stakes;
}

// What happened to a table stake's coins, for its Pull log row: still
// waiting, or why the resolve (or a GM's load) turned it back. "" for any
// other row.
const STAKE_REASON = {
  owner: "Refunded at the spin: the character changed hands.",
  game: "Refunded at the spin: the game was gone.",
  gone: "The character was gone at the spin; the stake went with it.",
  stale: "Refunded when the GM loaded: the round never spun.",
  outbid: "Refunded: outbid.",
};
export function stakeNote(row) {
  if (!row?.roundId) return "";
  const status = rowStatus(row);
  if (status === "open") return "Open: waiting on the spin.";
  if (status === "settled") return Math.round(Number(row.payoutCp) || 0) > 0 ? "" : "Lost at the spin.";
  return STAKE_REASON[row.refundReason] ?? "";
}

// "0:42" from a time left in ms.
export function clockText(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/*
  What a round is doing, in words, for a table game's shop card and the
  shared table window's head: { key: "none" | "open" | "clock" | "closed" |
  "spinning", text, closesAt }. "clock" counts down (the card's one ticking
  line, data-lc-countdown). A kind says it in its own words through
  `words` (the wheel's "The wheel is turning"; tableView.words, kinds.js);
  these are the plain ones.
*/
export const ROUND_WORDS = {
  none: "No round open yet",
  closed: "Bets are closed",
  waiting: "Bets are closed: waiting for the GM",
  clock: left => `Bets close in ${clockText(left)}`,
  open: "Bets are open until the GM calls it",
  held: "The table is settling",
};
export function roundState(round, { now = Date.now(), held = false, words = {} } = {}) {
  const w = { ...ROUND_WORDS, ...words };
  if (held) return { key: "spinning", text: w.held };
  if (!round || round.status === STATUS.RESOLVED) return { key: "none", text: w.none };
  if (stakeReason(round, now)) return { key: "closed", text: w.closed };
  if (round.closesAt != null) return { key: "clock", text: w.clock(round.closesAt - now), closesAt: round.closesAt };
  return { key: "open", text: w.open };
}
