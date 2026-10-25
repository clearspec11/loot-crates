/*
  The reveal window with a second kind's animation: the hold (the shop's held
  state, the sealed chat card) and the one button are the window's, once; the
  kind supplies only what plays in the vault, the result block and the sting.
  A kind with no animation lands at once. ApplicationV2 is a stand-in that
  renders once into a fake root, as in reveal.test.js.
*/
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../module/scripts/foundry/sound.js", () => ({ playTick: vi.fn(), playSlow: vi.fn(), playReveal: vi.fn() }));

const fakeElement = () => ({
  className: "", textContent: "", innerHTML: "", clientWidth: 600, dataset: {}, children: [], hidden: false,
  classes: new Set(),
  classList: { add(c) { this.owner.classes.add(c); }, remove(c) { this.owner.classes.delete(c); }, contains(c) { return this.owner.classes.has(c); } },
  style: { transform: "", setProperty() {} },
  setAttribute() {},
  append(...kids) { this.children.push(...kids); },
  appendChild(kid) { this.children.push(kid); },
  replaceChildren() {},
  remove() { this.removed = true; },
  focus() {},
  contains: () => false,
});
const element = () => { const el = fakeElement(); el.classList.owner = el; return el; };

class FakeApp {
  constructor(options) { this.options = options; this.state = 0; }
  async render() {
    if (this.options?.id) globalThis.foundry.applications.instances.set(this.options.id, this);
    const html = await this._renderHTML();
    const parts = new Map();
    this.element = { querySelector: sel => parts.get(sel) ?? parts.set(sel, element()).get(sel), contains: el => [...parts.values()].includes(el) };
    this._replaceHTML(html, element());
    this.state = 1;
    this._onRender();
    return this;
  }
  _onClose() {}
  close() { this.state = 0; globalThis.foundry.applications.instances.delete(this.options?.id); this._onClose({}); }
}

vi.stubGlobal("foundry", { applications: { api: { ApplicationV2: FakeApp }, instances: new Map() }, utils: { escapeHTML: s => s } });
const { showReveal, heldState, isSealedItem, sealChatCard, _resetHolds } = await import("../module/scripts/foundry/reveal.js");
const { registerKind, _resetKinds } = await import("../module/scripts/games/kinds.js");

// A controller the test lands by hand, so the result is held until then.
let controllers;
const sting = vi.fn();
const WELL = {
  id: "stub",
  async roll() { return { result: null }; },
  reveal: {
    title: "A coin in the well",
    play(host, reveal, { onLand }) {
      const c = { host, reveal, played: 0, skipped: false, reducedMotion: false, play() { c.played++; }, skip() { c.skipped = true; onLand(); }, land: onLand };
      controllers.push(c);
      return c;
    },
    result: reveal => (reveal.result ? `<div class="lc-reveal__name">${reveal.result.name}</div>` : `<div class="lc-reveal__name">The well keeps the coin</div>`),
    sting,
    replayable: false,
  },
};
const FLIP = { id: "flip", async roll() { return { result: null }; } };
// A kind that posts a card for some outcomes only (the dice's win): the
// card's presence would tell the result, so the seal hides the whole message.
const QUIET = { id: "quiet", async roll() { return { result: null }; }, reveal: WELL.reveal, chat: { card: () => null, conditional: true } };

