/*
  Refunding a logged pull with a fake `game`: coin-exact in whole coins, once
  only, removes only the item it granted, and puts the box's stock back.
*/
import { describe, it, expect, afterEach, vi } from "vitest";
import { registerSettings, appendLog, getLog, getBoxes, getActorState, enqueueWrite } from "../module/scripts/foundry/store.js";
import { refundPull, describeRefund, grantedItem } from "../module/scripts/foundry/refund.js";
import { toCopper, isWholeCoins } from "../module/scripts/core/currency.js";

const tick = () => new Promise(r => setTimeout(r, 0));

function makeActor(currency, items = []) {
  const actor = {
    id: "actor1", name: "Crate Tester", updates: 0,
    system: { currency: { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0, ...currency } },
    items: new Map(items.map(i => [i.id, { ...i, async delete() { await tick(); actor.items.delete(i.id); } }])),
    async update(data) { await tick(); actor.updates++; if (data["system.currency"]) actor.system.currency = data["system.currency"]; },
  };
  return actor;
}

function makeWorld(actor) {
  const settings = new Map();
  globalThis.game = {
    actors: { get: id => (id === actor.id ? actor : null) },
    settings: {
      register: (ns, key, { default: def }) => settings.set(`${ns}.${key}`, def),
      get: (ns, key) => settings.get(`${ns}.${key}`),
      async set(ns, key, value) { await tick(); settings.set(`${ns}.${key}`, value); },
    },
  };
  globalThis.foundry = { utils: { randomID: n => Math.random().toString(36).slice(2, 2 + n), deepClone: v => structuredClone(v) } };
  registerSettings();
}

const BOX = { id: "box", name: "Test Crate", price: 17.35, pools: [], weights: {}, rules: { stock: 2 } };
const ROW = { boxId: "box", boxName: "Test Crate", actorId: "actor1", actorName: "Crate Tester", userId: "p1", itemId: "item1", name: "Wand", uuid: "Compendium.dnd5e.items.Item.abc", rarity: "rare", price: 17.35 };
const GRANTED = { id: "item1", name: "Wand", flags: { "loot-crates": { boxId: "box", sourceUuid: "Compendium.dnd5e.items.Item.abc" } } };

async function seed(actor, { box = BOX, row = ROW } = {}) {
  makeWorld(actor);
  await globalThis.game.settings.set("loot-crates", "boxes", box ? { [box.id]: box } : {});
  await appendLog(row);
  return getLog()[0].id;
}

afterEach(() => { delete globalThis.game; delete globalThis.foundry; });

