/*
  What a drop on a pool would add (store.js entriesFromDrop), against a fake
  `game` with world folders, compendium packs and a roll table: folders bring
  their subfolders' items, spells and features are counted as skipped rather
  than added, items already in the pool are left out, and a roll table's
  result weights become entry weights while its text results are skipped.
*/
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { entriesFromDrop, entriesFromCompendium, packHasLoot, addEntries, registerSettings } from "../module/scripts/store.js";

const item = (id, name, type, rarity = "", extra = {}) => ({
  id, uuid: `Item.${id}`, documentName: "Item", name, type, img: `icons/${id}.webp`, system: { rarity }, ...extra,
});

function folder(id, name, contents, children = [], extra = {}) {
  return {
    id, uuid: `Folder.${id}`, documentName: "Folder", name, type: "Item", contents,
    getSubfolders: recursive => recursive ? children.flatMap(c => [c, ...c.getSubfolders(true)]) : children,
    ...extra,
  };
}

// Foundry's Collection is a Map that iterates its values.
class Collection extends Map { *[Symbol.iterator]() { yield* this.values(); } }

function pack(collection, label, rows, documentName = "Item") {
  const index = new Collection(rows.map(r => [r._id, { ...r, uuid: `Compendium.${collection}.Item.${r._id}` }]));
  return {
    collection, documentName, metadata: { label }, index,
    getIndex: vi.fn(async () => index),
    getDocuments: vi.fn(async ({ _id__in }) => _id__in.map(id => ({ id, system: { rarity: "" } }))),
  };
}

let docs;
beforeEach(() => {
  const sword = item("sword", "Longsword", "weapon", "common");
  const potion = item("potion", "Potion of Healing", "consumable", "common");
  const ring = item("ring", "Ring of Protection", "equipment", "rare");
  const fireball = item("fireball", "Fireball", "spell");
  const rage = item("rage", "Rage", "feat");
  const deep = folder("deep", "Rings", [ring]);
  const sub = folder("sub", "Spells", [fireball, rage], [deep]);
  const root = folder("root", "Homebrew", [sword, potion], [sub]);

  const srd = pack("dnd5e.items", "Items (SRD)", [
    { _id: "a1", name: "Bag of Holding", type: "container", system: { rarity: "uncommon" }, folder: "cf1" },
    { _id: "a2", name: "Wand of Fireballs", type: "equipment", system: { rarity: "rare" }, folder: "cf2" },
    { _id: "a3", name: "Rope", type: "loot", system: { rarity: "" }, folder: null },
    { _id: "a4", name: "Smith's Tools", type: "tool", system: { rarity: "" }, folder: "cf1" },
  ]);
  const spells = pack("dnd5e.spells", "Spells (SRD)", [
    { _id: "s1", name: "Fireball", type: "spell", system: {} },
    { _id: "s2", name: "Shield", type: "spell", system: {} },
    { _id: "s3", name: "Conjured Flame Blade", type: "weapon", system: {} },
  ]);
  const actors = pack("dnd5e.monsters", "Monsters", [{ _id: "m1", name: "Goblin", type: "npc" }], "Actor");
  const cf2 = folder("cf2", "Wands", [], [], { uuid: "Compendium.dnd5e.items.Folder.cf2", pack: "dnd5e.items" });
  const cf1 = folder("cf1", "Adventuring Gear", [], [cf2], { uuid: "Compendium.dnd5e.items.Folder.cf1", pack: "dnd5e.items" });

  const textResult = { type: "text", description: "Nothing but dust", weight: 4 };
  const table = {
    uuid: "RollTable.t1", documentName: "RollTable", name: "Goblin Pockets",
    results: [
      { type: "document", documentUuid: "Item.sword", weight: 3 },
      { type: "document", documentUuid: "Item.potion", weight: 1 },
      { type: "document", documentUuid: "Item.potion", weight: 2 },
      { type: "document", documentUuid: "Compendium.dnd5e.items.Item.a2", weight: 0 },
      { type: "document", documentUuid: "RollTable.other", weight: 5 },
      { type: "document", documentUuid: "Item.fireball", weight: 2 },
      textResult,
    ],
  };
  const otherTable = { uuid: "RollTable.other", documentName: "RollTable", name: "Other" };
  const wand = { ...srd.index.get("a2"), documentName: "Item", img: "icons/wand.webp" };

  docs = new Map([sword, potion, ring, fireball, rage, root, sub, deep, cf1, cf2, table, otherTable, wand].map(d => [d.uuid, d]));
  const packs = [srd, spells, actors];
  vi.stubGlobal("fromUuid", vi.fn(async uuid => docs.get(uuid) ?? null));
  vi.stubGlobal("game", {
    packs: Object.assign(new Map(packs.map(p => [p.collection, p])), { filter: fn => packs.filter(fn) }),
    folders: new Map([root, sub, deep].map(f => [f.id, f])),
  });
});
afterEach(() => vi.unstubAllGlobals());

