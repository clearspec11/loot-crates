/*
  The editors in the order a GM plans a game, and short (views/editors.js,
  poolpicker.js; round 30, B2): the shared pool picker puts the game's own
  pools first with what each holds and folds the rest under "Add a pool"
  with a search, every field keeping its name; each kind's sections come
  in its order; the pools and weights show only while an item prize is on,
  the weights only for rarities the pools hold; Who can buy and Extras
  fold with a line saying what is set; Fill's top prize starts the same in
  a New and an Edit; the auction's lots are grouped by pool with a search.
  Pure markup and DOM wiring on the minimal DOM.
*/
import { describe, it, expect, beforeAll, vi } from "vitest";
import { createDocument } from "./minidom.js";

const { poolPickerHTML, pickerOrder, rarityMix, wirePoolPicker, matchText, FOLD_AFTER } = await import("../module/scripts/views/poolpicker.js");
const { editorHTML, sectionsOf, itemsOn, showWhen, foldWeights, foldSaid, foldLine, wireEditor, lotChoices, lotPickerHTML, wireLotSearch, lotKey } = await import("../module/scripts/views/editors.js");
const { poolsFieldset, syncShares } = await import("../module/scripts/views/editorfields.js");
const { fillFieldsHTML, topOf, FILL_TOP } = await import("../module/scripts/games/scratchplan.js");
const { newDraft, crateFromPool } = await import("../module/scripts/views/newgame.js");

beforeAll(() => {
  vi.stubGlobal("document", createDocument());
  vi.stubGlobal("CSS", { escape: s => String(s) });
});

const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const entry = (uuid, name, rarity) => ({ uuid, name, img: "", rarity, weight: 1 });
const pool = (id, name, entries, pools = []) => ({ id, name, pools, entries });
// A world of seven pools, made in this order: the one a game uses last.
const WORLD = {
  arms: pool("arms", "Arms and armour", [entry("Item.sw", "Moon-Touched Sword", "common"), entry("Item.ft", "Flame Tongue", "rare")]),
  hoard: pool("hoard", "Dragon's hoard", [entry("Item.ha", "Holy Avenger", "legendary")], ["arms"]),
  potions: pool("potions", "Potions and scrolls", [entry("Item.ph", "Potion of Healing", "common"), entry("Item.ps", "Spell Scroll", "common")]),
  sea: pool("sea", "Sea chest", [entry("Item.cp", "Cloak of Protection", "uncommon"), entry("Item.bs", "Boots of Speed", "rare")]),
  temple: pool("temple", "Temple offerings", [entry("Item.rr", "Ring of Regeneration", "veryRare")]),
  fence: pool("fence", "Thieves' guild fence", [entry("Item.cp", "Cloak of Protection", "uncommon"), entry("Item.wm", "Wand of Magic Missiles", "uncommon")]),
  mine: pool("mine", "UX first pool", [entry("Item.bh", "Bag of Holding", "uncommon"), entry("Item.go", "Goggles of Night", "uncommon"), entry("Item.ft", "Flame Tongue", "rare")]),
};
const LIST = Object.values(WORLD);
const root = html => { const el = document.createElement("div"); el.innerHTML = html; return el; };
const picks = el => el.querySelectorAll(".lc-pool-pick").map(r => r.querySelector('input[type="checkbox"]').getAttribute("name").slice(5));

