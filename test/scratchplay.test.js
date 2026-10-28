/*
  The scratch (scratch.js mountScratch, the foil in views/foil.js) on the
  minidom with a fake requestAnimationFrame and clock: a foil per panel
  and the bonus spot, nothing of the card showing through until a panel
  opens, a panel giving at 60% scratched by the coin's band and not
  before (then crumbling over 160 ms on the one loop), the core's Skip,
  Reveal all, the keys, the table's auto-scratch that opens every panel
  by itself, reduced motion, and the kind's play: the buyer's hand, the
  table's and every replay's sweep, the rasp and the tick. Then the
  snapshot Watch again replays from, and the sounds on Foundry's channel.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDocument } from "./minidom.js";

vi.mock("../module/scripts/foundry/sound.js", () => ({ playTick: vi.fn(), playSlow: vi.fn(), playReveal: vi.fn(), playPlop: vi.fn(), playPlink: vi.fn(), playCoinBack: vi.fn(), playBane: vi.fn(), playScratch: vi.fn(() => ({ rasp: vi.fn(), stop: vi.fn() })), playFoilTick: vi.fn() }));

const { SCRATCH, layCard, cardWins, mountScratch, cleanCard } = await import("../module/scripts/games/scratch.js");
const { FOIL, bandWidth } = await import("../module/scripts/views/foil.js");
const { replaySnapshot, replayReveal } = await import("../module/scripts/views/revealcard.js");
const { NEW_DEFAULTS } = await import("../module/scripts/views/newgame.js");
const { seededRng } = await import("../module/scripts/core/odds.js");
const sound = await import("../module/scripts/foundry/sound.js");

const GAME = { ...NEW_DEFAULTS.scratch(), id: "fortune", name: "Fortune Ticket", price: 5 };
const MATCH3 = { ...GAME, id: "m3", name: "Market Scratchie", price: 1, layout: "match3", grid: { cols: 3, rows: 2 }, bonus: { on: false, gp: 0 }, roll: { id: 1, size: 50, prizes: [{ count: 1, item: { rarity: "uncommon" } }, { count: 4, gp: 5 }, { count: 10, gp: 1 }] } };
const reveal = (over = {}) => ({
  kind: "scratch", actorName: "Tam", userId: "u1", box: { id: "fortune", name: "Fortune Ticket", price: 5 },
  card: layCard(GAME, { kind: "gp", gp: 25 }, seededRng(4)), outcome: "coins", payoutCp: 2500, result: { name: "25 gp", outcome: "coins" },
  ticket: { rollId: 1, no: 44, size: 100 }, ...over,
});

let doc, frames, clock;
beforeEach(() => {
  doc = createDocument();
  frames = [];
  clock = 1000;
  vi.stubGlobal("document", doc);
  vi.stubGlobal("requestAnimationFrame", cb => { frames.push(cb); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", () => { frames.length = 0; });
  vi.stubGlobal("performance", { now: () => clock });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  for (const fn of Object.values(sound)) fn.mockClear?.();
});
afterEach(() => vi.unstubAllGlobals());

// Runs the loop for `ms`, a frame every 16 ms (or until it stops asking).
const run = (ms) => {
  const end = clock + ms;
  while (frames.length && clock <= end) { clock += 16; const cb = frames.shift(); cb(clock); }
};
const mount = (opts = {}) => {
  const host = doc.createElement("div");
  doc.body.append(host);
  const ctrl = mountScratch(host, { reveal: reveal(), reducedMotion: false, ...opts });
  return { host, ctrl, panels: [...host.querySelectorAll("[data-panel]")], ticket: host.querySelector(".lc-scratch__ticket") };
};
// Lays the panels out as a browser would: 100 x 100 each, 110 apart, four to a row.
const layOut = (ticket, panels, cols = 4) => {
  ticket.getBoundingClientRect = () => ({ left: 0, top: 0, width: 440, height: 400, right: 440, bottom: 400 });
  panels.forEach((p, i) => {
    const left = (i % cols) * 110, top = Math.floor(i / cols) * 110;
    p.getBoundingClientRect = () => ({ left, top, width: 100, height: 100, right: left + 100, bottom: top + 100 });
  });
};
const pointer = (ticket, type, x, y) => ticket.dispatchEvent({ type, clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", button: 0, preventDefault() {} });
// One horizontal stroke of the coin across panel 0 at height y, 10 px a move.
const stroke = (ticket, y) => {
  pointer(ticket, "pointerdown", 2, y);
  for (let x = 12; x <= 102; x += 10) pointer(ticket, "pointermove", x, y);
  pointer(ticket, "pointerup", 102, y);
};
const isOpen = p => p.classList.contains("lc-scratch__panel--open");
const key = (ticket, k) => { const e = { type: "keydown", key: k, preventDefault: vi.fn(), stopPropagation: vi.fn() }; ticket.dispatchEvent(e); return e; };

describe("the ticket under its foil", () => {
  it("covers every panel and the bonus spot, with nothing of the card showing through", () => {
    const { host, panels, ticket } = mount({ buyer: true });
    const won = cardWins(reveal().card).winners;
    expect(won.length).toBeGreaterThan(0);
    expect(panels).toHaveLength(13); // 4 x 3 and the bonus spot
    for (const p of panels) {
      expect(p.querySelector(".lc-scratch__foil")).not.toBeNull();
      expect(p.className).not.toMatch(/lc-scratch__panel--win|lc-rarity-/);
      expect(p.getAttribute("aria-label")).toMatch(/covered/);
    }
    expect(panels[0].getAttribute("aria-label")).toBe("Panel 1, covered");
    expect(panels[12].getAttribute("aria-label")).toBe("Bonus spot, covered");
    expect(ticket.querySelectorAll(".lc-scratch__shavings")).toHaveLength(1);
    expect(ticket.querySelectorAll(".lc-scratch__coin")).toHaveLength(1);
    expect(ticket.classList.contains("lc-scratch__ticket--covered")).toBe(true);
    expect(ticket.dataset.buyer).toBe("1");
    expect(host.querySelector(".lc-scratch__all").textContent).toBe("Reveal all");
    expect(host.querySelector(".lc-scratch__help").textContent).toMatch(/R reveals the whole card/);
  });

  it("a match 3 card: a foil per panel, and none for the key", () => {
    const { panels, host } = mount({ reveal: reveal({ card: layCard(MATCH3, { kind: "gp", gp: 5 }, seededRng(2)), box: { id: "m3", name: "Market Scratchie", price: 1 } }) });
    expect(panels).toHaveLength(6);
    expect(host.querySelectorAll(".lc-scratch__foil")).toHaveLength(6);
    expect(host.querySelector(".lc-scratch__key .lc-scratch__foil")).toBeNull();
    // The table's card has no tools and takes no pointer.
    expect(host.querySelector(".lc-scratch__tools")).toBeNull();
    expect(host.querySelector(".lc-scratch__ticket").dataset.buyer).toBeUndefined();
  });

  it("the band is the coin's edge, 32 px and up to 1.35x at speed", () => {
    expect(FOIL.band).toBe(32);
    expect(bandWidth(0)).toBeCloseTo(32 * 0.85);
    expect(bandWidth(10)).toBeCloseTo(32 * 1.1);
    expect(bandWidth(500)).toBeCloseTo(32 * 1.35);
    expect(FOIL.threshold).toBe(0.6);
    expect(FOIL.crumbleMs).toBe(160);
  });
});

describe("the buyer's hand", () => {
  it("a panel gives at 60% scratched and not before, crumbles over 160 ms, then opens with its win lit", async () => {
    const onPanel = vi.fn(), onLand = vi.fn();
    const tick = vi.fn(), voice = { rasp: vi.fn(), stop: vi.fn() };
    const r = reveal();
    const { ctrl, panels, ticket } = mount({ buyer: true, reveal: r, onPanel, onLand, sounds: { scratch: vi.fn(() => voice), tick } });
    layOut(ticket, panels);
    ctrl.play();
    // Two strokes, at a quarter and half way down: 7 of 12 rows of samples, 58%.
    stroke(ticket, 50);
    stroke(ticket, 25);
    run(400);
    expect(isOpen(panels[0])).toBe(false);
    expect(onPanel).not.toHaveBeenCalled();
    expect(voice.rasp).toHaveBeenCalled();
    expect(voice.stop).toHaveBeenCalledTimes(2);
    // A third, three quarters down: past 60%. It gives on the next frame and opens 160 ms on.
    stroke(ticket, 75);
    run(16);
    expect(isOpen(panels[0])).toBe(false);
    run(FOIL.crumbleMs + 32);
    expect(isOpen(panels[0])).toBe(true);
    expect(panels[0].classList.contains("lc-scratch__panel--pop")).toBe(true);
    expect(onPanel).toHaveBeenCalledTimes(1);
    expect(onPanel.mock.calls[0][0]).toBe(0);
    expect(tick).toHaveBeenCalledTimes(1);
    // Read as it is printed once open; lit only if it wins.
    const won = new Set(cardWins(r.card).winners);
    expect(panels[0].getAttribute("aria-label")).not.toMatch(/covered/);
    expect(panels[0].classList.contains("lc-scratch__panel--win")).toBe(won.has(0));
    // The neighbour the band brushed is still shut.
    expect(isOpen(panels[1])).toBe(false);
    expect(onLand).not.toHaveBeenCalled();
    expect(ctrl.opened()).toBe(1);
  });

  it("the coin follows the pointer over the foil, pressed while the button is down, and goes off it", () => {
    const { ctrl, panels, ticket } = mount({ buyer: true });
    layOut(ticket, panels);
    ctrl.play();
    const coin = ticket.querySelector(".lc-scratch__coin");
    pointer(ticket, "pointermove", 50, 50);
    expect(coin.classList.contains("lc-scratch__coin--on")).toBe(true);
    expect(coin.classList.contains("lc-scratch__coin--down")).toBe(false);
    expect(coin.style.transform).toMatch(/^translate\(50\.0px, 50\.0px\) rotate\(.*\) scale\(1\)$/);
    pointer(ticket, "pointerdown", 50, 50);
    pointer(ticket, "pointermove", 70, 50);
    expect(coin.classList.contains("lc-scratch__coin--down")).toBe(true);
    // Tilted into the stroke: moving right is 90 degrees.
    expect(coin.style.transform).toMatch(/rotate\(90\.0deg\) scale\(0\.94\)/);
    pointer(ticket, "pointerup", 70, 50);
    pointer(ticket, "pointermove", 105, 50); // the gap between panels
    expect(coin.classList.contains("lc-scratch__coin--on")).toBe(false);
  });

  it("the core's Skip opens every panel and lands once; nothing after counts", async () => {
    const onLand = vi.fn(), onPanel = vi.fn();
    const { ctrl, panels, host } = mount({ buyer: true, onLand, onPanel });
    const played = ctrl.play();
    ctrl.skip();
    ctrl.skip();
    ctrl.revealAll();
    await played;
    expect(onLand).toHaveBeenCalledTimes(1);
    expect(ctrl.skipped).toBe(true);
    expect(panels.every(isOpen)).toBe(true);
    expect(onPanel).toHaveBeenCalledTimes(13);
    expect(host.classList.contains("lc-scratch--landed")).toBe(true);
    expect(host.querySelector(".lc-scratch__tools")).toBeNull();
    // Landed, the winners are lit as printed.
    const won = cardWins(reveal().card).winners;
    expect(panels.filter(p => p.classList.contains("lc-scratch__panel--win")).map(p => Number(p.dataset.panel))).toEqual(won);
  });

  it("the keys: the arrows move between panels, Space or Enter opens one, R reveals the card", () => {
    const onLand = vi.fn(), tick = vi.fn();
    const { ctrl, panels, ticket } = mount({ buyer: true, onLand, sounds: { tick } });
    ctrl.play();
    expect(panels.map(p => p.getAttribute("tabindex"))).toEqual(["0", ...Array(12).fill("-1")]);
    expect(doc.activeElement).toBe(panels[0]);
    const right = key(ticket, "ArrowRight");
    expect(right.preventDefault).toHaveBeenCalled();
    // Kept from Foundry's keybindings (the arrows move tokens, Space pauses).
    expect(right.stopPropagation).toHaveBeenCalled();
    expect(doc.activeElement).toBe(panels[1]);
    key(ticket, "ArrowDown");
    expect(doc.activeElement).toBe(panels[5]);
    key(ticket, " ");
    expect(isOpen(panels[5])).toBe(true);
    expect(tick).toHaveBeenCalledTimes(1);
    key(ticket, "End");
    expect(doc.activeElement).toBe(panels[12]);
    key(ticket, "Enter");
    expect(isOpen(panels[12])).toBe(true);
    // A key the card doesn't use goes on to Foundry.
    expect(key(ticket, "x").stopPropagation).not.toHaveBeenCalled();
    expect(onLand).not.toHaveBeenCalled();
    key(ticket, "r");
    expect(panels.every(isOpen)).toBe(true);
    expect(onLand).toHaveBeenCalledTimes(1);
    // One tick for the lot.
    expect(tick).toHaveBeenCalledTimes(3);
    expect(panels.some(p => p.hasAttribute("tabindex"))).toBe(false);
  });

  it("Reveal all opens the card and lands", () => {
    const onLand = vi.fn();
    const { ctrl, panels, host } = mount({ buyer: true, onLand });
    ctrl.play();
    host.querySelector(".lc-scratch__all").dispatchEvent({ type: "click" });
    expect(panels.every(isOpen)).toBe(true);
    expect(onLand).toHaveBeenCalledTimes(1);
  });

  it("on a match 3 card a winning symbol lights only once its third panel is open", () => {
    const card = layCard(MATCH3, { kind: "gp", gp: 5 }, seededRng(2));
    const { winners } = cardWins(card);
    expect(winners).toHaveLength(3);
    const { ctrl, panels } = mount({ buyer: true, reveal: reveal({ card }) });
    ctrl.play();
    ctrl.open(winners[0]);
    ctrl.open(winners[1]);
    expect(panels.filter(p => p.classList.contains("lc-scratch__panel--win"))).toHaveLength(0);
    ctrl.open(winners[2]);
    expect(panels.filter(p => p.classList.contains("lc-scratch__panel--win")).map(p => Number(p.dataset.panel))).toEqual(winners);
  });
});

describe("the table's view and reduced motion", () => {
  it("the coin scratches the card by itself, panel by panel on the one loop, and lands once every panel is open", async () => {
    const onLand = vi.fn(), onPanel = vi.fn(), voice = { rasp: vi.fn(), stop: vi.fn() };
    const { ctrl, panels, ticket } = mount({ buyer: false, onLand, onPanel, sounds: { scratch: () => voice, tick: vi.fn() } });
    layOut(ticket, panels);
    const played = ctrl.play();
    // Each panel on the mockup's beat: it gives at 80% of its 380 ms, then crumbles.
    run(FOIL.perPanelMs * 0.8 - 40);
    expect(isOpen(panels[0])).toBe(false);
    run(FOIL.crumbleMs + 80);
    expect(isOpen(panels[0])).toBe(true);
    expect(ticket.querySelector(".lc-scratch__coin").classList.contains("lc-scratch__coin--on")).toBe(true);
    expect(voice.rasp).toHaveBeenCalled();
    run(FOIL.perPanelMs * 2);
    const midway = panels.filter(isOpen).length;
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(13);
    // In order, one at a time.
    expect(onPanel.mock.calls.map(c => c[0])).toEqual([...Array(midway).keys()]);
    run(FOIL.spectatorMs + 1000);
    await played;
    expect(panels.every(isOpen)).toBe(true);
    expect(onLand).toHaveBeenCalledTimes(1);
    expect(voice.stop).toHaveBeenCalled();
    expect(ticket.querySelector(".lc-scratch__coin").classList.contains("lc-scratch__coin--on")).toBe(false);
    // The loop stops once the card is still.
    run(2000);
    expect(frames).toHaveLength(0);
  });

  it("lands within about five seconds whatever the grid", () => {
    const onLand = vi.fn();
    const big = { ...GAME, grid: { cols: 6, rows: 5 } };
    const { ctrl, panels, ticket } = mount({ reveal: reveal({ card: layCard(big, { kind: "dud" }, seededRng(9)) }), onLand });
    expect(panels).toHaveLength(31);
    layOut(ticket, panels, 6);
    ctrl.play();
    run(FOIL.spectatorMs + FOIL.crumbleMs + 100);
    expect(onLand).toHaveBeenCalledTimes(1);
  });

  it("duration 0 opens the card at once (the harness)", async () => {
    const onLand = vi.fn();
    const { ctrl, panels } = mount({ duration: 0, onLand });
    await ctrl.play();
    expect(panels.every(isOpen)).toBe(true);
    expect(onLand).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(0);
  });

  it("reduced motion: the table's card opens at once, with no shavings and no pop", async () => {
    const onLand = vi.fn();
    const { ctrl, panels } = mount({ reducedMotion: true, onLand });
    expect(ctrl.reducedMotion).toBe(true);
    await ctrl.play();
    expect(panels.every(isOpen)).toBe(true);
    expect(panels.some(p => p.classList.contains("lc-scratch__panel--pop"))).toBe(false);
    expect(onLand).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(0);
  });

  it("reduced motion: the buyer still scratches, and a panel opens at 60% with no crumble", () => {
    const { ctrl, panels, ticket } = mount({ buyer: true, reducedMotion: true });
    layOut(ticket, panels);
    ctrl.play();
    stroke(ticket, 25); stroke(ticket, 50); stroke(ticket, 75);
    run(16);
    expect(isOpen(panels[0])).toBe(true);
    expect(panels[0].classList.contains("lc-scratch__panel--pop")).toBe(false);
  });
});

describe("the kind's play and Watch again", () => {
  const host = () => { const h = doc.createElement("div"); doc.body.append(h); return h; };

  it("the buyer's first play is theirs to scratch; the table and every replay watch it scratch itself", () => {
    const h1 = host();
    SCRATCH.reveal.play(h1, reveal(), { buyer: true, sound: true, onLand: () => {} }).play();
    expect(h1.querySelector(".lc-scratch__ticket").dataset.buyer).toBe("1");
    const h2 = host();
    SCRATCH.reveal.play(h2, reveal(), { buyer: false, onLand: () => {} });
    expect(h2.querySelector(".lc-scratch__ticket").dataset.buyer).toBeUndefined();
    const h3 = host();
    SCRATCH.reveal.play(h3, reveal(), { buyer: true, replay: true, onLand: () => {} });
    expect(h3.querySelector(".lc-scratch__ticket").dataset.buyer).toBeUndefined();
    const h4 = host();
    SCRATCH.reveal.play(h4, reveal({ replay: true }), { buyer: true, onLand: () => {} });
    expect(h4.querySelector(".lc-scratch__all")).toBeNull();
  });

  it("the rasp and the tick play while the sound setting is on and the page in view", () => {
    const h = host();
    let hidden = false;
    const ctrl = SCRATCH.reveal.play(h, reveal(), { buyer: true, sound: true, pageHidden: () => hidden, onLand: () => {} });
    const panels = [...h.querySelectorAll("[data-panel]")];
    layOut(h.querySelector(".lc-scratch__ticket"), panels);
    ctrl.play();
    pointer(h.querySelector(".lc-scratch__ticket"), "pointerdown", 50, 50);
    expect(sound.playScratch).toHaveBeenCalledTimes(1);
    ctrl.open(3);
    expect(sound.playFoilTick).toHaveBeenCalledTimes(1);
    hidden = true;
    ctrl.open(4);
    expect(sound.playFoilTick).toHaveBeenCalledTimes(1);
    const quiet = host();
    const q = SCRATCH.reveal.play(quiet, reveal(), { buyer: true, sound: false, onLand: () => {} });
    q.play();
    q.open(0);
    expect(sound.playFoilTick).toHaveBeenCalledTimes(1);
  });

  it("the chat card keeps the card for Watch again, display only, and the replay is the table's sweep", () => {
    const r = reveal({ itemUuid: "Actor.a.Item.b", purse: { gp: 400 }, logId: "L1", requestId: "R1" });
    const snap = JSON.parse(JSON.stringify(replaySnapshot(r)));
    expect(snap.kind).toBe("scratch");
    expect(snap.card).toEqual(r.card);
    expect(JSON.stringify(snap)).not.toMatch(/Actor\.a|purse|"gp":400|L1|R1/);
    expect(JSON.stringify(snap).length).toBeLessThan(2000);
    const again = replayReveal(snap, "msg1");
    expect(again).toMatchObject({ kind: "scratch", replay: true, replayKey: "msg1", outcome: "coins", payoutCp: 2500, actorName: "Tam", box: { name: "Fortune Ticket", price: 5 } });
    expect(again.card).toEqual(r.card);
    expect(SCRATCH.reveal.result(again, { canSee: false })).toContain("Won 25 gp");
    // A tampered snapshot plays nothing.
    expect(replayReveal({ ...snap, card: { ...snap.card, panels: snap.card.panels.slice(1) } }, "x")).toBeNull();
    expect(replayReveal({ ...snap, card: { ...snap.card, layout: "bingo" } }, "x")).toBeNull();
    expect(cleanCard({ layout: "match3", cols: 3, rows: 2, key: [], panels: Array(6).fill({ symbol: "skull" }) })).toBeNull();
  });
});

describe("the scratch's sounds on Foundry's interface channel", () => {
  const param = () => ({ value: 1, calls: [], setValueAtTime(v, t) { this.calls.push(["set", v, t]); }, setTargetAtTime(v, t, k) { this.calls.push(["target", v, t, k]); }, linearRampToValueAtTime(v, t) { this.calls.push(["linear", v, t]); }, exponentialRampToValueAtTime(v, t) { this.calls.push(["exp", v, t]); }, cancelScheduledValues(t) { this.calls.push(["cancel", t]); } });
  let ctx, real;
  beforeEach(async () => {
    real = await vi.importActual("../module/scripts/foundry/sound.js");
    const connections = [];
    const node = name => { const n = { name, connect: to => { connections.push([n, to]); return to; } }; return n; };
    ctx = {
      currentTime: 5, sampleRate: 100, connections, sources: [], filters: [], gains: [], oscillators: [],
      createBuffer: (_c, len) => { const d = new Float32Array(len); return { getChannelData: () => d }; },
      createBufferSource() { const s = Object.assign(node("source"), { started: 0, stops: [], start() { this.started++; }, stop(t) { this.stops.push(t); } }); ctx.sources.push(s); return s; },
      createBiquadFilter() { const f = Object.assign(node("filter"), { type: "", frequency: param(), Q: { value: 0 } }); ctx.filters.push(f); return f; },
      createGain() { const g = Object.assign(node("gain"), { gain: param() }); ctx.gains.push(g); return g; },
      createOscillator() { const o = Object.assign(node("osc"), { type: "", frequency: param(), start() {}, stop() {} }); ctx.oscillators.push(o); return o; },
    };
    ctx.gainNode = Object.assign(node("gainNode"), { gain: { value: 0.5 } });
    globalThis.game = { audio: { locked: false, globalMute: false, interface: ctx } };
  });
  afterEach(() => { delete globalThis.game; });

  it("the rasp: looped noise through a bandpass into the channel, its pitch and level following the coin's speed", () => {
    const voice = real.playScratch();
    const [src] = ctx.sources, [filt] = ctx.filters, [g] = ctx.gains;
    expect(src.loop).toBe(true);
    expect(src.started).toBe(1);
    expect(filt.type).toBe("bandpass");
    expect(ctx.connections.map(([a, b]) => `${a.name}>${b.name}`)).toEqual(["source>filter", "filter>gain", "gain>gainNode"]);
    expect(real.scratchLevel(0)).toEqual({ hz: 900, gain: 0.04 });
    expect(real.scratchLevel(1000)).toEqual({ hz: 3300, gain: 0.16 });
    const mid = real.scratchLevel(5);
    expect(mid.hz).toBeGreaterThan(900); expect(mid.hz).toBeLessThan(3300);
    voice.rasp(5);
    expect(filt.frequency.calls.at(-1)).toEqual(["target", mid.hz, 5, 0.02]);
    expect(g.gain.calls.slice(-2)).toEqual([["set", mid.gain, 5], ["linear", 0, 5 + 0.14]]);
    voice.stop();
    voice.stop();
    expect(src.stops).toHaveLength(1);
    voice.rasp(9); // after stop: nothing
    expect(g.gain.calls.at(-1)[0]).toBe("target");
  });

  it("nothing is built on a muted channel, and the voice still answers", () => {
    ctx.gainNode.gain.value = 0;
    const voice = real.playScratch(4);
    expect(() => { voice.rasp(4); voice.stop(); }).not.toThrow();
    real.playFoilTick();
    expect(ctx.sources).toHaveLength(0);
    expect(ctx.oscillators).toHaveLength(0);
  });

  it("the panel's tick: one short square note at 1400 Hz", () => {
    real.playFoilTick();
    expect(ctx.oscillators).toHaveLength(1);
    expect(ctx.oscillators[0].type).toBe("square");
    expect(ctx.oscillators[0].frequency.calls[0]).toEqual(["set", 1400, 5]);
  });
});
