/*
  A table round's reveal is one hold for the whole table (reveal.js
  showRound): the round's chat card stays sealed and the shop is told to
  redraw when this client lands. A table window (B2's) lands it; with none,
  under reduced motion or on a hidden page it lands at once.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDocument } from "./minidom.js";

vi.mock("../module/scripts/sound.js", () => ({ playTick: vi.fn(), playSlow: vi.fn(), playReveal: vi.fn() }));
vi.mock("../module/scripts/store.js", () => ({ getBoxes: () => ({}), getPools: () => ({}), getLog: () => [], todayKey: () => null, isShopOpen: () => true, getActorState: () => ({}) }));
vi.mock("../module/scripts/socket.js", () => ({ requestPull: vi.fn(async () => ({})) }));

class FakeApp {}
vi.stubGlobal("foundry", { applications: { api: { ApplicationV2: FakeApp }, instances: new Map() }, utils: { escapeHTML: s => String(s) } });

const { showRound, setTableWindow, sealChatCard, onRelease, _resetHolds } = await import("../module/scripts/reveal.js");

let doc;
let reduced = false;
beforeEach(() => {
  doc = createDocument();
  doc.visibilityState = "visible";
  reduced = false;
  vi.stubGlobal("foundry", { applications: { api: { ApplicationV2: FakeApp }, instances: new Map() }, utils: { escapeHTML: s => String(s) } });
  vi.stubGlobal("document", doc);
  vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
});
afterEach(() => {
  setTableWindow(null);
  _resetHolds();
  vi.unstubAllGlobals();
});

function cardHTML() {
  const classes = new Set(["loot-crates", "lc-chat"]);
  const kids = [];
  const card = {
    classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
    append: (...k) => kids.push(...k.map(x => Object.assign(x, { remove: () => kids.splice(kids.indexOf(x), 1) }))),
    kids, classes,
  };
  return { card, html: { querySelector: sel => (sel === ".lc-chat" ? card : null) } };
}
const message = logId => ({ flags: { "loot-crates": { logId } } });
const round = (id = "R1") => ({ type: "round", event: "resolve", roundId: id, boxId: "wheel", kind: "stubtable", box: { id: "wheel", name: "Wheel" }, outcome: "red", stakes: [] });
const flush = () => new Promise(r => setTimeout(r, 0));

describe("a table round's reveal", () => {
  it("holds the round's chat card and the shop until the table window lands", async () => {
    let land;
    const win = vi.fn((_reveal, ctx) => { land = ctx.land; });
    setTableWindow(win);
    const released = vi.fn();
    const stop = onRelease(released);
    const shown = showRound(round());
    expect(shown.instant).toBe(false);
    expect(win).toHaveBeenCalledWith(expect.objectContaining({ roundId: "R1", outcome: "red" }), expect.any(Object));
    const { card, html } = cardHTML();
    sealChatCard(message("R1"), html);
    expect(card.classes.has("lc-chat--sealed")).toBe(true);
    await flush();
    expect(released).not.toHaveBeenCalled();
    land();
    await shown.landed;
    await flush();
    expect(card.classes.has("lc-chat--sealed")).toBe(false);
    expect(released).toHaveBeenCalledWith({ actorId: null, boxId: "wheel", itemId: null });
    stop();
  });

  it("lands at once with no table window", async () => {
    const shown = showRound(round("R2"));
    expect(shown.instant).toBe(true);
    await shown.landed;
    await flush();
    const { card, html } = cardHTML();
    sealChatCard(message("R2"), html);
    expect(card.classes.has("lc-chat--sealed")).toBe(false);
  });

  it("lands at once under reduced motion and on a hidden page, without opening the window", async () => {
    const win = vi.fn();
    setTableWindow(win);
    reduced = true;
    expect(showRound(round("R3")).instant).toBe(true);
    reduced = false;
    doc.visibilityState = "hidden";
    expect(showRound(round("R4")).instant).toBe(true);
    expect(win).not.toHaveBeenCalled();
  });

  it("lets the table go when the window fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    setTableWindow(async () => { throw new Error("boom"); });
    const shown = showRound(round("R5"));
    await shown.landed;
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
