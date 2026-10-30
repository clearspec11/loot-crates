/*
  Buy to keep in a fake world: the shop's second button charges a purchase
  through the same guards and the one settle(), puts a ticket in the pack
  (stacking onto a kept ticket of the same game at the same price), writes
  a row no game counts as a play, and a refund takes one ticket back and
  returns its price, or refuses when none is left.
*/
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../module/scripts/foundry/reveal.js", () => ({ showReveal: vi.fn(async () => ({ landed: Promise.resolve() })) }));
const postKeptCard = vi.fn(async () => null);
vi.mock("../module/scripts/foundry/chat.js", () => ({ postPullCard: vi.fn(async () => null), postKeptCard: (...a) => postKeptCard(...a) }));

const { registerSocket, requestKeep } = await import("../module/scripts/foundry/socket.js");
const { registerSettings, setStoreListener, getLog, getBoxes } = await import("../module/scripts/foundry/store.js");
const { refundPull, describeRefund } = await import("../module/scripts/foundry/refund.js");
const { ticketData, ticketOf, keptStack, keptTicketFor, keepRow, rowPriceTag } = await import("../module/scripts/games/ticket.js");
const { cardShell } = await import("../module/scripts/views/boxcard.js");
const { boughtBy } = await import("../module/scripts/core/limits.js");
const { throwsToday } = await import("../module/scripts/games/well.js");
const { streakOf, nextPrice, drawnIds } = await import("../module/scripts/games/deck.js");
const { rollRows } = await import("../module/scripts/games/scratch.js");
const { toCopper } = await import("../module/scripts/core/currency.js");

const tick = () => new Promise(r => setTimeout(r, 0));
const GM = { id: "gm", name: "Gamemaster" };
const PLAYER = { id: "p1", name: "Player" };
const STRANGER = { id: "p2", name: "Stranger" };

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

