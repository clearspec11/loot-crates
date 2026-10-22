/*
  One play of any game, end to end, on a GM client: check the purse, let the
  game's kind decide the outcome, settle the coins, grant the item, record it.
  Everything it needs is passed in, so the live check (foundry-dev/checks) can
  run it against a world where the module isn't installed, and the socket
  handler wraps it with the stores.

  The kind (kinds.js) supplies the roll: what was won, the Item to grant if
  any, and any coins to pay out. This file is the one money path every kind
  runs on: nothing is written until the roll is in hand, the charge and the
  payout are one settle(), and a grant that fails after the charge puts the
  coins back. A purchase either charges and grants, or does neither.
*/
import { kindFor } from "./kinds.js";
// The crate, the well and the dice register themselves when imported: a
// direct caller of performPull (a live check, the module API) finds them
// without loading main.js.
import { sourceRaritiesOf } from "./crate.js";
import "./well.js";
import "./dicegame.js";
import "./deck.js";
import { settle, canAfford, formatPrice } from "./currency.js";

export { PullError } from "./kinds.js";
export { sourceRaritiesOf };
import { PullError } from "./kinds.js";

export function rollRng() {
  const r = globalThis.CONFIG?.Dice?.randomUniform;
  return typeof r === "function" ? r : Math.random;
}

async function resolveSource(uuid) {
  try { return await fromUuid(uuid); } catch { return null; }
}

/*
  `expectedPrice` is the price on the Buy the buyer pressed (socket.js passes
  the pull message's `price`). A GM's price edit runs through the same write
  queue ahead of a pull already in flight, so the box read here can cost more
  or less than the buyer agreed to: such a pull is refused before anything is
  charged, never charged and refunded after. Without one (a direct caller, or
  an older client's message) the box's own price is charged, as before.

  `onMissing(entry)` reaches the kind's roll (the crate re-rolls past an
  entry whose source vanished since the sweep, and the socket handler flags
  it). `grant: false` rolls without writing anything. `log` (the pull log as
  it stands) and `today` (the in-game day's key, store.js todayKey) reach
  the roll too, for a game that counts plays per day.

  The price is the record's, or the kind's for this play (kinds.js priceOf:
  the deck's draw price rises with each draw in a row): the Buy's price is
  checked against it, it is charged, and it comes back as `price` for the
  row and the reveal. A kind's payoutCp may be negative (the deck's bane
  takes coins): the stake and the loss leave the purse in the one settle(),
  never two writes.

  Returns { result, grant?, itemId, purse, payoutCp, price, state, pools,
  kind, ...whatever the kind's roll added } (the crate: strip,
  sourceRarity, rarityOverride). `result` is null when the game gave
  nothing (a miss).
*/
export async function performPull({ box, pools, actor, state = {}, rng = rollRng(), grant = true, onMissing = null, expectedPrice, log = [], today = null }) {
  if (!box) throw new PullError("That box no longer exists.");
  if (!actor) throw new PullError("No character to buy with.");
  if (box.rules?.stock != null && box.rules.stock <= 0) throw new PullError(`${box.name} is sold out.`);
  const kind = kindFor(box);
  const now = Date.now();
  const price = Number(kind.priceOf?.({ game: box, actor, state, log, today, now }) ?? box.price);
  if (expectedPrice != null && Number(expectedPrice) !== price) {
    throw new PullError(`${box.name} now costs ${formatPrice(price)} (you pressed ${formatPrice(expectedPrice)}). Nothing was charged.`);
  }

  // A copy: the live currency object is what actor.update rewrites, and the
  // grant-failure branch below needs the purse as it was before the charge.
  const purse = { ...(actor.system?.currency ?? {}) };
  if (!canAfford(purse, price)) throw new PullError(`${actor.name} can't afford ${box.name}.`);

  const { result = null, grant: data = null, payoutCp: payout, state: nextState, pools: rolledFrom, ...own } = await kind.roll({ game: box, pools, actor, state, rng, resolveSource, onMissing, log, today, now, price });
  const payoutCp = Math.round(Number(payout) || 0);
  const nextPurse = settle(purse, payoutCp - Math.round(price * 100));
  if (!nextPurse) throw new PullError(`${actor.name} can't afford ${box.name}.`);

  let created = null;
  if (grant) {
    await actor.update({ "system.currency": nextPurse });
    if (data) {
      try {
        [created] = await actor.createEmbeddedDocuments("Item", [data]);
      } catch (err) {
        // Charged but not granted: put the coins back before telling anyone.
        // A purchase either charges and grants, or does neither.
        console.error(`loot-crates | granting ${result?.name ?? data.name} to ${actor.name} failed after charging ${price} gp; returning the coins`, err);
        try {
          await actor.update({ "system.currency": purse });
        } catch (restoreErr) {
          console.error(`loot-crates | could not return ${price} gp to ${actor.name}; the GM must refund by hand`, restoreErr);
          throw new PullError("The item couldn't be added and the coins couldn't be returned. Tell the GM.");
        }
        throw new PullError("The item couldn't be added; your coins were returned.");
      }
    }
  }

  return {
    ...own,
    result,
    purse: nextPurse,
    itemId: created?.id ?? null,
    payoutCp,
    price,
    state: nextState,
    pools: rolledFrom ?? pools,
    kind: kind.id,
  };
}
