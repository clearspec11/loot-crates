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
import { kindFor, grantsOf, readyToGrant } from "../games/kinds.js";
// The crate, the well and the dice register themselves when imported: a
// direct caller of performPull (a live check, the module API) finds them
// without loading main.js.
import { sourceRaritiesOf } from "../games/crate.js";
import "../games/well.js";
import "../games/dicegame.js";
import "../games/deck.js";
import "../games/roulette.js";
import "../games/auction.js";
import "../games/scratch.js";
import { settle, canAfford, formatPrice } from "../core/currency.js";
import { limitState, limitRefusal } from "../core/limits.js";
import { onShelf, shelfRefusal } from "../core/shelf.js";
import { t } from "../core/i18n.js";
import { spendTicket, keepTicket } from "./tickets.js";
import { ticketOf } from "../games/ticket.js";

export { PullError } from "../games/kinds.js";
export { sourceRaritiesOf };
import { PullError } from "../games/kinds.js";

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

  Returns { result, itemId, itemIds, itemNames, purse, payoutCp, price,
  priceNote, state, pools, kind, ...whatever the kind's roll added } (the
  crate: strip, sourceRarity, rarityOverride). `result` is null when the
  game gave nothing (a miss). `itemIds` are every item the play created
  (a kind's `grants`: several, one creation), `itemId` the first, so
  anything that reads one item reads it as before.
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
  boundary (else null). A `ticket` play (performPull) skips the shelf,
  the stock and the price: it costs nothing, the ticket is its payment.
  A `kept` ticket's play skips the limit per character too: its Buy to
  keep was the purchase the limit counted (limits.js boughtBy).
*/
function guardPlay({ box, actor, state = {}, expectedPrice, log = [], today = null, bet, ticket = false, kept = false }) {
  if (!box) throw new PullError(t("LOOTCRATES.Error.BoxGone"));
  if (!ticket && !onShelf(box)) throw new PullError(shelfRefusal(box));
  if (!actor) throw new PullError(t("LOOTCRATES.Error.NoActor"));
  if (!ticket && box.rules?.stock != null && box.rules.stock <= 0) throw new PullError(t("LOOTCRATES.Error.SoldOut", { name: box.name }));
  const kind = kindFor(box);
  const limit = kept ? null : limitState(box, { log, actorId: actor.id, today });
  if (limit?.reached) throw new PullError(limitRefusal(box, limit, actor.name));
  // A ticket was paid for already (or handed out): the play costs nothing.
  if (ticket) return { kind, price: 0, purse: { ...(actor.system?.currency ?? {}) }, now: Date.now(), priceNote: null };
  const priceAt = at => Number(kind.priceOf?.({ game: box, actor, state, log, today, now: at, bet }) ?? box.price);
  let now = Date.now();
  let price = priceAt(now);
  let priceNote = null;
  if (expectedPrice != null && Number(expectedPrice) !== price) {
    const pressed = Number(expectedPrice);
    const near = kind.priceOf ? [now - PRICE_SKEW_MS, now + PRICE_SKEW_MS].find(at => priceAt(at) === pressed) : undefined;
    if (near == null) throw new PullError(t("LOOTCRATES.Error.PriceChanged", { name: box.name, price: formatPrice(price), pressed: formatPrice(expectedPrice) }), { stalePrice: price });
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

/*
  Creates a play's items on the actor in one call, each marked the way
  Plutonium's own opt-out is (kinds.js readyToGrant), and returns the
  created documents. Another module's preCreateItem hook can cancel a
  creation by returning false: Foundry then returns fewer documents than
  asked, with no error. That is a failed grant, the same as a throw: any
  that were created are deleted again and this throws, so the caller puts
  the coins back. A play is granted whole or not at all.
*/
export async function createGrants(actor, datas) {
  const docs = datas.map(readyToGrant);
  const created = ((await actor.createEmbeddedDocuments("Item", docs)) ?? []).filter(Boolean);
  if (created.length === docs.length) return created;
  if (created.length) {
    try {
      await actor.deleteEmbeddedDocuments("Item", created.map(d => d.id));
    } catch (err) {
      const names = created.map(d => d.name).join(", ");
      console.error(`loot-crates | could not take ${names} back from ${actor.name} after a cancelled grant; remove by hand`, err);
      globalThis.ui?.notifications?.error(t("LOOTCRATES.Error.GrantRollbackFailed", { items: names, actor: actor.name }));
    }
  }
  throw new Error(`the creation made ${created.length} of ${docs.length} items: another module's preCreateItem hook cancelled it`);
}

/*
  `ticket` (an Item on the actor, foundry/tickets.js) plays the game with a
  ticket instead of coins: the guards are a purchase's but for the shelf
  and the stock (a ticket is in the pack, already sold), the price is 0,
  and the ticket is the payment: one is spent (spendTicket) before the
  grant, as the coins are charged, and put back with any payout if the
  grant fails. The kind's own guards (a sold-out scratch roll, the well's
  daily cap) refuse in its roll, before anything is spent.
*/
export async function performPull({ box, pools, actor, state = {}, rng = rollRng(), grant = true, onMissing = null, expectedPrice, log = [], today = null, ticket = null }) {
  const { kind, price, purse, now, priceNote } = guardPlay({ box, actor, state, expectedPrice, log, today, ticket: !!ticket, kept: !!ticketOf(ticket)?.kept });
  // A table game is played in rounds (table.js): its roll settles every
  // stake at once, so it is staked, never pulled.
  if (kind.table) throw new PullError(t("LOOTCRATES.Error.TableGame", { name: box.name }));

  const rolled = await kind.roll({ game: box, pools, actor, state, rng, resolveSource, onMissing, log, today, now, price });
  const { result = null, payoutCp: payout, state: nextState, pools: rolledFrom, ...own } = rolled;
  const datas = grantsOf(rolled);
  // The Item data is created here, never broadcast.
  delete own.grant;
  delete own.grants;
  const payoutCp = Math.round(Number(payout) || 0);
  const delta = payoutCp - Math.round(price * 100);
  // A ticket's play that pays nothing moves no coins at all.
  const nextPurse = ticket && !delta ? purse : settle(purse, delta);
  if (!nextPurse) throw new PullError(t("LOOTCRATES.Error.CantAfford", { actor: actor.name, name: box.name }));

  if (ticket && grant) return { ...own, ...(await playTicket({ actor, ticket, purse, nextPurse, delta, datas, result })), result, payoutCp, price, priceNote, state: nextState, pools: rolledFrom ?? pools, kind: kind.id };

  let created = [];
  if (grant) {
    await actor.update({ "system.currency": nextPurse });
    if (datas.length) {
      try {
        created = await createGrants(actor, datas);
      } catch (err) {
        // Charged but not granted: put the coins back before telling anyone.
        // A purchase either charges and grants, or does neither.
        console.error(`loot-crates | granting ${result?.name ?? datas.map(d => d.name).join(", ")} to ${actor.name} failed after charging ${price} gp; returning the coins`, err);
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
    itemId: created[0]?.id ?? null,
    itemIds: created.map(d => d.id),
    itemNames: created.map(d => d.name),
    payoutCp,
    price,
    priceNote,
    state: nextState,
    pools: rolledFrom ?? pools,
    kind: kind.id,
  };
}

/*
  A ticket's payment and grant: one ticket spent, any payout settled, the
  items created; a failure at any step puts back what the steps before it
  wrote (the coins, then the ticket), so the ticket is spent only when the
  play goes through. Returns what performPull adds for a purchase: purse,
  itemId, itemIds, itemNames.
*/
async function playTicket({ actor, ticket, purse, nextPurse, delta, datas, result }) {
  let giveBack;
  try {
    giveBack = await spendTicket(actor, ticket);
  } catch (err) {
    console.error(`loot-crates | spending ${ticket?.name} on ${actor.name} failed; nothing was played`, err);
    throw new PullError(t("LOOTCRATES.Ticket.SpendFailed"));
  }
  let paid = false;
  let created = [];
  try {
    if (delta) { await actor.update({ "system.currency": nextPurse }); paid = true; }
    if (datas.length) created = await createGrants(actor, datas);
  } catch (err) {
    console.error(`loot-crates | granting ${result?.name ?? datas.map(d => d.name).join(", ")} to ${actor.name} for ${ticket?.name} failed; putting the ticket back`, err);
    try {
      if (paid) await actor.update({ "system.currency": purse });
      await giveBack();
    } catch (restoreErr) {
      console.error(`loot-crates | could not put ${ticket?.name} back on ${actor.name}; the GM must make it again`, restoreErr);
      throw new PullError(t("LOOTCRATES.Ticket.GrantAndRestoreFailed"));
    }
    throw new PullError(t("LOOTCRATES.Ticket.GrantFailed"));
  }
  return { purse: nextPurse, itemId: created[0]?.id ?? null, itemIds: created.map(d => d.id), itemNames: created.map(d => d.name) };
}

/*
  Buy to keep, on the GM inside the write queue: a purchase that plays
  nothing now. The guards are a purchase's, all of them (the shelf, the
  stock, the limit per character, the price on the button, the purse), the
  price leaves the purse in one settle(), and a ticket to the game goes
  into the character's pack (tickets.js keepTicket: onto a kept stack of
  the same game at the same price, else a new item) in place of a roll.
  Nothing is rolled: a scratch roll's ticket is drawn when the ticket is
  used, and the game's own reasons (the well's cap, a sold-out roll) are
  the shop's to show and the use's to check. A ticket that can't be put
  in the pack puts the coins back. The caller writes the log row in the
  same task, and undoes both (`undo`, then `before`) if it can't.

  Returns { purse, before, price, priceNote, kind, item, stacked, undo }:
  `item` the ticket stack it went onto.
*/
export async function performKeep({ box, actor, state = {}, expectedPrice, log = [], today = null }) {
  const { kind, price, purse, priceNote } = guardPlay({ box, actor, state, expectedPrice, log, today });
  if (kind.table) throw new PullError(t("LOOTCRATES.Error.TableGame", { name: box.name }));
  const nextPurse = settle(purse, -Math.round(price * 100));
  if (!nextPurse) throw new PullError(t("LOOTCRATES.Error.CantAfford", { actor: actor.name, name: box.name }));
  const charge = Math.round(price * 100) > 0;
  if (charge) await actor.update({ "system.currency": nextPurse });
  let kept;
  try {
    kept = await keepTicket(actor, box, price);
  } catch (err) {
    console.error(`loot-crates | putting a ${box.name} ticket in ${actor.name}'s pack failed; returning the coins`, err);
    try { if (charge) await actor.update({ "system.currency": purse }); } catch (restoreErr) {
      console.error(`loot-crates | could not return ${price} gp to ${actor.name}; the GM must refund by hand`, restoreErr);
      throw new PullError(t("LOOTCRATES.Keep.FailedAndRestoreFailed"));
    }
    throw new PullError(t("LOOTCRATES.Keep.Failed"));
  }
  return { purse: charge ? nextPurse : purse, before: purse, price, priceNote, kind: kind.id, ...kept };
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