function makeActor({ gp = 100, createFails = false } = {}) {
  let n = 0;
  const actor = {
    id: "actor1", name: "Crate Tester", documentName: "Actor", writes: [],
    system: { currency: { pp: 0, gp, ep: 0, sp: 0, cp: 0 } },
    items: new Map(),
    testUserPermission: user => user.id !== STRANGER.id,
    async update(data) { await tick(); actor.writes.push({ purse: data["system.currency"] }); actor.system.currency = data["system.currency"]; },
    async createEmbeddedDocuments(_type, docs, opts = {}) {
      await tick();
      if (createFails) return [];
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
const SCRATCH = { id: "scratch", kind: "scratch", name: "Fortune", price: 5, pools: [], weights: {}, layout: "lucky", grid: { cols: 4, rows: 3 }, bonus: { on: false, gp: 0 }, roll: { id: 1, size: 1, prizes: [] }, rules: {} };
const WHEEL = { id: "wheel", kind: "roulette", name: "Wheel", price: 5, pools: [], rules: {} };

async function seed(boxes = [CRATE]) {
  await globalThis.game.settings.set("loot-crates", "pools", { pool: POOL });
  await globalThis.game.settings.set("loot-crates", "boxes", Object.fromEntries(boxes.map(b => [b.id, b])));
}

const keep = (over = {}) => ({ type: "keep", requestId: `k${Math.random()}`, boxId: "box", actorId: "actor1", userId: "p1", price: 10, ...over });
const errorsTo = emitted => emitted.filter(m => m.type === "error").map(m => m.message);
const tickets = actor => [...actor.items.values()].filter(i => ticketOf(i));
const quiet = async fn => { const err = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = err; } };

afterEach(() => {
  vi.restoreAllMocks();
  postKeptCard.mockClear();
  delete globalThis.game;
  delete globalThis.foundry;
  delete globalThis.fromUuid;
  delete globalThis.ui;
  setStoreListener(null);
});

describe("Buy to keep on the GM: the charge", () => {
  it("charges the price once through settle(), puts a kept ticket in the pack, and logs it with no reveal", async () => {
    const { actor, emitted, deliver } = makeWorld();
    await seed([{ ...CRATE, rules: { stock: 4 } }]);
    await deliver(keep());
    expect(errorsTo(emitted)).toEqual([]);
    expect(toCopper(actor.system.currency)).toBe(9000);
    expect(actor.writes.filter(w => w.purse)).toHaveLength(1);
    const [ticket] = tickets(actor);
    expect(ticket).toMatchObject({ name: "Test Crate", type: "consumable", system: { quantity: 1, price: { value: 10 } } });
    expect(ticketOf(ticket)).toEqual({ boxId: "box", paid: 10, kept: true });
    // No prize was granted: the ticket is the only item.
    expect(actor.items.size).toBe(1);
    const row = getLog()[0];
    expect(row).toMatchObject({ kind: "crate", boxId: "box", actorId: "actor1", userId: "p1", price: 10, payoutCp: 0, itemId: null, keep: { itemId: ticket.id, itemName: "Test Crate", paid: 10 } });
    expect(row.uuid).toBeUndefined();
    // A purchase takes one from the stock.
    expect(getBoxes().box.rules.stock).toBe(3);
    expect(emitted.filter(m => m.type === "reveal")).toHaveLength(0);
    expect(emitted.find(m => m.type === "kept")).toMatchObject({ userId: "p1", logId: row.id, boxName: "Test Crate", actorName: "Crate Tester", price: 10, itemId: ticket.id, count: 1 });
    expect(postKeptCard).toHaveBeenCalledWith(expect.objectContaining({ id: row.id, keep: row.keep }));
  });

  it("stacks a second onto the kept ticket of the same game and price, and starts a new stack at another price", async () => {
    const { actor, emitted, deliver } = makeWorld();
    await seed();
    await deliver(keep());
    await deliver(keep());
    expect(tickets(actor)).toHaveLength(1);
    expect(tickets(actor)[0].system.quantity).toBe(2);
    expect(emitted.filter(m => m.type === "kept").map(m => m.count)).toEqual([1, 2]);
    expect(getLog().map(r => r.keep.itemId)).toEqual([tickets(actor)[0].id, tickets(actor)[0].id]);
    // The GM raised the price: a ticket bought at 12 gp is its own stack.
    await seed([{ ...CRATE, price: 12 }]);
    await deliver(keep({ price: 12 }));
    expect(tickets(actor).map(i => [ticketOf(i).paid, i.system.quantity])).toEqual([[10, 2], [12, 1]]);
    expect(toCopper(actor.system.currency)).toBe(10000 - 1000 - 1000 - 1200);
  });

  it("doesn't stack onto a ticket the GM handed out (it wasn't bought)", async () => {
    const { actor, deliver } = makeWorld();
    await seed();
    const given = makeItem(actor, { id: "given", ...ticketData(CRATE) });
    actor.items.set("given", given);
    await deliver(keep());
    expect(given.system.quantity).toBe(1);
    expect(tickets(actor)).toHaveLength(2);
  });

  it("asks from a player's client over the socket and resolves on the GM's answer", async () => {
    const { emitted } = makeWorld({ user: PLAYER });
    const asked = requestKeep({ boxId: "box", actorId: "actor1", price: 10 });
    expect(emitted[0]).toMatchObject({ type: "keep", boxId: "box", actorId: "actor1", userId: "p1", price: 10 });
    expect(emitted[0].requestId).toBeTruthy();
    // The GM's answer arrives on the same socket.
    expect(await Promise.race([asked.then(() => "settled"), tick().then(() => "waiting")])).toBe("waiting");
  });
});

describe("Buy to keep on the GM: a purchase's guards, nothing moves when one refuses", () => {
  it("refuses a character who can't afford it, a stale price, a sold-out stock, a closed shop and a stranger", async () => {
    const { actor, emitted, deliver } = makeWorld({ actor: makeActor({ gp: 5 }) });
    await seed([{ ...CRATE, rules: { stock: 0 } }, { ...CRATE, id: "cheap", name: "Cheap", price: 1 }]);
    await deliver(keep());
    await deliver(keep({ boxId: "cheap", price: 2 }));
    await globalThis.game.settings.set("loot-crates", "shopOpen", false);
    await deliver(keep({ boxId: "cheap", price: 1 }));
    await globalThis.game.settings.set("loot-crates", "shopOpen", true);
    await deliver(keep({ boxId: "cheap", price: 1, userId: "p2" }));
    expect(errorsTo(emitted)).toEqual([
      "Test Crate is sold out.",
      expect.stringContaining("Cheap"),
      "The GM has closed the shop.",
      "You don't own that character.",
    ]);
    expect(actor.writes).toEqual([]);
    expect(getLog()).toHaveLength(0);
  });

  it("refuses with too few coins before anything is written", async () => {
    const { actor, emitted, deliver } = makeWorld({ actor: makeActor({ gp: 5 }) });
    await seed();
    await deliver(keep());
    expect(errorsTo(emitted)).toEqual(["Crate Tester can't afford Test Crate."]);
    expect(actor.writes).toEqual([]);
  });

  it("counts toward the limit per character, and a kept ticket's use doesn't count again", async () => {
    const { emitted, deliver } = makeWorld();
    await seed([{ ...CRATE, rules: { perCharacter: { max: 1, per: "ever" } } }]);
    await deliver(keep());
    await deliver(keep());
    expect(errorsTo(emitted)).toEqual([expect.stringMatching(/Test Crate/)]);
    expect(getLog()).toHaveLength(1);
    // The ticket's use plays with the limit already reached: it was the purchase.
    await deliver({ type: "redeem", requestId: "r1", actorId: "actor1", itemId: getLog()[0].keep.itemId, userId: "p1" });
    expect(errorsTo(emitted)).toHaveLength(1);
    expect(emitted.filter(m => m.type === "reveal")).toHaveLength(1);
    expect(getLog()[0].redeem).toMatchObject({ paid: 10, kept: true });
    expect(boughtBy(getLog(), { boxId: "box", actorId: "actor1" })).toBe(1);
  });

  it("refuses a game off the shelf and a table game", async () => {
    const { actor, emitted, deliver } = makeWorld();
    await seed([{ ...CRATE, rules: { shelved: false } }, WHEEL]);
    await deliver(keep());
    await deliver(keep({ boxId: "wheel", price: 5 }));
    expect(errorsTo(emitted)).toHaveLength(2);
    expect(errorsTo(emitted)[1]).toBe("Wheel is played at the table: stake while a round is open.");
    expect(actor.writes).toEqual([]);
  });

  it("puts the coins back when the ticket can't be made", async () => {
    const { actor, emitted, deliver } = makeWorld({ actor: makeActor({ createFails: true }) });
    await seed();
    await quiet(() => deliver(keep()));
    expect(errorsTo(emitted)).toEqual(["The ticket couldn't be put in the pack, so your coins are back."]);
    expect(toCopper(actor.system.currency)).toBe(10000);
    expect(getLog()).toHaveLength(0);
  });

  it("takes the ticket back and returns the coins when the log row can't be written", async () => {
    const { actor, emitted, deliver } = makeWorld();
    await seed();
    await deliver(keep());
    const set = globalThis.game.settings.set;
    globalThis.game.settings.set = async (ns, key, value) => { if (key === "pullLog") throw new Error("disk full"); return set(ns, key, value); };
    await quiet(() => deliver(keep()));
    expect(errorsTo(emitted)).toEqual(["The ticket couldn't be put in the pack, so your coins are back."]);
    expect(tickets(actor)[0].system.quantity).toBe(1);
    expect(toCopper(actor.system.currency)).toBe(9000);
  });

  it("draws nothing from a scratch roll at buy time", async () => {
    const { actor, emitted, deliver } = makeWorld();
    await seed([SCRATCH]);
    await deliver(keep({ boxId: "scratch", price: 5 }));
    expect(errorsTo(emitted)).toEqual([]);
    expect(getLog()[0]).not.toHaveProperty("rollId");
    expect(getLog()[0]).not.toHaveProperty("tier");
    expect(rollRows(getLog(), { boxId: "scratch", rollId: 1 })).toHaveLength(0);
    // The roll's one ticket is still there for the kept ticket's use.
    await deliver({ type: "redeem", requestId: "r1", actorId: "actor1", itemId: tickets(actor)[0].id, userId: "p1" });
    expect(errorsTo(emitted)).toEqual([]);
    expect(rollRows(getLog(), { boxId: "scratch", rollId: 1 })).toHaveLength(1);
  });
});

describe("refunding a Buy to keep", () => {
  it("takes one ticket out of the stack and returns its price and the stock", async () => {
    const { actor, deliver } = makeWorld();
    await seed([{ ...CRATE, rules: { stock: 4 } }]);
    await deliver(keep());
    await deliver(keep());
    expect(getBoxes().box.rules.stock).toBe(2);
    const plan = describeRefund(getLog()[0].id);
    expect(plan).toMatchObject({ status: "ready", coins: 1000, items: [], gone: [] });
    expect(plan.ticket.id).toBe(tickets(actor)[0].id);
    const out = await refundPull(getLog()[0].id);
    expect(out).toMatchObject({ status: "refunded", keptBack: "Test Crate", removedItem: null });
    expect(tickets(actor)[0].system.quantity).toBe(1);
    expect(toCopper(actor.system.currency)).toBe(9000);
    expect(getBoxes().box.rules.stock).toBe(3);
    expect(getLog()[0].refunded).toBeTruthy();
  });

  it("deletes the ticket with the last one, and refuses once none is left (used or traded)", async () => {
    const { actor, deliver } = makeWorld();
    await seed();
    await deliver(keep());
    await deliver(keep());
    const [newer, older] = getLog();
    await refundPull(newer.id);
    // The player uses the other one.
    await deliver({ type: "redeem", requestId: "r1", actorId: "actor1", itemId: older.keep.itemId, userId: "p1" });
    expect(tickets(actor)).toHaveLength(0);
    const purse = toCopper(actor.system.currency);
    expect(describeRefund(older.id)).toMatchObject({ status: "ticket-gone", message: "Crate Tester has no Test Crate ticket left to give back (it was used or traded), so nothing was refunded." });
    const out = await refundPull(older.id);
    expect(out.status).toBe("ticket-gone");
    expect(toCopper(actor.system.currency)).toBe(purse);
    expect(getLog().find(r => r.id === older.id).refunded).toBeFalsy();
  });

  it("finds a kept ticket made again on a new item (a refunded use of the last one)", async () => {
    const { actor, deliver } = makeWorld();
    await seed();
    await deliver(keep());
    const kept = getLog()[0];
    await deliver({ type: "redeem", requestId: "r1", actorId: "actor1", itemId: kept.keep.itemId, userId: "p1" });
    await refundPull(getLog()[0].id);
    const [back] = tickets(actor);
    expect(back.id).not.toBe(kept.keep.itemId);
    expect(ticketOf(back)).toEqual({ boxId: "box", paid: 10, kept: true });
    const out = await refundPull(kept.id);
    expect(out.status).toBe("refunded");
    expect(tickets(actor)).toHaveLength(0);
    expect(toCopper(actor.system.currency)).toBe(10000);
  });

  it("leaves the buyer's pity and no-duplicates record alone", async () => {
    const { deliver } = makeWorld();
    await seed();
    await globalThis.game.settings.set("loot-crates", "actorState", { actor1: { box: { sinceRare: 3, owned: ["a"], pulls: 3 } } });
    await deliver(keep());
    await refundPull(getLog()[0].id);
    expect(globalThis.game.settings.get("loot-crates", "actorState").actor1.box).toEqual({ sinceRare: 3, owned: ["a"], pulls: 3 });
  });
});

describe("a kept row is a sale, not a play", () => {
  const row = over => ({ id: Math.random().toString(36), boxId: "g", actorId: "a", at: 1000, day: "y1d1", price: 1, ...over });

  it("isn't a throw at the well, a draw at the deck, or a ticket sold from a scratch roll", () => {
    const log = [row({ kind: "well", keep: { paid: 1 } }), row({ kind: "well" })];
    expect(throwsToday(log, { boxId: "g", actorId: "a", day: "y1d1" })).toBe(1);
    expect(drawnIds({ id: "g", deck: { cards: [{ id: "c1", kind: "blank", label: "x", weight: 1, once: true }] } }, [row({ kind: "deck", keep: { paid: 1 } })]).size).toBe(0);
    expect(rollRows([row({ kind: "scratch", rollId: 1, keep: { paid: 1 } })], { boxId: "g", rollId: 1 })).toHaveLength(0);
  });

  it("raises the deck's price as a draw does, and its ticket's later use doesn't raise it again", () => {
    const game = { id: "g", kind: "deck", price: 10, deck: { step: 2, streakMinutes: 5, cards: [] } };
    const log = [];
    const paid = [];
    for (let i = 0; i < 4; i++) {
      const price = nextPrice(game, log, { actorId: "a", now: 1000 + i });
      paid.push(price);
      log.push(row({ kind: "deck", at: 1000 + i, price, keep: { paid: price } }));
    }
    // Four kept tickets cost what four draws in a row do, not the base price four times.
    expect(paid).toEqual([10, 20, 40, 80]);
    const used = [row({ kind: "deck", at: 1000, keep: { paid: 10 } }), row({ kind: "deck", at: 1001, price: 0, redeem: { paid: 10, kept: true } })];
    expect(streakOf(used, { boxId: "g", actorId: "a", now: 1100, within: 60000 })).toBe(1);
    const given = [row({ kind: "deck", at: 1001, price: 0, redeem: { paid: 0 } })];
    expect(streakOf(given, { boxId: "g", actorId: "a", now: 1100, within: 60000 })).toBe(1);
  });

  it("counts toward the limit per character on the day it was bought; no ticket's play does", () => {
    const log = [row({ keep: { paid: 1 } }), row({ redeem: { paid: 1, kept: true } }), row({ redeem: { paid: 0 } })];
    expect(boughtBy(log, { boxId: "g", actorId: "a" })).toBe(1);
    expect(boughtBy(log, { boxId: "g", actorId: "a", per: "day", today: "y1d2" })).toBe(0);
  });

  it("says what it cost and that it was kept in the Pull log", () => {
    expect(rowPriceTag({ price: 10, keep: { paid: 10 } })).toBe("10 gp, kept");
    expect(rowPriceTag({ price: 10 })).toBe("10 gp");
  });
});

describe("the kept-ticket helpers", () => {
  const item = (id, box, { paid = 0, kept = false, qty = 1 } = {}) => { const d = ticketData(box, { paid, kept }); d.system.quantity = qty; return { id, ...d }; };

  it("keptStack stacks only onto a kept ticket to the same game at the same price", () => {
    const items = [item("given", CRATE), item("dear", CRATE, { paid: 12, kept: true }), item("mine", CRATE, { paid: 10, kept: true })];
    expect(keptStack(items, { boxId: "box", paid: 10 })?.id).toBe("mine");
    expect(keptStack(items, { boxId: "box", paid: 11 })).toBeNull();
    expect(keptStack(items, { boxId: "other", paid: 10 })).toBeNull();
  });

  it("keptTicketFor prefers the stack it went onto, then any kept ticket of that game and price, never an empty one", () => {
    const row = { boxId: "box", keep: { itemId: "a", paid: 10 } };
    expect(keptTicketFor([item("b", CRATE, { paid: 10, kept: true }), item("a", CRATE, { paid: 10, kept: true })], row).id).toBe("a");
    expect(keptTicketFor([item("a", CRATE, { paid: 10, kept: true, qty: 0 }), item("b", CRATE, { paid: 10, kept: true })], row).id).toBe("b");
    expect(keptTicketFor([item("a", CRATE)], row)).toBeNull();
    expect(keptTicketFor([item("a", CRATE, { paid: 10, kept: true })], { boxId: "box" })).toBeNull();
  });

  it("keepRow keeps the stack, its name and the price", () => {
    expect(keepRow({ item: { id: "t", name: "Test Crate" }, paid: 10 })).toEqual({ itemId: "t", itemName: "Test Crate", paid: 10 });
  });
});

describe("the shop card's Buy to keep", () => {
  const ctx = (over = {}) => ({ purse: { gp: 100 }, open: true, gmOnline: true, hasActor: true, actorId: "a", actorName: "Tam", log: [], esc: s => String(s ?? ""), ...over });
  const shell = (box, c = ctx()) => cardShell(box, c, { rarityClass: "lc-rarity-common", label: "Open for 10 gp" });

  it("sits under the Buy of every pulled game, at the same price, named for the game", () => {
    const html = shell(CRATE);
    expect(html).toMatch(/class="lc-box__buy"[\s\S]*class="lc-box__keep" data-action="keep" data-keep="box" data-price="10"/);
    expect(html).toContain(`<span class="lc-sr-only">Test Crate: </span>Buy to keep<span class="lc-sr-only">, 10 gp, a ticket for your pack to use later</span>`);
    expect(shell(SCRATCH)).toContain('data-action="keep"');
  });

  it("isn't on a table game's card", () => {
    expect(shell(WHEEL)).not.toContain('data-action="keep"');
  });

  it("is off with the Buy, for the same reasons", () => {
    const html = cardShell(CRATE, ctx(), { rarityClass: "", label: "Open", reason: "Needs 5 gp more" });
    const keepTag = html.match(/<button[^>]*lc-box__keep[^>]*>/)[0];
    expect(keepTag).toContain('aria-disabled="true"');
    expect(keepTag).toContain('aria-describedby="lc-why-box"');
    expect(cardShell(CRATE, ctx({ open: false }), { rarityClass: "", label: "Open" }).match(/<button[^>]*lc-box__keep[^>]*>/)[0]).toContain('aria-disabled="true"');
  });

  it("says Buying… on the pressed card while a keep is out, and the Buy keeps its label", () => {
    const html = shell(CRATE, ctx({ busy: true, busyBox: "box", busyKeep: true }));
    expect(html).toMatch(/lc-box__buy[\s\S]*Open for 10 gp[\s\S]*lc-box__keep[\s\S]*Buying…/);
    expect(html).not.toContain("Opening…");
    expect(shell(CRATE, ctx({ busy: true, busyBox: "box" }))).toMatch(/Opening…[\s\S]*Buy to keep/);
  });
});
