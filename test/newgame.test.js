/*
  A New on the Boxes tab starts from a draft (newgame.js): one builder per
  kind, each call a fresh copy, the id the manager gives it, the dialog's
  words and the status line's sentence once it is on the shelf. Nothing
  here writes.
*/
import { describe, it, expect } from "vitest";
import { NEW_DEFAULTS, NEW_TITLE, EDIT_TITLE, editorTitle, newDraft, crateFromPool, addLabel, addedNotice } from "../module/scripts/newgame.js";
import { DEFAULT_WEIGHTS, DEFAULT_PRICE_GP } from "../module/scripts/config.js";
import { WELL_DEFAULTS } from "../module/scripts/well.js";
import { DICE_DEFAULTS } from "../module/scripts/dicegame.js";
import { DECK_DEFAULTS } from "../module/scripts/deck.js";
import { ROULETTE_DEFAULTS } from "../module/scripts/roulette.js";
import { kindOf } from "../module/scripts/kinds.js";

const KINDS = ["crate", "well", "dice", "deck", "roulette"];

describe("the defaults per kind", () => {
  it("cover every kind the Boxes tab offers, each as that kind with the button's name", () => {
    expect(Object.keys(NEW_DEFAULTS)).toEqual(KINDS);
    for (const k of KINDS) {
      const d = NEW_DEFAULTS[k]();
      expect(kindOf(d)).toBe(k);
      expect(d.name).toBe(NEW_TITLE[k]);
      expect(d.pools).toEqual([]);
      expect(d.weights).toEqual(DEFAULT_WEIGHTS);
    }
  });

  it("are what each New wrote before: the crate's price, the well's silver and cap, the dice, the deck's cards, the wheel", () => {
    expect(NEW_DEFAULTS.crate()).toEqual({ name: "New box", price: DEFAULT_PRICE_GP, pools: [], weights: DEFAULT_WEIGHTS, rules: {} });
    expect(NEW_DEFAULTS.well()).toMatchObject({ kind: "well", price: WELL_DEFAULTS.price, odds: WELL_DEFAULTS.odds, rules: { cap: WELL_DEFAULTS.cap } });
    expect(NEW_DEFAULTS.dice()).toMatchObject({ kind: "dice", price: DICE_DEFAULTS.price, dice: { formula: "3d6", target: 12, multiplier: 3 }, rules: { prize: false } });
    expect(NEW_DEFAULTS.deck()).toMatchObject({ kind: "deck", price: DECK_DEFAULTS.price, deck: { step: DECK_DEFAULTS.step, shuffledAt: 0, cards: DECK_DEFAULTS.cards } });
    const d = ROULETTE_DEFAULTS;
    expect(NEW_DEFAULTS.roulette()).toMatchObject({ kind: "roulette", price: d.price, roulette: { colours: d.colours, pockets: d.pockets, payouts: d.payouts, itemOnRarity: d.itemOnRarity, maxStake: d.maxStake, maxBets: d.maxBets, windowSec: d.windowSec } });
  });

  it("give fresh copies, so editing one draft can't change the next", () => {
    const a = NEW_DEFAULTS.deck();
    a.deck.cards[0].label = "Changed";
    a.weights.common = 0;
    expect(NEW_DEFAULTS.deck().deck.cards[0].label).toBe(DECK_DEFAULTS.cards[0].label);
    expect(NEW_DEFAULTS.deck().weights.common).toBe(DEFAULT_WEIGHTS.common);
    expect(DECK_DEFAULTS.cards[0].label).not.toBe("Changed");
    const w = NEW_DEFAULTS.roulette();
    w.roulette.pockets.pop();
    expect(NEW_DEFAULTS.roulette().roulette.pockets).toHaveLength(ROULETTE_DEFAULTS.pockets.length);
  });
});

describe("newDraft", () => {
  it("is the kind's defaults under the given id, with any fields given over them", () => {
    expect(newDraft("dice", { id: "d1" })).toEqual({ ...NEW_DEFAULTS.dice(), id: "d1" });
    expect(newDraft("crate", { id: "c1", name: "Gilded", price: 250 })).toMatchObject({ id: "c1", name: "Gilded", price: 250, pools: [] });
  });

  it("refuses a kind with no New", () => {
    expect(() => newDraft("auction", { id: "x" })).toThrow(/no New/);
  });
});

describe("crateFromPool", () => {
  it("is a crate named for the pool that draws from it alone", () => {
    const d = crateFromPool({ id: "p7", name: "Leigh's homebrew", entries: [] }, "c9");
    expect(d).toMatchObject({ id: "c9", name: "Leigh's homebrew", price: DEFAULT_PRICE_GP, pools: [{ id: "p7", share: 1 }] });
    expect(kindOf(d)).toBe("crate");
  });
});

describe("the dialog's words", () => {
  it("title a new game by the button that opened it, and an edit by Edit", () => {
    for (const k of KINDS) {
      expect(editorTitle(NEW_DEFAULTS[k](), true)).toBe(NEW_TITLE[k]);
      expect(editorTitle(NEW_DEFAULTS[k](), false)).toBe(EDIT_TITLE[k]);
    }
    expect(editorTitle({ name: "Old", price: 5 }, false)).toBe("Edit box");
    expect(NEW_TITLE.dice).toBe("New dice game");
  });

  it("put the game on the shelf, or only add it while the shop is closed", () => {
    expect(addLabel(true)).toBe("Add to shelf");
    expect(addLabel(false)).toBe("Add");
  });
});

describe("addedNotice", () => {
  it("says the game is on the shelf and what it costs", () => {
    expect(addedNotice({ name: "Gilded Crate", price: 250 }, { shopOpen: true })).toBe("Gilded Crate is on the shelf at 250 gp.");
    expect(addedNotice(newDraft("well", { id: "w" }), { shopOpen: true })).toBe("New well is on the shelf at 1 sp.");
  });

  it("says a table game's bets, since a wheel isn't priced", () => {
    expect(addedNotice(newDraft("roulette", { id: "r" }), { shopOpen: true })).toBe("New wheel is on the shelf; bets from 5 gp.");
  });

  it("says the shop is closed when players can't see it yet", () => {
    expect(addedNotice({ name: "Gilded Crate", price: 250 }, { shopOpen: false })).toBe("Gilded Crate added. The shop is closed, so players can't see it yet.");
  });
});
