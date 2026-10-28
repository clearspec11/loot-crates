/*
  A new game, before it is anything: the record each New button on the
  manager's Boxes tab starts from (one builder per kind, in a table), the
  words its dialog uses, and the line the tab's status line says once it
  is on the shelf.

  Nothing here writes. The manager opens the kind's editor on the draft
  and only Save, reading "Add to shelf", creates the record; Cancel, Escape
  and closing the dialog leave the shelf as it was. Before this, every New
  wrote a live, buyable game the moment it was pressed: a dice game with
  no name took 10 gp stakes and paid 3x while the GM was still looking for
  its row, and the row itself was appended at the foot of the table with
  nothing said. Now one press shows the GM the thing they are making, and
  the shelf shows a player nothing until the GM is done.

  A Copy on a game's row (boxestable.js) is a New that starts from that
  game instead of the kind's defaults (copyOf below): the same editor on
  an unsaved draft holding every setting of the source, under a new id
  and name, with nothing of its history. Before this, a second crate with
  the same pools, a pricier "Goblin Crate (Deluxe)" or a wheel for the
  next tavern was built by hand from New: every pool ticked and shared
  again, six weights, pity, stock, each card or pocket retyped (a wheel
  starts at twelve), and that was the step a GM skipped.

  No Foundry globals: the manager passes the id (store.js newId).
*/
import { DEFAULT_WEIGHTS, DEFAULT_PRICE_GP } from "../core/config.js";
import { getKind, kindOf } from "../games/kinds.js";
import { WELL_DEFAULTS } from "../games/well.js";
import { DICE_DEFAULTS } from "../games/dicegame.js";
import { DECK_DEFAULTS } from "../games/deck.js";
import { ROULETTE_DEFAULTS } from "../games/roulette.js";
import { AUCTION_DEFAULTS } from "../games/auction.js";
import { SCRATCH_DEFAULTS, GRID_DEFAULTS } from "../games/scratch.js";
import { formatPrice } from "../core/currency.js";
import { restocked } from "../core/limits.js";
import { onShelf } from "../core/shelf.js";
import { t, words } from "../core/i18n.js";

const weights = () => ({ ...DEFAULT_WEIGHTS });

/*
  What each kind starts as. A crate: 100 gp, the default rarity weights,
  no pool yet (the editor's preview says so). A well: a silver a throw,
  almost always nothing, three throws a day. Dragon's Teeth: 10 gp to roll
  3d6 over the dragon's 12, paying three times the stake. A deck: 10 gp a
  draw, half again for each draw in a row, five placeholder cards for the
  GM to rename (nothing published ships). A wheel: twelve pockets in two
  colours and four rarity bands, 5 gp to 50 gp a bet, three bets a
  character, a 45-second betting window. An auction: no lot yet (the
  editor asks for one), bids opening at 10 gp and rising by 5 gp, no
  reserve, a 20-second gavel, no house bidders. A scratch ticket: the
  approved mockup's Fortune Ticket, 5 gp, lucky numbers on a 4 x 3 grid
  with a 25 gp bonus spot, roll 1 of 100 tickets (one Rare item, coins
  from 5 gp to 100 gp, three bonus tickets, 57 duds). Each call builds
  fresh copies.
*/
export const NEW_DEFAULTS = {
  crate: () => ({ name: t("LOOTCRATES.Boxes.NewBox"), price: DEFAULT_PRICE_GP, pools: [], weights: weights(), rules: {} }),
  well: () => ({ kind: "well", name: t("LOOTCRATES.Boxes.NewWell"), price: WELL_DEFAULTS.price, pools: [], weights: weights(), odds: { ...WELL_DEFAULTS.odds }, rules: { cap: WELL_DEFAULTS.cap } }),
  dice: () => ({ kind: "dice", name: t("LOOTCRATES.Boxes.NewDice"), price: DICE_DEFAULTS.price, pools: [], weights: weights(), dice: { formula: DICE_DEFAULTS.formula, target: DICE_DEFAULTS.target, multiplier: DICE_DEFAULTS.multiplier }, rules: { prize: false } }),
  deck: () => ({ kind: "deck", name: t("LOOTCRATES.Boxes.NewDeck"), price: DECK_DEFAULTS.price, pools: [], weights: weights(), deck: { step: DECK_DEFAULTS.step, shuffledAt: 0, cards: DECK_DEFAULTS.cards.map(c => ({ ...c })) }, rules: {} }),
  roulette: () => {
    const d = ROULETTE_DEFAULTS;
    return { kind: "roulette", name: t("LOOTCRATES.Boxes.NewWheel"), price: d.price, pools: [], weights: weights(), roulette: { colours: [...d.colours], pockets: d.pockets.map(p => ({ ...p })), payouts: { ...d.payouts }, itemOnRarity: d.itemOnRarity, maxStake: d.maxStake, maxBets: d.maxBets, windowSec: d.windowSec }, rules: {} };
  },
  auction: () => {
    const d = AUCTION_DEFAULTS;
    return { kind: "auction", name: t("LOOTCRATES.Boxes.NewAuction"), price: d.price, pools: [], weights: weights(), auction: { lot: null, increment: d.increment, reserve: d.reserve, gavelSec: d.gavelSec, house: { ...d.house } }, rules: {} };
  },
  scratch: () => {
    const d = SCRATCH_DEFAULTS;
    return { kind: "scratch", name: t("LOOTCRATES.Boxes.NewScratch"), price: d.price, pools: [], weights: weights(), layout: d.layout, grid: { ...GRID_DEFAULTS[d.layout] }, bonus: { on: true, gp: d.bonusGp }, theme: d.theme, roll: { id: 1, size: d.size, prizes: d.prizes.map(p => structuredClone(p)) }, rules: {} };
  },
};

