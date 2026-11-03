/*
  Players can't deduct their own gold or pull from compendia, so a purchase is
  a request to the active GM's client, which does the pull and broadcasts the
  reveal to everyone. No GM online means the shop is closed.

  Who sent it. A player's client can write anything into a message, and a
  message on the module socket arrives with no word from Foundry of who
  sent it (probed on 14.369: a pull naming another player as its sender, and
  their character as the buyer, was charged; a cancel naming another player
  marked their sale as called off; every player's client overheard every
  request). So the requests (pull, redeem, keep, stake, cancel, newDay,
  give, sell) go to the active GM only, as a Foundry query (User#query,
  REQUEST_QUERY), and the GM takes the sender from Foundry (heardRequest,
  senderOf), never from the message: a request naming anyone else is
  refused, the GM told, and nothing charged, and the guards then check the
  character against the real sender. A request that still comes over the
  socket (a client running an older build) is refused and its named
  sender told to reload.

  The answer goes back the same way. Anything on the socket can be forged
  by any player who has heard a request id (it rides the slow-pull ack
  every client hears): a forged "error" made a buyer's shop say a pull had
  failed while the GM went on charging it, and a second press charged
  again. So every answer to a request (the reveal for its buyer, kept,
  staked, a refusal, a late cancel's "it opened after all", an owed rest
  counted) is the query's own result (answerOf; a refusal is { type:
  "error", message, stalePrice? }, since Foundry passes only a thrown
  error's message), and a client ignores the socket's word on its own
  requests. What stays on the socket is what every client shows and none
  acts on for its money: the reveal for everyone else to watch, a table's
  staked and round, the slow-pull ack, the GM's ask for owed rests.

  Mixed builds. A request says it wants its answer by query (replyBy); one
  that doesn't (a client of 1.7.0, not reloaded) is answered on the socket
  as before as well. A GM of 1.7.0 answers every query with true and the
  rest on the socket: a client hearing true takes that request's answer
  from the socket after all (heardOnSocket keeps what came meanwhile).

  Messages (requests by REQUEST_QUERY to the active GM, the rest on SOCKET):
    { type: "pull", requestId, boxId, actorId, userId, price }
                                                           player -> GM; price is
                                                           the one on the Buy pressed
                                                           (optional: an older client
                                                           sends none)
    { type: "ack", requestId, userId, hidden: true }       GM -> the buyer, only
                                                           when the GM's tab is hidden
                                                           and the pull is already slow
    { type: "reveal", requestId, itemId, itemUuid, itemIds, itemUuids, logId, purse, ... }
                                                           GM -> everyone; itemIds and
                                                           itemUuids every item the
                                                           play granted, itemId and
                                                           itemUuid the first. The
                                                           buyer's own comes as the
                                                           query's answer (with `sold`)
    { type: "redeem", requestId, actorId, itemId, userId } player -> GM: play the
                                                           ticket itemId on that
                                                           character (a sheet's Use,
                                                           tickets.js); answered as a
                                                           pull is
    { type: "keep", requestId, boxId, actorId, userId, price }
                                                           player -> GM: Buy to keep,
                                                           a ticket to the game into
                                                           that character's pack
                                                           instead of a play now
    { type: "kept", requestId, userId, logId, itemId, ... }
                                                           the GM's answer: the
                                                           ticket is in the pack
    { type: "error", requestId, userId, message, stalePrice? }
                                                           the GM's answer: refused
    { type: "cancel", requestId, userId }                  the buyer -> GM, when
                                                           its wait timed out
    { type: "late", requestId, userId, boxName, got, actorName }
                                                           the GM's answer to a
                                                           cancel that came after
                                                           the charge
    { type: "stake", requestId, boxId, roundId, actorId, userId, price, bet }
                                                           player -> GM: a stake on
                                                           a table round (table.js);
                                                           answered with "staked"
                                                           (also to all, on SOCKET)
    { type: "staked", ... } and { type: "round", ... }     GM -> everyone; table.js
                                                           hears them (onTable)
    { type: "newDay", requestId, actorId, userId, at, owed? }
                                                           a player -> GM: that
                                                           character finished a
                                                           rest that starts a new
                                                           day (restCompleted); `at`
                                                           the world time it began;
                                                           owed: taken while no GM
                                                           was online (sendOwedRests)
    { type: "owedRests" }                                  GM -> everyone, at its
                                                           load: send the rests
                                                           taken while it was away
    { type: "newDayCounted", userId, actorId, at }         the GM's answer to a
                                                           newDay: counted (an owed
                                                           one is then forgotten)
    { type: "give", requestId, logId, itemId, targetId, userId }
    { type: "sell", requestId, logId, itemId, cp, userId } the winner -> GM, after the
                                                           reveal (handover.js): give
                                                           an item of the play to
                                                           another player's character,
                                                           or sell it back for cp
    { type: "parted", logId, userId, itemId, itemName, actorName, part }
                                                           the GM's answer to either,
                                                           and to everyone on SOCKET
                                                           (each open reveal of the
                                                           play says it; the winner's
                                                           own ignores the socket's)

  A buyer who gave up waiting (GM_TIMEOUT_MS) calls the purchase off, and the
  GM drops a request that is cancelled before it charges: otherwise a GM
  client slow past the timeout (measured live: 55 s with its tab in the
  background) charged a buyer who had been told it failed, and who may well
  have pressed Buy again. A cancel that arrives after the charge is too late
  to undo by itself: the reveal still reaches the buyer (the pull's own
  answer, which comes whenever the GM gets to it), who is told the crate
  opened after all, and the GM gets a notice naming the buyer, the
  crate and the item, with the log row marked, so the GM can refund it from
  the Pull log if the table would rather (lateCancel below). Nothing is
  refunded automatically: the buyer may be glad of the item.

  The GM client runs pulls one at a time, through the same queue refunds use
  (store.js enqueueWrite): every store write is a read-modify-write across
  awaits, so two requests arriving together would both see the same stock,
  purse and log. The queue is per GM client; a second GM is already excluded
  by `isActiveGM`. Only the writes are queued: the reveal window is not, since
  the spin takes 6 to 7 s to land, and a queue that waited on it would hold
  every later buyer behind each spin until their 30 s timeout fired while the
  GM still charged them.

  Every kind of game (kinds.js) comes through here the same way: the guards,
  the queue, the charge and payout (pull.js), the reveal broadcast and the
  log row are one copy; the kind adds its own fields to the reveal and the
  row (the crate: its odds, its item's rarity and pity bookkeeping).

  Before each roll the GM sweeps the game's pools for entries whose source is
  gone and flags them (store.js refreshMissing), so a dead item is taken out of
  the roll, the odds and the strip instead of failing after the buyer clicked.
  It reads only indexes already in memory (a few ms), never fetching one, so
  the first pull after a page load doesn't wait on the load sweep's index
  fetch; the drawn entry's own source is resolved by performPull either way,
  which re-rolls past a dead one, so a missing source is never drawn.

  The reveal goes out as soon as the coins are taken and the item granted;
  the pity state, stock and log row are written after it (together, still
  inside the queued task, so the next pull or refund reads them). Measured
  live, a pull on a responsive GM client takes ~0.3 s to the broadcast. What
  made players wait 20 s and more was a GM client too busy or throttled to
  run it: a browser slows a background tab's timers to once a second or once
  a minute, and every server round trip waits on one. A module can't stop
  that, so when it happens the GM is told, and so is the buyer (the "ack"
  above). Only when it happens: measured live, a hidden GM tab ran a pull in
  264 ms, and a warning on every hidden pull was a false alarm. A pull is slow
  when its reveal goes out more than SLOW_PULL_MS after the request arrived.
*/
import { SOCKET, MODULE_ID } from "../core/config.js";
import { performPull, performStake, performKeep, PullError } from "./pull.js";
import { getKind, kindOf, gotText, nounText } from "../games/kinds.js";
import { getBoxes, getPools, getLog, getTally, getActorState, recordPlay, appendLog, updateLog, newId, isShopOpen, saveBox, enqueueWrite, refreshMissing, markMissing, reportMissing, todayKey, dayMode, countRest, restInto, dayAt, getRounds, saveRound } from "./store.js";
import { byRest } from "../core/clock.js";
import { formatPrice } from "../core/currency.js";
import { stakeReason, stakesOf } from "../core/round.js";
import { heard as tableHeard, closeStakes, watchTables } from "./table.js";
import { showReveal } from "./reveal.js";
import { postPullCard, postKeptCard } from "./chat.js";
import { ticketToRedeem } from "./tickets.js";
import { keepRow } from "../games/ticket.js";
import { t, onStrings } from "../core/i18n.js";
import { doGive, doSell, tellParted } from "./handover.js";

