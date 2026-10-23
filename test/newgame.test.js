/*
  A New on the Boxes tab starts from a draft (newgame.js): one builder per
  kind, each call a fresh copy, the id the manager gives it, the dialog's
  words and the status line's sentence once it is on the shelf. A Copy on
  a row starts from that game (copyOf): every setting as its own copy,
  none of its history. Nothing here writes.
*/
import { describe, it, expect } from "vitest";
import { NEW_DEFAULTS, NEW_TITLE, EDIT_TITLE, COPY_TITLE, editorTitle, newDraft, crateFromPool, copyOf, copyName, addLabel, addedNotice } from "../module/scripts/newgame.js";
import { drawnIds, deckOdds } from "../module/scripts/deck.js";
import { liveRoundOf, newRound } from "../module/scripts/round.js";
import { stockOf } from "../module/scripts/limits.js";
import { DEFAULT_WEIGHTS, DEFAULT_PRICE_GP } from "../module/scripts/config.js";
import { WELL_DEFAULTS } from "../module/scripts/well.js";
import { DICE_DEFAULTS } from "../module/scripts/dicegame.js";
import { DECK_DEFAULTS } from "../module/scripts/deck.js";
import { ROULETTE_DEFAULTS } from "../module/scripts/roulette.js";
import { kindOf } from "../module/scripts/kinds.js";

const KINDS = ["crate", "well", "dice", "deck", "roulette", "auction"];

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
    expect(() => newDraft("raffle", { id: "x" })).toThrow(/no New/);
  });
});

describe("crateFromPool", () => {
  it("is a crate named for the pool that draws from it alone", () => {
    const d = crateFromPool({ id: "p7", name: "Leigh's homebrew", entries: [] }, "c9");
    expect(d).toMatchObject({ id: "c9", name: "Leigh's homebrew", price: DEFAULT_PRICE_GP, pools: [{ id: "p7", share: 1 }] });
    expect(kindOf(d)).toBe("crate");
  });
});

// One built game of each kind, with history a copy must not carry: a
// stock part sold, a deck with a once card drawn, a wheel with a round open.
const SOURCES = {
  crate: { id: "c1", name: "Goblin Crate", price: 150, pools: [{ id: "p1", share: 2 }, { id: "p2", share: 1 }], weights: { common: 50, uncommon: 30, rare: 15, veryRare: 4, legendary: 1, artifact: 0 }, rules: { pity: { minRarity: "rare", after: 8 }, noDuplicates: true, stock: 3, stockMax: 10, perCharacter: { max: 2, per: "day" } } },
  well: { id: "w1", kind: "well", name: "Old Well", price: 0.1, pools: [{ id: "p1", share: 1 }], weights: { common: 1, uncommon: 1, rare: 1, veryRare: 0, legendary: 0, artifact: 0 }, odds: { nothing: 90, coin: 8, item: 2 }, rules: { cap: 3, pity: { minRarity: "uncommon", after: 20 }, stock: 0, stockMax: 5 } },
  dice: { id: "d1", kind: "dice", name: "Dragon's Teeth", price: 10, pools: [{ id: "p2", share: 1 }], weights: { common: 1, uncommon: 1, rare: 1, veryRare: 1, legendary: 1, artifact: 1 }, dice: { formula: "2d6", target: 9, multiplier: 2.5 }, rules: { prize: true, perCharacter: { max: 3, per: "ever" }, stock: 1, stockMax: 4 } },
  deck: { id: "k1", kind: "deck", name: "Thornwick Deck", price: 10, pools: [{ id: "p1", share: 1 }], weights: { common: 0, uncommon: 2, rare: 1, veryRare: 0, legendary: 0, artifact: 0 }, deck: { step: 1.5, shuffledAt: 1000, cards: [{ id: "a", label: "Sun", kind: "item", weight: 2, once: true, gp: 0, text: "" }, { id: "b", label: "Ruin", kind: "loss", weight: 1, once: false, gp: 25, text: "" }, { id: "c", label: "Fates", kind: "effect", weight: 1, once: true, gp: 0, text: "Undo one thing." }] }, rules: { stock: 2, stockMax: 2 } },
  auction: { id: "u1", kind: "auction", name: "The Sling", price: 10, pools: [], weights: { common: 1, uncommon: 1, rare: 1, veryRare: 1, legendary: 1, artifact: 1 }, auction: { lot: { type: "item", uuid: "Item.sling", name: "Sling +2", img: "", rarity: "uncommon" }, increment: 5, reserve: 30, gavelSec: 20, house: { count: 2, budget: 60, chance: 25 } }, rules: {} },
  roulette: { id: "r1", kind: "roulette", name: "Wheel of Fate", price: 5, pools: [{ id: "p2", share: 1 }], weights: { common: 1, uncommon: 1, rare: 1, veryRare: 1, legendary: 1, artifact: 1 }, roulette: { colours: ["red", "black"], pockets: [{ n: 1, colour: 0, rarity: "common" }, { n: 2, colour: 1, rarity: "rare" }, { n: 3, colour: 0, rarity: "legendary" }], payouts: { colour: 1, number: 11, rarity: 3 }, itemOnRarity: true, maxStake: 50, maxBets: 3, windowSec: 45 }, rules: {} },
};
// The copy's settings are the source's but for the id, the name and what is reset.
const settingsOf = g => { const { id, name, rules, deck, ...rest } = g; const { stock, ...keep } = rules ?? {}; void id; void name; void stock; return { ...rest, rules: keep, deck: deck ? { ...deck, shuffledAt: null } : undefined }; };