// The dialog's title: the words on the button that opened it, so what the
// GM pressed is what they see. An existing record's editor says Edit.
export const NEW_TITLE = words({ crate: "LOOTCRATES.Boxes.NewBox", well: "LOOTCRATES.Boxes.NewWell", dice: "LOOTCRATES.Boxes.NewDice", deck: "LOOTCRATES.Boxes.NewDeck", roulette: "LOOTCRATES.Boxes.NewWheel", auction: "LOOTCRATES.Boxes.NewAuction", scratch: "LOOTCRATES.Boxes.NewScratch" });
export const EDIT_TITLE = words({ crate: "LOOTCRATES.Game.EditBox", well: "LOOTCRATES.Game.EditWell", dice: "LOOTCRATES.Game.EditDice", deck: "LOOTCRATES.Game.EditDeck", roulette: "LOOTCRATES.Game.EditWheel", auction: "LOOTCRATES.Game.EditAuction", scratch: "LOOTCRATES.Game.EditScratch" });
export const COPY_TITLE = words({ crate: "LOOTCRATES.Game.CopyBox", well: "LOOTCRATES.Game.CopyWell", dice: "LOOTCRATES.Game.CopyDice", deck: "LOOTCRATES.Game.CopyDeck", roulette: "LOOTCRATES.Game.CopyWheel", auction: "LOOTCRATES.Game.CopyAuction", scratch: "LOOTCRATES.Game.CopyScratch" });
export const DELETE_TITLE = words({ crate: "LOOTCRATES.Game.DeleteBox", well: "LOOTCRATES.Game.DeleteWell", dice: "LOOTCRATES.Game.DeleteDice", deck: "LOOTCRATES.Game.DeleteDeck", roulette: "LOOTCRATES.Game.DeleteWheel", auction: "LOOTCRATES.Game.DeleteAuction", scratch: "LOOTCRATES.Game.DeleteScratch" });
export const deleteTitle = game => DELETE_TITLE[kindOf(game)] ?? t("LOOTCRATES.Game.DeleteGame");