const names = plan => plan.entries.map(e => e.name).sort();

describe("entriesFromDrop", () => {
  it("adds one dropped item as it is", async () => {
    const plan = await entriesFromDrop({ type: "Item", uuid: "Item.ring" });
    expect(plan.label).toBe("Ring of Protection");
    expect(plan.entries).toEqual([{ uuid: "Item.ring", name: "Ring of Protection", img: "icons/ring.webp", rarity: "rare", weight: 1 }]);
  });

  it("refuses a single spell, counting it as not loot", async () => {
    const plan = await entriesFromDrop({ type: "Item", uuid: "Item.fireball" });
    expect(plan.entries).toEqual([]);
    expect(plan.skipped.notLoot).toEqual({ spell: 1 });
  });

  it("brings a world folder's items and every subfolder's items", async () => {
    const plan = await entriesFromDrop({ type: "Folder", uuid: "Folder.root" });
    expect(plan.label).toBe("Homebrew");
    expect(names(plan)).toEqual(["Longsword", "Potion of Healing", "Ring of Protection"]);
    expect(plan.entries.every(e => !("type" in e))).toBe(true);
  });

  it("counts spells and features in a folder as skipped instead of adding them", async () => {
    const plan = await entriesFromDrop({ type: "Folder", uuid: "Folder.root" });
    expect(plan.skipped.notLoot).toEqual({ spell: 1, feat: 1 });
    expect(names(plan)).not.toContain("Fireball");
  });

  it("leaves out items already in the pool and says how many", async () => {
    const plan = await entriesFromDrop({ type: "Folder", uuid: "Folder.root" }, { known: ["Item.sword", "Item.ring"] });
    expect(names(plan)).toEqual(["Potion of Healing"]);
    expect(plan.skipped.duplicates).toBe(2);
  });

  it("brings a compendium folder's index rows, subfolders included", async () => {
    const plan = await entriesFromDrop({ type: "Folder", uuid: "Compendium.dnd5e.items.Folder.cf1" });
    expect(names(plan)).toEqual(["Bag of Holding", "Smith's Tools", "Wand of Fireballs"]);
    expect(plan.entries.find(e => e.name === "Bag of Holding").uuid).toBe("Compendium.dnd5e.items.Item.a1");
  });

  it("brings a whole item compendium", async () => {
    const plan = await entriesFromDrop({ type: "Compendium", collection: "dnd5e.items" }, { known: ["Compendium.dnd5e.items.Item.a3"] });
    expect(plan.label).toBe("Items (SRD)");
    expect(plan.entries).toHaveLength(3);
    expect(plan.skipped.duplicates).toBe(1);
    expect(plan.entries.find(e => e.name === "Wand of Fireballs").rarity).toBe("rare");
  });

  it("skips the spells in a spell compendium and refuses an actor compendium", async () => {
    const spells = await entriesFromDrop({ type: "Compendium", collection: "dnd5e.spells" });
    expect(spells.entries.map(e => e.name)).toEqual(["Conjured Flame Blade"]);
    expect(spells.skipped.notLoot).toEqual({ spell: 2 });
    expect(await entriesFromDrop({ type: "Compendium", collection: "dnd5e.monsters" })).toBeNull();
  });

  it("applies the bulk filter on a compendium drop", async () => {
    const plan = await entriesFromDrop({ type: "Compendium", collection: "dnd5e.items", filter: { rarities: ["rare"] } });
    expect(names(plan)).toEqual(["Wand of Fireballs"]);
  });

  it("maps a roll table's result weights to entry weights and ignores text results", async () => {
    const plan = await entriesFromDrop({ type: "RollTable", uuid: "RollTable.t1" });
    expect(plan.label).toBe("Goblin Pockets");
    const byName = Object.fromEntries(plan.entries.map(e => [e.name, e.weight]));
    // The potion appears twice (1 + 2); a weight-0 result still goes in at 1
    // so its rarity is never left with nothing drawable.
    expect(byName).toEqual({ Longsword: 3, "Potion of Healing": 3, "Wand of Fireballs": 1 });
    expect(plan.skipped.notItems).toBe(2);
    expect(plan.skipped.notLoot).toEqual({ spell: 1 });
  });

  it("returns null for drag data it can't use", async () => {
    expect(await entriesFromDrop({ type: "Actor", uuid: "Actor.x" })).toBeNull();
    expect(await entriesFromDrop({ type: "Folder", uuid: "Folder.gone" })).toBeNull();
    expect(await entriesFromDrop(null)).toBeNull();
  });
});