describe("the pool picker", () => {
  it("lists the game's own pools first, in their order, then the rest by name", () => {
    const { on, rest } = pickerOrder(LIST, [{ id: "mine", share: 1 }, { id: "arms", share: 2 }]);
    expect(on.map(p => p.id)).toEqual(["mine", "arms"]);
    expect(rest.map(p => p.name)).toEqual(["Dragon's hoard", "Potions and scrolls", "Sea chest", "Temple offerings", "Thieves' guild fence"]);
  });

  it("a crate from a pool made last opens with that pool first and ticked, the rest folded under Add a pool", () => {
    const draft = crateFromPool(WORLD.mine, "new1");
    const el = root(poolsFieldset("Pools", LIST, draft.pools, { esc, id: "lc-picks-new1" }));
    expect(picks(el)[0]).toBe("mine");
    expect(el.querySelector('input[name="pool.mine"]').checked).toBe(true);
    const on = el.querySelector(".lc-pool-picker__on");
    expect(on.querySelectorAll(".lc-pool-pick").length).toBe(1);
    const more = el.querySelector(".lc-pool-picker__more");
    expect(more).not.toBeNull();
    expect(more.hasAttribute("open")).toBe(false);
    expect(more.querySelector("summary").textContent).toBe("Add a pool (6 more)");
    expect(more.querySelectorAll(".lc-pool-pick").length).toBe(6);
    expect(el.querySelector(".lc-pool-picker__none").hasAttribute("hidden")).toBe(true);
  });

  it("says what each pool holds, nested pools included, after its name", () => {
    expect(rarityMix("mine", WORLD)).toBe("2 uncommon, 1 rare");
    expect(rarityMix("hoard", WORLD)).toBe("1 common, 1 rare, 1 legendary");
    expect(rarityMix("nope", WORLD)).toBe("empty");
    const el = root(poolPickerHTML(LIST, [{ id: "mine", share: 1 }], { esc, id: "g" }));
    const box = el.querySelector('input[name="pool.mine"]');
    const mix = el.querySelectorAll("[id]").find(n => n.id === box.getAttribute("aria-describedby"));
    expect(mix.textContent).toBe("2 uncommon, 1 rare");
  });

  it("keeps every field's name: the checkbox the pool's, the share 'Share of pulls from' it, the search its own", () => {
    const el = root(poolPickerHTML(LIST, [{ id: "mine", share: 3 }], { esc }));
    const label = el.querySelector('input[name="pool.mine"]').closest("label");
    expect(label.querySelectorAll("input").length).toBe(1);
    expect(label.textContent.trim()).toBe("UX first pool");
    expect(el.querySelector('input[name="share.mine"]').getAttribute("aria-label")).toBe("Share of pulls from UX first pool");
    expect(el.querySelector('input[name="share.sea"]').getAttribute("aria-label")).toBe("Share of pulls from Sea chest");
    const search = el.querySelector(".lc-pool-picker__search");
    expect(search.getAttribute("aria-label")).toBe("Find a pool by name");
    // No name: the search is no part of what Save reads, or of whether the form changed.
    expect(search.hasAttribute("name")).toBe(false);
  });

  it("an unticked pool's share is off and out of sight until its pool is ticked", () => {
    const el = root(poolPickerHTML(LIST, [{ id: "mine", share: 1 }], { esc }));
    const share = id => el.querySelector(`input[data-share="${id}"]`);
    expect(share("sea").hasAttribute("disabled") && share("sea").hasAttribute("hidden")).toBe(true);
    expect(share("mine").hasAttribute("hidden")).toBe(false);
    el.querySelector('input[name="pool.sea"]').checked = true;
    syncShares(el);
    expect(share("sea").disabled).toBe(false);
    expect(share("sea").hidden).toBe(false);
  });

  it(`folds nothing with ${FOLD_AFTER} or fewer other pools, and says when none is ticked`, () => {
    const few = LIST.slice(0, 3);
    const el = root(poolPickerHTML(few, [], { esc }));
    expect(el.querySelector(".lc-pool-picker__more")).toBeNull();
    expect(el.querySelector(".lc-pool-picker__search")).toBeNull();
    expect(picks(el)).toEqual(["arms", "hoard", "potions"]);
    expect(el.querySelector(".lc-pool-picker__none").textContent).toBe("No pool ticked yet.");
  });

  it("the search filters the folded pools by name as it is typed, says how many match, and Enter goes to the first", () => {
    const el = root(poolPickerHTML(LIST, [{ id: "mine", share: 1 }], { esc }));
    wirePoolPicker(el);
    const search = el.querySelector(".lc-pool-picker__search");
    const shown = () => el.querySelectorAll(".lc-pool-picker__rest .lc-pool-pick").filter(r => !r.hidden).map(r => r.dataset.poolName);
    search.value = "SEA";
    search.dispatchEvent({ type: "input" });
    expect(shown()).toEqual(["sea chest"]);
    expect(el.querySelector(".lc-pool-picker__count").textContent).toBe("1 pool matches.");
    search.value = "zz";
    search.dispatchEvent({ type: "input" });
    expect(shown()).toEqual([]);
    expect(el.querySelector(".lc-pool-picker__count").textContent).toBe("No pool matches “zz”.");
    search.value = "t";
    search.dispatchEvent({ type: "input" });
    const enter = { type: "keydown", key: "Enter", preventDefault: vi.fn() };
    search.dispatchEvent(enter);
    expect(enter.preventDefault).toHaveBeenCalled();
    // "t": Potions and scrolls is the first match by name.
    expect(document.activeElement === el.querySelector('input[name="pool.potions"]')).toBe(true);
    // Escape clears a search before anything closes.
    const escape = { type: "keydown", key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() };
    search.dispatchEvent(escape);
    expect(escape.stopPropagation).toHaveBeenCalled();
    expect(search.value).toBe("");
    expect(shown().length).toBe(6);
    expect(matchText(3, "s")).toBe("3 pools match.");
  });

  it("Add a pool and 'No pool ticked yet' follow the checkboxes", () => {
    const el = root(poolsFieldset("Pools", LIST, [], { esc }));
    const follow = wirePoolPicker(el);
    expect(el.querySelector("[data-picker-add]").textContent).toBe("Add a pool (7 more)");
    el.querySelector('input[name="pool.sea"]').checked = true;
    follow();
    expect(el.querySelector("[data-picker-add]").textContent).toBe("Add a pool (6 more)");
    expect(el.querySelector(".lc-pool-picker__none").hidden).toBe(true);
  });
});