/*
  Delete's confirm. A table game with a round not yet settled names what
  that round still holds (round.js heldBy: { count, gp }), so the GM sees
  the coins before acting: they are refunded first (table.js cancelRound),
  then the game goes. A bid is the Auction's word, a stake every other's.
*/
const HELD_WORDS = {
  round: { open: "LOOTCRATES.Game.RoundOpenNone", holdsOne: "LOOTCRATES.Game.RoundHoldsOne", holdsMany: "LOOTCRATES.Game.RoundHoldsMany", off: "LOOTCRATES.Game.RoundCalledOff", offWith: "LOOTCRATES.Game.RoundCalledOffWith", refundedOne: "LOOTCRATES.Game.StakesRefundedOne", refundedMany: "LOOTCRATES.Game.StakesRefundedMany", goneOne: "LOOTCRATES.Game.StakesGoneOne", goneMany: "LOOTCRATES.Game.StakesGoneMany" },
  auction: { open: "LOOTCRATES.Game.AuctionOpenNone", holdsOne: "LOOTCRATES.Game.AuctionHoldsOne", holdsMany: "LOOTCRATES.Game.AuctionHoldsMany", off: "LOOTCRATES.Game.AuctionCalledOff", offWith: "LOOTCRATES.Game.AuctionCalledOffWith", refundedOne: "LOOTCRATES.Game.BidsRefundedOne", refundedMany: "LOOTCRATES.Game.BidsRefundedMany", goneOne: "LOOTCRATES.Game.BidsGoneOne", goneMany: "LOOTCRATES.Game.BidsGoneMany" },
};
const heldWords = game => HELD_WORDS[kindOf(game) === "auction" ? "auction" : "round"];

export function deleteGameText(game, held, esc) {
  const ask = t("LOOTCRATES.Game.DeleteAsk", { name: `<strong>${esc(game.name)}</strong>` });
  if (!held) return `<p>${ask}</p>`;
  const w = heldWords(game);
  if (!held.count) return `<p>${ask} ${t(w.open)}</p>`;
  return `<p>${ask} ${t(held.count === 1 ? w.holdsOne : w.holdsMany, { count: held.count, price: esc(formatPrice(held.gp)) })}</p>`;
}

// The Boxes tab's status line once the game is gone, saying the refund
// once: cancelRound's { refunded, gone } when a round was called off.
export function deletedNotice(game, cancelled = null) {
  const done = t("LOOTCRATES.Game.Deleted", { name: game.name });
  if (!cancelled) return done;
  const w = heldWords(game);
  const { refunded = 0, gone = 0 } = cancelled;
  if (!refunded && !gone) return `${done} ${t(w.off)}`;
  const parts = [];
  if (refunded) parts.push(t(refunded === 1 ? w.refundedOne : w.refundedMany, { count: refunded }));
  if (gone) parts.push(t(gone === 1 ? w.goneOne : w.goneMany, { count: gone }));
  return `${done} ${t(w.offWith, { parts: parts.join(t("LOOTCRATES.Common.ListSemicolon")) })}`;
}
export function editorTitle(game, isNew, copy = false) {
  const [titles, fallback] = copy ? [COPY_TITLE, "LOOTCRATES.Game.CopyGame"] : isNew ? [NEW_TITLE, "LOOTCRATES.Game.NewGame"] : [EDIT_TITLE, "LOOTCRATES.Game.EditGame"];
  return titles[kindOf(game)] ?? t(fallback);
}

// The unsaved record a New opens its editor on: the kind's defaults, any
// fields given over them (a name, the pools), and the id it will be saved
// under, so the editor's markup (its ids, its Limits group) is the same
// as for a record that exists.
export function newDraft(kind, { id, ...over } = {}) {
  const build = NEW_DEFAULTS[kind];
  if (!build) throw new Error(`loot-crates | no New for a game of kind ${kind}`);
  return { ...build(), ...over, id };
}

// "New crate from this pool" on the Pools tab: a crate named for the pool
// that draws only from it, so the first crate is one dialog from a pool
// with items in it (price, then Add).
export const crateFromPool = (pool, id) => newDraft("crate", { id, name: pool.name, pools: [{ id: pool.id, share: 1 }] });

/*
  "Make a crate" from a roll table (the sidebar's menu on a table, or a
  table dropped on the Boxes tab): a crate named for the table, drawing
  from the pool its items were just copied into, at the table's own odds
  (rules.oddsMode "weight"). `table` is what the drop found (store.js
  entriesFromDrop): its name and uuid, and its text results' share of the
  table, which the editor offers to count as pulls that find nothing.
  The record keeps where it came from (`fromTable`), so its editor can say
  it is a copy: edit the table and make the crate again to pick up changes.
*/
export function crateFromTable(table, poolId, id) {
  const fromTable = { uuid: table.uuid ?? null, name: table.label ?? table.name ?? "", items: table.entries?.length ?? table.items ?? 0, flattened: table.flattened ?? 0, textChance: Number(table.textChance) || 0 };
  return newDraft("crate", { id, name: fromTable.name || t("LOOTCRATES.Boxes.NewBox"), pools: [{ id: poolId, share: 1 }], rules: { oddsMode: "weight" }, fromTable });
}

