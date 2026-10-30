/*
  Stock limits (limits.js): the global stock shows what it started at and
  Restock fills it; the limit per character, ever or per in-game day, is
  counted from that character's unrefunded log rows and checked by the
  core (pull.js) for every pulled kind; the shop card says how many more,
  or that the limit is reached, with its Buy off. Records from before
  stockMax and perCharacter behave as they always have.
*/
import { describe, it, expect, afterEach } from "vitest";
import { performPull, PullError } from "../module/scripts/foundry/pull.js";
import { boxCard, cardShell } from "../module/scripts/views/boxcard.js";
import { getKind } from "../module/scripts/games/kinds.js";
import {
  stockOf, stockText, restocked, restockLine, stockAfterRefund, stockFromForm, stockField, stockProblem, stockLine, perCharacterOf, perCharacterFromForm,
  boughtBy, limitState, limitLine, limitReason, limitRefusal, withLimit, perCharacterText, limitsText, limitsFieldset,
} from "../module/scripts/core/limits.js";
import { POOLS as SHOP_POOLS, BOXES } from "../harness/sample.js";

const tick = () => new Promise(r => setTimeout(r, 0));
const POOLS = { pool: { id: "pool", name: "Pool", pools: [], entries: ["a", "b", "c"].map(u => ({ uuid: u, name: u, img: "", rarity: "common", weight: 1 })) } };
const BOX = { id: "box", name: "Test Crate", price: 10, pools: [{ id: "pool", share: 1 }], weights: { common: 1 }, rules: {} };
const limited = (max, per = "ever", rules = {}) => ({ ...BOX, rules: { ...rules, perCharacter: { max, per } } });
const row = (actorId, extra = {}) => ({ id: `r${Math.random()}`, boxId: "box", actorId, price: 10, ...extra });

function makeActor(id = "actor1", name = "Crate Tester") {
  const actor = {
    id, name, items: [], writes: [],
    system: { currency: { pp: 0, gp: 500, ep: 0, sp: 0, cp: 0 } },
    async update(data) { await tick(); actor.writes.push(data["system.currency"]); actor.system.currency = data["system.currency"]; },
    async createEmbeddedDocuments(_type, docs) { await tick(); const made = docs.map(d => ({ id: `item${actor.items.length}`, ...d })); actor.items.push(...made); return made; },
  };
  return actor;
}
const source = () => { globalThis.fromUuid = async uuid => ({ name: `Item ${uuid}`, img: "", toObject: () => ({ name: `Item ${uuid}`, type: "loot", flags: {} }) }); };
afterEach(() => { delete globalThis.fromUuid; });

