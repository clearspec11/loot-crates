/*
  An unbuyable Buy is aria-disabled, not disabled, so it keeps focus; a click
  or Enter on it still reaches the shop's action. The action must check again
  and never ask the GM for a pull it shouldn't.
*/
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createDocument } from "./minidom.js";
import { POOLS, BOXES } from "../harness/sample.js";
import { flattenPool } from "../module/scripts/odds.js";

const boxes = Object.fromEntries(BOXES.map(b => [b.id, b]));
let shopOpen = true;
// The pity and ownership state per "actorId.boxId", as the world setting holds it.
let states = {};
vi.mock("../module/scripts/store.js", () => ({ getBoxes: () => boxes, getPools: () => POOLS, isShopOpen: () => shopOpen, getActorState: (a, b) => states[`${a}.${b}`] ?? {} }));
const requestPull = vi.fn(async () => ({}));
vi.mock("../module/scripts/socket.js", () => ({ requestPull: (...args) => requestPull(...args) }));

// ApplicationV2 stand-in: counts renders and, when a document is stubbed,
// keeps the last rendered body in `last` (a promise, as _renderHTML is async).
class FakeApp {
  renders = 0;
  get rendered() { return this.renders > 0; }
  render() {
    this.renders++;
    if (globalThis.document) this.last = this._renderHTML();
    return this;
  }
}
// The characters in the world, and which of them this player owns now
// (the GM can change that while the shop is open).
let owns = new Set(["a1"]);
const character = (id, name, gp) => ({ id, type: "character", name, system: { currency: { gp } }, testUserPermission() { return owns.has(this.id); } });
const actor = { ...character("a1", "Tam", 420), system: { currency: { gp: 420, sp: 7, cp: 3 } } };
const actors = [actor, character("a2", "Orla", 300), character("a3", "Pip", 200)];
actors.get = id => actors.find(a => a.id === id);
let activeGM;
vi.stubGlobal("foundry", { applications: { api: { ApplicationV2: FakeApp } }, utils: { escapeHTML: s => s } });
vi.stubGlobal("ui", { notifications: { warn: vi.fn() } });
vi.stubGlobal("game", { user: { id: "u", character: actor }, actors, users: { get activeGM() { return activeGM; } } });

const { CrateShop, openShop, registerShopHooks } = await import("../module/scripts/shop.js");
const buy = (app, box, price) => CrateShop.DEFAULT_OPTIONS.actions.buy.call(app, {}, { dataset: price === undefined ? { box } : { box, price } });

beforeEach(() => {
  requestPull.mockClear();
  requestPull.mockImplementation(async () => ({}));
  shopOpen = true;
  states = {};
  activeGM = { id: "gm" };
  owns = new Set(["a1"]);
  globalThis.game.user.character = actor;
});

