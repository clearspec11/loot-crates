/*
  After the reveal, on the active GM (VIB-219): the winner's Give to… and
  Sell back (views/afterreveal.js) arrive as requests by query like any
  other (socket.js: the sender is Foundry's, never the message's), and run
  here inside the write queue, one at a time with pulls and refunds.

  The guards (core/afterplay.js partRefusal), read afresh inside the queue:
  the row is still in the log, the real sender sent that play and owns its
  character, it isn't refunded, the item came from it and hasn't been given
  or sold already, and the item is still on the character with the same id
  and this game's mark. A give's target must be a character a different
  non-GM player owns (isGiveTarget); a sell's price is the house's now
  (sellCp: the item's worth as granted, no more of it than is still on
  the sheet, heldWorth, at the game's sellBack), and a
  press at another price is refused naming the new one.

  The row is marked first (store.js recordPart, with the tallies and the
  no-duplicates record in the same write), as a refund marks first, so a
  second request for the item is refused even while this one is moving it.
  Then:
  - Give: the item is made on the target from its data (pull.js
    createGrants, which treats a creation another module cancelled as a
    failure), then deleted from the winner. A failure before the delete
    deletes the copy again, so the item is never on both sheets or on
    neither; a copy that can't be deleted is named to the GM.
  - Sell: the item is deleted, then the coins paid through settle(). Coins
    that can't be paid put the item back with its id.
  Either failure lifts the mark (liftPart) and is refused with a plain
  sentence. Once done, everyone's open reveal of the play hears it on the
  socket (`parted`, display only) and the play's chat card gets a line;
  the winner has it as the query's answer.
*/
import { SOCKET, MODULE_ID } from "../core/config.js";
import { PullError } from "../games/kinds.js";
import { getLog, getBoxes, recordPart, liftPart } from "./store.js";
import { createGrants } from "./pull.js";
import { partRefusal, isGiveTarget, sellBackOf, sellCp, heldWorth, rowItems, partsLine } from "../core/afterplay.js";
import { settle, formatPrice } from "../core/currency.js";
import { findPullCard, partedCardContent } from "../views/chatcard.js";
import { t } from "../core/i18n.js";

const allUsers = () => game.users?.contents ?? [...(game.users?.values?.() ?? [])];

// The request's row, its character and the item, or a PullError.
function guard(msg) {
  const row = getLog().find(r => r.id === msg.logId) ?? null;
  const sender = game.users.get(msg.userId) ?? null;
  const actor = row ? game.actors.get(row.actorId) ?? null : null;
  const item = actor?.items?.get?.(msg.itemId) ?? null;
  const why = partRefusal({ row, sender, itemId: msg.itemId, actor, item, now: Date.now() });
  if (why) throw new PullError(why);
  const name = rowItems(row).find(i => i.id === msg.itemId)?.name || item.name;
  return { row, sender, actor, item, name };
}

async function mark(row, itemId, part) {
  const done = await recordPart(row.id, itemId, part);
  if (!done) throw new PullError(t("LOOTCRATES.After.RowGone"));
  return done;
}

async function lift(done, what) {
  try { await liftPart(done); } catch (err) {
    console.error(`loot-crates | could not take back the mark of ${what} on its Pull log row; the GM must check the row`, err);
  }
}

/*
  The data of a given item: the item as it stands, with no id, keeping the
  game's mark and noting where it came from, but not the grant's time, so
  every client's preSealItem (reveal.js) doesn't take it for a fresh grant
  and hide it on the target's sheet.
*/
export function giftData(item, { fromActorId, logId }) {
  const data = typeof item.toObject === "function" ? item.toObject() : structuredClone(item);
  delete data._id;
  const own = { ...(data.flags?.[MODULE_ID] ?? {}) };
  delete own.at;
  data.flags = { ...(data.flags ?? {}), [MODULE_ID]: { ...own, given: { fromActorId, logId } } };
  return data;
}

export async function doGive(msg) {
  const { row, sender, actor, item, name } = guard(msg);
  const target = game.actors.get(msg.targetId) ?? null;
  if (!target || !isGiveTarget(target, allUsers(), sender)) throw new PullError(t("LOOTCRATES.After.BadTarget", { item: name }));
  const part = { at: Date.now(), given: { actorId: target.id, actorName: target.name } };
  const done = await mark(row, item.id, part);
  const data = giftData(item, { fromActorId: actor.id, logId: row.id });
  let made;
  try {
    [made] = await createGrants(target, [data]);
  } catch (err) {
    console.error(`loot-crates | giving ${name} from ${actor.name} to ${target.name} failed; it stays with ${actor.name}`, err);
    await lift(done, name);
    throw new PullError(t("LOOTCRATES.After.GiveFailed", { item: name, target: target.name, actor: actor.name }));
  }
  try {
    await actor.deleteEmbeddedDocuments("Item", [item.id]);
  } catch (err) {
    console.error(`loot-crates | taking ${name} off ${actor.name} after giving it to ${target.name} failed; deleting the copy`, err);
    try {
      await target.deleteEmbeddedDocuments("Item", [made.id]);
    } catch (undoErr) {
      console.error(`loot-crates | could not delete the copy of ${name} on ${target.name}; both sheets have it`, undoErr);
      globalThis.ui?.notifications?.error(t("LOOTCRATES.After.GiveUndoFailedGM", { item: name, actor: actor.name, target: target.name }));
      throw new PullError(t("LOOTCRATES.After.GiveUndoFailed", { item: name }));
    }
    await lift(done, name);
    throw new PullError(t("LOOTCRATES.After.GiveFailed", { item: name, target: target.name, actor: actor.name }));
  }
  return finish({ msg, row, actor, itemId: item.id, name, part, extra: { targetId: target.id, givenId: made.id } });
}