export const GM_TIMEOUT_MS = 30000;
// After this long without a reveal, the buyer's shop says it is waiting on
// the GM rather than showing an unchanging "Opening…".
export const WAIT_NOTICE_MS = 1500;
// A pull slower than this on the GM (request in to reveal out) is worth
// telling the GM about; a responsive client takes ~0.3 s.
export const SLOW_PULL_MS = 2000;
export let TIMED_OUT = "";
// A give or a sell after the reveal isn't a purchase: its own sentence.
export let TIMED_OUT_PART = "";
onStrings(() => {
  TIMED_OUT = t("LOOTCRATES.Error.TimedOut");
  TIMED_OUT_PART = t("LOOTCRATES.After.TimedOut");
});

// Only the request's own sender can call it off: a cancel from anyone else
// (who might have learned the id from the reveal) is refused and logged.
// A cancel after the charge is answered with lateCancel's "late".
function cancelPull(msg) {
  const sale = charged.get(msg.requestId);
  if (sale) {
    if (sale.userId !== msg.userId) return refuseCancel(msg, sale.userId);
    return lateCancel(sale);
  }
  const had = cancelled.get(msg.requestId);
  if (had && had !== msg.userId) return refuseCancel(msg, had);
  cancelled.set(msg.requestId, msg.userId);
  if (cancelled.size > 200) cancelled.delete(cancelled.keys().next().value);
  return null;
}

function refuseCancel(msg, owner) {
  console.warn(`loot-crates | refused ${userName(msg.userId)}'s cancel of ${msg.requestId}, which ${userName(owner)} sent`);
  return null;
}

// True (and forgotten) when the buyer has called this request off: the
// cancel came from the same sender as the request.
function wasCancelled(msg) {
  if (!cancelled.has(msg.requestId) || cancelled.get(msg.requestId) !== msg.userId) return false;
  cancelled.delete(msg.requestId);
  console.warn(`loot-crates | ${msg.requestId} was called off by its buyer after ${GM_TIMEOUT_MS / 1000} s; not charged`);
  return true;
}

// A cancel that came in while the coins were being taken, from the buyer.
function cancelledMidway(msg) {
  if (msg.userId === game.user.id || cancelled.get(msg.requestId) !== msg.userId) return false;
  cancelled.delete(msg.requestId);
  return true;
}

const userName = id => game.users?.get?.(id)?.name ?? id ?? "someone";

// The buyer's unanswered requests: requestId -> { resolve, reject, timer, slow, onWait, waited, hidden }.
const pending = new Map();
// The GM's side: requests their buyer has called off, requestId -> who
// called it off (insertion-ordered, capped).
const cancelled = new Map();
// The GM's side: requests already charged, so a cancel for one is too late
// (requestId -> what lateCancel names; insertion-ordered, capped).
const charged = new Map();

function rememberCharge(msg, sale) {
  charged.set(msg.requestId, { ...sale, requestId: msg.requestId, userId: msg.userId, byQuery: byQuery(msg) });
  if (charged.size > 200) charged.delete(charged.keys().next().value);
  return charged.get(msg.requestId);
}

// What a charged request's answer carries, so a buyer who had given up on
// it can be told what it came to (openedAfterAll).
const soldOf = sale => ({ boxName: sale.boxName, actorName: sale.actorName, got: sale.got ?? null });

// A request whose client takes its answer from the query (replyBy, 1.8.0
// on). One without (a 1.7.0 client not reloaded) listens on the socket, so
// it is answered there too, as that build was.
export const BY_QUERY = "query";
const byQuery = msg => msg?.replyBy === BY_QUERY;
function oldReply(msg, payload) {
  if (byQuery(msg) || !msg?.userId || msg.userId === game.user.id) return;
  game.socket.emit(SOCKET, { ...payload, requestId: msg.requestId, userId: msg.userId });
}

/*
  The buyer called off a pull this client had already charged (their wait ran
  out while it was running). The sale stands, once: nothing is charged or
  granted again. The GM is told who, what and where to undo it, the log row
  is marked so it can be found, and the buyer, if still here, is told the
  crate opened after all: "late" is the cancel's answer (and the pull's own
  answer, when it reaches a buyer who gave up, says it too). The mark goes
  through the write queue, so it lands after the pull has written its row
  even when the cancel arrives mid-pull. Resolves with "late" once marked.
*/
function lateCancel(sale) {
  if (!sale) return null;
  const { requestId, userId, buyerName, actorName, boxName, got, logId } = sale;
  const late = { type: "late", requestId, userId, boxName, got, actorName };
  if (sale.late) return Promise.resolve(late);
  sale.late = true;
  console.warn(`loot-crates | ${buyerName} called off ${requestId} after ${actorName} was charged for ${boxName}; the sale stands`);
  globalThis.ui?.notifications?.warn(t("LOOTCRATES.Error.LateCancelGM", { buyer: buyerName, box: boxName, actor: actorName, got: got ?? t("LOOTCRATES.Common.GotNothing") }));
  if (!sale.byQuery) game.socket.emit(SOCKET, late);
  return enqueueWrite(() => updateLog(logId, { lateCancel: Date.now() }))
    .catch(err => console.error(`loot-crates | couldn't mark ${requestId}'s log row as called off`, err))
    .then(() => late);
}

// The buyer's side of lateCancel: their shop said the purchase was called
// off, so say plainly that it went through. `got` is the kind's own phrase
// (kinds.js gotText), since not every game opens or hands over an item.
function openedAfterAll(msg) {
  globalThis.ui?.notifications?.info(t("LOOTCRATES.Error.LateCancelBuyer", { box: msg.boxName, actor: msg.actorName, got: msg.got ?? t("LOOTCRATES.Common.GotNothing") }));
}
const uid = () => foundry.utils.randomID(12);

export function isActiveGM() {
  const gm = game.users.activeGM;
  return !!gm && gm.id === game.user.id;
}

// Answers one pending request (once) and clears its timeout, so a late reveal
// or error can't fire a stale rejection afterwards.
function settle(requestId, answer) {
  const entry = pending.get(requestId);
  if (!entry) return;
  pending.delete(requestId);
  clearTimeout(entry.timer);
  clearTimeout(entry.slow);
  answer(entry);
}

