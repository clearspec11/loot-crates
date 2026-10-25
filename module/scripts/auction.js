/*
  The Auction (VIB-192): the second table kind (kinds.js `table: true`),
  played in rounds on the core's escrow (round.js, table.js) and shown in
  the shared table window (tablewindow.js) with its own words. The GM lists
  one lot, the table bids against each other and any house bidders while a
  gavel drains, and only the winner pays.

  - The lot is an item (a pool entry, or an item dragged into the editor)
    or a sealed crate (one of the GM's crates, opened for the winner at the
    hammer with the crate's own roll and strip). The record keeps a copy of
    what the board shows (name, art, rarity), so a player's client needs no
    other record to draw it.
  - A bid is a stake (socket.js doStake): it holds its amount as an open
    log row, charged in the write queue. A higher bid, by anyone, refunds
    the bid it beats in the same queued task (kinds.js stake `outbid`), so
    a lot never holds more than one open stake. A bid must be at least the
    top bid plus the increment (the opening bid when there is none), within
    the purse (the core's guard), and a character can't outbid themselves.
    Losing bids are never charged: they were held, and every one that is
    beaten comes back at once.
  - The gavel is the round's clock. Each bid sets it to now plus the gavel
    time in the same task (kinds.js stake `closesIn`), so every bid buys
    the table that long again. When it runs out the GM's client brings it
    down itself (`hammer`, table.js watchTables): the round's one resolve.
  - House bidders are the GM's: a count, each one's budget, and a chance to
    bid on each tick (`tick`, every HOUSE_TICK_MS), all rolled on the GM
    inside the write queue. A house bidder only ever bids against a player
    (never against another house bidder, so the house never runs a lot up
    on its own) and never past its budget. A house bid is a log row with no
    character and no coins (`house: true`, price 0, its amount on the
    stake); it outbids and is outbid like any other.
  - At the hammer the one open stake settles: a player's wins the lot (the
    item is granted by the core, or the crate is rolled and its item
    granted, and the strip plays for everyone), paying exactly the bid. A
    house win, a reserve not met, or a lot that is gone refunds it (round.js
    planResolve `refund`). An item that can't be put on the sheet refunds
    it too (`refundOnFail`). The GM's ordinary Refund in the Pull log
    undoes a win: the bid back, the item taken off the sheet.
  - The GM can bring the gavel down early (the window's primary button) or
    call the auction off (every open bid refunded, table.js cancelRound).

  Record: { kind: "auction", price (the opening bid, gp), pools: [],
  auction: { lot: { type: "item", uuid, name, img, rarity, rarityOverride? }
  | { type: "crate", boxId, name }, increment (gp), reserve (gp, 0: none),
  gavelSec, house: { count, budget (gp, each), chance (percent a tick) } } }.

  No Foundry globals: the core passes the pools, the records, the source
  resolver and the log.
*/
import { RARITY_LABEL, RARITIES } from "./config.js";
import { normalizeRarity, effectiveRarity } from "./odds.js";
import { formatPrice, canAfford, shortfall } from "./currency.js";
import { playTick, playDrop, playReveal } from "./sound.js";
import { cardShell, shopReason } from "./boxcard.js";
import { grantData, CRATE } from "./crate.js";
import { mountSpin } from "./spin.js";
import { liveRoundOf, isOpenStake, roundState as tableRoundState, clockText } from "./round.js";
import { PullError, registerKind } from "./kinds.js";
import { t, words } from "./i18n.js";

export const AUCTION_DEFAULTS = { price: 10, increment: 5, reserve: 0, gavelSec: 20, house: { count: 0, budget: 100, chance: 25 } };
// How often the house bidders get their chance, on the GM (table.js watchTables).
export const HOUSE_TICK_MS = 2000;
// The fewest seconds a gavel may be: a player needs time to answer a bid.
export const MIN_GAVEL_SEC = 5;
export const MAX_HOUSE = 6;
// The gavel's strike at the hammer, before a sealed crate's strip runs.
export const HAMMER_MS = 650;

const num = (v, d = 0) => (v !== "" && v != null && Number.isFinite(Number(v)) ? Number(v) : d);
const toCp = gp => Math.round(num(gp) * 100);
const gp2 = n => Math.round(n * 100) / 100;

/* ---------- The record as written ---------- */

export const incrementOf = game => { const n = gp2(num(game?.auction?.increment, AUCTION_DEFAULTS.increment)); return n > 0 ? n : 1; };
// The opening bid: the record's price, or the increment when it is nothing
// (the core refuses a stake of nothing).
export const openingOf = game => { const n = gp2(num(game?.price, AUCTION_DEFAULTS.price)); return n > 0 ? n : incrementOf(game); };
export const reserveOf = game => Math.max(0, gp2(num(game?.auction?.reserve, 0)));
export const gavelMsOf = game => Math.max(MIN_GAVEL_SEC, Math.round(num(game?.auction?.gavelSec, AUCTION_DEFAULTS.gavelSec))) * 1000;
export function houseOf(game) {
  const h = game?.auction?.house ?? {};
  return {
    count: Math.min(MAX_HOUSE, Math.max(0, Math.floor(num(h.count, AUCTION_DEFAULTS.house.count)))),
    budget: Math.max(0, gp2(num(h.budget, AUCTION_DEFAULTS.house.budget))),
    chance: Math.min(100, Math.max(0, num(h.chance, AUCTION_DEFAULTS.house.chance))),
  };
}
export const houseName = n => t("LOOTCRATES.Auction.HouseBidder", { n });

// The lot in one shape, or null when the record has none it can sell.
export function lotOf(game) {
  const lot = game?.auction?.lot;
  if (lot?.type === "crate" && lot.boxId) return { type: "crate", boxId: String(lot.boxId), name: String(lot.name ?? "") || t("LOOTCRATES.Auction.ACrate"), img: "", rarity: "none" };
  if (lot?.type === "item" && lot.uuid) {
    const rarity = normalizeRarity(lot.rarityOverride ?? lot.rarity);
    return { type: "item", uuid: String(lot.uuid), name: String(lot.name ?? "") || t("LOOTCRATES.Auction.AnItem"), img: String(lot.img ?? ""), rarity, ...(RARITIES.includes(lot.rarityOverride) ? { rarityOverride: lot.rarityOverride } : {}) };
  }
  return null;
}

