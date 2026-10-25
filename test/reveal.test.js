/*
  The reveal window on a page that is hidden: a hidden page runs no animation
  frames, so the spin must land without one. ApplicationV2 is a stand-in that
  renders once into a fake root; the spin is the real one, on a fake DOM.
*/
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../module/scripts/foundry/sound.js", () => ({ playTick: vi.fn(), playSlow: vi.fn(), playReveal: vi.fn() }));

const fakeElement = () => ({
  className: "", textContent: "", innerHTML: "", clientWidth: 600, dataset: {}, children: [], hidden: false,
  classList: { add() {}, remove() {} },
  style: { transform: "", setProperty() {} },
  setAttribute() {},
  append(...kids) { this.children.push(...kids); },
  appendChild(kid) { this.children.push(kid); },
  replaceChildren() {},
  focus() { if (doc) doc.activeElement = this; },
  contains: () => false,
});

class FakeApp {
  constructor(options) { this.options = options; this.state = 0; this.fronted = 0; }
  bringToFront() { this.fronted++; }
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
  close() { this.state = 0; globalThis.foundry.applications.instances.delete(this.options?.id); this._onClose({}); }
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

const { showReveal, showReplay, sealChatCard, watchAgain, stripVoice, CrateReveal } = await import("../module/scripts/foundry/reveal.js");
const { settleAt } = await import("../module/scripts/views/spin.js");
const sound = await import("../module/scripts/foundry/sound.js");
const { replaySnapshot, replayReveal } = await import("../module/scripts/views/revealcard.js");
const { playReveal, playSlow } = await import("../module/scripts/foundry/sound.js");

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
  Sound on the spin's own clock: the braking sweep is cued by the frame that
  starts the ease-out, never by a timer, and a near-miss voices the tease and
  the drop back as two different sounds.
*/
describe("sounds in time with the spin", () => {
  const { playTick } = vi.mocked(sound);
  beforeEach(() => { playTick.mockClear(); playSlow.mockClear(); });
  afterEach(() => vi.useRealTimers());

  const nearMiss = {
    ...reveal,
    requestId: "nm",
    strip: { ...reveal.strip, nearMiss: true, cards: reveal.strip.cards.map((c, i) => (i === 31 ? { ...c, rarity: "veryRare" } : c)) },
  };
  const play = (start = 0) => { for (let now = start; frames.length; now += 16) frames.shift()(now); };

  it("plays no sweep from timers alone", async () => {
    // Timers only: requestAnimationFrame stays the hand-driven stub, so no frame runs.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    await showReveal(reveal);
    vi.advanceTimersByTime(4000);
    expect(playSlow).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
  });

  it("starts the sweep in the frame the strip begins to brake, lasting until it settles", async () => {
    const app = await showReveal(reveal);
    for (let now = 0; now <= 2768; now += 16) frames.shift()(now);
    expect(playSlow).not.toHaveBeenCalled();
    frames.shift()(2784);
    expect(playSlow).toHaveBeenCalledTimes(1);
    expect(playSlow.mock.calls[0][0]).toBeCloseTo(settleAt() - 2784, 6);
    play(2800);
    await app.landed;
    expect(playSlow).toHaveBeenCalledTimes(1);
  });

  it("plays no sweep for a spin skipped before it brakes", async () => {
    const app = await showReveal(reveal);
    for (let now = 0; now <= 1000; now += 16) frames.shift()(now);
    app.close();
    play(1016);
    await app.landed;
    expect(playSlow).not.toHaveBeenCalled();
  });

  it("cuts the sweep when the strip lands early, not seconds later under the sting", async () => {
    const stop = vi.fn();
    playSlow.mockReturnValueOnce(stop);
    const app = await showReveal(reveal);
    for (let now = 0; now <= 3200; now += 16) frames.shift()(now);
    expect(playSlow).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    // Skip mid-brake: the strip lands on the next frame and the sweep goes with it.
    app.close();
    play(3216);
    await app.landed;
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("teases on the card past the result, then drops back, in that order, on a near-miss", async () => {
    const app = await showReveal(nearMiss);
    play();
    await app.landed;
    const voiced = playTick.mock.calls.map(([, voice]) => (voice?.tease ? "tease" : voice?.back ? "back" : "tick"));
    expect(voiced.filter(v => v !== "tick")).toEqual(["tease", "back"]);
    expect(voiced.slice(-2)).toEqual(["tease", "back"]);
  });

  it("never teases or drops back on a plain strip", async () => {
    const app = await showReveal(reveal);
    play();
    await app.landed;
    expect(playTick.mock.calls.length).toBeGreaterThan(20);
    expect(playTick.mock.calls.every(([, voice]) => voice === undefined)).toBe(true);
  });

  it("voices the tease only for the card past the result, and the back only after a tease", () => {
    const voice = stripVoice({ landIndex: 30, nearMiss: true });
    [29, 30, 31, 30].forEach(voice);
    expect(playTick.mock.calls).toEqual([[29 / 30], [1], [1, { tease: true }], [1, { back: true }]]);
    playTick.mockClear();
    const plain = stripVoice({ landIndex: 30, nearMiss: false });
    [29, 30, 31, 30].forEach(plain);
    expect(playTick.mock.calls.every(c => c.length === 1)).toBe(true);
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

/*
  "Watch again": a replay plays on this client only, from the card's
  snapshot. One window per card, titled as a replay, nobody's gold, and it
  never holds a chat card back.
*/
const snapshot = replaySnapshot({ ...reveal, odds: [{ rarity: "rare", chance: 1, label: "100%" }], purse: { gp: 5 }, itemUuid: "Actor.a.Item.i", logId: "L9" });

describe("a replay window", () => {
  it("opens once per card: a second press brings the open one forward", async () => {
    const a = await showReplay(snapshot, "m1");
    expect(a.options.id).toBe("loot-crates-reveal-replay-m1");
    const b = await showReplay(snapshot, "m1");
    expect(b).toBe(a);
    expect(a.fronted).toBe(1);
    const c = await showReplay(snapshot, "m2");
    expect(c).not.toBe(a);
    // Closed, the card's button opens a fresh one.
    a.close();
    const d = await showReplay(snapshot, "m1");
    expect(d).not.toBe(a);
  });

  it("says Replay, shows no gold or Open item even to a GM, and plays the spin", async () => {
    globalThis.game.user.isGM = true;
    const app = await showReplay(snapshot, "m3");
    expect(app.title).toBe("Replay: Crate Tester opens Crate");
    expect(app.canSee).toBe(false);
    expect(frames).toHaveLength(1);
    for (let now = 0; frames.length; now += 16) frames.shift()(now);
    await app.landed;
    const out = app.element.querySelector(".lc-reveal__result").innerHTML;
    expect(out).toContain("Sword");
    expect(out).not.toMatch(/gp left/);
    expect(app.element.querySelector(".lc-reveal__open").hidden).toBe(true);
    expect(app.element.querySelector(".lc-reveal__close").textContent).toBe("Close");
  });

  it("never enters the spinning set, so it seals no chat card", async () => {
    const app = new CrateReveal({ ...replayReveal(snapshot, "m4"), logId: "L9" });
    await app.render({ force: true });
    const { card, html } = cardHTML();
    sealChatCard(message("L9"), html);
    expect(card.classes.has("lc-chat--sealed")).toBe(false);
  });

  it("gives focus back to its Watch again on close", async () => {
    const back = { isConnected: true, focus() { doc.activeElement = this; } };
    const app = await showReplay(snapshot, "m5", { returnTo: back });
    for (let now = 0; frames.length; now += 16) frames.shift()(now);
    await app.landed;
    app.close();
    expect(doc.activeElement).toBe(back);
  });

  it("takes focus from the Watch again that opened it to Close on landing, as a Buy does", async () => {
    const back = { isConnected: true, focus() { doc.activeElement = this; } };
    back.focus();
    const app = await showReplay(snapshot, "m7", { returnTo: back });
    expect(doc.activeElement).toBe(back);
    for (let now = 0; frames.length; now += 16) frames.shift()(now);
    await app.landed;
    expect(doc.activeElement).toBe(app.element.querySelector(".lc-reveal__close"));
    app.close();
    expect(doc.activeElement).toBe(back);
    // Moved on elsewhere during the replay: left there.
    back.focus();
    const app2 = await showReplay(snapshot, "m8", { returnTo: back });
    const elsewhere = { focus() {} };
    doc.activeElement = elsewhere;
    for (let now = 0; frames.length; now += 16) frames.shift()(now);
    await app2.landed;
    expect(doc.activeElement).toBe(elsewhere);
  });

  // The card is drawn again while the replay plays (a refund marks it, the
  // log is re-rendered): the Watch again that opened it is gone.
  it("gives focus to the redrawn card's Watch again, or the chat input, never the body", async () => {
    const node = (extra = {}) => ({ isConnected: true, closest: () => null, focus() { doc.activeElement = this; }, ...extra });
    const gone = node({ isConnected: false });
    const inLog = node({ closest: sel => (sel === ".chat-log" ? {} : null) });
    const popup = node();
    const input = node();
    const asked = [];
    doc.querySelectorAll = sel => {
      asked.push(sel);
      if (sel === '[data-message-id="m9"] .lc-chat__replay') return [popup, inLog];
      if (sel === "#chat-message") return [input];
      return [];
    };
    const app = await showReplay(snapshot, "m9", { returnTo: gone });
    for (let now = 0; frames.length; now += 16) frames.shift()(now);
    await app.landed;
    doc.activeElement = doc.body;
    app.close();
    expect(doc.activeElement).toBe(inLog);
    // A refunded card has no Watch again: the chat input.
    const app2 = await showReplay(snapshot, "m10", { returnTo: gone });
    for (let now = 0; frames.length; now += 16) frames.shift()(now);
    await app2.landed;
    doc.activeElement = doc.body;
    app2.close();
    expect(doc.activeElement).toBe(input);
    expect(asked).toContain('[data-message-id="m10"] .lc-chat__replay');
  });

  it("opens nothing for a snapshot it can't play", async () => {
    expect(await showReplay({ strip: { cards: [] } }, "m6")).toBeNull();
  });
});

describe("Watch again on the chat card", () => {
  const button = () => {
    const el = fakeElement();
    el.listeners = [];
    el.attrs = {};
    el.setAttribute = (k, v) => { el.attrs[k] = String(v); };
    el.addEventListener = (type, fn) => el.listeners.push([type, fn]);
    return el;
  };
  const withButtons = card => {
    card.querySelector = sel => (sel === ".lc-chat__replay" ? card.kids.find(k => k.className === "lc-chat__replay") ?? null : null);
    return card;
  };
  const msg = (flags, id = "msg") => ({ id, flags: { "loot-crates": flags } });

  it("adds one button to a pull's card with a snapshot, which opens the replay", async () => {
    doc.createElement = button;
    const { card, html } = cardHTML();
    withButtons(card);
    watchAgain(msg({ logId: "L1", replay: snapshot }, "c1"), html);
    expect(card.kids.map(k => k.textContent)).toEqual(["Watch again"]);
    const btn = card.kids[0];
    expect(btn.type).toBe("button");
    // Its name starts with what it says, then which pull it replays.
    expect(btn.attrs["aria-label"]).toBe("Watch again: Crate Tester opens Crate");
    // Rendered again (a notification copy re-render): still one.
    watchAgain(msg({ logId: "L1", replay: snapshot }, "c1"), html);
    expect(card.kids).toHaveLength(1);
    const [[type, click]] = btn.listeners;
    expect(type).toBe("click");
    click({ preventDefault() {}, stopPropagation() {} });
    await new Promise(r => setTimeout(r, 0));
    expect(globalThis.foundry.applications.instances.get("loot-crates-reveal-replay-c1")).toBeTruthy();
  });

  it("adds none to a refunded card or a card from before snapshots", () => {
    doc.createElement = button;
    const refunded = cardHTML({ refunded: true });
    withButtons(refunded.card);
    watchAgain(msg({ logId: "L1", replay: snapshot }), refunded.html);
    expect(refunded.card.kids).toHaveLength(0);
    const legacy = cardHTML();
    withButtons(legacy.card);
    watchAgain(msg({ logId: "L1", uuid: "u" }), legacy.html);
    watchAgain({ flags: {} }, legacy.html);
    watchAgain(null, legacy.html);
    expect(legacy.card.kids).toHaveLength(0);
  });
});

/*
  Watch again in the reveal itself: offered only when this client didn't see
  the spin play out (it landed hidden, was hidden mid-spin, or was skipped),
  never after a natural landing or under reduced motion. It replays the same
  strip in the same host, display only: `landed` and the chat card's seal
  are the first spin's alone.
*/
describe("Watch again in a reveal this client didn't see spin", () => {
  let now;
  beforeEach(() => {
    now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    playReveal.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  const $ = (app, sel) => app.element.querySelector(sel);
  // ApplicationV2 runs a button's data-action handler with the window as
  // this. The fake root doesn't parse markup, so a button's first action is
  // given here (revealActionsHTML): Skip on the spin's button, watchAgain.
  const press = (app, button, detail = 1) => {
    const first = button === $(app, ".lc-reveal__close") ? "skip" : "watchAgain";
    return CrateReveal.DEFAULT_OPTIONS.actions[button.dataset.action ?? first].call(app, { detail }, button);
  };
  const run = () => { for (let t = 0; frames.length; t += 16) frames.shift()(t); };
  const skipped = async (extra = {}) => {
    const app = await showReveal({ ...reveal, ...extra });
    frames.shift()(0);
    press(app, $(app, ".lc-reveal__close"));
    run();
    await app.landed;
    return app;
  };

  it("is not offered after a spin that played to its end", async () => {
    const app = await showReveal(reveal);
    run();
    await app.landed;
    expect($(app, ".lc-reveal__watch").hidden).toBe(true);
  });

  it("is offered after Skip, a hidden-page land and a hidden-mid-spin land", async () => {
    const a = await skipped();
    expect($(a, ".lc-reveal__close").textContent).toBe("Close");
    expect($(a, ".lc-reveal__watch").hidden).toBe(false);

    doc.visibilityState = "hidden";
    const b = await showReveal({ ...reveal, requestId: "h1" });
    await b.landed;
    expect($(b, ".lc-reveal__watch").hidden).toBe(false);

    doc.visibilityState = "visible";
    const c = await showReveal({ ...reveal, requestId: "h2" });
    for (let t = 0; t < 500; t += 16) frames.shift()(t);
    doc.visibilityState = "hidden";
    for (const [fn] of listeners) fn();
    await c.landed;
    expect($(c, ".lc-reveal__watch").hidden).toBe(false);
  });

  it("is never offered under reduced motion, hidden or skipped", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const a = await showReveal(reveal);
    await a.landed;
    expect($(a, ".lc-reveal__watch").hidden).toBe(true);
    doc.visibilityState = "hidden";
    const b = await showReveal({ ...reveal, requestId: "rm2" });
    await b.landed;
    expect($(b, ".lc-reveal__watch").hidden).toBe(true);
  });

  it("replays in place, display only, and goes once a replay runs to its end with focus on Close", async () => {
    const app = await skipped({ requestId: "w1", logId: "LW1" });
    const watch = $(app, ".lc-reveal__watch");
    const close = $(app, ".lc-reveal__close");
    const host = $(app, ".lc-reveal__spin");
    const mounted = host.children.length;
    const reveals = playReveal.mock.calls.length;
    watch.focus();
    now += 2000;
    press(app, watch);
    // The pressed button keeps focus and now reads Skip; the result waits.
    expect(watch.textContent).toBe("Skip");
    expect(watch.dataset.action).toBe("skip");
    expect(doc.activeElement).toBe(watch);
    expect($(app, ".lc-reveal__result").hidden).toBe(true);
    // A fresh strip in the same host, playing.
    expect(host.children.length).toBe(mounted + 1);
    expect(frames).toHaveLength(1);
    // Close is still Close, and the chat card isn't sealed again.
    expect(close.textContent).toBe("Close");
    expect(close.dataset.action).toBe("dismiss");
    const { card, html } = cardHTML();
    sealChatCard(message("LW1"), html);
    expect(card.classes.has("lc-chat--sealed")).toBe(false);
    run();
    expect($(app, ".lc-reveal__result").hidden).toBe(false);
    expect(watch.hidden).toBe(true);
    expect(doc.activeElement).toBe(close);
    // The sting again, for the same result.
    expect(playReveal.mock.calls.length).toBe(reveals + 1);
    expect(playReveal).toHaveBeenLastCalledWith("rare");
    // Gone: pressing it again does nothing.
    press(app, Object.assign(watch, { dataset: { action: "watchAgain" } }));
    expect(frames).toHaveLength(0);
  });

  it("comes back when its replay is skipped, keeping focus, and ignores a double press", async () => {
    const app = await skipped({ requestId: "w2" });
    const watch = $(app, ".lc-reveal__watch");
    watch.focus();
    now += 2000;
    press(app, watch);
    // The second click of a double-click lands on Skip: ignored.
    press(app, watch, 2);
    now += 100;
    press(app, watch);
    frames.shift()(0);
    // Still playing: neither ignored press skipped it.
    expect(watch.textContent).toBe("Skip");
    now += 1000;
    press(app, watch);
    run();
    expect(watch.textContent).toBe("Watch again");
    expect(watch.dataset.action).toBe("watchAgain");
    expect(watch.hidden).toBe(false);
    expect(doc.activeElement).toBe(watch);
    expect($(app, ".lc-reveal__result").hidden).toBe(false);
  });

  it("doesn't take focus back on the replay's landing when the viewer moved on", async () => {
    const app = await skipped({ requestId: "w3" });
    now += 2000;
    press(app, $(app, ".lc-reveal__watch"));
    const chat = { focus() {} };
    doc.activeElement = chat;
    run();
    expect($(app, ".lc-reveal__watch").hidden).toBe(true);
    expect(doc.activeElement).toBe(chat);
  });

  it("ends quietly when the window closes mid-replay", async () => {
    const app = await skipped({ requestId: "w4" });
    now += 2000;
    press(app, $(app, ".lc-reveal__watch"));
    const reveals = playReveal.mock.calls.length;
    app.close();
    run();
    expect(playReveal.mock.calls.length).toBe(reveals);
    expect(listeners.size).toBe(0);
  });
});
