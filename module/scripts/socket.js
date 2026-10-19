/*
  Players can't deduct their own gold or pull from compendia, so a purchase is
  a request to the active GM's client, which does the pull and broadcasts the
  reveal to everyone. No GM online means the shop is closed.

  Messages on SOCKET:
    { type: "pull", requestId, boxId, actorId, userId }   player -> GM
    { type: "reveal", requestId, ... }                     GM -> everyone
    { type: "error", requestId, userId, message }          GM -> the buyer

  The GM client runs pulls one at a time (see `queue`): every store write is a
  read-modify-write across awaits, so two requests arriving together would
  both see the same stock, purse and log. The queue is per GM client; a second
  GM is already excluded by `isActiveGM`.
*/
import { SOCKET } from "./config.js";
import { performPull, PullError } from "./pull.js";
import { getBoxes, getPools, getActorState, setActorState, appendLog, isShopOpen, saveBox } from "./store.js";
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
// are read after the previous pull has finished writing.
let queue = Promise.resolve();
function handlePull(msg) {
  const run = queue.catch(() => {}).then(() => doPull(msg));
  queue = run;
  return run;
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

    const state = getActorState(msg.actorId, msg.boxId);
    const out = await performPull({ box, pools: getPools(), actor, state });
    await setActorState(msg.actorId, msg.boxId, out.state);
    if (box.rules?.stock != null) await saveBox({ ...box, rules: { ...box.rules, stock: box.rules.stock - 1 } });
    const log = { boxId: box.id, boxName: box.name, actorId: actor.id, actorName: actor.name, userId: msg.userId, itemId: out.itemId, name: out.result.name, uuid: out.result.uuid, rarity: out.result.rarity, price: box.price, pity: out.result.pity };
    await appendLog(log);

    const reveal = { type: "reveal", requestId: msg.requestId, userId: msg.userId, actorId: actor.id, actorName: actor.name, box: { id: box.id, name: box.name, price: box.price }, result: out.result, strip: out.strip, purse: out.purse };
    game.socket.emit(SOCKET, reveal);
    await showReveal(reveal);
    await postPullCard(reveal);
    return reveal;
  } catch (err) {
    const message = err instanceof PullError ? err.message : "The crate jammed. Check the GM's console.";
    if (!(err instanceof PullError)) console.error(`loot-crates | pull failed`, err);
    reply({ type: "error", userId: msg.userId, message });
    if (msg.userId === game.user.id) throw err instanceof PullError ? err : new PullError(message);
  }
}
