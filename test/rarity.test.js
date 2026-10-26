/*
  Rarity is read one way (odds.js rawRarityOf) from one registered index
  field list (store.js INDEX_FIELDS). The fake pack below behaves like
  Foundry v14's CompendiumCollection#getIndex: it reuses its index only when
  the fields asked for are a subset of the last fetch's, and replaces that
  set rather than merging it, so a caller asking for a different list
  refetches the whole pack. Every read here must share one list.
*/
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rawRarityOf, normalizeRarity, rarityUnset } from "../module/scripts/core/odds.js";
import {
  registerSettings, registerIndexFields, RARITY_FIELDS, INDEX_FIELDS,
  checkSources, entriesFromCompendium, entryFromItem, refreshMissing,
} from "../module/scripts/foundry/store.js";

describe("rawRarityOf", () => {
  it("reads a legacy string, '' included", () => {
    expect(rawRarityOf({ rarity: "rare" })).toBe("rare");
    expect(rawRarityOf({ rarity: "" })).toBe("");
  });

  it("reads dnd5e 6's rarities as an index row's Array or a document's Set", () => {
    expect(rawRarityOf({ rarities: ["veryRare"] })).toBe("veryRare");
    expect(rawRarityOf({ rarities: new Set(["legendary"]) })).toBe("legendary");
  });

  it("takes the first member, as dnd5e's rarity getter does (rarities.first())", () => {
    expect(rawRarityOf({ rarities: new Set(["rare", "uncommon"]) })).toBe("rare");
    expect(rawRarityOf({ rarities: ["uncommon", "rare"] })).toBe("uncommon");
  });

  it("prefers rarities over a legacy string, as dnd5e's migration does", () => {
    expect(rawRarityOf({ rarities: ["rare"], rarity: "common" })).toBe("rare");
  });

  it("reads an empty set as no rarity, and no field at all as unknown", () => {
    expect(rawRarityOf({ rarities: [] })).toBe("");
    expect(rawRarityOf({ rarities: new Set() })).toBe("");
    expect(rawRarityOf({})).toBeNull();
    expect(rawRarityOf({ rarity: undefined })).toBeNull();
    expect(rawRarityOf(undefined)).toBeNull();
  });

  it("normalises a legacy free-text rarity", () => {
    expect(normalizeRarity(rawRarityOf({ rarity: "Very Rare" }))).toBe("veryRare");
  });
});

// Foundry's Collection is a Map that iterates its values.
class Collection extends Map { *[Symbol.iterator]() { yield* this.values(); } }

