/*
  Handing over an item a play won and is still owed (core/owedprize.js), on
  a GM client, from the Pull log. One owed item per call, the row's first:

  - picked from the pools (`uuid`, one of owedChoices): a copy is made on
    the character exactly as a win makes one (crate.js grantData, pull.js
    createGrants: the loot-crates flag, Plutonium's opt-out, a ticket
    counted as issued), and the row gains it (handedPatch), so the one
    refund removes it and a sell back or a gift after the reveal finds it;
  - or given by hand (no `uuid`): the GM put the item on the sheet some
    other way, and only the debt is cleared.

  The game's own rules (no duplicates, stock) are not asked: the pick is
  the GM's, as a scratch draw ignores them too.

  It runs in the write queue, beside pulls and refunds, and reads the row
  there: a row refunded or settled since the dialog opened is refused. The
  item is made before the row is written; if the row can't be written the
  item is taken back, so a retry never hands over twice.

  The pull's chat card says what was handed over in place of what was owed.
*/
import { getLog, getPools, getBoxes, updateLog, enqueueWrite } from "./store.js";
import { createGrants, resolveSource } from "./pull.js";
import { grantData } from "../games/crate.js";
import { owedOf, owedChoices, owedName, handedPatch, owedCardLine } from "../core/owedprize.js";
import { worthColumns } from "../core/afterplay.js";
import { findPullCard, owedCardContent } from "../views/chatcard.js";
import { t } from "../core/i18n.js";

// What handing over this row's next owed item would do, for the dialog.
// status: "ready" | "missing" | "refunded" | "none" | "no-actor"
export function describeOwed(rowId) {
  const row = getLog().find(r => r.id === rowId);
  if (!row) return { status: "missing", message: t("LOOTCRATES.Refund.Missing") };
  if (row.refunded) return { status: "refunded", row, message: t("LOOTCRATES.Owed.Refunded") };
  const [owed] = owedOf(row);
  if (!owed) return { status: "none", row, message: t("LOOTCRATES.Owed.Nothing") };
  const actor = game.actors.get(row.actorId);
  if (!actor) return { status: "no-actor", row, message: t("LOOTCRATES.Refund.NoActor") };
  return { status: "ready", row, actor, owed, what: owedName(owed.rarity), choices: owedChoices(getPools(), owed.rarity) };
}

export function handOver(rowId, pick = {}) {
  return enqueueWrite(() => doHandOver(rowId, pick));
}

async function doHandOver(rowId, { uuid = null } = {}) {
  const plan = describeOwed(rowId);
  if (plan.status !== "ready") return plan;
  const { row, actor, owed } = plan;
  const at = Date.now();
  let created = null;
  let item = null;
  if (uuid) {
    const choice = plan.choices.find(c => c.uuid === uuid);
    const source = choice ? await resolveSource(uuid) : null;
    if (!source) return { status: "gone", row, message: t("LOOTCRATES.Owed.SourceGone") };
    const box = getBoxes()[row.boxId] ?? { id: row.boxId };
    const { grant } = grantData(source, { entry: choice.entry, rarity: owed.rarity, pity: false }, box);
    try {
      [created] = await createGrants(actor, [grant]);
    } catch (err) {
      console.error(`loot-crates | handing ${choice.name} over to ${actor.name} failed; the item is still owed`, err);
      return { status: "failed", row, message: t("LOOTCRATES.Owed.Failed", { item: choice.name, actor: actor.name }) };
    }
    item = { id: created.id, name: created.name, uuid, ...worthColumns([created]) };
  }
  const patch = handedPatch(row, { item, at });
  try {
    await updateLog(row.id, patch);
  } catch (err) {
    console.error(`loot-crates | could not record ${row.actorName}'s owed item as handed over`, err);
    if (created) {
      try { await created.delete(); } catch (undoErr) { console.error(`loot-crates | could not take ${created.name} back from ${actor.name}; remove it by hand`, undoErr); }
    }
    throw err;
  }
  const after = { ...row, ...patch };
  await markOwedCard(after);
  return { status: "handed", row: after, actor, what: plan.what, itemName: item?.name ?? null };
}

// The pull's chat card, with what was handed over in place of what was
// owed. The item and the row are settled by now: a failed chat write is
// logged, not thrown.
async function markOwedCard(row) {
  try {
    const msg = findPullCard(game.messages?.contents ?? [], row);
    if (!msg) return false;
    const content = owedCardContent(msg.content, { line: owedCardLine(row), esc: foundry.utils.escapeHTML });
    if (content === msg.content) return false;
    await msg.update({ content });
    return true;
  } catch (err) {
    console.error(`loot-crates | could not update the chat card for ${row.name}`, err);
    return false;
  }
}
