/*
  Players can't deduct their own gold or pull from compendia, so a purchase is
  a request to the active GM's client, which does the pull and broadcasts the
  reveal to everyone. No GM online means the shop is closed.

  Messages on SOCKET:
    { type: "pull", requestId, boxId, actorId, userId }   player -> GM
    { type: "ack", requestId, userId, hidden: true }       GM -> the buyer, only
                                                           when the GM's tab is hidden
                                                           and the pull is already slow
    { type: "reveal", requestId, itemId, itemUuid, logId, purse, ... }  GM -> everyone
    { type: "error", requestId, userId, message }          GM -> the buyer
    { type: "cancel", requestId, userId }                  the buyer -> GM, when
                                                           its wait timed out
    { type: "late", requestId, userId, boxName, itemName, actorName }
                                                           GM -> the buyer, when
                                                           the cancel came after
                                                           the charge

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

  Before each roll the GM sweeps the box's pools for entries whose source is
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
import { performPull, PullError } from "./pull.js";
import { getBoxes, getPools, getActorState, setActorState, appendLog, updateLog, newId, isShopOpen, saveBox, enqueueWrite, refreshMissing, markMissing, reportMissing } from "./store.js";
import { showReveal } from "./reveal.js";
import { postPullCard } from "./chat.js";
import { shopOdds, resetsPity } from "./odds.js";

export const GM_TIMEOUT_MS = 30000;
// After this long without a reveal, the buyer's shop says it is waiting on
// the GM rather than showing an unchanging "Opening…".
export const WAIT_NOTICE_MS = 1500;
// A pull slower than this on the GM (request in to reveal out) is worth
// telling the GM about; a responsive client takes ~0.3 s.
export const SLOW_PULL_MS = 2000;
export const TIMED_OUT = "The GM didn't answer in time, so the purchase was called off. If a crate opens anyway, the GM had already started it.";

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
  const { requestId, userId, buyerName, actorName, boxName, itemName, logId } = sale;
  console.warn(`loot-crates | ${buyerName} called off ${requestId} after ${actorName} was charged for ${boxName}; the sale stands`);
  globalThis.ui?.notifications?.warn(`Loot Crates: ${buyerName} gave up waiting on ${boxName}, but ${actorName} had already been charged and got ${itemName}. To undo it, use Refund on the marked row in the Pull log.`);
  game.socket.emit(SOCKET, { type: "late", requestId, userId, boxName, itemName, actorName });
  return enqueueWrite(() => updateLog(logId, { lateCancel: Date.now() }))
    .catch(err => console.error(`loot-crates | couldn't mark ${requestId}'s log row as called off`, err));
}

// The buyer's side of lateCancel: their shop said the purchase was called
// off, so say plainly that it went through.
function openedAfterAll(msg) {
  globalThis.ui?.notifications?.info(`Your ${msg.boxName} opened after all: ${msg.actorName} got ${msg.itemName}. Ask the GM if you'd like it refunded.`);
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
    if (msg.type === "cancel" && isActiveGM()) return cancelPull(msg);
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
export function requestPull({ boxId, actorId }, { onWait = null } = {}) {
  if (!game.users.activeGM) return Promise.reject(new PullError("The shop is closed until a GM is online."));
  const msg = { type: "pull", requestId: uid(), boxId, actorId, userId: game.user.id };
  if (isActiveGM()) return handlePull(msg);
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
function warnIfSlow(ms, { hidden, buyer }) {
  if (ms <= SLOW_PULL_MS) return;
  const secs = (ms / 1000).toFixed(1);
  const why = hidden ? " while this Foundry tab was in the background. Browsers slow background tabs; keep this tab visible while players shop" : "";
  console.warn(`loot-crates | ${buyer}'s crate took ${secs} s to open on this client${hidden ? " (tab in the background)" : ""}`);
  if (warnedSlow) return;
  warnedSlow = true;
  globalThis.ui?.notifications?.warn(`Loot Crates: ${buyer}'s crate took ${secs} s to open${why}.`);
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
  const writes = [
    setActorState(msg.actorId, msg.boxId, out.state),
    appendLog(log),
  ];
  if (box.rules?.stock != null) writes.push(saveBox({ ...box, rules: { ...box.rules, stock: box.rules.stock - 1 } }));
  const failed = (await Promise.allSettled(writes)).filter(r => r.status === "rejected");
  if (!failed.length) return;
  for (const f of failed) console.error(`loot-crates | recording ${actor.name}'s pull of ${log.name} from ${box.name} failed`, f.reason);
  globalThis.ui?.notifications?.error(`Loot Crates: ${actor.name} got ${log.name} from ${box.name}, but the pull log, stock or pity count wasn't saved. Check the console.`);
}

async function doPull(msg, timer, sent, stopWatching) {
  timer.mark("queue");
  const hiddenAtStart = gmTabHidden();
  const reply = payload => {
    if (msg.userId === game.user.id) return;
    game.socket.emit(SOCKET, { ...payload, requestId: msg.requestId });
  };
  try {
    if (wasCancelled(msg)) return null;
    if (!isShopOpen()) throw new PullError("The GM has closed the shop.");
    const box = getBoxes()[msg.boxId];
    const actor = game.actors.get(msg.actorId);
    const buyer = game.users.get(msg.userId);
    if (!actor || !buyer || !actor.testUserPermission(buyer, "OWNER")) throw new PullError("You don't own that character.");

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
    const out = await performPull({ box, pools: getPools(), actor, state, onMissing });
    timer.mark("roll+grant");
    ackIfSlow(msg, timer, sent);

    // itemUuid is the granted copy on the sheet, which the reveal's Open item
    // and the chat card's link point at (the pool's source is r.result.uuid).
    // logId is the row written below, so the chat card can be refunded.
    const itemUuid = out.itemId ? `Actor.${actor.id}.Item.${out.itemId}` : null;
    const logId = newId();
    // Charged now: a cancel from here on is too late to drop the pull.
    rememberCharge(msg.requestId, { requestId: msg.requestId, userId: msg.userId, buyerName: buyer.name, actorName: actor.name, boxName: box.name, itemName: out.result.name, logId });
    // The odds are the ones this roll was made at: the buyer's state before
    // it, and the pools performPull drew from, so an entry that went missing
    // mid-pull isn't counted even if marking it in the setting failed.
    // stateBefore is the buyer's pity and owned record before this pull: a
    // client whose spin is still playing shows the shop from it until the
    // spin lands (reveal.js heldState), since the new state is written
    // just after this and would tell the result early.
    const reveal = { type: "reveal", requestId: msg.requestId, userId: msg.userId, actorId: actor.id, actorName: actor.name, box: { id: box.id, name: box.name, price: box.price }, odds: shopOdds(box, out.pools, state).rows.map(({ rarity, chance, label }) => ({ rarity, chance, label })), result: out.result, strip: out.strip, purse: out.purse, itemId: out.itemId, itemUuid, logId, stateBefore: { sinceRare: state.sinceRare ?? 0, owned: [...(state.owned ?? [])], pulls: state.pulls ?? 0 } };
    stopWatching();
    game.socket.emit(SOCKET, reveal);
    timer.mark("broadcast");
    // A cancel that came in while the coins were being taken.
    if (msg.userId !== game.user.id && cancelled.delete(msg.requestId)) lateCancel(charged.get(msg.requestId));
    warnIfSlow(timer.elapsed(), { hidden: hiddenAtStart || gmTabHidden(), buyer: actor.name });
    showAndPost(reveal);

    const log = { id: logId, boxId: box.id, boxName: box.name, actorId: actor.id, actorName: actor.name, userId: msg.userId, itemId: out.itemId, name: out.result.name, uuid: out.result.uuid, rarity: out.result.rarity, price: box.price, pity: out.result.pity, before: { sinceRare: state.sinceRare ?? 0, hadItem: (state.owned ?? []).includes(out.result.uuid) }, resetPity: resetsPity(box, out.result.rarity) };
    // Provenance for a GM-set rarity: the source's own, only when it differs.
    const src = out.sourceRarity ?? [];
    if (out.rarityOverride && !(src.length === 1 && src[0] === out.result.rarity)) log.sourceRarity = src;
    await recordPull({ msg, box, actor, out, log });
    timer.mark("record");
    return reveal;
  } catch (err) {
    const message = err instanceof PullError ? err.message : "The crate jammed. Check the GM's console.";
    if (!(err instanceof PullError)) console.error(`loot-crates | pull failed`, err);
    reply({ type: "error", userId: msg.userId, message });
    if (msg.userId === game.user.id) throw err instanceof PullError ? err : new PullError(message);
  } finally {
    timer.done();
  }
}
