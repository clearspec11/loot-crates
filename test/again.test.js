/*
  The reveal window's Draw again (reveal.js): a kind that offers the buyer
  a next play from the window (kinds.js reveal.again, the deck's) gets the
  core's button on landing, for the buyer alone, never on a replay. The
  offer is asked for again at the click, so the price sent is the one the
  log says then; the play goes out as an ordinary pull (socket.js
  requestPull), the button reads "Drawing…" while it is out, the window
  closes once the next has opened, and a refusal is said with the button
  back. An offer that is off shows its reason and sends nothing.
  ApplicationV2 is a stand-in that renders once into a fake root, as in
  kindreveal.test.js.
*/
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../module/scripts/sound.js", () => ({ playTick: vi.fn(), playSlow: vi.fn(), playReveal: vi.fn() }));
vi.mock("../module/scripts/socket.js", () => ({ requestPull: vi.fn() }));
vi.mock("../module/scripts/store.js", () => ({ getBoxes: vi.fn(() => ({})), getPools: vi.fn(() => ({})), getLog: vi.fn(() => []), getRounds: vi.fn(() => ({})), isShopOpen: vi.fn(() => true) }));

const fakeElement = () => {
  const el = {
    className: "", textContent: "", innerHTML: "", clientWidth: 600, dataset: {}, children: [], hidden: false, id: "",
    classes: new Set(), attrs: new Map(),
    classList: { add(c) { el.classes.add(c); }, remove(c) { el.classes.delete(c); }, contains(c) { return el.classes.has(c); } },
    style: { transform: "", setProperty() {} },
    setAttribute(k, v) { el.attrs.set(k, String(v)); },
    getAttribute(k) { return el.attrs.has(k) ? el.attrs.get(k) : null; },
    removeAttribute(k) { el.attrs.delete(k); },
    append(...kids) { el.children.push(...kids); },
    appendChild(kid) { el.children.push(kid); },
    replaceChildren() {},
    remove() { el.removed = true; },
    focus() {},
    contains: () => false,
  };
  return el;
};

class FakeApp {
  constructor(options) { this.options = options; this.state = 0; this.closed = 0; }
  async render() {
    if (this.options?.id) globalThis.foundry.applications.instances.set(this.options.id, this);
    const html = await this._renderHTML();
    const parts = new Map();
    this.element = { querySelector: sel => parts.get(sel) ?? parts.set(sel, fakeElement()).get(sel), contains: el => [...parts.values()].includes(el) };
    this._replaceHTML(html, fakeElement());
    this.state = 1;
    this._onRender();
    return this;
  }
  _onClose() {}
  close() { this.closed++; this.state = 0; globalThis.foundry.applications.instances.delete(this.options?.id); this._onClose({}); }
}

vi.stubGlobal("foundry", { applications: { api: { ApplicationV2: FakeApp }, instances: new Map() }, utils: { escapeHTML: s => s } });
const { showReveal, CrateReveal, _resetHolds } = await import("../module/scripts/reveal.js");
const { registerKind, _resetKinds } = await import("../module/scripts/kinds.js");
const { requestPull } = await import("../module/scripts/socket.js");
const store = await import("../module/scripts/store.js");

// A deck-like kind: lands at once; its offer is whatever the test sets.
let offer;
const again = vi.fn(() => offer);
const DECK = {
  id: "deckish",
  async roll() { return { result: null }; },
  reveal: { title: "A card", result: () => "", again, replayable: false },
};
const PLAIN = { id: "plain", async roll() { return { result: null }; } };

const GAME = { id: "d1", kind: "deckish", name: "The Deck", price: 10 };
const reveal = extra => ({ kind: "deckish", requestId: "r1", userId: "p1", actorId: "a1", actorName: "Tam", box: { id: "d1", name: "The Deck", price: 10 }, result: { name: "Windfall" }, itemId: null, itemUuid: null, logId: "L1", purse: {}, ...extra });
const press = (app, button) => app.constructor.DEFAULT_OPTIONS.actions.drawAgain.call(app, { detail: 1 }, button);
const settle = () => new Promise(r => setTimeout(r, 0));