// A pool entry as a lot (the editor's list), its rarity the one the pool shows.
export function lotFromEntry(entry) {
  const over = RARITIES.includes(entry?.rarityOverride) ? { rarityOverride: entry.rarityOverride } : {};
  return { type: "item", uuid: entry.uuid, name: entry.name, img: entry.img ?? "", rarity: effectiveRarity(entry), ...over };
}
// One of the GM's crates as a lot, its name kept for the board.
export const lotFromCrate = box => ({ type: "crate", boxId: box.id, name: box.name });

// "Sling +2" / "A sealed Adventurer's Crate": the lot as the board and the card name it.
export const lotName = lot => (!lot ? t("LOOTCRATES.Auction.NoLot") : lot.type === "crate" ? t("LOOTCRATES.Auction.Sealed", { name: lot.name }) : lot.name);
// "Uncommon" / "Opened for the winner at the hammer": the line under it.
export const lotLine = lot => (!lot ? "" : lot.type === "crate" ? t("LOOTCRATES.Auction.OpenedForWinner") : RARITY_LABEL[lot.rarity] ?? "");

/* ---------- Bids ---------- */

// What a bid row bids: its stake's amount (a house bid holds no coins), else its price.
export const amountOf = row => num(row?.stake?.amount ?? row?.price, 0);

// The open bid on top of the lot (one at most; the highest if ever two).
export function leaderOf(stakes = []) {
  let top = null;
  for (const r of stakes) if (isOpenStake(r) && (!top || toCp(amountOf(r)) > toCp(amountOf(top)))) top = r;
  return top;
}

// The least the next bid can be: the top bid plus the increment, or the opening bid.
export function minBid(game, stakes = []) {
  const top = leaderOf(stakes);
  return top ? gp2(amountOf(top) + incrementOf(game)) : openingOf(game);
}

/*
  A bid the GM takes, checked inside the write queue (kinds.js stake): the
  lot exists, the character doesn't already hold the top bid, and the bid
  is at least the next legal amount. Two bids at the same amount queued
  together: the first takes it, the second is refused here naming the new
  least bid. Returns the amount.
*/
export function bidCheck(game, { actor, stakes = [], price }) {
  if (!lotOf(game)) throw new PullError(t("LOOTCRATES.Auction.NoLotError", { name: game.name }));
  const top = leaderOf(stakes);
  if (top && !top.house && top.actorId === actor?.id) throw new PullError(t("LOOTCRATES.Auction.AlreadyTop", { name: actor?.name ?? t("LOOTCRATES.Roulette.ThisCharacter"), price: formatPrice(amountOf(top)) }));
  const min = minBid(game, stakes);
  if (!(toCp(price) >= toCp(min))) {
    throw new PullError(top
      ? t("LOOTCRATES.Auction.BidIsNow", { price: formatPrice(amountOf(top)), name: top.actorName, min: formatPrice(min) })
      : t("LOOTCRATES.Auction.OpeningIs", { name: game.name, min: formatPrice(min) }));
  }
  return gp2(num(price));
}

// kinds.js priceOf: what this bid holds, the amount the player chose.
const priceOf = ({ game, bet }) => { const n = num(bet?.amount); return n > 0 ? gp2(n) : openingOf(game); };

// kinds.js stake: the row's bid, the open bid it beats, and the gavel reset.
function stake(ctx) {
  const amount = bidCheck(ctx.game, ctx);
  return { label: t("LOOTCRATES.Auction.Bid", { price: formatPrice(amount) }), amount, outbid: (ctx.stakes ?? []).filter(isOpenStake).map(r => r.id), closesIn: gavelMsOf(ctx.game) };
}

/*
  The house's turn (kinds.js tick), on the GM inside the write queue, every
  HOUSE_TICK_MS while bids are taken: when a player holds the top bid and
  the next legal bid is within the house's budget, each house bidder (in
  an order the rng shuffles) gets its chance; the first that takes it bids
  the next legal amount. Returns the house bid ({ label, amount, house,
  actorName, outbid, closesIn }) or null.
*/
export function houseBid({ game, stakes = [], rng = Math.random }) {
  const house = houseOf(game);
  if (!house.count || !house.chance || !lotOf(game)) return null;
  const top = leaderOf(stakes);
  if (!top || top.house) return null;
  const min = minBid(game, stakes);
  if (toCp(min) > toCp(house.budget)) return null;
  const order = Array.from({ length: house.count }, (_, i) => i + 1);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  for (const n of order) {
    if (rng() * 100 < house.chance) return { label: t("LOOTCRATES.Auction.Bid", { price: formatPrice(min) }), amount: min, house: n, actorName: houseName(n), outbid: [top.id], closesIn: gavelMsOf(game) };
  }
  return null;
}

/* ---------- The hammer ---------- */