describe("the shop's Buy action", () => {
  it("asks the GM for a crate that can be bought", async () => {
    const app = new CrateShop();
    await buy(app, "common", "25");
    expect(requestPull).toHaveBeenCalledTimes(1);
    expect(requestPull.mock.calls[0][0]).toEqual({ boxId: "common", actorId: "a1", price: 25 });
    expect(app.busy).toBe(false);
  });

  it("sends the price the pressed Buy showed, not the setting's current one", async () => {
    // The GM raised it after this card was drawn: the GM refuses such a pull
    // (pull.js expectedPrice), so the shop must not quietly send the new one.
    const was = boxes.common.price;
    boxes.common.price = 30;
    try {
      await buy(new CrateShop(), "common", "25");
      expect(requestPull.mock.calls[0][0]).toMatchObject({ boxId: "common", price: 25 });
    } finally { boxes.common.price = was; }
  });

  it("sends no price from a Buy without one, and the GM charges the box's", async () => {
    await buy(new CrateShop(), "common");
    expect(requestPull.mock.calls[0][0].price).toBeUndefined();
  });

  it("does nothing while a pull is out (busy)", async () => {
    const app = new CrateShop();
    app.busy = true;
    app.busyBox = "adventurer";
    await buy(app, "common");
    expect(requestPull).not.toHaveBeenCalled();
    expect(app.busyBox).toBe("adventurer");
  });

  it("does nothing for a crate the character can't afford", async () => {
    await buy(new CrateShop(), "royal");
    expect(requestPull).not.toHaveBeenCalled();
  });

  it("does nothing for an empty crate, a closed shop, no GM or an unknown crate", async () => {
    await buy(new CrateShop(), "empty");
    shopOpen = false;
    await buy(new CrateShop(), "common");
    shopOpen = true;
    activeGM = null;
    await buy(new CrateShop(), "common");
    activeGM = { id: "gm" };
    await buy(new CrateShop(), "nope");
    expect(requestPull).not.toHaveBeenCalled();
  });

  it("does nothing for a crate with nothing new for this character, and asks for one with something", async () => {
    const all = [...flattenPool("core", POOLS), ...flattenPool("homebrew", POOLS)].map(e => e.uuid);
    boxes.dupes = { ...boxes.common, id: "dupes", rules: { noDuplicates: true } };
    try {
      states["a1.dupes"] = { owned: all };
      await buy(new CrateShop(), "dupes");
      expect(requestPull).not.toHaveBeenCalled();
      states["a1.dupes"] = { owned: all.slice(1) };
      await buy(new CrateShop(), "dupes");
      expect(requestPull).toHaveBeenCalledTimes(1);
    } finally { delete boxes.dupes; }
  });
});

/*
  The shop follows ownership. It used to pick its character once, when it
  was first opened: a player whose character the GM took away kept that
  character's purse on screen and a live Buy the GM then refused ("You
  don't own that character."), and one who opened the shop before being
  given a character saw "No character" until they reloaded.
*/
describe("the shop's character, picked again each render", () => {
  // A document to render into; the Buy tests above run without one.
  beforeEach(() => { globalThis.document = createDocument(); });
  afterEach(() => { delete globalThis.document; });

  const draw = async app => { app.render(); return app.last; };
  const who = body => body.querySelector(".lc-shop__who")?.textContent.trim() ?? null;
  const purse = body => body.querySelector(".lc-shop__purse")?.textContent.trim() ?? null;
  const picked = body => body.querySelectorAll(".lc-shop__actor option").filter(o => o.hasAttribute("selected")).map(o => o.getAttribute("value"));
  const live = (body, box) => body.querySelector(`.lc-box__buy[data-box="${box}"]`).getAttribute("aria-disabled") !== "true";

  it("moves to the next owned character when the shown one is taken away, and Buy then asks for that one", async () => {
    owns = new Set(["a1", "a2"]);
    const app = new CrateShop();
    expect(picked(await draw(app))).toEqual(["a1"]);
    owns.delete("a1");
    const body = await draw(app);
    expect(app.actorId).toBe("a2");
    expect(who(body)).toBe("Orla");
    expect(purse(body)).toBe("300 gp");
    await buy(app, "common", "25");
    expect(requestPull).toHaveBeenCalledTimes(1);
    expect(requestPull.mock.calls[0][0]).toMatchObject({ boxId: "common", actorId: "a2" });
  });

  it("never asks for a character taken away since the last render: it redraws for the right one instead", async () => {
    owns = new Set(["a1", "a2"]);
    const app = new CrateShop();
    await draw(app);
    owns.delete("a1");
    // The press lands on cards still drawn for Tam (no redraw arrived yet).
    const renders = app.renders;
    await buy(app, "common", "25");
    expect(requestPull).not.toHaveBeenCalled();
    expect(app.renders).toBe(renders + 1);
    expect(who(await app.last)).toBe("Orla");
    // The cards now say Orla; the next press buys for her.
    await buy(app, "common", "25");
    expect(requestPull.mock.calls[0][0].actorId).toBe("a2");
  });

  it("shows No character and sends nothing when every character is taken away", async () => {
    const app = new CrateShop();
    expect(who(await draw(app))).toBe("Tam");
    owns.clear();
    await buy(app, "common", "25");
    const body = await app.last;
    expect(app.actorId).toBeNull();
    expect(who(body)).toBe("No character");
    expect(purse(body)).toBeNull();
    expect(live(body, "common")).toBe(false);
    await buy(app, "common", "25");
    expect(requestPull).not.toHaveBeenCalled();
  });

  it("picks up a character given after the shop was opened empty, on the next render", async () => {
    owns.clear();
    globalThis.game.user.character = null;
    const app = new CrateShop();
    expect(who(await draw(app))).toBe("No character");
    owns.add("a3");
    const body = await draw(app);
    expect(who(body)).toBe("Pip");
    expect(live(body, "common")).toBe(true);
    await buy(app, "common", "25");
    expect(requestPull.mock.calls[0][0].actorId).toBe("a3");
  });

  it("keeps the character the player picked while they still own it", async () => {
    owns = new Set(["a1", "a2", "a3"]);
    const app = new CrateShop();
    await draw(app);
    app.actorId = "a2"; // as the picker's change sets it
    owns.delete("a3");
    expect(picked(await draw(app))).toEqual(["a2"]);
    expect(app.actorId).toBe("a2");
    await buy(app, "common", "25");
    expect(requestPull.mock.calls[0][0].actorId).toBe("a2");
  });

  it("marks the character that will be charged as selected, also after the picked one is taken away", async () => {
    owns = new Set(["a1", "a2", "a3"]);
    const app = new CrateShop();
    await draw(app);
    app.actorId = "a3";
    expect(picked(await draw(app))).toEqual(["a3"]);
    owns.delete("a3");
    const body = await draw(app);
    // The user's own character, which also gets charged; before, nothing was
    // selected and the select showed Tam while Buy charged Pip.
    expect(picked(body)).toEqual(["a1"]);
    expect(body.querySelector(".lc-shop__actor").value).toBe("a1");
    expect(purse(body)).toBe("420 gp 7 sp 3 cp");
    await buy(app, "common", "25");
    expect(requestPull.mock.calls[0][0].actorId).toBe("a1");
  });

  it("keeps a pull's character while it is out, and moves on once it settles", async () => {
    owns = new Set(["a1", "a2"]);
    let settle;
    requestPull.mockImplementation(() => new Promise(r => { settle = r; }));
    const app = new CrateShop();
    await draw(app);
    const pressed = buy(app, "common", "25");
    expect(requestPull.mock.calls[0][0].actorId).toBe("a1");
    owns.delete("a1");
    await draw(app);
    expect(app.actorId).toBe("a1");
    settle({});
    await pressed;
    const body = await app.last;
    expect(app.actorId).toBe("a2");
    expect(who(body)).toBe("Orla");
  });
});

