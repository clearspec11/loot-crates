/*
  After the reveal (VIB-219): the rules and words (core/afterplay.js), the
  reveal's section (views/afterreveal.js) on the minimal DOM, what the row
  moves in the tallies and the no-duplicates record, the Pull log's note,
  the chat card's line, and the editors' Sell back field.
*/
import { describe, it, expect, beforeAll, vi } from "vitest";
import { createDocument } from "./minidom.js";

const { SELL_BACK_DEFAULT, PART_WINDOW_MS, sellBackOf, sellBackFromForm, worthOf, worthColumns, sellCp, heldWorth, rowItems, giveTargets, isGiveTarget, partRefusal, partsLine, partSentence, partWhere, anyParted, firstParted } = await import("../module/scripts/core/afterplay.js");
const { afterHTML, wireAfter, setBusy, refused, showPart, spectatorLine, whereAfter } = await import("../module/scripts/views/afterreveal.js");
const { resultHTML } = await import("../module/scripts/views/revealcard.js");
const { applyRow, emptyTally, wonCount, countsChange } = await import("../module/scripts/core/tally.js");
const { ownedAfterPart } = await import("../module/scripts/core/odds.js");
const { logPartedNote, logTableHTML } = await import("../module/scripts/views/logtable.js");
const { partedCardContent } = await import("../module/scripts/views/chatcard.js");
const { editorHTML } = await import("../module/scripts/views/editors.js");
const { newDraft } = await import("../module/scripts/views/newgame.js");

beforeAll(() => {
  vi.stubGlobal("document", createDocument());
  vi.stubGlobal("CSS", { escape: s => String(s) });
});

const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const root = html => { const el = document.createElement("div"); el.innerHTML = html; return el; };
const byId = (el, id) => el.querySelectorAll("[id]").find(n => n.id === id) ?? null;
const event = (type, target, more = {}) => ({ type, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...more });

describe("what the house pays", () => {
  it("is the game's percentage, 50 by default, 0 to 100", () => {
    expect(SELL_BACK_DEFAULT).toBe(50);
    expect(sellBackOf({ rules: {} })).toBe(50);
    expect(sellBackOf({})).toBe(50);
    expect(sellBackOf({ rules: { sellBack: 0 } })).toBe(0);
    expect(sellBackOf({ rules: { sellBack: 75 } })).toBe(75);
    expect(sellBackOf({ rules: { sellBack: 140 } })).toBe(100);
    expect(sellBackOf({ rules: { sellBack: -5 } })).toBe(0);
    expect(sellBackFromForm("")).toBe(50);
    expect(sellBackFromForm("0")).toBe(0);
    expect(sellBackFromForm("33.7")).toBe(33);
    expect(sellBackFromForm("abc")).toBe(50);
  });

  it("is the item's price times its quantity times the percentage, floored in the item's own coin", () => {
    const w = (value, denomination, quantity = 1) => ({ value, denomination, quantity });
    expect(sellCp(w(150, "gp"), 50)).toBe(7500);
    expect(sellCp(w(5, "sp"), 50)).toBe(20);
    expect(sellCp(w(1, "gp"), 50)).toBe(0);
    expect(sellCp(w(7, "cp"), 50)).toBe(3);
    expect(sellCp(w(3, "pp"), 50)).toBe(1000);
    expect(sellCp(w(10, "ep"), 25)).toBe(100);
    expect(sellCp(w(25, "gp", 2), 50)).toBe(2500);
    expect(sellCp(w(150, "gp"), 100)).toBe(15000);
  });

  it("counts no more of a stack than the sheet still has, and never more than was won", () => {
    const won = { value: 50, denomination: "gp", quantity: 5 };
    expect(heldWorth(won, { system: { quantity: 1 } })).toEqual({ ...won, quantity: 1 });
    expect(heldWorth(won, { system: { quantity: 9 } })).toEqual(won);
    expect(heldWorth(won, { system: { quantity: 0 } })).toBeNull();
    expect(heldWorth(won, { system: {} })).toEqual(won);
    expect(heldWorth(null, { system: { quantity: 1 } })).toBeNull();
    expect(sellCp(heldWorth(won, { system: { quantity: 2 } }), 50)).toBe(5000);
  });

  it("is nothing at 0%, or for an item with no price", () => {
    expect(sellCp({ value: 150, denomination: "gp", quantity: 1 }, 0)).toBe(0);
    expect(sellCp(null, 50)).toBe(0);
    expect(sellCp({ value: 0, denomination: "gp" }, 50)).toBe(0);
  });

  it("reads dnd5e's price as granted, and an older bare number as gold", () => {
    expect(worthOf({ system: { price: { value: 150, denomination: "gp" }, quantity: 1 } })).toEqual({ value: 150, denomination: "gp", quantity: 1 });
    expect(worthOf({ system: { price: { value: 5, denomination: "sp" }, quantity: 3 } })).toEqual({ value: 5, denomination: "sp", quantity: 3 });
    expect(worthOf({ system: { price: 12 } })).toEqual({ value: 12, denomination: "gp", quantity: 1 });
    expect(worthOf({ system: { price: { value: 0, denomination: "gp" } } })).toBeNull();
    expect(worthOf({ system: { price: { value: 4, denomination: "zz" } } })).toBeNull();
    expect(worthOf({ system: {} })).toBeNull();
    expect(worthColumns([{ id: "a", system: { price: { value: 2, denomination: "gp" } } }, { id: "b", system: {} }])).toEqual({ worth: { a: { value: 2, denomination: "gp", quantity: 1 } } });
    expect(worthColumns([{ id: "b", system: {} }])).toEqual({});
  });
});