const ctx = { esc, pools: LIST, hasClock: true };
const sections = (kind, box, extra = {}) => sectionsOf(root(editorHTML(kind, box, { ...ctx, ...extra })));

describe("each editor in the order a GM plans it", () => {
  it("a crate: name, what's in it, odds, the readout, price, who can buy, extras, the shelf", () => {
    expect(sections("crate", newDraft("crate", { id: "c", pools: [{ id: "mine", share: 1 }] }))).toEqual(["name", "pools", "odds", "weights", "readout", "price", "limits", "extras", "shelf"]);
  });
  it("a scratch ticket: price and roll, the pools right above the prizes and Fill, then the card, its look and who sees what", () => {
    const order = sections("scratch", newDraft("scratch", { id: "s" }));
    expect(order).toEqual(["name", "price", "roll", "pools", "prizes", "readout", "card", "look", "sees", "shelf"]);
    const el = root(editorHTML("scratch", newDraft("scratch", { id: "s" }), ctx));
    const prizes = el.querySelector('[data-section="prizes"]');
    // Fill comes first in the prizes, before the rows it fills.
    expect(prizes.children[1].classList.contains("lc-fill")).toBe(true);
  });
  it("the well, the dice, the deck, the wheel and the auction: what's in it before the price, limits and the shelf after", () => {
    expect(sections("well", newDraft("well", { id: "w" }))).toEqual(["name", "outcomes", "pools", "weights", "readout", "price", "cap", "extras", "shelf"]);
    expect(sections("dice", newDraft("dice", { id: "d" }))).toEqual(["name", "dragon", "prize", "pools", "weights", "readout", "price", "limits", "shelf"]);
    expect(sections("deck", newDraft("deck", { id: "k" }))).toEqual(["name", "cards", "pools", "weights", "readout", "price", "limits", "shelf"]);
    expect(sections("roulette", newDraft("roulette", { id: "r" }), { newId: () => "x" })).toEqual(["name", "pockets", "payouts", "prize", "pools", "readout", "price", "shelf"]);
    expect(sections("auction", newDraft("auction", { id: "a" }), { lots: lotChoices({}, WORLD) })).toEqual(["name", "lot", "price", "house", "readout", "shelf"]);
  });
  it("a crate made from a table says so above its pools", () => {
    const box = { ...newDraft("crate", { id: "t", pools: [{ id: "mine", share: 1 }] }), fromTable: { name: "Goblin's Pockets", items: 7, textChance: 0.25 } };
    expect(sections("crate", box).slice(0, 3)).toEqual(["name", "from", "pools"]);
  });
  it("names the deck's gold, weight and once in the row as well, for the narrow layout", () => {
    const el = root(editorHTML("deck", newDraft("deck", { id: "k" }), ctx));
    const row = el.querySelector(".lc-card-row");
    expect(row.querySelectorAll(".lc-card-row__cap").map(c => c.textContent)).toEqual(["Gold", "Weight", "Once"]);
    expect(row.querySelectorAll(".lc-card-row__cap").every(c => c.getAttribute("aria-hidden") === "true")).toBe(true);
    expect(row.querySelector(".lc-card-row__once input").getAttribute("aria-label")).toBe("Card 1 once per deck");
  });
});

