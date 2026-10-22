/*
  The table round on the core, GM side: open a round, take stakes (socket.js
  doStake, through the same queue, guards and money path as a pull), close
  it, resolve it once, and refund what a round left behind when the GM's
  Foundry loads. The state is round.js's (pure); the window that shows a
  round is a table kind's (B2), plugged into reveal.js setTableWindow.

  Every coin held has one way out and a recovery path:
  - A stake is charged and its open log row written in one queued task
    (socket.js doStake), so the coins are never without a row.
  - resolveRound runs in one queued task: it rolls the kind's outcome, marks
    the round resolved (so a second resolve does nothing), marks every open
    row settled or refunded in one log write, then moves the coins, summed
    per character, through currency.js settle(). Marked first, as a refund
    is: a failure after the mark can't pay twice; it is reported for the GM.
  - The guards run again at the resolve: a character deleted since the
    stake has its row closed (the coins went with it), and one whose staking
    user no longer owns it gets the stake back, not the winnings.
  - The GM's Refund closes an open row early (refund.js, unchanged: the
    stake comes back and the round stops counting the row).
  - recoverRounds, on the GM's ready hook, refunds every open row whose
    round is gone or stale (round.js staleStakes) and voids the stale
    rounds, telling the GM how many.

  Messages (socket.js routes them here on every client, heard below):
    { type: "round", event: "open" | "close", round, boxName }
    { type: "staked", requestId, userId, roundId, boxId, logId, actorId,
      actorName, price, stake, purse }                one per stake, to all
    { type: "round", event: "resolve", roundId, boxId, kind, box, outcome,
      stakes: [{ logId, actorId, actorName, userId, price, stake, action,
      reason, payoutCp, name, result }], ...the kind's roll extras }
    { type: "round", event: "void", roundIds, refunded }  the load's recovery
  onTable(fn) hears each of them on this client (B2's window).
*/
import { SOCKET } from "./config.js";
import { getBoxes, getPools, getLog, getRounds, saveRound, saveRounds, updateLogRows, enqueueWrite, newId } from "./store.js";
import { getKind, kindFor, PullError } from "./kinds.js";
import { settle } from "./currency.js";
import { rollRng, resolveSource } from "./pull.js";
import { newRound, liveRoundOf, openStakesOf, staleStakes, staleAt, planResolve, coinsByActor, rowPatch, STATUS } from "./round.js";
// reveal.js imports socket.js, which imports this file; each side reaches
// the other only inside a function.
import { showRound } from "./reveal.js";
import { postPullCard } from "./chat.js";

const listeners = new Set();

