/*
  Tickets in a world (games/ticket.js has what a ticket is): Make a ticket
  on a game's Boxes row, the sheet's Use, and the GM's side of spending
  one and giving one back.

    makeTicket(box)        the GM's Make a ticket: a world Item in the Items
                           folder "Loot Crates tickets" (made when missing),
                           for the GM to drag to a sheet, a loot sheet, a
                           merchant or a pool
    ticketUseHook(request) the dnd5e.preUseActivity handler main.js
                           registers: a ticket's Use is cancelled before
                           dnd5e consumes or posts anything (returns false)
                           and sent to the active GM as a redeem (socket.js
                           requestRedeem); any other item's use goes on
    ticketToRedeem(...)    the GM's guards on a redeem, in the write queue:
                           the item is still on the character, still a
                           ticket, with one to spend, and its game still
                           exists and is pulled
    spendTicket(...)       one from the stack (the item deleted at the
                           last), returning how to put it back; pull.js
                           runs it as the play's payment, before the grant
    returnTicket(...)      a refund's: one back on the same stack, or the
                           ticket made again from its log row

  Only a GM client writes: the hook on a player's client only asks.
*/
import { MODULE_ID } from "../core/config.js";
import { PullError, getKind, kindOf } from "../games/kinds.js";
import { ticketData, ticketOf, ticketCount, redeemRow } from "../games/ticket.js";
import { t } from "../core/i18n.js";

// The Items folder tickets are made in, found by its flag, so a GM who
// renames it keeps it (and a translation names a new one in its words).
export function ticketFolder() {
  return game.folders?.find(f => f.type === "Item" && f.flags?.[MODULE_ID]?.tickets) ?? null;
}

async function ensureFolder() {
  const found = ticketFolder();
  if (found) return found;
  return Folder.create({ name: t("LOOTCRATES.Ticket.Folder"), type: "Item", flags: { [MODULE_ID]: { tickets: true } } });
}

// Make a ticket: { item, folder }. A GM's (only a GM creates world items).
export async function makeTicket(box) {
  const folder = await ensureFolder();
  const item = await Item.create({ ...ticketData(box), folder: folder?.id ?? null });
  if (!item) throw new Error(`the ticket for ${box?.name} was not created (another module's preCreateItem hook cancelled it)`);
  return { item, folder };
}

/*
  The handler for dnd5e.preUseActivity (activity, usageConfig,
  dialogConfig, messageConfig). dnd5e runs a use on a clone of the item
  that keeps its id and its actor. A ticket's use returns false, which
  cancels it before the configuration dialog, consumption or the chat card,
  and the play is asked of the GM: the reveal that answers it opens on
  every client. `request` is socket.js requestRedeem; a refusal is shown
  as the GM's sentence. Anything else returns undefined, so dnd5e goes on.
*/
export function ticketUseHook(request, warn = msg => globalThis.ui?.notifications?.warn(msg)) {
  return activity => {
    const item = activity?.item;
    if (!ticketOf(item)) return undefined;
    const actor = item.actor ?? (item.parent?.documentName === "Actor" ? item.parent : null);
    if (actor?.id && item.id) {
      Promise.resolve()
        .then(() => request({ actorId: actor.id, itemId: item.id }))
        .catch(err => {
          if (!(err instanceof PullError)) console.error(`loot-crates | using ${item.name} failed`, err);
          warn(err?.message ?? String(err));
        });
    }
    return false;
  };
}

/*
  The GM's guards on a redeem, inside the write queue: { item, mark, box,
  row } or a PullError naming what is wrong. `row` is what the play's log
  row keeps of the ticket (games/ticket.js redeemRow), read before it is
  spent. Off the shelf a ticket still plays (it is in the pack, not the
  shop); deleted, or a table game, it can't.
*/
export function ticketToRedeem(actor, itemId, boxes = {}) {
  const item = actor?.items?.get?.(itemId) ?? null;
  const mark = ticketOf(item);
  if (!item || !mark || ticketCount(item) < 1) throw new PullError(t("LOOTCRATES.Ticket.NotInPack", { actor: actor?.name ?? "" }));
  const box = boxes[mark.boxId] ?? null;
  const kind = box ? getKind(kindOf(box)) : null;
  if (!box || !kind || kind.table) throw new PullError(t("LOOTCRATES.Ticket.GameGone"));
  const source = typeof item.toObject === "function" ? item.toObject() : { ...item };
  return { item, mark, box, row: redeemRow({ ...source, _id: item.id }, mark) };
}

/*
  Spends one ticket: the stack goes down by one, or the item is deleted at
  the last. Returns the function that puts it back (the stack's quantity
  as it was, or the item made again with its id), for a play whose grant
  then fails.
*/
export async function spendTicket(actor, item) {
  const qty = ticketCount(item);
  if (qty > 1) {
    await item.update({ "system.quantity": qty - 1 });
    return () => item.update({ "system.quantity": qty });
  }
  const data = typeof item.toObject === "function" ? item.toObject() : { ...item };
  await item.delete();
  return () => actor.createEmbeddedDocuments("Item", [data], { keepId: true });
}

/*
  A refund's ticket: one more on the stack it came from while that item is
  still on the character as a ticket to the same game, else the ticket made
  again from the row (redeemRow). Returns "stack" or "made".
*/
export async function returnTicket(actor, row) {
  const keep = row?.redeem;
  const item = keep?.itemId ? actor?.items?.get?.(keep.itemId) : null;
  if (item && ticketOf(item)?.boxId === row.boxId) {
    await item.update({ "system.quantity": ticketCount(item) + 1 });
    return "stack";
  }
  const data = keep?.data ?? ticketData({ id: row.boxId, name: row.boxName, kind: row.kind, price: keep?.paid ?? 0 }, { paid: keep?.paid ?? 0 });
  const made = await actor.createEmbeddedDocuments("Item", [data]);
  if (!made?.length) throw new Error(`the ticket for ${row.boxName} was not made again on ${actor.name}`);
  return "made";
}