/*
  The round's one resolve (kinds.js roll), on the GM, once: the open bid
  on top decides it. { outcome: { verdict: "sold" | "house" | "reserve" |
  "none" | "lot", lot, amount, leaderId, bidder, actorId, house,
  reserve (has one), reserveMet, bids (every bid of the round), result
  (what the winner got: the item, or the crate's draw, null for a crate
  that found nothing) }, grants, strip? }. A sealed crate is rolled here
  with the crate's own roll, as a fresh pull (it counts toward no pity at
  that crate and takes none of its stock), and its strip rides along in
  the broadcast so every client sees the winner's crate open. The grant
  goes to the core by row id, never in the broadcast.
*/
async function roll({ game, round, stakes = [], rng = Math.random, pools = {}, resolveSource = null, boxes = {}, log = [] }) {
  const lot = lotOf(game);
  const top = leaderOf(stakes);
  const view = lot?.type === "crate" ? { ...lot, name: boxes[lot.boxId]?.name ?? lot.name } : lot;
  const base = {
    lot: view, bids: log.filter(r => r?.roundId && r.roundId === round?.id).length,
    amount: top ? amountOf(top) : 0, leaderId: top?.id ?? null, bidder: top?.actorName ?? null, actorId: top?.actorId ?? null, house: !!top?.house,
    reserve: reserveOf(game) > 0, reserveMet: !!top && toCp(amountOf(top)) >= toCp(reserveOf(game)), result: null,
  };
  if (!top) return { outcome: { ...base, verdict: "none" } };
  if (top.house) return { outcome: { ...base, verdict: "house" } };
  if (!base.reserveMet) return { outcome: { ...base, verdict: "reserve" } };
  const find = typeof resolveSource === "function" ? resolveSource : async () => null;
  if (lot?.type === "crate") {
    const crate = boxes[lot.boxId];
    if (!crate) return { outcome: { ...base, verdict: "lot" } };
    let out;
    try {
      out = await CRATE.roll({ game: crate, pools, actor: { id: top.actorId, name: top.actorName }, state: {}, rng, resolveSource: find, onMissing: null });
    } catch (err) {
      if (!(err instanceof PullError)) throw err;
      return { outcome: { ...base, verdict: "lot", why: err.message } };
    }
    const grants = out.grant ? { [top.id]: { result: out.result, grant: out.grant } } : {};
    return { outcome: { ...base, verdict: "sold", result: out.result ?? null }, strip: out.strip ?? null, grants };
  }
  const source = lot ? await find(lot.uuid) : null;
  if (!source) return { outcome: { ...base, verdict: "lot" } };
  const g = grantData(source, { entry: { uuid: lot.uuid, rarity: lot.rarity, rarityOverride: lot.rarityOverride ?? null }, rarity: lot.rarity, pity: false }, game);
  return { outcome: { ...base, verdict: "sold", result: g.result }, grants: { [top.id]: { result: g.result, grant: g.grant } } };
}

/*
  Each open stake at the hammer (kinds.js settle): the winner pays the bid
  (payout 0) and gets the lot; the house's bid holds nothing either way;
  any other open player bid (there is none, one stake per lot) and a sale
  that didn't happen come back (`refund`, with its reason for the log).
*/
function settle({ outcome, row, grants = {} }) {
  const amount = formatPrice(amountOf(row));
  if (row.house) {
    const won = outcome?.verdict === "house" && row.id === outcome.leaderId;
    return { payoutCp: 0, name: won ? t("LOOTCRATES.Auction.WonByHouse", { price: amount }) : t("LOOTCRATES.Auction.HouseBid", { price: amount }), note: t("LOOTCRATES.Log.HouseBid") };
  }
  if (!outcome || row.id !== outcome.leaderId) return { refund: "outbid" };
  if (outcome.verdict === "reserve") return { refund: "reserve" };
  if (outcome.verdict !== "sold") return { refund: "lot" };
  const g = grants[row.id] ?? null;
  const name = g?.result?.name ?? (outcome.lot?.type === "crate" ? t("LOOTCRATES.Auction.CrateNothing", { name: outcome.lot.name }) : outcome.lot?.name ?? t("LOOTCRATES.Auction.TheLot"));
  return { payoutCp: 0, name, note: t("LOOTCRATES.Auction.WonAtHammer", { price: amount }), refundOnFail: true, ...(g ? { result: g.result, grant: g.grant } : {}) };
}

/* ---------- Words ---------- */

// The auction's words for what the round is doing (round.js roundState),
// on the shop card and in the table window's head; the countdown is the
// gavel, a timer, never announced each second (tableview.js).
export const AUCTION_WORDS = Object.assign(words({
  none: "LOOTCRATES.Auction.WordsNone",
  open: "LOOTCRATES.Auction.WordsOpen",
  closed: "LOOTCRATES.Auction.WordsClosed",
  waiting: "LOOTCRATES.Auction.WordsWaiting",
  held: "LOOTCRATES.Auction.WordsHeld",
  void: "LOOTCRATES.Auction.WordsVoid",
  list: "LOOTCRATES.Auction.WordsList",
  stakeOpen: "LOOTCRATES.Auction.WordsStakeOpen",
  roundWaiting: "LOOTCRATES.Auction.WordsRoundWaiting",
}), { clock: left => t("LOOTCRATES.Auction.WordsClock", { time: clockText(left) }) });
export const roundState = (round, opts = {}) => tableRoundState(round, { ...opts, words: AUCTION_WORDS });

// "Crate Tester bids 55 gp", for the list, the status line and the board.
export const bidSentence = row => t("LOOTCRATES.Auction.Bids", { name: row?.actorName ?? t("LOOTCRATES.Auction.Someone"), price: formatPrice(amountOf(row)) });

// "5 bids from 3 bidders", "1 bid", "No bids yet": every bid of the round,
// the ones that were beaten included.
export function bidCount(history = []) {
  const bids = history.filter(r => r && !(r.refunded && r.refundReason !== "outbid"));
  if (!bids.length) return t("LOOTCRATES.Auction.NoBids");
  const who = new Set(bids.map(r => (r.house ? `house:${r.stake?.house ?? r.actorName}` : r.actorId))).size;
  const n = t(bids.length === 1 ? "LOOTCRATES.Auction.BidsOne" : "LOOTCRATES.Auction.BidsMany", { count: bids.length });
  return who > 1 ? t("LOOTCRATES.Auction.BidsFrom", { bids: n, who }) : n;
}

// The status line as a bid lands: who bid what, and whose bid it beat (a
// player's comes back at once, which is said).
export function bidAnnouncement(row, { outbid = [] } = {}) {
  const beaten = outbid.map(r => t(r.house ? "LOOTCRATES.Auction.Outbid" : "LOOTCRATES.Auction.BidBack", { name: r.actorName }));
  const top = t("LOOTCRATES.Auction.TopBid", { bid: bidSentence(row) });
  return t("LOOTCRATES.Common.Sentence", { text: beaten.length ? [top, ...beaten].join(t("LOOTCRATES.Common.ListSemicolon")) : top });
}