describe("the global stock", () => {
  it("says what is left of what the GM set, and the count alone on a record from before stockMax", () => {
    expect(stockText({ rules: { stock: 3, stockMax: 10 } })).toBe("3 of 10 left");
    expect(stockText({ rules: { stock: 3 } })).toBe("3 left");
    expect(stockText({ rules: { stock: null, stockMax: null } })).toBe("");
    expect(stockText({ rules: {} })).toBe("");
    expect(stockOf({ rules: { stock: 0, stockMax: 4 } })).toEqual({ left: 0, max: 4 });
  });

  it("Restock sets the stock to stockMax, and leaves a record without one as it is", () => {
    expect(restocked({ stock: 3, stockMax: 10, noDuplicates: true })).toEqual({ stock: 10, stockMax: 10, noDuplicates: true });
    expect(restocked({ stock: 0, stockMax: 10 }).stock).toBe(10);
    expect(restocked({ stock: 3 })).toEqual({ stock: 3 });
    // The editor's line after Restock, from the Stock field as it reads now.
    expect(restockLine("12", 10)).toBe("12 of 12 left once you save");
    expect(restockLine("10", 10)).toBe("10 of 10 left once you save");
    expect(restockLine(" ", 10)).toBe("Unlimited once you save");
    expect(restockLine("abc", 10)).toBe("10 of 10 left once you save");
    expect(restockLine("7.9", 10)).toBe("7 of 7 left once you save");
  });

  it("a refund puts one back, never past the GM's number", () => {
    expect(stockAfterRefund({ rules: { stock: 3, stockMax: 10 } })).toBe(4);
    // Restocked between the pull and its refund: already full.
    expect(stockAfterRefund({ rules: { stock: 10, stockMax: 10 } })).toBe(10);
    expect(stockAfterRefund({ rules: { stock: 3 } })).toBe(4);
    expect(stockAfterRefund({ rules: {} })).toBeNull();
    expect(stockAfterRefund(undefined)).toBeNull();
  });

  it("the editor's Save keeps what pulls and Restock did unless the GM changed the number", () => {
    // Opened at 10, a pull took one meanwhile, the number untouched: 2 of 10 stays.
    expect(stockFromForm({ stock: 2, stockMax: 10 }, { shown: 10, value: "10" })).toEqual({ stock: 2, stockMax: 10 });
    // Raised to 12: two more on the shelf.
    expect(stockFromForm({ stock: 2, stockMax: 10 }, { shown: 10, value: "12" })).toEqual({ stock: 4, stockMax: 12 });
    // Lowered under what is left: never past the new number.
    expect(stockFromForm({ stock: 9, stockMax: 10 }, { shown: 10, value: "5" })).toEqual({ stock: 4, stockMax: 5 });
    expect(stockFromForm({ stock: 1, stockMax: 10 }, { shown: 10, value: "2" })).toEqual({ stock: 0, stockMax: 2 });
    // From unlimited: starts full. To unlimited: both go.
    expect(stockFromForm({}, { shown: null, value: "3" })).toEqual({ stock: 3, stockMax: 3 });
    expect(stockFromForm({ stock: 2, stockMax: 10 }, { shown: 10, value: "" })).toEqual({ stock: null, stockMax: null });
    // A record from before stockMax: its field opens at the count; typing a
    // number gives it one, from what is left.
    expect(stockField({ rules: { stock: 3 } })).toBe(3);
    expect(stockField({ rules: { stock: 3, stockMax: 10 } })).toBe(10);
    expect(stockFromForm({ stock: 3 }, { shown: 3, value: "3" })).toEqual({ stock: 3, stockMax: null });
    expect(stockFromForm({ stock: 3 }, { shown: 3, value: "10" })).toEqual({ stock: 10, stockMax: 10 });
  });

  it("a stock below 0 is refused, never saved as sold out; the line under the field says what Save will leave", () => {
    expect(stockProblem("-3")).toBe("Stock can't be below 0. Leave it blank for unlimited.");
    expect(stockProblem("-0.5")).toBe("Stock can't be below 0. Leave it blank for unlimited.");
    for (const ok of ["", " ", "0", "10", null, undefined]) expect(stockProblem(ok)).toBe("");
    // Before round 30, -3 saved as stock 0 of 0. Should one reach Save, nothing changes.
    expect(stockFromForm({ stock: 2, stockMax: 10 }, { shown: 10, value: "-3" })).toEqual({ stock: 2, stockMax: 10 });
    expect(stockFromForm({}, { shown: null, value: "-3" })).toEqual({ stock: null, stockMax: null });
    // The line follows the field, by Save's own rule.
    const game = { rules: { stock: 3, stockMax: 10 } };
    expect(stockLine(game, "10")).toBe("3 of 10 left");
    expect(stockLine(game, "12")).toBe("5 of 12 left once you save");
    expect(stockLine(game, "")).toBe("Unlimited once you save");
    expect(stockLine(game, "-3")).toBe("3 of 10 left");
    expect(stockLine({ rules: {} }, "")).toBe("Unlimited");
    expect(stockLine({ rules: {} }, "10")).toBe("10 of 10 left once you save");
    expect(stockLine({ rules: {} }, "0")).toBe("0 of 0 left once you save");
    // The editor's field says it under itself.
    const html = limitsFieldset({ id: "g", rules: {} });
    expect(html).toContain('aria-describedby="lc-limits-g-stock-why lc-limits-g-stock"');
    expect(html).toContain('id="lc-limits-g-stock-why" data-stock-why aria-live="polite"');
  });

  it("an old record without stockMax or perCharacter sells as before, and sells out at 0", async () => {
    source();
    const actor = makeActor();
    const out = await performPull({ box: { ...BOX, rules: { stock: 1 } }, pools: POOLS, actor, rng: () => 0.5, log: [row("actor1"), row("actor1")] });
    expect(out.result).not.toBeNull();
    await expect(performPull({ box: { ...BOX, rules: { stock: 0 } }, pools: POOLS, actor, rng: () => 0.5 })).rejects.toThrow("Test Crate is sold out.");
    expect(limitState(BOX, { log: [row("actor1")], actorId: "actor1" })).toBeNull();
  });
});