describe("only what applies is open", () => {
  it("an item prize turned on, by kind", () => {
    expect(itemsOn({ kind: "dice", rules: { prize: false } })).toBe(false);
    expect(itemsOn({ kind: "dice", rules: { prize: true } })).toBe(true);
    expect(itemsOn({ kind: "well", odds: { item: 0 } })).toBe(false);
    expect(itemsOn({ kind: "well", odds: { item: 2 } })).toBe(true);
    expect(itemsOn({ kind: "deck", deck: { cards: [{ kind: "coins" }] } })).toBe(false);
    expect(itemsOn({ kind: "deck", deck: { cards: [{ kind: "coins" }, { kind: "item" }] } })).toBe(true);
    expect(itemsOn({ kind: "roulette", roulette: { itemOnRarity: false } })).toBe(false);
    expect(itemsOn({ kind: "crate" })).toBe(true);
    expect(itemsOn({ kind: "scratch" })).toBe(true);
  });

  it("the dice's pools and rarity weights hide while its prize is off, and stay in the form", () => {
    const el = root(editorHTML("dice", newDraft("dice", { id: "d", pools: [{ id: "sea", share: 1 }] }), ctx));
    showWhen(el, { kind: "dice", rules: { prize: false } });
    const parts = el.querySelectorAll('[data-when="items"]');
    expect(parts.map(p => p.dataset.section)).toEqual(["pools", "weights"]);
    expect(parts.every(p => p.hidden)).toBe(true);
    expect(el.querySelector('input[name="pool.sea"]').checked).toBe(true);
    showWhen(el, { kind: "dice", rules: { prize: true } });
    expect(parts.some(p => p.hidden)).toBe(false);
  });

  it("the weights show only the rarities the ticked pools hold, the others behind one button", () => {
    const el = root(editorHTML("crate", newDraft("crate", { id: "c", pools: [{ id: "mine", share: 1 }] }), ctx));
    const shown = () => el.querySelectorAll("[data-weight]").filter(r => !r.hidden).map(r => r.dataset.weight);
    const more = el.querySelector(".lc-weights__more");
    foldWeights(el, new Set(["uncommon", "rare"]), true);
    expect(shown()).toEqual(["uncommon", "rare"]);
    expect(more.hidden).toBe(false);
    expect(more.textContent).toBe("Show Common, Very rare, Legendary and Artifact too");
    // Every weight is still in the form for Save.
    expect(el.querySelectorAll("input").filter(i => i.name.startsWith("w.")).length).toBe(6);
    // With no pool ticked there is nothing to judge from: all six show.
    foldWeights(el, new Set(), false);
    expect(shown().length).toBe(6);
    expect(more.hidden).toBe(true);
    // The button opens the others, and says how to put them away.
    foldWeights(el, new Set(["rare"]), true);
    const repaint = () => foldWeights(el, new Set(["rare"]), true);
    wireEditor(el, { read: () => ({}), repaint });
    more.dispatchEvent({ type: "click" });
    expect(shown().length).toBe(6);
    expect(more.textContent).toBe("Show only the rarities these pools hold");
  });

  it("Who can buy and Extras fold with a line saying what is set, open once something is", () => {
    const plain = root(editorHTML("crate", newDraft("crate", { id: "c" }), ctx));
    const fold = (el, key) => el.querySelector(`[data-fold="${key}"]`);
    expect(fold(plain, "limits").hasAttribute("open")).toBe(false);
    expect(fold(plain, "limits").querySelector("[data-fold-said]").textContent).toBe("Anyone, as often as they like");
    expect(fold(plain, "extras").querySelector("[data-fold-said]").textContent).toBe("None set");
    const set = root(editorHTML("crate", newDraft("crate", { id: "c", rules: { stock: 3, stockMax: 10, perCharacter: { max: 1, per: "day" }, pity: { minRarity: "rare", after: 6 }, noDuplicates: true } }), ctx));
    expect(fold(set, "limits").hasAttribute("open")).toBe(true);
    expect(fold(set, "limits").querySelector("[data-fold-said]").textContent).toBe("10 in stock, 1 per character a day");
    expect(fold(set, "extras").querySelector("[data-fold-said]").textContent).toBe("Pity: Rare or better after 6 pulls, no duplicates");
  });

  it("a fold's line follows what is typed", () => {
    expect(foldSaid("limits", { stock: "", limitMax: "2", limitPer: "ever" })).toBe("2 per character");
    expect(foldSaid("limits", { stock: "12", limitMax: "" })).toBe("12 in stock");
    expect(foldLine("limits", { stock: "", limitMax: "" })).toBe("Anyone, as often as they like");
    expect(foldSaid("cap", { cap: "3" })).toBe("3 throws a day per character");
    expect(foldSaid("extras", { pityRarity: "veryRare", pityAfter: "4" }, { noun: "throws" })).toBe("Pity: Very rare or better after 4 throws");
    expect(foldSaid("extras", { noDuplicates: true })).toBe("No duplicates per character");
    const el = root(editorHTML("crate", newDraft("crate", { id: "c" }), ctx));
    let values = { stock: "", limitMax: "" };
    wireEditor(el, { read: () => values });
    values = { stock: "5", limitMax: "1", limitPer: "day" };
    el.dispatchEvent({ type: "input" });
    expect(el.querySelector('[data-fold="limits"] [data-fold-said]').textContent).toBe("5 in stock, 1 per character a day");
  });
});

