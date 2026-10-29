/*
  A ticket's data (games/ticket.js): an ordinary dnd5e consumable with one
  utility activity named for the play, and the mark that names its game;
  what the log keeps of it; and the words a ticket's play shows where a
  purchase shows its price.
*/
import { describe, it, expect, afterEach, vi } from "vitest";
import { ticketData, ticketOf, ticketable, ticketCount, redeemRow, priceTag, rowPriceTag, useWord, TICKET_ACTIVITY_ID } from "../module/scripts/games/ticket.js";
import { getKind } from "../module/scripts/games/kinds.js";
import { grantData } from "../module/scripts/games/crate.js";
import { moneyText } from "../module/scripts/games/dicegame.js";
import { isMiss, collapseMisses } from "../module/scripts/games/well.js";
import { logTableHTML } from "../module/scripts/views/logtable.js";
import "../module/scripts/games/deck.js";
import "../module/scripts/games/scratch.js";
import "../module/scripts/games/roulette.js";
import "../module/scripts/games/auction.js";

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const CRATE = { id: "box", name: "Gilded Crate", price: 25, pools: [], rules: {} };

describe("ticketData", () => {
  it("is a consumable with the game's name, its price as the value, quantity 1 and one utility activity", () => {
    const data = ticketData(CRATE);
    expect(data).toMatchObject({
      name: "Gilded Crate", type: "consumable", img: "icons/containers/chest/chest-reinforced-steel-brown.webp",
      system: { quantity: 1, price: { value: 25, denomination: "gp" }, type: { value: "trinket" } },
      flags: { "loot-crates": { ticket: { boxId: "box", paid: 0 } } },
    });
    const activities = Object.values(data.system.activities);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ _id: TICKET_ACTIVITY_ID, type: "utility", name: "Open" });
    expect(TICKET_ACTIVITY_ID).toMatch(/^[a-zA-Z0-9]{16}$/);
    expect(data.system.description.value).toContain("One play of Gilded Crate.");
  });

  it("names the activity for each pulled game's play", () => {
    expect(useWord({ kind: "crate" })).toBe("Open");
    expect(useWord({})).toBe("Open");
    expect(useWord({ kind: "scratch" })).toBe("Scratch");
    expect(useWord({ kind: "well" })).toBe("Throw");
    expect(useWord({ kind: "dice" })).toBe("Roll");
    expect(useWord({ kind: "deck" })).toBe("Draw");
    for (const kind of ["scratch", "well", "dice", "deck"]) expect(Object.values(ticketData({ ...CRATE, kind }).system.activities)[0].name).toBe(useWord({ kind }));
  });

  it("keeps what a bought ticket cost, as its mark and its value", () => {
    const data = ticketData(CRATE, { paid: 20 });
    expect(data.flags["loot-crates"].ticket).toEqual({ boxId: "box", paid: 20 });
    expect(data.system.price.value).toBe(20);
  });
});

describe("which games have tickets", () => {
  it("every pulled game, never a table game or an unknown kind", () => {
    for (const kind of [undefined, "crate", "well", "dice", "deck", "scratch"]) expect(ticketable({ kind })).toBe(true);
    expect(getKind("roulette")?.table).toBe(true);
    expect(ticketable({ kind: "roulette" })).toBe(false);
    expect(ticketable({ kind: "auction" })).toBe(false);
    expect(ticketable({ kind: "lottery" })).toBe(false);
    expect(ticketable(null)).toBe(false);
  });
});

describe("a ticket's mark", () => {
  it("is read from the flag, and nothing else counts as a ticket", () => {
    expect(ticketOf({ flags: { "loot-crates": { ticket: { boxId: "box", paid: "5" } } } })).toEqual({ boxId: "box", paid: 5 });
    expect(ticketOf({ flags: { "loot-crates": { boxId: "box", sourceUuid: "x" } } })).toBeNull();
    expect(ticketOf({ flags: { "loot-crates": { ticket: { boxId: "" } } } })).toBeNull();
    expect(ticketOf(null)).toBeNull();
    expect(ticketCount({ system: { quantity: 3 } })).toBe(3);
    expect(ticketCount({ system: {} })).toBe(0);
  });

  it("stays on a ticket a pool hands out as a prize", () => {
    const source = { name: "Gilded Crate", toObject: () => ({ _id: "w1", ...ticketData(CRATE) }) };
    const { grant } = grantData(source, { entry: { uuid: "Item.w1" }, rarity: "common" }, { id: "other" });
    expect(grant.flags["loot-crates"]).toMatchObject({ ticket: { boxId: "box", paid: 0 }, boxId: "other", sourceUuid: "Item.w1" });
  });
});