// The requests a player sends the GM, by REQUEST_QUERY only.
export const REQUEST_QUERY = `${MODULE_ID}.request`;
// The GM asks a request's named sender whether it sent it, when Foundry
// gives the query's handler no sender (senderOf).
export const SENT_QUERY = `${MODULE_ID}.sent`;
const REQUESTS = new Set(["pull", "redeem", "keep", "stake", "cancel", "newDay", "give", "sell"]);
export const isRequest = msg => REQUESTS.has(msg?.type);

export function registerSocket() {
  const queries = globalThis.CONFIG?.queries;
  if (queries) {
    queries[REQUEST_QUERY] = (data, context) => answerOf(data, context);
    // One yes per request id: a later ask (a replay of an id the reveal or
    // a slow-pull ack made public) gets no. Only the active GM asks it:
    // where Foundry names who asks (14 on), anyone else gets no, so another
    // player can't use up the one yes. With no name (13), as before.
    queries[SENT_QUERY] = (data, context) => {
      if (context?.user && context.user.id !== game.users?.activeGM?.id) return false;
      return sentHere.delete(data?.requestId);
    };
  }
  game.socket.on(SOCKET, msg => {
    if (isRequest(msg)) return isActiveGM() ? refuseUnsigned(msg) : null;
    const mine = !!msg?.userId && msg.userId === game.user.id;
    if (msg.type === "staked") {
      if (mine) heardOnSocket(msg);
      return tableHeard(msg);
    }
    if (msg.type === "round") return tableHeard(msg);
    if (msg.type === "owedRests" && !isActiveGM()) return sendOwedRests();
    if (msg.type === "ack" && mine) return heardFromGM(msg);
    // The reveal is everyone's to watch; the buyer's own is its answer.
    if (msg.type === "reveal") return mine ? heardOnSocket(msg) : showReveal(msg);
    // What became of an item after the reveal: everyone else's window says
    // it; the winner's own takes it from its answer (anyone can emit this).
    if (msg.type === "parted") return mine ? null : tellParted(msg);
    if (mine && SOCKET_ANSWERS.has(msg.type)) return heardOnSocket(msg);
    return null;
  });
}

/*
  The active GM's answer to REQUEST_QUERY (see the header): the request's
  own answer (the reveal, kept, staked, late, newDayCounted, or null for
  one called off before it charged), or a refusal as { type: "error",
  message, stalePrice? }. A pull's answer goes as soon as its reveal is
  out, not after the row is written, so the buyer hears it as soon as the
  table does. A client of 1.7.0 (no replyBy) is answered true, or with
  the thrown refusal, and gets the rest on the socket as it expects.
*/
export function answerOf(data, context = {}) {
  const answer = new Promise((resolve, reject) => {
    heardRequest(data, context, { early: resolve }).then(resolve, reject);
  });
  return answer.then(
    value => (byQuery(data) ? value ?? null : true),
    err => {
      if (!byQuery(data)) throw err;
      return refusalOf(err);
    });
}

export function refusalOf(err) {
  if (!(err instanceof PullError)) console.error("loot-crates | a request failed", err);
  const message = err instanceof PullError ? err.message : t("LOOTCRATES.Error.JammedGM", { noun: nounText("crate") });
  return { type: "error", message, ...(err?.stalePrice != null ? { stalePrice: err.stalePrice } : {}) };
}

/*
  The active GM's side of REQUEST_QUERY: the sender is Foundry's, the
  request is handled as that sender's, and a request naming anyone else is
  refused before anything is read or charged (the GM is told, the sender's
  query is refused with a plain sentence). Resolves with the request's
  answer once it is handled, rejects with its refusal; `early` is called
  with a pull's answer as soon as it has one (answerOf).
*/
export function heardRequest(data, context = {}, { early = null } = {}) {
  if (!isActiveGM()) return Promise.reject(new PullError(t("LOOTCRATES.Error.NoGM")));
  if (!isRequest(data)) return Promise.reject(new PullError(t("LOOTCRATES.Error.Reload")));
  // Foundry's sender is at hand: handled at once, so a request joins the
  // write queue in the order it arrived (as the socket's did).
  if (context?.user) return fromSender(data, context.user, context, early);
  return senderOf(data).then(sender => fromSender(data, sender, context, early));
}

function fromSender(data, sender, context, early = null) {
  if (!sender || (data.userId != null && data.userId !== sender.id)) {
    const claimed = userName(data.userId);
    const who = sender?.name ?? context?.user?.name ?? "someone";
    console.warn(`loot-crates | refused a ${data.type} from ${who} that named ${claimed} as its sender; nothing was charged`);
    if (data.type !== "cancel") globalThis.ui?.notifications?.warn(t("LOOTCRATES.Error.ForgedGM", { sender: who, claimed }));
    return Promise.reject(new PullError(t("LOOTCRATES.Error.NotSender")));
  }
  const msg = { ...data, userId: sender.id };
  if (msg.type === "pull" || msg.type === "redeem") return handlePull(msg, early);
  if (msg.type === "keep") return handleKeep(msg);
  if (msg.type === "stake") return handleStake(msg);
  if (msg.type === "cancel") return Promise.resolve(cancelPull(msg));
  if (msg.type === "give" || msg.type === "sell") return handlePart(msg);
  return heardNewDay(msg);
}

/*
  Who sent a query. Foundry 14 hands the handler the querying User
  (context.user, from the server). A build that doesn't is asked the long
  way: the named sender's own client is queried (which only it receives)
  whether it sent this request id, and only a yes makes it the sender.
*/
async function senderOf(data) {
  const named = game.users?.get?.(data?.userId);
  if (!named || named.id === game.user.id || !data?.requestId || typeof named.query !== "function") return null;
  try {
    return (await named.query(SENT_QUERY, { requestId: data.requestId }, { timeout: 5000 })) === true ? named : null;
  } catch {
    return null;
  }
}

// A request that came over the module socket, which can't say who sent it:
// a client running a build from before REQUEST_QUERY. Refused; the client
// it names is told to reload, on the socket, the only way that build
// hears (a real one is waiting on this id, a forged one's named player has
// no such request and ignores it, and a client of 1.8.0 on ignores the
// socket's word on its own requests).
function refuseUnsigned(msg) {
  console.warn(`loot-crates | refused a ${msg.type} that came over the socket naming ${userName(msg.userId)}; requests come by query now (an older client must reload)`);
  if (msg.requestId && msg.type !== "cancel" && msg.userId && msg.userId !== game.user.id) {
    game.socket.emit(SOCKET, { type: "error", requestId: msg.requestId, userId: msg.userId, message: t("LOOTCRATES.Error.Reload") });
  }
  return null;
}

// This client's own request ids (capped), so a GM asking "did you send
// this?" (senderOf) gets a yes only for one it did, and only once: the
// ask forgets it, so another player who learns the id afterwards (it rides
// the reveal and a slow pull's ack, which every client hears) can't send
// a pull or a cancel in this player's name with it. A cancel notes its id
// again.
const sentHere = new Set();
function noteSent(requestId) {
  if (!requestId) return;
  sentHere.add(requestId);
  if (sentHere.size > 200) sentHere.delete(sentHere.values().next().value);
}

/*
  A request to the active GM, by REQUEST_QUERY, asking for its answer by
  query (replyBy). Resolves with the GM's answer (true from a GM of 1.7.0,
  which answers on the socket); rejects with the GM's refusal, or at once
  when there is no GM or this user may not query (Foundry's Query Users
  permission, on for players by default).
*/
export function toGM(msg) {
  const gm = game.users.activeGM;
  if (!gm) return Promise.reject(new PullError(t("LOOTCRATES.Error.NoGM")));
  if (typeof gm.query !== "function" || game.user?.hasPermission?.("QUERY_USER") === false) return Promise.reject(new PullError(t("LOOTCRATES.Error.NoQuery")));
  noteSent(msg.requestId);
  return gm.query(REQUEST_QUERY, { ...msg, replyBy: BY_QUERY });
}

