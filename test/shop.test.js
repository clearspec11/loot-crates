/*
  An unbuyable Buy is aria-disabled, not disabled, so it keeps focus; a click
  or Enter on it still reaches the shop's action. The action must check again
  and never ask the GM for a pull it shouldn't.
*/
import { describe, it, expect, beforeEach, vi } from "vitest";
import { POOLS, BOXES } from "../harness/sample.js";
import { flattenPool } from "../module/scripts/odds.js";

const boxes = Object.fromEntries(BOXES.map(b => [b.id, b]));
let shopOpen = true;
// The pity and ownership state per "actorId.boxId", as the world setting holds it.
let states = {};
vi.mock("../module/scripts/store.js", () => ({ getBoxes: () => boxes, getPools: () => POOLS, isShopOpen: () => shopOpen, getActorState: (a, b) => states[`${a}.${b}`] ?? {} }));
const requestPull = vi.fn(async () => ({}));
vi.mock("../module/scripts/socket.js", () => ({ requestPull: (...args) => requestPull(...args) }));

class FakeApp {
  render() { return this; }
}
const actor = { id: "a1", type: "character", name: "Tam", system: { currency: { gp: 420, sp: 7, cp: 3 } }, testUserPermission: () => true };
const actors = [actor];
actors.get = id => actors.find(a => a.id === id);
let activeGM;
vi.stubGlobal("foundry", { applications: { api: { ApplicationV2: FakeApp } }, utils: { escapeHTML: s => s } });
vi.stubGlobal("ui", { notifications: { warn: vi.fn() } });
vi.stubGlobal("game", { user: { id: "u", character: actor }, actors, users: { get activeGM() { return activeGM; } } });

const { CrateShop } = await import("../module/scripts/shop.js");
const buy = (app, box, price) => CrateShop.DEFAULT_OPTIONS.actions.buy.call(app, {}, { dataset: price === undefined ? { box } : { box, price } });

beforeEach(() => {
  requestPull.mockClear();
  shopOpen = true;
  states = {};
  activeGM = { id: "gm" };
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
