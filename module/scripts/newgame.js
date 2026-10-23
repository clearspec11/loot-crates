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
import { DEFAULT_WEIGHTS, DEFAULT_PRICE_GP } from "./config.js";
import { getKind, kindOf } from "./kinds.js";
import { WELL_DEFAULTS } from "./well.js";
import { DICE_DEFAULTS } from "./dicegame.js";
import { DECK_DEFAULTS } from "./deck.js";
import { ROULETTE_DEFAULTS } from "./roulette.js";
import { formatPrice } from "./currency.js";
import { restocked } from "./limits.js";
import { onShelf } from "./shelf.js";

const weights = () => ({ ...DEFAULT_WEIGHTS });

/*
  What each kind starts as. A crate: 100 gp, the default rarity weights,
  no pool yet (the editor's preview says so). A well: a silver a throw,
  almost always nothing, three throws a day. Dragon's Teeth: 10 gp to roll
  3d6 over the dragon's 12, paying three times the stake. A deck: 10 gp a
  draw, half again for each draw in a row, five placeholder cards for the
  GM to rename (nothing published ships). A wheel: twelve pockets in two
  colours and four rarity bands, 5 gp to 50 gp a bet, three bets a
  character, a 45-second betting window. Each call builds fresh copies.
*/
export const NEW_DEFAULTS = {
  crate: () => ({ name: "New box", price: DEFAULT_PRICE_GP, pools: [], weights: weights(), rules: {} }),
  well: () => ({ kind: "well", name: "New well", price: WELL_DEFAULTS.price, pools: [], weights: weights(), odds: { ...WELL_DEFAULTS.odds }, rules: { cap: WELL_DEFAULTS.cap } }),
  dice: () => ({ kind: "dice", name: "New dice game", price: DICE_DEFAULTS.price, pools: [], weights: weights(), dice: { formula: DICE_DEFAULTS.formula, target: DICE_DEFAULTS.target, multiplier: DICE_DEFAULTS.multiplier }, rules: { prize: false } }),
  deck: () => ({ kind: "deck", name: "New deck", price: DECK_DEFAULTS.price, pools: [], weights: weights(), deck: { step: DECK_DEFAULTS.step, shuffledAt: 0, cards: DECK_DEFAULTS.cards.map(c => ({ ...c })) }, rules: {} }),
  roulette: () => {
    const d = ROULETTE_DEFAULTS;
    return { kind: "roulette", name: "New wheel", price: d.price, pools: [], weights: weights(), roulette: { colours: [...d.colours], pockets: d.pockets.map(p => ({ ...p })), payouts: { ...d.payouts }, itemOnRarity: d.itemOnRarity, maxStake: d.maxStake, maxBets: d.maxBets, windowSec: d.windowSec }, rules: {} };
  },
};

// The dialog's title: the words on the button that opened it, so what the
// GM pressed is what they see. An existing record's editor says Edit.
export const NEW_TITLE = { crate: "New box", well: "New well", dice: "New dice game", deck: "New deck", roulette: "New wheel" };
export const EDIT_TITLE = { crate: "Edit box", well: "Edit well", dice: "Edit dice game", deck: "Edit deck", roulette: "Edit wheel" };
export const COPY_TITLE = { crate: "Copy box", well: "Copy well", dice: "Copy dice game", deck: "Copy deck", roulette: "Copy wheel" };
export function editorTitle(game, isNew, copy = false) {
  const [titles, fallback] = copy ? [COPY_TITLE, "Copy game"] : isNew ? [NEW_TITLE, "New game"] : [EDIT_TITLE, "Edit game"];
  return titles[kindOf(game)] ?? fallback;
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
  return newDraft("crate", { id, name: fromTable.name || "New box", pools: [{ id: poolId, share: 1 }], rules: { oddsMode: "weight" }, fromTable });
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
  drawn, and the log, each character's pity and collection and any live
  round are keyed on the source's id, so the copy starts with none.
*/
export function copyOf(game, { id, now = 0, names = [] } = {}) {
  const copy = structuredClone(game);
  copy.id = id;
  copy.name = copyName(game?.name, names);
  copy.rules = restocked(copy.rules ?? {});
  if (copy.deck) copy.deck = { ...copy.deck, shuffledAt: now };
  return copy;
}

/*
  A copy's name: "<name> (copy)", then "(copy 2)", "(copy 3)" and so on.
  A copy of a copy counts on from it ("Crate (copy)" gives "Crate (copy
  2)", never "Crate (copy) (copy)"), and a name already in `names` is
  skipped, so copying one game twice gives two names.
*/
export function copyName(name, names = []) {
  const m = String(name || "Game").match(/^(.*) \(copy(?: (\d+))?\)$/);
  const base = m ? m[1] : String(name || "Game");
  const taken = new Set(names);
  let n = m ? (Number(m[2]) || 1) + 1 : 1;
  const nameAt = k => (k === 1 ? `${base} (copy)` : `${base} (copy ${k})`);
  while (taken.has(nameAt(n))) n++;
  return nameAt(n);
}

// The New dialog's default button: it puts the game where players buy, or,
// while the shop is closed or the editor's "On the shelf" is unticked
// (shelf.js), only on the GM's list.
export const addLabel = (shopOpen, onShelf = true) => (shopOpen && onShelf ? "Add to shelf" : "Add");

// The Boxes tab's status line after the Save: where the game went and
// whether players can see it. A table game isn't priced; its bets are.
export function addedNotice(game, { shopOpen = true } = {}) {
  const name = game?.name || "The game";
  if (!onShelf(game)) return `${name} added off the shelf. Players can't see it until you put it on the shelf.`;
  if (!shopOpen) return `${name} added. The shop is closed, so players can't see it yet.`;
  const price = formatPrice(Number(game?.price) || 0);
  return getKind(kindOf(game))?.table ? `${name} is on the shelf; bets from ${price}.` : `${name} is on the shelf at ${price}.`;
}
