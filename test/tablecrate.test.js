/*
  A crate made from a roll table (B1): the table's own odds (rules.oddsMode
  "weight"), its text results as pulls that find nothing (rules.missChance),
  nested tables flattened with their weights multiplied through, and the
  words the shop, the editor and the drop preview say about all of it. A
  crate without either rule draws exactly as it always has.
*/
import { describe, it, expect, vi } from "vitest";
import { draw, shopOdds, rollMiss, missState, oddsModeOf, missChanceOf, seededRng, undoPull, MAX_MISS } from "../module/scripts/odds.js";
import { buildStrip, NOTHING_CARD, fillerSource, pickFiller, teaseRarity } from "../module/scripts/strip.js";
import { performPull } from "../module/scripts/pull.js";
import { crateLogRow, CRATE } from "../module/scripts/crate.js";
import { chanceLines, chanceLinesHTML, boxCard, draftBox, oddsRules, oddsRows, boxPreview, boxPreviewHTML, oddsSummary } from "../module/scripts/boxcard.js";
import { replaySnapshot, replayReveal, missHTML, oddsWithNothing } from "../module/scripts/revealcard.js";
import { flattenTable, integerWeights, entriesFromDrop, TABLE_DEPTH } from "../module/scripts/store.js";
import { describeSkipped, dropPreviewHTML } from "../module/scripts/poolview.js";
import { crateFromTable } from "../module/scripts/newgame.js";
import { oddsModeFieldset, tableNoteHTML, nothingRow } from "../module/scripts/editorfields.js";
import { boxesTabHTML } from "../module/scripts/boxestable.js";

const entry = (uuid, weight, rarity = "common", extra = {}) => ({ uuid, name: uuid, img: `icons/${uuid}.webp`, rarity, sourceRarity: rarity, weight, ...extra });
const tally = (n, fn) => { const out = {}; for (let i = 0; i < n; i++) { const k = fn(); out[k] = (out[k] ?? 0) + 1; } return out; };

// The live check's table: two items at 1 and 99.
const POOLS = {
  loot: { id: "loot", name: "Live loot table", pools: [], entries: [entry("scale", 1, "rare"), entry("potion", 99, "common")] },
  mixed: { id: "mixed", name: "Mixed", pools: [], entries: [entry("a", 1, "common"), entry("b", 1, "uncommon"), entry("c", 2, "legendary")] },
  other: { id: "other", name: "Other", pools: [], entries: [entry("x", 1, "common")] },
};
const WEIGHT = { id: "w", name: "Table crate", price: 1, pools: [{ id: "loot", share: 1 }], weights: { common: 60, uncommon: 26, rare: 10, veryRare: 3, legendary: 1, artifact: 0 }, rules: { oddsMode: "weight" } };
const RARITY = { ...WEIGHT, id: "r", rules: {} };

