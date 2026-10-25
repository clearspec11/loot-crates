/*
  A name that is gone (a deleted character's, or a row that never kept
  one) reads as the module's own word for it, never as a hole in the
  sentence: "Someone's Goblin Crate was refunded", "Someone wins 10 gp",
  "Top bid 10 gp by someone". A name that is there still reads as itself;
  i18n.js's blanking stays the last guard behind these.
*/
import { describe, it, expect, afterEach } from "vitest";

const { postRefundCard } = await import("../module/scripts/foundry/chat.js");
const { netText, railHTML, ROULETTE_DEFAULTS } = await import("../module/scripts/games/roulette.js");
const auction = await import("../module/scripts/games/auction.js");
const { getKind } = await import("../module/scripts/games/kinds.js");
const { stakeSentence } = await import("../module/scripts/views/tableview.js");

const GONE = [null, undefined, ""];

describe("the refund card's head (chat.js)", () => {
  afterEach(() => {
    delete globalThis.ChatMessage;
    delete globalThis.foundry;
  });
  const post = async (actor, row) => {
    globalThis.foundry = { utils: { escapeHTML: s => String(s) } };
    globalThis.ChatMessage = { create: async data => data, getSpeaker: () => ({}) };
    return (await postRefundCard({ row: { boxId: "b", boxName: "Goblin Crate", price: 5, itemId: null, ...row }, actor, removedItem: null })).content;
  };

  it("names a deleted character with no name kept on the row as Someone", async () => {
    for (const actorName of GONE) {
      expect(await post(null, { actorName })).toContain("Someone's <strong>Goblin Crate</strong> was refunded");
    }
  });

  it("names a deleted character by the name its row kept, and a live one by its own", async () => {
    expect(await post(null, { actorName: "Brinn" })).toContain("Brinn's <strong>Goblin Crate</strong> was refunded");
    expect(await post({ id: "a1", name: "Orla" }, { actorName: "Brinn" })).toContain("Orla's <strong>Goblin Crate</strong> was refunded");
  });
});

describe("the wheel's nets (roulette.js)", () => {
  it("says Someone in each of the four sentences when the name is gone", () => {
    for (const actorName of GONE) {
      expect(netText({ actorName, net: 1000, won: ["Red"], lost: [], items: [] })).toBe("Someone wins 10 gp on Red");
      expect(netText({ actorName, net: -500, won: [], lost: ["Black"], items: [] })).toBe("Someone loses 5 gp");
      expect(netText({ actorName, net: 0, won: [], lost: [], items: [] })).toBe("Someone's stake came back");
      expect(netText({ actorName, net: 0, won: ["Even"], lost: ["Rare"], items: [] })).toBe("Someone breaks even on Even");
    }
    expect(netText({ actorName: "Tam", net: 1000, won: ["Red"], lost: [], items: [] })).toBe("Tam wins 10 gp on Red");
  });

  it("titles a chip on the rail Someone's when the name is gone", () => {
    const game = { id: "wheel", kind: "roulette", name: "Live wheel", price: 5, pools: [], roulette: { colours: ["Red", "Black"], pockets: ROULETTE_DEFAULTS.pockets } };
    const html = railHTML(game, [{ id: "x", actorId: "gone", actorName: null, price: 10, status: "open", stake: { type: "colour", pick: 1, label: "Black" }, name: "Black" }]);
    expect(html).toContain('title="Someone: 10 gp on Black">?<');
  });
});

describe("the auction's words (auction.js)", () => {
  const ITEM_LOT = { type: "item", uuid: "Item.sling", name: "Sling +2", img: "sling.webp", rarity: "uncommon" };
  const GAME = { id: "lot", name: "The Sling", kind: "auction", price: 10, pools: [], auction: { lot: ITEM_LOT, increment: 5, reserve: 0, gavelSec: 20, house: { count: 0, budget: 100, chance: 25 } }, rules: {} };
  const bidRow = actorName => ({ id: "b1", actorId: "gone", actorName, price: 10, stake: { amount: 10 }, status: "open", roundId: "R" });

  it("the shop card's top bid reads 'by someone' when the bidder's name is gone", () => {
    const card = getKind("auction").shop.card;
    const ctx = name => ({ esc: s => String(s ?? ""), isGM: true, now: 1000, rounds: { R: { id: "R", boxId: "lot", kind: "auction", status: "open", opensAt: 0, closesAt: 999999 } }, log: [bidRow(name)] });
    for (const actorName of GONE) expect(card(GAME, {}, ctx(actorName))).toContain("Top bid 10 gp by someone.");
    expect(card(GAME, {}, ctx("Ana"))).toContain("Top bid 10 gp by Ana.");
  });

  it("the bid, the outbid and the board say Someone when a name is gone", () => {
    expect(auction.bidSentence(bidRow(null))).toBe("Someone bids 10 gp");
    expect(auction.bidAnnouncement({ ...bidRow("Bo"), price: 15, stake: { amount: 15 } }, { outbid: [{ ...bidRow(undefined), status: "refunded" }] })).toBe("Bo bids 15 gp, the top bid; Someone's bid came back.");
    expect(auction.boardHTML(GAME, [bidRow(null)], { history: [bidRow(null)], round: { id: "R", status: "open", closesAt: 5 } })).toContain(">Someone<");
    expect(auction.boardHTML(GAME, [], { outcome: { verdict: "sold", amount: 10, bidder: null, lot: ITEM_LOT, reserveMet: true } })).toContain(">Someone<");
  });

  it("the verdict names the sale and the failed grant without the bidder's name when it is gone", () => {
    expect(auction.verdictText({ verdict: "sold", amount: 10, bidder: null, lot: ITEM_LOT })).toBe("Sold to someone for 10 gp.");
    expect(auction.verdictText({ verdict: "grant", amount: 10, bidder: null, lot: ITEM_LOT })).toBe("No sale: the lot couldn't be put on the winner's sheet. The top bid of 10 gp came back.");
    expect(auction.verdictText({ verdict: "sold", amount: 10, bidder: "Bo", lot: ITEM_LOT })).toBe("Sold to Bo for 10 gp.");
  });
});

describe("a table stake's sentence (tableview.js)", () => {
  it("says Someone when the name is gone", () => {
    for (const actorName of GONE) expect(stakeSentence({ actorName, price: 5, name: "Red" }, "bets")).toBe("Someone bets 5 gp on Red");
  });
});