/*
  The outcome as it ended: a sale whose item couldn't be put on the sheet
  was refunded at the hammer (the core's refundOnFail, the stake's reason
  "grant"), so it reads as no sale. Every word of the hammer reads this.
*/
export function outcomeOf(reveal) {
  const o = reveal?.outcome ?? null;
  if (o?.verdict !== "sold") return o;
  const s = (reveal.stakes ?? []).find(x => x.logId === o.leaderId);
  return s && s.action !== "settle" ? { ...o, verdict: "grant", result: null } : o;
}

// The verdict at the hammer, everywhere: the window's live region, the chat card.
export function verdictText(o) {
  if (!o) return "";
  const amount = formatPrice(o.amount);
  if (o.verdict === "sold") {
    const head = t("LOOTCRATES.Auction.SoldTo", { name: o.bidder, price: amount });
    if (o.lot?.type !== "crate") return head;
    return `${head} ${o.result ? t("LOOTCRATES.Auction.CrateGave", { name: o.result.name }) : t("LOOTCRATES.Auction.CrateHeldNothing")}`;
  }
  if (o.verdict === "house") return t("LOOTCRATES.Auction.VerdictHouse", { price: amount });
  if (o.verdict === "reserve") return t("LOOTCRATES.Auction.VerdictReserve", { price: amount });
  if (o.verdict === "lot") return t("LOOTCRATES.Auction.VerdictLot", { price: amount });
  if (o.verdict === "grant") return t("LOOTCRATES.Auction.VerdictGrant", { name: o.bidder, price: amount });
  return t("LOOTCRATES.Auction.VerdictNone");
}

// What the lot was, for a sale: the item (or the crate's draw) and its rarity.
const soldLine = o => (o?.verdict === "sold" && o.result ? `${o.result.name}, ${RARITY_LABEL[o.result.rarity] ?? o.result.rarity}` : "");

/* ---------- The board (the table window's stage) ---------- */

// The gavel: a head on a handle, drawn in the pin's gold; it swings once at the hammer.
const GAVEL_ART = `<svg class="lc-gavel__art" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><g class="lc-gavel__head"><rect x="3" y="4" width="11" height="6" rx="1.2" transform="rotate(-35 8.5 7)"/><path d="M10.4 9.6 19.6 18.8" stroke-width="2.4" stroke-linecap="round"/></g><rect x="13" y="20" width="9" height="2" rx="1"/></svg>`;
export const CRATE_ART = `<svg class="lc-auction__glyph" viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M3 8 12 4l9 4v9l-9 4-9-4z"/><path d="M3 8l9 4 9-4M12 12v9"/><path d="M7.5 6 16.5 10"/></svg>`;

const easeIn3 = p => p * p * p;
const clamp01 = x => Math.max(0, Math.min(1, x));
const prefersReduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/*
  The board's markup (the window's rail): the lot, the top bid and who
  holds it, whether the reserve is met (never its amount), the last five
  bids (a beaten one muted, the viewer's own marked), and the gavel's
  clock as data the stage's loop reads. Once the gavel is down
  (`outcome`), the bid line says Sold or No sale and the stamp lands.
*/
export function boardHTML(game, stakes = [], { esc = s => String(s ?? ""), outcome = null, fresh = [], actorIds = [], round = null, history = null } = {}) {
  const lot = outcome?.lot ?? lotOf(game);
  const bids = (history ?? stakes).filter(r => r && !(r.refunded && r.refundReason && r.refundReason !== "outbid"));
  const top = leaderOf(stakes);
  const art = lot?.type === "item" && lot.img ? `<img src="${esc(lot.img)}" alt="">` : lot?.type === "crate" ? CRATE_ART : "";
  const reserve = reserveOf(game) > 0 || outcome?.reserve;
  let line, amount, who, state;
  if (outcome) {
    const sold = outcome.verdict === "sold";
    state = sold ? "sold" : "nosale";
    line = sold ? t("LOOTCRATES.Auction.SoldFor") : outcome.verdict === "house" ? t("LOOTCRATES.Auction.HouseTookAt") : t("LOOTCRATES.Auction.NoSale");
    amount = outcome.verdict === "none" ? "" : formatPrice(outcome.amount);
    who = sold ? outcome.bidder : outcome.verdict === "house" ? outcome.bidder : outcome.verdict === "reserve" ? t("LOOTCRATES.Auction.ReserveNotMet") : outcome.verdict === "lot" ? t("LOOTCRATES.Auction.LotGone") : outcome.verdict === "grant" ? t("LOOTCRATES.Auction.LotNotAdded") : t("LOOTCRATES.Auction.NobodyBid");
  } else {
    state = top ? "open" : "opening";
    line = top ? t("LOOTCRATES.Auction.TopBidLine") : t("LOOTCRATES.Auction.OpeningBidLine");
    amount = formatPrice(top ? amountOf(top) : openingOf(game));
    who = top ? top.actorName : t("LOOTCRATES.Auction.NoBids");
  }
  const met = outcome ? outcome.reserveMet : !!top && toCp(amountOf(top)) >= toCp(reserveOf(game));
  const reserveLine = reserve && !(outcome && outcome.verdict !== "sold" && outcome.verdict !== "reserve") ? `<span class="lc-auction__reserve" data-met="${met}">${met ? t("LOOTCRATES.Auction.ReserveMet") : t("LOOTCRATES.Auction.ReserveNotMetYet")}</span>` : "";
  const last = bids.slice(0, 5).map(r => {
    const cls = ["lc-auction__past", r.id === top?.id || r.id === outcome?.leaderId ? "lc-auction__past--top" : "", r.refunded ? "lc-auction__past--beaten" : "", fresh.includes(r.id) ? "lc-auction__past--new" : "", !r.house && actorIds.includes(r.actorId) ? "lc-auction__past--mine" : "", r.house ? "lc-auction__past--house" : ""].filter(Boolean).join(" ");
    return `<li class="${cls}"><span class="lc-auction__past-who">${esc(r.actorName)}</span><span class="lc-auction__past-amount">${esc(formatPrice(amountOf(r)))}</span></li>`;
  }).join("");
  const clock = !outcome && round?.closesAt != null && round.status !== "resolved" ? `<span class="lc-auction__clock" data-gavel data-closes-at="${esc(round.closesAt)}" data-gavel-ms="${esc(gavelMsOf(game))}" hidden></span>` : "";
  const stamp = outcome ? `<span class="lc-auction__stamp" aria-hidden="true">${outcome.verdict === "sold" ? t("LOOTCRATES.Auction.Sold") : t("LOOTCRATES.Auction.NoSale")}</span>` : "";
  return `<div class="lc-auction__lot lc-rarity-${esc(lot?.rarity ?? "none")}">
        <div class="lc-auction__art" aria-hidden="true">${art}</div>
        <div class="lc-auction__lotname"><strong>${esc(lotName(lot))}</strong><span class="lc-auction__sub">${esc(lotLine(lot))}</span></div>
      </div>
      <div class="lc-auction__bid" data-state="${state}">
        <span class="lc-auction__line">${esc(line)}</span>
        ${amount ? `<strong class="lc-auction__amount">${esc(amount)}</strong>` : ""}
        <span class="lc-auction__who">${esc(who)}</span>
        ${reserveLine}${stamp}
      </div>
      ${last ? `<ol class="lc-auction__bids" aria-label="${t("LOOTCRATES.Auction.LastBids")}">${last}</ol>` : `<p class="lc-auction__bids lc-auction__bids--empty">${t("LOOTCRATES.Auction.FirstBid", { price: esc(formatPrice(openingOf(game))), step: esc(formatPrice(incrementOf(game))) })}</p>`}
      ${clock}`;
}

