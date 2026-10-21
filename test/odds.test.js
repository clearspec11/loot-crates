import { describe, it, expect } from "vitest";
import { draw, nextState, undoPull, resetsPity, oddsTable, shopOdds, chanceLabel, wholePercents, flattenPool, normalizeRarity, seededRng, weightedPick, markEntriesMissing, sourceStatus, withSources } from "../module/scripts/odds.js";
import { POOLS, BOX, BOXES } from "../harness/sample.js";

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

describe("shopOdds", () => {
  const byId = id => BOXES.find(b => b.id === id);
  it("drops rarities the box weighs at 0", () => {
    const { rows, top } = shopOdds(byId("common"), POOLS);
    expect(rows.map(r => r.rarity)).toEqual(["common", "uncommon"]);
    expect(rows.map(r => r.label)).toEqual(["85%", "15%"]);
    expect(top).toBe("uncommon");
  });
  it("tops Royal Vault at legendary with no common row", () => {
    const { rows, top } = shopOdds(byId("royal"), POOLS);
    expect(rows.map(r => r.rarity)).not.toContain("common");
    expect(rows.every(r => r.chance > 0 && r.label !== "0%")).toBe(true);
    expect(top).toBe("legendary");
  });
  it("shows equal chances summing to 1 when every rarity weighs 0, as draw() does", () => {
    const box = { pools: [{ id: "homebrew", share: 1 }], weights: { common: 0, uncommon: 0, rare: 0, veryRare: 0, legendary: 0 } };
    const { rows, top } = shopOdds(box, POOLS);
    expect(rows.map(r => r.rarity)).toEqual(["uncommon", "rare", "legendary"]);
    for (const r of rows) expect(r.chance).toBeCloseTo(1 / 3, 9);
    expect(rows.reduce((n, r) => n + r.chance, 0)).toBeCloseTo(1, 9);
    expect(top).toBe("legendary");
    const rng = seededRng(5);
    const got = new Set(Array.from({ length: 200 }, () => draw({ box, pools: POOLS, rng }).rarity));
    expect([...got].sort()).toEqual(["legendary", "rare", "uncommon"]);
  });
  it("labels a 0.4% row '<1%' rather than 0%", () => {
    const box = { pools: [{ id: "core", share: 1 }], weights: { common: 996, legendary: 4, uncommon: 0, rare: 0, veryRare: 0 } };
    const { rows } = shopOdds(box, POOLS);
    expect(rows.find(r => r.rarity === "legendary")).toMatchObject({ chance: 0.004, label: "<1%" });
    expect(rows.find(r => r.rarity === "common").label).toBe(">99%");
  });
  it("gives rows [] and top null for an empty box", () => {
    expect(shopOdds(byId("empty"), POOLS)).toEqual({ rows: [], top: null });
    expect(shopOdds({ pools: [] }, POOLS)).toEqual({ rows: [], top: null });
  });
  it("leaves out a rarity held only by missing entries", () => {
    const pools = { p: { id: "p", entries: [{ uuid: "a", rarity: "common" }, { uuid: "b", rarity: "legendary", missing: true }] } };
    expect(shopOdds({ pools: [{ id: "p" }] }, pools)).toMatchObject({ rows: [{ rarity: "common", label: "100%" }], top: "common" });
  });
  it("labels sum to 100 rather than 101", () => {
    const box = { pools: [{ id: "core", share: 1 }], weights: { uncommon: 50, rare: 30, common: 0, veryRare: 0, legendary: 0 } };
    expect(shopOdds(box, POOLS).rows.map(r => r.label)).toEqual(["63%", "37%"]);
    expect(wholePercents([1 / 3, 1 / 3, 1 / 3]).reduce((a, b) => a + b)).toBe(100);
  });
  it("chanceLabel rounds in between", () => {
    expect(chanceLabel(0.124)).toBe("12%");
    expect(chanceLabel(0.01)).toBe("1%");
    expect(chanceLabel(1)).toBe("100%");
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

/*
  A refund undoes the pull's record: the pity count and the no-duplicates
  list read as if the pull never happened. Rows are the pull log's, with
  `before.sinceRare` and `resetPity` as socket.js writes them.
*/
describe("undoPull", () => {
  const PITY = { rules: { pity: { after: 3, minRarity: "rare" }, noDuplicates: true } };
  // Pulls in order; returns the log (newest first) and the state after them.
  const pulls = (...picks) => {
    let state = {};
    const log = [];
    picks.forEach(([uuid, rarity], i) => {
      log.unshift({ id: `r${i}`, at: (i + 1) * 10, actorId: "a1", boxId: "b", uuid, rarity, before: { sinceRare: state.sinceRare ?? 0, hadItem: (state.owned ?? []).includes(uuid) }, resetPity: resetsPity(PITY, rarity) });
      state = nextState(PITY, state, { rarity, entry: { uuid } });
    });
    return { log, state, row: id => log.find(r => r.id === id) };
  };
  const refund = (w, id, at) => { const row = w.row(id); row.refunded = at; w.state = undoPull(w.state, row, w.log); return w.state; };

  it("puts the latest pull back: the item is new again and the pity count drops by one", () => {
    const w = pulls(["rope", "common"], ["torch", "common"]);
    expect(w.state).toEqual({ sinceRare: 2, owned: ["rope", "torch"], pulls: 2 });
    expect(refund(w, "r1", 100)).toEqual({ sinceRare: 1, owned: ["rope"], pulls: 1 });
  });

  it("gives back the pity a refunded rare wiped, and the rare can drop again", () => {
    // Orla's box: Cloak (rare), Rope, Torch; pity Rare after 3.
    const before = { sinceRare: 2, owned: [], pulls: 2 };
    const w = pulls(["rope", "common"], ["torch", "common"], ["cloak", "rare"]);
    w.log.find(r => r.id === "r0").refunded = 1; w.log.find(r => r.id === "r1").refunded = 2;
    w.state = { sinceRare: 0, owned: ["cloak"], pulls: 1 };
    // Only the Cloak pull stands; rope and torch were refunded before it.
    w.row("r2").before = { sinceRare: 2 };
    const box = { ...PITY, pools: [{ id: "p", share: 1 }] };
    const pools = { p: { id: "p", entries: [{ uuid: "cloak", rarity: "rare", weight: 1 }, { uuid: "rope", rarity: "common", weight: 1 }, { uuid: "torch", rarity: "common", weight: 1 }] } };
    expect(shopOdds(box, pools, w.state).rows.map(r => r.rarity)).toEqual(["common"]);
    const after = refund(w, "r2", 100);
    expect(after).toEqual({ ...before, owned: [], pulls: 0 });
    expect(shopOdds(box, pools, after).rows.map(r => r.rarity)).toEqual(["common", "rare"]);
  });

  it("an older pull with later ones after it: only its own effects come back", () => {
    const w = pulls(["rope", "common"], ["torch", "common"], ["lamp", "common"]);
    expect(refund(w, "r0", 100)).toEqual({ sinceRare: 2, owned: ["torch", "lamp"], pulls: 2 });
  });

  it("a pull before a standing rare leaves the pity count alone", () => {
    const w = pulls(["rope", "common"], ["cloak", "rare"], ["torch", "common"]);
    expect(w.state.sinceRare).toBe(1);
    expect(refund(w, "r0", 100)).toEqual({ sinceRare: 1, owned: ["cloak", "torch"], pulls: 2 });
  });

  it("a rare that reset pity, with no later reset: its wiped count comes back on top", () => {
    const w = pulls(["rope", "common"], ["torch", "common"], ["cloak", "rare"], ["lamp", "common"]);
    expect(w.state.sinceRare).toBe(1);
    expect(refund(w, "r2", 100)).toEqual({ sinceRare: 3, owned: ["rope", "torch", "lamp"], pulls: 3 });
  });

  it("a rare that reset pity, with a later rare still standing: the count stays", () => {
    const w = pulls(["rope", "common"], ["cloak", "rare"], ["lamp", "common"], ["wand", "rare"], ["torch", "common"]);
    expect(refund(w, "r1", 100)).toEqual({ sinceRare: 1, owned: ["rope", "lamp", "wand", "torch"], pulls: 4 });
  });

  it("a rare refunded after a later reset was itself refunded counts across both", () => {
    const w = pulls(["rope", "common"], ["cloak", "rare"], ["lamp", "common"], ["wand", "rare"], ["torch", "common"]);
    refund(w, "r3", 100);
    expect(w.state.sinceRare).toBe(2);
    expect(refund(w, "r1", 110)).toEqual({ sinceRare: 3, owned: ["rope", "lamp", "torch"], pulls: 3 });
  });

  it("an item granted twice stays owned after one refund, and goes after the second", () => {
    const w = pulls(["rope", "common"], ["rope", "common"]);
    expect(refund(w, "r1", 100).owned).toEqual(["rope"]);
    expect(refund(w, "r0", 110).owned).toEqual([]);
  });

  // Live in cc-dev: a pull of the Flail, then the state reset by hand (not
  // through a refund), then the Flail again. Refunding the second must free
  // it: it wasn't owned before that pull, whatever the older row says.
  it("frees an item the refunded pull granted fresh, though an older row granted it before a reset", () => {
    const w = pulls(["flail", "common"]);
    w.state = {};
    const again = { id: "r1", at: 20, actorId: "a1", boxId: "b", uuid: "flail", rarity: "common", before: { sinceRare: 0, hadItem: false }, resetPity: false };
    w.log.unshift(again);
    w.state = nextState(PITY, w.state, { rarity: "common", entry: { uuid: "flail" } });
    expect(refund(w, "r1", 100)).toEqual({ sinceRare: 0, owned: [], pulls: 0 });
  });

  it("a row from before refunds tracked pity fixes owned and pulls, and keeps the count", () => {
    const legacy = { id: "old", at: 10, actorId: "a1", boxId: "b", uuid: "cloak", rarity: "rare", refunded: 50 };
    const state = { sinceRare: 2, owned: ["cloak", "rope"], pulls: 3 };
    expect(undoPull(state, legacy, [legacy])).toEqual({ sinceRare: 2, owned: ["rope"], pulls: 2 });
  });

  it("only counts the same character's rows for the same box, and never goes below zero", () => {
    const row = { id: "x", at: 10, actorId: "a1", boxId: "b", uuid: "rope", before: { sinceRare: 0 }, resetPity: false };
    const others = [{ id: "y", at: 5, actorId: "a2", boxId: "b", uuid: "rope" }, { id: "z", at: 6, actorId: "a1", boxId: "c", uuid: "rope" }];
    expect(undoPull({}, row, [row, ...others])).toEqual({ owned: [], pulls: 0, sinceRare: 0 });
  });

  // Any mix of pulls and refunds, in any order, ends where a replay of only
  // the pulls still standing would.
  it("matches a replay of the unrefunded pulls after any order of refunds", () => {
    const rng = seededRng(42);
    const uuids = ["rope", "torch", "lamp", "cloak", "wand"];
    for (let run = 0; run < 200; run++) {
      let state = {}, t = 0;
      const log = [];
      for (let step = 0; step < 14; step++) {
        const standing = log.filter(r => !r.refunded);
        if (standing.length && rng() < 0.4) {
          const row = standing[Math.floor(rng() * standing.length)];
          row.refunded = ++t;
          state = undoPull(state, row, log);
        } else {
          const uuid = uuids[Math.floor(rng() * uuids.length)];
          const rarity = rng() < 0.3 ? "rare" : "common";
          log.unshift({ id: `r${run}-${step}`, at: ++t, actorId: "a1", boxId: "b", uuid, rarity, before: { sinceRare: state.sinceRare ?? 0, hadItem: (state.owned ?? []).includes(uuid) }, resetPity: resetsPity(PITY, rarity) });
          state = nextState(PITY, state, { rarity, entry: { uuid } });
        }
        const replay = log.filter(r => !r.refunded).reverse().reduce((s, r) => nextState(PITY, s, { rarity: r.rarity, entry: { uuid: r.uuid } }), {});
        expect({ ...state, owned: [...(state.owned ?? [])].sort() }).toEqual({ sinceRare: replay.sinceRare ?? 0, owned: [...(replay.owned ?? [])].sort(), pulls: replay.pulls ?? 0 });
      }
    }
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

/*
  The odds next to Buy are the roll's odds for this character: shopOdds with
  a buyer's state (owned items under noDuplicates, the pity count) matches
  what draw() actually gives that buyer.
*/
describe("shopOdds for a buyer's state", () => {
  const RULED = { ...BOX, rules: { pity: { after: 3, minRarity: "rare" }, noDuplicates: true, stock: null } };
  const ALL = [...flattenPool("core", POOLS), ...flattenPool("homebrew", POOLS)].map(e => e.uuid);
  const freq = (box, state, n = 5000, seed = 1) => {
    const rng = seededRng(seed);
    const counts = tally(n, () => draw({ box, pools: POOLS, rng, state })?.rarity ?? "none");
    return Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v / n]));
  };
  const matches = (box, state, seed) => {
    const odds = shopOdds(box, POOLS, state);
    const seen = freq(box, state, 5000, seed);
    expect(Object.keys(seen).sort(), JSON.stringify(state)).toEqual(odds.rows.map(r => r.rarity).sort());
    for (const row of odds.rows) expect(Math.abs(row.chance - seen[row.rarity]), `${row.rarity} ${JSON.stringify(state)}`).toBeLessThanOrEqual(0.02);
  };

  it("matches draw() within 2 points over 5000 seeded draws, for random owned sets and pity counts", () => {
    const pick = seededRng(42);
    for (let i = 0; i < 12; i++) {
      // Leave at least one item unowned; the owns-everything case is below.
      const owned = ALL.filter(() => pick() < 0.6).slice(0, ALL.length - 1);
      const sinceRare = Math.floor(pick() * 5);
      matches(RULED, { owned, sinceRare }, 100 + i);
    }
  });

  it("drops what this character owns: owning every Rare and better leaves only the lower odds", () => {
    const owned = [...flattenPool("core", POOLS), ...flattenPool("homebrew", POOLS)].filter(e => ["rare", "veryRare", "legendary"].includes(e.rarity)).map(e => e.uuid);
    const odds = shopOdds(RULED, POOLS, { owned });
    expect(odds.rows.map(r => r.rarity)).toEqual(["common", "uncommon"]);
    expect(odds.rows.map(r => r.label)).toEqual(["66%", "34%"]);
    matches(RULED, { owned }, 7);
    // Without noDuplicates, owning things changes nothing.
    expect(shopOdds({ ...RULED, rules: {} }, POOLS, { owned }).rows).toEqual(shopOdds({ ...RULED, rules: {} }, POOLS).rows);
  });

  it("shows only the guaranteed rarities once pity is due, and says so", () => {
    const odds = shopOdds(RULED, POOLS, { sinceRare: 3 });
    expect(odds.rows.map(r => r.rarity)).toEqual(["rare", "veryRare", "legendary"]);
    expect(odds.pity).toEqual({ due: true, left: 1, minRarity: "rare" });
    matches(RULED, { sinceRare: 3 }, 3);
    expect(freq(RULED, { sinceRare: 3 }).common).toBeUndefined();
  });

  it("counts down the pulls to the guaranteed one", () => {
    expect(shopOdds(RULED, POOLS).pity).toEqual({ due: false, left: 4, minRarity: "rare" });
    expect(shopOdds(RULED, POOLS, { sinceRare: 2 }).pity).toEqual({ due: false, left: 2, minRarity: "rare" });
    expect(shopOdds({ ...RULED, rules: {} }, POOLS)).not.toHaveProperty("pity");
  });

  it("promises no floor the buyer can't reach", () => {
    const box = { pools: [{ id: "homebrew", share: 1 }], weights: { uncommon: 1, rare: 1, legendary: 1 }, rules: { pity: { after: 1, minRarity: "artifact" } } };
    expect(shopOdds(box, POOLS, { sinceRare: 1 })).not.toHaveProperty("pity");
    // draw() falls back to the best rarity left, and the odds say the same.
    expect(shopOdds(box, POOLS, { sinceRare: 1 }).rows.map(r => r.label)).toEqual(["100%"]);
    matches(box, { sinceRare: 1 }, 5);
  });

  it("says nothing new is left when this character owns everything, and draw() agrees", () => {
    const odds = shopOdds(RULED, POOLS, { owned: ALL, sinceRare: 3 });
    expect(odds).toEqual({ rows: [], top: null, nothingNew: true });
    expect(freq(RULED, { owned: ALL })).toEqual({ none: 1 });
    // An empty box is empty, not "nothing new".
    expect(shopOdds({ ...RULED, pools: [] }, POOLS, { owned: ALL })).toEqual({ rows: [], top: null });
  });

  it("is the plain shop odds for a buyer with no history", () => {
    for (const box of BOXES) expect(shopOdds(box, POOLS, {}).rows).toEqual(shopOdds(box, POOLS).rows);
  });
});