// toGM, with the GM's { type: "error" } answer as the rejection it stands for.
function ask(msg) {
  return toGM(msg).then(answer => (answer?.type === "error" ? Promise.reject(refusalFrom(answer)) : answer));
}
const refusalFrom = answer => new PullError(answer?.message || TIMED_OUT, { stalePrice: answer?.stalePrice ?? null });

/*
  The socket's word on this client's own requests: never taken while the
  query can answer (anyone can send it), only kept in case the GM turns out
  to be a 1.7.0 one, whose query says true and whose answer is this. An
  "error" never displaces an answer that came with it.
*/
const SOCKET_ANSWERS = new Set(["kept", "error", "late", "newDayCounted"]);
const oldAnswers = new Map(); // "late.<requestId>" / "rest.<actorId>" -> msg (capped)
function heardOnSocket(msg) {
  if (msg.type === "late") return keepOld(`late.${msg.requestId}`, msg);
  if (msg.type === "newDayCounted") return keepOld(`rest.${msg.actorId}`, msg);
  const entry = pending.get(msg.requestId);
  if (!entry) return null;
  if (entry.oldGM) return takeOld(msg);
  if (!entry.heard || msg.type !== "error") entry.heard = msg;
  return null;
}
function keepOld(key, msg) {
  oldAnswers.set(key, msg);
  if (oldAnswers.size > 50) oldAnswers.delete(oldAnswers.keys().next().value);
  return null;
}
function takeHeard(key) {
  const msg = oldAnswers.get(key) ?? null;
  oldAnswers.delete(key);
  return msg;
}

// A socket answer from a GM of 1.7.0, taken as that build meant it.
function takeOld(msg) {
  if (msg.type === "error") return settle(msg.requestId, p => p.reject(refusalFrom(msg)));
  if (msg.type === "reveal") showOwn(msg);
  return settle(msg.requestId, p => p.resolve(msg));
}

// The buyer's own reveal window, from the answer.
function showOwn(reveal) {
  showReveal(reveal).catch(err => console.error(`loot-crates | reveal failed`, err));
}

/*
  The GM's answer to one of this client's requests: a refusal ends the
  wait with its sentence; a reveal opens the buyer's window and ends it;
  kept or staked ends it. One that comes after the wait gave up (the GM
  got to it late) is said as lateCancel says it: it went through.
*/
function answered(msg, answer) {
  if (answer === true) {
    const entry = pending.get(msg.requestId);
    if (!entry) return null;
    entry.oldGM = true;
    return entry.heard ? takeOld(entry.heard) : null;
  }
  if (answer?.type === "error") return settle(msg.requestId, p => p.reject(refusalFrom(answer)));
  if (!answer) return settle(msg.requestId, p => p.reject(new PullError(TIMED_OUT)));
  if (answer.type === "reveal") showOwn(answer);
  if (pending.has(msg.requestId)) return settle(msg.requestId, p => p.resolve(answer));
  // A give or a sell the GM got to after the wait gave up: the winner's
  // window says what came of it after all (reveal.js partHeard).
  if (answer.type === "parted") return tellParted({ ...answer, own: true });
  return toldLate(msg.requestId, answer.sold);
}

// "It went through after all", once per request, whichever answer says it first.
const toldLateIds = new Set();
function toldLate(requestId, info) {
  if (!info || toldLateIds.has(requestId)) return null;
  toldLateIds.add(requestId);
  if (toldLateIds.size > 200) toldLateIds.delete(toldLateIds.values().next().value);
  return openedAfterAll(info);
}

// The player's side. Resolves on the GM's answer (the reveal, which opens
// this client's window), rejects on the GM's refusal or after GM_TIMEOUT_MS.
// `onWait(why)` is told when the wait gets long: "gm" after WAIT_NOTICE_MS,
// then "hidden" if the GM's client says its tab is in the background.
// `price` is the one the buyer saw on the Buy: the GM charges that or nothing.
export function requestPull({ boxId, actorId, price }, { onWait = null } = {}) {
  if (!game.users.activeGM) return Promise.reject(new PullError(t("LOOTCRATES.Error.NoGM")));
  const msg = { type: "pull", requestId: uid(), boxId, actorId, userId: game.user.id };
  if (price != null) msg.price = price;
  return send(msg, handlePull, onWait);
}

// A ticket's Use (tickets.js ticketUseHook), the same way: the GM plays
// ticket `itemId` on that character through the same queue and core as a
// pull, spending one, and everyone sees the reveal.
export function requestRedeem({ actorId, itemId }, { onWait = null } = {}) {
  if (!game.users.activeGM) return Promise.reject(new PullError(t("LOOTCRATES.Ticket.NoGM")));
  const msg = { type: "redeem", requestId: uid(), actorId, itemId, userId: game.user.id };
  return send(msg, handlePull, onWait);
}

// Buy to keep (shop.js), the same way: resolves on the GM's "kept" answer,
// rejects on its refusal or after GM_TIMEOUT_MS (and the GM drops one
// called off before it charges). `price` is the one on the button pressed.
export function requestKeep({ boxId, actorId, price }, { onWait = null } = {}) {
  if (!game.users.activeGM) return Promise.reject(new PullError(t("LOOTCRATES.Error.NoGM")));
  const msg = { type: "keep", requestId: uid(), boxId, actorId, userId: game.user.id };
  if (price != null) msg.price = price;
  return send(msg, handleKeep, onWait);
}

// A stake on a table round (table.js), the same way: resolves on the GM's
// "staked" answer, rejects on its refusal or after GM_TIMEOUT_MS (and the
// GM drops a stake called off before it charges). `bet` is the kind's (a
// colour, a number, a bid); `price` what the player chose to stake.
export function requestStake({ boxId, roundId, actorId, price, bet = null }, { onWait = null } = {}) {
  if (!game.users.activeGM) return Promise.reject(new PullError(t("LOOTCRATES.Error.NoGM")));
  const msg = { type: "stake", requestId: uid(), boxId, roundId, actorId, userId: game.user.id, bet };
  if (price != null) msg.price = price;
  return send(msg, handleStake, onWait);
}

/*
  After the reveal (handover.js): the winner gives item `itemId` of the
  play `logId` to the character `targetId`, or sells it back for `cp`
  copper (the price on the button pressed; the GM refuses another). Each
  is a request by query like a pull, answered with { type: "parted", ...
  }, or refused with a plain sentence.
*/
export function requestGive({ logId, itemId, targetId }) {
  if (!game.users.activeGM) return Promise.reject(new PullError(t("LOOTCRATES.Error.NoGM")));
  return send({ type: "give", requestId: uid(), logId, itemId, targetId, userId: game.user.id }, handlePart, null);
}
export function requestSell({ logId, itemId, cp }) {
  if (!game.users.activeGM) return Promise.reject(new PullError(t("LOOTCRATES.Error.NoGM")));
  return send({ type: "sell", requestId: uid(), logId, itemId, cp, userId: game.user.id }, handlePart, null);
}

// The GM's side: in the write queue, dropped when the winner called it off
// (their wait ran out) before it ran. A failure that isn't a PullError is
// said as one.
function handlePart(msg) {
  return enqueueWrite(async () => {
    if (wasCancelled(msg)) return null;
    try {
      return await (msg.type === "give" ? doGive(msg) : doSell(msg));
    } catch (err) {
      if (err instanceof PullError) throw err;
      console.error(`loot-crates | a ${msg.type} after the reveal failed`, err);
      throw new PullError(t("LOOTCRATES.After.Failed"));
    }
  });
}