describe("redeemRow", () => {
  it("keeps one ticket's data for a refund to make again, without its id, stats or folder", () => {
    const row = redeemRow({ _id: "tix", folder: "f", _stats: { a: 1 }, ...ticketData(CRATE, { paid: 20 }), system: { ...ticketData(CRATE).system, quantity: 3 } }, { boxId: "box", paid: 20 });
    expect(row).toMatchObject({ itemId: "tix", itemName: "Gilded Crate", paid: 20 });
    expect(row.data.system.quantity).toBe(1);
    expect(row.data).not.toHaveProperty("_id");
    expect(row.data).not.toHaveProperty("_stats");
    expect(row.data).not.toHaveProperty("folder");
  });
});

describe("what a ticket's play says in place of the price", () => {
  it("the reveal's and chat card's price slot", () => {
    expect(priceTag({ box: { price: 12.5 } })).toBe("12 gp 5 sp");
    expect(priceTag({ box: { price: 0 }, redeem: { itemName: "Gilded Crate", paid: 0 } })).toBe("with a ticket");
  });

  it("every pulled kind's head and chat head", () => {
    const reveal = { actorName: "Tam", box: { id: "box", name: "Gilded Crate", price: 0 }, redeem: { itemName: "Gilded Crate", paid: 0 }, result: { name: "Rope", rarity: "common" }, formula: "3d6", target: 12, faces: [1, 2, 3], card: { label: "A blank card", kind: "blank" } };
    for (const id of ["crate", "well", "dice", "deck", "scratch"]) {
      const kind = getKind(id);
      const head = kind.reveal.head?.(reveal, { esc });
      if (head) expect(head, id).toContain("with a ticket");
    }
    const card = getKind("crate").chat.card(reveal, { esc, itemLink: (_u, n) => n });
    expect(card).toContain('<span class="lc-chat__price">with a ticket</span>');
    expect(card).not.toContain("0 gp");
  });

  it("a lost throw of the dice with a ticket loses the ticket, not 0 gp", () => {
    expect(moneyText({ win: false, price: 0, ticket: true })).toBe("Lost the ticket");
    expect(moneyText({ win: false, price: 10 })).toBe("Lost 10 gp");
  });

  it("the Pull log's row says ticket, and a ticket's miss is never folded with paid ones", () => {
    const row = { id: "r1", kind: "crate", boxId: "box", boxName: "Gilded Crate", actorId: "tam", actorName: "Tam", at: 1, price: 0, payoutCp: 0, outcome: "nothing", name: "Nothing", redeem: { itemId: "tix", itemName: "Gilded Crate", paid: 0 } };
    expect(rowPriceTag(row)).toBe("ticket");
    expect(rowPriceTag({ price: 25 })).toBe("25 gp");
    expect(isMiss(row)).toBe(false);
    expect(collapseMisses([row, { ...row, id: "r2", redeem: undefined }]).map(x => (x.group ? "group" : "row"))).toEqual(["row", "group"]);
    expect(logTableHTML({ log: [row], esc })).toContain("Gilded Crate (ticket)");
  });
});

describe("the refund card for a ticket's play", () => {
  afterEach(() => { delete globalThis.ChatMessage; delete globalThis.foundry; delete globalThis.game; });

  it("says the ticket came back, names the prize taken back, and shows no price", async () => {
    globalThis.foundry = { utils: { escapeHTML: s => String(s) } };
    globalThis.game = { messages: { contents: [] } };
    const created = [];
    globalThis.ChatMessage = { create: vi.fn(async d => { created.push(d); return d; }), getSpeaker: () => ({}) };
    const { postRefundCard } = await import("../module/scripts/foundry/chat.js");
    const row = { boxId: "box", boxName: "Gilded Crate", actorName: "Tam", price: 0, payoutCp: 0, itemId: "i1", name: "Rope", redeem: { itemId: "tix", itemName: "Gilded Crate", paid: 0 } };
    await postRefundCard({ row, actor: { name: "Tam" }, removedItem: "Rope", removedItems: ["Rope"], goneItems: [], ticketBack: "stack" });
    const html = created[0].content;
    expect(html).toContain("Their Gilded Crate ticket went back into their pack.");
    expect(html).toContain("Rope was removed from their inventory.");
    // The head names no price: the line under it says the ticket came back.
    expect(html).not.toContain("lc-chat__price");
    expect(html).not.toContain("coin");

    await postRefundCard({ row: { ...row, itemId: null, payoutCp: 2500 }, actor: { name: "Tam" }, removedItems: [], goneItems: [], ticketBack: "made" });
    expect(created[1].content).toContain("Their Gilded Crate ticket went back into their pack. The 25 gp won was taken back from their purse.");
  });
});
