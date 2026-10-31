/*
  Tickets in a fake world: the sheet's Use asks the GM and cancels dnd5e's
  own use, only for a ticket; the GM plays it through the same queue and
  core as a purchase at price 0, spends exactly one ticket and only when
  the play goes through, and a refund gives the ticket back.
*/
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../module/scripts/foundry/reveal.js", () => ({ showReveal: vi.fn(async () => ({ landed: Promise.resolve() })) }));
vi.mock("../module/scripts/foundry/chat.js", () => ({ postPullCard: vi.fn(async () => null) }));

const { registerSocket, requestRedeem } = await import("../module/scripts/foundry/socket.js");
const { registerSettings, setStoreListener, getLog, appendLog, getBoxes } = await import("../module/scripts/foundry/store.js");
const { refundPull } = await import("../module/scripts/foundry/refund.js");
const { ticketUseHook, ticketToRedeem, spendTicket, returnTicket } = await import("../module/scripts/foundry/tickets.js");
const { ticketData } = await import("../module/scripts/games/ticket.js");
const { PullError } = await import("../module/scripts/foundry/pull.js");
const { toCopper } = await import("../module/scripts/core/currency.js");
const { boughtBy } = await import("../module/scripts/core/limits.js");

const tick = () => new Promise(r => setTimeout(r, 0));
const GM = { id: "gm", name: "Gamemaster" };
const PLAYER = { id: "p1", name: "Player" };
const STRANGER = { id: "p2", name: "Stranger" };

// An embedded item as a test sees one: update and delete write through to
// the actor's collection after a tick, as a document does.
function makeItem(actor, data) {
  const item = {
    ...structuredClone(data),
    get actor() { return actor; },
    parent: actor,
    toObject() { const { id, ...rest } = this; return structuredClone({ _id: id, name: rest.name, type: rest.type, img: rest.img, system: rest.system, flags: rest.flags }); },
    async update(change) {
      await tick();
      actor.writes.push({ item: item.id, change });
      if ("system.quantity" in change) item.system.quantity = change["system.quantity"];
    },
    async delete() { await tick(); actor.writes.push({ deleted: item.id }); actor.items.delete(item.id); },
  };
  return item;
}

function makeActor({ gp = 100, grantFails = false } = {}) {
  let n = 0;
  const actor = {
    id: "actor1", name: "Crate Tester", documentName: "Actor", writes: [],
    system: { currency: { pp: 0, gp, ep: 0, sp: 0, cp: 0 } },
    items: new Map(),
    testUserPermission: user => user.id !== STRANGER.id,
    async update(data) { await tick(); actor.writes.push({ purse: data["system.currency"] }); actor.system.currency = data["system.currency"]; },
    async createEmbeddedDocuments(_type, docs, opts = {}) {
      await tick();
      if (grantFails && !docs.some(d => d.flags?.["loot-crates"]?.ticket)) throw new Error("Item validation failed");
      return docs.map(d => {
        const id = opts.keepId && d._id ? d._id : `made${++n}`;
        const { _id, ...rest } = d;
        const item = makeItem(actor, { id, ...rest });
        actor.items.set(id, item);
        return item;
      });
    },
    async deleteEmbeddedDocuments(_type, ids) { await tick(); for (const id of ids) actor.items.delete(id); },
  };
  return actor;
}

function addTicket(actor, box, quantity = 1, id = "tix") {
  const data = ticketData(box);
  data.system.quantity = quantity;
  const item = makeItem(actor, { id, ...data });
  actor.items.set(id, item);
  return item;
}

function makeWorld({ user = GM, actor = makeActor() } = {}) {
  const settings = new Map();
  const onChange = new Map();
  const handlers = [];
  const emitted = [];
  globalThis.game = {
    user,
    users: { activeGM: GM, get: id => [GM, PLAYER, STRANGER].find(u => u.id === id) ?? null },
    actors: { get: id => (id === actor.id ? actor : null) },
    settings: {
      register: (ns, key, { default: def, onChange: fn }) => { settings.set(`${ns}.${key}`, def); if (fn) onChange.set(`${ns}.${key}`, fn); },
      get: (ns, key) => settings.get(`${ns}.${key}`),
      async set(ns, key, value) { await tick(); settings.set(`${ns}.${key}`, value); onChange.get(`${ns}.${key}`)?.(value); },
    },
    socket: { on: (_n, fn) => handlers.push(fn), emit: (_n, msg) => emitted.push(msg) },
    messages: { contents: [] },
  };
  globalThis.foundry = { utils: { randomID: n => Math.random().toString(36).slice(2, 2 + n), deepClone: v => structuredClone(v), escapeHTML: s => String(s) } };
  globalThis.fromUuid = async uuid => ({ name: `Item ${uuid}`, img: "", toObject: () => ({ name: `Item ${uuid}`, type: "loot", flags: {} }) });
  registerSettings();
  registerSocket();
  const deliver = msg => Promise.all(handlers.map(h => h(msg)));
  return { actor, emitted, deliver };
}

