/*
  An item a play won that nobody has been given yet (VIB-221). A scratch
  ticket drawn for an item its pools can't give still wins it (scratch.js
  roll): its row carries `owed: [{ rarity }]`, one entry per item, and the
  GM hands each over from the Pull log (foundry/owedprize.js): an item
  picked from the pools, created on the character and recorded on the row
  as any won item is, or one the GM gave by hand, which only clears the
  debt. What was handed over is kept on the row as `handed: [{ rarity, at,
  name } | { rarity, at, byHand: true }]`.

  A row with an item still owed is never trimmed from the log (core/
  tally.js trimLog): the row is the only record of the debt.

  No Foundry globals.
*/
import { RARITY_LABEL } from "./config.js";
import { flattenPool } from "./odds.js";
import { t, listAnd } from "./i18n.js";

// The items a row still owes, [{ rarity }].
export const owedOf = row => (Array.isArray(row?.owed) ? row.owed.filter(o => o?.rarity) : []);
export const handedOf = row => (Array.isArray(row?.handed) ? row.handed.filter(h => h?.rarity) : []);

// "Rare item": an owed item by its rarity, as the ticket named it.
export const owedName = rarity => t("LOOTCRATES.Scratch.ItemPrize", { rarity: RARITY_LABEL[rarity] ?? rarity });

// "Owed: Rare item" under a row in the Pull log, or "".
export const owedNote = row => (owedOf(row).length && !row.refunded ? t("LOOTCRATES.Owed.Note", { what: listAnd(owedOf(row).map(o => owedName(o.rarity))) }) : "");

// "Handed over by the GM: Flame Tongue" under a row, or "".
export const handedNote = row => (handedOf(row).length ? t("LOOTCRATES.Owed.HandedNote", { what: listAnd(handedOf(row).map(h => h.name ?? owedName(h.rarity))) }) : "");

// The chat card's foot line once something was handed over: what was, and
// what is still owed after it.
export function owedCardLine(row) {
  const parts = [];
  if (handedOf(row).length) parts.push(t("LOOTCRATES.Owed.CardHanded", { what: listAnd(handedOf(row).map(h => h.name ?? owedName(h.rarity))) }));
  if (owedOf(row).length) parts.push(t("LOOTCRATES.Scratch.OwedWhere", { what: listAnd(owedOf(row).map(o => owedName(o.rarity))) }));
  return parts.join(" ");
}

/*
  The items the GM can hand over for an owed rarity: every entry at it in
  any pool (not only the game's: its own pools are the ones that couldn't
  give it), once each, by name. [{ uuid, name, img, rarity, poolName,
  entry }], `entry` the pool's own for the grant (crate.js grantData).
*/
export function owedChoices(pools = {}, rarity) {
  const seen = new Set();
  const out = [];
  for (const pool of Object.values(pools ?? {})) {
    for (const e of flattenPool(pool?.id, pools, new Set())) {
      if (e.rarity !== rarity || !e.uuid || seen.has(e.uuid)) continue;
      seen.add(e.uuid);
      out.push({ uuid: e.uuid, name: String(e.name ?? ""), img: String(e.img ?? ""), rarity: e.rarity, poolName: String(pools[e.poolId]?.name ?? ""), entry: e });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.uuid.localeCompare(b.uuid));
}

/*
  The row's patch once its first owed item is handed over at `at`. With
  `item` ({ id, name, uuid: the pool source's, worth? }, the copy made on
  the character) the row gains it as an item it granted: its id and name
  beside any others, the source's uuid when the row had none (so the one
  refund finds and removes it, refund.js grantedItems), its worth, and the
  row's name with the item's in place of the rarity's. Without one (given
  by hand) only the debt is cleared. Null when nothing is owed.
*/
export function handedPatch(row, { item = null, at = Date.now() } = {}) {
  const [first, ...rest] = owedOf(row);
  if (!first) return null;
  const handed = [...handedOf(row), item ? { rarity: first.rarity, at, name: String(item.name ?? "") } : { rarity: first.rarity, at, byHand: true }];
  if (!item) return { owed: rest, handed };
  const ids = Array.isArray(row.itemIds) && row.itemIds.length ? row.itemIds : row.itemId ? [row.itemId] : [];
  const names = [...(Array.isArray(row.itemNames) ? row.itemNames : []), String(item.name ?? "")];
  const byHand = handed.filter(h => h.byHand).map(h => owedName(h.rarity));
  return {
    owed: rest, handed,
    itemId: row.itemId ?? item.id,
    itemIds: [...ids, item.id],
    itemNames: names,
    ...(row.uuid ? {} : { uuid: item.uuid }),
    ...(item.worth ? { worth: { ...(row.worth ?? {}), ...item.worth } } : {}),
    name: listAnd([...names, ...byHand, ...rest.map(o => owedName(o.rarity))]),
  };
}