// Hears every round message on this client. Returns the function that stops it.
export function onTable(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// A round message, on every client (socket.js), and on the GM for its own.
// A resolve opens the table's reveal (and its hold) before anyone else hears it.
export function heard(msg) {
  if (msg?.type === "round" && msg.event === "resolve") {
    try { showRound(msg); } catch (err) { console.error("loot-crates | the round's reveal failed", err); }
  }
  for (const fn of listeners) {
    try { fn(msg); } catch (err) { console.error("loot-crates | a table listener failed", err); }
  }
}

// To everyone, here included.
export function announce(msg) {
  game.socket.emit(SOCKET, msg);
  heard(msg);
}

function gmOnly() {
  const gm = game.users.activeGM;
  if (!gm || gm.id !== game.user.id) throw new PullError("Only the GM running the game can do that.");
}

/*
  Opens a betting window on a table game, or gives back the one already
  open (one round at a time per game). `windowMs` 0: open until the GM spins.
*/
export function openRound(boxId, { windowMs = 0 } = {}) {
  gmOnly();
  return enqueueWrite(async () => {
    const box = getBoxes()[boxId];
    if (!box) throw new PullError("That game no longer exists.");
    if (!kindFor(box).table) throw new PullError(`${box.name} isn't played at the table.`);
    const live = liveRoundOf(getRounds(), boxId);
    if (live) return live;
    const round = await saveRound(newRound({ id: newId(), game: box, windowMs }));
    announce({ type: "round", event: "open", round, boxName: box.name });
    return round;
  });
}

// No more bets: the round waits for its spin.
export function closeRound(roundId) {
  gmOnly();
  return enqueueWrite(async () => {
    const round = getRounds()[roundId];
    if (!round || round.status !== STATUS.OPEN) return round ?? null;
    const closed = await saveRound({ ...round, status: STATUS.CLOSED, closedAt: Date.now() });
    announce({ type: "round", event: "close", round: closed, boxName: getBoxes()[round.boxId]?.name ?? "" });
    return closed;
  });
}

// The guard at the resolve, as it stands now (round.js planResolve).
function guardAtResolve(row) {
  const actor = game.actors.get(row.actorId);
  if (!actor) return "gone";
  const user = game.users.get(row.userId);
  return user && actor.testUserPermission(user, "OWNER") ? "ok" : "owner";
}

/*
  The coins of a set of plan lines (round.js): grants any item a settled
  stake won (so its id is on the row), marks every row in one log write,
  then pays each character once through settle(). A grant that fails
  leaves the stake paid in coins, reported to the GM. Returns the names of
  characters whose purse couldn't be written (reported to the GM).
*/
export async function closeStakes(lines, now = Date.now()) {
  if (!lines.length) return [];
  for (const l of lines) {
    if (l.action !== "settle" || !l.grant) continue;
    const actor = game.actors.get(l.row.actorId);
    try {
      const [created] = actor ? await actor.createEmbeddedDocuments("Item", [l.grant]) : [];
      l.itemId = created?.id ?? null;
    } catch (err) {
      console.error(`loot-crates | granting ${l.result?.name ?? "the item"} to ${l.row.actorName} at the spin failed; the stake is paid in coins only`, err);
      globalThis.ui?.notifications?.error(`Loot Crates: ${l.row.actorName} won ${l.result?.name ?? "an item"} at ${l.row.boxName}, but it couldn't be added to their sheet. Check the console.`);
      l.itemId = null;
    }
    if (!l.itemId) { l.result = null; l.grant = null; }
  }
  await updateLogRows(lines.map(l => [l.row.id, rowPatch(l, now)]));
  const unpaid = [];
  for (const [actorId, cp] of coinsByActor(lines)) {
    const actor = game.actors.get(actorId);
    if (!actor) continue;
    try {
      await actor.update({ "system.currency": settle(actor.system?.currency ?? {}, cp) });
    } catch (err) {
      console.error(`loot-crates | could not pay ${cp} cp to ${actor.name}; the GM must pay it by hand`, err);
      unpaid.push(actor.name);
    }
  }
  if (unpaid.length) globalThis.ui?.notifications?.error(`Loot Crates: ${unpaid.join(", ")} weren't paid what the round owed them. Check the console.`);
  return unpaid;
}

// The GM's word on stakes the guards turned back at a resolve.
function guardNotice(plan, boxName) {
  const refunded = plan.filter(l => l.action === "refund").length;
  const gone = plan.filter(l => l.action === "void").length;
  const parts = [];
  if (refunded) parts.push(`${refunded} stake${refunded === 1 ? " was" : "s were"} refunded, not paid: the character changed hands or its game is gone`);
  if (gone) parts.push(`${gone} stake${gone === 1 ? "'s character is" : "s' characters are"} gone, so ${gone === 1 ? "it" : "they"} went with ${gone === 1 ? "it" : "them"}`);
  if (parts.length) globalThis.ui?.notifications?.warn(`Loot Crates: at ${boxName}, ${parts.join("; ")}.`);
}

/*
  The round's one resolve, in one queued task on the GM. A round already
  resolved is left as it is ({ status: "already" }). A roll that throws
  writes nothing. Returns { status: "resolved", round, reveal, plan }.
*/
export function resolveRound(roundId, { rng = rollRng() } = {}) {
  gmOnly();
  return enqueueWrite(() => doResolve(roundId, rng));
}

async function doResolve(roundId, rng) {
  const round = getRounds()[roundId];
  if (!round) throw new PullError("That round is gone.");
  if (round.status === STATUS.RESOLVED) return { status: "already", round };
  const box = getBoxes()[round.boxId] ?? null;
  const kind = box ? getKind(round.kind) : null;
  if (box && !kind) throw new PullError(`${box.name} is a kind of game (${round.kind}) this client can't run.`);
  const log = getLog();
  const rows = openStakesOf(log, roundId);
  const now = Date.now();

  // The outcome is decided here, once, before anything is written or shown.
  // A game deleted since the round opened can't roll: its stakes go back.
  // The kind's `grants` (Item data by row id, for stakes that won an item)
  // reach settle() and the sheet, never the broadcast.
  let outcome = null;
  let grants = {};
  let extra = {};
  if (kind) ({ outcome = null, grants = {}, ...extra } = (await kind.roll({ game: box, round, stakes: rows, rng, log, now, pools: getPools(), resolveSource })) ?? {});
  const plan = planResolve(rows, {
    check: row => { const g = guardAtResolve(row); return g === "ok" && !kind ? "game" : g; },
    settle: row => kind.settle?.({ game: box, round, outcome, row, stake: row.stake, grants: grants ?? {} }) ?? { payoutCp: 0 },
  });

  const resolved = await saveRound({ ...round, status: STATUS.RESOLVED, closedAt: round.closedAt ?? now, resolvedAt: now, outcome });
  await closeStakes(plan, now);

  const boxName = box?.name ?? rows[0]?.boxName ?? "";
  const reveal = {
    ...extra,
    type: "round", event: "resolve", roundId, boxId: round.boxId, kind: round.kind,
    box: { id: round.boxId, name: boxName }, outcome,
    stakes: plan.map(l => ({ logId: l.row.id, actorId: l.row.actorId, actorName: l.row.actorName, userId: l.row.userId, price: l.row.price, stake: l.row.stake ?? null, action: l.action, reason: l.reason ?? null, payoutCp: l.payoutCp, name: l.name ?? null, result: l.result ?? null, itemId: l.itemId ?? null })),
  };
  announce(reveal);
  // The round's one chat card, tied to the round (its seal is the round's hold).
  postPullCard({ ...reveal, logId: roundId }).catch(err => console.error("loot-crates | the round's chat card failed", err));
  guardNotice(plan, boxName);
  return { status: "resolved", round: resolved, reveal, plan };
}

/*
  On the GM's load: every open stake whose round is gone or stale is
  refunded (to a character that still exists; a deleted one's coins went
  with it), and every stale round is voided so it can never resolve and
  pay. The GM is told how many. Rounds still inside their window are left
  for their spin.
*/
export function recoverRounds() {
  return enqueueWrite(async () => {
    const now = Date.now();
    const rounds = getRounds();
    const rows = staleStakes(getLog(), rounds, now);
    const stale = Object.values(rounds).filter(r => r && r.status !== STATUS.RESOLVED && now >= staleAt(r));
    if (!rows.length && !stale.length) return { refunded: 0, gone: 0, voided: 0 };
    if (stale.length) await saveRounds(stale.map(r => ({ ...r, status: STATUS.RESOLVED, closedAt: r.closedAt ?? now, resolvedAt: now, voided: now })));
    const plan = rows.map(row => (game.actors.get(row.actorId)
      ? { row, action: "refund", reason: "stale", payoutCp: 0 }
      : { row, action: "void", reason: "gone", payoutCp: 0 }));
    await closeStakes(plan, now);
    const refunded = plan.filter(l => l.action === "refund").length;
    const gone = plan.length - refunded;
    if (plan.length) {
      const what = `${plan.length} open stake${plan.length === 1 ? "" : "s"} from a round that never spun`;
      const back = gone ? `: ${refunded} refunded, ${gone} belonged to a character that is gone` : ` ${plan.length === 1 ? "was" : "were"} refunded`;
      globalThis.ui?.notifications?.warn(`Loot Crates: ${what}${back}.`);
    }
    announce({ type: "round", event: "void", roundIds: stale.map(r => r.id), refunded: rows.map(r => r.id) });
    return { refunded, gone, voided: stale.length };
  });
}
