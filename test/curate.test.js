/*
  Per-entry curation: a GM's rarity override and weight are what the roll,
  the odds and the strip use; weight 0 never drops; an entry keeps its
  source's own rarity ("" when it had none) so the editor can flag it and a
  source check never mistakes an override for drift.
*/
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { draw, oddsTable, shopOdds, flattenPool, sourceStatus, seededRng, effectiveRarity, rarityUnset, entryWeight, curateEntries } from "../module/scripts/core/odds.js";
import { buildStrip, fillerSource } from "../module/scripts/core/strip.js";
import { entryFromItem, registerSettings, savePool, getPools, updatePool, enqueueWrite, markMissing } from "../module/scripts/foundry/store.js";

const entry = (uuid, rarity, extra = {}) => ({ uuid, name: uuid, img: "", rarity, sourceRarity: rarity, weight: 1, ...extra });
const BOX = { id: "b", pools: [{ id: "p", share: 1 }], weights: { common: 60, uncommon: 30, rare: 9, legendary: 1 } };

describe("rarity override", () => {
  const pools = { p: { id: "p", entries: [entry("sword", "common"), entry("wand", "common", { rarityOverride: "legendary" })], pools: [] } };

  it("flattenPool hands out the override, not the stored rarity", () => {
    const byUuid = Object.fromEntries(flattenPool("p", pools).map(e => [e.uuid, e.rarity]));
    expect(byUuid).toEqual({ sword: "common", wand: "legendary" });
  });

  it("draw lands the overridden entry at its override", () => {
    const seen = new Set();
    for (let seed = 1; seed < 400; seed++) {
      const r = draw({ box: BOX, pools, rng: seededRng(seed) });
      if (r.entry.uuid === "wand") { expect(r.rarity).toBe("legendary"); seen.add("wand"); }
      if (r.entry.uuid === "sword") expect(r.rarity).toBe("common");
    }
    expect(seen.has("wand")).toBe(true);
  });

  it("oddsTable and shopOdds show a rarity only the override brings in", () => {
    expect(oddsTable(BOX, pools).map(o => o.rarity)).toEqual(["common", "legendary"]);
    const shop = shopOdds(BOX, pools);
    expect(shop.top).toBe("legendary");
    expect(shop.rows.map(r => r.label)).toEqual(["98%", "2%"]);
    const plain = { p: { ...pools.p, entries: [entry("sword", "common"), entry("wand", "common")] } };
    expect(shopOdds(BOX, plain).top).toBe("common");
  });

  it("falls back to the stored rarity for older entries and ignores a bad override", () => {
    expect(effectiveRarity({ rarity: "rare" })).toBe("rare");
    expect(effectiveRarity({ rarity: "rare", rarityOverride: "mythic" })).toBe("rare");
    expect(effectiveRarity({ sourceRarity: "", rarity: "common" })).toBe("common");
    expect(effectiveRarity({ sourceRarity: "very rare", rarity: "veryRare", rarityOverride: "uncommon" })).toBe("uncommon");
  });

  it("sourceStatus doesn't call an overridden entry renamed", () => {
    const e = entry("wand", "rare", { name: "Wand", rarityOverride: "legendary" });
    expect(sourceStatus(e, { name: "Wand", rarity: "rare" })).toBe("ok");
    // The source itself changing is still drift.
    expect(sourceStatus(e, { name: "Wand", rarity: "veryRare" })).toBe("renamed");
    // An older entry with no sourceRarity compares its stored rarity.
    expect(sourceStatus({ name: "Wand", rarity: "rare", rarityOverride: "legendary" }, { name: "Wand", rarity: "rare" })).toBe("ok");
    // A blank source rarity matches an entry whose source had none.
    expect(sourceStatus(entry("x", "", { name: "X", rarity: "common" }), { name: "X", rarity: "common" })).toBe("ok");
  });
});

describe("weight 0", () => {
  const pools = { p: { id: "p", entries: [entry("a", "common"), entry("b", "common", { weight: 0 }), entry("c", "rare", { weight: 0 })], pools: [] } };

  it("is never drawn, and a rarity held only at weight 0 leaves the odds", () => {
    for (let seed = 1; seed < 300; seed++) expect(draw({ box: BOX, pools, rng: seededRng(seed) }).entry.uuid).toBe("a");
    expect(oddsTable(BOX, pools).map(o => o.rarity)).toEqual(["common"]);
    expect(shopOdds(BOX, pools).top).toBe("common");
  });

  it("is never a strip filler or the near-miss tease", () => {
    expect(fillerSource(BOX, pools).rarities).toEqual(["common"]);
    for (let seed = 1; seed < 50; seed++) {
      const rng = seededRng(seed);
      const result = draw({ box: BOX, pools, rng });
      const { cards } = buildStrip({ result, box: BOX, pools, rng });
      expect(cards.every(c => c.uuid === "a")).toBe(true);
    }
  });

  it("a pool of only weight-0 entries gives nothing rather than throwing", () => {
    const none = { p: { id: "p", entries: [entry("b", "common", { weight: 0 })], pools: [] } };
    expect(draw({ box: BOX, pools: none, rng: seededRng(1) })).toBeNull();
  });

  it("the sweep still sees weight-0 entries", () => {
    expect(flattenPool("p", pools, new Set(), { includeMissing: true }).map(e => e.uuid)).toEqual(["a", "b", "c"]);
  });

  it("entryWeight is a whole number, 0 or more, 1 when unset", () => {
    expect([undefined, null, 3, 2.7, -4, "5", "x", 0].map(w => entryWeight({ weight: w }))).toEqual([1, 1, 3, 2, 0, 5, 0, 0]);
  });
});

