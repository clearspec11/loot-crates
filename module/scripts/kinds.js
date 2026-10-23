/*
  The games of chance this module runs, and what every one of them shares.

  A game record (the `boxes` setting) has a `kind`; a record with none is a
  crate, which is every record written before kinds existed, so settings keep
  their shape. The core does what every game does the same way, once:
    pull.js     the money path on the GM: the guards (gone, sold out, stale
                price, purse), the roll, the charge and payout through one
                settle(), the grant with its rollback
    socket.js   the request, the serial write queue, the ownership and
                cancel guards, the reveal broadcast, the log row
    refund.js   one refund for every kind: coins, item, stock, state, card
    reveal.js   one window, one hold: the sealed chat card, the hidden sheet
                row and the held shop odds until this client's reveal lands
  The kind supplies what differs, through the contract below. The crate
  (crate.js) is the first kind and the Wishing Well (well.js) the second;
  the module API's registerKind lets another module add one.

  Contract (every field but roll is optional; the crate shows each):
    id            the value stored on the record as `kind`
    noun          what a player buys, for messages: "The crate jammed."
    priceOf(ctx)  the price of this play in gp, when it isn't the record's
                  (the deck's draw price rises with each draw in a row);
                  ctx: { game, actor, state, log, today, now }. The core
                  checks the Buy's price against it, charges it, and writes
                  it to the row and the reveal, so a refund gives back what
                  was paid. A kind without one plays at game.price. A Buy
                  whose price the kind names a few seconds either side of
                  `now` (pull.js PRICE_SKEW_MS: clock skew at the deck's
                  streak boundary) is charged at that price, and the roll
                  gets that moment as `now`.
    roll(ctx)     GM side, before anything is charged, so a failed roll costs
                  nothing. ctx: { game, pools, actor, state, rng,
                  resolveSource, onMissing, log, today, now, price }: `log`
                  is the pull log as it stands, `today` the in-game day's
                  key (clock.js; null without a clock), for a game that
                  counts plays per day (the well's cap), `price` what this
                  play costs. Resolves to the outcome:
                    result    what was won, { name, img, rarity?, ... }, or
                              null for nothing (a miss)
                    grant     Item data to create on the actor, or null
                    payoutCp  coins paid out, in copper (none when absent);
                              negative for coins the game takes beyond the
                              stake (the deck's bane), settled in the same
                              move, so a kind never touches the purse
                    state     the buyer's state for this game after the play
                    pools     the pools it was finally rolled from
                  Anything else rides along into performPull's result and
                  the reveal broadcast (the crate's strip and provenance).
                  Throws a PullError for anything the buyer should be told.
    logRow(ctx)   the fields this kind adds to the pull log row, from
                  { game, state, out }; the core writes id, kind, boxId,
                  boxName, actorId, actorName, userId, itemId, price and
                  payoutCp.
    revealExtra(ctx) the fields this kind adds to the reveal broadcast,
                  from the same ctx (the crate: its odds ribbon and the
                  buyer's state before the pull, which the shop holds).
    undo(state, row, log) the buyer's state with the row undone, for a
                  refund; a kind without one leaves the state as it is.
    gotText(out)  what the buyer came away with, as a verb phrase after
                  their name, for the late-cancel messages (socket.js
                  lateCancel): the crate's "got Sling +2" or "got nothing"
                  (the default, from out.result.name), the dice's "rolled
                  4, 6, 5: 15 beats the dragon's 12", the deck's "drew Ruin".
    reveal        the window: { title, head(reveal, { esc }) -> html (the
                  line over the vault; the crate's "Tam opens Crate 150 gp"
                  when absent), play(host, reveal, { sound, pageHidden,
                  onLand }) -> { play, skip, skipped, reducedMotion },
                  result(reveal, { esc, canSee }) -> html, sting(reveal),
                  notice(reveal) -> a quiet word shown to the buyer alone
                  as the result lands (or null), again(reveal, ctx) -> the
                  buyer's next play of the same game straight from the
                  window (the deck's "Draw again for 15 gp"): { price,
                  label, off } with `off` why it can't be played now or "",
                  or null for none; ctx: { game (the record as it stands),
                  log, pools, purse, now, open, gmOnline }. The core shows it to the buyer alone, sends
                  the play as a pull at that price and closes the window
                  once the next one has opened. replayable }. play mounts
                  the animation and calls onLand once when the result is
                  under the marker.
    chat          { card(reveal, { esc, itemLink }) -> html, or null for no
                  chat card; conditional: true when only some outcomes post
                  one (the dice's win), so the seal (reveal.js) hides the
                  whole message until this client lands rather than showing
                  its head with "Opening…", which would tell the result }
    shop          { card(game, pools, ctx) -> html, reason(game, pools,
                  ctx) -> why it can't be bought or "" }; a kind without
                  these gets the crate's card and rules.

  A table game (Roulette, the Auction) is played in rounds the whole
  table stakes on, one resolve settling every stake (round.js, table.js).
  It is a kind with `table: true`; it is staked, never pulled, and the
  money, the hold and the log are still the core's:
    table         true
    priceOf(ctx)  as above, with ctx.bet: what this stake costs (the amount
                  the player chose); the core checks, charges and logs it.
    stake(ctx)    GM side at charge time, optional: { game, actor, bet,
                  round, stakes (the round's live log rows), log, price } ->
                  what the open row keeps of the bet ({ label?, ... }; the
                  row is named by `label`), plus `outbid`: ids of open rows
                  this stake displaces, refunded in the same queued task
                  (the Auction's one open stake per lot), and `closesIn`:
                  ms from now the round's clock is set to in the same task
                  (the Auction's gavel, reset by every bid). Throws a
                  PullError for a bet the round can't take.
    roll(ctx)     GM side at the resolve, once per round: { game, round,
                  stakes (the open rows), rng, log, now, pools, boxes (every
                  game record: the Auction's sealed crate), resolveSource }
                  -> { outcome, grants?, ...whatever the reveal broadcast
                  carries besides }. `grants` (Item data by row id, with
                  its `result`) is for stakes that won an item: the core
                  grants them at the resolve and never broadcasts them.
    settle(ctx)   per open stake that passed the resolve's guards: { game,
                  round, outcome, row, stake, grants } -> { payoutCp,
                  name?, note?, result?, grant?, refundOnFail? }: the
                  coins the character gets back in copper (the stake was
                  taken already, so 0 is a loss and a 1:1 win on 10 gp is
                  2000), what the row is called after, its line in the
                  Pull log, the item it won, if any, and whether a grant
                  that fails hands the stake back (a bid paid for the item
                  alone). Or { refund: reason }: the stake comes back whole
                  (the Auction's reserve not met, "reserve"; its lot gone,
                  "lot"; round.js stakeNote says why in the log).
    openReason(game)  why no round can open on this game yet, or "" (the
                  Auction with no lot); table.js openRound refuses with it.
    hammer        true: the GM's client resolves the round itself once its
                  clock runs out (table.js watchTables), through the same
                  resolveRound, as the Auction's gavel falls.
    tick(ctx), tickMs  GM side, in the write queue, every tickMs while the
                  round takes stakes: { game, round, stakes, rng, now } ->
                  a house stake { label, amount, house, actorName, outbid,
                  closesIn } or null (the Auction's house bidders). The
                  core writes it as an open row with no character and no
                  coins (`house: true`, price 0), refunds what it outbids
                  and moves the clock in the same task, and broadcasts it
                  as a "staked".
    tableView     the shared table window's pieces (tableview.js,
                  tablewindow.js): { title(game), verb ("bets"), words
                  (what the round is doing, in this game's voice, over
                  round.js ROUND_WORDS: { open, closed, waiting, clock(left),
                  held, none }), fields(game, { esc, values }) -> the bet
                  form's fields,
                  pickOptions(game, type, picked, esc), readBet(game,
                  values) -> { bet, price } or a PullError, mount(host, {
                  pockets, esc }) -> { rail(html), spin({ index, onTick,
                  onDrop, onLand, duration, reducedMotion }) -> the play
                  controller }, rail(game, stakes, { esc, outcome, fresh,
                  actorIds }) -> html, pockets(game), pocketsIn(reveal),
                  outcomeIndex(reveal), result(reveal, { esc }) -> html,
                  sting(reveal, { actorIds }), sounds: { tick(progress),
                  drop(), bid()? }, windowMs(game), rarityOf(reveal) }.
                  A kind may also name the window's words: betLabel(game,
                  { stakes, values }) for the bet button (the Auction's
                  "Bid 55 gp"; else "Place a bet"), busyLabel, spinLabel
                  and spinningLabel for the GM's Spin, cancelLabel to give
                  the GM Call it off (table.js cancelRound), sentence(row)
                  and announce(row, { outbid }) for the list and the
                  status line, count(history) for the head (every stake of
                  the round, the beaten ones included), words.void, .list,
                  .stakeOpen and .roundWaiting for the void head, the
                  screen-reader list and the Pull log; and keep its form
                  in step as stakes land (syncForm(form, { game, stakes }),
                  onInput). fields() and readBet() get the live stakes too.
  The window that plays a round plugs into reveal.js setTableWindow.
*/

