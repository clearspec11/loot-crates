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
    If the rows can't be marked, the round goes back to closed so Spin can
    retry (undoResolve); if even that fails, every client hears it called
    off and the GM's next load refunds it.
  - The guards run again at the resolve: a character deleted since the
    stake has its row closed (the coins went with it), and one whose staking
    user no longer owns it gets the stake back, not the winnings.
  - The GM's Refund closes an open row early (refund.js, unchanged: the
    stake comes back and the round stops counting the row).
  - recoverRounds, on the GM's ready hook, refunds every open row whose
    round is gone or stale (round.js staleStakes) and voids the stale
    rounds, telling the GM how many. While the GM stays, watchStale runs it
    again when the next round goes stale (round.js nextStaleAt), so a round
    left unspun comes back without a reload.
  - cancelRound, the GM calling a round off (the Auction's Call it off):
    the round is voided first, then every open stake refunded in one task.
    The manager's Delete calls a game's round off this way before the game
    goes.
  - refundOrphanRounds, on the active GM whenever the boxes change and at
    load: a round whose game is gone some other way (the module API,
    another GM's client) is called off through cancelRound, so no stake
    waits in escrow for a game that can't be spun.
  - A kind that runs itself (the Auction) is watched on the GM's client
    (watchTables): its round resolves through the same resolveRound once
    its clock runs out (`hammer`), and its `tick` (the house bidders) is
    given a turn in the write queue while it takes stakes. A house stake is
    a row with no character and no coins (`house: true`, price 0): it is
    outbid, settled and recovered like any other, and moves no purse.

  Messages (socket.js routes them here on every client, heard below):
    { type: "round", event: "open" | "close", round, boxName }
    { type: "staked", requestId, userId, roundId, boxId, logId, actorId,
      actorName, price, stake, purse }                one per stake, to all
    { type: "round", event: "resolve", roundId, boxId, kind, box, outcome,
      stakes: [{ logId, actorId, actorName, userId, price, stake, action,
      reason, payoutCp, name, result }], ...the kind's roll extras }
    { type: "round", event: "void", roundIds, refunded }  the load's recovery
    { type: "round", event: "void", roundIds, refunded: [], onReload: true }
                                 a spin that failed and couldn't be undone
    { type: "round", event: "void", roundIds: [id], refunded, cancelled: true }
                                 the GM called the round off
    { type: "staked", house: true, userId: null, actorId: null, ... }
                                 a house stake (the Auction's house bidder)
  onTable(fn) hears each of them on this client (B2's window).
*/
import { SOCKET } from "./config.js";
import { getBoxes, getPools, getLog, getRounds, saveRound, saveRounds, updateLogRows, appendLog, enqueueWrite, newId } from "./store.js";
import { getKind, kindFor, PullError } from "./kinds.js";
import { settle } from "./currency.js";
import { rollRng, resolveSource } from "./pull.js";
import { newRound, liveRoundOf, openStakesOf, stakesOf, staleStakes, staleAt, nextStaleAt, stakeReason, planResolve, coinsByActor, rowPatch, tableDue, orphanRounds, STATUS } from "./round.js";
import { onShelf, shelfRoundRefusal } from "./shelf.js";
// reveal.js imports socket.js, which imports this file; each side reaches
// the other only inside a function.
import { showRound, boxHeld } from "./reveal.js";
import { postPullCard } from "./chat.js";
import { t } from "./i18n.js";

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
  if (!gm || gm.id !== game.user.id) throw new PullError(t("LOOTCRATES.Error.NotActiveGM"));
}

/*
  Opens a betting window on a table game, or gives back the one already
  open (one round at a time per game). `windowMs` 0: open until the GM spins.
*/
export function openRound(boxId, { windowMs = 0 } = {}) {
  gmOnly();
  return enqueueWrite(async () => {
    const box = getBoxes()[boxId];
    if (!box) throw new PullError(t("LOOTCRATES.Error.GameGone"));
    if (!kindFor(box).table) throw new PullError(t("LOOTCRATES.Error.NotTable", { name: box.name }));
    const live = liveRoundOf(getRounds(), boxId);
    if (live) return live;
    // The last round still plays on the GM's screen: the next one opens
    // once it lands, never under it.
    if (boxHeld(boxId)) throw new PullError(t("LOOTCRATES.Error.StillPlaying", { name: box.name }));
    // Off the shelf, no new round; one already open runs to its resolve.
    if (!onShelf(box)) throw new PullError(shelfRoundRefusal(box));
    if (box.rules?.stock != null && box.rules.stock <= 0) throw new PullError(t("LOOTCRATES.Error.SoldOut", { name: box.name }));
    // The kind's own word on a game that can't be played yet (the Auction with no lot).
    const unready = kindFor(box).openReason?.(box);
    if (unready) throw new PullError(unready);
    const round = await saveRound(newRound({ id: newId(), game: box, windowMs }));
    announce({ type: "round", event: "open", round, boxName: box.name });
    watchTables();
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

// The guard at the resolve, as it stands now (round.js planResolve). A
// house stake has no character to guard.
function guardAtResolve(row) {
  if (row.house) return "ok";
  const actor = game.actors.get(row.actorId);
  if (!actor) return "gone";
  const user = game.users.get(row.userId);
  return user && actor.testUserPermission(user, "OWNER") ? "ok" : "owner";
}

/*
  The coins of a set of plan lines (round.js): grants any item a settled
  stake won (so its id is on the row), marks every row in one log write,
  then pays each character once through settle(). A grant that fails
  leaves the stake paid in coins, reported to the GM, unless the line says
  `refundOnFail` (a bid paid for the item alone): then the stake comes
  back instead. Returns the names of characters whose purse couldn't be
  written (reported to the GM).
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
      console.error(`loot-crates | granting ${l.result?.name ?? "the item"} to ${l.row.actorName} at the spin failed; ${l.refundOnFail ? "the stake is refunded" : "the stake is paid in coins only"}`, err);
      globalThis.ui?.notifications?.error(t("LOOTCRATES.Error.WonNotAdded", { actor: l.row.actorName, item: l.result?.name ?? t("LOOTCRATES.Error.AnItem"), box: l.row.boxName }));
      l.itemId = null;
    }
    if (!l.itemId) {
      l.result = null;
      l.grant = null;
      if (l.refundOnFail) Object.assign(l, { action: "refund", reason: "grant", payoutCp: 0, name: null, note: null });
    }
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
  if (unpaid.length) globalThis.ui?.notifications?.error(t("LOOTCRATES.Error.Unpaid", { names: unpaid.join(", ") }));
  return unpaid;
}

// The GM's word on stakes the guards turned back at a resolve.
function guardNotice(plan, boxName) {
  const refunded = plan.filter(l => l.action === "refund").length;
  const gone = plan.filter(l => l.action === "void").length;
  const parts = [];
  if (refunded) parts.push(t(refunded === 1 ? "LOOTCRATES.Error.RoundRefundedOne" : "LOOTCRATES.Error.RoundRefundedMany", { count: refunded }));
  if (gone) parts.push(t(gone === 1 ? "LOOTCRATES.Error.RoundGoneOne" : "LOOTCRATES.Error.RoundGoneMany", { count: gone }));
  if (parts.length) globalThis.ui?.notifications?.warn(t("LOOTCRATES.Error.RoundAt", { box: boxName, parts: parts.join(t("LOOTCRATES.Common.ListSemicolon")) }));
}

/*
  The round's one resolve, in one queued task on the GM. A round already
  resolved is left as it is ({ status: "already" }). A roll that throws
  writes nothing. `ifDue` (the watch's hammer) resolves only a round whose
  clock has run out by the time the task runs: a bid queued just ahead of
  it moved the gavel on, and the round is left for it ({ status:
  "not-due" }). Returns { status: "resolved", round, reveal, plan }.

  The queue is this client's, so it can't hold back a second GM's: a GM
  who joins with a lower id becomes the active one while this resolve is
  still rolling, and their watch brings the same gavel down. So after the
  roll, the one await before the first write, the resolve asks again: a
  client that is no longer the active GM writes nothing (NotActiveGM; the
  new one resolves it), and a round another GM resolved meanwhile is
  "already". One gavel, one settle.
*/
export function resolveRound(roundId, { rng = rollRng(), ifDue = false } = {}) {
  gmOnly();
  return enqueueWrite(() => doResolve(roundId, rng, { ifDue }));
}

async function doResolve(roundId, rng, { ifDue = false } = {}) {
  const round = getRounds()[roundId];
  if (!round) throw new PullError(t("LOOTCRATES.Error.RoundGone"));
  if (round.status === STATUS.RESOLVED) return { status: "already", round };
  if (ifDue && round.status === STATUS.OPEN && !(round.closesAt != null && Date.now() >= round.closesAt)) return { status: "not-due", round };
  const box = getBoxes()[round.boxId] ?? null;
  const kind = box ? getKind(round.kind) : null;
  if (box && !kind) throw new PullError(t("LOOTCRATES.Error.UnknownKind", { name: box.name, id: round.kind }));
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
  if (kind) ({ outcome = null, grants = {}, ...extra } = (await kind.roll({ game: box, round, stakes: rows, rng, log, now, pools: getPools(), boxes: getBoxes(), resolveSource })) ?? {});
  gmOnly();
  if (getRounds()[roundId]?.status === STATUS.RESOLVED) return { status: "already", round: getRounds()[roundId] };
  const plan = planResolve(rows, {
    check: row => { const g = guardAtResolve(row); return g === "ok" && !kind ? "game" : g; },
    settle: row => kind.settle?.({ game: box, round, outcome, row, stake: row.stake, grants: grants ?? {} }) ?? { payoutCp: 0 },
  });

  const boxName = box?.name ?? rows[0]?.boxName ?? "";
  const resolved = await saveRound({ ...round, status: STATUS.RESOLVED, closedAt: round.closedAt ?? now, resolvedAt: now, outcome });
  try {
    await closeStakes(plan, now);
  } catch (err) {
    // The log still holds every stake open: nothing was paid, so the round
    // goes back to waiting for its spin. Once marked, the coins moved.
    const marked = new Set(openStakesOf(getLog(), roundId).map(r => r.id));
    if (rows.every(r => marked.has(r.id))) await undoResolve({ round, plan, boxName, now, err });
    else console.error(`loot-crates | the spin at ${boxName} was settled, but closing its stakes failed partway`, err);
  }

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
  A resolve whose stakes couldn't be closed (the log write failed) never
  strands the table: items granted at this spin are taken back and the
  round goes back to closed, so Spin can roll again, and the GM is told in
  one sentence (the PullError, which the Spin button shows). If that
  rollback fails too, the round stays marked resolved, so it can't pay
  twice, and every client is told it was called off: its open stakes are
  refunded on the GM's next load (recoverRounds, a resolved round's open
  rows being stale at once). Always throws.
*/
async function undoResolve({ round, plan, boxName, now, err }) {
  console.error(`loot-crates | closing the stakes of the spin at ${boxName} failed; rolling the round back`, err);
  try {
    for (const l of plan) {
      if (!l.itemId) continue;
      const item = game.actors.get(l.row.actorId)?.items?.get(l.itemId);
      if (item) await item.delete();
    }
    await saveRound({ ...round, status: STATUS.CLOSED, closedAt: round.closedAt ?? now });
  } catch (undoErr) {
    const kept = plan.filter(l => l.itemId).map(l => `${l.result?.name ?? "an item"} on ${l.row.actorName}`);
    console.error(`loot-crates | rolling back the spin at ${boxName} failed; its stakes are refunded on the GM's next load${kept.length ? `. Granted and possibly still on the sheet: ${kept.join(", ")}` : ""}`, undoErr);
    announce({ type: "round", event: "void", roundIds: [round.id], refunded: [], onReload: true });
    throw new PullError(t("LOOTCRATES.Error.SpinUndoFailed", { box: boxName }));
  }
  throw new PullError(t("LOOTCRATES.Error.SpinFailed", { box: boxName }));
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
    // A house stake holds no coins: it is closed with the rest, unsaid.
    const plan = rows.map(row => (row.house || game.actors.get(row.actorId)
      ? { row, action: "refund", reason: "stale", payoutCp: 0 }
      : { row, action: "void", reason: "gone", payoutCp: 0 }));
    await closeStakes(plan, now);
    const said = plan.filter(l => !l.row.house);
    const refunded = said.filter(l => l.action === "refund").length;
    const gone = said.length - refunded;
    if (said.length) {
      const count = said.length;
      globalThis.ui?.notifications?.warn(gone ? t(count === 1 ? "LOOTCRATES.Error.StaleGoneOne" : "LOOTCRATES.Error.StaleGoneMany", { count, refunded, gone }) : t(count === 1 ? "LOOTCRATES.Error.StaleOne" : "LOOTCRATES.Error.StaleMany", { count }));
    }
    announce({ type: "round", event: "void", roundIds: stale.map(r => r.id), refunded: rows.map(r => r.id) });
    return { refunded, gone, voided: stale.length };
  });
}

/*
  The GM's timer for the next round to go stale, on the active GM only: one
  setTimeout at round.js nextStaleAt (a moment past it, so the round is
  stale when it fires), which runs recoverRounds and arms the next. Armed
  at load, on every change of the rounds setting, and whenever who the
  active GM is may have changed (a GM joining or leaving, a role changed:
  main.js), each call replacing the last, so a round opened, closed or
  spun moves it, and a GM handing over takes the timer with it. A
  recovery that fails is tried again after WATCH_RETRY_MS. Nothing to wait
  for, or not the active GM (any timer this client had is cleared): no
  timer. Returns the delay armed, or null.
*/
export const STALE_SLACK_MS = 250;
// setTimeout's longest delay; a later moment is re-armed when this fires.
const MAX_DELAY_MS = 2 ** 31 - 1;
let staleTimer = null;

export function watchStale() {
  if (staleTimer) clearTimeout(staleTimer);
  staleTimer = null;
  if (!globalThis.game?.user || game.users?.activeGM?.id !== game.user.id) return null;
  const at = nextStaleAt(getRounds());
  if (at == null) return null;
  const ms = Math.min(MAX_DELAY_MS, Math.max(0, at - Date.now()) + STALE_SLACK_MS);
  staleTimer = setTimeout(() => {
    staleTimer = null;
    if (Date.now() < at) return watchStale();
    recoverRounds()
      .then(() => watchStale())
      .catch(err => {
        console.error("loot-crates | refunding a stale round failed; trying again shortly", err);
        if (!staleTimer) staleTimer = setTimeout(watchStale, WATCH_RETRY_MS);
      });
  }, ms);
  return ms;
}

export function stopStaleWatch() {
  if (staleTimer) clearTimeout(staleTimer);
  staleTimer = null;
}

/*
  The GM calls a round off (the Auction's Call it off), in one queued task:
  the round is marked resolved and voided first, so it can never resolve
  and pay, then every open stake is refunded (a deleted character's went
  with it), and every client hears it called off. Returns { refunded,
  gone } (house stakes, which hold nothing, are not counted).
*/
export function cancelRound(roundId) {
  gmOnly();
  return enqueueWrite(async () => {
    const round = getRounds()[roundId];
    if (!round) throw new PullError(t("LOOTCRATES.Error.RoundGone"));
    if (round.status === STATUS.RESOLVED) return { status: "already", refunded: 0, gone: 0 };
    const now = Date.now();
    await saveRound({ ...round, status: STATUS.RESOLVED, closedAt: round.closedAt ?? now, resolvedAt: now, voided: now, cancelled: true });
    const rows = openStakesOf(getLog(), roundId);
    const plan = rows.map(row => (row.house || game.actors.get(row.actorId)
      ? { row, action: "refund", reason: "cancel", payoutCp: 0 }
      : { row, action: "void", reason: "gone", payoutCp: 0 }));
    await closeStakes(plan, now);
    announce({ type: "round", event: "void", roundIds: [roundId], refunded: rows.map(r => r.id), cancelled: true });
    const said = plan.filter(l => !l.row.house);
    return { status: "cancelled", refunded: said.filter(l => l.action === "refund").length, gone: said.filter(l => l.action === "void").length };
  });
}

/*
  The safety net under Delete, on the active GM only: every round not yet
  settled whose game is no longer in the boxes (round.js orphanRounds) is
  called off through cancelRound, and the GM is told once per game how
  many stakes came back. The manager's Delete has already called its round
  off, so this finds nothing then. Heard on every change of the boxes
  setting (main.js) and at load; cancelRound's own check makes a second
  call for the same round do nothing. Returns cancelRound's results.
*/
export async function refundOrphanRounds() {
  if (!globalThis.game?.user || game.users?.activeGM?.id !== game.user.id) return [];
  const orphans = orphanRounds(getRounds(), getBoxes());
  const out = [];
  for (const round of orphans) {
    const name = getLog().find(r => r?.roundId === round.id)?.boxName || t("LOOTCRATES.Error.ADeletedGame");
    const result = await cancelRound(round.id);
    if (result.status !== "cancelled") continue;
    out.push({ roundId: round.id, name, ...result });
    const { refunded, gone } = result;
    if (!refunded && !gone) continue;
    const back = [refunded ? t(refunded === 1 ? "LOOTCRATES.Game.StakesRefundedOne" : "LOOTCRATES.Game.StakesRefundedMany", { count: refunded }) : "", gone ? t("LOOTCRATES.Error.CountGone", { count: gone }) : ""].filter(Boolean).join(t("LOOTCRATES.Common.ListSemicolon"));
    globalThis.ui?.notifications?.warn(t("LOOTCRATES.Error.DeletedWithRound", { name, back }));
  }
  return out;
}

/*
  A table kind's own turn (kinds.js tick: the Auction's house bidders), on
  the GM inside the write queue: while the round takes stakes and its game
  is on the shelf, the kind may answer with a house stake ({ label, amount,
  house, actorName, outbid, closesIn }), written as an open row with no
  character and no coins, the stakes it displaces refunded and the round's
  clock moved in the same task, then heard by everyone as a "staked".
  Returns the broadcast, or null when the kind passed.
*/
export function tableTick(roundId, { rng = rollRng() } = {}) {
  gmOnly();
  return enqueueWrite(async () => {
    let round = getRounds()[roundId];
    const box = round ? getBoxes()[round.boxId] : null;
    const kind = box ? getKind(round.kind) : null;
    if (!round || !box || typeof kind?.tick !== "function" || stakeReason(round) || !onShelf(box)) return null;
    const stakes = stakesOf(getLog(), roundId);
    const bid = kind.tick({ game: box, round, stakes, rng, now: Date.now() });
    if (!bid) return null;
    const logId = newId();
    const stake = { label: bid.label, amount: bid.amount, house: bid.house };
    await appendLog({ id: logId, kind: round.kind, boxId: box.id, boxName: box.name, actorId: null, actorName: bid.actorName, userId: null, itemId: null, price: 0, payoutCp: 0, status: "open", roundId, stake, name: bid.label, house: true });
    const displaced = stakes.filter(r => (bid.outbid ?? []).includes(r.id) && r.status === "open");
    if (displaced.length) await closeStakes(displaced.map(r => ({ row: r, action: r.house || game.actors.get(r.actorId) ? "refund" : "void", reason: "outbid", payoutCp: 0 })));
    if (bid.closesIn != null) round = await saveRound({ ...round, closesAt: Date.now() + bid.closesIn });
    const staked = { type: "staked", requestId: null, userId: null, roundId, boxId: box.id, logId, actorId: null, actorName: bid.actorName, price: 0, stake, purse: null, outbid: displaced.map(r => r.id), house: true, round };
    announce(staked);
    return staked;
  });
}

/*
  The GM's watch on the rounds of kinds that run themselves (kinds.js
  `hammer`, `tick`: the Auction), once a second on the active GM's client
  while any is live (round.js tableDue): a round whose clock has run out
  is resolved (resolveRound with ifDue, so a bid queued just ahead of it
  keeps its gavel), and one taking stakes gets its tick every tickMs. A
  hammer that fails (the resolve rolled back, as Spin's does) is tried
  again after WATCH_RETRY_MS, and the GM is told once. Started when such a
  round opens or is staked, on the GM's load (main.js), so a GM who
  reloads mid-auction brings its gavel down (or, past the grace, the load's
  recovery refunds it first), and whenever who the active GM is may have
  changed (main.js, as watchStale), so a GM taking over a live auction
  takes its watch with it. It stops itself when nothing is left to watch,
  and at once on a client that is not the active GM. Returns true when it
  started a watch.
*/
export const WATCH_MS = 1000;
export const WATCH_RETRY_MS = 10000;
let watch = null;
const lastTick = new Map();
const busy = new Set();
const failedAt = new Map();

const selfRunning = kind => !!(kind?.hammer || typeof kind?.tick === "function");

export function watchTables() {
  if (!globalThis.game?.user || game.users?.activeGM?.id !== game.user.id) {
    stopWatching();
    return false;
  }
  if (watch) return false;
  watch = setInterval(watchTick, WATCH_MS);
  watchTick();
  return true;
}

export function stopWatching() {
  if (watch) clearInterval(watch);
  watch = null;
  lastTick.clear();
  busy.clear();
  failedAt.clear();
}

function watchTick() {
  if (game.users?.activeGM?.id !== game.user.id) return stopWatching();
  const now = Date.now();
  const rounds = Object.values(getRounds()).filter(r => r && r.status !== STATUS.RESOLVED && selfRunning(getKind(r.kind)));
  if (!rounds.length) return stopWatching();
  for (const round of rounds) {
    if (busy.has(round.id)) continue;
    const due = tableDue(round, getKind(round.kind), { now, lastTick: lastTick.get(round.id) ?? round.opensAt ?? -Infinity });
    if (due === "hammer") {
      if (now - (failedAt.get(round.id) ?? -Infinity) < WATCH_RETRY_MS) continue;
      busy.add(round.id);
      resolveRound(round.id, { ifDue: true })
        .catch(err => {
          // Handed over mid-resolve: the new active GM's watch has it.
          if (game.users?.activeGM?.id !== game.user.id) return;
          const told = failedAt.has(round.id);
          failedAt.set(round.id, Date.now());
          console.error("loot-crates | bringing the gavel down failed; trying again shortly", err);
          if (!told) globalThis.ui?.notifications?.warn(err instanceof PullError ? err.message : t("LOOTCRATES.Error.GavelJammed"));
        })
        .finally(() => busy.delete(round.id));
    } else if (due === "tick") {
      lastTick.set(round.id, now);
      busy.add(round.id);
      tableTick(round.id)
        .catch(err => console.error("loot-crates | the table's turn failed", err))
        .finally(() => busy.delete(round.id));
    }
  }
}
