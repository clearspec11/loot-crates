/*
  The pool editor as a craft table: rows annotated once, problems first, a
  case-insensitive name search, census chips whose counts are what they
  show, 50 rows at a time, and markup that draws no more than a page.
*/
import { describe, it, expect } from "vitest";
import { PAGE_ROWS, OPEN_UP_TO, defaultView, poolRows, sortRows, filterRows, pageRows, nextRows, chipList, matchesChip, poolCount, poolBody, poolSummary, entryParts, entryRow, pinRecent, dropNotice, poolUsers, emptiedBy, withoutPool, withoutEntry, deleteImpact, removeImpact, deletePoolText, removeEntryText, usersLine, nameList } from "../module/scripts/poolview.js";

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

describe("the pool's bar", () => {
  it("offers a new crate from the pool, named for it, beside Add from compendium", () => {
    const html = poolBody(POOL, ROWS, defaultView(POOL), esc);
    expect(html).toMatch(/data-action="bulkAdd"[^>]*data-pool="p"/);
    expect(html).toMatch(/<button[^>]*data-action="crateFromPool"[^>]*data-pool="p"[^>]*aria-label="New crate from Big pool"[^>]*>[^<]*<i[^>]*><\/i> New crate from this pool<\/button>/);
    expect(html.indexOf('data-action="crateFromPool"')).toBeLessThan(html.indexOf('data-action="editPool"'));
  });
});

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

/*
  A drop says where it went: what was just added is pinned above everything,
  problems included, on the first page of its pool, marked "Just added", and
  a chip or search that would hide it is cleared and named.
*/
describe("a dropped item", () => {
  it("sorts recent rows first, ahead of missing and renamed rows, newest first", () => {
    const sorted = sortRows(ROWS, ["g", "a"]);
    expect(uuids(sorted)).toEqual(["g", "a", "d", "f", "b", "c", "e"]);
    expect(sorted.slice(0, 2).every(r => r.recent)).toBe(true);
    expect(sorted.slice(2).some(r => r.recent)).toBe(false);
    // An unknown uuid (removed since) changes nothing; no list is the old order.
    expect(uuids(sortRows(ROWS, ["gone"]))).toEqual(uuids(sortRows(ROWS)));
    expect(defaultView(POOL).recent).toEqual([]);
  });

  const big = { id: "c", name: "dnd5e items (filtered)", entries: Array.from({ length: 130 }, (_, i) => entry(`u${i}`, `Item ${i}`, i % 2 ? "common" : "rare")) };
  big.entries[3] = entry("u3", "Old Shield", "uncommon"); // renamed at the source
  const src = srcOf({ u3: { name: "Shield +1", img: "", rarity: "uncommon", rawRarity: "uncommon" } });

  it("puts the newest entry of a 130-entry pool on page one, first", () => {
    const plain = pageRows(sortRows(poolRows(big, src)));
    expect(uuids(plain.rows)).not.toContain("u129");
    const pinned = pageRows(sortRows(poolRows(big, src), ["u129"]));
    expect(pinned.rows[0].e.uuid).toBe("u129");
    expect(pinned.rows[1].e.uuid).toBe("u3"); // then the problems, as before
    const html = poolBody(big, sortRows(poolRows(big, src), ["u129"]), { ...defaultView(big), recent: ["u129"] }, esc);
    expect(html.indexOf('data-entry="u129"')).toBeLessThan(html.indexOf('data-entry="u3"'));
  });

  it("marks a recent row Just added, with a class for its edge", () => {
    const [row] = sortRows(poolRows(big, src), ["u129"]);
    const parts = entryParts(row, esc);
    expect(parts.className).toContain("lc-entry--recent");
    expect(parts.text).toContain("Just added");
    const other = entryParts(sortRows(poolRows(big, src), ["u129"])[5], esc);
    expect(other.className).not.toContain("lc-entry--recent");
    expect(other.text).not.toContain("Just added");
    // Alongside a problem note, both are said.
    const unset = sortRows(poolRows(POOL, srcOf({})), ["b"])[0];
    expect(entryRow("p", unset, esc)).toMatch(/Just added<\/span> · No rarity set/);
  });

  it("opens the pool, back to page one, and keeps a chip and search that still show it", () => {
    const view = { ...defaultView(big), chip: "common", q: "item", shown: 150 };
    const out = pinRecent(view, poolRows(big, src), ["u129"]);
    expect(out.view).toMatchObject({ open: true, shown: PAGE_ROWS, chip: "common", q: "item", recent: ["u129"] });
    expect(out.cleared).toEqual([]);
    expect(view.recent).toEqual([]); // the old view is left alone
  });

  it("clears a chip that would hide it, and says so", () => {
    const view = { ...defaultView(big), chip: "rare" };
    const rows = poolRows(big, src);
    const out = pinRecent(view, rows, ["u129"]); // u129 is common
    expect(out.view.chip).toBe(null);
    expect(out.cleared).toEqual(["the Rare filter"]);
    const shown = sortRows(rows, out.view.recent);
    expect(uuids(pageRows(filterRows(shown, out.view)).rows)[0]).toBe("u129");
    const text = dropNotice({ pool: big, rows: shown.filter(r => r.recent), cleared: out.cleared });
    expect(text).toBe("Item 129 added to dnd5e items (filtered), Common, at the top. Cleared the Rare filter so it shows.");
  });

  it("clears a search that would hide it, and a problem chip by its name", () => {
    const out = pinRecent({ ...defaultView(big), chip: "renamed", q: "shield" }, poolRows(big, src), ["u129"]);
    expect(out.view).toMatchObject({ chip: null, q: "" });
    expect(out.cleared).toEqual(["the Renamed filter", "the search"]);
  });

  it("pins at most a page", () => {
    const all = big.entries.map(e => e.uuid);
    expect(pinRecent(defaultView(big), poolRows(big, src), all).view.recent).toHaveLength(PAGE_ROWS);
  });

  it("names the item, its pool, its rarity and where it is", () => {
    const rows = sortRows(poolRows(POOL, srcOf({})), ["c"]).filter(r => r.recent);
    expect(dropNotice({ pool: POOL, rows })).toBe("WAND OF WEB added to Big pool, Rare, at the top.");
    const unset = sortRows(poolRows(POOL, srcOf({})), ["b"]).filter(r => r.recent);
    expect(dropNotice({ pool: POOL, rows: unset })).toBe("Longsword added to Big pool, no rarity set (draws as Common), at the top.");
    expect(dropNotice({ pool: POOL, rows, duplicate: true })).toBe("WAND OF WEB is already in Big pool; it is at the top.");
    const many = sortRows(poolRows(big, src), big.entries.slice(0, 40).map(e => e.uuid)).filter(r => r.recent);
    expect(dropNotice({ pool: { name: "Core magic items" }, rows: many, label: "SRD Items" })).toBe("Added 40 items from SRD Items to Core magic items; they are at the top.");
    const page = many.concat(sortRows(poolRows(big, src), big.entries.slice(40, 50).map(e => e.uuid)).filter(r => r.recent));
    expect(dropNotice({ pool: { name: "Core" }, rows: page, label: "SRD Items", added: 130 })).toBe("Added 130 items from SRD Items to Core; the first 50 are at the top.");
  });
});

