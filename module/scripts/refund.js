/*
  Undo one pull from the log, on a GM client, for every kind of game: the
  coins go back in the same whole gp/sp/cp that charge() took (less any
  payout the game made, taken back in the same move: currency.js settle),
  the granted item (and only that item) is removed, the box's stock goes
  back up by one, and the character's state for the game is put back as if
  the pull never happened (the kind's undo: the crate's pity count and
  no-duplicates record, odds.js undoPull).

  Winnings already spent can't come back: such a refund is refused before
  anything is marked, naming the shortfall, rather than minting coins or
  taking the purse below zero.

  Constraints this holds: a row refunds at most once (the row is marked before
  any write that could fail, and refunds run one at a time), and the only item
  it will ever delete is the one carrying this pull's own loot-crates flag.
  The pull's chat card is marked refunded in the same queued write, so chat,
  the log and the sheet agree, and the card stops linking a deleted item.
*/
import { settle, toCopper, formatPrice } from "./currency.js";
import { getLog, updateLog, getBoxes, saveBox, enqueueWrite, getActorState, setActorState } from "./store.js";
import { getKind, kindOf } from "./kinds.js";
// The crate registers itself when imported, so a row or record with no kind is found.
import "./crate.js";
import { findPullCard, isRefundedCard, refundedCardContent } from "./chatcard.js";

// What a refund of this row moves, in copper: the stake back, the payout
// taken back, and coins the game took beyond the stake (a negative payout,
// the deck's bane) given back too. Positive is paid to the character; a row
// from before payouts has none.
export function refundCoins(row) {
  return Math.round((Number(row?.price) || 0) * 100) - Math.round(Number(row?.payoutCp) || 0);
}

// How much of a row's winnings the character no longer has, in gp (0 when
// the refund can go ahead).
export function spentWinnings(row, actor) {
  const net = refundCoins(row);
  if (net >= 0) return 0;
  return Math.max(0, -net - toCopper(actor?.system?.currency ?? {})) / 100;
}

/*
  The plain sentence for a refund the purse can't cover: "Crate Tester has
  spent 40 gp of the 60 gp won at Live dice (30 gp of the 50 gp to take
  back is left). Nothing was refunded; refund it once the purse can cover
  it." Says what was won, what the refund would take back and what is
  missing, so the GM can top the purse up or wait, rather than the module
  minting coins or taking the purse below zero.
*/
export function shortMessage(row, actor) {
  const short = spentWinnings(row, actor);
  const take = -refundCoins(row) / 100;
  const won = Math.max(0, Math.round(Number(row?.payoutCp) || 0)) / 100;
  const have = Math.max(0, take - short);
  return `${actor.name} has spent ${formatPrice(short)} of the ${formatPrice(won)} won at ${row.boxName} (${formatPrice(have)} of the ${formatPrice(take)} to take back is left). Nothing was refunded; refund it once the purse can cover it.`;
}

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
// status: "ready" | "already" | "missing" | "no-actor" | "short"
// `coins` is what the character gets back, in copper (negative: gives back).
export function describeRefund(rowId) {
  const row = getLog().find(r => r.id === rowId);
  if (!row) return { status: "missing", message: "That pull is no longer in the log." };
  if (row.refunded) return { status: "already", row, message: "That pull was already refunded." };
  const actor = game.actors.get(row.actorId);
  if (!actor) return { status: "no-actor", row, message: "That character is gone." };
  const box = getBoxes()[row.boxId] ?? null;
  const short = spentWinnings(row, actor);
  if (short > 0) return { status: "short", row, actor, box, short, message: shortMessage(row, actor) };
  return { status: "ready", row, actor, item: grantedItem(row, actor), box, coins: refundCoins(row), state: stateAfter(row, box) };
}

// The buyer's state for the row's game now, and with the row undone the way
// its kind undoes one. The row names its kind; a row from before kinds, or
// one whose box is gone, is a crate's. A kind this client doesn't know, or
// one with no undo, leaves the state as it is.
function stateAfter(row, box) {
  const before = getActorState(row.actorId, row.boxId);
  const kind = getKind(kindOf(row.kind ? row : box ?? row));
  return { before, after: kind?.undo ? kind.undo(before, row, getLog()) : before };
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

  const purse = settle(actor.system?.currency ?? {}, plan.coins);
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
    const next = stateAfter(row, box);
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
