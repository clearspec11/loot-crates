/*
  The reveal window on a page that is hidden: a hidden page runs no animation
  frames, so the spin must land without one. ApplicationV2 is a stand-in that
  renders once into a fake root; the spin is the real one, on a fake DOM.
*/
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../module/scripts/sound.js", () => ({ playTick: vi.fn(), playSlow: vi.fn(), playReveal: vi.fn() }));

const fakeElement = () => ({
  className: "", textContent: "", innerHTML: "", clientWidth: 600, dataset: {}, children: [], hidden: false,
  classList: { add() {} },
  style: { transform: "", setProperty() {} },
  setAttribute() {},
  append(...kids) { this.children.push(...kids); },
  appendChild(kid) { this.children.push(kid); },
  replaceChildren() {},
  focus() {},
  contains: () => false,
});

class FakeApp {
  constructor(options) { this.options = options; this.state = 0; }
  async render() {
    const html = await this._renderHTML();
    const parts = new Map();
    this.element = { querySelector: sel => parts.get(sel) ?? parts.set(sel, fakeElement()).get(sel) };
    this._replaceHTML(html, fakeElement());
    this.state = 1;
    this._onRender();
    return this;
  }
  _onClose() {}
  close() { this._onClose({}); }
}

let frames, listeners, doc;
// reveal.js reads foundry.applications.api when it is imported.
vi.stubGlobal("foundry", { applications: { api: { ApplicationV2: FakeApp }, instances: new Map() }, utils: { escapeHTML: s => s } });
beforeEach(() => {
  frames = [];
  listeners = new Map();
  doc = {
    visibilityState: "visible",
    activeElement: null,
    body: {},
    createElement: fakeElement,
    addEventListener: (type, fn) => listeners.set(fn, type),
    removeEventListener: (_type, fn) => listeners.delete(fn),
  };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", { innerWidth: 1440, innerHeight: 900 });
  vi.stubGlobal("requestAnimationFrame", cb => frames.push(cb));
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("foundry", { applications: { api: { ApplicationV2: FakeApp }, instances: new Map() }, utils: { escapeHTML: s => s } });
  vi.stubGlobal("game", { user: { id: "u", isGM: false }, settings: { get: () => true } });
  vi.stubGlobal("fromUuidSync", () => null);
});
afterEach(() => vi.unstubAllGlobals());

const reveal = {
  requestId: "r1", userId: "p1", actorName: "Crate Tester", box: { id: "b", name: "Crate", price: 10 },
  result: { name: "Sword", rarity: "rare", img: "" },
  strip: { landIndex: 30, cards: Array.from({ length: 36 }, (_, i) => ({ uuid: `c${i}`, name: `Card ${i}`, img: "", rarity: "common", result: i === 30 })) },
};

const { showReveal } = await import("../module/scripts/reveal.js");
const { playReveal, playSlow } = await import("../module/scripts/sound.js");

describe("a reveal on a hidden page", () => {
  it("lands at once when it opens hidden, without a frame, silently", async () => {
    doc.visibilityState = "hidden";
    const app = await showReveal(reveal);
    let landed = false;
    app.landed.then(() => { landed = true; });
    await Promise.resolve();
    expect(landed).toBe(true);
    expect(frames).toHaveLength(0);
    expect(app.element.querySelector(".lc-reveal__close").textContent).toBe("Close");
    expect(playReveal).not.toHaveBeenCalled();
    expect(playSlow).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });

  it("lands as soon as the page is hidden mid-spin, and stops listening", async () => {
    const app = await showReveal(reveal);
    for (let now = 0; now < 500; now += 16) frames.shift()(now);
    let landed = false;
    app.landed.then(() => { landed = true; });
    await Promise.resolve();
    expect(landed).toBe(false);
    doc.visibilityState = "hidden";
    for (const [fn] of listeners) fn();
    await Promise.resolve();
    expect(landed).toBe(true);
    expect(listeners.size).toBe(0);
    // The loop's next frame (when the page is shown again) draws nothing more.
    frames.shift()?.(600);
    expect(frames).toHaveLength(0);
  });

  it("plays the spin as before on a visible page", async () => {
    const app = await showReveal(reveal);
    expect(frames).toHaveLength(1);
    expect(app.element.querySelector(".lc-reveal__close").textContent).toBe("");
    for (let now = 0; frames.length; now += 16) frames.shift()(now);
    await app.landed;
    expect(app.element.querySelector(".lc-reveal__close").textContent).toBe("Close");
    expect(listeners.size).toBe(0);
  });
});
