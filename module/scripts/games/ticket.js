/*
  A ticket: one play of a pulled game as an item a character carries. It is
  an ordinary dnd5e consumable (the game's name, an image for its kind, its
  price as the item's value, quantity for a stack) with one utility
  activity named for the play ("Open", "Scratch", "Throw", "Roll", "Draw"),
  so every sheet shows it a Use button, and it can be dragged, traded, put
  in a loot sheet, a merchant or a pool like any item. Its mark,
  flags["loot-crates"].ticket = { boxId, paid }, names the game and what
  the ticket cost (0 for one the GM handed out).

  Using it never runs dnd5e's own use: the module's dnd5e.preUseActivity
  hook (foundry/tickets.js) sees the mark, cancels the use and asks the
  active GM to redeem it, who plays the game through the same core as a
  purchase at price 0 and spends one ticket in the same queued task
  (socket.js, pull.js). A refund gives the ticket back (refund.js).

  Only a game a player pulls has tickets (the crate, the Wishing Well,
  Dragon's Teeth, the deck, scratch tickets); a table game is staked in
  rounds, never pulled. Pure: no Foundry globals.

  A ticket bought in the shop with Buy to keep (foundry/tickets.js
  keepTicket) is marked `kept`: the purchase was the play's, so its own
  log row (`keep`, see keepRow) counts toward the limit per character and
  took the stock, and the play it is later used for counts toward neither
  (limits.js boughtBy, pull.js). Kept tickets of one game at one price
  stack as one item.
*/
import { getKind, kindOf } from "./kinds.js";
import { formatPrice } from "../core/currency.js";
import { t } from "../core/i18n.js";

export const TICKET_FLAG = "ticket";
// The one activity's id: a ticket has exactly one, and a fixed id keeps
// two copies of the same ticket stacking as the same data.
export const TICKET_ACTIVITY_ID = "lootcrateticket0";

// The verb on the Use (the activity's name), per kind; a kind the module
// doesn't name plays as "Use".
const USE_KEYS = { crate: "LOOTCRATES.Ticket.UseOpen", scratch: "LOOTCRATES.Ticket.UseScratch", well: "LOOTCRATES.Ticket.UseThrow", dice: "LOOTCRATES.Ticket.UseRoll", deck: "LOOTCRATES.Ticket.UseDraw" };
export const useWord = box => t(USE_KEYS[kindOf(box)] ?? "LOOTCRATES.Ticket.Use");

// Foundry's own icons, one per kind (served by every Foundry install).
const ICONS = {
  crate: "icons/containers/chest/chest-reinforced-steel-brown.webp",
  scratch: "icons/sundries/documents/document-sealed-signatures-red.webp",
  well: "icons/commodities/currency/coin-embossed-crown-gold.webp",
  dice: "icons/sundries/gaming/dice-runed-brown.webp",
  deck: "icons/sundries/gaming/playing-cards.webp",
};
export const ticketImg = box => ICONS[kindOf(box)] ?? ICONS.crate;

// Whether a game can have tickets: a kind this client knows that is
// pulled, not staked at a table.
export function ticketable(box) {
  if (!box) return false;
  const kind = getKind(kindOf(box));
  return !!kind && !kind.table;
}

const gp = v => Math.max(0, Number(v) || 0);
// The description is HTML on the sheet: the game's name goes in escaped.
const escHTML = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/*
  The Item data for a ticket to `box`: a consumable (trinket) with one
  utility activity, at quantity 1. `paid` is what it cost in gp (0 for a
  ticket handed out); the item's value is that, or the game's price for
  one handed out, so a merchant or a loot sheet prices it as the game does.
*/
/*
  The ticket item's name, "<game> ticket": in the Items sidebar and on a
  sheet it isn't mistaken for the game's crate or its pool, which share
  the name. A game already named for its ticket ("Fortune ticket", "New
  scratch ticket") keeps its name, not "Fortune ticket ticket".
*/
export function ticketName(box) {
  const game = String(box?.name ?? "");
  const word = t("LOOTCRATES.Ticket.Name", { game: "" }).trim().toLowerCase();
  const name = game.trim().toLowerCase();
  return word && (name === word || name.endsWith(` ${word}`)) ? game.trim() : t("LOOTCRATES.Ticket.Name", { game });
}

