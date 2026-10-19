/*
  Players can't deduct their own gold or pull from compendia, so a purchase is
  a request to the active GM's client, which does the pull and broadcasts the
  reveal to everyone. No GM online means the shop is closed.

  Messages on SOCKET:
    { type: "pull", requestId, boxId, actorId, userId }   player -> GM
    { type: "reveal", requestId, itemId, itemUuid, purse, ... }  GM -> everyone
    { type: "error", requestId, userId, message }          GM -> the buyer

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
*/
import { SOCKET } from "./config.js";
import { performPull, PullError } from "./pull.js";
import { getBoxes, getPools, getActorState, setActorState, appendLog, isShopOpen, saveBox, enqueueWrite, refreshMissing, markMissing, reportMissing } from "./store.js";
import { showReveal } from "./reveal.js";
import { postPullCard } from "./chat.js";

export const GM_TIMEOUT_MS = 30000;

// The buyer's unanswered requests: requestId -> { resolve, reject, timer }.
const pending = new Map();
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
  answer(entry);
}

export function registerSocket() {
  game.socket.on(SOCKET, msg => {
    if (msg.type === "pull" && isActiveGM()) return handlePull(msg);
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
export function requestPull({ boxId, actorId }) {
  if (!game.users.activeGM) return Promise.reject(new PullError("The shop is closed until a GM is online."));
  const msg = { type: "pull", requestId: uid(), boxId, actorId, userId: game.user.id };
  if (isActiveGM()) return handlePull(msg);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => settle(msg.requestId, p => p.reject(new PullError("The GM didn't answer in time."))), GM_TIMEOUT_MS);
    pending.set(msg.requestId, { resolve, reject, timer });
    game.socket.emit(SOCKET, msg);
  });
}

// The GM's side. Pulls run strictly one after another, whether they came over
// the socket or from this client's own shop, so stock, purse, state and log
// are read after the previous pull (or refund) has finished writing.
function handlePull(msg) {
  return enqueueWrite(() => doPull(msg));
}

// The table's side of a pull: open the reveal here too, and post the chat
// card once the spin has landed so the log never spoils the result. Not
// awaited by the caller: the writes are done, the next pull can start.
function showAndPost(reveal) {
  showReveal(reveal)
    .then(app => app?.landed)
    .then(() => postPullCard(reveal))
    .catch(err => console.error(`loot-crates | reveal failed`, err));
}

// A failed sweep doesn't stop the sale: performPull still re-rolls past a
// source it can't resolve.
async function sweepBox(box) {
  try {
    reportMissing(await refreshMissing((box.pools ?? []).map(ref => ref.id)));
  } catch (err) {
    console.error(`loot-crates | checking ${box.name} for missing items failed`, err);
  }
}

async function doPull(msg) {
  const reply = payload => {
    if (msg.userId === game.user.id) return;
    game.socket.emit(SOCKET, { ...payload, requestId: msg.requestId });
  };
  try {
    if (!isShopOpen()) throw new PullError("The GM has closed the shop.");
    const box = getBoxes()[msg.boxId];
    const actor = game.actors.get(msg.actorId);
    const buyer = game.users.get(msg.userId);
    if (!actor || !buyer || !actor.testUserPermission(buyer, "OWNER")) throw new PullError("You don't own that character.");

    if (box) await sweepBox(box);
    const state = getActorState(msg.actorId, msg.boxId);
    const onMissing = async entry => {
      try {
        await markMissing(entry.poolId, [entry.uuid], true);
        reportMissing([{ poolId: entry.poolId, poolName: getPools()[entry.poolId]?.name ?? entry.poolId, uuid: entry.uuid, name: entry.name }]);
      } catch (err) { console.error(`loot-crates | could not flag ${entry.uuid} as missing`, err); }
    };
    const out = await performPull({ box, pools: getPools(), actor, state, onMissing });
    await setActorState(msg.actorId, msg.boxId, out.state);
    if (box.rules?.stock != null) await saveBox({ ...box, rules: { ...box.rules, stock: box.rules.stock - 1 } });
    const log = { boxId: box.id, boxName: box.name, actorId: actor.id, actorName: actor.name, userId: msg.userId, itemId: out.itemId, name: out.result.name, uuid: out.result.uuid, rarity: out.result.rarity, price: box.price, pity: out.result.pity };
    await appendLog(log);

    // itemUuid is the granted copy on the sheet, which the reveal's Open item
    // and the chat card's link point at (the pool's source is r.result.uuid).
    const itemUuid = out.itemId ? `Actor.${actor.id}.Item.${out.itemId}` : null;
    const reveal = { type: "reveal", requestId: msg.requestId, userId: msg.userId, actorId: actor.id, actorName: actor.name, box: { id: box.id, name: box.name, price: box.price }, result: out.result, strip: out.strip, purse: out.purse, itemId: out.itemId, itemUuid };
    game.socket.emit(SOCKET, reveal);
    showAndPost(reveal);
    return reveal;
  } catch (err) {
    const message = err instanceof PullError ? err.message : "The crate jammed. Check the GM's console.";
    if (!(err instanceof PullError)) console.error(`loot-crates | pull failed`, err);
    reply({ type: "error", userId: msg.userId, message });
    if (msg.userId === game.user.id) throw err instanceof PullError ? err : new PullError(message);
  }
}