describe("the table's odds (rules.oddsMode weight)", () => {
  it("reads the mode, with no oddsMode meaning rarity", () => {
    expect(oddsModeOf(WEIGHT)).toBe("weight");
    expect(oddsModeOf(RARITY)).toBe("rarity");
    expect(oddsModeOf({ rules: { oddsMode: "rarity" } })).toBe("rarity");
    expect(oddsModeOf({})).toBe("rarity");
  });

  it("draws each item as often as its weight says, over a seeded sweep", () => {
    const rng = seededRng(11);
    const n = 20000;
    const got = tally(n, () => draw({ box: WEIGHT, pools: POOLS, rng }).entry.uuid);
    expect(got.scale / n).toBeGreaterThan(0.006);
    expect(got.scale / n).toBeLessThan(0.014);
    expect(got.potion / n).toBeCloseTo(0.99, 2);
  });

  it("ignores the rarity bands: a rarity weighted 0 still drops by its items' weights", () => {
    const box = { ...WEIGHT, pools: [{ id: "mixed", share: 1 }], weights: { common: 100, uncommon: 0, rare: 0, veryRare: 0, legendary: 0, artifact: 0 } };
    const rng = seededRng(4);
    const n = 16000;
    const got = tally(n, () => draw({ box, pools: POOLS, rng }).entry.uuid);
    expect(got.a / n).toBeCloseTo(0.25, 1);
    expect(got.b / n).toBeCloseTo(0.25, 1);
    expect(got.c / n).toBeCloseTo(0.5, 1);
    // The same box by rarity drops only the common item.
    const byRarity = { ...box, rules: {} };
    expect(new Set(Array.from({ length: 300 }, () => draw({ box: byRarity, pools: POOLS, rng }).entry.uuid))).toEqual(new Set(["a"]));
  });

  it("still splits pulls between pools by their shares", () => {
    const box = { ...WEIGHT, pools: [{ id: "mixed", share: 3 }, { id: "other", share: 1 }] };
    const rng = seededRng(8);
    const n = 16000;
    const got = tally(n, () => draw({ box, pools: POOLS, rng }).poolId);
    expect(got.mixed / n).toBeCloseTo(0.75, 1);
    expect(got.other / n).toBeCloseTo(0.25, 1);
    const odds = shopOdds(box, POOLS);
    const c = odds.items.find(it => it.uuid === "c");
    expect(c.chance).toBeCloseTo(0.75 * 0.5, 10);
    expect(odds.items.find(it => it.uuid === "x").chance).toBeCloseTo(0.25, 10);
  });

  it("keeps pity in weight mode: once due, only items at its rarity or better, by their weights", () => {
    const box = { ...WEIGHT, pools: [{ id: "mixed", share: 1 }], rules: { oddsMode: "weight", pity: { after: 3, minRarity: "uncommon" } } };
    const rng = seededRng(2);
    const due = { sinceRare: 3 };
    const got = tally(9000, () => draw({ box, pools: POOLS, rng, state: due }).entry.uuid);
    expect(got.a).toBeUndefined();
    expect(got.c / 9000).toBeCloseTo(2 / 3, 1);
    expect(draw({ box, pools: POOLS, rng, state: due }).pity).toBe(true);
    const odds = shopOdds(box, POOLS, due);
    expect(odds.items.map(it => it.uuid).sort()).toEqual(["b", "c"]);
    expect(odds.pity).toMatchObject({ due: true, minRarity: "uncommon" });
  });

  it("keeps no-duplicates in weight mode: what the buyer owns never drops and isn't named", () => {
    const box = { ...WEIGHT, pools: [{ id: "mixed", share: 1 }], rules: { oddsMode: "weight", noDuplicates: true } };
    const rng = seededRng(6);
    const state = { owned: ["c"] };
    const got = tally(4000, () => draw({ box, pools: POOLS, rng, state }).entry.uuid);
    expect(got.c).toBeUndefined();
    expect(shopOdds(box, POOLS, state).items.map(it => it.uuid).sort()).toEqual(["a", "b"]);
    expect(shopOdds(box, POOLS, { owned: ["a", "b", "c"] }).nothingNew).toBe(true);
  });

  it("names every item's real chance in the shop, best find first, summing to 100 and never 0%", () => {
    const odds = shopOdds(WEIGHT, POOLS);
    expect(odds.mode).toBe("weight");
    expect(odds.items.map(it => [it.name, it.label])).toEqual([["scale", "1%"], ["potion", "99%"]]);
    expect(odds.items.reduce((n, it) => n + it.pct, 0)).toBe(100);
    // The ribbon's rarity rows are the items' chances added up by rarity.
    expect(odds.rows.map(r => [r.rarity, r.label])).toEqual([["common", "99%"], ["rare", "1%"]]);
    const tiny = { ...WEIGHT, pools: [{ id: "t", share: 1 }] };
    const pools = { t: { id: "t", pools: [], entries: [entry("rare-find", 1, "rare"), entry("junk", 999)] } };
    const t = shopOdds(tiny, pools);
    expect(t.items.find(it => it.uuid === "rare-find").label).toBe("<1%");
    expect(t.items.every(it => it.label !== "0%")).toBe(true);
    expect(t.items.reduce((n, it) => n + it.pct, 0)).toBe(100);
  });

  it("leaves a crate without oddsMode exactly as it was: no items, no nothing, the same rolls", () => {
    const odds = shopOdds(RARITY, POOLS);
    expect(odds.mode).toBeUndefined();
    expect(odds.items).toBeUndefined();
    expect(odds.nothing).toBeUndefined();
    const a = seededRng(21), b = seededRng(21);
    for (let i = 0; i < 200; i++) expect(draw({ box: RARITY, pools: POOLS, rng: a }).entry.uuid).toBe(draw({ box: { ...RARITY, rules: { oddsMode: "rarity" } }, pools: POOLS, rng: b }).entry.uuid);
    // rollMiss takes no number from the rng for a box that can't miss.
    const rng = vi.fn(() => 0);
    expect(rollMiss({ box: RARITY, pools: POOLS, rng })).toBe(false);
    expect(rng).not.toHaveBeenCalled();
  });
});