describe("refundPull", () => {
  it("returns the exact copper in whole coins, removes the granted item and restores stock", async () => {
    const actor = makeActor({ gp: 482, sp: 6, cp: 5 }, [GRANTED]);
    const rowId = await seed(actor);
    const before = toCopper(actor.system.currency);
    const out = await refundPull(rowId);
    expect(out.status).toBe("refunded");
    expect(out.removedItem).toBe("Wand");
    expect(actor.system.currency).toEqual({ pp: 0, gp: 500, ep: 0, sp: 0, cp: 0 });
    expect(toCopper(actor.system.currency)).toBe(before + 1735);
    expect(isWholeCoins(actor.system.currency)).toBe(true);
    expect(actor.items.has("item1")).toBe(false);
    expect(getBoxes().box.rules.stock).toBe(3);
    expect(getLog()[0].refunded).toBeTypeOf("number");
  });

  it("is a no-op the second time, even when both clicks land together", async () => {
    const actor = makeActor({ gp: 500 }, [GRANTED]);
    const rowId = await seed(actor);
    const [a, b] = await Promise.all([refundPull(rowId), refundPull(rowId)]);
    expect([a.status, b.status].sort()).toEqual(["already", "refunded"]);
    const third = await refundPull(rowId);
    expect(third.status).toBe("already");
    expect(actor.updates).toBe(1);
    expect(actor.system.currency.gp).toBe(517);
    expect(getBoxes().box.rules.stock).toBe(3);
  });

  it("only deletes the item carrying this pull's flag, and says so", async () => {
    const stranger = { id: "item1", name: "Player's own wand", flags: {} };
    const actor = makeActor({ gp: 500 }, [stranger]);
    const rowId = await seed(actor);
    expect(grantedItem(getLog()[0], actor)).toBeNull();
    expect(describeRefund(rowId).item).toBeNull();
    const out = await refundPull(rowId);
    expect(out.status).toBe("refunded");
    expect(out.removedItem).toBeNull();
    expect(actor.items.has("item1")).toBe(true);
    expect(actor.system.currency.gp).toBe(517);
  });

  it("refunds coins when the item is already gone and leaves unlimited stock alone", async () => {
    const actor = makeActor({ gp: 500 });
    const rowId = await seed(actor, { box: { ...BOX, rules: {} } });
    const out = await refundPull(rowId);
    expect(out).toMatchObject({ status: "refunded", removedItem: null, stock: null });
    expect(getBoxes().box.rules).toEqual({});
  });

  it("marks the row before the purse write, so a failed write can't be paid twice", async () => {
    const actor = makeActor({ gp: 500 }, [GRANTED]);
    actor.update = async () => { throw new Error("network blip"); };
    const rowId = await seed(actor);
    await expect(refundPull(rowId)).rejects.toThrow("network blip");
    expect(getLog()[0].refunded).toBeTypeOf("number");
    expect((await refundPull(rowId)).status).toBe("already");
  });

  it("reports a missing row or character without writing", async () => {
    const actor = makeActor({ gp: 500 });
    const rowId = await seed(actor, { row: { ...ROW, actorId: "ghost" } });
    expect((await refundPull("nope")).status).toBe("missing");
    expect((await refundPull(rowId)).status).toBe("no-actor");
    expect(getLog()[0].refunded).toBeUndefined();
  });
});

/*
  The refund also undoes the pull's record for the character: the pity
  count and the no-duplicates list (odds.js undoPull), in the same queued
  write as the coins and stock, and only once.
*/
describe("refundPull and the buyer's pity and no-duplicates record", () => {
  const RULED = { ...BOX, rules: { stock: 2, pity: { after: 3, minRarity: "rare" }, noDuplicates: true } };
  // The Wand was a Rare that reset a pity count of 2.
  const PULLED = { ...ROW, before: { sinceRare: 2 }, resetPity: true };

  async function seedState(actor, state) {
    const rowId = await seed(actor, { box: RULED, row: PULLED });
    await globalThis.game.settings.set("loot-crates", "actorState", { "actor1.box": state });
    const writes = [];
    const set = globalThis.game.settings.set;
    globalThis.game.settings.set = async (ns, key, value) => { if (key === "actorState") writes.push(structuredClone(value)); return set(ns, key, value); };
    return { rowId, writes };
  }

  it("puts the pity count and the item back in the same queued write as the coins", async () => {
    const actor = makeActor({ gp: 500 }, [GRANTED]);
    const { rowId, writes } = await seedState(actor, { sinceRare: 0, owned: [ROW.uuid], pulls: 3 });
    const shown = describeRefund(rowId).state;
    expect(shown.after).toEqual({ sinceRare: 2, owned: [], pulls: 2 });
    const pending = refundPull(rowId);
    // Whatever is queued next sees the refund whole: coins, stock and state.
    const next = enqueueWrite(() => ({ gp: actor.system.currency.gp, stock: getBoxes().box.rules.stock, state: getActorState("actor1", "box") }));
    const out = await pending;
    expect(out.state).toEqual({ before: { sinceRare: 0, owned: [ROW.uuid], pulls: 3 }, after: shown.after });
    expect(await next).toEqual({ gp: 517, stock: 3, state: { sinceRare: 2, owned: [], pulls: 2 } });
    expect(writes).toHaveLength(1);
  });

  it("writes nothing the second time", async () => {
    const actor = makeActor({ gp: 500 }, [GRANTED]);
    const { rowId, writes } = await seedState(actor, { sinceRare: 1, owned: [ROW.uuid, "other"], pulls: 4 });
    const [a, b] = await Promise.all([refundPull(rowId), refundPull(rowId)]);
    expect([a.status, b.status].sort()).toEqual(["already", "refunded"]);
    expect((await refundPull(rowId)).status).toBe("already");
    expect(writes).toHaveLength(1);
    expect(getActorState("actor1", "box")).toEqual({ sinceRare: 3, owned: ["other"], pulls: 3 });
  });

  // The coins and the item are back by then: a failed state write is the
  // GM's to fix, reported, and the refund still finishes (the card is
  // marked and the manager posts its refund card), as with the chat write.
  it("finishes the refund when the state write fails, and says so", async () => {
    const actor = makeActor({ gp: 500 }, [GRANTED]);
    const { rowId } = await seedState(actor, { sinceRare: 0, owned: [ROW.uuid], pulls: 3 });
    const card = message("m1", { uuid: ROW.uuid, logId: rowId });
    globalThis.game.messages = { contents: [card] };
    globalThis.foundry.utils.escapeHTML = escapeHTML;
    const set = globalThis.game.settings.set;
    globalThis.game.settings.set = async (ns, key, value) => { if (key === "actorState") throw new Error("socket down"); return set(ns, key, value); };
    const notify = vi.fn();
    globalThis.ui = { notifications: { error: notify } };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await refundPull(rowId);
      expect(out).toMatchObject({ status: "refunded", removedItem: "Wand", card: true, state: null });
      expect(actor.system.currency.gp).toBe(517);
      expect(err).toHaveBeenCalled();
      expect(notify.mock.calls[0][0]).toMatch(/pity count/);
    } finally { err.mockRestore(); delete globalThis.ui; }
  });

  it("leaves a deleted box's state alone", async () => {
    const actor = makeActor({ gp: 500 }, [GRANTED]);
    const rowId = await seed(actor, { box: null, row: PULLED });
    const out = await refundPull(rowId);
    expect(out).toMatchObject({ status: "refunded", state: null });
    expect(getActorState("actor1", "box")).toEqual({});
  });
});