/*
  The board in the window's vault: the lot and bids (rail() draws them),
  the gavel's bar, and a strip for a sealed crate. One requestAnimationFrame
  loop drains the bar as the gavel runs (one scaleX transform; a stepped
  bar, once a second, under reduced motion), and it visibly fills again
  (lc-gavel--reset) when a bid moves the clock. spin() is the hammer: the
  loop stops, the gavel's head swings once (one rotate transform on its
  own loop), and for a sealed crate the crate's strip (spin.js) then runs
  to the winner's draw; it lands with the host marked
  lc-table__stage--landed. Returns the controller the window expects:
  { rail(html), spin(opts) -> { play, skip, skipped, reducedMotion } }.
*/
export function mountBoard(host, { pockets: view = {}, esc: _esc = s => String(s ?? "") } = {}) {
  host.classList.add("lc-table__stage", "lc-auction-stage");
  host.classList.remove("lc-table__stage--spinning", "lc-table__stage--landed");
  host.innerHTML = `<div class="lc-auction">
      <div class="lc-auction__board"></div>
      <div class="lc-gavel" aria-hidden="true"><span class="lc-gavel__track"><span class="lc-gavel__bar"></span></span>${GAVEL_ART}</div>
      <div class="lc-auction__strip" hidden></div>
    </div>`;
  const board = host.querySelector(".lc-auction__board");
  const gavel = host.querySelector(".lc-gavel");
  const bar = host.querySelector(".lc-gavel__bar");
  const head = host.querySelector(".lc-gavel__head");
  const stripHost = host.querySelector(".lc-auction__strip");
  const reduced = prefersReduced();
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : null;
  const caf = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : () => {};
  let closesAt = null, gavelMs = AUCTION_DEFAULTS.gavelSec * 1000, frame = null, stopped = false, wasIn = false, shown = null;
  const setBar = p => { if (bar?.style && shown !== p) { shown = p; bar.style.transform = `scaleX(${p.toFixed(4)})`; } };
  const share = () => {
    if (closesAt == null) return 0;
    const left = closesAt - Date.now();
    // Reduced motion: the bar steps once a second rather than gliding.
    return clamp01((reduced ? Math.ceil(left / 1000) * 1000 : left) / gavelMs);
  };
  const loop = () => {
    frame = null;
    if (stopped) return;
    if (host.isConnected) wasIn = true;
    else if (wasIn) { stopped = true; return; }
    setBar(share());
    if (closesAt != null && Date.now() < closesAt && raf) frame = raf(loop);
  };
  const start = () => { if (frame == null && !stopped && raf) frame = raf(loop); };
  const out = {
    landed: false,
    rail(html) {
      if (!board) return;
      board.innerHTML = html;
      const data = board.querySelector("[data-gavel]");
      const next = data ? Number(data.dataset.closesAt) : null;
      const ms = data ? Number(data.dataset.gavelMs) : 0;
      if (ms > 0) gavelMs = ms;
      // A bid moved the clock on: the bar fills again where it can be seen.
      if (next != null && closesAt != null && next > closesAt + 250 && gavel?.classList) {
        gavel.classList.remove("lc-gavel--reset");
        void gavel.offsetWidth;
        gavel.classList.add("lc-gavel--reset");
      }
      closesAt = Number.isFinite(next) ? next : null;
      if (closesAt == null && !out.landed) gavel?.classList?.add("lc-gavel--idle");
      else gavel?.classList?.remove("lc-gavel--idle");
      setBar(share());
      start();
    },
    spin({ onTick = null, onDrop = null, onLand = null, duration = null, reducedMotion } = {}) {
      const still = reducedMotion ?? reduced;
      stopped = true;
      if (frame != null) caf(frame);
      frame = null;
      setBar(0);
      host.classList.add("lc-table__stage--spinning");
      const strip = view?.strip && view?.outcome?.verdict === "sold" ? view.strip : null;
      let landed = false, swing = null, crate = null, done = null;
      const showStrip = now => {
        if (!strip || crate) return crate;
        stripHost.removeAttribute("hidden");
        host.classList.add("lc-auction-stage--crate");
        crate = mountSpin(stripHost, strip, { duration: duration ?? undefined, reducedMotion: now, onTick: i => { try { onTick?.(clamp01(i / Math.max(1, strip.landIndex))); } catch (err) { console.error("loot-crates | the strip's tick failed", err); } } });
        return crate;
      };
      const land = () => {
        if (landed) return;
        landed = true;
        if (swing != null) caf(swing);
        if (head?.style) head.style.transform = "";
        host.classList.remove("lc-table__stage--spinning");
        host.classList.add("lc-table__stage--landed");
        out.landed = true;
        onLand?.();
        done?.();
      };
      const strike = () => new Promise(resolve => {
        let t0 = null;
        const step = now => {
          if (landed) return resolve();
          t0 ??= now;
          const p = clamp01((now - t0) / HAMMER_MS);
          if (head?.style) head.style.transform = `rotate(${(-40 * (1 - easeIn3(p))).toFixed(2)}deg)`;
          if (p >= 1) {
            swing = null;
            try { onDrop?.(); } catch (err) { console.error("loot-crates | the gavel's sound failed", err); }
            resolve();
          } else swing = raf(step);
        };
        swing = raf ? raf(step) : (resolve(), null);
      });
      const ctrl = {
        skipped: false,
        reducedMotion: still,
        play() {
          if (landed) return Promise.resolve();
          if (still || duration === 0 || !raf) {
            const c = showStrip(true);
            c?.play();
            land();
            return Promise.resolve();
          }
          return new Promise(resolve => {
            done = resolve;
            strike().then(async () => {
              if (landed) return;
              const c = showStrip(false);
              if (c) await c.play();
              land();
            }).catch(err => { console.error("loot-crates | the hammer failed", err); land(); });
          });
        },
        skip() {
          ctrl.skipped = true;
          if (crate) crate.skip({ now: true });
          else { const c = showStrip(true); c?.play(); }
          land();
        },
      };
      return ctrl;
    },
  };
  setBar(0);
  return out;
}

