/*
  After the reveal (VIB-219): the winner of a play that granted items can,
  while the reveal is open, give each item to a character another player
  owns or sell it back to the house; closing the window leaves it where it
  is. This file is the rules and the words, with no Foundry in them: what
  an item is worth, what the house pays for it, who can be given it, why
  the GM refuses a request, and how the row says what happened. The GM's
  side is foundry/handover.js, the reveal's buttons views/afterreveal.js.

  What the house pays is set per game (`rules.sellBack`, a percentage,
  SELL_BACK_DEFAULT when the game was saved before the setting; 0 turns
  it off for that game). The amount is the item's dnd5e price times its
  quantity times the percentage, floored in the item's own coin (a 5 sp
  item at 50% sells for 2 sp), in copper for settle(). The price is the
  one the item had when it was granted (`worth` on the row, worthColumns):
  a player owns their character and can edit an item's price on the
  sheet, so the GM never reads it from the item afterwards; only its
  quantity, which can only lower the amount (heldWorth: a stack partly
  used since sells for what is left).

  A row records each item's outcome in `parted` by item id: { at, given:
  { actorId, actorName } } or { at, soldCp }. A given or sold item no
  longer counts as owned for no duplicates (tally.js won, odds.js
  ownedAfterPart), and a row with any parted item can't be refunded: the
  item is gone.
*/
import { COPPER_PER, formatPrice } from "./currency.js";
import { t, listAnd } from "./i18n.js";

export const SELL_BACK_DEFAULT = 50;

const clampPct = n => Math.max(0, Math.min(100, Math.floor(n)));

// A game's sell-back percentage, 0 to 100.
export function sellBackOf(game) {
  const n = Number(game?.rules?.sellBack);
  return game?.rules?.sellBack == null || !Number.isFinite(n) ? SELL_BACK_DEFAULT : clampPct(n);
}

// The editor's field, as saved: blank is the default, anything else 0 to 100.
export function sellBackFromForm(value) {
  if (value === "" || value == null) return SELL_BACK_DEFAULT;
  const n = Number(value);
  return Number.isFinite(n) ? clampPct(n) : SELL_BACK_DEFAULT;
}

/*
  What an item is worth as dnd5e prices it: { value, denomination,
  quantity }, or null when it has no price (or a coin dnd5e doesn't have).
  dnd5e 3 on stores { value, denomination }; older data a bare number of gp.
*/
export function worthOf(item) {
  const sys = item?.system ?? {};
  const raw = sys.price;
  const value = Number(typeof raw === "object" && raw ? raw.value : raw);
  const denomination = typeof raw === "object" && raw ? String(raw.denomination ?? "gp") : "gp";
  if (!(value > 0) || !COPPER_PER[denomination]) return null;
  const quantity = Math.max(1, Math.floor(Number(sys.quantity) || 1));
  return { value, denomination, quantity };
}

// The row's and the reveal's `worth`: each granted item's worth by id, for
// the items that have one (none: nothing to add).
export function worthColumns(created = []) {
  const worth = {};
  for (const d of created) {
    const w = d?.id ? worthOf(d) : null;
    if (w) worth[d.id] = w;
  }
  return Object.keys(worth).length ? { worth } : {};
}

// What an item worth `worth` (worthOf) is worth in all, in copper: its
// price times its quantity, rounded to the copper (0 with no price). The
// economy readout's value of an item won (core/tally.js).
export function worthCp(worth) {
  const per = COPPER_PER[worth?.denomination];
  if (!per || !(Number(worth?.value) > 0)) return 0;
  return Math.round(Number(worth.value) * Math.max(1, Math.floor(Number(worth.quantity) || 1)) * per);
}

// What the house pays for an item worth `worth` at `pct`, in copper: 0 when
// it has no price or the game buys nothing back.
export function sellCp(worth, pct) {
  const per = COPPER_PER[worth?.denomination];
  if (!per || !(Number(worth?.value) > 0) || !(pct > 0)) return 0;
  const qty = Math.max(1, Math.floor(Number(worth.quantity) || 1));
  return Math.floor(Number(worth.value) * qty * pct / 100) * per;
}

/*
  What of `worth` (as granted) is still on the sheet: its quantity no more
  than the item's own now, so a stack partly used since (four of five
  potions drunk) sells for what is left, never for the stack as won. The
  price stays the grant's (a player can edit it). Null when nothing is
  left or the item had no worth.
*/
export function heldWorth(worth, item) {
  if (!worth) return null;
  const won = Math.max(1, Math.floor(Number(worth.quantity) || 1));
  const raw = item?.system?.quantity;
  const now = raw == null ? won : Math.max(0, Math.floor(Number(raw) || 0));
  const quantity = Math.min(won, now);
  return quantity > 0 ? { ...worth, quantity } : null;
}

// The items a row (or a reveal) granted, in order: [{ id, name }].
export function rowItems(row) {
  const ids = Array.isArray(row?.itemIds) && row.itemIds.length ? row.itemIds : row?.itemId ? [row.itemId] : [];
  const names = Array.isArray(row?.itemNames) ? row.itemNames : [];
  return ids.map((id, i) => ({ id, name: String(names[i] ?? (ids.length === 1 ? row?.result?.name ?? row?.name : "") ?? "") }));
}