// Users and characters as Foundry has them: a GM owns every one.
const GM = { id: "gm", name: "Gamemaster", isGM: true };
const ANA = { id: "p1", name: "Ana", isGM: false };
const CY = { id: "p3", name: "Cy", isGM: false };
const DEE = { id: "p4", name: "Dee", isGM: false };
const USERS = [GM, ANA, CY, DEE];
const actor = (id, name, owners, type = "character") => ({ id, name, type, testUserPermission: (u, level) => level === "OWNER" && (!!u?.isGM || owners.includes(u?.id)) });
const ACTORS = [actor("a1", "Brinn", ["p1"]), actor("a2", "Saria", ["p3"]), actor("a3", "Pony", ["p1"]), actor("a4", "Sir Nobody", []), actor("a5", "Wolf", ["p3"], "npc"), actor("a6", "Odo", ["p3", "p4"]), actor("a7", "Shared", ["p1", "p3"])];

describe("who an item can be given to", () => {
  it("every character another non-GM player owns, by name, with its players; never the winner's or another of theirs", () => {
    expect(giveTargets({ actors: ACTORS, users: USERS, userId: "p1", fromActorId: "a1" })).toEqual([
      { id: "a6", name: "Odo", players: "Cy and Dee" },
      { id: "a2", name: "Saria", players: "Cy" },
    ]);
  });

  it("for a GM, every character a player owns", () => {
    expect(giveTargets({ actors: ACTORS, users: USERS, userId: "gm", fromActorId: "a1" }).map(c => c.name)).toEqual(["Odo", "Pony", "Saria", "Shared"]);
  });

  it("the GM's check is the same rule", () => {
    expect(isGiveTarget(ACTORS[1], USERS, ANA)).toBe(true);
    expect(isGiveTarget(ACTORS[2], USERS, ANA)).toBe(false);
    expect(isGiveTarget(ACTORS[3], USERS, ANA)).toBe(false);
    expect(isGiveTarget(ACTORS[4], USERS, ANA)).toBe(false);
    expect(isGiveTarget(ACTORS[6], USERS, ANA)).toBe(false);
  });
});