describe("curateEntries", () => {
  const list = [entry("a", "rare"), entry("blank", "", { rarity: "common" }), { uuid: "old", name: "Old", rarity: "common", weight: 2 }];

  it("sets and clears an override, and picking the source's own rarity clears it", () => {
    const set = curateEntries(list, ["a"], { rarityOverride: "legendary" });
    expect(set[0].rarityOverride).toBe("legendary");
    expect(set[1]).toBe(list[1]);
    expect(curateEntries(set, ["a"], { rarityOverride: null })[0]).not.toHaveProperty("rarityOverride");
    expect(curateEntries(set, ["a"], { rarityOverride: "rare" })[0]).not.toHaveProperty("rarityOverride");
    expect(curateEntries(set, ["a"], { rarityOverride: "mythic" })[0]).not.toHaveProperty("rarityOverride");
  });

  it("keeps Common as a real choice when the source has no rarity", () => {
    expect(rarityUnset(list[1])).toBe(true);
    const out = curateEntries(list, ["blank"], { rarityOverride: "common" })[1];
    expect(out.rarityOverride).toBe("common");
    expect(rarityUnset(out)).toBe(false);
  });

  it("clamps weight and teaches an older entry its source rarity", () => {
    const out = curateEntries(list, ["a", "old"], { weight: -3, sourceRarity: "" });
    expect(out[0]).toMatchObject({ weight: 0, sourceRarity: "rare" });
    expect(out[2]).toMatchObject({ weight: 0, sourceRarity: "" });
    expect(curateEntries(list, ["a"], { weight: 3.9 })[0].weight).toBe(3);
  });
});

describe("entryFromItem", () => {
  it("keeps the source's rarity as given, '' when it has none", () => {
    expect(entryFromItem({ uuid: "Item.ls", name: "Longsword", img: "", system: { rarity: "" } })).toMatchObject({ rarity: "common", sourceRarity: "" });
    expect(entryFromItem({ uuid: "Item.w", name: "Wand", img: "", system: {} })).toMatchObject({ rarity: "common", sourceRarity: "" });
    expect(entryFromItem({ uuid: "Item.r", name: "Ring", img: "", system: { rarity: "veryRare" } })).toMatchObject({ rarity: "veryRare", sourceRarity: "veryRare" });
  });
});

describe("updatePool with an edit function", () => {
  let settings;
  beforeEach(() => {
    settings = new Map();
    vi.stubGlobal("foundry", { utils: { deepClone: v => structuredClone(v) } });
    vi.stubGlobal("game", { settings: {
      register: (_m, key, cfg) => settings.set(key, cfg.default),
      get: (_m, key) => settings.get(key),
      set: async (_m, key, v) => { await new Promise(r => setTimeout(r, 5)); settings.set(key, structuredClone(v)); },
    } });
    registerSettings();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("applies a rarity edit to the pool as it is, keeping a sweep's flag", async () => {
    await savePool({ id: "p", name: "Pool", entries: [entry("a", "common"), entry("dead", "rare")] });
    const sweep = enqueueWrite(() => markMissing("p", ["dead"], true));
    const edit = updatePool("p", fresh => ({ ...fresh, entries: curateEntries(fresh.entries, ["a"], { rarityOverride: "legendary", weight: 3 }) }));
    await Promise.all([sweep, edit]);
    const [a, dead] = getPools().p.entries;
    expect(a).toMatchObject({ rarityOverride: "legendary", weight: 3, sourceRarity: "common" });
    expect(dead.missing).toBe(true);
  });
});

describe("curateEntries on an entry added before sourceRarity existed", () => {
  const old = { uuid: "a", name: "Rope", rarity: "common", weight: 1 };
  it("keeps Common when the same change learns the source has no rarity", () => {
    const [e] = curateEntries([old], ["a"], { sourceRarity: "", rarityOverride: "common" });
    expect(e.sourceRarity).toBe("");
    expect(e.rarityOverride).toBe("common");
    expect(rarityUnset(e)).toBe(false);
  });
  it("still clears an override equal to a real source rarity", () => {
    const [e] = curateEntries([{ ...old, rarity: "rare" }], ["a"], { sourceRarity: "rare", rarityOverride: "rare" });
    expect(e.rarityOverride).toBeUndefined();
  });
});