function send(msg, handle, onWait) {
  if (isActiveGM()) return handle(msg);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => settle(msg.requestId, p => {
      callOff(msg);
      p.reject(new PullError(msg.type === "give" || msg.type === "sell" ? TIMED_OUT_PART : TIMED_OUT));
    }), GM_TIMEOUT_MS);
    const entry = { resolve, reject, timer, onWait, waited: false, hidden: false, oldGM: false, heard: null };
    entry.slow = setTimeout(() => {
      entry.waited = true;
      tellWait(entry);
    }, WAIT_NOTICE_MS);
    pending.set(msg.requestId, entry);
    // The GM's answer, or its refusal (or no way to ask), ends the wait.
    toGM(msg).then(
      answer => answered(msg, answer),
      err => settle(msg.requestId, p => p.reject(err instanceof PullError ? err : new PullError(err?.message || TIMED_OUT))));
  });
}

// The wait ran out: the purchase is called off, and a GM that had already
// charged it answers "late" (a GM of 1.7.0 said it on the socket).
function callOff(msg) {
  const { requestId, userId } = msg;
  toGM({ type: "cancel", requestId, userId })
    .then(answer => {
      const heard = takeHeard(`late.${requestId}`);
      return toldLate(requestId, answer === true ? heard : answer?.type === "late" ? answer : null);
    })
    .catch(err => console.warn(`loot-crates | calling off ${requestId} failed`, err));
}

function tellWait(entry) {
  try { entry.onWait?.(entry.hidden ? "hidden" : "gm"); } catch (err) { console.error(`loot-crates | wait notice failed`, err); }
}

// The GM's client said its tab is hidden: say why once the wait is long
// (at once if it already is).
function heardFromGM(msg) {
  const entry = pending.get(msg.requestId);
  if (!entry || !msg.hidden) return;
  entry.hidden = true;
  if (entry.waited) tellWait(entry);
}

export function gmTabHidden() {
  return globalThis.document?.visibilityState === "hidden";
}

// Tells a waiting buyer the GM's tab is in the background, once per pull and
// only once the pull is already slow: on a responsive client the reveal
// follows within a second, and an extra message first would only delay it.
// Never after the reveal has gone out (sent.ack is set then).
function ackIfSlow(msg, timer, sent) {
  if (sent.ack || msg.userId === game.user.id || !gmTabHidden() || timer.elapsed() <= SLOW_PULL_MS) return;
  sent.ack = true;
  game.socket.emit(SOCKET, { type: "ack", requestId: msg.requestId, userId: msg.userId, hidden: true });
}

/*
  Checks for the ack on a timer from the moment the request arrives, as well
  as between doPull's steps: a pull can sit for many seconds inside one step
  (a throttled tab's server round trip) or in the queue behind another pull,
  and a check at the step's end comes with the reveal, too late to tell the
  buyer anything. A hidden tab runs this timer late too (about once a second),
  which is still seconds sooner than the step. Returns the stop function.
*/
function watchForSlow(msg, timer, sent) {
  if (msg.userId === game.user.id) return () => {};
  let handle = null;
  const check = () => {
    ackIfSlow(msg, timer, sent);
    // Not slow-and-hidden yet (the tab may be hidden later): look again.
    if (!sent.ack) handle = setTimeout(check, 1000);
  };
  handle = setTimeout(check, SLOW_PULL_MS + 1);
  return () => { sent.ack = true; clearTimeout(handle); };
}

// The GM hears about a slow pull once per session, with its time, in a toast
// that goes away by itself: it is advice, not an error to dismiss.
let warnedSlow = false;
function warnIfSlow(ms, { hidden, buyer, noun = "crate" }) {
  if (ms <= SLOW_PULL_MS) return;
  const secs = (ms / 1000).toFixed(1);
  console.warn(`loot-crates | ${buyer}'s ${noun} took ${secs} s to open on this client${hidden ? " (tab in the background)" : ""}`);
  if (warnedSlow) return;
  warnedSlow = true;
  globalThis.ui?.notifications?.warn(t(hidden ? "LOOTCRATES.Error.SlowHidden" : "LOOTCRATES.Error.Slow", { buyer, noun: nounText(noun), secs }));
}

// For tests: a new session.
export function _resetSlowWarning() { warnedSlow = false; }

// The GM's side. Pulls run strictly one after another, whether they came over
// the socket or from this client's own shop, so stock, purse, state and log
// are read after the previous pull (or refund) has finished writing.
function handlePull(msg, early = null) {
  const timer = stepTimer(`pull ${msg.requestId}`);
  const sent = { ack: false };
  const stop = watchForSlow(msg, timer, sent);
  return enqueueWrite(() => doPull(msg, timer, sent, stop, early)).finally(stop);
}

/*
  How long each step of a pull took on the GM, as one console.debug line
  (Chrome shows it under Verbose), so a slow purchase can be traced to its
  step on the client that did it: queue (waiting behind another write),
  then each step after.
*/
export function stepTimer(label) {
  const t0 = performance.now();
  let last = t0;
  const steps = [];
  return {
    mark(name) { const now = performance.now(); steps.push(`${name} ${Math.round(now - last)}`); last = now; },
    elapsed() { return performance.now() - t0; },
    done() { console.debug(`loot-crates | ${label} timings (ms): ${steps.join(", ")}, total ${Math.round(performance.now() - t0)}`); },
  };
}

/*
  The table's side of a pull: open the reveal here too, and post the chat
  card. The card goes out with the result, not after this client's own spin:
  a GM whose tab is hidden runs no animation frames, so waiting on its spin
  held the card from the whole table until the GM came back. Neither is
  awaited by the caller: the writes are done, the next pull can start.
*/
function showAndPost(reveal) {
  showReveal(reveal).catch(err => console.error(`loot-crates | reveal failed`, err));
  postPullCard(reveal).catch(err => console.error(`loot-crates | chat card failed`, err));
}

// A failed sweep doesn't stop the sale: performPull still re-rolls past a
// source it can't resolve.
async function sweepBox(box) {
  try {
    reportMissing(await refreshMissing((box.pools ?? []).map(ref => ref.id), { cachedOnly: true }));
  } catch (err) {
    console.error(`loot-crates | checking ${box.name} for missing items failed`, err);
  }
}

/*
  The pull's bookkeeping, after the reveal: the row, the tallies it moves
  (core/tally.js), the buyer's state and the stock, in one write
  (store.js recordPlay). The coins are taken and the item is on the sheet
  by now, so a failure here is the GM's to fix (the buyer has their item);
  it is reported, not thrown back at the buyer as a failed purchase.
*/
async function recordPull({ box, actor, out, log, hidden = null }) {
  // A kind with no per-buyer state (nothing to count between plays) writes
  // none. A ticket was sold (or given) already: its play takes no stock.
  const stock = box.rules?.stock != null && !log.redeem ? Math.max(0, box.rules.stock - 1) : null;
  try {
    await recordPlay({ row: log, hidden, state: out.state ?? null, box, stock });
  } catch (err) {
    const got = out.result?.name ?? t("LOOTCRATES.Common.NothingWord");
    console.error(`loot-crates | recording ${actor.name}'s pull of ${got} from ${box.name} failed`, err);
    globalThis.ui?.notifications?.error(t("LOOTCRATES.Error.LogFailed", { actor: actor.name, got, box: box.name }));
  }
}

