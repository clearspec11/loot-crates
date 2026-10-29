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
  any write that could fail, and refunds run one at a time), and the only
  items it will ever delete are the ones this pull granted, by the ids on
  its row and carrying this pull's own loot-crates flag. A play that granted
  several items (a kind's `grants`) is undone whole: every one still on the
  sheet goes, and each one already gone is named.
  The pull's chat card is marked refunded in the same queued write, so chat,
  the log and the sheet agree, and the card stops linking a deleted item.

  A play made with a ticket (its row's `redeem`, socket.js) cost no coins,
  so none come back for it: the ticket does (tickets.js returnTicket: one
  more on its stack, or made again from the row), and what the play won is
  taken back as any refund takes it. It took no stock, so it gives none.
*/
import { settle, toCopper, formatPrice } from "../core/currency.js";
import { getLog, updateLog, getBoxes, saveBox, enqueueWrite, getActorState, setActorState } from "./store.js";
import { getKind, kindOf } from "../games/kinds.js";
import { stockAfterRefund } from "../core/limits.js";
import { t, listAnd } from "../core/i18n.js";
// The crate registers itself when imported, so a row or record with no kind is found.
import "../games/crate.js";
import { findPullCard, isRefundedCard, refundedCardContent } from "../views/chatcard.js";
import { returnTicket } from "./tickets.js";

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
  return t("LOOTCRATES.Refund.Spent", { actor: actor.name, short: formatPrice(short), won: formatPrice(won), box: row.boxName, have: formatPrice(have), take: formatPrice(take) });
}

/*
  The items this row granted that the actor still has, and the names of
  the ones it no longer has: { items, gone }. A row names its items by
  itemIds; a row from before several items, by its one itemId. An item
  counts only while it carries the loot-crates flag written at grant time
  for this row's source (one item) or this row's game (several), so a
  reused id, or an item the player added themselves, is never deleted.
*/
export function grantedItems(row, actor) {
  const several = Array.isArray(row?.itemIds) && row.itemIds.length > 0;
  const ids = several ? row.itemIds : row?.itemId ? [row.itemId] : [];
  const items = [];
  const gone = [];
  ids.forEach((id, i) => {
    const item = actor?.items?.get(id);
    const flag = item?.flags?.["loot-crates"];
    // One item names its source on the row, as it always has; several
    // share the row, so each is matched on its game.
    const ours = several && ids.length > 1 ? flag?.boxId === row.boxId : flag?.sourceUuid === row.uuid;
    if (item && ours) items.push(item);
    else gone.push((ids.length > 1 ? row.itemNames?.[i] : null) ?? row.name);
  });
  return { items, gone };
}

// The first item this row granted, if the actor still has it.
export const grantedItem = (row, actor) => grantedItems(row, actor).items[0] ?? null;

// What a refund of this row would do, for the confirm dialog. Writes nothing.
// status: "ready" | "already" | "missing" | "no-actor" | "short"
// `coins` is what the character gets back, in copper (negative: gives back).
export function describeRefund(rowId) {
  const row = getLog().find(r => r.id === rowId);
  if (!row) return { status: "missing", message: t("LOOTCRATES.Refund.Missing") };
  if (row.refunded) return { status: "already", row, message: t("LOOTCRATES.Refund.Already") };
  const actor = game.actors.get(row.actorId);
  if (!actor) return { status: "no-actor", row, message: t("LOOTCRATES.Refund.NoActor") };
  const box = getBoxes()[row.boxId] ?? null;
  const short = spentWinnings(row, actor);
  if (short > 0) return { status: "short", row, actor, box, short, message: shortMessage(row, actor) };
  const { items, gone } = grantedItems(row, actor);
  return { status: "ready", row, actor, item: items[0] ?? null, items, gone, box, coins: refundCoins(row), state: stateAfter(row, box) };
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
  const { row, actor, items, gone, box } = plan;

  // Marked first: if a later write throws, a retry can't pay twice. A refund
  // that failed halfway is visible in the console and the row says refunded.
  // An open table stake is closed by its refund (round.js rowStatus): its
  // round stops counting it, and its resolve passes it by.
  const refunded = Date.now();
  await updateLog(row.id, { refunded, ...(row.status === "open" ? { status: "refunded" } : {}) });

  const purse = settle(actor.system?.currency ?? {}, plan.coins);
  await actor.update({ "system.currency": purse });

  // Every item the play granted, in one deletion when there are several.
  const removedItems = items.map(i => i.name);
  if (items.length === 1) await items[0].delete();
  else if (items.length) await actor.deleteEmbeddedDocuments("Item", items.map(i => i.id));
  const removedItem = removedItems.length ? listAnd(removedItems) : null;

  // The ticket the play spent, back in the pack. The coins and the items
  // are settled by now, so a failure is reported for the GM to fix (Make
  // a ticket on the game's row), not thrown.
  let ticketBack = null;
  if (row.redeem) {
    try {
      ticketBack = await returnTicket(actor, row);
    } catch (err) {
      console.error(`loot-crates | could not give ${row.actorName}'s ${row.boxName} ticket back`, err);
      globalThis.ui?.notifications?.error(t("LOOTCRATES.Ticket.ReturnFailed", { actor: row.actorName, box: row.boxName }));
    }
  }

  // A table stake (round.js) never took stock, and nor did a ticket's
  // play, so neither gives any back.
  let stock = null;
  // One back, never past the GM's number (limits.js).
  if (box?.rules?.stock != null && !row.roundId && !row.redeem) {
    stock = stockAfterRefund(box);
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
      globalThis.ui?.notifications?.error(t("LOOTCRATES.Refund.StateFailed", { name: row.name, actor: row.actorName, box: row.boxName }));
    }
  }

  const card = await markPullCard({ ...row, refunded });
  return { status: "refunded", row, purse, removedItem, removedItems, goneItems: gone, stock, state, card, ticketBack };
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