describe("index rows that lost their rarity", () => {
  // Foundry re-indexes a compendium item it has loaded with only
  // pack.indexFields, which has no system.rarity, and getIndex keeps
  // returning that row. Live in cc-dev: Vicious Shortsword's row read
  // { container, identifier, source } after one getDocument.
  beforeEach(() => {
    const srd = globalThis.game.packs.get("dnd5e.items");
    srd.index.set("a2", { ...srd.index.get("a2"), system: { identifier: "wand-of-fireballs" } });
    srd.getDocuments = vi.fn(async ({ _id__in }) => _id__in.map(id => ({ id, system: { rarity: { a2: "rare" }[id] } })));
  });

  it("reads the rarity from the document instead of calling it common", async () => {
    const plan = await entriesFromDrop({ type: "Compendium", collection: "dnd5e.items" });
    expect(plan.entries.find(e => e.name === "Wand of Fireballs").rarity).toBe("rare");
    expect(globalThis.game.packs.get("dnd5e.items").getDocuments).toHaveBeenCalledWith({ _id__in: ["a2"] });
  });

  it("keeps such an item in a rarity filter and a compendium folder drop", async () => {
    const filtered = await entriesFromDrop({ type: "Compendium", collection: "dnd5e.items", filter: { rarities: ["rare"] } });
    expect(names(filtered)).toEqual(["Wand of Fireballs"]);
    const fromFolder = await entriesFromDrop({ type: "Folder", uuid: "Compendium.dnd5e.items.Folder.cf2" });
    expect(fromFolder.entries.map(e => e.rarity)).toEqual(["rare"]);
  });
});

describe("compendium picker", () => {
  // A spell pack with one conjured weapon in it is still a spell pack.
  it("offers only packs that are mostly loot", () => {
    expect(packHasLoot(globalThis.game.packs.get("dnd5e.items"))).toBe(true);
    expect(packHasLoot(globalThis.game.packs.get("dnd5e.spells"))).toBe(false);
    expect(packHasLoot(globalThis.game.packs.get("dnd5e.monsters"))).toBe(false);
  });

  it("keeps entriesFromCompendium's entries free of the item type", async () => {
    const entries = await entriesFromCompendium("dnd5e.items");
    expect(entries).toHaveLength(4);
    expect(entries.every(e => !("type" in e))).toBe(true);
  });
});

describe("addEntries", () => {
  it("writes only entries not already in the pool, read fresh", async () => {
    const settings = new Map();
    vi.stubGlobal("foundry", { utils: { deepClone: v => structuredClone(v) } });
    globalThis.game.settings = {
      register: (_m, key, cfg) => settings.set(key, cfg.default),
      get: (_m, key) => settings.get(key),
      set: async (_m, key, v) => settings.set(key, v),
    };
    registerSettings();
    settings.set("pools", { p: { id: "p", name: "Pool", entries: [{ uuid: "Item.sword", name: "Longsword", weight: 1 }], pools: [] } });
    const plan = await entriesFromDrop({ type: "Folder", uuid: "Folder.root" });
    expect(await addEntries("p", plan.entries)).toBe(2);
    expect(settings.get("pools").p.entries.map(e => e.uuid)).toEqual(["Item.sword", "Item.potion", "Item.ring"]);
    expect(await addEntries("p", plan.entries)).toBe(0);
  });
});