const POOL = { id: "pool", name: "Pool", pools: [], entries: ["a", "b", "c"].map(u => ({ uuid: u, name: u, img: "", rarity: "common", weight: 1 })) };
const CRATE = { id: "box", name: "Test Crate", price: 10, pools: [{ id: "pool", share: 1 }], weights: { common: 1 }, rules: {} };
// A roll of one ticket with no prizes: one dud, then sold out.
const SCRATCH = { id: "scratch", kind: "scratch", name: "Fortune", price: 5, pools: [], weights: {}, layout: "lucky", grid: { cols: 4, rows: 3 }, bonus: { on: false, gp: 0 }, roll: { id: 1, size: 1, prizes: [] }, rules: {} };
const WHEEL = { id: "wheel", kind: "roulette", name: "Wheel", price: 5, pools: [], rules: {} };

async function seed(boxes = [CRATE]) {
  await globalThis.game.settings.set("loot-crates", "pools", { pool: POOL });
  await globalThis.game.settings.set("loot-crates", "boxes", Object.fromEntries(boxes.map(b => [b.id, b])));
}

const redeem = (over = {}) => ({ type: "redeem", requestId: `r${Math.random()}`, actorId: "actor1", itemId: "tix", userId: "p1", ...over });
const errorsTo = emitted => emitted.filter(m => m.type === "error").map(m => m.message);

afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.game;
  delete globalThis.foundry;
  delete globalThis.fromUuid;
  delete globalThis.ui;
  setStoreListener(null);
});

describe("the sheet's Use (ticketUseHook)", () => {
  const activityOf = item => ({ item });

  it("cancels a ticket's use and asks the GM to play it, from the user who pressed it", async () => {
    const actor = makeActor();
    const ticket = addTicket(actor, CRATE);
    const request = vi.fn(async () => ({}));
    expect(ticketUseHook(request)(activityOf(ticket))).toBe(false);
    await tick();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ actorId: "actor1", itemId: "tix" });
  });

  it("lets any other item's use go on, and asks nothing", async () => {
    const actor = makeActor();
    const potion = makeItem(actor, { id: "pot", name: "Potion", type: "consumable", system: { quantity: 1 }, flags: { "loot-crates": { boxId: "box", sourceUuid: "x" } } });
    const request = vi.fn();
    const hook = ticketUseHook(request);
    expect(hook(activityOf(potion))).toBeUndefined();
    expect(hook({})).toBeUndefined();
    expect(hook(undefined)).toBeUndefined();
    await tick();
    expect(request).not.toHaveBeenCalled();
  });

  it("shows the GM's refusal as a warning", async () => {
    const actor = makeActor();
    const ticket = addTicket(actor, CRATE);
    const warn = vi.fn();
    ticketUseHook(async () => { throw new PullError("This ticket's game is gone."); }, warn)(activityOf(ticket));
    await tick(); await tick();
    expect(warn).toHaveBeenCalledWith("This ticket's game is gone.");
  });

  it("sends a redeem over the socket from a player's client", () => {
    const { emitted } = makeWorld({ user: PLAYER });
    requestRedeem({ actorId: "actor1", itemId: "tix" });
    expect(emitted[0]).toMatchObject({ type: "redeem", actorId: "actor1", itemId: "tix", userId: "p1" });
    expect(emitted[0].requestId).toBeTruthy();
  });
});