export function ticketData(box, { paid = 0, kept = false } = {}) {
  const verb = useWord(box);
  const price = gp(paid) || gp(box?.price);
  return {
    name: ticketName(box),
    type: "consumable",
    img: ticketImg(box),
    system: {
      description: { value: `<p>${t("LOOTCRATES.Ticket.Description", { game: escHTML(box?.name) })}</p>` },
      quantity: 1,
      weight: { value: 0, units: "lb" },
      price: { value: price, denomination: "gp" },
      type: { value: "trinket", subtype: "" },
      activities: {
        [TICKET_ACTIVITY_ID]: {
          _id: TICKET_ACTIVITY_ID,
          type: "utility",
          name: verb,
          activation: { type: "action", value: 1, condition: "" },
          consumption: { targets: [], scaling: { allowed: false, max: "" }, spellSlot: false },
          description: { chatFlavor: "" },
          roll: { formula: "", name: "", prompt: false, visible: false },
        },
      },
    },
    flags: { "loot-crates": { [TICKET_FLAG]: { boxId: String(box?.id ?? ""), paid: gp(paid), ...(kept ? { kept: true } : {}) } } },
  };
}

// An item's ticket mark ({ boxId, paid }, with kept: true for one bought
// with Buy to keep), or null for any other item.
export function ticketOf(item) {
  const mark = item?.flags?.["loot-crates"]?.[TICKET_FLAG];
  if (!mark || typeof mark.boxId !== "string" || !mark.boxId) return null;
  return { boxId: mark.boxId, paid: gp(mark.paid), ...(mark.kept ? { kept: true } : {}) };
}

/*
  The kept ticket on a character a Buy to keep of `box` at `paid` gp
  stacks onto: a kept ticket to the same game bought at the same price,
  or null. `items` are the character's items (any iterable).
*/
export function keptStack(items, { boxId, paid }) {
  for (const item of items ?? []) {
    const mark = ticketOf(item);
    if (mark?.kept && mark.boxId === boxId && mark.paid === gp(paid)) return item;
  }
  return null;
}

/*
  The kept ticket a refund of a Buy to keep row takes back: the stack the
  ticket went onto while it still holds one, else another kept ticket to
  the same game at the same price (a stack used up and given back by a
  refund is a new item), or null when every one has been used or traded.
*/
export function keptTicketFor(items, row) {
  const keep = row?.keep;
  if (!keep) return null;
  const list = [...(items ?? [])];
  const same = item => { const mark = ticketOf(item); return !!mark?.kept && mark.boxId === row.boxId && mark.paid === gp(keep.paid) && ticketCount(item) >= 1; };
  return list.find(i => i.id === keep.itemId && same(i)) ?? list.find(same) ?? null;
}

// A Buy to keep's log row: { itemId, itemName, paid }, the stack the
// ticket went onto and what it cost. The row has no itemId of its own: no
// prize was granted, and a refund takes the ticket back, never the stack.
export const keepRow = ({ item, paid }) => ({ itemId: item?.id ?? null, itemName: String(item?.name ?? ""), paid: gp(paid) });

// Whether a log row is a Buy to keep (a ticket sold, nothing played): no
// game counts it as a play (the well's throws today, the deck's once cards,
// a scratch roll's tickets sold); the deck's rising price counts it as the
// purchase it is (deck.js pricedRows).
export const isKept = row => !!row?.keep;

// How many plays a ticket item holds (its quantity, 0 when it has none).
export const ticketCount = item => Math.max(0, Math.floor(Number(item?.system?.quantity) || 0));

/*
  What a redeemed play's log row keeps of the ticket, so a refund can give
  it back: { itemId, itemName, paid, data }, `data` the item as one ticket
  (quantity 1, no id or stats), re-created from the row when the stack was
  used up. `source` is the item's data (Item#toObject()). A kept ticket's
  row says `kept`: its play doesn't count toward the limit (limits.js).
*/
export function redeemRow(source, mark) {
  const data = structuredClone(source ?? {});
  const itemId = data._id ?? null;
  delete data._id;
  delete data._stats;
  delete data.folder;
  data.system = { ...(data.system ?? {}), quantity: 1 };
  return { itemId, itemName: String(source?.name ?? ""), paid: gp(mark?.paid), ...(mark?.kept ? { kept: true } : {}), data };
}

// What the reveal and the chat card show where a purchase shows its price:
// the price, or "with a ticket" for a redeemed play.
export const priceTag = reveal => (reveal?.redeem ? t("LOOTCRATES.Ticket.WithTicket") : formatPrice(reveal?.box?.price));

// The Pull log's word after the game's name: "(12 gp)", "(ticket)", or
// "(12 gp, kept)" for a Buy to keep.
export const rowPriceTag = row => (row?.redeem ? t("LOOTCRATES.Ticket.LogTag") : row?.keep ? t("LOOTCRATES.Keep.LogTag", { price: formatPrice(row.price) }) : formatPrice(row?.price));