describe("text results as nothing (rules.missChance)", () => {
  const MISS = { ...WEIGHT, rules: { oddsMode: "weight", missChance: 0.25 } };

  it("reads the chance, capped below a sure miss", () => {
    expect(missChanceOf(MISS)).toBe(0.25);
    expect(missChanceOf(WEIGHT)).toBe(0);
    expect(missChanceOf({ rules: { missChance: 5 } })).toBe(MAX_MISS);
    expect(missChanceOf({ rules: { missChance: "nope" } })).toBe(0);
  });

  it("misses as often as the chance says, never on a pull whose pity is due", () => {
    const rng = seededRng(13);
    const n = 20000;
    let misses = 0;
    for (let i = 0; i < n; i++) if (rollMiss({ box: MISS, pools: POOLS, rng })) misses++;
    expect(misses / n).toBeCloseTo(0.25, 1);
    const pity = { ...MISS, rules: { ...MISS.rules, pity: { after: 2, minRarity: "rare" } } };
    expect(Array.from({ length: 500 }, () => rollMiss({ box: pity, pools: POOLS, rng, state: { sinceRare: 2 } })).some(Boolean)).toBe(false);
  });

  it("shows the nothing with the items, the lines summing to 100", () => {
    const odds = shopOdds(MISS, POOLS);
    expect(odds.nothing).toMatchObject({ chance: 0.25, label: "25%" });
    expect(odds.items.reduce((n, it) => n + it.pct, 0) + odds.nothing.pct).toBe(100);
    expect(odds.items.find(it => it.uuid === "potion").chance).toBeCloseTo(0.75 * 0.99, 10);
    // In rarity mode too, after the rarity pills.
    const rarity = shopOdds({ ...RARITY, rules: { missChance: 0.1 } }, POOLS);
    expect(oddsRows(rarity).at(-1)).toMatchObject({ rarity: "none", label: "10%" });
  });

  it("counts a miss toward pity and owns nothing, and its refund takes the one back", () => {
    expect(missState({ sinceRare: 2, owned: ["a"], pulls: 4 })).toEqual({ sinceRare: 3, owned: ["a"], pulls: 5 });
    const row = crateLogRow({ game: MISS, state: { sinceRare: 2 }, out: { result: null } });
    expect(row).toEqual({ outcome: "nothing", name: "Nothing", before: { sinceRare: 2, hadItem: false }, resetPity: false });
    expect(undoPull({ sinceRare: 3, owned: ["a"], pulls: 5 }, { ...row, id: "r1", actorId: "x", boxId: "w", at: 1 }, [])).toEqual({ sinceRare: 2, owned: ["a"], pulls: 4 });
  });

  it("rolls a miss on the GM: no item, nothing granted, the strip landing on a blank", async () => {
    globalThis.fromUuid = async uuid => ({ name: uuid, img: "", toObject: () => ({ name: uuid, type: "loot", flags: {} }) });
    const actor = {
      id: "a1", name: "Crate Tester", system: { currency: { gp: 10 } }, created: [],
      async update(d) { actor.system.currency = d["system.currency"]; },
      async createEmbeddedDocuments(_t, docs) { actor.created.push(...docs); return docs.map(d => ({ id: "i1", ...d })); },
    };
    const box = { ...MISS, rules: { ...MISS.rules, missChance: MAX_MISS } };
    const out = await performPull({ box, pools: POOLS, actor, state: { sinceRare: 0 }, rng: () => 0 });
    expect(out.result).toBeNull();
    expect(out.outcome).toBe("nothing");
    expect(out.itemId).toBeNull();
    expect(actor.created).toEqual([]);
    expect(actor.system.currency.gp).toBe(9);
    expect(out.state.sinceRare).toBe(1);
    expect(out.strip.cards[out.strip.landIndex]).toMatchObject({ rarity: "none", result: true, nothing: true, name: "Nothing" });
    // The reveal, the chat card and the quiet word.
    const reveal = { ...out, actorName: "Crate Tester", box: { id: "w", name: "Table crate", price: 1 }, userId: "u" };
    expect(CRATE.reveal.result(reveal, { canSee: true, esc: String })).toContain("Nothing this time.");
    expect(CRATE.chat.card(reveal, { esc: String, itemLink: (_u, n) => n })).toContain("lc-chat__item");
    expect(CRATE.reveal.notice(reveal)).toBe("Table crate: nothing this time.");
    delete globalThis.fromUuid;
  });

  it("replays a miss from its card, landing on the blank", () => {
    const strip = buildStrip({ result: { entry: NOTHING_CARD, rarity: "none", miss: true }, box: MISS, pools: POOLS, rng: seededRng(3) });
    const reveal = { strip, result: null, outcome: "nothing", box: { name: "Table crate", price: 1 }, actorName: "Tam", odds: oddsWithNothing(shopOdds(MISS, POOLS)) };
    const snap = replaySnapshot(reveal);
    expect(snap.result).toEqual({ name: "Nothing", rarity: "none", nothing: true });
    const back = replayReveal(snap, "m1");
    expect(back.result).toBeNull();
    expect(back.outcome).toBe("nothing");
    expect(back.strip.cards[back.strip.landIndex].rarity).toBe("none");
    expect(back.odds.at(-1).rarity).toBe("none");
    expect(missHTML(back, { esc: String })).not.toContain("left");
  });
});

