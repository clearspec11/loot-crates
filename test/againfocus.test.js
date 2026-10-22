/*
  Where focus goes on Draw again (reveal.js): straight from the button to
  the next window's one button (Skip, then Close on the same node), never
  through the shop's Buy, which is aria-disabled "Still turning" for the
  whole of the next reveal. Closing the old window first sent it there, so
  a screen reader announced that Buy before the new Close took focus at
  the landing. Run in a minimal DOM where, as in a browser, a focused node
  that is removed drops focus to the body, and every focus move is
  recorded. ApplicationV2 is a stand-in that puts each window in the page.
*/
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createDocument } from "./minidom.js";

vi.mock("../module/scripts/sound.js", () => ({ playTick: vi.fn(), playSlow: vi.fn(), playReveal: vi.fn() }));
vi.mock("../module/scripts/socket.js", () => ({ requestPull: vi.fn() }));
vi.mock("../module/scripts/store.js", () => ({ getBoxes: vi.fn(() => ({})), getPools: vi.fn(() => ({})), getLog: vi.fn(() => []), getRounds: vi.fn(() => ({})), isShopOpen: vi.fn(() => true) }));

// A window in the page: a section holding the content, removed on close
// before _onClose runs, as ApplicationV2 does.
class DomApp {
  constructor(options) { this.options = options; this.state = 0; }
  async render() {
    const html = await this._renderHTML();
    const section = document.createElement("section");
    section.className = "application lc-reveal";
    const content = document.createElement("div");
    content.className = "window-content";
    section.append(content);
    document.body.append(section);
    this.element = section;
    this._replaceHTML(html, content);
    this.state = 1;
    await this._onRender();
    return this;
  }
  _onClose() {}
  close() {
    this.state = 0;
    this.element.remove();
    this._onClose({});
  }
}

vi.stubGlobal("foundry", { applications: { api: { ApplicationV2: DomApp }, instances: new Map() }, utils: { escapeHTML: s => String(s ?? "") } });
const { showReveal, CrateReveal, _resetHolds } = await import("../module/scripts/reveal.js");
const { CLOSE_GRACE_MS } = await import("../module/scripts/revealcard.js");
const { registerKind, _resetKinds } = await import("../module/scripts/kinds.js");
const { requestPull } = await import("../module/scripts/socket.js");
const store = await import("../module/scripts/store.js");

// A deck-like kind whose card lands when the test says.
let controllers;
const DECK = {
  id: "deckish",
  async roll() { return { result: null }; },
  reveal: {
    title: "A card",
    play(_host, _reveal, { onLand }) {
      const c = { skipped: false, reducedMotion: false, play() {}, skip() { c.skipped = true; onLand(); }, land: onLand };
      controllers.push(c);
      return c;
    },
    result: r => `<div class="lc-reveal__name">${r.result.name}</div>`,
    again: () => ({ price: 15, label: "Draw again for 15 gp", off: "" }),
    replayable: false,
  },
};
const GAME = { id: "d1", kind: "deckish", name: "The Deck", price: 10 };
const reveal = extra => ({ kind: "deckish", requestId: "r1", userId: "p1", actorId: "a1", actorName: "Tam", box: { id: "d1", name: "The Deck", price: 10 }, result: { name: "Windfall" }, itemId: null, itemUuid: null, logId: "L1", purse: {}, ...extra });
const act = (app, name, button, detail = 0) => CrateReveal.DEFAULT_OPTIONS.actions[name].call(app, { detail }, button);