/*
  The unsaved draft a Copy opens its editor on: every setting of the source
  (its kind, price, pools and shares, weights, odds, pity, no duplicates,
  the limit per character, the dice, the deck's step and cards, the
  wheel's pockets, payouts and rules) as its own copy, so editing one
  never changes the other, under `id` and named "<name> (copy)" for the
  GM to rename (copyName: a copy of a copy is "<name> (copy 2)", and no
  name in `names`, the games there already, is used twice). Nothing of the source's history comes along: the stock is
  full again (what the GM set, limits.js restocked; a record with a count
  alone keeps it), the deck's shuffle mark is `now` so no card counts as
  drawn, a scratch ticket's roll is its first again (the prize list
  whole: its tickets are counted at the copy's own id), and the log, each
  character's pity and collection and any live round are keyed on the
  source's id, so the copy starts with none.
*/
export function copyOf(game, { id, now = 0, names = [] } = {}) {
  const copy = structuredClone(game);
  copy.id = id;
  copy.name = copyName(game?.name, names);
  copy.rules = restocked(copy.rules ?? {});
  if (copy.deck) copy.deck = { ...copy.deck, shuffledAt: now };
  if (copy.roll) copy.roll = { ...copy.roll, id: 1 };
  return copy;
}

/*
  A copy's name: "<name> (copy)", then "(copy 2)", "(copy 3)" and so on.
  A copy of a copy counts on from it ("Crate (copy)" gives "Crate (copy
  2)", never "Crate (copy) (copy)"), and a name already in `names` is
  skipped, so copying one game twice gives two names.
*/
// A copy's name in the module's words ("{name} (copy)", "{name} (copy
// {n})"), and a pattern that reads one back: a name made by an earlier
// copy is counted on from, not copied again. The placeholders become named
// groups, so a translation may put {n} before {name}.
const GROUPS = { name: "(?<name>.*)", n: "(?<n>\\d+)" };
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const copyPattern = key => new RegExp(`^${t(key).split(/(\{name\}|\{n\})/).map(p => GROUPS[p.slice(1, -1)] ?? escape(p)).join("")}$`);
function readCopy(name) {
  const many = String(name).match(copyPattern("LOOTCRATES.Game.CopyNameN"));
  if (many?.groups?.name != null) return { base: many.groups.name, n: Number(many.groups.n) || 1 };
  const one = String(name).match(copyPattern("LOOTCRATES.Game.CopyName"));
  return one?.groups?.name != null ? { base: one.groups.name, n: 1 } : null;
}
export function copyName(name, names = []) {
  const fallback = t("LOOTCRATES.Game.Fallback");
  const m = readCopy(name || fallback);
  const base = m ? m.base : String(name || fallback);
  const taken = new Set(names);
  let n = m ? m.n + 1 : 1;
  const nameAt = k => (k === 1 ? t("LOOTCRATES.Game.CopyName", { name: base }) : t("LOOTCRATES.Game.CopyNameN", { name: base, n: k }));
  while (taken.has(nameAt(n))) n++;
  return nameAt(n);
}

// The New dialog's default button: it puts the game where players buy, or,
// while the shop is closed or the editor's "On the shelf" is unticked
// (shelf.js), only on the GM's list.
export const addLabel = (shopOpen, onShelf = true) => (shopOpen && onShelf ? t("LOOTCRATES.Game.AddToShelf") : t("LOOTCRATES.Game.Add"));

// The Boxes tab's status line after the Save: where the game went and
// whether players can see it. A table game isn't priced; its bets are.
export function addedNotice(game, { shopOpen = true } = {}) {
  const name = game?.name || t("LOOTCRATES.Shelf.TheGame");
  if (!onShelf(game)) return t("LOOTCRATES.Game.AddedOff", { name });
  if (!shopOpen) return t("LOOTCRATES.Game.AddedClosed", { name });
  const price = formatPrice(Number(game?.price) || 0);
  if (kindOf(game) === "auction") return t("LOOTCRATES.Game.AddedAuction", { name, price });
  return t(getKind(kindOf(game))?.table ? "LOOTCRATES.Game.AddedTable" : "LOOTCRATES.Game.AddedAt", { name, price });
}
