import { describe, it, expect } from "vitest";
import { draw, nextState, oddsTable, flattenPool, normalizeRarity, seededRng, weightedPick, markEntriesMissing, sourceStatus, withSources } from "../module/scripts/odds.js";
import { POOLS, BOX } from "../harness/sample.js";

const tally = (n, fn) => {
  const out = {};
  for (let i = 0; i < n; i++) { const k = fn(i); out[k] = (out[k] ?? 0) + 1; }
  return out;
};

describe("normalizeRarity", () => {
  it("maps dnd5e keys and loose spellings", () => {
    expect(normalizeRarity("veryRare")).toBe("veryRare");
    expect(normalizeRarity("Very Rare")).toBe("veryRare");
    expect(normalizeRarity("")).toBe("common");
    expect(normalizeRarity(undefined)).toBe("common");
    expect(normalizeRarity("LEGENDARY")).toBe("legendary");
  });
});

describe("weightedPick", () => {
  it("never picks a zero-weight item and returns null when all are zero", () => {
    const rng = seededRng(3);
    for (let i = 0; i < 200; i++) expect(weightedPick(["a", "b"], x => (x === "a" ? 0 : 1), rng)).toBe("b");
    expect(weightedPick(["a"], () => 0, rng)).toBeNull();
  });
});

describe("flattenPool", () => {
  it("follows nested pools and survives a cycle", () => {
    const pools = {
      a: { id: "a", entries: [{ uuid: "1", rarity: "rare" }], pools: ["b"] },
      b: { id: "b", entries: [{ uuid: "2", rarity: "common" }], pools: ["a"] },
    };
    const out = flattenPool("a", pools);
    expect(out.map(e => e.uuid).sort()).toEqual(["1", "2"]);
    expect(out.find(e => e.uuid === "2").poolId).toBe("b");
  });
});

describe("oddsTable", () => {
  it("shows only rarities the pools hold, normalised to 1", () => {
    const rows = oddsTable(BOX, POOLS);
    expect(rows.map(r => r.rarity)).toEqual(["common", "uncommon", "rare", "veryRare", "legendary"]);
    expect(rows.reduce((n, r) => n + r.chance, 0)).toBeCloseTo(1, 9);
    expect(rows[0].chance).toBeCloseTo(0.55, 9);
  });
  it("drops a rarity no pool holds even if weighted", () => {
    const box = { pools: [{ id: "homebrew", share: 1 }], weights: { common: 50, rare: 50, legendary: 50 } };
    expect(oddsTable(box, POOLS).map(r => r.rarity)).toEqual(["uncommon", "rare", "legendary"]);
  });
});

