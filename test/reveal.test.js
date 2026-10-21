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
  focus() { if (doc) doc.activeElement = this; },
  contains: () => false,
});

class FakeApp {
  constructor(options) { this.options = options; this.state = 0; }
  async render() {
    const html = await this._renderHTML();
    const parts = new Map();
    this.element = { querySelector: sel => parts.get(sel) ?? parts.set(sel, fakeElement()).get(sel), contains: el => [...parts.values()].includes(el) };
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
    querySelectorAll: () => [],
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

const { showReveal, sealChatCard } = await import("../module/scripts/reveal.js");
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

/*
  The chat card goes out with the result, seconds before a watching client's
  spin lands: there it is sealed (its head and "Opening…") until that spin
  lands, so chat never gives the result away.
*/
function cardHTML({ refunded = false } = {}) {
  const classes = new Set(["loot-crates", "lc-chat", ...(refunded ? ["lc-chat--refunded"] : [])]);
  const kids = [];
  const card = {
    classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
    append: (...k) => kids.push(...k.map(x => Object.assign(x, { remove: () => kids.splice(kids.indexOf(x), 1) }))),
    kids, classes,
  };
  return { card, html: { querySelector: sel => (sel === ".lc-chat" ? card : null) } };
}
const message = logId => ({ flags: { "loot-crates": { logId } } });

describe("the chat card while a spin plays here", () => {
  it("is sealed until this client's reveal of that pull lands", async () => {
    const app = await showReveal({ ...reveal, requestId: "s1", logId: "L1" });
    const { card, html } = cardHTML();
    sealChatCard(message("L1"), html);
    expect(card.classes.has("lc-chat--sealed")).toBe(true);
    expect(card.kids.map(k => k.textContent)).toEqual(["Opening…"]);
    for (let now = 0; frames.length; now += 16) frames.shift()(now);
    await app.landed;
    await Promise.resolve();
    expect(card.classes.has("lc-chat--sealed")).toBe(false);
    expect(card.kids).toHaveLength(0);
    // Rendered again after landing (a notification, a refund): whole.
    const again = cardHTML();
    sealChatCard(message("L1"), again.html);
    expect(again.card.classes.has("lc-chat--sealed")).toBe(false);
  });

  it("is opened when the window is closed before landing", async () => {
    const app = await showReveal({ ...reveal, requestId: "s2", logId: "L2" });
    const { card, html } = cardHTML();
    sealChatCard(message("L2"), html);
    app.close();
    await app.landed;
    await Promise.resolve();
    expect(card.classes.has("lc-chat--sealed")).toBe(false);
  });

  it("is whole on a hidden page, for another pull, and when refunded", async () => {
    doc.visibilityState = "hidden";
    await showReveal({ ...reveal, requestId: "s3", logId: "L3" });
    await Promise.resolve();
    const hidden = cardHTML();
    sealChatCard(message("L3"), hidden.html);
    expect(hidden.card.classes.has("lc-chat--sealed")).toBe(false);
    doc.visibilityState = "visible";
    await showReveal({ ...reveal, requestId: "s4", logId: "L4" });
    const other = cardHTML();
    sealChatCard(message("nope"), other.html);
    sealChatCard({ flags: {} }, other.html);
    expect(other.card.classes.has("lc-chat--sealed")).toBe(false);
    const refunded = cardHTML({ refunded: true });
    sealChatCard(message("L4"), refunded.html);
    expect(refunded.card.classes.has("lc-chat--sealed")).toBe(false);
  });
});

/*
  The shop keeps focus on the Buy the buyer pressed (boxcard.js patchShop),
  so that focus mustn't count as "busy elsewhere": the buyer's Close still
  gets focus on landing, and closing hands it back to the crate they bought.
  Anyone else's focus on a Buy is theirs to keep.
*/
describe("focus between the buyer's Buy and the reveal", () => {
  const buyFor = box => ({ dataset: { box }, isConnected: true, focus() { doc.activeElement = this; } });
  const land = async app => {
    for (let now = 0; frames.length; now += 16) frames.shift()(now);
    await app.landed;
  };
  const mine = { ...reveal, userId: "u" };

  it("moves the buyer's focus from their Buy to Close on landing, and back on close", async () => {
    const buy = buyFor("b");
    doc.querySelectorAll = sel => sel === ".lc-shop .lc-box__buy" ? [buyFor("other"), buy] : [];
    buy.focus();
    const app = await showReveal(mine);
    expect(doc.activeElement).toBe(buy);
    await land(app);
    const close = app.element.querySelector(".lc-reveal__close");
    expect(doc.activeElement).toBe(close);
    app.close();
    expect(doc.activeElement).toBe(buy);
  });

  it("leaves focus on a Buy that isn't this pull's buyer's", async () => {
    const buy = buyFor("b");
    doc.querySelectorAll = () => [buy];
    buy.focus();
    // Another player's pull of the same crate.
    const app = await showReveal(reveal);
    await land(app);
    expect(doc.activeElement).toBe(buy);
    // The buyer's own Buy for another crate isn't theirs to leave either.
    const other = buyFor("x");
    doc.querySelectorAll = () => [other];
    other.focus();
    const app2 = await showReveal({ ...mine, requestId: "r2" });
    await land(app2);
    expect(doc.activeElement).toBe(other);
  });

  it("doesn't pull focus back to the Buy when the buyer has moved on, or the Buy is gone", async () => {
    const buy = buyFor("b");
    doc.querySelectorAll = () => [buy];
    buy.focus();
    const app = await showReveal(mine);
    await land(app);
    const chat = { focus() {} };
    doc.activeElement = chat;
    app.close();
    expect(doc.activeElement).toBe(chat);
    const app2 = await showReveal({ ...mine, requestId: "r3" });
    await land(app2);
    buy.isConnected = false;
    doc.activeElement = app2.element.querySelector(".lc-reveal__close");
    app2.close();
    expect(doc.activeElement).not.toBe(buy);
  });
});
