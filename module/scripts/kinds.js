/*
  The games of chance this module runs, and what every one of them shares.

  A game record (the `boxes` setting) has a `kind`; a record with none is a
  crate, which is every record written before kinds existed, so settings keep
  their shape. The core does what every game does the same way, once:
    pull.js     the money path on the GM: the guards (gone, sold out, stale
                price, purse), the roll, the charge and payout through one
                settle(), the grant with its rollback
    socket.js   the request, the serial write queue, the ownership and
                cancel guards, the reveal broadcast, the log row
    refund.js   one refund for every kind: coins, item, stock, state, card
    reveal.js   one window, one hold: the sealed chat card, the hidden sheet
                row and the held shop odds until this client's reveal lands
  The kind supplies what differs, through the contract below. The crate
  (crate.js) is the first kind; the module API's registerKind lets another
  module add one.

  Contract (every field but roll is optional; the crate shows each):
    id            the value stored on the record as `kind`
    noun          what a player buys, for messages: "The crate jammed."
    roll(ctx)     GM side, before anything is charged, so a failed roll costs
                  nothing. ctx: { game, pools, actor, state, rng,
                  resolveSource, onMissing }. Resolves to the outcome:
                    result    what was won, { name, img, rarity?, ... }, or
                              null for nothing (a miss)
                    grant     Item data to create on the actor, or null
                    payoutCp  coins paid out, in copper (none when absent)
                    state     the buyer's state for this game after the play
                    pools     the pools it was finally rolled from
                  Anything else rides along into performPull's result and
                  the reveal broadcast (the crate's strip and provenance).
                  Throws a PullError for anything the buyer should be told.
    logRow(ctx)   the fields this kind adds to the pull log row, from
                  { game, state, out }; the core writes id, kind, boxId,
                  boxName, actorId, actorName, userId, itemId, price and
                  payoutCp.
    revealExtra(ctx) the fields this kind adds to the reveal broadcast,
                  from the same ctx (the crate: its odds ribbon and the
                  buyer's state before the pull, which the shop holds).
    undo(state, row, log) the buyer's state with the row undone, for a
                  refund; a kind without one leaves the state as it is.
    reveal        the window: { title, play(host, reveal, { sound,
                  pageHidden, onLand }) -> { play, skip, skipped,
                  reducedMotion }, result(reveal, { esc, canSee }) -> html,
                  sting(reveal), replayable }. play mounts the animation
                  and calls onLand once when the result is under the marker.
    chat          { card(reveal, { esc, itemLink }) -> html, or null for no
                  chat card }
    shop          { card(game, pools, ctx) -> html, reason(game, pools,
                  ctx) -> why it can't be bought or "" }; a kind without
                  these gets the crate's card and rules.
*/

// The error a player is shown, as one plain sentence. Here so a kind can
// throw it without importing the core (pull.js re-exports it).
export class PullError extends Error {}

export const DEFAULT_KIND = "crate";

const kinds = new Map();

// The kind a game record (or a reveal message, or a log row) is.
export function kindOf(record) {
  const k = record?.kind;
  return typeof k === "string" && k ? k : DEFAULT_KIND;
}

export function registerKind(kind) {
  if (!kind || typeof kind.id !== "string" || !kind.id) throw new Error("loot-crates | a kind needs an id");
  if (typeof kind.roll !== "function") throw new Error(`loot-crates | kind ${kind.id} needs a roll`);
  kinds.set(kind.id, kind);
  return kind;
}

export const getKind = id => kinds.get(id) ?? null;

export const kindIds = () => [...kinds.keys()];

// The kind of a record, or a PullError naming the game when this client
// doesn't know it (a record written by a newer module, or a kind whose
// module is off).
export function kindFor(record) {
  const id = kindOf(record);
  const kind = getKind(id);
  if (!kind) throw new PullError(`${record?.name ?? "That game"} is a kind of game (${id}) this client can't run.`);
  return kind;
}

// For tests: forget every kind but the ones given back.
export function _resetKinds(keep = []) {
  for (const id of [...kinds.keys()]) if (!keep.includes(id)) kinds.delete(id);
}