/* ---------- The bid form (tableview.js calls these) ---------- */

// The one field: the bid, filled with the next legal amount.
export function bidFields(game, { esc = s => String(s ?? ""), values = {}, stakes = [] } = {}) {
  const min = minBid(game, stakes);
  const typed = num(values.amount, 0);
  const amount = values.touched === "1" && toCp(typed) >= toCp(min) ? typed : min;
  return `<label class="lc-table__field lc-table__field--stake"><span class="lc-label">${t("LOOTCRATES.Auction.YourBid")}</span><input name="amount" type="number" min="${esc(min)}" step="any" value="${esc(amount)}" class="lc-table__stake lc-auction__input" inputmode="decimal"></label>
      <input type="hidden" name="touched" value="${values.touched === "1" ? "1" : ""}">`;
}

// The primary action names the bid it places: "Bid 55 gp".
export function bidLabel(game, { stakes = [], values = {} } = {}) {
  const min = minBid(game, stakes);
  const typed = num(values.amount, 0);
  return t("LOOTCRATES.Auction.Bid", { price: formatPrice(toCp(typed) >= toCp(min) ? typed : min) });
}

// The bid the form's values describe, or a PullError before anything is sent.
export function readBid(game, values = {}, stakes = []) {
  const amount = gp2(num(values.amount, NaN));
  const min = minBid(game, stakes);
  const top = leaderOf(stakes);
  if (top && !top.house && values.actorId && top.actorId === values.actorId) throw new PullError(t("LOOTCRATES.Auction.AlreadyHolds", { name: top.actorName }));
  if (!(toCp(amount) >= toCp(min))) throw new PullError(t("LOOTCRATES.Auction.BidAtLeast", { price: formatPrice(min) }));
  return { bet: { amount }, price: amount };
}

/*
  The form after a bid landed elsewhere (tablewindow.js refresh): the field
  follows the next legal amount unless the player typed more, and the
  button says what it will bid.
*/
export function syncBidForm(form, { game, stakes = [] } = {}) {
  const input = form?.querySelector?.('input[name="amount"]');
  const btn = form?.querySelector?.(".lc-table__bet");
  if (!input) return;
  const min = minBid(game, stakes);
  const touched = form.querySelector('input[name="touched"]');
  input.min = String(min);
  if (touched?.value !== "1" || !(toCp(input.value) >= toCp(min))) { input.value = String(min); if (touched) touched.value = ""; }
  if (btn && btn.getAttribute("aria-disabled") !== "true") btn.textContent = bidLabel(game, { stakes, values: { amount: input.value } });
}

// A typed bid is the player's own: the field stops following the table until it is below the next legal amount.
export function onBidInput(form, { game, stakes = [] } = {}) {
  const input = form?.querySelector?.('input[name="amount"]');
  const touched = form?.querySelector?.('input[name="touched"]');
  const btn = form?.querySelector?.(".lc-table__bet");
  if (!input) return;
  if (touched) touched.value = "1";
  if (btn && btn.getAttribute("aria-disabled") !== "true") btn.textContent = bidLabel(game, { stakes, values: { amount: input.value } });
}

// The window's result, into its live region once the gavel is down.
function tableResult(reveal, { esc = String } = {}) {
  const o = outcomeOf(reveal);
  const sold = soldLine(o);
  return `<div class="lc-reveal__quiet lc-table__verdict">${esc(verdictText(o))}</div>${sold ? `<div class="lc-reveal__where">${esc(sold)}</div>` : ""}`;
}

// The sting: the winner's own client plays the lot's rarity.
function tableSting(reveal, { actorIds = [] } = {}) {
  const o = outcomeOf(reveal);
  if (o?.verdict === "sold" && actorIds.includes(o.actorId)) playReveal(o.result?.rarity ?? o.lot?.rarity ?? "common");
}

/* ---------- The chat card ---------- */