/*
  A pull row's items: itemIds, every item the play granted, which the
  refund removes together (refund.js grantedItems), and when there are
  several their names (itemNames), so a refund can name the one that is
  already gone; and what each was worth as granted (worth, pull.js), which
  a sell back after the reveal is paid from (handover.js). A play that
  granted nothing adds none of them.
*/
export function itemColumns(out) {
  const ids = out?.itemIds ?? [];
  if (!ids.length) return {};
  return { itemIds: [...ids], ...(ids.length > 1 ? { itemNames: [...(out.itemNames ?? [])] } : {}), ...(out.worth ? { worth: { ...out.worth } } : {}) };
}

async function doPull(msg, timer, sent, stopWatching, early = null) {
  timer.mark("queue");
  const hiddenAtStart = gmTabHidden();
  let box;
  try {
    if (wasCancelled(msg)) return null;
    // A redeem plays the ticket's game: the character's owner may use it
    // with the shop closed or the game off the shelf (it is in the pack).
    const redeem = msg.type === "redeem";
    const { actor, buyer } = redeem ? guardOwner(msg) : guardBuyer(msg);
    const ticket = redeem ? ticketToRedeem(actor, msg.itemId, getBoxes()) : null;
    box = ticket ? ticket.box : getBoxes()[msg.boxId];

    if (box) await sweepBox(box);
    timer.mark("sweep");
    ackIfSlow(msg, timer, sent);
    if (wasCancelled(msg)) return null;
    const state = getActorState(msg.actorId, box?.id ?? msg.boxId);
    const onMissing = async entry => {
      try {
        await markMissing(entry.poolId, [entry.uuid], true);
        reportMissing([{ poolId: entry.poolId, poolName: getPools()[entry.poolId]?.name ?? entry.poolId, uuid: entry.uuid, name: entry.name }]);
      } catch (err) { console.error(`loot-crates | could not flag ${entry.uuid} as missing`, err); }
    };
    // The tallies and the day reach the guards and the roll for anything
    // counted per character, per day or per roll (the limit per character,
    // the well's cap, a scratch roll, a deck's once cards; core/tally.js),
    // read here inside the queue so two quick buys can't both pass.
    const today = todayKey(actor.id);
    const out = await performPull({ box, pools: getPools(), actor, state, onMissing, expectedPrice: redeem ? undefined : msg.price, log: getLog(), tally: getTally(), today, ticket: ticket?.item ?? null });
    // What the reveal and the chat card say in place of the price.
    if (ticket) out.redeem = { itemName: ticket.row.itemName, paid: ticket.row.paid };
    const kind = getKind(out.kind);
    timer.mark("roll+grant");
    ackIfSlow(msg, timer, sent);

    // itemUuid is the granted copy on the sheet, which the reveal's Open item
    // and the chat card's link point at (the pool's source is r.result.uuid).
    // logId is the row written below, so the chat card can be refunded.
    const itemUuids = (out.itemIds ?? []).map(id => `Actor.${actor.id}.Item.${id}`);
    const itemUuid = out.itemId ? `Actor.${actor.id}.Item.${out.itemId}` : null;
    const logId = newId();
    // Charged now: a cancel from here on is too late to drop the pull.
    const sale = rememberCharge(msg, { buyerName: buyer.name, actorName: actor.name, boxName: box.name, got: gotText(kind, out), logId });
    // What every reveal carries, then what this kind adds (the crate: the
    // odds this roll was made at and the buyer's state before it, which a
    // client whose spin is still playing holds its shop at; reveal.js
    // heldState). stateBefore defaults to the state as read, since the new
    // one is written just after this and would tell the result early.
    const ctx = { game: box, pools: out.pools, state, out };
    // box.price is what this play cost (pull.js: the record's, or the
    // kind's for this play), so the head and the row say what was paid.
    const reveal = { ...out, type: "reveal", requestId: msg.requestId, userId: msg.userId, kind: out.kind, actorId: actor.id, actorName: actor.name, box: { id: box.id, name: box.name, price: out.price }, result: out.result, purse: out.purse, itemId: out.itemId, itemUuid, itemIds: out.itemIds ?? [], itemUuids, logId, stateBefore: { ...state }, ...(kind.revealExtra?.(ctx) ?? {}) };
    delete reveal.grant;
    delete reveal.state;
    delete reveal.pools;
    stopWatching();
    game.socket.emit(SOCKET, reveal);
    // The buyer's answer, now: its query needn't wait on the row.
    const answer = { ...reveal, sold: soldOf(sale) };
    early?.(answer);
    timer.mark("broadcast");
    // A cancel that came in while the coins were being taken.
    if (cancelledMidway(msg)) lateCancel(charged.get(msg.requestId));
    warnIfSlow(timer.elapsed(), { hidden: hiddenAtStart || gmTabHidden(), buyer: actor.name, noun: kind.noun });
    showAndPost(reveal);

    // The row every kind writes, then the kind's own columns (the crate: the
    // item, its rarity and the pity bookkeeping a refund undoes). payoutCp
    // is what the game paid back in copper (negative: what it took beyond
    // the stake); rows from before it count as 0. `day` is the in-game day
    // it was bought on, which a limit per character per day counts
    // (limits.js); none in a world with no clock. itemId is the first
    // item, as rows from before several items read; itemColumns the rest.
    const log = { id: logId, kind: out.kind, boxId: box.id, boxName: box.name, actorId: actor.id, actorName: actor.name, userId: msg.userId, itemId: out.itemId, ...itemColumns(out), price: out.price, payoutCp: out.payoutCp, ...(today ? { day: today } : {}), ...(kind.logRow?.(ctx) ?? {}), ...(ticket ? { redeem: ticket.row } : {}) };
    // The kind's GM-only columns (the scratch ticket's tier) are kept off
    // the row, which every client reads (hidden.js).
    await recordPull({ box, actor, out, log, hidden: kind.hiddenRow?.(ctx) ?? null });
    timer.mark("record");
    return answer;
  } catch (err) {
    failPlay(msg, box, err);
  } finally {
    timer.done();
  }
}

/*
  A new day at a long rest. dnd5e fires restCompleted on the client that
  rested, with `newDay` set for a long rest unless the dialog's New day was
  unticked. The active GM notes it; anyone else asks the GM, who notes it
  only for a sender who owns the character. Noted how this world tells a
  day (clock.js): with dnd5e's calendar off, one more in the character's
  count of rests (store.js countRest); with it on, one more day on the
  character's own day, the clock catching up (store.js restInto, clock.js),
  since dnd5e moves the clock for a rest only on a GM's client and a
  player's own rest from the sheet would otherwise end nothing. The message carries the world time the rest began (restBegan),
  which the GM caps at its own clock.

  No GM online: only a GM client writes, so the player's client doesn't
  write the rest anywhere in the world. It keeps it in this browser's own
  storage (localStorage, per world and user: owedRests), and sends it when
  a GM is there to hear it: at this client's load if a GM is online, and
  when a GM's client loads and asks (settleOwedRests, main.js ready). The
  GM notes it as any rest, answers newDayCounted, and only then is it
  forgotten here, so a GM who drops it gets it again at its next load. A
  rest the GM couldn't be asked about (the query refused, or the GM gone
  between the look and the ask) is kept the same way, for the next GM. A
  rest kept by a browser the player never opens again with a GM online is
  lost, and that character's day ends at its next long rest instead.
  Several rests owed for one character are one: a day can only end once
  before the next throw.
*/
export function restCompleted(actor, result, config) {
  if (!actor?.id || !(result?.newDay ?? config?.newDay)) return null;
  const at = restBegan(config);
  if (isActiveGM()) return newDayFor(actor.id, at);
  if (!game.users.activeGM) {
    oweRest(actor.id, at);
    return null;
  }
  ask({ type: "newDay", requestId: uid(), actorId: actor.id, userId: game.user.id, ...(at != null ? { at } : {}) }).catch(err => {
    console.warn(`loot-crates | telling the GM of ${actor.name}'s new day failed; kept for the next GM`, err);
    oweRest(actor.id, at);
  });
  return null;
}