describe("why the GM refuses", () => {
  const NOW = 1_000_000_000;
  const row = { id: "r", userId: "p1", actorId: "a1", boxId: "box", itemId: "i1", name: "Wand of Webs", at: NOW - 60_000 };
  const brinn = actor("a1", "Brinn", ["p1"]);
  const item = { id: "i1", flags: { "loot-crates": { boxId: "box" } } };
  const why = over => partRefusal({ row, sender: ANA, itemId: "i1", actor: brinn, item, now: NOW, ...over });
  it("names each case in a plain sentence, and lets the winner's own request through", () => {
    expect(why({})).toBeNull();
    expect(why({ row: null })).toBe("That play is no longer in the Pull log, so nothing was given or sold.");
    expect(why({ sender: CY })).toBe("Only the player who won an item can give it away or sell it back. Nothing moved.");
    expect(why({ row: { ...row, refunded: 5 } })).toBe("That play was refunded, so Wand of Webs is no longer yours to pass on. Nothing moved.");
    expect(why({ itemId: "other" })).toBe("That item didn't come from this play. Nothing moved.");
    expect(why({ row: { ...row, parted: { i1: { soldCp: 100 } } } })).toBe("Wand of Webs was already sold back.");
    expect(why({ row: { ...row, parted: { i1: { given: { actorId: "a2", actorName: "Saria" } } } } })).toBe("Wand of Webs was already given to Saria.");
    expect(why({ item: null })).toBe("Wand of Webs is no longer on Brinn's sheet. Nothing moved.");
    expect(why({ item: { id: "i1", flags: { "loot-crates": { boxId: "elsewhere" } } } })).toBe("Wand of Webs is no longer on Brinn's sheet. Nothing moved.");
  });

  it("takes a give or a sell for an hour after the play, and none after", () => {
    const late = "Wand of Webs can be given away or sold back only within an hour of the play, so it stays with Brinn.";
    expect(PART_WINDOW_MS).toBe(3_600_000);
    expect(why({ row: { ...row, at: NOW - PART_WINDOW_MS } })).toBeNull();
    expect(why({ row: { ...row, at: NOW - PART_WINDOW_MS - 1 } })).toBe(late);
    expect(why({ row: { ...row, at: undefined } })).toBe(late);
    // Someone else's old row still reads as not theirs, and an item already sold says so first.
    expect(why({ sender: CY, row: { ...row, at: 0 } })).toBe("Only the player who won an item can give it away or sell it back. Nothing moved.");
    expect(why({ row: { ...row, at: 0, parted: { i1: { soldCp: 100 } } } })).toBe("Wand of Webs was already sold back.");
  });
});