describe("copyOf", () => {
  for (const k of KINDS) {
    it(`${k}: every setting as its own copy, a new id, "(copy)" on the name, the source unchanged`, () => {
      const source = structuredClone(SOURCES[k]);
      const was = structuredClone(source);
      const copy = copyOf(source, { id: "new1", now: 5000 });
      expect(copy.id).toBe("new1");
      expect(copy.name).toBe(`${source.name} (copy)`);
      expect(kindOf(copy)).toBe(k);
      expect(settingsOf(copy)).toEqual(settingsOf(source));
      expect(copy.pools).not.toBe(source.pools);
      expect(copy.weights).not.toBe(source.weights);
      expect(copy.rules).not.toBe(source.rules);
      if (source.deck) { expect(copy.deck.cards).not.toBe(source.deck.cards); expect(copy.deck.cards[0]).not.toBe(source.deck.cards[0]); }
      if (source.roulette) { expect(copy.roulette.pockets).not.toBe(source.roulette.pockets); expect(copy.roulette.pockets[0]).not.toBe(source.roulette.pockets[0]); }
      expect(source).toEqual(was);
    });

    it(`${k}: changing the copy's pools, weights, cards or pockets leaves the source as it was`, () => {
      const source = structuredClone(SOURCES[k]);
      const was = structuredClone(source);
      const copy = copyOf(source, { id: "new2" });
      copy.pools.push({ id: "p9", share: 1 });
      copy.weights.common = 999;
      copy.rules.pity = { minRarity: "legendary", after: 1 };
      if (copy.deck) { copy.deck.cards[0].label = "Changed"; copy.deck.cards.pop(); }
      if (copy.roulette) { copy.roulette.pockets[0].rarity = "artifact"; copy.roulette.pockets.pop(); copy.roulette.payouts.colour = 99; }
      if (copy.dice) copy.dice.target = 2;
      if (copy.odds) copy.odds.item = 50;
      if (copy.auction) { copy.auction.lot.name = "Changed"; copy.auction.house.count = 0; }
      expect(source).toEqual(was);
    });
  }

  it("starts with the stock full again: what the GM set, or the count alone on an older record, or none", () => {
    expect(stockOf(copyOf(SOURCES.crate, { id: "x" }))).toEqual({ left: 10, max: 10 });
    expect(stockOf(copyOf(SOURCES.well, { id: "x" }))).toEqual({ left: 5, max: 5 });
    expect(stockOf(copyOf({ name: "Old", price: 1, rules: { stock: 4 } }, { id: "x" }))).toEqual({ left: 4, max: null });
    expect(stockOf(copyOf({ name: "Open", price: 1, rules: {} }, { id: "x" }))).toBeNull();
    expect(copyOf({ name: "Bare", price: 1 }, { id: "x" }).rules).toEqual({});
  });

  it("starts the deck fresh: no card counts as drawn against a log holding the source's draws", () => {
    const source = SOURCES.deck;
    const log = [
      { id: "l1", kind: "deck", boxId: "k1", cardId: "a", at: 2000, actorId: "A" },
      { id: "l2", kind: "deck", boxId: "k1", cardId: "c", at: 3000, actorId: "A" },
    ];
    expect(drawnIds(source, log)).toEqual(new Set(["a", "c"]));
    const copy = copyOf(source, { id: "k2", now: 4000 });
    expect(copy.deck.shuffledAt).toBe(4000);
    expect(drawnIds(copy, log)).toEqual(new Set());
    expect(deckOdds(copy, {}, log).drawn).toBe(0);
    // Even a row at the copy's own id from before its shuffle mark is out.
    expect(drawnIds(copy, [...log, { id: "l3", kind: "deck", boxId: "k2", cardId: "a", at: 3500 }])).toEqual(new Set());
    expect(copyOf(source, { id: "k3" }).deck.shuffledAt).toBe(0);
  });

  it("has no live round: the source's open round stays the source's", () => {
    const rounds = { R1: newRound({ id: "R1", game: SOURCES.roulette, now: 1000 }) };
    expect(liveRoundOf(rounds, "r1")).not.toBeNull();
    const copy = copyOf(SOURCES.roulette, { id: "r2" });
    expect(liveRoundOf(rounds, copy.id)).toBeNull();
    expect(JSON.stringify(copy)).not.toContain("R1");
  });

  it("names an unnamed game, and counts on from an earlier copy", () => {
    expect(copyOf({ price: 1 }, { id: "x" }).name).toBe("Game (copy)");
    expect(copyOf({ name: "Goblin Crate (copy)", price: 1 }, { id: "y" }).name).toBe("Goblin Crate (copy 2)");
    expect(copyOf({ name: "Goblin Crate (copy 2)", price: 1 }, { id: "z" }).name).toBe("Goblin Crate (copy 3)");
  });

  it("numbers copies in sequence, never '(copy) (copy)', and skips a name already taken", () => {
    const seq = ["Goblin Crate"];
    for (let i = 0; i < 4; i++) seq.push(copyName(seq.at(-1)));
    expect(seq).toEqual(["Goblin Crate", "Goblin Crate (copy)", "Goblin Crate (copy 2)", "Goblin Crate (copy 3)", "Goblin Crate (copy 4)"]);
    // Copying the original twice: the second copy doesn't reuse the first's name.
    expect(copyName("Goblin Crate", ["Goblin Crate", "Goblin Crate (copy)"])).toBe("Goblin Crate (copy 2)");
    expect(copyName("Goblin Crate (copy)", ["Goblin Crate (copy 2)", "Goblin Crate (copy 3)"])).toBe("Goblin Crate (copy 4)");
    expect(copyOf({ name: "Old Well", price: 1 }, { id: "w", names: ["Old Well", "Old Well (copy)"] }).name).toBe("Old Well (copy 2)");
    // A name that only looks like a copy in the middle is a plain name.
    expect(copyName("Crate (copy) of doom")).toBe("Crate (copy) of doom (copy)");
    expect(copyName("")).toBe("Game (copy)");
  });
});

describe("the dialog's words", () => {
  it("title a new game by the button that opened it, an edit by Edit, and a copy by Copy", () => {
    for (const k of KINDS) {
      expect(editorTitle(NEW_DEFAULTS[k](), true)).toBe(NEW_TITLE[k]);
      expect(editorTitle(NEW_DEFAULTS[k](), false)).toBe(EDIT_TITLE[k]);
      expect(editorTitle(NEW_DEFAULTS[k](), true, true)).toBe(COPY_TITLE[k]);
    }
    expect(editorTitle({ name: "Old", price: 5 }, false)).toBe("Edit box");
    expect(editorTitle({ name: "Old", price: 5 }, true, true)).toBe("Copy box");
    expect(editorTitle({ kind: "raffle", name: "Lot" }, true, true)).toBe("Copy game");
    expect(NEW_TITLE.dice).toBe("New dice game");
    expect(COPY_TITLE.dice).toBe("Copy dice game");
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
