/*
  The winner's give or sell answered after its wait gave up (socket.js
  answered sends it to tellParted with `own`; reveal.js heardParted and
  CrateReveal.partHeard): on the winner's own window the row says what
  came of the item after all, once, and the countdown the open picker held
  starts again. The socket's copy (no `own`), a second word on the same
  item, a closed window, a replay and another play's window change nothing.
  ApplicationV2 is a stand-in that puts each window in a minimal DOM and in
  foundry.applications.instances, where heardParted looks.
*/
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createDocument } from "./minidom.js";

vi.mock("../module/scripts/foundry/sound.js", () => ({ playTick: vi.fn(), playSlow: vi.fn(), playReveal: vi.fn(), playDrop: vi.fn(), playCoinBack: vi.fn(), playPlop: vi.fn(), playPlink: vi.fn(), playBane: vi.fn() }));
vi.mock("../module/scripts/foundry/socket.js", () => ({ requestPull: vi.fn(), requestGive: vi.fn(), requestSell: vi.fn(), requestStake: vi.fn(), isActiveGM: vi.fn(() => true) }));
vi.mock("../module/scripts/foundry/table.js", () => ({ onTable: vi.fn(), openRound: vi.fn(), resolveRound: vi.fn(), cancelRound: vi.fn() }));
vi.mock("../module/scripts/foundry/shop.js", () => ({ buyableActors: vi.fn(() => []) }));
vi.mock("../module/scripts/foundry/store.js", () => ({ getBoxes: vi.fn(() => ({ c1: { id: "c1", rules: {} } })), getPools: vi.fn(() => ({})), getLog: vi.fn(() => []), getTally: vi.fn(() => null), getRounds: vi.fn(() => ({})), todayKey: vi.fn(() => null), isShopOpen: vi.fn(() => true), getActorState: vi.fn(() => ({})) }));

// A window in the page and in Foundry's instances, removed from both on
// close before _onClose runs, as ApplicationV2 does.
class DomApp {
  constructor(options) { this.options = options; this.state = 0; }
  get rendered() { return this.state === 1; }
  async render() {
    const html = await this._renderHTML();
    if (!this.element) {
      const section = document.createElement("section");
      section.className = "application";
      const content = document.createElement("div");
      content.className = "window-content";
      section.append(content);
      document.body.append(section);
      this.element = section;
    }
    this._replaceHTML(html, this.element.querySelector(".window-content"));
    if (this.options?.id) globalThis.foundry.applications.instances.set(this.options.id, this);
    this.state = 1;
    await this._onRender?.();
    return this;
  }
  _onClose() {}
  async close() {
    this.state = 0;
    globalThis.foundry.applications.instances.delete(this.options?.id);
    this.element.remove();
    this._onClose({});
  }
}

vi.stubGlobal("foundry", { applications: { api: { ApplicationV2: DomApp }, instances: new Map() }, utils: { escapeHTML: s => String(s ?? "") } });
const { showReveal, heardParted, CrateReveal, _resetHolds } = await import("../module/scripts/foundry/reveal.js");
const { registerKind, _resetKinds } = await import("../module/scripts/games/kinds.js");
const { resultHTML } = await import("../module/scripts/views/revealcard.js");
const socket = await import("../module/scripts/foundry/socket.js");

// A crate-like kind whose spin lands when the test says, with the crate's
// own result block (the "Added to" and gold line).
let controllers;
const CRATEISH = {
  id: "crateish",
  async roll() { return { result: null }; },
  reveal: {
    title: "A crate",
    play(_host, _reveal, { onLand }) {
      let done = false;
      const c = { skipped: false, reducedMotion: false, play() {}, skip() { c.land(); }, land() { if (!done) { done = true; onLand(); } } };
      controllers.push(c);
      return c;
    },
    result: (r, opts) => resultHTML(r, opts),
    replayable: true,
  },
};

