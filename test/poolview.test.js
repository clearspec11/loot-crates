/*
  The pool editor as a craft table: rows annotated once, problems first, a
  case-insensitive name search, census chips whose counts are what they
  show, 50 rows at a time, and markup that draws no more than a page.
*/
import { describe, it, expect } from "vitest";
import { PAGE_ROWS, OPEN_UP_TO, defaultView, poolRows, sortRows, filterRows, pageRows, nextRows, chipList, matchesChip, poolCount, poolBody, poolSummary } from "../module/scripts/poolview.js";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const entry = (uuid, name, rarity, extra = {}) => ({ uuid, name, img: "", rarity, sourceRarity: rarity, weight: 1, ...extra });
// What the source check found: same name and rarity unless told otherwise.
const srcOf = overrides => e => (e.uuid in overrides ? overrides[e.uuid] : { name: e.name, img: "", rarity: e.sourceRarity || null, rawRarity: e.sourceRarity ?? null });

const POOL = {
  id: "p", name: "Big pool",
  entries: [
    entry("a", "Wand of Magic Detection", "uncommon"),
    entry("b", "Longsword", "", { rarity: "common" }), // source has no rarity
    entry("c", "WAND OF WEB", "uncommon", { rarityOverride: "rare" }),
    entry("d", "Ghost Blade", "legendary"), // source gone
    entry("e", "Potion of Healing", "common", { weight: 0 }),
    entry("f", "Old Shield", "uncommon"), // renamed at the source
    entry("g", "Club", "", { rarity: "common" }),
  ],
};
const ROWS = poolRows(POOL, srcOf({ d: null, f: { name: "Shield +1", img: "", rarity: "uncommon", rawRarity: "uncommon" } }));
const uuids = rows => rows.map(r => r.e.uuid);

describe("poolRows and sortRows", () => {
  it("annotate status, shown name, drawn rarity, unset and never", () => {
    const by = Object.fromEntries(ROWS.map(r => [r.e.uuid, r]));
    expect(by.d.status).toBe("missing");
    expect(by.f).toMatchObject({ status: "renamed", name: "Shield +1" });
    expect(by.c.rarity).toBe("rare");
    expect(by.b.unset).toBe(true);
    expect(by.e.never).toBe(true);
    expect(by.d.unset || by.d.never).toBe(false); // a missing row is only missing
  });

  it("put missing, then renamed, then no rarity set first, keeping pool order", () => {
    expect(uuids(sortRows(ROWS))).toEqual(["d", "f", "b", "g", "a", "c", "e"]);
  });
});

describe("filterRows", () => {
  it("searches names ignoring case, and trims the query", () => {
    expect(uuids(filterRows(ROWS, { q: "wand" }))).toEqual(["a", "c"]);
    expect(uuids(filterRows(ROWS, { q: "  WaNd " }))).toEqual(["a", "c"]);
  });

  it("finds a renamed row by its new or its old name", () => {
    expect(uuids(filterRows(ROWS, { q: "shield +1" }))).toEqual(["f"]);
    expect(uuids(filterRows(ROWS, { q: "old shield" }))).toEqual(["f"]);
  });

  it("'No rarity set' returns only unset rows", () => {
    const got = filterRows(ROWS, { chip: "unset" });
    expect(uuids(got)).toEqual(["b", "g"]);
    expect(got.every(r => r.unset)).toBe(true);
  });

  it("'Missing', 'Renamed' and 'Never drops' return only those rows", () => {
    expect(uuids(filterRows(ROWS, { chip: "missing" }))).toEqual(["d"]);
    expect(uuids(filterRows(ROWS, { chip: "renamed" }))).toEqual(["f"]);
    expect(uuids(filterRows(ROWS, { chip: "never" }))).toEqual(["e"]);
  });

  it("a rarity chip returns what the box can draw at that rarity", () => {
    // c is drawn at its override; d (missing) and e (weight 0) are never drawn.
    expect(uuids(filterRows(ROWS, { chip: "rare" }))).toEqual(["c"]);
    expect(uuids(filterRows(ROWS, { chip: "uncommon" }))).toEqual(["a", "f"]);
    expect(uuids(filterRows(ROWS, { chip: "legendary" }))).toEqual([]);
    expect(uuids(filterRows(ROWS, { chip: "common" }))).toEqual(["b", "g"]);
  });

  it("search and chip combine; an unknown chip matches nothing", () => {
    expect(uuids(filterRows(ROWS, { q: "wand", chip: "rare" }))).toEqual(["c"]);
    expect(filterRows(ROWS, { chip: "bogus" })).toEqual([]);
    expect(filterRows(ROWS)).toHaveLength(ROWS.length);
  });
});