describe("the limit per character", () => {
  it("reads the record, and a blank or 0 limit is none", () => {
    expect(perCharacterOf(limited(2))).toEqual({ max: 2, per: "ever" });
    expect(perCharacterOf(limited(1, "day"))).toEqual({ max: 1, per: "day" });
    expect(perCharacterOf(limited(0))).toBeNull();
    expect(perCharacterOf(BOX)).toBeNull();
    expect(perCharacterFromForm({ limitMax: "2", limitPer: "day" })).toEqual({ max: 2, per: "day" });
    expect(perCharacterFromForm({ limitMax: "", limitPer: "day" })).toBeNull();
    expect(perCharacterFromForm({ limitMax: "0" })).toBeNull();
  });

  it("counts only this character's unrefunded rows at this game", () => {
    const log = [row("actor1"), row("actor1", { refunded: 123 }), row("actor2"), row("actor1", { boxId: "other" }), row("actor1", { roundId: "R1" })];
    expect(boughtBy(log, { boxId: "box", actorId: "actor1" })).toBe(1);
    expect(boughtBy(log, { boxId: "box", actorId: "actor2" })).toBe(1);
  });

  it("blocks purchase N+1 for that character and not for another, with the refusal sentence", async () => {
    source();
    const box = limited(2);
    const log = [row("actor1"), row("actor1")];
    const tester = makeActor("actor1", "Crate Tester");
    const promise = performPull({ box, pools: POOLS, actor: tester, rng: () => 0.5, log });
    await expect(promise).rejects.toBeInstanceOf(PullError);
    await expect(promise).rejects.toThrow("Test Crate: limit reached, 2 of 2 for Crate Tester. Nothing was charged.");
    expect(tester.writes).toHaveLength(0);
    const other = makeActor("actor2", "Orla");
    const out = await performPull({ box, pools: POOLS, actor: other, rng: () => 0.5, log });
    expect(out.result).not.toBeNull();
    expect(other.writes).toHaveLength(1);
  });

  it("refunded rows don't count: a refund gives the purchase back by itself", async () => {
    source();
    const actor = makeActor();
    const out = await performPull({ box: limited(1), pools: POOLS, actor, rng: () => 0.5, log: [row("actor1", { refunded: Date.now() })] });
    expect(out.result).not.toBeNull();
  });

  it("per day: counts today's rows only, and resets on a new in-game day", async () => {
    source();
    const box = limited(1, "day");
    const log = [row("actor1", { day: "y1d5" }), row("actor1", { day: "y1d4" }), row("actor1")];
    expect(limitState(box, { log, actorId: "actor1", today: "y1d5" })).toMatchObject({ bought: 1, left: 0, reached: true });
    await expect(performPull({ box, pools: POOLS, actor: makeActor(), rng: () => 0.5, log, today: "y1d5" }))
      .rejects.toThrow("Test Crate: limit reached, 1 of 1 for Crate Tester until tomorrow. Nothing was charged.");
    expect(limitState(box, { log, actorId: "actor1", today: "y1d6" })).toMatchObject({ bought: 0, left: 1, reached: false });
    const out = await performPull({ box, pools: POOLS, actor: makeActor(), rng: () => 0.5, log, today: "y1d6" });
    expect(out.result).not.toBeNull();
    // A world with no clock: a limit per day can't apply (like the well's cap).
    expect(limitState(box, { log, actorId: "actor1", today: null })).toBeNull();
  });

  it("applies to every pulled kind, not only crates, and never to a table game", async () => {
    const well = getKind("well");
    expect(well).toBeTruthy();
    const game = { id: "box", kind: "well", name: "Wishing Well", price: 0.1, pools: [], weights: {}, odds: { nothing: 1, coin: 0, item: 0 }, rules: { perCharacter: { max: 1, per: "ever" } } };
    await expect(performPull({ box: game, pools: {}, actor: makeActor(), rng: () => 0.5, log: [row("actor1")] })).rejects.toThrow("Wishing Well: limit reached, 1 of 1 for Crate Tester.");
    expect(perCharacterOf({ ...game, kind: "roulette" })).toBeNull();
  });

  it("words: the card's line, its reason, the GM's refusal and the Boxes table", () => {
    const ever = { max: 2, per: "ever", bought: 1, left: 1, reached: false };
    const day = { max: 2, per: "day", bought: 2, left: 0, reached: true };
    expect(limitLine(ever)).toBe("You can buy 1 more");
    expect(limitLine({ ...ever, per: "day" })).toBe("You can buy 1 more today");
    expect(limitLine(day)).toBe("");
    expect(limitReason({ ...day, per: "ever" }, "Crate Tester")).toBe("Limit reached: 2 of 2 for Crate Tester");
    expect(limitReason(day, "Crate Tester")).toBe("Limit reached: 2 of 2 for Crate Tester until tomorrow");
    expect(limitRefusal(BOX, day, "Crate Tester")).toBe("Test Crate: limit reached, 2 of 2 for Crate Tester until tomorrow. Nothing was charged.");
    expect(perCharacterText(limited(1))).toBe("1 per character");
    expect(perCharacterText(limited(2, "day"))).toBe("2 per character a day");
    expect(limitsText(limited(1, "ever", { stock: 3, stockMax: 10 }))).toBe("3 of 10 left, 1 per character");
    expect(limitsText(BOX)).toBe("");
  });

  it("the reason over the game's own, except while the last play is still spinning", () => {
    const ctx = { log: [row("actor1")], actorId: "actor1", actorName: "Crate Tester" };
    expect(withLimit(limited(1), "Needs 3 gp more", ctx)).toBe("Limit reached: 1 of 1 for Crate Tester");
    expect(withLimit(limited(1), "", { ...ctx, held: id => id === "box" })).toBe("");
    expect(withLimit(limited(2), "Needs 3 gp more", ctx)).toBe("Needs 3 gp more");
  });
});