describe("the GM's guards on a redeem: nothing is spent", () => {
  it("refuses a user who doesn't own the character", async () => {
    const { actor, emitted, deliver } = makeWorld();
    await seed();
    addTicket(actor, CRATE);
    await deliver(redeem({ userId: "p2" }));
    expect(errorsTo(emitted)).toEqual(["You don't own that character."]);
    expect(actor.items.get("tix").system.quantity).toBe(1);
    expect(actor.writes).toEqual([]);
  });

  it("refuses a ticket no longer on the character, and one at quantity 0", async () => {
    const { actor, emitted, deliver } = makeWorld();
    await seed();
    await deliver(redeem());
    addTicket(actor, CRATE, 0);
    await deliver(redeem());
    expect(errorsTo(emitted)).toEqual(["That ticket is no longer in Crate Tester's pack, so nothing was played.", "That ticket is no longer in Crate Tester's pack, so nothing was played."]);
    expect(actor.writes).toEqual([]);
  });

  it("refuses a ticket whose game is gone, and one for a table game", async () => {
    const { actor, emitted, deliver } = makeWorld();
    await seed([CRATE, WHEEL]);
    addTicket(actor, { ...CRATE, id: "deleted" }, 1, "tix");
    await deliver(redeem());
    addTicket(actor, WHEEL, 1, "wheelTix");
    await deliver(redeem({ itemId: "wheelTix" }));
    expect(errorsTo(emitted)).toEqual(["This ticket's game is gone, so the ticket stays in your pack as a keepsake.", "This ticket's game is gone, so the ticket stays in your pack as a keepsake."]);
    expect(actor.writes).toEqual([]);
    expect(getLog()).toHaveLength(0);
  });

  it("leaves the ticket when the kind's own guard refuses (a sold-out scratch roll)", async () => {
    const { actor, emitted, deliver } = makeWorld();
    await seed([SCRATCH]);
    await appendLog({ kind: "scratch", boxId: "scratch", boxName: "Fortune", actorId: "x", actorName: "X", rollId: 1, tier: "dud", price: 5, payoutCp: 0, name: "Dud" });
    addTicket(actor, SCRATCH, 2);
    await deliver(redeem());
    expect(errorsTo(emitted)).toEqual(["Fortune is sold out. Ask the GM to print a new roll."]);
    expect(actor.items.get("tix").system.quantity).toBe(2);
    expect(actor.writes).toEqual([]);
  });

  it("plays a ticket whose game is off the shelf, or with the shop closed (it is in the pack)", async () => {
    const { actor, emitted, deliver } = makeWorld();
    await seed([{ ...CRATE, rules: { shelved: false } }]);
    await globalThis.game.settings.set("loot-crates", "shopOpen", false);
    addTicket(actor, CRATE);
    await deliver(redeem());
    expect(errorsTo(emitted)).toEqual([]);
    expect(emitted.filter(m => m.type === "reveal")).toHaveLength(1);
  });

  it("plays a ticket the GM handed out past the limit per character, and doesn't count it (Leigh, 2026-10-30)", async () => {
    const { actor, emitted, deliver } = makeWorld();
    const LIMITED = { ...CRATE, rules: { perCharacter: { max: 1, per: "ever" } } };
    await seed([LIMITED]);
    // The character has bought its one already.
    await appendLog({ id: "bought", kind: "crate", boxId: "box", actorId: "actor1", price: 10, at: Date.now() });
    addTicket(actor, LIMITED, 2);
    await deliver(redeem());
    await deliver(redeem());
    expect(errorsTo(emitted)).toEqual([]);
    expect(emitted.filter(m => m.type === "reveal")).toHaveLength(2);
    expect(boughtBy(getLog(), { boxId: "box", actorId: "actor1" })).toBe(1);
  });
});

