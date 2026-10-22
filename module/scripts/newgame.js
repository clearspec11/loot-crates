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

  No Foundry globals: the manager passes the id (store.js newId).
*/
import { DEFAULT_WEIGHTS, DEFAULT_PRICE_GP } from "./config.js";
import { getKind, kindOf } from "./kinds.js";
import { WELL_DEFAULTS } from "./well.js";
import { DICE_DEFAULTS } from "./dicegame.js";
import { DECK_DEFAULTS } from "./deck.js";
import { ROULETTE_DEFAULTS } from "./roulette.js";
import { formatPrice } from "./currency.js";

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
export const editorTitle = (game, isNew) => (isNew ? NEW_TITLE : EDIT_TITLE)[kindOf(game)] ?? (isNew ? "New game" : "Edit game");

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

// The New dialog's default button: it puts the game where players buy, or,
// while the shop is closed, only on the GM's list.
export const addLabel = shopOpen => (shopOpen ? "Add to shelf" : "Add");

// The Boxes tab's status line after the Save: where the game went and
// whether players can see it. A table game isn't priced; its bets are.
export function addedNotice(game, { shopOpen = true } = {}) {
  const name = game?.name || "The game";
  if (!shopOpen) return `${name} added. The shop is closed, so players can't see it yet.`;
  const price = formatPrice(Number(game?.price) || 0);
  return getKind(kindOf(game))?.table ? `${name} is on the shelf; bets from ${price}.` : `${name} is on the shelf at ${price}.`;
}