describe("draw", () => {
  it("lands on rarities at the box's odds, whatever the pool sizes", () => {
    const rng = seededRng(42);
    const n = 20000;
    const counts = tally(n, () => draw({ box: BOX, pools: POOLS, rng }).rarity);
    expect(counts.common / n).toBeCloseTo(0.55, 1);
    expect(counts.uncommon / n).toBeCloseTo(0.28, 1);
    expect(counts.rare / n).toBeCloseTo(0.12, 1);
    expect(counts.legendary / n).toBeGreaterThan(0.004);
    expect(counts.legendary / n).toBeLessThan(0.02);
  });

  it("splits a rarity between pools by share", () => {
    const rng = seededRng(5);
    const box = { pools: [{ id: "core", share: 1 }, { id: "homebrew", share: 1 }], weights: { common: 0, uncommon: 0, rare: 1, veryRare: 0, legendary: 0 } };
    const counts = tally(4000, () => draw({ box, pools: POOLS, rng }).poolId);
    expect(counts.homebrew / 4000).toBeCloseTo(0.5, 1);
  });

  it("returns only entries the box can actually give", () => {
    const rng = seededRng(9);
    const uuids = new Set(flattenPool("core", POOLS).concat(flattenPool("homebrew", POOLS)).map(e => e.uuid));
    for (let i = 0; i < 500; i++) expect(uuids.has(draw({ box: BOX, pools: POOLS, rng }).entry.uuid)).toBe(true);
  });

  it("applies pity once the counter is reached", () => {
    const rng = seededRng(1);
    const box = { ...BOX, rules: { pity: { after: 5, minRarity: "rare" } } };
    for (let i = 0; i < 300; i++) {
      const r = draw({ box, pools: POOLS, rng, state: { sinceRare: 5 } });
      expect(["rare", "veryRare", "legendary"]).toContain(r.rarity);
      expect(r.pity).toBe(true);
    }
    const before = draw({ box, pools: POOLS, rng, state: { sinceRare: 4 } });
    expect(before.pity).toBe(false);
  });

  it("pity falls back to the best rarity a box holds", () => {
    const rng = seededRng(2);
    const box = { pools: [{ id: "homebrew", share: 1 }], weights: { uncommon: 1, rare: 1, legendary: 1 }, rules: { pity: { after: 1, minRarity: "artifact" } } };
    const r = draw({ box, pools: POOLS, rng, state: { sinceRare: 1 } });
    expect(r.rarity).toBe("legendary");
  });

  it("skips owned items under noDuplicates and gives up when nothing is left", () => {
    const rng = seededRng(4);
    const box = { pools: [{ id: "homebrew", share: 1 }], weights: { uncommon: 1, rare: 1, legendary: 1 }, rules: { noDuplicates: true } };
    const all = flattenPool("homebrew", POOLS).map(e => e.uuid);
    const owned = all.slice(0, 2);
    for (let i = 0; i < 50; i++) expect(draw({ box, pools: POOLS, rng, state: { owned } }).entry.uuid).toBe(all[2]);
    expect(draw({ box, pools: POOLS, rng, state: { owned: all } })).toBeNull();
  });

  it("returns null for a box with no pools", () => {
    expect(draw({ box: { pools: [] }, pools: POOLS })).toBeNull();
  });

  it("treats all-zero weights as equal odds rather than giving nothing", () => {
    const rng = seededRng(8);
    const box = { pools: [{ id: "homebrew", share: 1 }], weights: { common: 0, uncommon: 0, rare: 0, veryRare: 0, legendary: 0, artifact: 0 } };
    const counts = tally(600, () => draw({ box, pools: POOLS, rng }).rarity);
    expect(Object.keys(counts).sort()).toEqual(["legendary", "rare", "uncommon"]);
  });
});

describe("nextState", () => {
  it("counts pulls since the pity floor and remembers what was owned", () => {
    const box = { rules: { pity: { after: 3, minRarity: "rare" } } };
    const s1 = nextState(box, {}, { rarity: "common", entry: { uuid: "a" } });
    expect(s1).toEqual({ sinceRare: 1, owned: ["a"], pulls: 1 });
    const s2 = nextState(box, s1, { rarity: "veryRare", entry: { uuid: "b" } });
    expect(s2.sinceRare).toBe(0);
    expect(s2.owned).toEqual(["a", "b"]);
    const s3 = nextState(box, s2, { rarity: "common", entry: { uuid: "a" } });
    expect(s3.owned).toEqual(["a", "b"]);
  });
});

