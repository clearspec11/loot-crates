import { describe, it, expect } from "vitest";
import { draftBox, boxPreview, boxPreviewHTML, oddsPills, oddsRibbon } from "../module/scripts/boxcard.js";
import { shopOdds } from "../module/scripts/odds.js";
import { POOLS, BOX } from "../harness/sample.js";

// The box editor's form as promptForm reads it: checkboxes as booleans,
// numbers as the strings the inputs hold.
const IDS = ["core", "homebrew"];
const form = (over = {}) => ({
  name: BOX.name, price: "150",
  "pool.core": true, "share.core": "4", "pool.homebrew": true, "share.homebrew": "1",
  "w.common": "55", "w.uncommon": "28", "w.rare": "12", "w.veryRare": "4", "w.legendary": "1", "w.artifact": "0",
  ...over,
});
const pills = html => [...html.matchAll(/<span class="lc-odd[^"]*">([^<]*)<\/span>/g)].map(m => m[1]);

describe("draftBox", () => {
  it("reads weights and shares as Save does: 0 or more, blank or nonsense is 0", () => {
    const d = draftBox(BOX, form({ "w.rare": "", "w.veryRare": "-3", "w.legendary": "abc", "share.homebrew": "2.5" }), IDS);
    expect(d.weights).toEqual({ common: 55, uncommon: 28, rare: 0, veryRare: 0, legendary: 0, artifact: 0 });
    expect(d.pools).toEqual([{ id: "core", share: 4 }, { id: "homebrew", share: 2.5 }]);
    expect(d.id).toBe(BOX.id);
    expect(d.rules).toBe(BOX.rules);
  });

  it("keeps only ticked pools, in the form's order", () => {
    expect(draftBox(BOX, form({ "pool.core": false }), IDS).pools).toEqual([{ id: "homebrew", share: 1 }]);
    expect(draftBox(BOX, form({ "pool.core": "on", "pool.homebrew": false }), IDS).pools).toEqual([{ id: "core", share: 4 }]);
    expect(draftBox(BOX, form({ "pool.core": false, "pool.homebrew": false }), IDS).pools).toEqual([]);
  });

  it("gives the same odds as the stored box when nothing changed", () => {
    expect(shopOdds(draftBox(BOX, form(), IDS), POOLS)).toEqual(shopOdds(BOX, POOLS));
  });
});

describe("boxPreview", () => {
  const preview = over => boxPreview(draftBox(BOX, form(over), IDS), POOLS);

  it("shows the shop's ribbon and pills, and follows a weight as it is typed", () => {
    const before = boxPreview(draftBox(BOX, form(), IDS), POOLS);
    const html = boxPreviewHTML(before);
    expect(html).toContain(oddsRibbon(shopOdds(BOX, POOLS).rows));
    expect(html).toContain(oddsPills(shopOdds(BOX, POOLS).rows));
    expect(pills(html)).toEqual(["Common 55%", "Uncommon 28%", "Rare 12%", "V. rare 4%", "Legendary 1%"]);
    expect(before.note).toBe("");
    expect(pills(boxPreviewHTML(preview({ "w.common": "0" })))).toEqual(["Uncommon 62%", "Rare 27%", "V. rare 9%", "Legendary 2%"]);
  });

  it("drops rarities only an unticked pool holds, and flags weights with nothing to act on", () => {
    // The homebrew pool alone holds uncommon, rare and legendary.
    const p = preview({ "pool.core": false });
    expect(pills(boxPreviewHTML(p))).toEqual(["Uncommon 68%", "Rare 29%", "Legendary 3%"]);
    expect([...p.held].sort()).toEqual(["legendary", "rare", "uncommon"]);
    expect(p.held.has("common")).toBe(false);
  });

  it("says when the box can drop nothing", () => {
    const none = preview({ "pool.core": false, "pool.homebrew": false });
    expect(none.empty).toBe(true);
    expect(none.note).toBe("This box can drop nothing: tick a pool above.");
    expect(boxPreviewHTML(none)).not.toContain("lc-ribbon");
    expect(boxPreviewHTML(none)).toContain("lc-form__hint--warn");

    const gone = { ...POOLS, homebrew: { ...POOLS.homebrew, entries: POOLS.homebrew.entries.map(e => ({ ...e, missing: true })) } };
    const dead = boxPreview(draftBox(BOX, form({ "pool.core": false }), IDS), gone);
    expect(dead.empty).toBe(true);
    expect(dead.note).toBe("This box can drop nothing: its pools have no item that can drop.");
  });

  it("says an all-zero box treats what it holds as equal, as draw() does", () => {
    const zero = Object.fromEntries(["common", "uncommon", "rare", "veryRare", "legendary", "artifact"].map(r => [`w.${r}`, "0"]));
    const p = preview({ ...zero, "pool.core": false });
    expect(p.empty).toBe(false);
    expect(p.note).toBe("Every rarity these pools hold weighs 0, so each is equally likely.");
    expect(pills(boxPreviewHTML(p))).toEqual(["Uncommon 34%", "Rare 33%", "Legendary 33%"]);
  });

  it("escapes through the caller's function", () => {
    const none = preview({ "pool.core": false, "pool.homebrew": false });
    expect(boxPreviewHTML(none, s => `[${s}]`)).toContain("[This box can drop nothing: tick a pool above.]");
  });
});
