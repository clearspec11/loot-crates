/*
  Undo one pull from the log, on a GM client: the coins go back in the same
  whole gp/sp/cp that charge() took, the granted item (and only that item) is
  removed, the box's stock goes back up by one, and the character's pity
  count and no-duplicates record for the box are put back as if the pull
  never happened (odds.js undoPull).

  Constraints this holds: a row refunds at most once (the row is marked before
  any write that could fail, and refunds run one at a time), and the only item
  it will ever delete is the one carrying this pull's own loot-crates flag.
  The pull's chat card is marked refunded in the same queued write, so chat,
  the log and the sheet agree, and the card stops linking a deleted item.
*/
import { refund } from "./currency.js";
import { getLog, updateLog, getBoxes, saveBox, enqueueWrite, getActorState, setActorState } from "./store.js";
import { undoPull } from "./odds.js";
import { findPullCard, isRefundedCard, refundedCardContent } from "./chatcard.js";

// The item this row granted, if the actor still has it. Matching on the
// sourceUuid flag written at grant time means a reused id, or an item the
// player added themselves, is never deleted.
export function grantedItem(row, actor) {
  const item = row.itemId ? actor?.items?.get(row.itemId) : null;
  if (!item) return null;
  const flag = item.flags?.["loot-crates"];
  return flag?.sourceUuid === row.uuid ? item : null;
}

// What a refund of this row would do, for the confirm dialog. Writes nothing.
// status: "ready" | "already" | "missing" | "no-actor"
export function describeRefund(rowId) {
  const row = getLog().find(r => r.id === rowId);
  if (!row) return { status: "missing", message: "That pull is no longer in the log." };
  if (row.refunded) return { status: "already", row, message: "That pull was already refunded." };
  const actor = game.actors.get(row.actorId);
  if (!actor) return { status: "no-actor", row, message: "That character is gone." };
  return { status: "ready", row, actor, item: grantedItem(row, actor), box: getBoxes()[row.boxId] ?? null, state: stateAfter(row) };
}

// The buyer's state for the row's box now, and with the row undone.
function stateAfter(row) {
  const before = getActorState(row.actorId, row.boxId);
  return { before, after: undoPull(before, row, getLog()) };
}

// Refunds run strictly one after another, in the same queue as pulls, so two
// clicks on the same row, two rows for one actor, or a refund landing while
// that actor's purchase is being charged never read the same purse or stock.
export function refundPull(rowId) {
  return enqueueWrite(() => doRefund(rowId));
}

async function doRefund(rowId) {
  const plan = describeRefund(rowId);
  if (plan.status !== "ready") return plan;
  const { row, actor, item, box } = plan;

  // Marked first: if a later write throws, a retry can't pay twice. A refund
  // that failed halfway is visible in the console and the row says refunded.
  const refunded = Date.now();
  await updateLog(row.id, { refunded });

  const purse = refund(actor.system?.currency ?? {}, row.price);
  await actor.update({ "system.currency": purse });

  let removedItem = null;
  if (item) {
    await item.delete();
    removedItem = item.name;
  }

  let stock = null;
  if (box?.rules?.stock != null) {
    stock = box.rules.stock + 1;
    await saveBox({ ...box, rules: { ...box.rules, stock } });
  }

  // Read again here, inside the queue, after the row is marked: the shop's
  // pills and pity line redraw from this write (redraw.js).
  // A deleted box has no shop to correct. The coins and the item are back
  // by now, so a failed write is reported for the GM to fix, not thrown:
  // the card is still marked and the manager still posts the refund.
  let state = null;
  if (box) {
    const next = stateAfter(row);
    try {
      await setActorState(row.actorId, row.boxId, next.after);
      state = next;
    } catch (err) {
      console.error(`loot-crates | could not put back ${row.actorName}'s pity count and no-duplicates record for ${row.boxName}`, err);
      globalThis.ui?.notifications?.error(`Loot Crates: ${row.name} was refunded, but ${row.actorName}'s pity count and no-duplicates record for ${row.boxName} weren't put back. Check the console.`);
    }
  }

  const card = await markPullCard({ ...row, refunded });
  return { status: "refunded", row, purse, removedItem, stock, state, card };
}

// Rewrites the card that announced this pull, once. The coins and the item
// are already settled, so a failed chat write is logged, not thrown: the
// refund happened either way. Returns whether a card was updated.
export async function markPullCard(row) {
  try {
    const msg = findPullCard(game.messages?.contents ?? [], row);
    if (!msg || isRefundedCard(msg.content)) return false;
    const content = refundedCardContent(msg.content, row, { esc: foundry.utils.escapeHTML });
    await msg.update({ content, "flags.loot-crates.refundedAt": row.refunded });
    return true;
  } catch (err) {
    console.error(`loot-crates | could not mark the chat card for ${row.name} refunded`, err);
    return false;
  }
}