// One card after the hammer: the lot, who won it for what, or why it didn't sell.
function chatCard(reveal, { esc, itemLink }) {
  const o = outcomeOf(reveal);
  if (!o) return null;
  const won = (reveal.stakes ?? []).find(s => s.logId === o.leaderId && s.itemId);
  const result = o.verdict === "sold" ? o.result : null;
  const rarity = result?.rarity ?? (o.verdict === "sold" ? o.lot?.rarity : "none") ?? "none";
  const name = result ? itemLink(won ? `Actor.${won.actorId}.Item.${won.itemId}` : result.uuid, result.name) : esc(o.verdict === "sold" ? t("LOOTCRATES.Auction.CrateNothing", { name: o.lot?.name ?? t("LOOTCRATES.Auction.TheLot") }) : t("LOOTCRATES.Auction.NoSale"));
  const img = result?.img ?? (o.lot?.type === "item" ? o.lot.img : "");
  return `
    <div class="loot-crates lc-chat lc-rarity-${esc(rarity)}">
      <div class="lc-chat__head">${t("LOOTCRATES.Auction.ChatHead", { box: `<strong>${esc(reveal.box?.name ?? "")}</strong>`, bids: `<span class="lc-chat__price">${esc(t(o.bids === 1 ? "LOOTCRATES.Auction.BidsOne" : "LOOTCRATES.Auction.BidsMany", { count: o.bids }))}</span>` })}</div>
      <div class="lc-chat__item">
        ${img ? `<img src="${esc(img)}" alt="">` : `<span class="lc-chat__lot" aria-hidden="true">${CRATE_ART}</span>`}
        <div>
          <div class="lc-chat__name">${name}</div>
          <div class="lc-chat__rarity">${esc(o.lot?.type === "crate" ? lotName(o.lot) : RARITY_LABEL[o.lot?.rarity] ?? "")}</div>
          <div class="lc-chat__text">${esc(verdictText(o))}</div>
        </div>
      </div>
    </div>`;
}

/* ---------- The shop card ---------- */

const AUCTION_ART = `<svg class="lc-auction__icon" viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="11" height="6" rx="1.2" transform="rotate(-35 8.5 8)"/><path d="M10.5 10.5 19 19" stroke-linecap="round"/><path d="M12 21h9"/></svg>`;

const roundStakes = (ctx, round) => (round ? (ctx.log ?? []).filter(r => r?.roundId === round.id) : []);

// Why this player can't bid now, or "": no lot, the gavel down here, no
// auction open, bidding closed; being short of the next legal bid is the
// card's last word, as for every kind. The GM's card is off only for an
// auction with no lot and while the last one's gavel still falls here.
function auctionState(game, ctx) {
  if (!lotOf(game)) return t("LOOTCRATES.Auction.NoLotSet");
  const round = liveRoundOf(ctx.rounds ?? {}, game.id);
  const state = roundState(round, { now: ctx.now ?? Date.now(), held: !!ctx.held?.(game.id) });
  if (state.key === "spinning") return AUCTION_WORDS.held;
  if (ctx.isGM) return "";
  if (state.key === "none") return AUCTION_WORDS.none;
  if (state.key === "closed") return AUCTION_WORDS.closed;
  return "";
}

function nextBidFor(game, ctx) {
  const round = liveRoundOf(ctx.rounds ?? {}, game.id);
  return minBid(game, roundStakes(ctx, round).filter(isOpenStake));
}

const shortOf = (game, ctx) => {
  const min = nextBidFor(game, ctx);
  return ctx.hasActor && !ctx.isGM && !canAfford(ctx.purse ?? {}, min) ? t("LOOTCRATES.Card.Needs", { price: formatPrice(shortfall(ctx.purse ?? {}, min)) }) : "";
};

function card(game, pools, ctx) {
  const esc = ctx.esc ?? (s => String(s ?? ""));
  const lot = lotOf(game);
  const round = liveRoundOf(ctx.rounds ?? {}, game.id);
  const state = roundState(round, { now: ctx.now ?? Date.now(), held: !!ctx.held?.(game.id) });
  const open = roundStakes(ctx, round).filter(isOpenStake);
  const top = leaderOf(open);
  const min = minBid(game, open);
  const reason = auctionState(game, ctx) || shortOf(game, ctx);
  const bid = top ? t("LOOTCRATES.Auction.CardTopBid", { price: formatPrice(amountOf(top)), name: top.actorName }) : t("LOOTCRATES.Auction.CardOpening", { price: formatPrice(openingOf(game)), step: formatPrice(incrementOf(game)) });
  const reserve = reserveOf(game) > 0 ? (top && toCp(amountOf(top)) >= toCp(reserveOf(game)) ? t("LOOTCRATES.Auction.ReserveMet") : t("LOOTCRATES.Auction.HasReserve")) : t("LOOTCRATES.Auction.NoReserve");
  const middle = [
    `<div class="lc-box__rule"><strong>${esc(lotName(lot))}</strong>${lot ? `<br>${esc(lotLine(lot))}` : ""}</div>`,
    `<div class="lc-box__stock">${t("LOOTCRATES.Auction.CardStock", { bid: esc(bid), reserve: esc(reserve) })}</div>`,
    `<div class="lc-box__round" data-round="${esc(state.key)}"${state.closesAt ? ` data-lc-countdown="${esc(state.closesAt)}"` : ""}>${esc(state.text)}</div>`,
  ];
  const label = ctx.isGM ? (round ? t("LOOTCRATES.Boxes.GoToAuction") : t("LOOTCRATES.Boxes.OpenAuction")) : t("LOOTCRATES.Auction.Join");
  const art = lot?.type === "item" && lot.img ? `<img src="${esc(lot.img)}" alt="">` : lot?.type === "crate" ? CRATE_ART : AUCTION_ART;
  return cardShell(game, ctx, { rarityClass: `lc-rarity-${lot?.rarity ?? "none"} lc-box--auction`, art, middle, reason, label, price: min });
}

const reason = (game, pools, ctx) => auctionState(game, ctx) || shopReason(ctx) || shortOf(game, ctx);

/* ---------- The manager's words ---------- */

// "Opens at 10 gp, +5 gp a bid, reserve 50 gp, 20 s gavel, 2 house bidders up to 100 gp".
export function auctionRulesText(game) {
  const h = houseOf(game);
  return [t("LOOTCRATES.Auction.RuleOpens", { price: formatPrice(openingOf(game)) }), t("LOOTCRATES.Auction.RuleStep", { price: formatPrice(incrementOf(game)) }), reserveOf(game) ? t("LOOTCRATES.Auction.RuleReserve", { price: formatPrice(reserveOf(game)) }) : t("LOOTCRATES.Auction.RuleNoReserve"), t("LOOTCRATES.Auction.RuleGavel", { count: gavelMsOf(game) / 1000 }), h.count ? t(h.count === 1 ? "LOOTCRATES.Auction.RuleHouseOne" : "LOOTCRATES.Auction.RuleHouseMany", { count: h.count, price: formatPrice(h.budget) }) : ""].filter(Boolean).join(", ");
}

