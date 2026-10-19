/*
  Undo one pull from the log, on a GM client: the coins go back in the same
  whole gp/sp/cp that charge() took, the granted item (and only that item) is
  removed, and the box's stock goes back up by one.

  Constraints this holds: a row refunds at most once (the row is marked before
  any write that could fail, and refunds run one at a time), and the only item
  it will ever delete is the one carrying this pull's own loot-crates flag.
*/
import { refund } from "./currency.js";
import { getLog, updateLog, getBoxes, saveBox } from "./store.js";

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
  return { status: "ready", row, actor, item: grantedItem(row, actor), box: getBoxes()[row.boxId] ?? null };
}

// Refunds run strictly one after another, like pulls in socket.js, so two
// clicks on the same row (or two rows for one actor) never read the same
// log, purse or stock.
let queue = Promise.resolve();
export function refundPull(rowId) {
  const run = queue.catch(() => {}).then(() => doRefund(rowId));
  queue = run;
  return run;
}

async function doRefund(rowId) {
  const plan = describeRefund(rowId);
  if (plan.status !== "ready") return plan;
  const { row, actor, item, box } = plan;

  // Marked first: if a later write throws, a retry can't pay twice. A refund
  // that failed halfway is visible in the console and the row says refunded.
  await updateLog(row.id, { refunded: Date.now() });

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

  return { status: "refunded", row, purse, removedItem, stock };
}
