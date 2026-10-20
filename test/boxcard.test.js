import { describe, it, expect } from "vitest";
import { boxCard, buyReason, crateReason, shopReason, shopNotice, shopHTML, SHOP_NOTICE_ID, oddsPills } from "../module/scripts/boxcard.js";
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
    expect(buyReason(byId("common"), odds("common"), { ...ctx, open: false })).toBe("The GM has closed the shop.");
    expect(buyReason(byId("common"), odds("common"), { ...ctx, open: false, gmOnline: false })).toBe("Closed until a GM is online.");
    expect(buyReason(byId("common"), odds("common"), { ...ctx, hasActor: false })).toBe("You have no character to buy for.");
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
  it("says it is waiting for the GM on the pressed crate only, and why once, in the shop's notice", () => {
    const slow = { ...ctx, busy: true, busyBox: "common", waiting: "gm" };
    const card = boxCard(byId("common"), POOLS, slow);
    expect(card).toContain("Waiting for the GM…");
    expect(card).not.toContain("Opening…");
    expect(card).not.toContain('role="status"');
    expect(card.match(/<button[^>]*>/)[0]).toContain(`aria-describedby="${SHOP_NOTICE_ID}"`);
    expect(shopNotice(slow)).toEqual({ text: "Waiting for the GM: their client hasn't rolled yet.", tone: "wait" });
    expect(shopNotice({ ...slow, waiting: "hidden" }).text).toContain("their Foundry tab is in the background");
    const other = boxCard(byId("adventurer"), POOLS, slow);
    expect(other).not.toContain("Waiting");
    // Before the notice, it still just says Opening…, and the notice is empty.
    expect(boxCard(byId("common"), POOLS, { ...slow, waiting: null })).toContain("Opening…");
    expect(shopNotice({ ...slow, waiting: null })).toEqual({ text: "", tone: "" });
  });
});

describe("a closed shop says so once", () => {
  const visibleText = html => html.replace(/<[^>]*>/g, " ");
  const shop = c => {
    const notice = shopNotice(c);
    const cards = BOXES.map(b => boxCard(b, POOLS, c)).join("");
    return { notice, cards, html: shopHTML({ fields: "", cards, notice }) + notice.text };
  };
  const buttons = html => [...html.matchAll(/<button[^>]*>/g)].map(m => m[0]);
  const describedBy = btn => btn.match(/aria-describedby="([^"]+)"/)?.[1].split(" ") ?? [];
  // Every id a disabled Buy names must be an element with text: the notice
  // (filled from shopNotice) or a card's own line.
  const texts = ({ notice, cards }) => new Map([
    [SHOP_NOTICE_ID, notice.text],
    ...[...cards.matchAll(/<div class="lc-box__why" id="([^"]+)">([^<]*)</g)].map(m => [m[1], m[2]]),
  ]);

  it("splits shop-wide reasons from a crate's own", () => {
    expect(shopReason({ ...ctx, open: false, gmOnline: false })).toBe("Closed until a GM is online.");
    expect(shopReason({ ...ctx, open: false })).toBe("The GM has closed the shop.");
    expect(shopReason({ ...ctx, hasActor: false })).toBe("You have no character to buy for.");
    expect(shopReason(ctx)).toBe("");
    const odds = id => shopOdds(byId(id), POOLS);
    expect(crateReason(byId("empty"), odds("empty"), ctx)).toBe("Nothing inside");
    expect(crateReason({ ...byId("common"), rules: { stock: 0 } }, odds("common"), ctx)).toBe("Sold out");
    expect(crateReason(byId("royal"), odds("royal"), { ...ctx, purse: { gp: 420 } })).toBe("Needs 780 gp more");
    // No character: no purse to fall short of.
    expect(crateReason(byId("royal"), odds("royal"), { ...ctx, hasActor: false })).toBe("");
  });

  for (const [label, c, reason] of [
    ["no GM online", { ...ctx, open: false, gmOnline: false }, "Closed until a GM is online."],
    ["closed by the GM", { ...ctx, open: false }, "The GM has closed the shop."],
    ["no character", { ...ctx, hasActor: false }, "You have no character to buy for."],
  ]) {
    it(`says "${reason}" once, in the header, when ${label}`, () => {
      const s = shop(c);
      expect(s.notice).toEqual({ text: reason, tone: "warn" });
      const core = reason.replace(/\.$/, "");
      expect(visibleText(s.html).split(core).length - 1).toBe(1);
      expect(s.cards).not.toContain(core);
      expect(s.cards).not.toMatch(/closed|GM is online|no character/i);
      for (const btn of buttons(s.cards)) {
        expect(btn).toMatch(/ disabled/);
        expect(describedBy(btn)).toContain(SHOP_NOTICE_ID);
      }
    });
  }

  it("still shows a crate's own reason under its card, and points the Buy at both", () => {
    const s = shop({ ...ctx, open: false, gmOnline: false });
    expect(s.cards).toMatch(/id="lc-why-empty">Nothing inside</);
    expect(s.cards).toMatch(/id="lc-why-royal">Needs 779 gp 2 sp 7 cp more</);
    const royal = buttons(s.cards).find(b => b.includes('data-box="royal"'));
    expect(describedBy(royal)).toEqual([SHOP_NOTICE_ID, "lc-why-royal"]);
    // Sold out too.
    const sold = boxCard({ ...byId("common"), rules: { stock: 0 } }, POOLS, { ...ctx, open: false, gmOnline: false });
    expect(sold).toMatch(/class="lc-box__why" id="lc-why-common">Sold out</);
  });

  it("gives every disabled Buy a description that resolves to visible text, open or closed", () => {
    for (const c of [ctx, { ...ctx, open: false, gmOnline: false }, { ...ctx, open: false }, { ...ctx, hasActor: false }, { ...ctx, busy: true, busyBox: "common", waiting: "hidden" }]) {
      const s = shop(c);
      const known = texts(s);
      for (const btn of buttons(s.cards).filter(b => / disabled/.test(b))) {
        const ids = describedBy(btn);
        if (c.busy && !c.waiting) continue;
        expect(ids.length).toBeGreaterThan(0);
        for (const id of ids) expect(known.get(id)?.trim()).toBeTruthy();
      }
    }
  });

  it("an open shop with nothing to say has an empty notice and no shop-wide line", () => {
    const s = shop(ctx);
    expect(s.notice).toEqual({ text: "", tone: "" });
    expect(s.html).toContain(`<p class="lc-shop__notice" id="${SHOP_NOTICE_ID}" role="status" data-tone=""></p>`);
    expect(buttons(s.cards).filter(b => b.includes(SHOP_NOTICE_ID))).toEqual([]);
  });
});