describe("a redeem on the GM", () => {
  it("spends exactly one from a stack of three, moves no coins, and logs and reveals it as a ticket's play", async () => {
    const { actor, emitted, deliver } = makeWorld();
    await seed([{ ...CRATE, rules: { stock: 4 } }]);
    addTicket(actor, CRATE, 3);
    const purse = { ...actor.system.currency };
    await deliver(redeem());
    expect(actor.items.get("tix").system.quantity).toBe(2);
    expect(actor.system.currency).toEqual(purse);
    expect(actor.writes.filter(w => w.purse)).toEqual([]);
    const granted = [...actor.items.values()].filter(i => i.id !== "tix");
    expect(granted).toHaveLength(1);

    const reveal = emitted.find(m => m.type === "reveal");
    expect(reveal).toMatchObject({ userId: "p1", actorId: "actor1", box: { id: "box", price: 0 }, redeem: { itemName: "Test Crate ticket", paid: 0 } });
    expect(JSON.stringify(reveal)).not.toContain("activities");
    const row = getLog()[0];
    expect(row).toMatchObject({ boxId: "box", price: 0, payoutCp: 0, redeem: { itemId: "tix", itemName: "Test Crate ticket", paid: 0 } });
    expect(row.redeem.data.system.quantity).toBe(1);
    // A ticket was sold (or given) already: its play takes no stock.
    expect(getBoxes().box.rules.stock).toBe(4);
  });

  it("deletes the ticket with the last of the stack", async () => {
    const { actor, deliver } = makeWorld();
    await seed();
    addTicket(actor, CRATE, 1);
    await deliver(redeem());
    expect(actor.items.has("tix")).toBe(false);
  });

  it("spends nothing when the grant fails", async () => {
    const { actor, emitted, deliver } = makeWorld({ actor: makeActor({ grantFails: true }) });
    await seed();
    addTicket(actor, CRATE, 3);
    const err = console.error;
    console.error = () => {};
    try { await deliver(redeem()); } finally { console.error = err; }
    expect(errorsTo(emitted)).toEqual(["The prize couldn't be added, so your ticket is back in your pack."]);
    expect(actor.items.get("tix").system.quantity).toBe(3);
    expect(toCopper(actor.system.currency)).toBe(10000);
    expect(getLog()).toHaveLength(0);
    expect(emitted.filter(m => m.type === "reveal")).toHaveLength(0);
  });

  it("puts the last ticket back with its id when the grant fails after it was deleted", async () => {
    const { actor, deliver } = makeWorld({ actor: makeActor({ grantFails: true }) });
    await seed();
    addTicket(actor, CRATE, 1);
    const err = console.error;
    console.error = () => {};
    try { await deliver(redeem()); } finally { console.error = err; }
    expect(actor.items.get("tix")?.flags["loot-crates"].ticket.boxId).toBe("box");
  });
});

describe("refunding a ticket's play", () => {
  it("gives the ticket back on its stack, takes the prize back, and returns no coins", async () => {
    const { actor, deliver } = makeWorld();
    await seed([{ ...CRATE, rules: { stock: 4 } }]);
    addTicket(actor, CRATE, 3);
    await deliver(redeem());
    const purse = { ...actor.system.currency };
    const out = await refundPull(getLog()[0].id);
    expect(out.status).toBe("refunded");
    expect(out.ticketBack).toBe("stack");
    expect(actor.items.get("tix").system.quantity).toBe(3);
    expect([...actor.items.values()].map(i => i.id)).toEqual(["tix"]);
    expect(actor.system.currency).toEqual(purse);
    expect(getBoxes().box.rules.stock).toBe(4);
  });

  it("makes the ticket again from the row when the stack was used up", async () => {
    const { actor, deliver } = makeWorld();
    await seed();
    addTicket(actor, CRATE, 1);
    await deliver(redeem());
    expect(actor.items.has("tix")).toBe(false);
    const out = await refundPull(getLog()[0].id);
    expect(out.ticketBack).toBe("made");
    const back = [...actor.items.values()];
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ name: "Test Crate ticket", type: "consumable", system: { quantity: 1 }, flags: { "loot-crates": { ticket: { boxId: "box", paid: 0 } } } });
  });
});

describe("the ticket helpers", () => {
  it("ticketToRedeem reads the row before anything is spent", () => {
    const actor = makeActor();
    addTicket(actor, CRATE, 2);
    const { item, box, row } = ticketToRedeem(actor, "tix", { box: CRATE });
    expect(item.id).toBe("tix");
    expect(box).toBe(CRATE);
    expect(row).toMatchObject({ itemId: "tix", itemName: "Test Crate ticket", paid: 0 });
    expect(row.data.system.quantity).toBe(1);
    expect(row.data._id).toBeUndefined();
  });

  it("spendTicket's undo puts the quantity back, and returnTicket adds to a stack of the same game only", async () => {
    const actor = makeActor();
    const item = addTicket(actor, CRATE, 2);
    const undo = await spendTicket(actor, item);
    expect(item.system.quantity).toBe(1);
    await undo();
    expect(item.system.quantity).toBe(2);
    // A stack of another game's tickets that took the id is left alone.
    addTicket(actor, { ...CRATE, id: "other" }, 5, "tix");
    expect(await returnTicket(actor, { boxId: "box", boxName: "Test Crate", redeem: { itemId: "tix", data: ticketData(CRATE) } })).toBe("made");
    expect(actor.items.get("tix").system.quantity).toBe(5);
  });
});
