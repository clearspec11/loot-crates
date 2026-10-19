/*
  performPull's money guarantee: a purchase charges and grants, or does
  neither. When the grant throws after the charge, the purse is written back
  and the buyer gets a PullError that says so.
*/
import { describe, it, expect, afterEach } from "vitest";
import { performPull, PullError } from "../module/scripts/pull.js";
import { toCopper } from "../module/scripts/currency.js";

const tick = () => new Promise(r => setTimeout(r, 0));
const POOLS = { pool: { id: "pool", name: "Pool", pools: [], entries: ["a", "b", "c"].map(u => ({ uuid: u, name: u, img: "", rarity: "common", weight: 1 })) } };
const BOX = { id: "box", name: "Test Crate", price: 12.5, pools: [{ id: "pool", share: 1 }], weights: { common: 1 }, rules: {} };

function makeActor({ grantFails = false } = {}) {
  const actor = {
    id: "actor1", name: "Crate Tester", items: [], writes: [],
    system: { currency: { pp: 0, gp: 500, ep: 0, sp: 0, cp: 0 } },
    async update(data) { await tick(); actor.writes.push(data["system.currency"]); actor.system.currency = data["system.currency"]; },
    async createEmbeddedDocuments(_type, docs) {
      await tick();
      if (grantFails) throw new Error("Item validation failed: type 'weapon' is not valid");
      const made = docs.map(d => ({ id: "item1", ...d }));
      actor.items.push(...made);
      return made;
    },
  };
  return actor;
}

afterEach(() => { delete globalThis.fromUuid; });

describe("performPull", () => {
  it("returns the coins and throws a PullError when the grant fails after the charge", async () => {
    globalThis.fromUuid = async uuid => ({ name: `Item ${uuid}`, img: "", toObject: () => ({ name: `Item ${uuid}`, type: "loot", flags: {} }) });
    const actor = makeActor({ grantFails: true });
    const before = { ...actor.system.currency };
    const errors = [];
    const orig = console.error;
    console.error = (...a) => errors.push(a.join(" "));
    try {
      const promise = performPull({ box: BOX, pools: POOLS, actor, state: {}, rng: () => 0.5 });
      await expect(promise).rejects.toBeInstanceOf(PullError);
      await expect(promise).rejects.toThrow("The item couldn't be added; your coins were returned.");
    } finally { console.error = orig; }
    expect(actor.writes).toHaveLength(2);
    expect(toCopper(actor.writes[0])).toBe(toCopper(before) - 1250);
    expect(actor.system.currency).toEqual(before);
    expect(actor.items).toHaveLength(0);
    expect(errors.some(e => e.startsWith("loot-crates |"))).toBe(true);
  });

  it("charges nothing when the rolled entry's source is gone from its compendium", async () => {
    globalThis.fromUuid = async () => null;
    const actor = makeActor();
    const promise = performPull({ box: BOX, pools: POOLS, actor, state: {}, rng: () => 0.5 });
    await expect(promise).rejects.toBeInstanceOf(PullError);
    await expect(promise).rejects.toThrow("is missing from its compendium");
    expect(actor.writes).toHaveLength(0);
    expect(actor.items).toHaveLength(0);
  });

  it("charges and grants together when the grant succeeds", async () => {
    globalThis.fromUuid = async uuid => ({ name: `Item ${uuid}`, img: "", toObject: () => ({ name: `Item ${uuid}`, type: "loot", flags: {} }) });
    const actor = makeActor();
    const out = await performPull({ box: BOX, pools: POOLS, actor, state: {}, rng: () => 0.5 });
    expect(out.itemId).toBe("item1");
    expect(actor.writes).toHaveLength(1);
    expect(actor.system.currency).toEqual({ pp: 0, gp: 487, ep: 0, sp: 5, cp: 0 });
    expect(actor.items[0].flags["loot-crates"].sourceUuid).toBe(out.result.uuid);
  });

  it("re-rolls once past an entry whose source vanished, and charges only after a live source is found", async () => {
    const pools = { pool: { id: "pool", name: "Pool", pools: [], entries: [
      { uuid: "gone", name: "Flame Tongue", img: "", rarity: "rare", weight: 1 },
      { uuid: "live", name: "Potion", img: "", rarity: "common", weight: 1 },
    ] } };
    const box = { ...BOX, weights: { common: 1, rare: 100 } };
    const events = [];
    globalThis.fromUuid = async uuid => {
      events.push(`resolve ${uuid}`);
      return uuid === "gone" ? null : { name: "Potion", img: "", toObject: () => ({ name: "Potion", type: "consumable", flags: {} }) };
    };
    const actor = makeActor();
    const origUpdate = actor.update;
    actor.update = async data => { events.push("charge"); return origUpdate(data); };
    const lost = [];
    const warn = console.warn;
    console.warn = () => {};
    try {
      const out = await performPull({ box, pools, actor, state: {}, rng: () => 0.5, onMissing: async e => { lost.push(e.uuid); } });
      expect(out.result.uuid).toBe("live");
    } finally { console.warn = warn; }
    expect(events).toEqual(["resolve gone", "resolve live", "charge"]);
    expect(lost).toEqual(["gone"]);
    expect(actor.writes).toHaveLength(1);
    expect(actor.items).toHaveLength(1);
    // The caller's pools are not mutated; the exclusion is local to this pull.
    expect(pools.pool.entries[0].missing).toBeUndefined();
  });

  it("redraws up to three times past sources that vanished, then charges once for the live one", async () => {
    const pools = { pool: { id: "pool", name: "Pool", pools: [], entries: [
      ...["g1", "g2", "g3"].map(u => ({ uuid: u, name: u, img: "", rarity: "legendary", weight: 1 })),
      { uuid: "live", name: "Potion", img: "", rarity: "common", weight: 1 },
    ] } };
    const box = { ...BOX, weights: { common: 1, legendary: 1000 } };
    globalThis.fromUuid = async uuid => (uuid === "live" ? { name: "Potion", img: "", toObject: () => ({ name: "Potion", type: "consumable", flags: {} }) } : null);
    const actor = makeActor();
    const lost = [];
    const warn = console.warn;
    console.warn = () => {};
    try {
      const out = await performPull({ box, pools, actor, state: {}, rng: () => 0.5, onMissing: async e => { lost.push(e.uuid); } });
      expect(out.result.uuid).toBe("live");
    } finally { console.warn = warn; }
    expect(lost.sort()).toEqual(["g1", "g2", "g3"]);
    expect(actor.writes).toHaveLength(1);
    expect(actor.items).toHaveLength(1);
  });

  it("gives up after three redraws and writes nothing when the sources keep vanishing", async () => {
    const pools = { pool: { id: "pool", name: "Pool", pools: [], entries:
      ["g1", "g2", "g3", "g4", "g5"].map(u => ({ uuid: u, name: u, img: "", rarity: "rare", weight: 1 })) } };
    globalThis.fromUuid = async () => null;
    const actor = makeActor();
    const lost = [];
    const warn = console.warn;
    console.warn = () => {};
    try {
      const promise = performPull({ box: { ...BOX, weights: { rare: 1 } }, pools, actor, state: {}, rng: () => 0.5, onMissing: async e => { lost.push(e.uuid); } });
      await expect(promise).rejects.toThrow("is missing from its compendium. Tell the GM.");
    } finally { console.warn = warn; }
    expect(lost).toHaveLength(4);
    expect(actor.writes).toHaveLength(0);
    expect(actor.items).toHaveLength(0);
  });
});

