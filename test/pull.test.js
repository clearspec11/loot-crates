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

  it("charges and grants together when the grant succeeds", async () => {
    globalThis.fromUuid = async uuid => ({ name: `Item ${uuid}`, img: "", toObject: () => ({ name: `Item ${uuid}`, type: "loot", flags: {} }) });
    const actor = makeActor();
    const out = await performPull({ box: BOX, pools: POOLS, actor, state: {}, rng: () => 0.5 });
    expect(out.itemId).toBe("item1");
    expect(actor.writes).toHaveLength(1);
    expect(actor.system.currency).toEqual({ pp: 0, gp: 487, ep: 0, sp: 5, cp: 0 });
    expect(actor.items[0].flags["loot-crates"].sourceUuid).toBe(out.result.uuid);
  });
});