// A compendium pack with v14's getIndex caching. `fetches` lists each
// server fetch's field list.
class FakePack {
  #indexedFields = new Set();
  constructor(collection, rows, coreFields = ["_id", "name", "img", "type", "folder"]) {
    this.collection = collection;
    this.documentName = "Item";
    this.metadata = { label: collection };
    this.coreFields = coreFields;
    this.rows = rows;
    this.index = new Collection();
    this.fetches = [];
    this.getDocuments = vi.fn(async ({ _id__in }) => _id__in.map(id => ({ id, system: this.rows.find(r => r._id === id).doc })));
  }
  get indexFields() { return new Set([...this.coreFields, ...(globalThis.CONFIG?.Item?.compendiumIndexFields ?? [])]); }
  get indexed() { return this.indexFields.isSubsetOf(this.#indexedFields); }
  async getIndex({ fields = [] } = {}) {
    const want = new Set([...this.indexFields, ...fields]);
    if (want.isSubsetOf(this.#indexedFields)) return this.index;
    this.fetches.push([...want].sort());
    await new Promise(r => setTimeout(r, 1));
    for (const row of this.rows) {
      const out = { _id: row._id, name: row.name, type: row.type, img: row.img, folder: null, uuid: `Compendium.${this.collection}.Item.${row._id}` };
      for (const f of want) {
        if (!f.startsWith("system.")) continue;
        const key = f.slice(7);
        if (key in (row.system ?? {})) (out.system ??= {})[key] = row.system[key];
      }
      this.index.set(row._id, out);
    }
    this.#indexedFields = want;
    return this.index;
  }
}

const row = (id, name, system, extra = {}) => ({ _id: id, name, type: "equipment", img: `icons/${id}.webp`, system, ...extra });
const uuid = id => `Compendium.world.homebrew.Item.${id}`;

let pack;
beforeEach(() => {
  vi.stubGlobal("CONFIG", { Item: { compendiumIndexFields: ["system.container", "system.identifier", "system.source"] } });
  pack = new FakePack("world.homebrew", [
    row("legacy", "Cloak of Elvenkind", { rarity: "uncommon" }),
    row("blank", "Rope", { rarity: "" }),
    row("modern", "Wand of Sparks", { rarities: ["rare"] }),
    row("empty", "Plain Ring", { rarities: [] }),
    row("both", "Mirror Shield", { rarities: ["veryRare", "rare"] }),
  ]);
  vi.stubGlobal("game", { packs: new Map([[pack.collection, pack]]) });
});
afterEach(() => vi.unstubAllGlobals());

describe("registerIndexFields", () => {
  it("adds both rarity fields to Foundry's Item index fields once", () => {
    registerIndexFields();
    registerIndexFields();
    const fields = globalThis.CONFIG.Item.compendiumIndexFields;
    for (const f of RARITY_FIELDS) expect(fields.filter(x => x === f)).toHaveLength(1);
    expect(fields).toContain("system.source");
    expect(INDEX_FIELDS).toEqual(["system.rarities", "system.rarity", "img", "folder"]);
  });

  it("does nothing without CONFIG", () => {
    vi.stubGlobal("CONFIG", undefined);
    expect(() => registerIndexFields()).not.toThrow();
  });
});

describe("one index field list", () => {
  const entries = ["legacy", "modern"].map(id => ({ uuid: uuid(id) }));

  it("the editor's check, the sweep's check and a bulk add share one fetch", async () => {
    await checkSources(entries, { rarity: true });
    await checkSources(entries);
    await entriesFromCompendium("world.homebrew");
    expect(pack.fetches).toHaveLength(1);
    expect(pack.fetches[0]).toEqual(expect.arrayContaining(INDEX_FIELDS));
  });

  it("callers that ask at once wait on the same fetch", async () => {
    await Promise.all([checkSources(entries), checkSources(entries, { rarity: true }), entriesFromCompendium("world.homebrew")]);
    expect(pack.fetches).toHaveLength(1);
  });

  it("fetches nothing once Foundry has indexed the registered fields", async () => {
    registerIndexFields();
    await pack.getIndex(); // what Foundry does for every pack at load
    pack.fetches.length = 0;
    await checkSources(entries, { rarity: true });
    await checkSources(entries);
    await entriesFromCompendium("world.homebrew");
    expect(pack.fetches).toEqual([]);
  });

  it("survives dnd5e's compendium browser asking for its own fields", async () => {
    registerIndexFields();
    await pack.getIndex();
    await pack.getIndex({ fields: ["system.rarities", "system.price.value"] });
    pack.fetches.length = 0;
    await checkSources(entries);
    await entriesFromCompendium("world.homebrew");
    expect(pack.fetches).toEqual([]);
  });
});

describe("checkSources and bulk adds on every pack shape", () => {
  const all = ["legacy", "blank", "modern", "empty", "both"].map(id => ({ uuid: uuid(id) }));

  it("reads a rarities-only row's rarity, '' for an empty set", async () => {
    const got = await checkSources(all);
    const raw = id => got.get(uuid(id)).rawRarity;
    expect([raw("legacy"), raw("blank"), raw("modern"), raw("empty"), raw("both")]).toEqual(["uncommon", "", "rare", "", "veryRare"]);
    expect(got.get(uuid("modern")).rarity).toBe("rare");
    expect(got.get(uuid("empty")).rarity).toBe("common");
  });

  it("adds an empty-set item flagged unset, without loading any document", async () => {
    const added = await entriesFromCompendium("world.homebrew");
    const byName = Object.fromEntries(added.map(e => [e.name, e]));
    expect(byName["Plain Ring"].sourceRarity).toBe("");
    expect(rarityUnset(byName["Plain Ring"])).toBe(true);
    expect(byName["Wand of Sparks"]).toMatchObject({ rarity: "rare", sourceRarity: "rare" });
    expect(rarityUnset(byName["Wand of Sparks"])).toBe(false);
    expect(pack.getDocuments).not.toHaveBeenCalled();
  });

  it("filters a rarities-only pack by rarity", async () => {
    const rare = await entriesFromCompendium("world.homebrew", { rarities: ["rare"] });
    expect(rare.map(e => e.name)).toEqual(["Wand of Sparks"]);
  });

  it("loads only the rows that carry neither field", async () => {
    pack.rows.push(row("lost", "Vicious Shortsword", { identifier: "vicious-shortsword" }, { doc: { rarities: new Set(["rare"]) } }));
    const added = await entriesFromCompendium("world.homebrew");
    expect(added.find(e => e.name === "Vicious Shortsword").rarity).toBe("rare");
    expect(pack.getDocuments).toHaveBeenCalledWith({ _id__in: ["lost"] });
  });

  it("builds an entry from a dnd5e 6 document's rarities set", () => {
    const doc = { uuid: "Item.x", name: "Ring", img: "", system: { rarities: new Set(), get rarity() { return undefined; } } };
    expect(entryFromItem(doc)).toMatchObject({ rarity: "common", sourceRarity: "" });
    expect(entryFromItem({ ...doc, system: { rarities: new Set(["legendary"]) } })).toMatchObject({ rarity: "legendary", sourceRarity: "legendary" });
  });
});

describe("refreshMissing teaches older entries their source's rarity", () => {
  let settings, writes;
  beforeEach(() => {
    settings = new Map();
    writes = 0;
    vi.stubGlobal("foundry", { utils: { deepClone: v => structuredClone(v) } });
    globalThis.game.settings = {
      register: (_m, key, cfg) => settings.set(key, cfg.default),
      get: (_m, key) => settings.get(key),
      set: async (_m, key, v) => { writes++; settings.set(key, v); },
    };
    registerSettings();
  });

  const older = (id, name, rarity, extra = {}) => ({ uuid: uuid(id), name, img: "", rarity, weight: 1, ...extra });

  it("fills sourceRarity on older entries in one write and leaves stored ones alone", async () => {
    settings.set("pools", { p: { id: "p", name: "Live UI pool", pools: [], entries: [
      older("blank", "Rope", "common"),
      older("empty", "Plain Ring", "common", { rarityOverride: "rare" }),
      older("modern", "Wand of Sparks", "rare"),
      older("legacy", "Cloak of Elvenkind", "common"), // the source is uncommon now: shown, not learned
      older("both", "Mirror Shield", "veryRare", { sourceRarity: "rare" }), // stored: untouched
    ] } });
    expect(await refreshMissing(["p"])).toEqual([]);
    expect(writes).toBe(1);
    const byName = Object.fromEntries(settings.get("pools").p.entries.map(e => [e.name, e]));
    expect(byName.Rope.sourceRarity).toBe("");
    expect(rarityUnset(byName.Rope)).toBe(true);
    expect(byName["Plain Ring"]).toMatchObject({ sourceRarity: "", rarityOverride: "rare" });
    expect(byName["Wand of Sparks"].sourceRarity).toBe("rare");
    expect(byName["Cloak of Elvenkind"].sourceRarity).toBeUndefined();
    expect(byName["Mirror Shield"].sourceRarity).toBe("rare");
  });

  it("writes nothing when there is nothing to learn or flag", async () => {
    settings.set("pools", { p: { id: "p", name: "P", pools: [], entries: [older("modern", "Wand of Sparks", "rare", { sourceRarity: "rare" })] } });
    await refreshMissing(["p"]);
    expect(writes).toBe(0);
  });

  it("keeps the flags and learns nothing when the index can't be read", async () => {
    pack.getIndex = async () => { throw new Error("socket closed"); };
    settings.set("pools", { p: { id: "p", name: "P", pools: [], entries: [older("blank", "Rope", "common", { missing: true })] } });
    const warn = console.warn;
    console.warn = () => {};
    try { await refreshMissing(["p"]); } finally { console.warn = warn; }
    expect(writes).toBe(0);
    expect(settings.get("pools").p.entries[0]).toMatchObject({ missing: true });
    expect(settings.get("pools").p.entries[0].sourceRarity).toBeUndefined();
  });
});
