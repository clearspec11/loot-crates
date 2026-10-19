/*
  One purchase, end to end, on a GM client: check the purse, roll the result,
  deduct the coins, grant the item, record it. Everything it needs is passed in,
  so the live check (foundry-dev/checks) can run it against a world where the
  module isn't installed, and the socket handler wraps it with the stores.
*/
import { draw, nextState } from "./odds.js";
import { buildStrip } from "./strip.js";
import { charge, canAfford } from "./currency.js";

export class PullError extends Error {}

export function rollRng() {
  const r = globalThis.CONFIG?.Dice?.randomUniform;
  return typeof r === "function" ? r : Math.random;
}

export async function performPull({ box, pools, actor, state = {}, rng = rollRng(), grant = true }) {
  if (!box) throw new PullError("That box no longer exists.");
  if (!actor) throw new PullError("No character to buy with.");
  if (box.rules?.stock != null && box.rules.stock <= 0) throw new PullError(`${box.name} is sold out.`);

  // A copy: the live currency object is what actor.update rewrites, and the
  // grant-failure branch below needs the purse as it was before the charge.
  const purse = { ...(actor.system?.currency ?? {}) };
  if (!canAfford(purse, box.price)) throw new PullError(`${actor.name} can't afford ${box.name}.`);

  const result = draw({ box, pools, rng, state });
  if (!result) throw new PullError(`${box.name} has nothing left to give ${actor.name}.`);

  const source = await fromUuid(result.entry.uuid);
  if (!source) throw new PullError(`${result.entry.name} is missing from its compendium. Tell the GM.`);

  const nextPurse = charge(purse, box.price);
  const strip = buildStrip({ result, box, pools, rng });

  let created = null;
  if (grant) {
    const data = source.toObject();
    delete data._id;
    delete data.folder;
    data.flags = { ...(data.flags ?? {}), "loot-crates": { boxId: box.id, sourceUuid: result.entry.uuid, at: Date.now() } };
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
    state: nextState(box, state, result),
  };
}