describe("the strip for a table crate", () => {
  it("draws fillers by the items' weights and blanks as often as a pull misses", () => {
    const box = { ...WEIGHT, rules: { oddsMode: "weight", missChance: 0.5 } };
    const source = fillerSource(box, POOLS);
    const rng = seededRng(17);
    const got = tally(10000, () => (pickFiller(source, rng)?.nothing ? "nothing" : "item"));
    expect(got.nothing / 10000).toBeCloseTo(0.5, 1);
    const items = fillerSource(WEIGHT, POOLS);
    const names = tally(10000, () => pickFiller(items, rng).uuid);
    expect(names.potion / 10000).toBeCloseTo(0.99, 1);
  });

  it("teases a miss with the lowest droppable rarity, as any item outranks nothing", () => {
    expect(teaseRarity({ miss: true, rarity: "none" }, ["common"], () => 0)).toBe("common");
    expect(teaseRarity({ rarity: "common" }, ["common"], () => 0)).toBeNull();
  });
});

describe("nested tables flattened", () => {
  const table = (uuid, results) => ({ uuid, documentName: "RollTable", name: uuid, results });
  const item = id => ({ uuid: `Item.${id}`, documentName: "Item", name: id, type: "loot", img: "", system: { rarity: "" } });
  const doc = (uuid, weight) => ({ type: "document", documentUuid: uuid, weight });

  it("multiplies a nested table's weights through by the result's share", async () => {
    const child = table("RollTable.child", [doc("Item.c1", 1), doc("Item.c2", 2)]);
    const root = table("RollTable.root", [doc("Item.a", 3), doc("RollTable.child", 6), { type: "text", weight: 1 }]);
    const docs = new Map([child, item("a"), item("c1"), item("c2")].map(d => [d.uuid, d]));
    const flat = await flattenTable(root, { load: async u => docs.get(u) ?? null });
    const w = Object.fromEntries(flat.items.map(i => [i.item.name, i.weight]));
    // 6 split 1:2 is 2 and 4; the root's own weights stay as they were.
    expect(w).toEqual({ a: 3, c1: 2, c2: 4 });
    expect(flat).toMatchObject({ flattened: 1, text: 1, textWeight: 1, tooDeep: 0 });
  });

  it("keeps ratios exact with whole numbers when a share doesn't divide", async () => {
    const child = table("RollTable.child", [doc("Item.c1", 1), doc("Item.c2", 1), doc("Item.c3", 1)]);
    const root = table("RollTable.root", [doc("Item.a", 1), doc("RollTable.child", 1)]);
    const docs = new Map([child, item("a"), item("c1"), item("c2"), item("c3")].map(d => [d.uuid, d]));
    const flat = await flattenTable(root, { load: async u => docs.get(u) ?? null });
    expect(flat.items.map(i => i.weight)).toEqual([3, 1, 1, 1]);
    expect(integerWeights([[2, 1], [4, 1]])).toEqual([2, 4]);
    expect(integerWeights([[1, 2], [1, 4]])).toEqual([2, 1]);
  });

  it("stops at the depth cap and counts what it skipped", async () => {
    const chain = [];
    for (let i = 1; i <= TABLE_DEPTH + 2; i++) chain.push(table(`RollTable.t${i}`, [doc(`Item.i${i}`, 1), doc(`RollTable.t${i + 1}`, 1)]));
    const docs = new Map([...chain, ...chain.map((_t, i) => item(`i${i + 1}`))].map(d => [d.uuid, d]));
    const flat = await flattenTable(chain[0], { load: async u => docs.get(u) ?? null });
    expect(flat.items.map(i => i.item.name)).toEqual(["i1", "i2", "i3", "i4", "i5"]);
    expect(flat.flattened).toBe(TABLE_DEPTH - 1);
    expect(flat.tooDeep).toBe(1);
  });

  it("stops on a table that rolls a table above it", async () => {
    const a = table("RollTable.a", [doc("Item.x", 1), doc("RollTable.b", 1)]);
    const b = table("RollTable.b", [doc("Item.y", 1), doc("RollTable.a", 1)]);
    const docs = new Map([a, b, item("x"), item("y")].map(d => [d.uuid, d]));
    const flat = await flattenTable(a, { load: async u => docs.get(u) ?? null });
    expect(flat.items.map(i => i.item.name)).toEqual(["x", "y"]);
    expect(flat).toMatchObject({ flattened: 1, tooDeep: 1 });
  });

  it("says what a table drop flattened and skipped, and the text's share, through entriesFromDrop", async () => {
    const child = table("RollTable.child", [doc("Item.c1", 1), doc("Item.c2", 1)]);
    const root = table("RollTable.root", [doc("Item.a", 1), doc("Item.b", 99), doc("RollTable.child", 10), { type: "text", weight: 10 }]);
    const docs = new Map([root, child, item("a"), item("b"), item("c1"), item("c2")].map(d => [d.uuid, d]));
    vi.stubGlobal("fromUuid", vi.fn(async u => docs.get(u) ?? null));
    try {
      const plan = await entriesFromDrop({ type: "RollTable", uuid: "RollTable.root" });
      expect(Object.fromEntries(plan.entries.map(e => [e.name, e.weight]))).toEqual({ a: 1, b: 99, c1: 5, c2: 5 });
      expect(plan).toMatchObject({ flattened: 1, textWeight: 10, uuid: "RollTable.root" });
      expect(plan.textChance).toBeCloseTo(10 / 120, 10);
      expect(describeSkipped(plan.skipped, { flattened: plan.flattened })).toEqual(["1 nested table flattened into its items", "1 text result skipped"]);
      const html = dropPreviewHTML(plan, "Loot", String);
      expect(html).toContain("Add <strong>4 items</strong>");
      expect(html).toContain("1 nested table flattened into its items");
      expect(html).toContain("weight 99");
    } finally { vi.unstubAllGlobals(); }
  });

  it("words what was left out of a deep or looping table", () => {
    expect(describeSkipped({ text: 2, tooDeep: 2, notItems: 1 }, { textAsNothing: true })).toEqual([
      "2 text results counted as nothing",
      "1 table result that isn't an item, skipped",
      "2 nested tables skipped: more than 5 deep, or rolling a table above them",
    ]);
  });
});

