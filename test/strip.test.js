import { describe, it, expect } from "vitest";
import { buildStrip, STRIP_LENGTH, LAND_INDEX, fillerSource } from "../module/scripts/strip.js";
import { draw, seededRng, rarityRank, flattenPool } from "../module/scripts/odds.js";
import { POOLS, BOX } from "../harness/sample.js";

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
