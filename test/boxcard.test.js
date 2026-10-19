import { describe, it, expect } from "vitest";
import { boxCard, buyReason, oddsPills } from "../module/scripts/boxcard.js";
import { shopOdds } from "../module/scripts/odds.js";
import { shortfall } from "../module/scripts/currency.js";
import { POOLS, BOXES } from "../harness/sample.js";

const byId = id => BOXES.find(b => b.id === id);
const purse = { gp: 420, sp: 7, cp: 3 };
const ctx = { purse, hasActor: true, open: true, gmOnline: true };

describe("shortfall", () => {
  it("is the gp still needed, 0 when affordable", () => {
    expect(shortfall({ gp: 420 }, 1200)).toBe(780);
    expect(shortfall({ gp: 2000 }, 1200)).toBe(0);
    expect(shortfall({ gp: 1, sp: 5 }, 2)).toBe(0.5);
  });
});

describe("buyReason", () => {
  const odds = id => shopOdds(byId(id), POOLS);
  it("says how much more an unaffordable box needs", () => {
    expect(buyReason(byId("royal"), odds("royal"), { ...ctx, purse: { gp: 420 } })).toBe("Needs 780 gp more");
    expect(buyReason(byId("royal"), odds("royal"), ctx)).toBe("Needs 779 gp 2 sp 7 cp more");
  });
  it("names every other blocker", () => {
    expect(buyReason(byId("empty"), odds("empty"), ctx)).toBe("Nothing inside");
    expect(buyReason({ ...byId("common"), rules: { stock: 0 } }, odds("common"), ctx)).toBe("Sold out");
    expect(buyReason(byId("common"), odds("common"), { ...ctx, open: false })).toBe("The GM has closed the shop");
    expect(buyReason(byId("common"), odds("common"), { ...ctx, open: false, gmOnline: false })).toBe("Closed until a GM is online");
    expect(buyReason(byId("common"), odds("common"), { ...ctx, hasActor: false })).toBe("Pick a character");
    expect(buyReason(byId("common"), odds("common"), ctx)).toBe("");
  });
});

describe("boxCard", () => {
  const pills = html => [...html.matchAll(/<span class="lc-odd[^"]*">([^<]*)<\/span>/g)].map(m => m[1]);
  const button = html => html.match(/<button[^>]*>/)[0];
  it("shows named pills with no 0% and colours Pauper's Box by its best real drop", () => {
    const html = boxCard(byId("common"), POOLS, ctx);
    expect(html).toMatch(/class="lc-box lc-rarity-uncommon"/);
    expect(pills(html)).toEqual(["Common 85%", "Uncommon 15%"]);
    expect(html).not.toMatch(/(^|[^\d<>])0%/);
    expect(button(html)).not.toMatch(/disabled|aria-describedby|title=/);
  });
  it("links a disabled Buy to a visible reason", () => {
    const html = boxCard(byId("royal"), POOLS, ctx);
    expect(html).toMatch(/class="lc-box lc-rarity-legendary"/);
    expect(pills(html).some(p => p.startsWith("Common"))).toBe(false);
    const btn = button(html);
    expect(btn).toMatch(/ disabled/);
    expect(btn).not.toMatch(/title=/);
    const id = btn.match(/aria-describedby="([^"]+)"/)[1];
    expect(html).toContain(`<div class="lc-box__why" id="${id}">Needs 779 gp 2 sp 7 cp more</div>`);
  });
  it("marks an empty box and turns its Buy off", () => {
    const html = boxCard(byId("empty"), POOLS, ctx);
    expect(html).toMatch(/class="lc-box lc-box--empty"/);
    expect(pills(html)).toEqual([]);
    expect(button(html)).toMatch(/ disabled/);
    expect(html).toMatch(/class="lc-box__why" id="lc-why-empty">Nothing inside</);
  });
  it("escapes the box name", () => {
    const html = boxCard({ ...byId("common"), name: "<b>x</b>" }, POOLS, { ...ctx, esc: s => String(s).replace(/</g, "&lt;") });
    expect(html).not.toContain("<b>");
  });
  it("oddsPills writes the short name", () => {
    expect(oddsPills([{ rarity: "veryRare", label: "28%" }])).toBe('<span class="lc-odd lc-rarity-veryRare">V. rare 28%</span>');
  });
});

describe("the crate's peek and ribbon", () => {
  it("peeks at real droppable items, best first, and none a crate can't drop", async () => {
    const { peekItems } = await import("../module/scripts/boxcard.js");
    const pauper = peekItems(byId("common"), POOLS);
    expect(pauper.map(e => e.rarity)).toEqual(["uncommon", "common"]);
    const royal = peekItems(byId("royal"), POOLS);
    expect(royal.map(e => e.rarity)).toEqual(["legendary", "veryRare", "rare"]);
    expect(peekItems(byId("empty"), POOLS)).toEqual([]);
  });
  it("draws the ribbon from the shop's own odds, hidden from assistive tech", async () => {
    const { oddsRibbon } = await import("../module/scripts/boxcard.js");
    const html = oddsRibbon(shopOdds(byId("common"), POOLS).rows);
    expect(html).toMatch(/^<div class="lc-ribbon" aria-hidden="true">/);
    expect([...html.matchAll(/flex-grow:([\d.]+)/g)].map(m => +m[1])).toEqual([0.85, 0.15]);
    expect(oddsRibbon([])).toBe("");
  });
  it("only the pressed crate says Opening… while every Buy is off", () => {
    const busy = { ...ctx, busy: true, busyBox: "common" };
    expect(boxCard(byId("common"), POOLS, busy)).toContain("Opening…");
    const other = boxCard(byId("adventurer"), POOLS, busy);
    expect(other).not.toContain("Opening…");
    expect(other.match(/<button[^>]*>/)[0]).toMatch(/ disabled/);
  });
});