/*
  Which boxes draw from a pool, and which a delete or a removal would leave
  with nothing inside: the shop's "Nothing inside", judged before it lands.
*/
describe("pool users and what a delete or removal empties", () => {
  const item = (uuid, rarity = "rare", extra = {}) => entry(uuid, uuid, rarity, extra);
  const pools = {
    core: { id: "core", name: "Core", pools: [], entries: [item("sword"), item("ring", "uncommon")] },
    gems: { id: "gems", name: "Gems", pools: [], entries: [item("ruby")] },
    hoard: { id: "hoard", name: "Hoard", pools: ["gems"], entries: [] },
    lone: { id: "lone", name: "Lone", pools: [], entries: [item("wand"), item("dud", "rare", { weight: 0 }), item("ghost", "rare", { missing: true })] },
    // A cycle: each nests the other.
    a: { id: "a", name: "A", pools: ["b"], entries: [item("x")] },
    b: { id: "b", name: "B", pools: ["a"], entries: [] },
  };
  const box = (id, ...refs) => ({ id, name: `${id} crate`, price: 10, pools: refs.map(r => ({ id: r, share: 1 })), weights: {}, rules: {} });
  const boxes = {
    adventurer: box("adventurer", "core", "lone"),
    royal: box("royal", "core"),
    dragon: box("dragon", "hoard"),
    solo: box("solo", "lone"),
    loop: box("loop", "b"),
  };
  const ids = list => list.map(b => b.id);

  it("poolUsers finds direct and nested users, in stored order", () => {
    expect(ids(poolUsers("core", pools, boxes))).toEqual(["adventurer", "royal"]);
    expect(ids(poolUsers("gems", pools, boxes))).toEqual(["dragon"]);
    expect(ids(poolUsers("hoard", pools, boxes))).toEqual(["dragon"]);
    expect(poolUsers("nowhere", pools, boxes)).toEqual([]);
    expect(ids(poolUsers("core", pools, Object.values(boxes)))).toEqual(["adventurer", "royal"]);
  });

  it("poolUsers survives a cycle of nested pools", () => {
    expect(ids(poolUsers("a", pools, boxes))).toEqual(["loop"]);
    expect(ids(poolUsers("b", pools, boxes))).toEqual(["loop"]);
    expect(poolUsers("core", pools, { loop: boxes.loop })).toEqual([]);
  });

  it("emptiedBy flags a box whose only pool is deleted, not a mixed box", () => {
    const after = withoutPool(pools, "core");
    expect(ids(emptiedBy(boxes, pools, after))).toEqual(["royal"]);
    // Nested: deleting Gems leaves Hoard, and the Dragon box, empty.
    expect(ids(emptiedBy(boxes, pools, withoutPool(pools, "gems")))).toEqual(["dragon"]);
    expect(withoutPool(pools, "gems").hoard.pools).toEqual([]);
  });

  it("emptiedBy flags a box whose pool loses its last droppable entry; weight 0 and missing don't count", () => {
    // Lone holds wand, plus one at weight 0 and one missing: wand is the last.
    const after = withoutEntry(pools, "lone", "wand");
    expect(ids(emptiedBy(boxes, pools, after))).toEqual(["solo"]);
    expect(after.lone.entries.map(e => e.uuid)).toEqual(["dud", "ghost"]);
    // Removing one of two leaves the box something to drop.
    expect(emptiedBy(boxes, pools, withoutEntry(pools, "core", "sword"))).toEqual([]);
    // Removing the weight-0 or missing one empties nothing.
    expect(removeImpact("lone", "dud", pools, boxes)).toEqual([]);
    expect(removeImpact("lone", "ghost", pools, boxes)).toEqual([]);
    expect(ids(removeImpact("lone", "wand", pools, boxes))).toEqual(["solo"]);
  });

  it("a box already empty before isn't flagged", () => {
    const empty = { ...pools, lone: { ...pools.lone, entries: [item("dud", "rare", { weight: 0 })] } };
    expect(emptiedBy(boxes, empty, withoutPool(empty, "lone"))).toEqual([]);
    const impact = deleteImpact("lone", empty, boxes);
    expect(ids(impact.users)).toEqual(["adventurer", "solo"]);
    expect(impact.emptied).toEqual([]);
    expect(ids(impact.kept)).toEqual(["adventurer"]);
  });

  it("deleteImpact splits users into kept and emptied", () => {
    const impact = deleteImpact("core", pools, boxes);
    expect(ids(impact.users)).toEqual(["adventurer", "royal"]);
    expect(ids(impact.emptied)).toEqual(["royal"]);
    expect(ids(impact.kept)).toEqual(["adventurer"]);
  });

  it("the header line names the boxes, at most three, or says none", () => {
    expect(usersLine([], esc)).toBe('<span class="lc-pool__users">Not in any box</span>');
    expect(usersLine(["Adventurer's Crate", "Royal Crate"], esc)).toBe('<span class="lc-pool__users">In Adventurer&#39;s Crate, Royal Crate</span>');
    expect(usersLine(["A", "B", "C", "D", "E"], esc)).toContain(">In A, B, C and 2 more<");
    expect(poolSummary(POOL, ROWS, esc, ["Royal Crate"])).toContain('<span class="lc-pool__users">In Royal Crate</span></summary>');
    expect(poolSummary(POOL, ROWS, esc)).not.toContain("lc-pool__users");
  });

  it("the confirms name the boxes, and the emptied ones in a sentence of their own", () => {
    expect(nameList(["A"])).toBe("A");
    expect(nameList(["A", "B", "C"])).toBe("A, B and C");
    const text = deletePoolText(pools.core, deleteImpact("core", pools, boxes), esc);
    expect(text).toBe("<p>Delete <strong>Core</strong>? It is in <strong>adventurer crate</strong> and <strong>royal crate</strong>.</p>"
      + "<p><strong>adventurer crate</strong> can still drop items from its other pools.</p>"
      + "<p><strong>royal crate</strong> will have nothing inside and can't be bought until it has an item that can drop.</p>");
    expect(deletePoolText(pools.a, { users: [] }, esc)).toBe("<p>Delete <strong>A</strong>? No box draws from it.</p>");
    const two = [boxes.royal, boxes.solo];
    expect(deletePoolText(pools.core, { users: two, emptied: two }, esc)).toContain("<strong>royal crate</strong> and <strong>solo crate</strong> will have nothing inside and can't be bought until they have an item that can drop.");
    expect(removeEntryText("Wand <1>", pools.lone, [boxes.solo], esc)).toBe("<p>Remove <strong>Wand &lt;1&gt;</strong> from <strong>Lone</strong>? It is the last item solo crate can drop.</p>"
      + "<p><strong>solo crate</strong> will have nothing inside and can't be bought until it has an item that can drop.</p>");
  });
});