describe("Fill's top prize starts the same in a New and an Edit", () => {
  const selected = html => root(html).querySelector('select[name="fillTop"]').value;
  it("a new ticket's list tops out at a Rare item, and Fill starts there", () => {
    const fresh = newDraft("scratch", { id: "s" });
    expect(topOf(fresh).what).toBe(FILL_TOP);
    expect(selected(fillFieldsHTML(fresh, { esc }))).toBe("item.rare");
  });
  it("an edit whose list was emptied, or tops out with several parts, starts at a Rare item too (not coins worked out)", () => {
    expect(selected(fillFieldsHTML({ id: "e", roll: { size: 100, prizes: [] } }, { esc }))).toBe("item.rare");
    const combo = { id: "e", bonus: { on: true, gp: 25 }, roll: { size: 100, prizes: [{ count: 1, parts: [{ item: { rarity: "uncommon" } }, { gp: 25 }] }, { count: 10, parts: [{ gp: 5 }] }] } };
    expect(selected(fillFieldsHTML(combo, { esc }))).toBe("item.rare");
  });
  it("an edit whose top line is one item or one coin amount starts at that", () => {
    expect(topOf({ roll: { prizes: [{ count: 1, parts: [{ item: { rarity: "veryRare" } }] }, { count: 9, parts: [{ gp: 5 }] }] } }).what).toBe("item.veryRare");
    expect(topOf({ roll: { prizes: [{ count: 1, parts: [{ gp: 125 }] }, { count: 9, parts: [{ gp: 5 }] }] } })).toEqual({ what: "gp", gp: 125 });
  });
});