describe("chipList", () => {
  it("counts each chip by what it shows, and skips empty ones", () => {
    const chips = chipList(ROWS);
    for (const c of chips) expect(c.n).toBe(filterRows(ROWS, { chip: c.chip }).length);
    expect(chips.map(c => c.chip)).toEqual(["common", "uncommon", "rare", "unset", "never", "missing", "renamed"]);
    expect(chips.find(c => c.chip === "unset").label).toBe("2 no rarity set");
    expect(chips.find(c => c.chip === "never").label).toBe("1 never drops");
  });

  it("keeps the active chip at 0 so it can be turned off", () => {
    expect(chipList(ROWS, "artifact").find(c => c.chip === "artifact")).toMatchObject({ n: 0 });
    expect(matchesChip(ROWS[0], null)).toBe(true);
  });
});

describe("pageRows and nextRows", () => {
  const many = Array.from({ length: 123 }, (_, i) => ({ e: { uuid: `u${i}` } }));

  it("returns 50 and the remaining count", () => {
    const p = pageRows(many);
    expect(p.rows).toHaveLength(PAGE_ROWS);
    expect(PAGE_ROWS).toBe(50);
    expect(p).toMatchObject({ left: 73, next: 50 });
    expect(pageRows(many, 100)).toMatchObject({ left: 23, next: 23 });
    expect(pageRows(many, 500)).toMatchObject({ left: 0, next: 0 });
    expect(pageRows(many, 0).rows).toHaveLength(50); // never less than a page
    expect(pageRows([], 50)).toMatchObject({ rows: [], left: 0, next: 0 });
  });

  it("the next page skips rows already drawn, so a re-sort never repeats or drops one", () => {
    const drawn = many.slice(0, 50).map(r => r.e.uuid);
    // An edit moved row 10 to the end: the fresh order differs from what's drawn.
    const resorted = [...many.slice(0, 10), ...many.slice(11), many[10]];
    const next = nextRows(resorted, drawn);
    expect(next.rows.map(r => r.e.uuid)).toEqual(many.slice(50, 100).map(r => r.e.uuid));
    expect(next).toMatchObject({ left: 23, next: 23 });
  });
});

describe("markup", () => {
  const big = { id: "big", name: "Every item", entries: Array.from({ length: 872 }, (_, i) => entry(`Compendium.dnd5e.items.Item.${i}`, `Item ${i}`, i % 3 ? "uncommon" : "")) };
  const rows = sortRows(poolRows(big, srcOf({})));

  it("a pool over 60 entries starts collapsed; a small one open", () => {
    expect(defaultView(big).open).toBe(false);
    expect(defaultView({ entries: Array(OPEN_UP_TO) }).open).toBe(true);
    expect(defaultView({ entries: Array(OPEN_UP_TO + 1) }).open).toBe(false);
  });

  it("the summary carries the census with no rows", () => {
    const html = poolSummary(big, rows, esc);
    expect(html).toContain("872 items");
    expect(html).toContain("291 no rarity set");
    expect(html).not.toContain("<select");
  });

  it("an open pool draws one page of controls, its chips pressed by the view", () => {
    const html = poolBody(big, rows, { ...defaultView(big), chip: "unset" }, esc);
    expect(html.match(/<select/g)).toHaveLength(50);
    expect(html.match(/<input class="lc-entry__weight"/g)).toHaveLength(50);
    expect(html).toContain('data-chip="unset" aria-pressed="true"');
    expect(html).toContain("Show 50 more (241 left)");
    expect(html).toContain("Set rarity for 291 unset matching");
    expect(html).not.toContain("aria-live");
  });

  it("escapes names and the search text", () => {
    const evil = { id: "x", name: "<b>pool</b>", entries: [entry("u", "<img src=x onerror=1>", "rare")] };
    const html = poolSummary(evil, poolRows(evil, srcOf({})), esc) + poolBody(evil, poolRows(evil, srcOf({})), { ...defaultView(evil), q: '"><script>' }, esc);
    expect(html).not.toMatch(/<img src=x|<script>|<b>pool/);
  });

  it("the census reads the same as before", () => {
    expect(poolCount(POOL, ROWS)).toBe('7 items · 2 common, 2 uncommon, 1 rare · 1 never drops · <span class="lc-pool__problems">1 missing, 1 renamed, 2 no rarity set</span>');
  });
});