let doc, trail, buy, notes, warns;
beforeEach(() => {
  controllers = [];
  notes = [];
  warns = [];
  doc = createDocument();
  // Every focus move, in order.
  trail = [];
  let active = doc.activeElement;
  Object.defineProperty(doc, "activeElement", { get: () => active, set: el => { active = el; trail.push(el); } });
  Object.assign(doc, { visibilityState: "visible", addEventListener() {}, removeEventListener() {} });
  // The buyer's shop, its Buy for this deck held while the next draw turns.
  const shop = doc.createElement("div");
  shop.innerHTML = `<div class="lc-shop"><button type="button" class="lc-box__buy" data-box="d1" aria-disabled="true">Still turning</button></div>`;
  doc.body.append(shop);
  buy = doc.querySelector(".lc-box__buy");
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", { innerWidth: 1440, innerHeight: 900 });
  vi.stubGlobal("foundry", { applications: { api: { ApplicationV2: DomApp }, instances: new Map() }, utils: { escapeHTML: s => String(s ?? "") } });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("game", { user: { id: "p1", isGM: false }, users: { activeGM: { id: "gm" } }, actors: { get: () => ({ system: { currency: { gp: 40 } } }) }, settings: { get: () => false } });
  vi.stubGlobal("ui", { notifications: { warn: m => warns.push(m), info: m => notes.push(m) } });
  vi.stubGlobal("fromUuidSync", () => null);
  store.getBoxes.mockReturnValue({ d1: GAME });
  requestPull.mockReset();
  registerKind(DECK);
});
afterEach(() => { _resetHolds(); _resetKinds(["crate"]); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// The first draw, landed, with focus on its Draw again as a keyboard user
// leaves it after tabbing there; and the GM's answer to the next press: the
// broadcast opens the next window (not awaited, as socket.js does) and the
// request resolves with that message.
async function landedWithAgain() {
  const first = await showReveal(reveal());
  controllers[0].land();
  await first.landed;
  const again = first.element.querySelector(".lc-reveal__again");
  expect(again.hidden).toBe(false);
  again.focus();
  let next;
  requestPull.mockImplementation(async () => {
    next = showReveal(reveal({ requestId: "r2", logId: "L2", result: { name: "Omen" } }));
    return { type: "reveal", requestId: "r2" };
  });
  return { first, again, next: () => next };
}

describe("Draw again's focus", () => {
  it("goes from Draw again to the next window's Skip and stays on that node, as Close, through the landing: never on the held Buy", async () => {
    const { first, again, next } = await landedWithAgain();
    trail.length = 0;
    await act(first, "drawAgain", again, 1);
    const second = await next();
    const button = second.element.querySelector(".lc-reveal__close");
    expect(first.element.isConnected).toBe(false);
    expect(doc.activeElement).toBe(button);
    expect(button.textContent).toBe("Skip");
    controllers[1].land();
    await second.landed;
    expect(doc.activeElement).toBe(button);
    expect(button.textContent).toBe("Close");
    // Every move on the way: none to the Buy, none to the page's body.
    expect(trail).not.toContain(buy);
    expect(trail).not.toContain(doc.body);
    expect(trail.every(el => el === button)).toBe(true);
    expect(warns).toEqual([]);
  });

  it("leaves focus where the buyer took it meanwhile (the chat box), and the old window still closes", async () => {
    const { first, again } = await landedWithAgain();
    const chat = doc.createElement("textarea");
    doc.body.append(chat);
    let opening;
    requestPull.mockImplementation(async () => {
      chat.focus();
      opening = showReveal(reveal({ requestId: "r2", logId: "L2" }));
      return { type: "reveal", requestId: "r2" };
    });
    await act(first, "drawAgain", again, 1);
    const second = await opening;
    expect(first.element.isConnected).toBe(false);
    expect(doc.activeElement).toBe(chat);
    controllers[1].land();
    await second.landed;
    expect(doc.activeElement).toBe(chat);
    expect(trail).not.toContain(buy);
  });

  it("ignores a held Enter's repeat on the handed-over Skip for a moment, then Skip works", async () => {
    const { first, again, next } = await landedWithAgain();
    let t = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => t);
    await act(first, "drawAgain", again);
    const second = await next();
    const button = second.element.querySelector(".lc-reveal__close");
    act(second, "skip", button);
    expect(controllers[1].skipped).toBe(false);
    t += CLOSE_GRACE_MS + 1;
    act(second, "skip", button);
    expect(controllers[1].skipped).toBe(true);
  });

  it("with no next window to find (an older answer), closes as before and hands focus back to the Buy", async () => {
    const { first, again } = await landedWithAgain();
    requestPull.mockImplementation(async () => ({ type: "reveal" }));
    await act(first, "drawAgain", again, 1);
    expect(first.element.isConnected).toBe(false);
    expect(doc.activeElement === buy).toBe(true);
  });
});

describe("a press at a price's boundary", () => {
  it("tells the buyer alone which price was charged, as the result lands", async () => {
    const note = "Charged 15 gp, the price you pressed for The Deck; by the GM's clock it was 10 gp just then.";
    const mine = await showReveal(reveal({ priceNote: note }));
    expect(notes).toEqual([]);
    controllers[0].land();
    await mine.landed;
    expect(notes).toEqual([note]);
    vi.stubGlobal("game", { user: { id: "p2", isGM: false }, users: { activeGM: { id: "gm" } }, actors: { get: () => null }, settings: { get: () => false } });
    const theirs = await showReveal(reveal({ requestId: "r3", logId: "L3", priceNote: note }));
    controllers[1].land();
    await theirs.landed;
    expect(notes).toEqual([note]);
  });
});
