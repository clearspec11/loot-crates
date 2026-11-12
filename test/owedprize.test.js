/*
  An item a play won and is still owed (core/owedprize.js), and handing it
  over from the Pull log (foundry/owedprize.js) with a fake `game`: picked
  from the pools it is made on the character and recorded on the row so the
  one refund removes it; given by hand only the debt is cleared; once only.
*/
import { describe, it, expect, afterEach, vi } from "vitest";
import { registerSettings, appendLog, getLog, getTally } from "../module/scripts/foundry/store.js";
import { describeOwed, handOver } from "../module/scripts/foundry/owedprize.js";
import { refundPull } from "../module/scripts/foundry/refund.js";
import { owedOf, owedNote, handedNote, owedChoices, handedPatch, owedCardLine } from "../module/scripts/core/owedprize.js";
import { owedCardContent } from "../module/scripts/views/chatcard.js";
import { logOwedNote, logTableHTML } from "../module/scripts/views/logtable.js";
import { wonCount } from "../module/scripts/core/tally.js";

const tick = () => new Promise(r => setTimeout(r, 0));

const POOLS = {
  p: { id: "p", name: "The hoard", pools: [], entries: [
    { uuid: "Item.coin", name: "Lucky Coin", img: "a.webp", rarity: "uncommon", weight: 1 },
    { uuid: "Item.tongue", name: "Flame Tongue", img: "b.webp", rarity: "rare", weight: 1 },
  ] },
  q: { id: "q", name: "Side stash", pools: [], entries: [
    { uuid: "Item.tongue", name: "Flame Tongue", img: "b.webp", rarity: "rare", weight: 1 },
    { uuid: "Item.cloak", name: "Cloak of Elvenkind", img: "c.webp", rarity: "rare", weight: 2 },
    { uuid: "Item.gone", name: "Lost Ring", img: "", rarity: "rare", weight: 1, missing: true },
  ] },
};
const SOURCES = {
  "Item.tongue": { name: "Flame Tongue", img: "b.webp", uuid: "Item.tongue", toObject: () => ({ _id: "src", name: "Flame Tongue", img: "b.webp", type: "weapon", system: { rarity: "rare", price: { value: 500, denomination: "gp" }, quantity: 1 } }) },
  "Item.cloak": { name: "Cloak of Elvenkind", img: "c.webp", uuid: "Item.cloak", toObject: () => ({ _id: "src2", name: "Cloak of Elvenkind", img: "c.webp", type: "equipment", system: { rarity: "rare" } }) },
};

function makeActor() {
  const actor = {
    id: "a1", name: "Tam", system: { currency: { pp: 0, gp: 100, ep: 0, sp: 0, cp: 0 } }, items: new Map(), made: 0,
    testUserPermission: () => true,
    async update(data) { await tick(); if (data["system.currency"]) actor.system.currency = data["system.currency"]; },
    async createEmbeddedDocuments(_type, datas) {
      await tick();
      return datas.map(data => {
        const id = `item${++actor.made}`;
        const item = { id, name: data.name, flags: data.flags, system: data.system, async delete() { await tick(); actor.items.delete(id); } };
        actor.items.set(id, item);
        return item;
      });
    },
    async deleteEmbeddedDocuments(_type, ids) { await tick(); for (const id of ids) actor.items.delete(id); },
  };
  return actor;
}

