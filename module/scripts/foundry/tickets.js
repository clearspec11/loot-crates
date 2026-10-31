/*
  Tickets in a world (games/ticket.js has what a ticket is): Make a ticket
  on a game's Boxes row, the sheet's Use, and the GM's side of spending
  one and giving one back.

    makeTicket(box)        the GM's Make a ticket: a world Item named
                           "<game> ticket" in the Items folder "Loot Crates
                           tickets" (made when missing), for the GM to drag
                           to a sheet, a loot sheet, a merchant or a pool
    showInItems(item)      that item shown in the Items sidebar: its tab,
                           its folder open, the row in view and marked
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
    keepTicket(...)        Buy to keep's: one kept ticket into the pack, on
                           the stack of the same game at the same price, or
                           a new item; returns how to take it out again
    takeKeptTicket(...)    a refund of a Buy to keep: one kept ticket out of
                           the pack (games/ticket.js keptTicketFor), or null
                           when none is left to take

  Only a GM client writes: the hook on a player's client only asks.
*/
import { MODULE_ID } from "../core/config.js";
import { PullError, getKind, kindOf } from "../games/kinds.js";
import { ticketData, ticketOf, ticketCount, redeemRow, keptStack, keptTicketFor } from "../games/ticket.js";
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
  Make a ticket's ticket, shown where it is: the Items sidebar's tab (a GM
  on Chat or Actors saw nothing happen), its folder opened, the item
  scrolled into view and marked for a few seconds (module.css
  .loot-crates-made). The directory redraws on its own when an item is
  made, which can land after ours, so the mark is put back once more a
  moment later. Best effort: false when there is no sidebar to show it in.
*/
const MADE_MS = 4000;
export async function showInItems(item, folder = null) {
  const dir = globalThis.ui?.items;
  if (!dir || !item?.id) return false;
  if (folder?.uuid && game.folders?._expanded) game.folders._expanded[folder.uuid] = true;
  dir.activate?.();
  await dir.render?.();
  const mark = () => {
    const li = dir.element?.querySelector?.(`[data-entry-id="${CSS.escape(item.id)}"]`);
    if (!li) return false;
    if (!li.classList.contains("loot-crates-made")) li.scrollIntoView?.({ block: "nearest" });
    li.classList.add("loot-crates-made");
    setTimeout(() => li.classList.remove("loot-crates-made"), MADE_MS);
    return true;
  };
  const shown = mark();
  setTimeout(mark, 300);
  return shown;
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

/*
  Buy to keep, on the GM in the write queue after the charge: one ticket to
  `box` bought at `paid` gp into the character's pack, added to a kept
  ticket of the same game at the same price when there is one (a stack of
  scratchies is one item), else a new item. Returns { item, stacked, undo },
  `undo` taking that one ticket out again, for a sale whose log row then
  fails. Throws when the item isn't made (another module's preCreateItem
  hook cancelled it): the caller puts the coins back.
*/
export async function keepTicket(actor, box, paid) {
  const stack = keptStack(actor?.items?.values?.() ?? [], { boxId: String(box.id), paid });
  if (stack) {
    const qty = ticketCount(stack);
    await stack.update({ "system.quantity": qty + 1 });
    return { item: stack, stacked: true, undo: () => stack.update({ "system.quantity": qty }) };
  }
  const [item] = (await actor.createEmbeddedDocuments("Item", [ticketData(box, { paid, kept: true })])) ?? [];
  if (!item) throw new Error(`the ${box.name} ticket was not made on ${actor.name} (another module's preCreateItem hook cancelled it)`);
  return { item, stacked: false, undo: () => item.delete() };
}

/*
  A refund of a Buy to keep: one kept ticket out of the pack (the stack goes
  down by one, or the item is deleted at the last). Returns { item, undo },
  `undo` putting it back should the refund's next write fail, or null when
  the character has none of it left (used or traded), so nothing moved.
*/
export async function takeKeptTicket(actor, row) {
  const item = keptTicketFor(actor?.items?.values?.() ?? [], row);
  if (!item) return null;
  return { item, undo: await spendTicket(actor, item) };
}