export async function doSell(msg) {
  const { row, actor, item, name } = guard(msg);
  const box = getBoxes()[row.boxId] ?? null;
  const cp = sellCp(heldWorth(row.worth?.[item.id], item), box ? sellBackOf(box) : 0);
  if (!cp) throw new PullError(t("LOOTCRATES.After.SellOff", { box: row.boxName, item: name }));
  if (msg.cp != null && Math.round(Number(msg.cp)) !== cp) throw new PullError(t("LOOTCRATES.After.SellChanged", { box: row.boxName, item: name, price: formatPrice(cp / 100) }));
  const part = { at: Date.now(), soldCp: cp };
  const done = await mark(row, item.id, part);
  const data = typeof item.toObject === "function" ? item.toObject() : structuredClone(item);
  try {
    await actor.deleteEmbeddedDocuments("Item", [item.id]);
  } catch (err) {
    console.error(`loot-crates | selling ${name} back from ${actor.name} failed; nothing moved`, err);
    await lift(done, name);
    throw new PullError(t("LOOTCRATES.After.SellFailed", { item: name, actor: actor.name }));
  }
  const purse = settle(actor.system?.currency ?? {}, cp);
  try {
    await actor.update({ "system.currency": purse });
  } catch (err) {
    console.error(`loot-crates | paying ${actor.name} ${formatPrice(cp / 100)} for ${name} failed; putting the item back`, err);
    try {
      await actor.createEmbeddedDocuments("Item", [data], { keepId: true });
    } catch (undoErr) {
      console.error(`loot-crates | could not put ${name} back on ${actor.name}; the GM must pay ${formatPrice(cp / 100)} or give it back by hand`, undoErr);
      globalThis.ui?.notifications?.error(t("LOOTCRATES.After.SellUndoFailedGM", { item: name, actor: actor.name, price: formatPrice(cp / 100) }));
      throw new PullError(t("LOOTCRATES.After.SellUndoFailed", { item: name }));
    }
    await lift(done, name);
    throw new PullError(t("LOOTCRATES.After.SellFailed", { item: name, actor: actor.name }));
  }
  return finish({ msg, row, actor, itemId: item.id, name, part, extra: { purse } });
}

/*
  Done: everyone's open reveal of the play hears it (the winner's own
  takes its answer, below, and ignores this), the chat card gets its line,
  and the answer goes back. The writes are settled by now, so a chat card
  that can't be written is logged, never thrown.
*/
async function finish({ msg, row, actor, itemId, name, part, extra }) {
  const parted = { type: "parted", logId: row.id, userId: row.userId, itemId, itemName: name, actorName: actor.name, part };
  try { game.socket.emit(SOCKET, parted); } catch (err) { console.error("loot-crates | telling the table what was given or sold failed", err); }
  tellParted(parted);
  await markCard({ ...row, parted: { ...(row.parted ?? {}), [itemId]: part } }, actor);
  return { ...parted, requestId: msg.requestId, ...extra };
}

// The open reveal windows on this client hear what became of an item
// (reveal.js heardParted sets the listener, so this file imports no
// window): from the socket, and from this GM's own give or sell, whose
// emit it never hears.
let heard = null;
export function onParted(fn) { heard = typeof fn === "function" ? fn : null; }
export function tellParted(msg) {
  try { heard?.(msg); } catch (err) { console.error("loot-crates | showing what became of an item failed", err); }
  return null;
}

// The play's chat card, with what became of its items.
async function markCard(row, actor) {
  try {
    const card = findPullCard(game.messages?.contents ?? [], row);
    if (!card) return false;
    const line = t("LOOTCRATES.After.CardLine", { actor: row.actorName ?? actor.name, what: partsLine(row) });
    const content = partedCardContent(card.content, row, { esc: foundry.utils.escapeHTML, line, actorId: actor.id });
    if (content === card.content) return false;
    await card.update({ content });
    return true;
  } catch (err) {
    console.error(`loot-crates | could not write what became of ${row.name} on its chat card`, err);
    return false;
  }
}
