/*
  One purchase, end to end, on a GM client: check the purse, roll the result,
  deduct the coins, grant the item, record it. Everything it needs is passed in,
  so the live check (foundry-dev/checks) can run it against a world where the
  module isn't installed, and the socket handler wraps it with the stores.
*/
import { RARITIES } from "./config.js";
import { draw, nextState, markEntriesMissing } from "./odds.js";
import { buildStrip } from "./strip.js";
import { charge, canAfford } from "./currency.js";

export class PullError extends Error {}

export function rollRng() {
  const r = globalThis.CONFIG?.Dice?.randomUniform;
  return typeof r === "function" ? r : Math.random;
}

async function resolveSource(uuid) {
  try { return await fromUuid(uuid); } catch { return null; }
}

// A source's own rarities as stored: dnd5e 6's set (an array once copied, more
// than one for a "Varies" item), dnd5e 5's string, or none.
export function sourceRaritiesOf(data) {
  const sys = data?.system ?? {};
  if (Array.isArray(sys.rarities)) return [...sys.rarities];
  if (sys.rarities instanceof Set) return [...sys.rarities];
  return typeof sys.rarity === "string" && sys.rarity ? [sys.rarity] : [];
}

/*
  `onMissing(entry)` is told about a rolled entry whose source turned out to be
  gone (the socket handler marks it in the pool setting and warns the GM).
  The caller is expected to have swept the box for dead sources already, so
  this only happens when one vanished in between: the entry is excluded and the
  roll is made again, up to MAX_REDRAWS times. Nothing is charged until a live
  source is in hand.
*/
const MAX_REDRAWS = 3;
export async function performPull({ box, pools, actor, state = {}, rng = rollRng(), grant = true, onMissing = null }) {
  if (!box) throw new PullError("That box no longer exists.");
  if (!actor) throw new PullError("No character to buy with.");
  if (box.rules?.stock != null && box.rules.stock <= 0) throw new PullError(`${box.name} is sold out.`);

  // A copy: the live currency object is what actor.update rewrites, and the
  // grant-failure branch below needs the purse as it was before the charge.
  const purse = { ...(actor.system?.currency ?? {}) };
  if (!canAfford(purse, box.price)) throw new PullError(`${actor.name} can't afford ${box.name}.`);

  let result = draw({ box, pools, rng, state });
  let source = result && await resolveSource(result.entry.uuid);
  let lost = null;
  for (let redraws = 0; result && !source; redraws++) {
    lost = result.entry;
    await onMissing?.(lost);
    if (redraws === MAX_REDRAWS) throw new PullError(`${lost.name} is missing from its compendium. Tell the GM.`);
    console.warn(`loot-crates | ${lost.name} (${lost.uuid}) in pool ${lost.poolId} has no source; excluding it and rolling again`);
    pools = markEntriesMissing(pools, lost.poolId, [lost.uuid], true);
    result = draw({ box, pools, rng, state });
    source = result && await resolveSource(result.entry.uuid);
  }
  // Every entry left was dead: say so rather than "nothing left".
  if (!result && lost) throw new PullError(`${lost.name} is missing from its compendium. Tell the GM.`);
  if (!result) throw new PullError(`${box.name} has nothing left to give ${actor.name}.`);

  const nextPurse = charge(purse, box.price);
  const strip = buildStrip({ result, box, pools, rng });

  let created = null;
  // The source's own rarity, kept on the copy and in the log when the GM's
  // differs, so a Legendary rope can be traced back to an Uncommon one.
  const sourceData = source.toObject();
  const sourceRarity = sourceRaritiesOf(sourceData);
  const overridden = RARITIES.includes(result.entry.rarityOverride);
  if (grant) {
    const data = sourceData;
    delete data._id;
    delete data.folder;
    const marks = { boxId: box.id, sourceUuid: result.entry.uuid, at: Date.now() };
    // A rarity the GM set in the pool editor is the one the reveal and chat
    // announce, so the copy on the sheet says it too (one value, never a
    // "Varies" set). dnd5e 6 stores a set, system.rarities (system.rarity is
    // a getter on it); dnd5e 5 a string. An unedited entry keeps its source's.
    if (overridden) {
      data.system ??= {};
      if (Array.isArray(data.system.rarities)) data.system.rarities = [result.rarity];
      else data.system.rarity = result.rarity;
      marks.sourceRarity = sourceRarity;
      marks.rarityOverride = true;
    }
    data.flags = { ...(data.flags ?? {}), "loot-crates": marks };
    // Foundry's provenance convention for a copy taken from a compendium.
    if (source.pack || String(source.uuid ?? "").startsWith("Compendium.")) {
      data._stats = { ...(data._stats ?? {}), compendiumSource: source.uuid };
    }
    await actor.update({ "system.currency": nextPurse });
    try {
      [created] = await actor.createEmbeddedDocuments("Item", [data]);
    } catch (err) {
      // Charged but not granted: put the coins back before telling anyone.
      // A purchase either charges and grants, or does neither.
      console.error(`loot-crates | granting ${source.name} to ${actor.name} failed after charging ${box.price} gp; returning the coins`, err);
      try {
        await actor.update({ "system.currency": purse });
      } catch (restoreErr) {
        console.error(`loot-crates | could not return ${box.price} gp to ${actor.name}; the GM must refund by hand`, restoreErr);
        throw new PullError("The item couldn't be added and the coins couldn't be returned. Tell the GM.");
      }
      throw new PullError("The item couldn't be added; your coins were returned.");
    }
  }

  return {
    result: { uuid: result.entry.uuid, name: source.name, img: source.img, rarity: result.rarity, pity: result.pity },
    strip,
    purse: nextPurse,
    itemId: created?.id ?? null,
    sourceRarity,
    rarityOverride: overridden,
    state: nextState(box, state, result),
  };
}