/*
  The pull's chat card after a refund: the one card announcing this row is
  rewritten once (muted, struck through, linked to the pool's source, with
  the time), and no other card is touched.
*/
const { refundedCardContent, findPullCard, LEGACY_WINDOW_MS } = await import("../module/scripts/views/chatcard.js");

const escapeHTML = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const CARD = `
    <div class="loot-crates lc-chat lc-rarity-rare">
      <div class="lc-chat__head">Crate Tester opened <strong>Test Crate</strong> <span class="lc-chat__price">17 gp 3 sp 5 cp</span></div>
      <div class="lc-chat__item">
        <img src="icons/wand.webp" alt="">
        <div>
          <div class="lc-chat__name"><a class="content-link" draggable="true" data-link data-uuid="Actor.actor1.Item.item1" data-type="Item" data-tooltip="Item"><i class="fa-solid fa-suitcase" inert></i>Wand</a></div>
          <div class="lc-chat__rarity">Rare</div>
        </div>
      </div>
    </div>`;

function message(id, flags, { actor = "actor1", timestamp = Date.now(), content = CARD } = {}) {
  const msg = {
    id, content, timestamp, speaker: { actor }, flags: { "loot-crates": flags },
    update: vi.fn(async data => { await tick(); msg.content = data.content; msg.flags["loot-crates"].refundedAt = data["flags.loot-crates.refundedAt"]; }),
  };
  return msg;
}

async function seedWithChat(actor, messages) {
  const rowId = await seed(actor);
  globalThis.game.messages = { contents: messages(rowId) };
  globalThis.foundry.utils.escapeHTML = escapeHTML;
  return rowId;
}