describe("performPull and a GM's rarity", () => {
  it("grants the copy at the rarity the GM set, and leaves an unedited one as its source", async () => {
    globalThis.fromUuid = async uuid => ({ name: uuid, img: "", toObject: () => ({ name: uuid, type: "loot", flags: {}, system: uuid === "set6" ? { rarities: ["uncommon"] } : { rarity: "uncommon" } }) });
    const pools = { pool: { id: "pool", name: "Pool", pools: [], entries: [
      { uuid: "set", name: "set", img: "", rarity: "uncommon", sourceRarity: "uncommon", rarityOverride: "legendary", weight: 1 },
    ] } };
    const box = { ...BOX, weights: { legendary: 1 } };
    const actor = makeActor();
    const out = await performPull({ box, pools, actor, state: {}, rng: () => 0.5 });
    expect(out.result.rarity).toBe("legendary");
    expect(actor.items[0].system.rarity).toBe("legendary");

    // dnd5e 6 keeps a set of rarities rather than one string.
    const six = { pool: { ...pools.pool, entries: [{ ...pools.pool.entries[0], uuid: "set6" }] } };
    const actor6 = makeActor();
    await performPull({ box, pools: six, actor: actor6, state: {}, rng: () => 0.5 });
    expect(actor6.items[0].system.rarities).toEqual(["legendary"]);
    expect(actor6.items[0].system.rarity).toBeUndefined();

    const plain = { pool: { ...pools.pool, entries: [{ uuid: "plain", name: "plain", img: "", rarity: "uncommon", sourceRarity: "uncommon", weight: 1 }] } };
    const actor2 = makeActor();
    await performPull({ box: { ...BOX, weights: { uncommon: 1 } }, pools: plain, actor: actor2, state: {}, rng: () => 0.5 });
    expect(actor2.items[0].system.rarity).toBe("uncommon");
  });
});