// When the rest began, in world seconds: on a GM's client with
// advanceTime, dnd5e has already moved the clock by the rest's duration
// (minutes) when the hook fires, so this goes back over it.
function restBegan(config) {
  const now = Number(game.time?.worldTime);
  if (!Number.isFinite(now)) return null;
  const minutes = Number(config?.duration);
  const moved = !!config?.advanceTime && minutes > 0 && !!game.user?.isGM;
  return moved ? now - 60 * minutes : now;
}

async function heardNewDay(msg) {
  const actor = game.actors.get(msg.actorId);
  const user = game.users.get(msg.userId);
  const owner = !!actor && !!user && actor.testUserPermission(user, "OWNER");
  if (owner) await newDayFor(actor.id, msg.at);
  // Answered whatever came of it, so an owed rest for a character since
  // deleted or given away isn't sent again at every load.
  const counted = { type: "newDayCounted", userId: msg.userId, actorId: msg.actorId, at: msg.at ?? null };
  if (msg.owed && !byQuery(msg)) game.socket.emit(SOCKET, counted);
  return counted;
}

function newDayFor(actorId, at) {
  const mode = dayMode();
  const failed = err => { console.error(`loot-crates | counting a new day for ${actorId} failed`, err); return null; };
  if (byRest(mode)) return countRest(actorId).catch(failed);
  if (mode !== "calendar") return null;
  const now = Number(game.time?.worldTime);
  const began = typeof at === "number" && Number.isFinite(at) ? (Number.isFinite(now) ? Math.min(at, now) : at) : now;
  const day = dayAt(began);
  return day ? restInto(actorId, day).catch(failed) : null;
}

// The rests this client owes the GM: { actorId: { at } }, in this browser
// for this world and user. Storage that throws (a private window) owes nothing.
const owedKey = () => `loot-crates.owedRests.${game.world?.id ?? "world"}.${game.user?.id ?? "user"}`;
export function owedRests() {
  try { return JSON.parse(globalThis.localStorage?.getItem(owedKey()) ?? "null") ?? {}; } catch { return {}; }
}
function saveOwed(owed) {
  try {
    if (Object.keys(owed).length) globalThis.localStorage?.setItem(owedKey(), JSON.stringify(owed));
    else globalThis.localStorage?.removeItem(owedKey());
  } catch { /* nothing kept: the day ends at the next rest a GM hears */ }
}
function oweRest(actorId, at) {
  const owed = owedRests();
  const was = owed[actorId]?.at;
  const fin = v => typeof v === "number" && Number.isFinite(v);
  owed[actorId] = { at: fin(was) && fin(at) ? Math.max(was, at) : fin(at) ? at : fin(was) ? was : null };
  saveOwed(owed);
}

/*
  Sends every owed rest to the active GM. Returns how many went. A rest sent
  and not yet answered isn't sent again within OWED_RESEND_MS: this client's
  own load and the GM's ask at its load can fall moments apart (both joining
  at a session's start), and the GM would hear one rest twice and end two
  days. A GM that dropped it still hears it again at its next ask.
*/
export const OWED_RESEND_MS = 30_000;
const owedSent = new Map(); // actorId -> { at, sentAt }
export function _resetOwedSent() { owedSent.clear(); }
export function sendOwedRests() {
  if (!game.users.activeGM || isActiveGM()) return 0;
  const now = Date.now();
  let sent = 0;
  for (const [actorId, { at = null } = {}] of Object.entries(owedRests())) {
    const last = owedSent.get(actorId);
    if (last && last.at === at && now - last.sentAt < OWED_RESEND_MS) continue;
    owedSent.set(actorId, { at, sentAt: now });
    ask({ type: "newDay", requestId: uid(), actorId, userId: game.user.id, at, owed: true }).then(
      answer => {
        const heard = takeHeard(`rest.${actorId}`);
        const counted = answer === true ? heard : answer;
        if (counted?.type === "newDayCounted") forgetOwedRest({ ...counted, actorId });
      },
      err => {
        // Still owed; sent again at the next ask, not held back by the resend window.
        if (owedSent.get(actorId)?.sentAt === now) owedSent.delete(actorId);
        console.warn(`loot-crates | sending an owed rest for ${actorId} failed; kept for the next GM`, err);
      });
    sent++;
  }
  return sent;
}

function forgetOwedRest(msg) {
  const owed = owedRests();
  if (!owed[msg.actorId] || (owed[msg.actorId].at ?? null) !== (msg.at ?? null)) return;
  delete owed[msg.actorId];
  owedSent.delete(msg.actorId);
  saveOwed(owed);
}

// At a client's load (main.js ready): the active GM asks every client for
// the rests it owes; anyone else sends its own if a GM is online to hear.
export function settleOwedRests() {
  if (isActiveGM()) {
    game.socket.emit(SOCKET, { type: "owedRests" });
    return 0;
  }
  return sendOwedRests();
}

// The shop is open and the buyer owns the character, checked on the GM
// inside the queue for every play (a pull or a stake). msg.userId is the
// sender Foundry named (heardRequest), or this GM's own.
function guardBuyer(msg) {
  if (!isShopOpen()) throw new PullError(t("LOOTCRATES.Shop.ClosedByGM"));
  const actor = game.actors.get(msg.actorId);
  const buyer = game.users.get(msg.userId);
  if (!actor || !buyer || !actor.testUserPermission(buyer, "OWNER")) throw new PullError(t("LOOTCRATES.Error.NotOwner"));
  return { actor, buyer };
}

// A ticket's Use: the user owns the character (a GM owns every one). The
// shop's switch is the shop's, not the pack's.
function guardOwner(msg) {
  const actor = game.actors.get(msg.actorId);
  const user = game.users.get(msg.userId);
  if (!actor || !user || !actor.testUserPermission(user, "OWNER")) throw new PullError(t("LOOTCRATES.Error.NotOwner"));
  return { actor, buyer: user };
}

// A play that failed: thrown back as a PullError with a plain sentence (its
// own, or that the game jammed), the GM's own play's and a player's query's
// refusal alike (answerOf), and said on the socket only to a client of
// 1.7.0. A stale price's refusal carries the price now, so the buyer's
// shop says it in its notice as it says one it caught itself.
function failPlay(msg, box, err) {
  const message = err instanceof PullError ? err.message : t("LOOTCRATES.Error.JammedGM", { noun: nounText(getKind(kindOf(box))?.noun ?? "crate") });
  if (!(err instanceof PullError)) console.error(`loot-crates | ${msg.type} failed`, err);
  oldReply(msg, { type: "error", message, ...(err?.stalePrice != null ? { stalePrice: err.stalePrice } : {}) });
  throw err instanceof PullError ? err : new PullError(message);
}

function handleKeep(msg) {
  const timer = stepTimer(`keep ${msg.requestId}`);
  const sent = { ack: false };
  const stop = watchForSlow(msg, timer, sent);
  return enqueueWrite(() => doKeep(msg, timer, sent, stop)).finally(stop);
}