describe("the shop card", () => {
  const esc = s => String(s ?? "");
  const ctx = (log = [], extra = {}) => ({ purse: { gp: 5000 }, hasActor: true, open: true, gmOnline: true, actorId: "tam", actorName: "Tam Thornwick", today: "y1d1", log, esc, ...extra });
  const pauper = BOXES.find(b => b.id === "common");
  const royal = BOXES.find(b => b.id === "royal");
  const tam = n => Array.from({ length: n }, () => ({ boxId: pauper.id, actorId: "tam", day: "y1d1" }));

  it("reads '3 of 10 left' under the odds", () => {
    const html = boxCard({ ...royal, rules: { stock: 3, stockMax: 10 } }, SHOP_POOLS, ctx());
    expect(html).toContain(`<div class="lc-box__stock">3 of 10 left</div>`);
    expect(boxCard({ ...royal, rules: { stock: 3 } }, SHOP_POOLS, ctx())).toContain(`<div class="lc-box__stock">3 left</div>`);
  });

  it("says 'You can buy 1 more' with the Buy on", () => {
    const html = boxCard({ ...pauper, rules: { perCharacter: { max: 2, per: "ever" } } }, SHOP_POOLS, ctx(tam(1)));
    expect(html).toContain(`<div class="lc-box__limit">You can buy 1 more</div>`);
    expect(html).not.toContain("aria-disabled");
  });

  it("at the limit: 'Limit reached' as the reason, the Buy aria-disabled and described by it", () => {
    const html = boxCard({ ...pauper, rules: { perCharacter: { max: 2, per: "ever" } } }, SHOP_POOLS, ctx(tam(2)));
    expect(html).toContain(`<div class="lc-box__why" id="lc-why-common">Limit reached: 2 of 2 for Tam Thornwick</div>`);
    expect(html).toMatch(/data-action="buy"[^>]*aria-disabled="true"[^>]*aria-describedby="lc-why-common"/);
    expect(html).not.toContain("lc-box__limit");
    const daily = boxCard({ ...pauper, rules: { perCharacter: { max: 2, per: "day" } } }, SHOP_POOLS, ctx(tam(2)));
    expect(daily).toContain("Limit reached: 2 of 2 for Tam Thornwick until tomorrow");
    // Another character has bought nothing.
    expect(boxCard({ ...pauper, rules: { perCharacter: { max: 2, per: "ever" } } }, SHOP_POOLS, ctx(tam(2), { actorId: "orla", actorName: "Orla" }))).toContain("You can buy 2 more");
  });

  it("every kind's card gets the line through the shared shell", () => {
    const html = cardShell({ id: "w", name: "Well", price: 0.1, rules: { perCharacter: { max: 3, per: "day" } } }, ctx([{ boxId: "w", actorId: "tam", day: "y1d1" }]), { rarityClass: "", label: "Throw" });
    expect(html).toContain("You can buy 2 more today");
  });

  it("a card for a record without limits reads the log not at all", () => {
    let reads = 0;
    const c = ctx();
    Object.defineProperty(c, "log", { get: () => { reads++; return []; } });
    boxCard({ ...pauper, rules: {} }, SHOP_POOLS, c);
    expect(reads).toBe(0);
  });
});

