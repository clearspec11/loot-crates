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
import "./roulette.js";
import "./auction.js";
import { settle, canAfford, formatPrice } from "./currency.js";
import { limitState, limitRefusal } from "./limits.js";
import { onShelf, shelfRefusal } from "./shelf.js";
import { t } from "./i18n.js";

export { PullError } from "./kinds.js";
export { sourceRaritiesOf };
import { PullError } from "./kinds.js";

export function rollRng() {
  const r = globalThis.CONFIG?.Dice?.randomUniform;
  return typeof r === "function" ? r : Math.random;
}

// A pool entry's source (fromUuid in a world), null when it is gone. The
// table's resolve (table.js) hands it to a kind that draws items there.
export async function resolveSource(uuid) {
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

  Returns { result, grant?, itemId, purse, payoutCp, price, priceNote,
  state, pools, kind, ...whatever the kind's roll added } (the crate: strip,
  sourceRarity, rarityOverride). `result` is null when the game gave
  nothing (a miss).
*/
/*
  How far either side of the GM's clock a pressed price still counts. A
  kind's price can turn on the clock (the deck's streak: two minutes from
  the last draw's row.at, stamped by the GM), and the buyer's client reads
  that window on its own clock, so skew between the two, or the trip to
  the GM, could refuse a press made just as the price changed. A pressed
  price the kind names within PRICE_SKEW_MS of now is charged, and the
  buyer is told which price that was.
*/
export const PRICE_SKEW_MS = 5000;

/*
  The guards every play passes before anything is charged, pull or stake:
  the game exists and is on the shelf (shelf.js: a game the GM took off
  it is refused for a shop drawn before that, or a request made by hand),
  there is a character, it isn't sold out, this character
  hasn't reached its limit (limits.js: counted from `log`, the unrefunded
  rows as they stand in the queue, and for a limit per day `today`; a
  table game has none), the price is
  the one on the button pressed (the kind's priceOf, or the record's; at
  a boundary of a clock-driven price, either side of it, PRICE_SKEW_MS),
  and the purse covers it. `bet` reaches priceOf for a table stake, whose
  price is what the player chose to stake. Returns { kind, price, purse,
  now, priceNote }, `purse` a copy of the coins as they were before the
  charge, `now` the moment the charged price is the kind's at (the roll
  reads it, so the deck's streak matches what was paid), and `priceNote`
  the buyer's line when the pressed price was the other side of a
  boundary (else null).
*/
function guardPlay({ box, actor, state = {}, expectedPrice, log = [], today = null, bet }) {
  if (!box) throw new PullError(t("LOOTCRATES.Error.BoxGone"));
  if (!onShelf(box)) throw new PullError(shelfRefusal(box));
  if (!actor) throw new PullError(t("LOOTCRATES.Error.NoActor"));
  if (box.rules?.stock != null && box.rules.stock <= 0) throw new PullError(t("LOOTCRATES.Error.SoldOut", { name: box.name }));
  const kind = kindFor(box);
  const limit = limitState(box, { log, actorId: actor.id, today });
  if (limit?.reached) throw new PullError(limitRefusal(box, limit, actor.name));
  const priceAt = at => Number(kind.priceOf?.({ game: box, actor, state, log, today, now: at, bet }) ?? box.price);
  let now = Date.now();
  let price = priceAt(now);
  let priceNote = null;
  if (expectedPrice != null && Number(expectedPrice) !== price) {
    const pressed = Number(expectedPrice);
    const near = kind.priceOf ? [now - PRICE_SKEW_MS, now + PRICE_SKEW_MS].find(at => priceAt(at) === pressed) : undefined;
    if (near == null) throw new PullError(t("LOOTCRATES.Error.PriceChanged", { name: box.name, price: formatPrice(price), pressed: formatPrice(expectedPrice) }));
    priceNote = t("LOOTCRATES.Error.PriceNote", { pressed: formatPrice(pressed), name: box.name, price: formatPrice(price) });
    now = near;
    price = pressed;
  }
  // A copy: the live currency object is what actor.update rewrites, and the
  // grant-failure branch below needs the purse as it was before the charge.
  const purse = { ...(actor.system?.currency ?? {}) };
  if (!canAfford(purse, price)) throw new PullError(t("LOOTCRATES.Error.CantAfford", { actor: actor.name, name: box.name }));
  return { kind, price, purse, now, priceNote };
}

export async function performPull({ box, pools, actor, state = {}, rng = rollRng(), grant = true, onMissing = null, expectedPrice, log = [], today = null }) {
  const { kind, price, purse, now, priceNote } = guardPlay({ box, actor, state, expectedPrice, log, today });
  // A table game is played in rounds (table.js): its roll settles every
  // stake at once, so it is staked, never pulled.
  if (kind.table) throw new PullError(t("LOOTCRATES.Error.TableGame", { name: box.name }));

  const { result = null, grant: data = null, payoutCp: payout, state: nextState, pools: rolledFrom, ...own } = await kind.roll({ game: box, pools, actor, state, rng, resolveSource, onMissing, log, today, now, price });
  const payoutCp = Math.round(Number(payout) || 0);
  const nextPurse = settle(purse, payoutCp - Math.round(price * 100));
  if (!nextPurse) throw new PullError(t("LOOTCRATES.Error.CantAfford", { actor: actor.name, name: box.name }));

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
          throw new PullError(t("LOOTCRATES.Error.GrantAndRestoreFailed"));
        }
        throw new PullError(t("LOOTCRATES.Error.GrantFailed"));
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
    priceNote,
    state: nextState,
    pools: rolledFrom ?? pools,
    kind: kind.id,
  };
}

/*
  A stake at a table game (kinds.js `table: true`), on the GM inside the
  write queue: the same guards as a pull, then the kind's stake check (the
  bet is valid for this round; an Auction's bid beats the lot's best), then
  the stake leaves the purse in one settle(). Nothing is rolled: the
  round's one resolve settles every stake (table.js). The caller writes the
  open log row in the same task, so the coins are never without a row.

  `round` is the round being staked on and `stakes` its live stakes (log
  rows), for the kind's check. Returns { purse, before, price, stake,
  outbid, kind } (`before` the purse as it was, should the row fail):
  `stake` what the row keeps of the bet ({ bet } when the kind says
  nothing), `outbid` the ids of open rows this stake displaces, which the
  caller refunds in the same task (the Auction: one open stake per lot),
  and `closesIn` (ms, or null) the round's clock from now, which the caller
  sets in the same task (the Auction's gavel, reset by every bid).
*/
export async function performStake({ box, actor, round, bet = null, stakes = [], expectedPrice, log = [], today = null }) {
  const { kind, price, purse } = guardPlay({ box, actor, expectedPrice, log, today, bet });
  if (!kind.table) throw new PullError(t("LOOTCRATES.Error.NotTable", { name: box.name }));
  if (!(price > 0)) throw new PullError(t("LOOTCRATES.Error.StakeNothing", { name: box.name }));
  const checked = kind.stake?.({ game: box, actor, bet, round, stakes, log, price }) ?? {};
  const { outbid = [], closesIn = null, ...stake } = checked;
  const nextPurse = settle(purse, -Math.round(price * 100));
  if (!nextPurse) throw new PullError(t("LOOTCRATES.Error.CantAfford", { actor: actor.name, name: box.name }));
  await actor.update({ "system.currency": nextPurse });
  return { purse: nextPurse, before: purse, price, stake: Object.keys(stake).length ? stake : { bet }, outbid, closesIn, kind: kind.id };
}
