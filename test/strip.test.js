import { describe, it, expect } from "vitest";
import { buildStrip, STRIP_LENGTH, LAND_INDEX, fillerSource } from "../module/scripts/core/strip.js";
import { draw, seededRng, rarityRank, flattenPool } from "../module/scripts/core/odds.js";
import { POOLS, BOX, BOXES } from "../harness/sample.js";

describe("buildStrip", () => {
  it("puts the rolled result at the landing index and fills the rest from the pools", () => {
    const rng = seededRng(21);
    const result = draw({ box: BOX, pools: POOLS, rng });
    const strip = buildStrip({ result, box: BOX, pools: POOLS, rng });
    expect(strip.cards).toHaveLength(STRIP_LENGTH);
    expect(strip.landIndex).toBe(LAND_INDEX);
    const land = strip.cards[LAND_INDEX];
    expect(land.uuid).toBe(result.entry.uuid);
    expect(land.rarity).toBe(result.rarity);
    expect(land.result).toBe(true);
    const uuids = new Set(flattenPool("core", POOLS).concat(flattenPool("homebrew", POOLS)).map(e => e.uuid));
    for (const c of strip.cards) expect(uuids.has(c.uuid)).toBe(true);
    expect(strip.cards.filter(c => c.result)).toHaveLength(1);
  });

  it("near-miss places a better card right after the result, when one exists", () => {
    let seen = false;
    for (let seed = 1; seed < 40 && !seen; seed++) {
      const rng = seededRng(seed);
      const result = draw({ box: BOX, pools: POOLS, rng, state: {} });
      if (result.rarity === "legendary") continue;
      const strip = buildStrip({ result, box: BOX, pools: POOLS, rng });
      if (strip.nearMiss) {
        seen = true;
        expect(rarityRank(strip.cards[LAND_INDEX + 1].rarity)).toBeGreaterThan(rarityRank(result.rarity));
      }
    }
    expect(seen).toBe(true);
  });

  it("never near-misses when the result is already the best the box holds", () => {
    const rng = seededRng(3);
    const result = { entry: { uuid: "sample.holy-avenger", name: "Holy Avenger", img: "", rarity: "legendary" }, rarity: "legendary" };
    for (let i = 0; i < 20; i++) expect(buildStrip({ result, box: BOX, pools: POOLS, rng }).nearMiss).toBe(false);
  });

  it("can be built without the near-miss beat", () => {
    const rng = seededRng(5);
    const result = draw({ box: BOX, pools: POOLS, rng });
    expect(buildStrip({ result, box: BOX, pools: POOLS, rng, nearMiss: false }).nearMiss).toBe(false);
  });

  it("fillers follow the box's rarity odds", () => {
    const rng = seededRng(77);
    const src = fillerSource(BOX, POOLS);
    expect(src.rarities).toEqual(["common", "uncommon", "rare", "veryRare", "legendary"]);
    const result = draw({ box: BOX, pools: POOLS, rng });
    const counts = {};
    for (let i = 0; i < 200; i++) for (const c of buildStrip({ result, box: BOX, pools: POOLS, rng, nearMiss: false }).cards) counts[c.rarity] = (counts[c.rarity] ?? 0) + 1;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(counts.common / total).toBeCloseTo(0.55, 1);
  });
});

describe("buildStrip with missing entries", () => {
  const entry = (uuid, rarity, extra = {}) => ({ uuid, name: uuid, img: "", rarity, weight: 1, ...extra });
  const pools = {
    p: { id: "p", name: "P", pools: [], entries: [entry("c1", "common"), entry("c2", "common"), entry("u1", "uncommon"), entry("r1", "rare", { missing: true }), entry("l1", "legendary", { missing: true })] },
  };
  const box = { id: "b", name: "B", price: 1, pools: [{ id: "p", share: 1 }], weights: { common: 60, uncommon: 20, rare: 15, legendary: 5 }, rules: {} };

  it("never shows a missing entry as a filler or as the near-miss tease, across 200 seeds", () => {
    let teases = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const rng = seededRng(seed);
      const result = draw({ box, pools, rng });
      const strip = buildStrip({ result, box, pools, rng });
      for (const c of strip.cards) expect(["c1", "c2", "u1"]).toContain(c.uuid);
      if (strip.nearMiss) {
        teases++;
        expect(strip.cards[LAND_INDEX + 1].uuid).toBe("u1");
      }
    }
    // The tease still happens, one rank up from a common, from a live entry.
    expect(teases).toBeGreaterThan(0);
  });

  it("fillerSource offers no rarity whose only entries are missing", () => {
    expect(fillerSource(box, pools).rarities).toEqual(["common", "uncommon"]);
  });
});