describe("making the crate and editing it", () => {
  const plan = { label: "Live loot table", uuid: "RollTable.live", entries: [{}, {}, {}], flattened: 1, textChance: 0.25 };

  it("drafts a crate named for the table, on its pool, at the table's odds", () => {
    const draft = crateFromTable(plan, "pool1", "box1");
    expect(draft).toMatchObject({ id: "box1", name: "Live loot table", pools: [{ id: "pool1", share: 1 }], rules: { oddsMode: "weight" }, fromTable: { uuid: "RollTable.live", name: "Live loot table", items: 3, flattened: 1, textChance: 0.25 } });
    expect(draft.rules.missChance).toBeUndefined();
  });

  it("offers the odds as one choice with a sentence each, and says the table is a copy", () => {
    const draft = crateFromTable(plan, "pool1", "box1");
    const html = oddsModeFieldset(draft, { esc: String });
    expect(html).toContain('value="weight" checked');
    expect(html).toContain("Use the table's odds");
    expect(html).toContain("1 in 100 stays 1 in 100");
    expect((html.match(/aria-describedby="lc-mode-box1-/g) ?? []).length).toBe(2);
    expect(oddsModeFieldset({ id: "b", rules: {} }, { esc: String })).toContain('value="rarity" checked');
    expect(oddsModeFieldset({ id: "b", rules: {} }, { esc: String })).toContain("By item weight");
    expect(tableNoteHTML(draft, { esc: String })).toBe("<p class=\"lc-form__hint lc-form__from\">Copied from <strong>Live loot table</strong> (3 items, 1 nested table flattened); edit the table and make the crate again to pick up changes.</p>");
    expect(tableNoteHTML({ id: "b" })).toBe("");
  });

  it("offers 'Count text results as nothing' only for a table with text, off for a new crate", () => {
    const draft = crateFromTable(plan, "pool1", "box1");
    const row = nothingRow(draft, { esc: String });
    expect(row).toContain("Count text results as nothing");
    expect(row).toContain("25%");
    expect(row).not.toContain("checked");
    expect(nothingRow({ ...draft, rules: { ...draft.rules, missChance: 0.25 } })).toContain("checked");
    expect(nothingRow(crateFromTable({ ...plan, textChance: 0 }, "p", "b"))).toBe("");
  });

  it("saves the choice: weight stored, rarity stored as no oddsMode, the nothing only while ticked", () => {
    const fromTable = { textChance: 0.25 };
    expect(oddsRules({ pity: null }, { oddsMode: "weight", countNothing: true }, fromTable)).toEqual({ pity: null, oddsMode: "weight", missChance: 0.25 });
    expect(oddsRules({ oddsMode: "weight", missChance: 0.25 }, { oddsMode: "rarity", countNothing: false }, fromTable)).toEqual({});
    expect(oddsRules({ missChance: 0.25 }, {}, fromTable)).toEqual({ missChance: 0.25 });
    // No text in the table: nothing to count, whatever the form says.
    expect(oddsRules({}, { countNothing: true }, {})).toEqual({});
    const draft = draftBox({ id: "b", rules: { pity: null }, fromTable }, { "pool.p": true, "share.p": "1", oddsMode: "weight", countNothing: true }, ["p"]);
    expect(draft.rules).toEqual({ pity: null, oddsMode: "weight", missChance: 0.25 });
    // An editor without the choice (a well's) leaves the rules alone.
    const well = { id: "w", rules: { cap: 3 } };
    expect(draftBox(well, {}, []).rules).toBe(well.rules);
  });

  it("previews the named chances in the editor, and says them in one line", () => {
    const box = { ...WEIGHT, rules: { oddsMode: "weight", missChance: 0.25 } };
    const preview = boxPreview(box, POOLS);
    const html = boxPreviewHTML(preview, String);
    expect(html).toContain("lc-chances");
    expect(oddsSummary(preview)).toBe("scale <1%, potion 74%, Nothing 25%");
  });
});

describe("the shop card of a table crate", () => {
  const many = { t: { id: "t", pools: [], entries: ["a", "b", "c", "d", "e", "f", "g"].map((u, i) => entry(u, i + 1, i === 6 ? "legendary" : "common")) } };
  const box = { ...WEIGHT, id: "many", pools: [{ id: "t", share: 1 }], rules: { oddsMode: "weight", missChance: 0.2 } };

  it("names the first few items, then 'and N more' with what they add up to, then the nothing", () => {
    const lines = chanceLines(shopOdds(box, many), 4);
    expect(lines.map(l => l.name)).toEqual(["g", "a", "b", "c", "and 3 more", "Nothing"]);
    expect(lines[0].rarity).toBe("legendary");
    const pct = s => (s === "<1%" ? 0 : Number(s.replace(/[<>%]/g, "")));
    expect(lines.reduce((n, l) => n + pct(l.label), 0)).toBe(100);
    expect(lines.every(l => l.label !== "0%")).toBe(true);
    // One more than fits shows in full, never "and 1 more".
    expect(chanceLines(shopOdds({ ...box, rules: { oddsMode: "weight" } }, { t: { ...many.t, entries: many.t.entries.slice(0, 5) } }), 4).map(l => l.name)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("draws the card with the named chances in place of the rarity pills", () => {
    const html = boxCard(WEIGHT, POOLS, { esc: String, stateOf: () => ({}) });
    expect(html).toContain('<span class="lc-chance__name">scale</span><span class="lc-sr-only">: </span><span class="lc-chance__pct">1%</span>');
    expect(html).toContain('<span class="lc-chance__name">potion</span><span class="lc-sr-only">: </span><span class="lc-chance__pct">99%</span>');
    expect(html).not.toContain("lc-box__odds");
    expect(chanceLinesHTML(shopOdds(RARITY, POOLS))).toBe("");
    // A rarity crate keeps its pills.
    expect(boxCard(RARITY, POOLS, { esc: String, stateOf: () => ({}) })).toContain("lc-box__odds");
  });

  it("marks a table crate's row on the Boxes tab and says the tab takes a table", () => {
    const html = boxesTabHTML({ boxes: [{ ...WEIGHT, fromTable: { name: "t" } }], pools: POOLS, esc: String });
    expect(html).toContain("the table's odds");
    expect(html).toContain("Drop a roll table here");
  });
});