describe("the row's outcome", () => {
  const row = { id: "r", actorName: "Brinn", boxId: "box", actorId: "a1", uuid: "wand", itemId: "i1", itemIds: ["i1"], name: "Wand of Webs", at: 1 };
  it("reads as the log and the chat card say it, one item or several", () => {
    expect(partsLine({ ...row, parted: { i1: { given: { actorId: "a2", actorName: "Saria" } } } })).toBe("gave it to Saria");
    expect(partsLine({ ...row, parted: { i1: { soldCp: 7500 } } })).toBe("sold it back for 75 gp");
    const two = { ...row, itemIds: ["i1", "i2"], itemNames: ["Wand of Webs", "Potion"], parted: { i2: { soldCp: 2500 }, i1: { given: { actorName: "Saria" } } } };
    expect(partsLine(two)).toBe("gave Wand of Webs to Saria; sold Potion back for 25 gp");
    expect(partSentence({ soldCp: 7500 }, { actor: "Brinn", item: "Wand of Webs" })).toBe("Brinn sold Wand of Webs back for 75 gp.");
    expect(partSentence({ given: { actorName: "Saria" } }, { actor: "Brinn", item: "Wand of Webs" })).toBe("Brinn gave Wand of Webs to Saria.");
    expect(anyParted(row)).toBe(false);
    expect(anyParted(two)).toBe(true);
    expect(rowItems(two)).toEqual([{ id: "i1", name: "Wand of Webs" }, { id: "i2", name: "Potion" }]);
    expect(rowItems(row)).toEqual([{ id: "i1", name: "Wand of Webs" }]);
  });

  it("takes the item out of `won` and the no-duplicates record, unless another play still holds it", () => {
    const t = emptyTally();
    const other = { ...row, id: "r2", itemId: "j1", itemIds: ["j1"], at: 2 };
    applyRow(t, row, 1);
    applyRow(t, other, 1);
    expect(wonCount(t, { boxId: "box", actorId: "a1", uuid: "wand" })).toBe(2);
    const sold = { ...row, parted: { i1: { soldCp: 7500 } } };
    expect(firstParted(sold)).toBe(true);
    expect(countsChange(row, sold)).toBe(true);
    applyRow(t, row, -1);
    applyRow(t, sold, 1);
    expect(wonCount(t, { boxId: "box", actorId: "a1", uuid: "wand" })).toBe(1);
    const state = { sinceRare: 1, owned: ["wand", "rope"], pulls: 2 };
    expect(ownedAfterPart(state, sold, t)).toEqual(state);
    applyRow(t, other, -1);
    expect(ownedAfterPart(state, sold, t)).toEqual({ sinceRare: 1, owned: ["rope"], pulls: 2 });
    // A second item given leaves the first's record alone.
    expect(ownedAfterPart(state, { ...row, itemIds: ["i1", "i2"], parted: { i2: { soldCp: 1 } } }, emptyTally())).toEqual(state);
  });

  it("is noted under the row in the Pull log", () => {
    const sold = { ...row, boxName: "Test Crate", price: 10, parted: { i1: { soldCp: 7500 } } };
    expect(logPartedNote(row)).toBe("");
    expect(logPartedNote(sold, esc)).toBe('<small class="lc-log__parted">Brinn sold it back for 75 gp.</small>');
    expect(logTableHTML({ log: [{ ...sold, parted: { i1: { given: { actorName: "Saria" } } } }], esc })).toContain("Brinn gave it to Saria.");
  });

  it("is a line on the chat card, with the parted item's link to the winner's sheet unlinked", () => {
    const card = '<div class="loot-crates lc-chat"><div class="lc-chat__head">Brinn opens Test Crate</div><div class="lc-chat__item"><div class="lc-chat__name"><a class="content-link" data-uuid="Actor.a1.Item.i1" data-type="Item">Wand of Webs</a></div></div></div>';
    const sold = { ...row, parted: { i1: { soldCp: 7500 } } };
    const out = partedCardContent(card, sold, { esc, line: "Brinn sold it back for 75 gp." });
    expect(out).toContain('<div class="lc-chat__name">Wand of Webs</div>');
    expect(out).toContain('<div class="lc-chat__after">Brinn sold it back for 75 gp.</div></div>');
    // A second word replaces the line, never adds one.
    const again = partedCardContent(out, sold, { esc, line: "Brinn gave Wand of Webs to Saria; sold Potion back for 25 gp." });
    expect(again.match(/lc-chat__after/g)).toHaveLength(1);
    expect(partedCardContent('<div class="loot-crates lc-chat lc-chat--refunded"></div>', sold, { line: "x" })).toBe('<div class="loot-crates lc-chat lc-chat--refunded"></div>');
  });
});