/*
  Buy to keep, on the GM inside the write queue: the buyer's guards (the
  shop open, the character theirs), then the money path (pull.js
  performKeep: a purchase's guards, the charge through settle(), the ticket
  into the pack), and the log row in the same task, so the coins and the
  ticket are never without a row: a row that can't be written takes the
  ticket out and puts the coins back. The row is the game's (its kind, box
  and price, the day for a limit per day) with `keep` in place of a roll;
  no game counts it as a play (games/ticket.js isKept). Like a pull it
  takes one from the stock. No reveal: the buyer is answered ("kept", the
  query's answer) and the table gets a chat line.
*/
async function doKeep(msg, timer, sent, stopWatching) {
  timer.mark("queue");
  let box;
  try {
    if (wasCancelled(msg)) return null;
    const { actor, buyer } = guardBuyer(msg);
    box = getBoxes()[msg.boxId];
    const today = todayKey(actor.id);
    const out = await performKeep({ box, pools: getPools(), actor, state: getActorState(msg.actorId, msg.boxId), expectedPrice: msg.price, log: getLog(), tally: getTally(), today });
    timer.mark("charge");

    const logId = newId();
    const keep = keepRow({ item: out.item, paid: out.price });
    const row = { id: logId, kind: out.kind, boxId: box.id, boxName: box.name, actorId: actor.id, actorName: actor.name, userId: msg.userId, itemId: null, price: out.price, payoutCp: 0, name: t("LOOTCRATES.Keep.LogGot"), ...(today ? { day: today } : {}), keep };
    try {
      await appendLog(row);
    } catch (err) {
      console.error(`loot-crates | recording ${actor.name}'s ${box.name} ticket failed; taking it back and returning the coins`, err);
      try {
        await out.undo();
        await actor.update({ "system.currency": out.before });
      } catch (restoreErr) {
        console.error(`loot-crates | could not undo ${actor.name}'s ${box.name} ticket; the GM must take it back and return ${out.price} gp by hand`, restoreErr);
        throw new PullError(t("LOOTCRATES.Keep.FailedAndRestoreFailed"));
      }
      throw new PullError(t("LOOTCRATES.Keep.Failed"));
    }
    // The coins and the row are settled: a stock that can't be written is
    // reported for the GM to fix, never thrown back at the buyer.
    if (box.rules?.stock != null) {
      try { await saveBox({ ...box, rules: { ...box.rules, stock: Math.max(0, box.rules.stock - 1) } }); } catch (err) {
        console.error(`loot-crates | taking one from ${box.name}'s stock after ${actor.name}'s ticket failed`, err);
        globalThis.ui?.notifications?.error(t("LOOTCRATES.Error.LogFailed", { actor: actor.name, got: t("LOOTCRATES.Keep.LogGot"), box: box.name }));
      }
    }
    const sale = rememberCharge(msg, { buyerName: buyer.name, actorName: actor.name, boxName: box.name, got: t("LOOTCRATES.Keep.Got", { box: box.name }), logId });
    stopWatching();
    const kept = { type: "kept", requestId: msg.requestId, userId: msg.userId, logId, boxId: box.id, boxName: box.name, actorId: actor.id, actorName: actor.name, price: out.price, purse: out.purse, itemId: out.item.id, count: Math.max(1, Math.floor(Number(out.item.system?.quantity) || 1)), ...(out.priceNote ? { priceNote: out.priceNote } : {}) };
    oldReply(msg, kept);
    timer.mark("answer");
    if (cancelledMidway(msg)) lateCancel(charged.get(msg.requestId));
    postKeptCard(row).catch(err => console.error(`loot-crates | chat line for ${actor.name}'s ${box.name} ticket failed`, err));
    return { ...kept, sold: soldOf(sale) };
  } catch (err) {
    failPlay(msg, box, err);
  } finally {
    timer.done();
  }
}

function handleStake(msg) {
  const timer = stepTimer(`stake ${msg.requestId}`);
  const sent = { ack: false };
  const stop = watchForSlow(msg, timer, sent);
  return enqueueWrite(() => doStake(msg, timer, sent, stop)).finally(stop);
}

/*
  A stake, on the GM inside the write queue: the buyer's guards, the round's
  (open, this game's, before its clock runs out), then the money path
  (pull.js performStake: the price, the purse, the kind's check of the bet,
  the charge through settle()), and the open log row in the same task, so
  the coins are never without a row. A row that can't be written puts the
  coins back. Stakes the kind says this one displaces (an outbid) are
  refunded in the same task, and the round's clock is moved when the kind
  says so (the Auction's gavel, reset by each bid). Then everyone hears it
  ("staked", carrying the round as it now stands), and the bidder has it
  as the query's answer.
*/
async function doStake(msg, timer, sent, stopWatching) {
  timer.mark("queue");
  let box;
  try {
    if (wasCancelled(msg)) return null;
    const { actor, buyer } = guardBuyer(msg);
    box = getBoxes()[msg.boxId];
    let round = getRounds()[msg.roundId] ?? null;
    if (round && round.boxId !== msg.boxId) throw new PullError(t("LOOTCRATES.Error.OtherTable"));
    const why = stakeReason(round);
    if (why) throw new PullError(why);
    const log = getLog();
    const stakes = stakesOf(log, round.id);
    const out = await performStake({ box, actor, round, bet: msg.bet ?? null, stakes, expectedPrice: msg.price, log, today: todayKey(actor.id) });
    timer.mark("charge");

    const logId = newId();
    const row = { id: logId, kind: out.kind, boxId: box.id, boxName: box.name, actorId: actor.id, actorName: actor.name, userId: msg.userId, itemId: null, price: out.price, payoutCp: 0, status: "open", roundId: round.id, stake: out.stake, name: out.stake.label ?? t("LOOTCRATES.Editor.Stake") };
    try {
      await appendLog(row);
    } catch (err) {
      console.error(`loot-crates | recording ${actor.name}'s stake at ${box.name} failed; returning the coins`, err);
      try { await actor.update({ "system.currency": out.before }); } catch (restoreErr) {
        console.error(`loot-crates | could not return ${out.price} gp to ${actor.name}; the GM must refund by hand`, restoreErr);
        throw new PullError(t("LOOTCRATES.Error.StakeAndRestoreFailed"));
      }
      throw new PullError(t("LOOTCRATES.Error.StakeFailed"));
    }
    const sale = rememberCharge(msg, { buyerName: buyer.name, actorName: actor.name, boxName: box.name, got: t("LOOTCRATES.Error.Staked", { price: formatPrice(out.price) }), logId });
    const displaced = stakes.filter(r => out.outbid.includes(r.id) && r.status === "open");
    if (displaced.length) await closeStakes(displaced.map(r => ({ row: r, action: r.house || game.actors.get(r.actorId) ? "refund" : "void", reason: "outbid", payoutCp: 0 })));
    // The coins and the row are settled by now: a clock that can't be
    // moved is reported, never thrown back at the bidder.
    if (out.closesIn != null) {
      try { round = await saveRound({ ...round, closesAt: Date.now() + out.closesIn }); } catch (err) { console.error(`loot-crates | moving the clock at ${box.name} after ${actor.name}'s stake failed`, err); }
    }
    watchTables();

    stopWatching();
    const staked = { type: "staked", requestId: msg.requestId, userId: msg.userId, roundId: round.id, boxId: box.id, logId, actorId: actor.id, actorName: actor.name, price: out.price, stake: out.stake, purse: out.purse, outbid: displaced.map(r => r.id), round };
    game.socket.emit(SOCKET, staked);
    timer.mark("broadcast");
    if (cancelledMidway(msg)) lateCancel(charged.get(msg.requestId));
    tableHeard(staked);
    return { ...staked, sold: soldOf(sale) };
  } catch (err) {
    failPlay(msg, box, err);
  } finally {
    timer.done();
  }
}
