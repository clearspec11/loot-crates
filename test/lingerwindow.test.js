/*
  The countdown wired into the game windows (reveal.js CrateReveal,
  tablewindow.js TableWindow; linger.js): with fake timers and the
  player's setting at 10 s, a reveal never closes before its result has
  landed, then closes 10 s after through its Close (focus back on the
  buyer's Buy, as a Close sends it); Skip counts as the landing; Watch
  again holds it while the replay plays and starts it over once it lands;
  the pointer or the user's focus inside holds it; Keep open keeps it; Off
  never closes. A table window counts down only once its round is settled
  here or called off, never while bets are open or the wheel turns.
  ApplicationV2 is a stand-in that puts each window in a minimal DOM.
*/
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createDocument } from "./minidom.js";

vi.mock("../module/scripts/sound.js", () => ({ playTick: vi.fn(), playSlow: vi.fn(), playReveal: vi.fn(), playDrop: vi.fn(), playCoinBack: vi.fn(), playPlop: vi.fn(), playPlink: vi.fn(), playBane: vi.fn() }));
vi.mock("../module/scripts/socket.js", () => ({ requestPull: vi.fn(), requestStake: vi.fn(), isActiveGM: vi.fn(() => true) }));
vi.mock("../module/scripts/table.js", () => ({ onTable: vi.fn(), openRound: vi.fn(), resolveRound: vi.fn(), cancelRound: vi.fn() }));
vi.mock("../module/scripts/shop.js", () => ({ buyableActors: vi.fn(() => []) }));
vi.mock("../module/scripts/store.js", () => ({ getBoxes: vi.fn(() => ({})), getPools: vi.fn(() => ({})), getLog: vi.fn(() => []), getRounds: vi.fn(() => ({})), todayKey: vi.fn(() => null), isShopOpen: vi.fn(() => true), getActorState: vi.fn(() => ({})) }));

// A window in the page: a section holding the content, removed on close
// before _onClose runs, as ApplicationV2 does.
class DomApp {
  constructor(options) { this.options = options; this.state = 0; this.closed = 0; }
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
    this.state = 1;
    await this._onRender?.();
    return this;
  }
  _onClose() {}
  async close() {
    this.closed++;
    this.state = 0;
    this.element.remove();
    this._onClose({});
  }
}

vi.stubGlobal("foundry", { applications: { api: { ApplicationV2: DomApp }, instances: new Map() }, utils: { escapeHTML: s => String(s ?? "") } });
const { showReveal, CrateReveal, _resetHolds } = await import("../module/scripts/reveal.js");
const { TableWindow } = await import("../module/scripts/tablewindow.js");
const { registerKind, _resetKinds } = await import("../module/scripts/kinds.js");
const store = await import("../module/scripts/store.js");

// A crate-like kind whose spin lands when the test says (or on Skip).
let controllers;
const CRATEISH = {
  id: "crateish",
  async roll() { return { result: null }; },
  reveal: {
    title: "A crate",
    play(_host, _reveal, { onLand }) {
      let done = false;
      const c = { skipped: false, reducedMotion: false, play() {}, skip() { if (!done) { done = true; c.skipped = true; onLand(); } }, land() { if (!done) { done = true; onLand(); } } };
      controllers.push(c);
      return c;
    },
    result: r => `<div class="lc-reveal__name">${r.result.name}</div>`,
    replayable: true,
  },
};
const reveal = extra => ({ kind: "crateish", requestId: "r1", userId: "p1", actorId: "a1", actorName: "Tam", box: { id: "c1", name: "The Crate", price: 10 }, result: { name: "Sling +1" }, itemId: null, itemUuid: null, logId: "L1", purse: {}, ...extra });
const act = (app, name, button) => app.constructor.DEFAULT_OPTIONS.actions[name].call(app, { detail: 0 }, button);
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

// A table kind whose wheel lands when the test says.
let wheels;
const TABLEISH = {
  id: "tableish",
  table: true,
  async roll() { return { result: null }; },
  tableView: {
    title: () => "The wheel",
    verb: "bets",
    pockets: () => [],
    pocketsIn: () => [],
    outcomeIndex: () => 0,
    rail: () => "",
    rarityOf: () => "common",
    result: () => `<p class="lc-table__verdict">Red wins.</p>`,
    mount() {
      return {
        rail() {},
        spin({ onLand }) {
          let done = false;
          const c = { play() {}, skip() { c.land(); }, land() { if (!done) { done = true; onLand(); } } };
          wheels.push(c);
          return c;
        },
      };
    },
  },
};

