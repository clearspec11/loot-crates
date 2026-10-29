import { formatPrice } from "../core/currency.js";
import { refundedCardContent } from "../views/chatcard.js";
import { replaySnapshot } from "../views/revealcard.js";
import { getLog } from "./store.js";
import { getKind, kindOf } from "../games/kinds.js";
import { t, listAnd } from "../core/i18n.js";
// The crate registers itself when imported, so a row or record with no kind is found.
import "../games/crate.js";

const esc = s => foundry.utils.escapeHTML(String(s ?? ""));

// Foundry's own content link (what @UUID[...]{name} enriches to), written out
// so the stored message carries it: it looks like every other link in chat,
// opens the sheet on click and drags onto a sheet. Points at the granted copy
// in the buyer's inventory, or at the pool's source when there isn't one.
function itemLink(uuid, name) {
  if (!uuid) return esc(name);
  return `<a class="content-link" draggable="true" data-link data-uuid="${esc(uuid)}" data-type="Item" data-tooltip="Item"><i class="fa-solid fa-suitcase" inert></i>${esc(name)}</a>`;
}

// The chat card everyone keeps: who opened what and got what. Posted with the
// result (socket.js showAndPost), not after the GM's own spin. The card's
// words are the kind's (kinds.js chat.card); a kind that posts none for this
// result (a miss) returns null, and so does this. flags.logId ties it to its
// log row, so a refund can mark this card; flags.replay lets anyone watch
// the spin again from the card.
export async function postPullCard(reveal) {
  const r = reveal.result;
  let content = getKind(kindOf(reveal))?.chat?.card?.(reveal, { esc, itemLink }) ?? null;
  if (!content) return null;
  // A refund made before the card was posted found no card to mark, so the
  // card is posted already refunded.
  const row = reveal.logId ? getLog().find(x => x.id === reveal.logId) : null;
  if (row?.refunded) content = refundedCardContent(content, row, { esc });
  const actor = game.actors.get(reveal.actorId);
  const flags = { boxId: reveal.box.id };
  if (r?.uuid) flags.uuid = r.uuid;
  if (reveal.logId) flags.logId = reveal.logId;
  // What "Watch again" replays (reveal.js watchAgain): the strip, odds and
  // result to show, never the purse or the granted item.
  const replay = replaySnapshot(reveal);
  if (replay) flags.replay = replay;
  return ChatMessage.create({
    content,
    speaker: ChatMessage.getSpeaker({ actor }),
    flags: { "loot-crates": flags },
  });
}

/*
  The refund card's line about the items, or null for a row that granted
  none. A play that granted several (refund.js removedItems, goneItems)
  names each removed and each already gone; a caller that passes only
  removedItem (one name) reads as before.
*/
function refundItemsLine({ row, removedItem, removedItems, goneItems }) {
  const removed = removedItems ?? (removedItem ? [removedItem] : []);
  const gone = goneItems ?? (!removed.length && row.itemId ? [row.name] : []);
  const names = list => esc(listAnd(list));
  if (removed.length && gone.length) return t("LOOTCRATES.Chat.RefundSomeGone", { removed: names(removed), gone: names(gone) });
  if (removed.length > 1) return t("LOOTCRATES.Chat.RefundRemovedSeveral", { names: names(removed) });
  if (removed.length) return t("LOOTCRATES.Chat.RefundRemoved", { name: esc(removed[0]) });
  if (gone.length > 1) return t("LOOTCRATES.Chat.RefundGoneSeveral", { names: names(gone) });
  if (gone.length) return t("LOOTCRATES.Chat.RefundGone", { name: esc(gone[0]) });
  return null;
}

// Posted when the GM refunds a pull, so the player whose coins came back and
// whose item vanished from their sheet can see why.
export async function postRefundCard({ row, actor, removedItem, removedItems, goneItems }) {
  // A row that granted no item (a well's miss or coin back, a dice bet, a
  // deck's card) has nothing to remove: the stake came back (and what a
  // bane took with it), the winnings were taken back less the stake (a
  // dice win), or the coin had already come back. A row that paid out or
  // took coins beyond the stake has no one price to show in the head (the
  // stake alone would misname what moved), so the head says "was refunded"
  // and the line under it carries the sum.
  const stake = Math.round((Number(row.price) || 0) * 100);
  const payout = Math.round(Number(row.payoutCp) || 0);
  const net = stake - payout;
  const line = refundItemsLine({ row, removedItem, removedItems, goneItems })
    ?? (payout < 0 ? t("LOOTCRATES.Chat.RefundBane", { net: esc(formatPrice(net / 100)), stake: esc(formatPrice(stake / 100)), took: esc(formatPrice(-payout / 100)) })
    : net > 0 ? t("LOOTCRATES.Chat.RefundBack", { net: esc(formatPrice(net / 100)) })
    : net < 0 ? t("LOOTCRATES.Chat.RefundTaken", { net: esc(formatPrice(-net / 100)), won: esc(formatPrice(payout / 100)), stake: esc(formatPrice(stake / 100)) })
    : t("LOOTCRATES.Chat.RefundCoinBack"));
  const content = `
    <div class="loot-crates lc-chat lc-rarity-${esc(row.rarity ?? "none")}">
      <div class="lc-chat__head">${t("LOOTCRATES.Chat.RefundHead", { actor: esc(actor?.name || row.actorName || t("LOOTCRATES.Auction.Someone")), box: `<strong>${esc(row.boxName)}</strong>` })}${payout ? "" : ` <span class="lc-chat__price">${esc(formatPrice(row.price))}</span>`}</div>
      <div class="lc-chat__refund">${line}</div>
    </div>`;
  return ChatMessage.create({
    content,
    speaker: ChatMessage.getSpeaker({ actor }),
    flags: { "loot-crates": { uuid: row.uuid, boxId: row.boxId, refunded: true } },
  });
}