describe("the near-miss tease is one droppable rank up", () => {
  const PAUPER = BOXES.find(b => b.id === "common");
  const entryOf = rarity => flattenPool("core", POOLS).find(e => e.rarity === rarity);
  const fixed = (rarity, extra = {}) => ({ entry: entryOf(rarity), rarity, ...extra });

  it("never teases a rarity the box weighs at 0, over 2000 seeded strips", () => {
    expect(PAUPER.weights).toMatchObject({ common: 85, uncommon: 15, rare: 0, veryRare: 0, legendary: 0 });
    expect(flattenPool("core", POOLS).some(e => e.rarity === "legendary")).toBe(true);
    let teases = 0;
    for (let seed = 1; seed <= 2000; seed++) {
      const rng = seededRng(seed);
      const result = draw({ box: PAUPER, pools: POOLS, rng, state: {} });
      const strip = buildStrip({ result, box: PAUPER, pools: POOLS, rng });
      if (!strip.nearMiss) continue;
      teases++;
      expect(result.rarity).toBe("common");
      expect(strip.cards[LAND_INDEX + 1].rarity).toBe("uncommon");
    }
    expect(teases).toBeGreaterThan(0);
  });

  it("teases an uncommon result with a rare most of the time, sometimes two up, never the jackpot or lower", () => {
    const counts = {};
    let teases = 0;
    for (let seed = 1; seed <= 2000; seed++) {
      const rng = seededRng(seed);
      const strip = buildStrip({ result: fixed("uncommon"), box: BOX, pools: POOLS, rng });
      if (!strip.nearMiss) continue;
      teases++;
      const r = strip.cards[LAND_INDEX + 1].rarity;
      counts[r] = (counts[r] ?? 0) + 1;
      expect(rarityRank(r)).toBeGreaterThan(rarityRank("uncommon"));
    }
    expect(counts.rare / teases).toBeGreaterThanOrEqual(0.7);
    expect(counts.veryRare).toBeGreaterThan(0);
    expect(counts.legendary).toBeUndefined();
    // The tease rate is unchanged at 0.6.
    expect(teases / 2000).toBeCloseTo(0.6, 1);
  });

  it("gives no near-miss on a result at the box's best droppable rarity", () => {
    for (let seed = 1; seed <= 200; seed++) {
      expect(buildStrip({ result: fixed("uncommon"), box: PAUPER, pools: POOLS, rng: seededRng(seed) }).nearMiss).toBe(false);
    }
  });

  it("gives no near-miss on a box that drops one rarity", () => {
    const box = { ...BOX, id: "single", weights: { common: 0, uncommon: 0, rare: 1, veryRare: 0, legendary: 0 } };
    for (let seed = 1; seed <= 200; seed++) {
      expect(buildStrip({ result: fixed("rare"), box, pools: POOLS, rng: seededRng(seed) }).nearMiss).toBe(false);
      expect(buildStrip({ result: fixed("common"), box, pools: POOLS, rng: seededRng(seed) }).nearMiss).toBe(false);
    }
  });

  it("gives no near-miss on a pity result", () => {
    for (let seed = 1; seed <= 200; seed++) {
      expect(buildStrip({ result: fixed("rare", { pity: true }), box: BOX, pools: POOLS, rng: seededRng(seed) }).nearMiss).toBe(false);
    }
  });
});

/*
  The shop shows each buyer their own odds (owned items out under
  noDuplicates), so the tease must be one of those too: a spin that teases
  a rarity the shop just told this character they can't get, or an item
  they already own, isn't a near miss.
*/
describe("the near-miss tease follows the buyer's own odds", () => {
  const entry = (uuid, rarity) => ({ uuid, name: uuid, img: "", rarity, weight: 1 });
  const pools = { p: { id: "p", name: "P", pools: [], entries: [entry("c1", "common"), entry("c2", "common"), entry("u1", "uncommon"), entry("u2", "uncommon"), entry("r1", "rare")] } };
  const box = { id: "b", name: "B", price: 1, pools: [{ id: "p", share: 1 }], weights: { common: 50, uncommon: 30, rare: 20 }, rules: { noDuplicates: true } };

  it("never teases a rarity or an item this buyer owns, across 300 seeds", () => {
    const state = { owned: ["r1", "u1"], sinceRare: 0 };
    let teases = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const rng = seededRng(seed);
      const result = draw({ box, pools, rng, state });
      if (result.rarity !== "common") continue;
      const strip = buildStrip({ result, box, pools, rng, state });
      if (!strip.nearMiss) continue;
      teases++;
      expect(strip.cards[LAND_INDEX + 1].uuid).toBe("u2");
    }
    expect(teases).toBeGreaterThan(0);
  });
});