describe("the editor's Limits group", () => {
  it("groups the stock, what is left with Restock, and the limit per character, with help", () => {
    const html = limitsFieldset({ id: "b", rules: { stock: 3, stockMax: 10, perCharacter: { max: 1, per: "day" } } });
    expect(html).toContain("<legend>Limits</legend>");
    expect(html).toContain(`name="stock" type="number" min="0" step="1" value="10"`);
    expect(html).toContain(`<span class="lc-limits__left" role="status">3 of 10 left</span>`);
    expect(html).toMatch(/<button type="button" class="lc-limits__restock" data-restock>/);
    expect(html).toContain(`name="limitMax" type="number" min="0" step="1" value="1"`);
    expect(html).toContain(`<option value="day" selected>a day</option>`);
    expect(html).not.toContain("No calendar");
  });

  it("Restock is off when the shelf is full, and absent without the GM's number", () => {
    expect(limitsFieldset({ id: "b", rules: { stock: 10, stockMax: 10 } })).toContain(`data-restock aria-disabled="true"`);
    // A draft (a New, a copy) has no record to fill: the count, no Restock.
    const draft = limitsFieldset({ id: "b", rules: { stock: 10, stockMax: 10 } }, { draft: true });
    expect(draft).not.toContain("data-restock");
    expect(draft).toContain(">10 of 10 left</span>");
    expect(draft).toContain('name="stock" type="number" min="0" step="1" value="10"');
    const old = limitsFieldset({ id: "b", rules: { stock: 3 } });
    expect(old).not.toContain("data-restock");
    expect(old).toContain(">3 left</span>");
    expect(limitsFieldset({ id: "b", rules: {} })).toContain(">Unlimited</span>");
  });

  it("only the limit per character for a game without stock, and a warning for a limit per day with no calendar", () => {
    const html = limitsFieldset({ id: "d", rules: { perCharacter: { max: 2, per: "day" } } }, { stock: false, hasClock: false });
    expect(html).not.toContain(`name="stock"`);
    expect(html).toContain(`lc-form__hint lc-form__hint--warn">No calendar: a limit per day will not apply.`);
  });
});