let doc, setting, buy;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  controllers = [];
  wheels = [];
  setting = 10;
  doc = createDocument();
  Object.assign(doc, { visibilityState: "visible", addEventListener() {}, removeEventListener() {} });
  // The buyer's shop, with the Buy they pressed.
  const shop = doc.createElement("div");
  shop.innerHTML = `<div class="lc-shop"><button type="button" class="lc-box__buy" data-box="c1">Open for 10 gp</button></div>`;
  doc.body.append(shop);
  buy = doc.querySelector(".lc-box__buy");
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", { innerWidth: 1440, innerHeight: 900 });
  vi.stubGlobal("CSS", { escape: s => String(s) });
  vi.stubGlobal("foundry", { applications: { api: { ApplicationV2: DomApp }, instances: new Map() }, utils: { escapeHTML: s => String(s ?? "") } });
  vi.stubGlobal("game", { user: { id: "p1", isGM: false, character: null }, users: { activeGM: { id: "gm" } }, actors: { get: () => null }, settings: { get: (_m, key) => (key === "closeFinished" ? setting : true) } });
  vi.stubGlobal("ui", { notifications: { warn() {}, info() {} } });
  vi.stubGlobal("fromUuidSync", () => null);
  registerKind(CRATEISH);
  registerKind(TABLEISH);
});
afterEach(() => {
  vi.useRealTimers();
  _resetHolds();
  _resetKinds(["crate", "roulette", "auction"]);
  vi.unstubAllGlobals();
});

describe("a reveal closes by itself once landed", () => {
  it("never before the landing, then 10 s after it through its Close, focus back on the Buy", async () => {
    buy.focus();
    const app = await showReveal(reveal());
    vi.advanceTimersByTime(60000);
    expect(app.closed).toBe(0);
    expect(app.element.querySelector(".lc-linger")).toBeNull();
    controllers[0].land();
    await settle();
    const close = app.element.querySelector(".lc-reveal__close");
    expect(doc.activeElement).toBe(close);
    expect(app.element.querySelector(".lc-linger__text").textContent).toBe("Closes in 10 s");
    expect(app.element.querySelector(".lc-reveal__actions").firstElementChild.classList.contains("lc-linger")).toBe(true);
    vi.advanceTimersByTime(9999);
    expect(app.closed).toBe(0);
    vi.advanceTimersByTime(1);
    expect(app.closed).toBe(1);
    expect(doc.activeElement).toBe(buy);
  });

  it("counts a Skip as the landing", async () => {
    const app = await showReveal(reveal());
    act(app, "skip");
    vi.advanceTimersByTime(10000);
    expect(app.closed).toBe(1);
  });

  it("holds while Watch again replays, and starts over once the replay lands", async () => {
    const app = await showReveal(reveal());
    act(app, "skip");
    vi.advanceTimersByTime(6000);
    const watch = app.element.querySelector(".lc-reveal__watch");
    expect(watch.hidden).toBe(false);
    act(app, "watchAgain", watch);
    expect(app.element.querySelector(".lc-linger__text").textContent).toBe("Paused, 4 s left");
    vi.advanceTimersByTime(60000);
    expect(app.closed).toBe(0);
    controllers[1].land();
    expect(app.element.querySelector(".lc-linger__text").textContent).toBe("Closes in 10 s");
    vi.advanceTimersByTime(9999);
    expect(app.closed).toBe(0);
    vi.advanceTimersByTime(1);
    expect(app.closed).toBe(1);
  });

  it("holds while focus the user brought is inside, and runs on with the time left once it leaves", async () => {
    const app = await showReveal(reveal());
    controllers[0].land();
    vi.advanceTimersByTime(3000);
    const close = app.element.querySelector(".lc-reveal__close");
    app.element.dispatchEvent({ type: "focusin", target: close });
    vi.advanceTimersByTime(60000);
    expect(app.closed).toBe(0);
    app.element.dispatchEvent({ type: "focusout", target: close, relatedTarget: doc.body });
    vi.advanceTimersByTime(6999);
    expect(app.closed).toBe(0);
    vi.advanceTimersByTime(1);
    expect(app.closed).toBe(1);
  });

  it("holds while the pointer is over the window", async () => {
    const app = await showReveal(reveal());
    app.element.dispatchEvent({ type: "pointerenter" });
    controllers[0].land();
    vi.advanceTimersByTime(60000);
    expect(app.closed).toBe(0);
    expect(app.element.querySelector(".lc-linger__text").textContent).toBe("Paused, 10 s left");
    app.element.dispatchEvent({ type: "pointerleave" });
    vi.advanceTimersByTime(10000);
    expect(app.closed).toBe(1);
  });

  it("Keep open keeps it, and focus goes from the button to Close", async () => {
    const app = await showReveal(reveal());
    controllers[0].land();
    const keep = app.element.querySelector(".lc-linger__keep");
    keep.focus();
    keep.dispatchEvent({ type: "click", preventDefault() {} });
    expect(app.element.querySelector(".lc-linger")).toBeNull();
    expect(doc.activeElement).toBe(app.element.querySelector(".lc-reveal__close"));
    vi.advanceTimersByTime(600000);
    expect(app.closed).toBe(0);
  });

  it("never closes with the setting at Off, and draws no line", async () => {
    setting = 0;
    const app = await showReveal(reveal());
    controllers[0].land();
    expect(app.element.querySelector(".lc-linger")).toBeNull();
    vi.advanceTimersByTime(600000);
    expect(app.closed).toBe(0);
  });

  it("a replay window from the chat card closes the same way", async () => {
    const app = new CrateReveal(reveal({ replay: true, replayKey: "m1", requestId: undefined, logId: undefined }));
    await app.render();
    controllers[0].land();
    vi.advanceTimersByTime(10000);
    expect(app.closed).toBe(1);
  });

  it("closed by hand first, its countdown is gone", async () => {
    const app = await showReveal(reveal());
    controllers[0].land();
    await app.close();
    vi.advanceTimersByTime(60000);
    expect(app.closed).toBe(1);
  });
});