let doc, toasts;
beforeEach(() => {
  offer = { price: 15, label: "Draw again for 15 gp", off: "" };
  toasts = [];
  doc = { visibilityState: "visible", activeElement: null, body: {}, head: { append() {} }, createElement: fakeElement, getElementById: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", { innerWidth: 1440, innerHeight: 900 });
  vi.stubGlobal("requestAnimationFrame", cb => cb(0));
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("foundry", { applications: { api: { ApplicationV2: FakeApp }, instances: new Map() }, utils: { escapeHTML: s => s } });
  vi.stubGlobal("game", { user: { id: "p1", isGM: false }, users: { activeGM: { id: "gm" } }, actors: { get: () => ({ system: { currency: { gp: 40 } } }) }, settings: { get: () => true } });
  vi.stubGlobal("ui", { notifications: { warn: m => toasts.push(m), info() {} } });
  vi.stubGlobal("fromUuidSync", () => null);
  store.getBoxes.mockReturnValue({ d1: GAME });
  store.getLog.mockReturnValue([{ id: "x" }]);
  requestPull.mockReset();
  again.mockClear();
  registerKind(DECK);
  registerKind(PLAIN);
});
afterEach(() => { _resetHolds(); _resetKinds(["crate"]); vi.unstubAllGlobals(); });

describe("Draw again", () => {
  it("shows the kind's offer to the buyer on landing, with the record, log, purse and shop state", async () => {
    const app = await showReveal(reveal());
    await app.landed;
    const btn = app.element.querySelector(".lc-reveal__again");
    expect(btn.hidden).toBe(false);
    expect(btn.textContent).toBe("Draw again for 15 gp");
    expect(btn.getAttribute("aria-disabled")).toBeNull();
    expect(app.element.querySelector(".lc-reveal__why").hidden).toBe(true);
    expect(again).toHaveBeenCalledWith(expect.objectContaining({ requestId: "r1" }), expect.objectContaining({ game: GAME, log: [{ id: "x" }], purse: { gp: 40 }, open: true, gmOnline: true }));
    expect(typeof again.mock.calls[0][1].now).toBe("number");
  });

  it("hides it from the table, on a replay, for a kind without one, and when the record is gone", async () => {
    vi.stubGlobal("game", { user: { id: "other", isGM: true }, users: { activeGM: { id: "gm" } }, actors: { get: () => null }, settings: { get: () => true } });
    const table = await showReveal(reveal());
    await table.landed;
    expect(table.element.querySelector(".lc-reveal__again").hidden).toBe(true);
    expect(again).not.toHaveBeenCalled();
    vi.stubGlobal("game", { user: { id: "p1", isGM: false }, users: { activeGM: { id: "gm" } }, actors: { get: () => null }, settings: { get: () => true } });
    const plain = await showReveal(reveal({ kind: "plain", requestId: "r2" }));
    await plain.landed;
    expect(plain.element.querySelector(".lc-reveal__again").hidden).toBe(true);
    store.getBoxes.mockReturnValue({});
    const gone = await showReveal(reveal({ requestId: "r3" }));
    await gone.landed;
    expect(gone.element.querySelector(".lc-reveal__again").hidden).toBe(true);
    expect(again).not.toHaveBeenCalled();
    store.getBoxes.mockReturnValue({ d1: GAME });
    const replay = new CrateReveal(reveal({ replay: true, replayKey: "k", requestId: undefined }));
    await replay.render();
    await replay.landed;
    expect(replay.element.querySelector(".lc-reveal__again").hidden).toBe(true);
  });

  it("an offer that is off shows its reason before the button, which is aria-disabled and sends nothing", async () => {
    offer = { price: 15, label: "Draw again for 15 gp", off: "Needs 3 gp more" };
    const app = await showReveal(reveal());
    await app.landed;
    const btn = app.element.querySelector(".lc-reveal__again");
    const why = app.element.querySelector(".lc-reveal__why");
    expect(btn.hidden).toBe(false);
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(why.hidden).toBe(false);
    expect(why.textContent).toBe("Needs 3 gp more");
    expect(why.id).toBe("lc-reveal-why-r1");
    expect(btn.getAttribute("aria-describedby")).toBe("lc-reveal-why-r1");
    await press(app, btn);
    expect(requestPull).not.toHaveBeenCalled();
    expect(app.closed).toBe(0);
  });

  it("sends the next play as a pull at the price the kind names at the click, reads Drawing… meanwhile, and closes once it resolves", async () => {
    const app = await showReveal(reveal());
    await app.landed;
    const btn = app.element.querySelector(".lc-reveal__again");
    // The price fell since the landing (the streak ran out): the click sends the fresh one.
    offer = { price: 10, label: "Draw again for 10 gp", off: "" };
    let resolve;
    requestPull.mockReturnValue(new Promise(r => { resolve = r; }));
    const pressed = press(app, btn);
    expect(requestPull).toHaveBeenCalledWith({ boxId: "d1", actorId: "a1", price: 10 });
    expect(btn.textContent).toBe("Drawing…");
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    // A second press while it is out sends nothing.
    await press(app, btn);
    expect(requestPull).toHaveBeenCalledTimes(1);
    expect(app.closed).toBe(0);
    resolve({ type: "reveal" });
    await pressed;
    expect(app.closed).toBe(1);
  });

  it("says a refusal and gives the button back, with the offer as it stands then", async () => {
    const app = await showReveal(reveal());
    await app.landed;
    const btn = app.element.querySelector(".lc-reveal__again");
    requestPull.mockRejectedValue(new Error("The Deck now costs 10 gp (you pressed 15 gp). Nothing was charged."));
    await press(app, btn);
    await settle();
    expect(toasts).toEqual(["The Deck now costs 10 gp (you pressed 15 gp). Nothing was charged."]);
    expect(app.closed).toBe(0);
    expect(btn.textContent).toBe("Draw again for 15 gp");
    expect(btn.getAttribute("aria-disabled")).toBeNull();
    // And it can be pressed again.
    requestPull.mockResolvedValue({ type: "reveal" });
    await press(app, btn);
    expect(requestPull).toHaveBeenCalledTimes(2);
    expect(app.closed).toBe(1);
  });
});