// The error a player is shown, as one plain sentence. Here so a kind can
// throw it without importing the core (pull.js re-exports it).
export class PullError extends Error {}

export const DEFAULT_KIND = "crate";

const kinds = new Map();

// The kind a game record (or a reveal message, or a log row) is.
export function kindOf(record) {
  const k = record?.kind;
  return typeof k === "string" && k ? k : DEFAULT_KIND;
}

export function registerKind(kind) {
  if (!kind || typeof kind.id !== "string" || !kind.id) throw new Error("loot-crates | a kind needs an id");
  if (typeof kind.roll !== "function") throw new Error(`loot-crates | kind ${kind.id} needs a roll`);
  kinds.set(kind.id, kind);
  return kind;
}

export const getKind = id => kinds.get(id) ?? null;

// "got Sling +2" / "got nothing", or the kind's own phrase (gotText above).
export function gotText(kind, out) {
  const own = typeof kind?.gotText === "function" ? kind.gotText(out) : null;
  return own || `got ${out?.result?.name || "nothing"}`;
}

export const kindIds = () => [...kinds.keys()];

// The kind of a record, or a PullError naming the game when this client
// doesn't know it (a record written by a newer module, or a kind whose
// module is off).
export function kindFor(record) {
  const id = kindOf(record);
  const kind = getKind(id);
  if (!kind) throw new PullError(`${record?.name ?? "That game"} is a kind of game (${id}) this client can't run.`);
  return kind;
}

// For tests: forget every kind but the ones given back.
export function _resetKinds(keep = []) {
  for (const id of [...kinds.keys()]) if (!keep.includes(id)) kinds.delete(id);
}