describe("a table window closes by itself once its round is over", () => {
  const ROUND = { id: "R1", boxId: "w1", status: "open", closesAt: null };
  const resolve = () => ({ type: "round", event: "resolve", roundId: "R1", boxId: "w1", kind: "tableish", box: { id: "w1", name: "Wheel" }, outcome: { index: 0 }, stakes: [] });
  beforeEach(() => {
    store.getBoxes.mockReturnValue({ w1: { id: "w1", kind: "tableish", name: "Wheel", price: 5 } });
    store.getRounds.mockReturnValue({ R1: ROUND });
  });

  it("never while bets are open or the wheel turns; 10 s after the result shows", async () => {
    const win = new TableWindow("R1", "w1");
    await win.render({ force: true });
    vi.advanceTimersByTime(60000);
    expect(win.closed).toBe(0);
    expect(win.element.querySelector(".lc-linger")).toBeNull();
    await win.play(resolve());
    vi.advanceTimersByTime(60000);
    expect(win.closed).toBe(0);
    expect(win.element.querySelector(".lc-linger")).toBeNull();
    wheels[0].land();
    expect(win.element.querySelector(".lc-table__result").textContent).toBe("Red wins.");
    expect(win.element.querySelector(".lc-linger__text").textContent).toBe("Closes in 10 s");
    vi.advanceTimersByTime(9999);
    expect(win.closed).toBe(0);
    vi.advanceTimersByTime(1);
    expect(win.closed).toBe(1);
  });

  it("10 s after the round is called off", async () => {
    const win = new TableWindow("R1", "w1");
    await win.render({ force: true });
    win.heardVoid({ cancelled: true });
    await settle();
    expect(win.element.querySelector(".lc-linger__text")?.textContent).toBe("Closes in 10 s");
    vi.advanceTimersByTime(10000);
    expect(win.closed).toBe(1);
  });

  it("not for a round this client hasn't heard of yet", async () => {
    store.getRounds.mockReturnValue({});
    const win = new TableWindow("R1", "w1");
    await win.render({ force: true });
    vi.advanceTimersByTime(60000);
    expect(win.closed).toBe(0);
  });

  it("holds while the pointer is over it", async () => {
    const win = new TableWindow("R1", "w1");
    await win.render({ force: true });
    await win.play(resolve());
    win.element.dispatchEvent({ type: "pointerenter" });
    wheels[0].land();
    vi.advanceTimersByTime(60000);
    expect(win.closed).toBe(0);
    win.element.dispatchEvent({ type: "pointerleave" });
    vi.advanceTimersByTime(10000);
    expect(win.closed).toBe(1);
  });
});