export const partOf = (row, itemId) => row?.parted?.[itemId] ?? null;
export const partedItems = row => rowItems(row).filter(i => partOf(row, i.id));
export const anyParted = row => partedItems(row).length > 0;

// Whether the row's first item (the one its `uuid` names, which no
// duplicates counts) was given or sold.
export function firstParted(row) {
  const first = rowItems(row)[0];
  return !!first && !!partOf(row, first.id);
}

/*
  The characters a player can give an item to: every character another
  non-GM player owns, which `userId` doesn't own (a GM owns every one, so
  for a GM only the first rule holds), never the winner's own. Each with
  its owners' names, sorted by name: [{ id, name, players }]. `actors` and
  `users` are lists of Foundry's documents (testUserPermission, isGM).
*/
export function giveTargets({ actors = [], users = [], userId = null, fromActorId = null } = {}) {
  const me = users.find(u => u?.id === userId) ?? null;
  const out = [];
  for (const actor of actors) {
    if (!actor || actor.id === fromActorId) continue;
    const owners = targetOwners(actor, users, me);
    if (owners) out.push({ id: actor.id, name: String(actor.name ?? ""), players: listAnd(owners.map(u => String(u.name ?? ""))) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// The players who make `actor` a place to give to (see giveTargets), or
// null when it isn't one.
function targetOwners(actor, users, me) {
  if (actor?.type !== "character" || typeof actor.testUserPermission !== "function") return null;
  if (me && !me.isGM && actor.testUserPermission(me, "OWNER")) return null;
  const owners = users.filter(u => u && !u.isGM && u.id !== me?.id && actor.testUserPermission(u, "OWNER"));
  return owners.length ? owners : null;
}
export const isGiveTarget = (actor, users, me) => !!targetOwners(actor, users, me);

/*
  Why the GM refuses a give or a sell, as the sentence the player reads,
  or null when it can go ahead. `row` the play's log row as it stands,
  `sender` the user Foundry names, `actor` the winner's character, `item`
  the item on it by the requested id.
*/
export function partRefusal({ row, sender, itemId, actor, item }) {
  if (!row) return t("LOOTCRATES.After.RowGone");
  const name = rowItems(row).find(i => i.id === itemId)?.name || row.name || t("LOOTCRATES.After.ThatItem");
  const mine = !!sender && row.userId === sender.id && !!actor && actor.testUserPermission?.(sender, "OWNER");
  if (!mine) return t("LOOTCRATES.After.NotYours");
  if (row.refunded) return t("LOOTCRATES.After.Refunded", { item: name });
  if (row.roundId || !rowItems(row).some(i => i.id === itemId)) return t("LOOTCRATES.After.NotInRow");
  const part = partOf(row, itemId);
  if (part?.given) return t("LOOTCRATES.After.AlreadyGiven", { item: name, target: part.given.actorName });
  if (part) return t("LOOTCRATES.After.AlreadySold", { item: name });
  const mark = item?.flags?.["loot-crates"];
  if (!item || mark?.boxId !== row.boxId) return t("LOOTCRATES.After.Gone", { item: name, actor: actor.name });
  return null;
}

/* ---------- Words ---------- */

/*
  What happened to an item, as the Pull log's note and the chat card's
  line say it after the winner's name and the item: "gave it to Saria",
  "sold it back for 75 gp"; with several items each is named ("gave Wand
  of Webs to Saria").
*/
export function partPhrase(part, { item = "", several = false } = {}) {
  if (part?.given) return several ? t("LOOTCRATES.After.GaveNamed", { item, target: part.given.actorName }) : t("LOOTCRATES.After.GaveIt", { target: part.given.actorName });
  return several ? t("LOOTCRATES.After.SoldNamed", { item, price: formatPrice((Number(part?.soldCp) || 0) / 100) }) : t("LOOTCRATES.After.SoldIt", { price: formatPrice((Number(part?.soldCp) || 0) / 100) });
}

// Every parted item of a row, as one line: "gave it to Saria", or "gave
// Wand of Webs to Saria; sold Potion of Healing back for 25 gp".
export function partsLine(row) {
  const items = rowItems(row);
  const several = items.length > 1;
  return items.filter(i => partOf(row, i.id)).map(i => partPhrase(partOf(row, i.id), { item: i.name, several })).join(t("LOOTCRATES.Common.ListSemicolon"));
}

// The reveal's line for one item, for whoever watches: "Brinn gave Wand of
// Webs to Saria." / "Brinn sold Wand of Webs back for 75 gp."
export function partSentence(part, { actor = "", item = "" } = {}) {
  if (part?.given) return t("LOOTCRATES.After.GaveSentence", { actor, item, target: part.given.actorName });
  return t("LOOTCRATES.After.SoldSentence", { actor, item, price: formatPrice((Number(part?.soldCp) || 0) / 100) });
}

// Why a row with a given or sold item can't be refunded (refund.js).
export function partedRefundMessage(row) {
  return t("LOOTCRATES.After.NoRefund", { actor: row.actorName, what: partsLine(row) });
}