describe("what redraws an open shop", () => {
  // A document to render into; the Buy tests above run without one.
  beforeEach(() => { globalThis.document = createDocument(); });
  afterEach(() => { delete globalThis.document; });

  it("follows ownership, new and deleted actors, this user's character and the purse", () => {
    const on = {};
    registerShopHooks({ on: (name, fn) => { on[name] = fn; } });
    const shop = openShop();
    const redraws = fire => { const n = shop.renders; fire(); return shop.renders - n; };
    expect(redraws(() => on.updateActor(actor, { ownership: { u: 2 } }))).toBe(1);
    expect(redraws(() => on.updateActor(actor, { system: { currency: { gp: 1 } } }))).toBe(1);
    expect(redraws(() => on.updateActor(actor, { name: "Tamsin" }))).toBe(0);
    expect(redraws(() => on.createActor(actors[1]))).toBe(1);
    expect(redraws(() => on.deleteActor(actors[1]))).toBe(1);
    expect(redraws(() => on.updateUser({ id: "u" }, { character: "a2" }))).toBe(1);
    expect(redraws(() => on.updateUser({ id: "u" }, { character: null }))).toBe(1);
    expect(redraws(() => on.updateUser({ id: "someone" }, { character: "a2" }))).toBe(0);
    expect(redraws(() => on.updateUser({ id: "u" }, { color: "#fff" }))).toBe(0);
    expect(redraws(() => on.userConnected({ id: "gm" }, true))).toBe(1);
  });
});