// The Boxes row's odds cell: the lot as a pill in its rarity.
export function auctionLotHTML(game, esc = s => String(s ?? "")) {
  const lot = lotOf(game);
  if (!lot) return `<em>${t("LOOTCRATES.Auction.NoLotCell")}</em>`;
  return `<div class="lc-odds"><span class="lc-odd lc-odd--lot lc-rarity-${esc(lot.rarity)}">${esc(lotName(lot))}</span></div>`;
}

/*
  The auction as the editor's form would save it: the lot by its choice's
  value ("item:<uuid>" or "crate:<id>", read through `lotFor`, which knows
  the pools' entries, the crates and any item dropped on the editor), the
  opening bid, the increment, the reserve, the gavel and the house.
*/
export function draftAuction(game, values = {}, lotFor = () => null) {
  const n = (v, d) => (String(v ?? "").trim() !== "" && Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : d);
  const lot = values.lot ? lotFor(String(values.lot)) ?? null : game.auction?.lot ?? null;
  return {
    ...game,
    pools: [],
    price: gp2(n(values.price, openingOf(game))),
    auction: {
      ...(game.auction ?? {}),
      lot,
      increment: gp2(n(values.increment, incrementOf(game))) || 1,
      reserve: gp2(n(values.reserve, 0)),
      gavelSec: Math.max(MIN_GAVEL_SEC, Math.round(n(values.gavelSec, AUCTION_DEFAULTS.gavelSec))),
      house: { count: Math.min(MAX_HOUSE, Math.floor(n(values.houseCount, 0))), budget: gp2(n(values.houseBudget, AUCTION_DEFAULTS.house.budget)), chance: Math.min(100, n(values.houseChance, AUCTION_DEFAULTS.house.chance)) },
    },
  };
}

// The editor's preview: what the table will see, and a warning for what won't sell.
export function auctionPreview(game) {
  const lot = lotOf(game);
  const h = houseOf(game);
  const lines = [
    lot ? t("LOOTCRATES.Auction.PreviewLot", { name: lotName(lot) }) : "",
    t("LOOTCRATES.Auction.PreviewBids", { price: formatPrice(openingOf(game)), step: formatPrice(incrementOf(game)), gavel: gavelMsOf(game) / 1000 }),
    reserveOf(game) ? t("LOOTCRATES.Auction.PreviewReserve", { price: formatPrice(reserveOf(game)) }) : "",
    h.count ? t(h.count === 1 ? "LOOTCRATES.Auction.PreviewHouseOne" : "LOOTCRATES.Auction.PreviewHouseMany", { count: h.count, price: formatPrice(h.budget), chance: h.chance, every: HOUSE_TICK_MS / 1000 }) : "",
  ].filter(Boolean);
  const warn = !lot;
  const note = warn ? t("LOOTCRATES.Auction.PreviewPickLot") : h.count && toCp(h.budget) < toCp(openingOf(game) + incrementOf(game)) ? t("LOOTCRATES.Auction.PreviewBudget") : "";
  return { lines, note, warn };
}

export function auctionPreviewHTML(preview, esc = s => String(s ?? "")) {
  return `<p class="lc-form__hint">${preview.lines.map(esc).join("<br>")}</p>${preview.note ? `<p class="lc-form__hint${preview.warn ? " lc-form__hint--warn" : ""}">${esc(preview.note)}</p>` : ""}`;
}

export const auctionSummary = preview => [...preview.lines, preview.note].filter(Boolean).join(" ");

export const AUCTION = registerKind({
  id: "auction",
  noun: "auction",
  table: true,
  // The GM's client brings the gavel down when its clock runs out, and
  // gives the house its chance every tickMs (table.js watchTables).
  hammer: true,
  tickMs: HOUSE_TICK_MS,
  // No round opens on an auction with nothing to sell (table.js openRound).
  openReason: game => (lotOf(game) ? "" : t("LOOTCRATES.Auction.OpenNoLot", { name: game?.name ?? t("LOOTCRATES.Auction.ThatAuction") })),
  priceOf,
  stake,
  tick: houseBid,
  roll,
  settle,
  gotText: out => t("LOOTCRATES.Auction.GotText", { price: formatPrice(out?.price ?? 0) }),
  // The shared table window's pieces (tableview.js, tablewindow.js).
  tableView: {
    title: game => t("LOOTCRATES.Auction.Title", { name: game?.name ?? t("LOOTCRATES.Table.TheTable") }),
    get verb() { return t("LOOTCRATES.Auction.Verb"); },
    words: AUCTION_WORDS,
    fields: bidFields,
    readBet: readBid,
    betLabel: bidLabel,
    get busyLabel() { return t("LOOTCRATES.Auction.Busy"); },
    syncForm: syncBidForm,
    onInput: onBidInput,
    sentence: bidSentence,
    count: bidCount,
    announce: bidAnnouncement,
    get spinLabel() { return t("LOOTCRATES.Auction.Spin"); },
    get spinningLabel() { return t("LOOTCRATES.Auction.Spinning"); },
    get cancelLabel() { return t("LOOTCRATES.Table.CallOff"); },
    mount: mountBoard,
    rail: boardHTML,
    pockets: game => ({ lot: lotOf(game) }),
    pocketsIn: reveal => ({ lot: reveal?.outcome?.lot ?? null, strip: reveal?.strip ?? null, outcome: outcomeOf(reveal) }),
    outcomeIndex: () => 0,
    result: tableResult,
    sting: tableSting,
    sounds: { tick: progress => playTick(progress), drop: () => playDrop(), bid: () => playTick(0.35) },
    windowMs: gavelMsOf,
    rarityOf: reveal => { const o = outcomeOf(reveal); return o?.verdict === "sold" ? o.result?.rarity ?? o.lot?.rarity ?? "none" : "none"; },
    outcomeOf,
  },
  chat: { card: chatCard },
  shop: { card, reason },
});