describe("the refunded pull's chat card", () => {
  it("rewrites exactly the card carrying this row's logId, once", async () => {
    const actor = makeActor({ gp: 500 }, [GRANTED]);
    let mine, other;
    const rowId = await seedWithChat(actor, id => [
      (mine = message("m1", { uuid: ROW.uuid, boxId: "box", logId: id })),
      (other = message("m2", { uuid: ROW.uuid, boxId: "box", logId: "someone-else" })),
    ]);
    const out = await refundPull(rowId);
    expect(out.card).toBe(true);
    expect(mine.update).toHaveBeenCalledTimes(1);
    expect(other.update).not.toHaveBeenCalled();
    expect(mine.content).toContain("lc-chat--refunded");
    expect(mine.content).not.toContain('data-uuid="Actor.');
    expect(mine.content).toContain(`data-uuid="${ROW.uuid}"`);
    expect(mine.content).toContain("<s>Wand</s>");
    expect(mine.content).toMatch(/Refunded <time datetime="[^"]+">[^<]+<\/time>/);
    expect(mine.flags["loot-crates"].refundedAt).toBe(getLog()[0].refunded);
    expect(other.content).toBe(CARD);

    expect((await refundPull(rowId)).status).toBe("already");
    expect(mine.update).toHaveBeenCalledTimes(1);
  });

  it("matches a card from before logId by source, buyer and time, and leaves near misses alone", async () => {
    const actor = makeActor({ gp: 500 }, [GRANTED]);
    const now = Date.now();
    let legacy, refundCard, otherActor, tooOld;
    const rowId = await seedWithChat(actor, () => [
      (tooOld = message("m0", { uuid: ROW.uuid, boxId: "box" }, { timestamp: now - LEGACY_WINDOW_MS - 5000 })),
      (legacy = message("m1", { uuid: ROW.uuid, boxId: "box" }, { timestamp: now + 7000 })),
      (otherActor = message("m2", { uuid: ROW.uuid, boxId: "box" }, { actor: "actor2", timestamp: now + 8000 })),
      (refundCard = message("m3", { uuid: ROW.uuid, boxId: "box", refunded: true }, { timestamp: now + 9000 })),
    ]);
    await refundPull(rowId);
    expect(legacy.update).toHaveBeenCalledTimes(1);
    expect(legacy.content).toContain("lc-chat--refunded");
    for (const m of [tooOld, otherActor, refundCard]) expect(m.update).not.toHaveBeenCalled();
  });

  it("refunds anyway when there is no card, or the card write fails", async () => {
    const actor = makeActor({ gp: 500 }, [GRANTED]);
    const rowId = await seedWithChat(actor, () => []);
    expect((await refundPull(rowId)).card).toBe(false);

    const actor2 = makeActor({ gp: 500 }, [GRANTED]);
    let broken;
    const rowId2 = await seedWithChat(actor2, id => [(broken = message("m1", { uuid: ROW.uuid, logId: id }))]);
    broken.update.mockRejectedValue(new Error("socket down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await refundPull(rowId2);
    expect(out).toMatchObject({ status: "refunded", card: false, removedItem: "Wand" });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("refundedCardContent", () => {
  const row = { id: "r1", name: "Wand <of> \"Doom\"", uuid: "Compendium.dnd5e.items.Item.abc", refunded: Date.UTC(2026, 9, 20, 14, 5) };

  it("mutes the card, strikes the name, links the source and stamps the time", () => {
    const out = refundedCardContent(CARD, row, { esc: escapeHTML, when: "20 Oct 2026, 14:05" });
    expect(out).toContain('class="loot-crates lc-chat lc-rarity-rare lc-chat--refunded"');
    expect(out).not.toMatch(/data-uuid="Actor\./);
    expect(out).toContain('data-uuid="Compendium.dnd5e.items.Item.abc"');
    expect(out).toContain("<s>Wand &lt;of&gt; &quot;Doom&quot;</s>");
    expect(out).toContain('Refunded <time datetime="2026-10-20T14:05:00.000Z">20 Oct 2026, 14:05</time>');
    expect(out.trim().endsWith("</div>")).toBe(true);
  });

  it("is idempotent", () => {
    const once = refundedCardContent(CARD, row, { esc: escapeHTML, when: "x" });
    expect(refundedCardContent(once, row, { esc: escapeHTML, when: "y" })).toBe(once);
  });

  it("finds nothing in an empty chat", () => {
    expect(findPullCard([], row)).toBeNull();
    expect(findPullCard(undefined, row)).toBeNull();
  });
});