describe("seededRng", () => {
  it("is deterministic and in [0, 1)", () => {
    const a = seededRng(11), b = seededRng(11);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe("entries whose source is gone", () => {
  const entry = (uuid, rarity, extra = {}) => ({ uuid, name: uuid, img: "", rarity, weight: 1, ...extra });
  const pools = {
    live: { id: "live", name: "Live", pools: ["child"], entries: [entry("c1", "common"), entry("c2", "common"), entry("r1", "rare", { missing: true })] },
    child: { id: "child", name: "Child", pools: [], entries: [entry("l1", "legendary", { missing: true }), entry("u1", "uncommon")] },
  };
  const box = { id: "b", name: "B", price: 1, pools: [{ id: "live", share: 1 }], weights: { common: 60, uncommon: 0, rare: 30, legendary: 10 }, rules: {} };

  it("flattenPool leaves them out, nested pools included, unless asked", () => {
    expect(flattenPool("live", pools).map(e => e.uuid)).toEqual(["c1", "c2", "u1"]);
    expect(flattenPool("live", pools, new Set(), { includeMissing: true }).map(e => e.uuid)).toEqual(["c1", "c2", "r1", "l1", "u1"]);
  });

  it("oddsTable shows no row for a rarity whose only entries are missing", () => {
    const odds = oddsTable(box, pools);
    expect(odds.map(o => o.rarity)).toEqual(["common", "uncommon"]);
    expect(odds.find(o => o.rarity === "legendary")).toBeUndefined();
    expect(odds.reduce((n, o) => n + o.chance, 0)).toBeCloseTo(1, 6);
  });

  it("draw never lands on one, across 2000 seeds", () => {
    const rng = seededRng(13);
    for (let i = 0; i < 2000; i++) {
      const r = draw({ box, pools, rng });
      expect(["c1", "c2", "u1"]).toContain(r.entry.uuid);
    }
  });

  it("draw gives nothing when every entry is missing", () => {
    const dead = { p: { id: "p", name: "P", pools: [], entries: [entry("x", "rare", { missing: true })] } };
    expect(draw({ box: { ...box, pools: [{ id: "p", share: 1 }] }, pools: dead, rng: seededRng(1) })).toBeNull();
  });

  it("markEntriesMissing sets and clears the flag on one pool without touching the input", () => {
    const marked = markEntriesMissing(pools, "live", ["c1"], true);
    expect(marked.live.entries[0].missing).toBe(true);
    expect(pools.live.entries[0].missing).toBeUndefined();
    expect(marked.child).toBe(pools.child);
    const cleared = markEntriesMissing(marked, "live", ["c1", "r1"], false);
    expect(cleared.live.entries.some(e => "missing" in e)).toBe(false);
  });
});

describe("checking entries against their sources", () => {
  const entry = (uuid, rarity, extra = {}) => ({ uuid, name: uuid, img: "", rarity, weight: 1, ...extra });

  it("sourceStatus tells ok, missing and renamed apart", () => {
    const e = { uuid: "w", name: "Wand of Sparks", rarity: "rare" };
    expect(sourceStatus(e, { name: "Wand of Sparks", rarity: "rare" })).toBe("ok");
    expect(sourceStatus(e, { name: "Wand of Sparks", rarity: "Rare" })).toBe("ok");
    expect(sourceStatus(e, null)).toBe("missing");
    expect(sourceStatus(e, undefined)).toBe("missing");
    expect(sourceStatus(e, { name: "Wand of Sparking", rarity: "rare" })).toBe("renamed");
    expect(sourceStatus(e, { name: "Wand of Sparks", rarity: "veryRare" })).toBe("renamed");
    // A pack index row without a rarity says nothing about it.
    expect(sourceStatus(e, { name: "Wand of Sparks", rarity: null })).toBe("ok");
  });

  const pools = {
    p: { id: "p", name: "P", pools: [], entries: [entry("c1", "common"), entry("r1", "rare"), entry("dead-l", "legendary"), entry("back", "uncommon", { missing: true })] },
  };
  const box = { id: "b", name: "B", price: 1, pools: [{ id: "p", share: 1 }], weights: { common: 40, uncommon: 10, rare: 10, legendary: 40 }, rules: {} };
  const sources = new Map([["c1", { name: "c1" }], ["r1", { name: "r1" }], ["dead-l", null], ["back", { name: "back" }]]);

  it("withSources flags what is gone now and clears what came back, without touching the input", () => {
    const view = withSources(pools, sources);
    expect(view.p.entries.find(e => e.uuid === "dead-l").missing).toBe(true);
    expect("missing" in view.p.entries.find(e => e.uuid === "back")).toBe(false);
    expect(pools.p.entries.find(e => e.uuid === "dead-l").missing).toBeUndefined();
    expect(withSources(pools, new Map()).p.entries.find(e => e.uuid === "back").missing).toBe(true);
  });

  it("oddsTable omits a rarity held only by a dead entry", () => {
    expect(oddsTable(box, pools).map(o => o.rarity)).toContain("legendary");
    const odds = oddsTable(box, withSources(pools, sources));
    expect(odds.map(o => o.rarity)).toEqual(["common", "uncommon", "rare"]);
    expect(odds.reduce((n, o) => n + o.chance, 0)).toBeCloseTo(1, 6);
  });

  it("draw never returns a dead entry over 1000 seeded draws", () => {
    const view = withSources(pools, sources);
    const rng = seededRng(77);
    const got = tally(1000, () => draw({ box, pools: view, rng }).entry.uuid);
    expect(got["dead-l"]).toBeUndefined();
    expect(Object.keys(got).sort()).toEqual(["back", "c1", "r1"]);
  });
});