let doc;
beforeEach(() => {
  controllers = [];
  doc = {
    visibilityState: "visible", activeElement: null, body: {}, head: { append() {} },
    createElement: element,
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
  };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", { innerWidth: 1440, innerHeight: 900 });
  vi.stubGlobal("requestAnimationFrame", () => {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("foundry", { applications: { api: { ApplicationV2: FakeApp }, instances: new Map() }, utils: { escapeHTML: s => s } });
  vi.stubGlobal("game", { user: { id: "u", isGM: false }, settings: { get: () => true } });
  vi.stubGlobal("fromUuidSync", () => null);
  registerKind(WELL);
  registerKind(FLIP);
  registerKind(QUIET);
  sting.mockClear();
});
afterEach(() => { _resetHolds(); _resetKinds(["crate"]); vi.unstubAllGlobals(); });

const reveal = extra => ({ kind: "stub", requestId: "w1", userId: "p1", actorId: "a1", actorName: "Tam", box: { id: "well", name: "Wishing Well", price: 0.05 }, result: null, itemId: null, itemUuid: null, logId: "L9", purse: {}, stateBefore: { throws: 2 }, ...extra });

describe("a second kind's reveal", () => {
  it("plays the kind's animation in the vault and holds the shop's state and the chat card until it lands", async () => {
    const app = await showReveal(reveal());
    expect(app.title).toBe("A coin in the well");
    expect(controllers).toHaveLength(1);
    const [c] = controllers;
    expect(c.played).toBe(1);
    expect(c.host).toBe(app.element.querySelector(".lc-reveal__spin"));
    // Held: the buyer's shop shows the state from before the throw.
    expect(heldState("a1", "well")).toEqual({ throws: 2 });
    // Sealed: the card for this throw says Opening… here until the landing.
    const card = element();
    sealChatCard({ flags: { "loot-crates": { logId: "L9" } } }, { querySelector: () => card });
    expect(card.classes.has("lc-chat--sealed")).toBe(true);
    expect(card.children[0].textContent).toBe("Opening…");
    expect(app.element.querySelector(".lc-reveal__result").innerHTML).toBe("");
    expect(app.element.querySelector(".lc-reveal__close").textContent).toBe("");

    c.land();
    await app.landed;
    await Promise.resolve();
    expect(heldState("a1", "well")).toBeNull();
    expect(card.classes.has("lc-chat--sealed")).toBe(false);
    expect(card.children[0].removed).toBe(true);
    const result = app.element.querySelector(".lc-reveal__result");
    expect(result.innerHTML).toContain("The well keeps the coin");
    expect(sting).toHaveBeenCalledWith(expect.objectContaining({ requestId: "w1" }));
    const btn = app.element.querySelector(".lc-reveal__close");
    expect(btn.textContent).toBe("Close");
    expect(btn.dataset.action).toBe("dismiss");
    // Not replayable: no Watch again even though it played out here.
    expect(app.element.querySelector(".lc-reveal__watch").hidden).toBe(true);
  });

  it("seals an item the kind grants, as the crate does, and the sting waits for sound", async () => {
    vi.stubGlobal("game", { user: { id: "u", isGM: false }, settings: { get: () => false } });
    const app = await showReveal(reveal({ itemId: "well1", result: { name: "A wish", img: "" } }));
    expect(isSealedItem("well1")).toBe(true);
    controllers[0].land();
    await app.landed;
    await Promise.resolve();
    expect(isSealedItem("well1")).toBe(false);
    expect(sting).not.toHaveBeenCalled();
    expect(app.element.querySelector(".lc-reveal__result").innerHTML).toContain("A wish");
  });

  it("lands at once for a kind with no animation, holding nothing back", async () => {
    const app = await showReveal(reveal({ kind: "flip", requestId: "f1", box: { id: "flip", name: "Coin flip", price: 1 }, stateBefore: { flips: 1 } }));
    await app.landed;
    await Promise.resolve();
    expect(heldState("a1", "flip")).toBeNull();
    expect(app.element.querySelector(".lc-reveal__close").textContent).toBe("Close");
    expect(app.element.querySelector(".lc-reveal__result").innerHTML).toBe("");
    expect(app.element.querySelector(".lc-reveal__watch").hidden).toBe(true);
    expect(controllers).toHaveLength(0);
  });

  it("hides the whole message of a kind whose card only some outcomes post, until the landing", async () => {
    const app = await showReveal(reveal({ kind: "quiet", requestId: "q1", logId: "LQ" }));
    const card = element();
    const html = { querySelector: () => card, style: { display: "" } };
    sealChatCard({ flags: { "loot-crates": { logId: "LQ" } } }, html);
    expect(card.classes.has("lc-chat--sealed")).toBe(true);
    expect(html.style.display).toBe("none");
    // The well's card (posted for every outcome the kind cards) is shown sealed, not hidden.
    const well = await showReveal(reveal({ requestId: "w2", logId: "LW" }));
    const wellHtml = { querySelector: () => element(), style: { display: "" } };
    sealChatCard({ flags: { "loot-crates": { logId: "LW" } } }, wellHtml);
    expect(wellHtml.style.display).toBe("");
    controllers[0].land();
    await app.landed;
    await Promise.resolve();
    expect(html.style.display).toBe("");
    expect(card.classes.has("lc-chat--sealed")).toBe(false);
    well.close();
  });

  it("shows a kind this client doesn't know with no strip at once, rather than failing to open", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const app = await showReveal(reveal({ kind: "slots", requestId: "x1", result: { name: "Bar", rarity: "common", img: "" } }));
      await app.landed;
      await Promise.resolve();
      expect(app.element.querySelector(".lc-reveal__close").textContent).toBe("Close");
      expect(app.element.querySelector(".lc-reveal__result").innerHTML).toContain("Bar");
      expect(heldState("a1", "well")).toBeNull();
      app.close();
    } finally { warn.mockRestore(); }
  });

  it("shows a kind this client doesn't know as a crate, so the table still sees the window", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const strip = { landIndex: 1, cards: [{ name: "a", img: "", rarity: "common" }, { name: "b", img: "", rarity: "common", result: true }] };
      const app = await showReveal(reveal({ kind: "slots", result: { name: "Bar", rarity: "common", img: "" }, strip }));
      expect(app.title).toBe("Opening a crate");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("no kind slots"));
      expect(controllers).toHaveLength(0);
      app.close();
    } finally { warn.mockRestore(); }
  });
});