const messages = [];
function makeWorld(actor) {
  const settings = new Map();
  messages.length = 0;
  globalThis.game = {
    actors: { get: id => (id === actor.id ? actor : null) },
    messages: { contents: messages },
    settings: {
      register: (ns, key, { default: def }) => settings.set(`${ns}.${key}`, def),
      get: (ns, key) => settings.get(`${ns}.${key}`),
      async set(ns, key, value) { await tick(); settings.set(`${ns}.${key}`, value); },
    },
  };
  globalThis.foundry = { utils: { randomID: n => Math.random().toString(36).slice(2, 2 + n), deepClone: v => structuredClone(v), escapeHTML: s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;") } };
  globalThis.fromUuid = async uuid => SOURCES[uuid] ?? null;
  registerSettings();
}

const GAME = { id: "small", name: "Small Ticket", kind: "scratch", price: 5, pools: [{ id: "p", share: 1 }], rules: {} };
const OWED_ROW = { kind: "scratch", boxId: "small", boxName: "Small Ticket", actorId: "a1", actorName: "Tam", userId: "u1", itemId: null, rollId: 1, name: "Rare item", rarity: "rare", price: 5, payoutCp: 0, owed: [{ rarity: "rare" }], itemNames: [] };

async function seed(actor, row = OWED_ROW) {
  makeWorld(actor);
  await globalThis.game.settings.set("loot-crates", "boxes", { [GAME.id]: GAME });
  await globalThis.game.settings.set("loot-crates", "pools", POOLS);
  await appendLog(row);
  const id = getLog()[0].id;
  messages.push({ content: `<div class="loot-crates lc-chat lc-rarity-rare"><div class="lc-chat__name">Rare item</div><div class="lc-chat__owed">Owed by the GM: Rare item</div></div>`, flags: { "loot-crates": { logId: id } }, async update(data) { await tick(); Object.assign(this, data); } });
  return id;
}

afterEach(() => { delete globalThis.game; delete globalThis.foundry; delete globalThis.fromUuid; vi.restoreAllMocks(); });

describe("an owed item, in words", () => {
  it("names what a row owes and what was handed over", () => {
    expect(owedOf({ owed: [{ rarity: "rare" }, null, {}] })).toEqual([{ rarity: "rare" }]);
    expect(owedNote(OWED_ROW)).toBe("Owed: Rare item");
    expect(owedNote({ ...OWED_ROW, refunded: 5 })).toBe("");
    expect(owedNote({ name: "Wand" })).toBe("");
    expect(handedNote({ handed: [{ rarity: "rare", at: 1, name: "Flame Tongue" }, { rarity: "veryRare", at: 2, byHand: true }] })).toBe("Handed over by the GM: Flame Tongue and Very rare item");
    expect(owedCardLine({ owed: [{ rarity: "legendary" }], handed: [{ rarity: "rare", at: 1, name: "Flame Tongue" }] })).toBe("The GM handed over Flame Tongue. Owed by the GM: Legendary item");
  });

  it("offers every item at the rarity in any pool, once each, by name, and none that is missing", () => {
    expect(owedChoices(POOLS, "rare").map(c => [c.name, c.poolName])).toEqual([["Cloak of Elvenkind", "Side stash"], ["Flame Tongue", "The hoard"]]);
    expect(owedChoices(POOLS, "legendary")).toEqual([]);
    expect(owedChoices({}, "rare")).toEqual([]);
  });

  it("the row gains a picked item as one it granted; one given by hand only clears the debt", () => {
    const picked = handedPatch(OWED_ROW, { item: { id: "i9", name: "Flame Tongue", uuid: "Item.tongue", worth: { i9: { value: 500, denomination: "gp", quantity: 1 } } }, at: 7 });
    expect(picked).toEqual({ owed: [], handed: [{ rarity: "rare", at: 7, name: "Flame Tongue" }], itemId: "i9", itemIds: ["i9"], itemNames: ["Flame Tongue"], uuid: "Item.tongue", worth: { i9: { value: 500, denomination: "gp", quantity: 1 } }, name: "Flame Tongue" });
    expect(handedPatch(OWED_ROW, { at: 7 })).toEqual({ owed: [], handed: [{ rarity: "rare", at: 7, byHand: true }] });
    expect(handedPatch({ name: "Wand" })).toBeNull();
    // One granted beside one owed: its id, name and source stay first.
    const mixed = { ...OWED_ROW, itemId: "i1", itemIds: ["i1"], itemNames: ["Lucky Coin"], uuid: "Item.coin", name: "Legendary item and Lucky Coin", owed: [{ rarity: "legendary" }, { rarity: "rare" }] };
    expect(handedPatch(mixed, { item: { id: "i2", name: "Vorpal Sword", uuid: "Item.v" }, at: 1 })).toMatchObject({ itemId: "i1", itemIds: ["i1", "i2"], itemNames: ["Lucky Coin", "Vorpal Sword"], owed: [{ rarity: "rare" }], name: "Lucky Coin, Vorpal Sword and Rare item" });
    expect(handedPatch(mixed, { item: { id: "i2", name: "Vorpal Sword", uuid: "Item.v" }, at: 1 }).uuid).toBeUndefined();
  });

  it("the chat card says what was handed over in place of what was owed", () => {
    const card = `<div class="lc-chat"><div class="lc-chat__name">Rare item</div><div class="lc-chat__owed">Owed by the GM: Rare item</div></div>`;
    expect(owedCardContent(card, { line: "The GM handed over Flame Tongue." })).toBe(`<div class="lc-chat"><div class="lc-chat__name">Rare item</div><div class="lc-chat__owed">The GM handed over Flame Tongue.</div></div>`);
    expect(owedCardContent(`<div class="lc-chat"><b>x</b></div>`, { line: "A <b>" , esc: s => s.replace(/</g, "&lt;") })).toBe(`<div class="lc-chat"><b>x</b><div class="lc-chat__owed">A &lt;b></div></div>`);
    expect(owedCardContent(`<div class="lc-chat lc-chat--refunded"></div>`, { line: "x" })).toBe(`<div class="lc-chat lc-chat--refunded"></div>`);
  });

  it("the Pull log row says what is owed with Hand over under it, and nothing on a refunded row", () => {
    const row = { ...OWED_ROW, id: "r1", at: 1 };
    const note = logOwedNote(row);
    expect(note).toContain(`<small class="lc-log__owed">Owed: Rare item</small>`);
    expect(note).toContain(`data-action="handOver" data-row="r1"`);
    expect(note).toContain(`aria-label="Hand over to Tam. Owed: Rare item"`);
    expect(logOwedNote({ ...row, refunded: 3 })).toBe("");
    expect(logOwedNote({ ...row, owed: [], handed: [{ rarity: "rare", at: 2, name: "Flame Tongue" }] })).toBe(`<small class="lc-log__parted">Handed over by the GM: Flame Tongue</small>`);
    const html = logTableHTML({ log: [row] });
    expect(html).toContain(`data-action="handOver"`);
    expect(html).toContain(`data-action="refund"`);
  });
});

describe("handOver", () => {
  it("makes the picked item on the character, records it on the row and the tallies, and rewrites the chat card", async () => {
    const actor = makeActor();
    const id = await seed(actor);
    const plan = describeOwed(id);
    expect(plan).toMatchObject({ status: "ready", what: "Rare item" });
    expect(plan.choices.map(c => c.uuid)).toEqual(["Item.cloak", "Item.tongue"]);
    const done = await handOver(id, { uuid: "Item.tongue" });
    expect(done).toMatchObject({ status: "handed", itemName: "Flame Tongue" });
    expect(actor.items.size).toBe(1);
    const item = [...actor.items.values()][0];
    expect(item.flags["loot-crates"]).toMatchObject({ boxId: "small", sourceUuid: "Item.tongue" });
    const row = getLog()[0];
    expect(row).toMatchObject({ itemId: item.id, itemIds: [item.id], itemNames: ["Flame Tongue"], uuid: "Item.tongue", name: "Flame Tongue", owed: [], worth: { [item.id]: { value: 500, denomination: "gp", quantity: 1 } } });
    expect(row.handed).toMatchObject([{ rarity: "rare", name: "Flame Tongue" }]);
    expect(wonCount(getTally(), { boxId: "small", actorId: "a1", uuid: "Item.tongue" })).toBe(1);
    expect(messages[0].content).toContain(`<div class="lc-chat__owed">The GM handed over Flame Tongue.</div>`);
    // Once only.
    expect(await handOver(id, { uuid: "Item.tongue" })).toMatchObject({ status: "none" });
    expect(actor.items.size).toBe(1);
    // The one refund takes the handed item back with the price.
    const back = await refundPull(id);
    expect(back).toMatchObject({ status: "refunded", removedItem: "Flame Tongue" });
    expect(actor.items.size).toBe(0);
    expect(actor.system.currency.gp).toBe(105);
  });

  it("given by hand: nothing is made, the debt is cleared and the row says so", async () => {
    const actor = makeActor();
    const id = await seed(actor);
    const done = await handOver(id);
    expect(done).toMatchObject({ status: "handed", itemName: null });
    expect(actor.items.size).toBe(0);
    expect(getLog()[0]).toMatchObject({ owed: [], name: "Rare item", itemId: null });
    expect(getLog()[0].handed).toMatchObject([{ rarity: "rare", byHand: true }]);
    expect(messages[0].content).toContain("The GM handed over Rare item.");
  });

  it("refuses a refunded row, an item no pool offers and a source that is gone, and makes nothing", async () => {
    const actor = makeActor();
    const id = await seed(actor);
    expect(await handOver(id, { uuid: "Item.coin" })).toMatchObject({ status: "gone" });
    expect(await handOver(id, { uuid: "Item.gone" })).toMatchObject({ status: "gone" });
    delete SOURCES["Item.cloak"];
    expect(await handOver(id, { uuid: "Item.cloak" })).toMatchObject({ status: "gone" });
    expect(actor.items.size).toBe(0);
    expect(getLog()[0].owed).toEqual([{ rarity: "rare" }]);
    await refundPull(id);
    expect(await handOver(id, { uuid: "Item.tongue" })).toMatchObject({ status: "refunded" });
    expect(actor.items.size).toBe(0);
    expect(describeOwed("nope").status).toBe("missing");
  });

  it("takes the item back when the row can't be written, so a retry can't hand over twice", async () => {
    const actor = makeActor();
    const id = await seed(actor);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const set = globalThis.game.settings.set;
    globalThis.game.settings.set = async () => { throw new Error("disk full"); };
    await expect(handOver(id, { uuid: "Item.tongue" })).rejects.toThrow("disk full");
    expect(actor.items.size).toBe(0);
    globalThis.game.settings.set = set;
    expect(await handOver(id, { uuid: "Item.tongue" })).toMatchObject({ status: "handed" });
    expect(actor.items.size).toBe(1);
  });

  it("a cancelled creation leaves the item owed", async () => {
    const actor = makeActor();
    const id = await seed(actor);
    vi.spyOn(console, "error").mockImplementation(() => {});
    actor.createEmbeddedDocuments = async () => [];
    expect(await handOver(id, { uuid: "Item.tongue" })).toMatchObject({ status: "failed", message: "Flame Tongue could not be put on Tam's sheet. It is still owed." });
    expect(getLog()[0].owed).toEqual([{ rarity: "rare" }]);
  });
});