describe("the auction's lot picker", () => {
  const CRATES = { c1: { id: "c1", name: "Adventurer's Crate" }, w: { id: "w", kind: "well", name: "Wishing Well" } };
  it("lists the crates, then each pool's items under the pool, an item in two pools under both", () => {
    const { choices, groups } = lotChoices(CRATES, WORLD);
    expect(groups[0]).toEqual({ label: "Sealed crates", keys: ["crate:c1"] });
    const labels = groups.map(g => g.label);
    expect(labels.slice(1)).toEqual(["Arms and armour", "Dragon's hoard", "Potions and scrolls", "Sea chest", "Temple offerings", "Thieves' guild fence", "UX first pool"]);
    const holding = groups.filter(g => g.keys.includes("item:Item.cp")).map(g => g.label);
    expect(holding).toEqual(["Sea chest", "Thieves' guild fence"]);
    // One choice per item, however many pools list it.
    expect([...choices.keys()].filter(k => k === "item:Item.cp").length).toBe(1);
  });

  it("an item dropped earlier keeps a group of its own", () => {
    const own = { type: "item", uuid: "Compendium.x.Item.y", name: "Sunblade", img: "", rarity: "rare" };
    const { groups } = lotChoices({}, WORLD, own);
    expect(groups.at(-1)).toEqual({ label: "Dropped here", keys: [lotKey(own)], dropped: true });
  });

  it("the game's lot is chosen in its first place; the search finds a lot by its name and Enter picks it", () => {
    const lots = lotChoices(CRATES, WORLD);
    const el = root(lotPickerHTML(lots, "item:Item.ft", esc));
    const pick = el.querySelector('select[name="lot"]');
    expect(pick.getAttribute("size")).toBe("8");
    expect(el.querySelectorAll('option[selected]').map(o => o.parentNode.getAttribute("label"))).toEqual(["Arms and armour"]);
    expect(el.querySelector(".lc-auction-lot__search").getAttribute("aria-label")).toBe("Find a lot by name");
    wireLotSearch(el);
    const search = el.querySelector(".lc-auction-lot__search");
    search.value = "cloak";
    search.dispatchEvent({ type: "input" });
    const visible = el.querySelectorAll("optgroup").filter(g => !g.hidden).map(g => g.getAttribute("label"));
    expect(visible).toEqual(["Sea chest", "Thieves' guild fence"]);
    expect(el.querySelector(".lc-auction-lot__count").textContent).toBe("2 lots match.");
    // A name's rarity isn't what is searched: "rare" finds no Rare-tagged item by its tag.
    search.value = "rare";
    search.dispatchEvent({ type: "input" });
    expect(el.querySelector(".lc-auction-lot__count").textContent).toBe("No lot matches “rare”.");
    search.value = "boots";
    search.dispatchEvent({ type: "input" });
    let changed = 0;
    pick.addEventListener("change", () => changed++);
    search.dispatchEvent({ type: "keydown", key: "Enter", preventDefault: () => {} });
    const chosen = el.querySelectorAll("option").filter(o => o.selected);
    expect(chosen.map(o => o.getAttribute("value"))).toEqual(["item:Item.bs"]);
    expect(changed).toBe(1);
    expect(el.querySelector("[data-lot-said]").textContent).toBe("Boots of Speed, Rare is the lot.");
  });
});