// Tam's play of two items; Saria (Cy's) is someone to give to.
const worth = { value: 150, denomination: "gp", quantity: 1 };
const reveal = extra => ({
  kind: "crateish", requestId: "r1", userId: "p1", actorId: "a1", actorName: "Tam",
  box: { id: "c1", name: "The Crate", price: 10 }, result: { name: "Sling +1" },
  itemId: "i1", itemUuid: "Actor.a1.Item.i1", itemIds: ["i1", "i2"], itemNames: ["Sling +1", "Potion"],
  worth: { i1: worth, i2: worth }, logId: "L1", purse: { gp: 40 }, ...extra,
});
const gave = { given: { actorId: "a2", actorName: "Saria" } };
// The GM's answer as socket.js answered hands it on (`own`), and the
// socket's copy as heardOnTable says it from the row (no `own`).
const late = extra => ({ type: "parted", logId: "L1", userId: "p1", itemId: "i1", itemName: "Sling +1", actorName: "Tam", part: gave, own: true, ...extra });
const fromRow = extra => { const { own: _own, ...msg } = late(extra); return msg; };

const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const event = (type, target) => ({ type, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} });
const slotOf = app => app.element.querySelector(".lc-reveal__after");
const rowOf = (app, id) => slotOf(app).querySelectorAll(".lc-after__item").find(li => li.dataset.afterItem === id) ?? null;
const said = (app, id) => rowOf(app, id)?.querySelector(".lc-after__said")?.textContent ?? null;
const gold = app => app.element.querySelector(".lc-reveal__gold").textContent;

let setting;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  controllers = [];
  setting = 10;
  const doc = createDocument();
  Object.assign(doc, { visibilityState: "visible", addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", { innerWidth: 1440, innerHeight: 900 });
  vi.stubGlobal("CSS", { escape: s => String(s) });
  vi.stubGlobal("foundry", { applications: { api: { ApplicationV2: DomApp }, instances: new Map() }, utils: { escapeHTML: s => String(s ?? "") } });
  const users = [{ id: "p1", name: "Lee", isGM: false }, { id: "p2", name: "Cy", isGM: false }];
  const tam = { id: "a1", name: "Tam", type: "character", testUserPermission: u => u.id === "p1", items: { get: () => ({ system: { quantity: 1 } }) } };
  const saria = { id: "a2", name: "Saria", type: "character", testUserPermission: u => u.id === "p2", items: { get: () => null } };
  const actors = [tam, saria];
  vi.stubGlobal("game", {
    user: { id: "p1", isGM: false, character: null },
    users: { activeGM: { id: "gm" }, contents: users },
    actors: { contents: actors, get: id => actors.find(a => a.id === id) ?? null },
    settings: { get: (_m, key) => (key === "closeFinished" ? setting : true) },
  });
  vi.stubGlobal("ui", { notifications: { warn() {}, info() {} } });
  vi.stubGlobal("fromUuidSync", () => ({}));
  registerKind(CRATEISH);
  socket.requestGive.mockReset();
  socket.requestSell.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  _resetHolds();
  _resetKinds(["crate", "roulette", "auction"]);
  vi.unstubAllGlobals();
});

// The winner's window, landed, with Give to… pressed on the first item and
// its answer given up on: the picker stays open and holds the countdown.
const WAITED = "The GM didn't answer in time.";
async function waitedOut(extra) {
  socket.requestGive.mockRejectedValue(new Error(WAITED));
  const asked = socket.requestGive.mock.calls.length;
  const app = await showReveal(reveal(extra));
  controllers.at(-1).land();
  await settle();
  const slot = slotOf(app);
  const li = rowOf(app, "i1");
  slot.dispatchEvent(event("click", li.querySelector(".lc-after__give")));
  slot.dispatchEvent(event("click", li.querySelector(".lc-after__confirm")));
  await settle();
  expect(socket.requestGive).toHaveBeenCalledTimes(asked + 1);
  expect(li.querySelector(".lc-after__pick").hidden).toBe(false);
  expect(said(app, "i1")).toBe(WAITED);
  return app;
}