describe("the reveal's section", () => {
  const offer = { actorName: "Brinn", targets: [{ id: "a2", name: "Saria", players: "Cy" }], items: [{ id: "i1", name: "Wand of Webs", sellCp: 7500 }] };
  it("gives the winner Give to… and Sell back for the price, and says closing leaves it, never Keep", () => {
    const el = root(afterHTML(offer, { esc, key: "r1" }));
    expect(el.querySelector(".lc-after__lead").textContent).toBe("While this window is open you can give it to a party member or sell it back. Closing it leaves it with Brinn.");
    expect(el.textContent).not.toMatch(/\bKeep\b/);
    const [give, sell] = el.querySelectorAll(".lc-after__acts button");
    expect(give.textContent).toBe("Give to…");
    expect(give.getAttribute("aria-label")).toBe("Give Wand of Webs to a party member");
    expect(sell.textContent).toBe("Sell back for 75 gp");
    expect(sell.getAttribute("aria-label")).toBe("Sell Wand of Webs back for 75 gp");
    expect(el.querySelector(".lc-after__name")).toBeNull();
    const options = el.querySelectorAll(".lc-after__target option");
    expect(options.map(o => [o.getAttribute("value"), o.textContent])).toEqual([["a2", "Saria (Cy)"]]);
    expect(el.querySelector(".lc-after__pick-label").getAttribute("for")).toBe(el.querySelector(".lc-after__target").id);
  });

  it("hides Sell back at 0% or with no price, and turns Give off with its reason when nobody can take it", () => {
    const el = root(afterHTML({ ...offer, targets: [], items: [{ id: "i1", name: "Wand of Webs", sellCp: 0 }] }, { esc, key: "r1" }));
    expect(el.querySelector(".lc-after__sell")).toBeNull();
    const give = el.querySelector(".lc-after__give");
    expect(give.getAttribute("aria-disabled")).toBe("true");
    expect(byId(el, give.getAttribute("aria-describedby")).textContent).toBe("No other player has a character to give it to.");
  });

  it("offers a pair for every item of a play that granted several, each named", () => {
    const el = root(afterHTML({ ...offer, items: [{ id: "i1", name: "Wand of Webs", sellCp: 7500 }, { id: "i2", name: "Potion", sellCp: 2500 }] }, { esc, key: "r1" }));
    expect(el.querySelector(".lc-after__lead").textContent).toBe("While this window is open you can give each item to a party member or sell it back. Closing it leaves them with Brinn.");
    const rows = el.querySelectorAll(".lc-after__item");
    expect(rows.map(r => r.querySelector(".lc-after__name").textContent)).toEqual(["Wand of Webs", "Potion"]);
    expect(rows.map(r => r.querySelectorAll(".lc-after__acts button").map(b => b.textContent))).toEqual([["Give to…", "Sell back for 75 gp"], ["Give to…", "Sell back for 25 gp"]]);
    expect(new Set(el.querySelectorAll("select").map(s => s.id)).size).toBe(2);
  });

  it("opens the picker in place and focuses it; Give names the pick; Escape or Cancel puts focus back on Give to…", () => {
    const el = root(afterHTML(offer, { esc, key: "r1" }));
    document.body.append(el);
    const calls = [];
    wireAfter(el, { onGive: (...a) => calls.push(["give", a[0], a[1]]), onSell: (...a) => calls.push(["sell", a[0], a[1]]), onPick: open => calls.push(["pick", open]) });
    const press = target => el.dispatchEvent(event("click", target));
    const give = el.querySelector(".lc-after__give");
    press(give);
    const pick = el.querySelector(".lc-after__pick");
    expect(pick.hidden).toBe(false);
    expect(el.querySelector(".lc-after__acts").hidden).toBe(true);
    expect(document.activeElement).toBe(el.querySelector(".lc-after__target"));
    el.dispatchEvent(event("keydown", el.querySelector(".lc-after__target"), { key: "Escape" }));
    expect(pick.hidden).toBe(true);
    expect(document.activeElement).toBe(give);
    press(give);
    press(el.querySelector(".lc-after__confirm"));
    press(el.querySelector(".lc-after__cancel"));
    expect(calls).toEqual([["pick", true], ["pick", false], ["pick", true], ["give", "i1", "a2"], ["pick", false]]);
    el.remove();
  });

  it("Sell back asks once more in place before anything is sold; Escape or Cancel puts focus back on Sell back", () => {
    const el = root(afterHTML(offer, { esc, key: "r1" }));
    document.body.append(el);
    const calls = [];
    wireAfter(el, { onGive: () => calls.push(["give"]), onSell: (...a) => calls.push(["sell", a[0], a[1]]), onPick: open => calls.push(["pick", open]) });
    const press = target => el.dispatchEvent(event("click", target));
    const sell = el.querySelector(".lc-after__sell");
    const sure = el.querySelector(".lc-after__sure");
    const go = el.querySelector(".lc-after__sellgo");
    expect(sure.hidden).toBe(true);
    press(sell);
    // The first press sells nothing: it asks, with the item and the price.
    expect(calls).toEqual([["pick", true]]);
    expect(sure.hidden).toBe(false);
    expect(el.querySelector(".lc-after__acts").hidden).toBe(true);
    expect(sure.querySelector(".lc-after__sure-label").textContent).toBe("Sell Wand of Webs back for 75 gp? This can't be undone.");
    expect(go.textContent).toBe("Sell");
    expect(go.getAttribute("aria-describedby")).toBe(sure.querySelector(".lc-after__sure-label").id);
    expect(document.activeElement).toBe(go);
    el.dispatchEvent(event("keydown", go, { key: "Escape" }));
    expect(sure.hidden).toBe(true);
    expect(document.activeElement).toBe(sell);
    press(sell);
    press(sure.querySelector(".lc-after__cancel"));
    expect(sure.hidden).toBe(true);
    expect(calls).toEqual([["pick", true], ["pick", false], ["pick", true], ["pick", false]]);
    // The second press sells, at the price on the Sell back button.
    press(sell);
    press(go);
    expect(calls.at(-1)).toEqual(["sell", "i1", 7500]);
    el.remove();
  });

  it("a sale refused goes back to Sell back at the house's price now, and the next press asks at that price", () => {
    const el = root(afterHTML(offer, { esc, key: "r1" }));
    document.body.append(el);
    const calls = [];
    wireAfter(el, { onSell: (...a) => calls.push(a[1]) });
    const press = target => el.dispatchEvent(event("click", target));
    const li = el.querySelector(".lc-after__item");
    const sure = el.querySelector(".lc-after__sure");
    press(el.querySelector(".lc-after__sell"));
    press(el.querySelector(".lc-after__sellgo"));
    setBusy(li, "sell");
    refused(li, "Test Crate now buys Wand of Webs back for 60 gp.", { cp: 6000 });
    expect(sure.hidden).toBe(true);
    expect(el.querySelector(".lc-after__acts").hidden).toBe(false);
    expect(document.activeElement).toBe(el.querySelector(".lc-after__sell"));
    expect(el.querySelector(".lc-after__sellgo").textContent).toBe("Sell");
    press(el.querySelector(".lc-after__sell"));
    expect(sure.querySelector(".lc-after__sure-label").textContent).toBe("Sell Wand of Webs back for 60 gp? This can't be undone.");
    press(el.querySelector(".lc-after__sellgo"));
    expect(calls).toEqual([7500, 6000]);
    el.remove();
  });

  it("while a request is out its button says so and nothing else can be pressed; a refusal brings the buttons back with the reason", () => {
    const el = root(afterHTML(offer, { esc, key: "r1" }));
    const calls = [];
    wireAfter(el, { onSell: () => calls.push("sell") });
    const li = el.querySelector(".lc-after__item");
    setBusy(li, "sell");
    expect(el.querySelector(".lc-after__sellgo").textContent).toBe("Selling…");
    el.dispatchEvent(event("click", el.querySelector(".lc-after__sellgo")));
    el.dispatchEvent(event("click", el.querySelector(".lc-after__sell")));
    expect(calls).toEqual([]);
    refused(li, "Test Crate now buys Wand of Webs back for 60 gp.", { cp: 6000 });
    const sell = el.querySelector(".lc-after__sell");
    expect(sell.textContent).toBe("Sell back for 60 gp");
    expect(sell.dataset.cp).toBe("6000");
    expect(sell.getAttribute("aria-disabled")).toBeNull();
    expect(li.querySelector(".lc-after__said").textContent).toBe("Test Crate now buys Wand of Webs back for 60 gp.");
  });

  it("once done, the row's buttons give way to what happened, and focus goes to the next row's button", () => {
    const el = root(afterHTML({ ...offer, items: [{ id: "i1", name: "Wand of Webs", sellCp: 7500 }, { id: "i2", name: "Potion", sellCp: 2500 }] }, { esc, key: "r1" }));
    const next = showPart(el, "i1", "Brinn sold Wand of Webs back for 75 gp.");
    const [first, second] = el.querySelectorAll(".lc-after__item");
    expect(first.querySelectorAll("button")).toHaveLength(0);
    expect(first.querySelector(".lc-after__said").textContent).toBe("Brinn sold Wand of Webs back for 75 gp.");
    expect(next).toBe(second.querySelector(".lc-after__give"));
    expect(showPart(el, "i2", "Brinn gave Potion to Saria.")).toBeNull();
    expect(el.querySelector(".lc-after__lead")).toBeNull();
  });

  it("a play of one item says what became of it once, in the result's own line, and its row goes", () => {
    const el = root(`<div class="lc-reveal__result">${resultHTML({ result: { name: "Wand of Webs", rarity: "rare" }, itemUuid: "Actor.a1.Item.i1", actorName: "Brinn", purse: { gp: 345 } }, { esc, canSee: true })}</div><div class="lc-reveal__after">${afterHTML(offer, { esc, key: "r1" })}</div>`);
    const where = el.querySelector(".lc-reveal__where");
    expect(where.textContent).toBe("Added to Brinn's inventory · 345 gp left");
    const slot = el.querySelector(".lc-reveal__after");
    expect(showPart(slot, "i1")).toBeNull();
    whereAfter(el, partWhere({ soldCp: 7500 }));
    // Never both: "Added to Brinn's inventory" and, under it, that it was sold.
    expect(where.textContent).toBe("Sold back for 75 gp · 345 gp left");
    expect(el.textContent).not.toContain("Added to");
    expect(slot.querySelector(".lc-after")).toBeNull();
    expect(slot.textContent.trim()).toBe("");
    whereAfter(el, partWhere({ given: { actorName: "Saria" } }));
    expect(where.textContent).toBe("Given to Saria · 345 gp left");
  });

  it("with every item of a play gone, the result's line stops saying it was added to the sheet", () => {
    const seen = root(`<div class="lc-reveal__result">${resultHTML({ result: { name: "Wand of Webs", rarity: "rare" }, itemUuid: "Actor.a1.Item.i1", actorName: "Brinn", purse: { gp: 345 } }, { esc, canSee: true })}</div>`);
    whereAfter(seen, "");
    expect(seen.querySelector(".lc-reveal__where").textContent).toBe("345 gp left");
    // A spectator's line held that phrase alone: the line goes with it.
    const unseen = root(`<div class="lc-reveal__result">${resultHTML({ result: { name: "Wand of Webs", rarity: "rare" }, itemUuid: "Actor.a1.Item.i1", actorName: "Brinn" }, { esc })}</div>`);
    whereAfter(unseen, "");
    expect(unseen.querySelector(".lc-reveal__where")).toBeNull();
    // A result with no such phrase (a miss) is left as it is.
    const miss = root(`<div class="lc-reveal__result"><div class="lc-reveal__quiet">Nothing this time.</div></div>`);
    whereAfter(miss, "Sold back for 75 gp");
    expect(miss.textContent).toBe("Nothing this time.");
  });

  it("everyone else sees only the lines", () => {
    const el = document.createElement("div");
    spectatorLine(el, "i1", "Brinn gave Wand of Webs to Saria.", { esc });
    spectatorLine(el, "i1", "Brinn gave Wand of Webs to Saria.", { esc });
    expect(el.querySelectorAll("button")).toHaveLength(0);
    expect(el.querySelectorAll(".lc-after__item")).toHaveLength(1);
    expect(el.textContent).toBe("Brinn gave Wand of Webs to Saria.");
  });
});

