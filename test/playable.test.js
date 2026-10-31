/*
  Whether a game can be played as its editor would save it (views/playable.js):
  one verdict per kind, the sentence its own readout already warns with,
  "" when it can. The editor keeps a game it refuses off the shelf.
*/
import { describe, it, expect } from "vitest";
import { unplayableReason } from "../module/scripts/views/playable.js";
import { newDraft } from "../module/scripts/views/newgame.js";

const POOLS = {
  p: { id: "p", name: "Hoard", pools: [], entries: [{ uuid: "Item.a", name: "Rope", img: "", rarity: "common", weight: 1 }, { uuid: "Item.b", name: "Flame Tongue", img: "", rarity: "rare", weight: 1 }] },
  empty: { id: "empty", name: "Empty", pools: [], entries: [] },
};
const draft = (kind, over = {}) => ({ ...newDraft(kind, { id: kind }), ...over });
const withPool = { pools: [{ id: "p", share: 1 }] };

describe("unplayableReason", () => {
  it("a crate that can drop nothing: no pool ticked, or pools with nothing in them", () => {
    expect(unplayableReason(draft("crate"), POOLS)).toBe("This crate can drop nothing: tick a pool above.");
    expect(unplayableReason(draft("crate", { pools: [{ id: "empty", share: 1 }] }), POOLS)).toBe("This crate can drop nothing: its pools have no item that can drop.");
    expect(unplayableReason(draft("crate", withPool), POOLS)).toBe("");
    // A price of 0 is the GM's choice (asked once in the editor), not a broken game.
    expect(unplayableReason(draft("crate", { ...withPool, price: 0 }), POOLS)).toBe("");
  });

  it("a scratch ticket whose item prizes have no pool, or whose every ticket is a dud", () => {
    expect(unplayableReason(draft("scratch"), POOLS)).toBe("Tick a pool for the item prizes, or those tickets can't be sold.");
    expect(unplayableReason(draft("scratch", withPool), POOLS)).toBe("");
    const duds = draft("scratch", { ...withPool, roll: { id: 1, size: 100, prizes: [] } });
    expect(unplayableReason(duds, POOLS)).toBe("Every ticket is a dud: add a prize to the list.");
    // Coins only need no pool.
    expect(unplayableReason(draft("scratch", { roll: { id: 1, size: 10, prizes: [{ count: 2, parts: [{ gp: 5 }] }] } }), POOLS)).toBe("");
  });

  it("a scratch roll no ticked pool can give a prize from is unplayable; one undrawable prize beside a drawable one only warns", () => {
    // Copilot's review of PR #35: ten rare items in a roll of ten, from a pool that holds no rare item.
    const commonOnly = { ...POOLS, c: { id: "c", name: "Commons", pools: [], entries: [{ uuid: "Item.a", name: "Rope", img: "", rarity: "common", weight: 1 }] } };
    const rares = draft("scratch", { pools: [{ id: "c", share: 1 }], roll: { id: 1, size: 10, prizes: [{ count: 10, parts: [{ item: { rarity: "rare" } }] }] } });
    expect(unplayableReason(rares, commonOnly)).toBe("The ticked pools can't give any prize on this roll: tick a pool that holds the prizes' rarities.");
    // With duds beside them, every ticket sold would still be a dud.
    expect(unplayableReason({ ...rares, roll: { id: 1, size: 50, prizes: [{ count: 2, parts: [{ item: { rarity: "rare" } }] }] } }, commonOnly)).not.toBe("");
    // A coin prize can still be won: the rare item only waits in the roll.
    expect(unplayableReason({ ...rares, roll: { id: 1, size: 50, prizes: [{ count: 2, parts: [{ item: { rarity: "rare" } }] }, { count: 5, parts: [{ gp: 5 }] }] } }, commonOnly)).toBe("");
    // The pool that holds a rare makes it playable.
    expect(unplayableReason({ ...rares, pools: [{ id: "p", share: 1 }] }, POOLS)).toBe("");
  });

  it("an auction with no lot", () => {
    expect(unplayableReason(draft("auction"), POOLS)).toBe("Pick a lot: an auction with none can't be opened.");
    expect(unplayableReason(draft("auction", { auction: { ...draft("auction").auction, lot: { type: "item", uuid: "Item.b", name: "Flame Tongue", rarity: "rare" } } }), POOLS)).toBe("");
  });

  it("the other kinds' own warnings: a dry well, a dragon nobody beats, a deck with no card to draw, a wheel of one pocket", () => {
    for (const kind of ["well", "dice", "deck", "roulette"]) expect(unplayableReason(draft(kind), POOLS)).toBe("");
    expect(unplayableReason(draft("well", { odds: { nothing: 0, coin: 0, item: 0 } }), POOLS)).toBe("This well is dry: every outcome weighs 0.");
    expect(unplayableReason(draft("dice", { dice: { formula: "2d6", target: 12, multiplier: 3 } }), POOLS)).toMatch(/^Nobody can beat 12 on 2d6/);
    expect(unplayableReason(draft("deck", { deck: { step: 1.5, shuffledAt: 0, cards: [] } }), POOLS)).toBe("This deck has no cards.");
    const zero = draft("deck");
    zero.deck.cards = zero.deck.cards.map(c => ({ ...c, weight: 0 }));
    expect(unplayableReason(zero, POOLS)).toBe("Every card weighs 0, so nothing can be drawn.");
    const wheel = draft("roulette");
    wheel.roulette.pockets = wheel.roulette.pockets.slice(0, 1);
    expect(unplayableReason(wheel, POOLS)).toBe("The wheel needs at least two pockets: the shop won't sell this.");
  });

  it("softer warnings don't stop a game: a well or a deck with no pool for its items still plays", () => {
    expect(unplayableReason(draft("well"), {})).toBe("");
    expect(unplayableReason(draft("deck"), {})).toBe("");
  });

  it("a kind another module registered has no verdict here", () => {
    expect(unplayableReason({ id: "x", kind: "slots", name: "Slots" }, POOLS)).toBe("");
  });
});