describe("the winner's late give or sell, on their own reveal", () => {
  it("says what came of the item after all, and the countdown the picker held starts again", async () => {
    const app = await waitedOut();
    vi.advanceTimersByTime(60_000);
    expect(app.state).toBe(1);
    heardParted(late());
    expect(said(app, "i1")).toBe("Tam gave Sling +1 to Saria.");
    expect(rowOf(app, "i1").dataset.parted).toBe("1");
    expect(rowOf(app, "i1").querySelector(".lc-after__pick")).toBeNull();
    // The other item is still the winner's to give or sell.
    expect(rowOf(app, "i2").querySelector(".lc-after__give")).not.toBeNull();
    expect(app.state).toBe(1);
    vi.advanceTimersByTime(11_000);
    expect(app.state).toBe(0);
  });

  it("a sale's coins land in the gold line", async () => {
    const app = await waitedOut();
    heardParted(late({ itemId: "i2", itemName: "Potion", part: { soldCp: 7500 }, purse: { gp: 115 } }));
    expect(said(app, "i2")).toBe("Tam sold Potion back for 75 gp.");
    expect(gold(app)).toBe("115 gp left");
  });

  it("lands once: a second word on the same item changes nothing", async () => {
    const app = await waitedOut();
    heardParted(late());
    const before = gold(app);
    heardParted(late({ part: { soldCp: 7500 }, purse: { gp: 115 } }));
    expect(said(app, "i1")).toBe("Tam gave Sling +1 to Saria.");
    expect(gold(app)).toBe(before);
  });

  it("ignores the socket's copy (no `own`): the picker stays open and the countdown held", async () => {
    const app = await waitedOut();
    heardParted(fromRow());
    app.partHeard(fromRow({ part: { soldCp: 7500 }, purse: { gp: 115 } }));
    expect(said(app, "i1")).toBe(WAITED);
    expect(rowOf(app, "i1").dataset.parted).toBeUndefined();
    expect(rowOf(app, "i1").querySelector(".lc-after__pick").hidden).toBe(false);
    expect(gold(app)).toBe("40 gp left");
    vi.advanceTimersByTime(60_000);
    expect(app.state).toBe(1);
    // The winner's own answer still lands after it.
    heardParted(late());
    expect(said(app, "i1")).toBe("Tam gave Sling +1 to Saria.");
  });

  it("a closed window ignores both", async () => {
    const app = await waitedOut();
    await app.close();
    expect(() => heardParted(late())).not.toThrow();
    app.partHeard(late({ purse: { gp: 115 } }));
    app.partHeard(fromRow({ purse: { gp: 115 } }));
    expect(said(app, "i1")).toBe(WAITED);
    expect(rowOf(app, "i1").querySelector(".lc-after__pick")).not.toBeNull();
    expect(gold(app)).toBe("40 gp left");
  });

  it("a replay of the play ignores both", async () => {
    const app = new CrateReveal(reveal({ replay: true, replayKey: "m1", requestId: null }));
    await app.render({ force: true });
    controllers.at(-1).land();
    await settle();
    // A replay offers nothing and says nothing of the play's purse.
    expect(slotOf(app).hidden).toBe(true);
    for (const itemId of ["i1", "i2"]) {
      heardParted(late({ itemId }));
      app.partHeard(late({ itemId }));
      app.partHeard(fromRow({ itemId }));
    }
    expect(slotOf(app).childElementCount).toBe(0);
    // Every item heard as parted would take "Added to" off the result's line.
    expect(app.element.querySelector(".lc-reveal__added").textContent).toBe("Added to Tam's inventory");
  });

  it("touches only the window of its own play", async () => {
    const other = await waitedOut({ requestId: "r2", logId: "L2" });
    const app = await waitedOut();
    heardParted(late({ purse: { gp: 115 } }));
    expect(said(app, "i1")).toBe("Tam gave Sling +1 to Saria.");
    expect(said(other, "i1")).toBe(WAITED);
    expect(rowOf(other, "i1").querySelector(".lc-after__pick").hidden).toBe(false);
    expect(gold(other)).toBe("40 gp left");
  });
});