describe("the editors' Sell back", () => {
  const ctx = { esc, pools: [] };
  it.each(["crate", "well", "dice", "deck", "scratch"])("is in the %s editor's price section, 50 by default", kind => {
    const el = root(editorHTML(kind, newDraft(kind, { id: "g" }), ctx));
    const input = el.querySelector('input[name="sellBack"]');
    expect(input.getAttribute("value")).toBe("50");
    expect(input.closest("label").textContent).toBe("Sell back for  % of an item's price");
    expect(byId(el, input.getAttribute("aria-describedby")).textContent).toContain("0 turns it off for this game");
    // In the price section: inside it (the deck's fieldset), or after its
    // first element and before the next section.
    const price = el.querySelector('[data-section="price"]');
    const label = input.closest("label");
    if (!price.contains(label)) {
      const all = [...price.parentNode.children];
      const at = all.indexOf(label);
      const next = all.slice(all.indexOf(price) + 1).find(n => n.dataset.section);
      expect(at).toBeGreaterThan(all.indexOf(price));
      expect(next == null || all.indexOf(next) > at).toBe(true);
    }
  });

  it("shows a game's own percentage, and is in no table game's editor", () => {
    const el = root(editorHTML("crate", newDraft("crate", { id: "g", rules: { sellBack: 0 } }), ctx));
    expect(el.querySelector('input[name="sellBack"]').getAttribute("value")).toBe("0");
    for (const kind of ["roulette", "auction"]) expect(root(editorHTML(kind, newDraft(kind, { id: "g" }), ctx)).querySelector('input[name="sellBack"]')).toBeNull();
  });
});
