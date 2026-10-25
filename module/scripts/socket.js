/*
  Players can't deduct their own gold or pull from compendia, so a purchase is
  a request to the active GM's client, which does the pull and broadcasts the
  reveal to everyone. No GM online means the shop is closed.

  Messages on SOCKET:
    { type: "pull", requestId, boxId, actorId, userId, price }
                                                           player -> GM; price is
                                                           the one on the Buy pressed
                                                           (optional: an older client
                                                           sends none)
    { type: "ack", requestId, userId, hidden: true }       GM -> the buyer, only
                                                           when the GM's tab is hidden
                                                           and the pull is already slow
    { type: "reveal", requestId, itemId, itemUuid, logId, purse, ... }  GM -> everyone
    { type: "error", requestId, userId, message }          GM -> the buyer
    { type: "cancel", requestId, userId }                  the buyer -> GM, when
                                                           its wait timed out
    { type: "late", requestId, userId, boxName, got, actorName }
                                                           GM -> the buyer, when
                                                           the cancel came after
                                                           the charge
    { type: "stake", requestId, boxId, roundId, actorId, userId, price, bet }
                                                           player -> GM: a stake on
                                                           a table round (table.js);
                                                           answered with "staked"
                                                           (to all) or "error"
    { type: "staked", ... } and { type: "round", ... }     GM -> everyone; table.js
                                                           hears them (onTable)
    { type: "newDay", actorId, userId, at, owed? }         a player -> GM: that
                                                           character finished a
                                                           rest that starts a new
                                                           day (restCompleted); `at`
                                                           the world time it began;
                                                           owed: taken while no GM
                                                           was online (sendOwedRests)
    { type: "owedRests" }                                  GM -> everyone, at its
                                                           load: send the rests
                                                           taken while it was away
    { type: "newDayCounted", userId, actorId, at }         GM -> that player: an
                                                           owed rest is counted,
                                                           so it is forgotten

  A buyer who gave up waiting (GM_TIMEOUT_MS) calls the purchase off, and the
  GM drops a request that is cancelled before it charges: otherwise a GM
  client slow past the timeout (measured live: 55 s with its tab in the
  background) charged a buyer who had been told it failed, and who may well
  have pressed Buy again. A cancel that arrives after the charge is too late
  to undo by itself: the reveal still reaches the buyer, who is told the
  crate opened after all, and the GM gets a notice naming the buyer, the
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
import { SOCKET } from "./config.js";
import { performPull, performStake, PullError } from "./pull.js";
import { getKind, kindOf, gotText, nounText } from "./kinds.js";
import { getBoxes, getPools, getLog, getActorState, setActorState, appendLog, updateLog, newId, isShopOpen, saveBox, enqueueWrite, refreshMissing, markMissing, reportMissing, todayKey, dayMode, countRest, restInto, dayAt, getRounds, saveRound } from "./store.js";
import { byRest } from "./clock.js";
import { formatPrice } from "./currency.js";
import { stakeReason, stakesOf } from "./round.js";
import { heard as tableHeard, closeStakes, watchTables } from "./table.js";
import { showReveal } from "./reveal.js";
import { postPullCard } from "./chat.js";
import { t, onStrings } from "./i18n.js";

export const GM_TIMEOUT_MS = 30000;
// After this long without a reveal, the buyer's shop says it is waiting on
// the GM rather than showing an unchanging "Opening…".
export const WAIT_NOTICE_MS = 1500;
// A pull slower than this on the GM (request in to reveal out) is worth
// telling the GM about; a responsive client takes ~0.3 s.
export const SLOW_PULL_MS = 2000;
export let TIMED_OUT = "";
onStrings(() => { TIMED_OUT = t("LOOTCRATES.Error.TimedOut"); });

function cancelPull(msg) {
  const sale = charged.get(msg.requestId);
  if (sale) return lateCancel(sale);
  cancelled.add(msg.requestId);
  if (cancelled.size > 200) cancelled.delete(cancelled.values().next().value);
}

// True (and forgotten) when the buyer has called this request off.
function wasCancelled(msg) {
  if (!cancelled.delete(msg.requestId)) return false;
  console.warn(`loot-crates | ${msg.requestId} was called off by its buyer after ${GM_TIMEOUT_MS / 1000} s; not charged`);
  return true;
}

// The buyer's unanswered requests: requestId -> { resolve, reject, timer, slow, onWait, waited, hidden }.
const pending = new Map();
// The GM's side: requests their buyer has called off (insertion-ordered, capped).
const cancelled = new Set();
// The GM's side: requests already charged, so a cancel for one is too late
// (requestId -> what lateCancel names; insertion-ordered, capped).
const charged = new Map();

function rememberCharge(requestId, sale) {
  charged.set(requestId, sale);
  if (charged.size > 200) charged.delete(charged.keys().next().value);
}

/*
  The buyer called off a pull this client had already charged (their wait ran
  out while it was running). The sale stands, once: nothing is charged or
  granted again. The GM is told who, what and where to undo it, the log row
  is marked so it can be found, and the buyer, if still here, is told the
  crate opened after all. The mark goes through the write queue, so it lands
  after the pull has written its row even when the cancel arrives mid-pull.
*/
function lateCancel(sale) {
  if (sale.late) return null;
  sale.late = true;
  const { requestId, userId, buyerName, actorName, boxName, got, logId } = sale;
  console.warn(`loot-crates | ${buyerName} called off ${requestId} after ${actorName} was charged for ${boxName}; the sale stands`);
  globalThis.ui?.notifications?.warn(t("LOOTCRATES.Error.LateCancelGM", { buyer: buyerName, box: boxName, actor: actorName, got: got ?? t("LOOTCRATES.Common.GotNothing") }));
  game.socket.emit(SOCKET, { type: "late", requestId, userId, boxName, got, actorName });
  return enqueueWrite(() => updateLog(logId, { lateCancel: Date.now() }))
    .catch(err => console.error(`loot-crates | couldn't mark ${requestId}'s log row as called off`, err));
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

export function registerSocket() {
  game.socket.on(SOCKET, msg => {
    if (msg.type === "pull" && isActiveGM()) return handlePull(msg);
    if (msg.type === "stake" && isActiveGM()) return handleStake(msg);
    if (msg.type === "staked") {
      if (msg.userId === game.user.id) settle(msg.requestId, p => p.resolve(msg));
      return tableHeard(msg);
    }
    if (msg.type === "round") return tableHeard(msg);
    if (msg.type === "cancel" && isActiveGM()) return cancelPull(msg);
    if (msg.type === "newDay" && isActiveGM()) return heardNewDay(msg);
    if (msg.type === "owedRests" && !isActiveGM()) return sendOwedRests();
    if (msg.type === "newDayCounted" && msg.userId === game.user.id) return forgetOwedRest(msg);
    if (msg.type === "ack" && msg.userId === game.user.id) return heardFromGM(msg);
    if (msg.type === "late" && msg.userId === game.user.id) return openedAfterAll(msg);
    if (msg.type === "reveal") {
      if (msg.userId === game.user.id) settle(msg.requestId, p => p.resolve(msg));
      return showReveal(msg);
    }
    if (msg.type === "error" && msg.userId === game.user.id) {
      settle(msg.requestId, p => p.reject(new PullError(msg.message)));
    }
  });
}

// The player's side. Resolves on the GM's reveal broadcast (the same message
// everyone else gets), rejects on the GM's error reply or after GM_TIMEOUT_MS.
// `onWait(why)` is told when the wait gets long: "gm" after WAIT_NOTICE_MS,
// then "hidden" if the GM's client says its tab is in the background.
// `price` is the one the buyer saw on the Buy: the GM charges that or nothing.
export function requestPull({ boxId, actorId, price }, { onWait = null } = {}) {
  if (!game.users.activeGM) return Promise.reject(new PullError(t("LOOTCRATES.Error.NoGM")));
  const msg = { type: "pull", requestId: uid(), boxId, actorId, userId: game.user.id };
  if (price != null) msg.price = price;
  return send(msg, handlePull, onWait);
}

// A stake on a table round (table.js), the same way: resolves on the GM's
// "staked" broadcast, rejects on its error or after GM_TIMEOUT_MS (and the
// GM drops a stake called off before it charges). `bet` is the kind's (a
// colour, a number, a bid); `price` what the player chose to stake.
export function requestStake({ boxId, roundId, actorId, price, bet = null }, { onWait = null } = {}) {
  if (!game.users.activeGM) return Promise.reject(new PullError(t("LOOTCRATES.Error.NoGM")));
  const msg = { type: "stake", requestId: uid(), boxId, roundId, actorId, userId: game.user.id, bet };
  if (price != null) msg.price = price;
  return send(msg, handleStake, onWait);
}

function send(msg, handle, onWait) {
  if (isActiveGM()) return handle(msg);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => settle(msg.requestId, p => {
      game.socket.emit(SOCKET, { type: "cancel", requestId: msg.requestId, userId: msg.userId });
      p.reject(new PullError(TIMED_OUT));
    }), GM_TIMEOUT_MS);
    const entry = { resolve, reject, timer, onWait, waited: false, hidden: false };
    entry.slow = setTimeout(() => {
      entry.waited = true;
      tellWait(entry);
    }, WAIT_NOTICE_MS);
    pending.set(msg.requestId, entry);
    game.socket.emit(SOCKET, msg);
  });
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
function handlePull(msg) {
  const timer = stepTimer(`pull ${msg.requestId}`);
  const sent = { ack: false };
  const stop = watchForSlow(msg, timer, sent);
  return enqueueWrite(() => doPull(msg, timer, sent, stop)).finally(stop);
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
  The pull's bookkeeping, after the reveal: three settings, each its own key,
  written together. The coins are taken and the item is on the sheet by now,
  so a failure here is the GM's to fix (the buyer has their item); it is
  reported, not thrown back at the buyer as a failed purchase.
*/
async function recordPull({ msg, box, actor, out, log }) {
  const writes = [appendLog(log)];
  // A kind with no per-buyer state (nothing to count between plays) writes none.
  if (out.state != null) writes.unshift(setActorState(msg.actorId, msg.boxId, out.state));
  if (box.rules?.stock != null) writes.push(saveBox({ ...box, rules: { ...box.rules, stock: Math.max(0, box.rules.stock - 1) } }));
  const failed = (await Promise.allSettled(writes)).filter(r => r.status === "rejected");
  if (!failed.length) return;
  const got = out.result?.name ?? t("LOOTCRATES.Common.NothingWord");
  for (const f of failed) console.error(`loot-crates | recording ${actor.name}'s pull of ${got} from ${box.name} failed`, f.reason);
  globalThis.ui?.notifications?.error(t("LOOTCRATES.Error.LogFailed", { actor: actor.name, got, box: box.name }));
}

async function doPull(msg, timer, sent, stopWatching) {
  timer.mark("queue");
  const hiddenAtStart = gmTabHidden();
  const reply = payload => {
    if (msg.userId === game.user.id) return;
    game.socket.emit(SOCKET, { ...payload, requestId: msg.requestId });
  };
  let box;
  try {
    if (wasCancelled(msg)) return null;
    const { actor, buyer } = guardBuyer(msg);
    box = getBoxes()[msg.boxId];

    if (box) await sweepBox(box);
    timer.mark("sweep");
    ackIfSlow(msg, timer, sent);
    if (wasCancelled(msg)) return null;
    const state = getActorState(msg.actorId, msg.boxId);
    const onMissing = async entry => {
      try {
        await markMissing(entry.poolId, [entry.uuid], true);
        reportMissing([{ poolId: entry.poolId, poolName: getPools()[entry.poolId]?.name ?? entry.poolId, uuid: entry.uuid, name: entry.name }]);
      } catch (err) { console.error(`loot-crates | could not flag ${entry.uuid} as missing`, err); }
    };
    // The log and the day reach the guards and the roll for anything
    // counted per character or per day (the limit per character, the
    // well's cap), read here inside the queue so two quick buys can't both
    // pass.
    const today = todayKey(actor.id);
    const out = await performPull({ box, pools: getPools(), actor, state, onMissing, expectedPrice: msg.price, log: getLog(), today });
    const kind = getKind(out.kind);
    timer.mark("roll+grant");
    ackIfSlow(msg, timer, sent);

    // itemUuid is the granted copy on the sheet, which the reveal's Open item
    // and the chat card's link point at (the pool's source is r.result.uuid).
    // logId is the row written below, so the chat card can be refunded.
    const itemUuid = out.itemId ? `Actor.${actor.id}.Item.${out.itemId}` : null;
    const logId = newId();
    // Charged now: a cancel from here on is too late to drop the pull.
    rememberCharge(msg.requestId, { requestId: msg.requestId, userId: msg.userId, buyerName: buyer.name, actorName: actor.name, boxName: box.name, got: gotText(kind, out), logId });
    // What every reveal carries, then what this kind adds (the crate: the
    // odds this roll was made at and the buyer's state before it, which a
    // client whose spin is still playing holds its shop at; reveal.js
    // heldState). stateBefore defaults to the state as read, since the new
    // one is written just after this and would tell the result early.
    const ctx = { game: box, pools: out.pools, state, out };
    // box.price is what this play cost (pull.js: the record's, or the
    // kind's for this play), so the head and the row say what was paid.
    const reveal = { ...out, type: "reveal", requestId: msg.requestId, userId: msg.userId, kind: out.kind, actorId: actor.id, actorName: actor.name, box: { id: box.id, name: box.name, price: out.price }, result: out.result, purse: out.purse, itemId: out.itemId, itemUuid, logId, stateBefore: { ...state }, ...(kind.revealExtra?.(ctx) ?? {}) };
    delete reveal.grant;
    delete reveal.state;
    delete reveal.pools;
    stopWatching();
    game.socket.emit(SOCKET, reveal);
    timer.mark("broadcast");
    // A cancel that came in while the coins were being taken.
    if (msg.userId !== game.user.id && cancelled.delete(msg.requestId)) lateCancel(charged.get(msg.requestId));
    warnIfSlow(timer.elapsed(), { hidden: hiddenAtStart || gmTabHidden(), buyer: actor.name, noun: kind.noun });
    showAndPost(reveal);

    // The row every kind writes, then the kind's own columns (the crate: the
    // item, its rarity and the pity bookkeeping a refund undoes). payoutCp
    // is what the game paid back in copper (negative: what it took beyond
    // the stake); rows from before it count as 0. `day` is the in-game day
    // it was bought on, which a limit per character per day counts
    // (limits.js); none in a world with no clock.
    const log = { id: logId, kind: out.kind, boxId: box.id, boxName: box.name, actorId: actor.id, actorName: actor.name, userId: msg.userId, itemId: out.itemId, price: out.price, payoutCp: out.payoutCp, ...(today ? { day: today } : {}), ...(kind.logRow?.(ctx) ?? {}) };
    await recordPull({ msg, box, actor, out, log });
    timer.mark("record");
    return reveal;
  } catch (err) {
    failPlay(msg, box, err, reply);
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
  game.socket.emit(SOCKET, { type: "newDay", actorId: actor.id, userId: game.user.id, ...(at != null ? { at } : {}) });
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
  // An owed rest is answered whatever came of it, so a character since
  // deleted or given away isn't sent again at every load.
  if (msg.owed) game.socket.emit(SOCKET, { type: "newDayCounted", userId: msg.userId, actorId: msg.actorId, at: msg.at ?? null });
  return null;
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
    game.socket.emit(SOCKET, { type: "newDay", actorId, userId: game.user.id, at, owed: true });
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
// inside the queue for every play (a pull or a stake).
function guardBuyer(msg) {
  if (!isShopOpen()) throw new PullError(t("LOOTCRATES.Shop.ClosedByGM"));
  const actor = game.actors.get(msg.actorId);
  const buyer = game.users.get(msg.userId);
  if (!actor || !buyer || !actor.testUserPermission(buyer, "OWNER")) throw new PullError(t("LOOTCRATES.Error.NotOwner"));
  return { actor, buyer };
}

// A play that failed: the buyer is told in a plain sentence (a PullError's
// own, or that the game jammed), and the GM's own play throws it back.
function failPlay(msg, box, err, reply) {
  const message = err instanceof PullError ? err.message : t("LOOTCRATES.Error.JammedGM", { noun: nounText(getKind(kindOf(box))?.noun ?? "crate") });
  if (!(err instanceof PullError)) console.error(`loot-crates | ${msg.type} failed`, err);
  reply({ type: "error", userId: msg.userId, message });
  if (msg.userId === game.user.id) throw err instanceof PullError ? err : new PullError(message);
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
  ("staked", carrying the round as it now stands).
*/
async function doStake(msg, timer, sent, stopWatching) {
  timer.mark("queue");
  const reply = payload => {
    if (msg.userId === game.user.id) return;
    game.socket.emit(SOCKET, { ...payload, requestId: msg.requestId });
  };
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
    rememberCharge(msg.requestId, { requestId: msg.requestId, userId: msg.userId, buyerName: buyer.name, actorName: actor.name, boxName: box.name, got: t("LOOTCRATES.Error.Staked", { price: formatPrice(out.price) }), logId });
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
    if (msg.userId !== game.user.id && cancelled.delete(msg.requestId)) lateCancel(charged.get(msg.requestId));
    tableHeard(staked);
    return staked;
  } catch (err) {
    failPlay(msg, box, err, reply);
  } finally {
    timer.done();
  }
}
