/*
  Crate sounds play on Foundry's interface channel: every oscillator's
  envelope connects to game.audio.interface.gainNode, never straight to the
  speakers, so the hotbar Mute and the interface volume slider apply. With
  no channel yet (before the first gesture) or a muted one, nothing is built.
*/
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { playTick, playSlow, playReveal, TICK_HZ, TEASE_HZ, BACK_HZ } from "../module/scripts/sound.js";

const param = () => ({
  value: 1, set: [], ramps: [],
  setValueAtTime(v, t) { this.set.push([v, t]); },
  exponentialRampToValueAtTime(v, t) { this.ramps.push([v, t]); },
});

function fakeContext({ volume = 0.5 } = {}) {
  const ctx = {
    currentTime: 10,
    destination: { name: "destination" },
    oscillators: [],
    envelopes: [],
    connections: [],
    node(name) {
      const n = { name, connect: target => { ctx.connections.push([n, target]); return target; } };
      return n;
    },
    createOscillator() {
      const o = Object.assign(ctx.node("osc"), { type: "", frequency: param(), started: 0, start() { this.started++; }, stop() {} });
      ctx.oscillators.push(o);
      return o;
    },
    createGain() {
      const g = Object.assign(ctx.node("envelope"), { gain: param() });
      ctx.envelopes.push(g);
      return g;
    },
    createBiquadFilter() {
      const f = Object.assign(ctx.node("filter"), { type: "", frequency: param() });
      ctx.filters.push(f);
      return f;
    },
    filters: [],
  };
  ctx.gainNode = Object.assign(ctx.node("gainNode"), { gain: { value: volume } });
  return ctx;
}

const playAll = () => { playTick(0.2); playTick(1); playSlow(); playReveal("legendary"); };

describe("crate sounds on Foundry's interface channel", () => {
  let ctx;
  beforeEach(() => {
    ctx = fakeContext();
    globalThis.game = { audio: { locked: false, globalMute: false, interface: ctx }, settings: { get: () => 0.25 } };
  });
  afterEach(() => { delete globalThis.game; });

  it("connects every sound to the interface gainNode and never to the destination", () => {
    playAll();
    expect(ctx.oscillators.length).toBe(7); // 2 ticks, 1 whoosh, 4 sting notes
    expect(ctx.oscillators.every(o => o.started === 1)).toBe(true);
    for (const osc of ctx.oscillators) {
      let [, envelope] = ctx.connections.find(([from]) => from === osc);
      // The braking sweep runs through its lowpass on the way.
      if (ctx.filters.includes(envelope)) [, envelope] = ctx.connections.find(([from]) => from === envelope);
      expect(ctx.envelopes).toContain(envelope);
      expect(ctx.connections.find(([from]) => from === envelope)[1]).toBe(ctx.gainNode);
    }
    expect(ctx.connections.some(([, to]) => to === ctx.destination)).toBe(false);
    expect(ctx.connections.filter(([, to]) => to === ctx.gainNode)).toHaveLength(7);
  });

  it("builds nothing and throws nothing before Foundry has an interface channel", () => {
    globalThis.game = { audio: { locked: true, interface: undefined } };
    expect(playAll).not.toThrow();
    globalThis.game = {};
    expect(playAll).not.toThrow();
    delete globalThis.game;
    expect(playAll).not.toThrow();
    expect(ctx.oscillators).toHaveLength(0);
  });

  it("builds nothing while the channel's gain is 0 (the hotbar Mute or a zero slider)", () => {
    ctx.gainNode.gain.value = 0;
    playAll();
    expect(ctx.oscillators).toHaveLength(0);
    ctx.gainNode.gain.value = 0.5;
    globalThis.game.audio.globalMute = true; // muted before the gain ramp has rendered
    playAll();
    expect(ctx.oscillators).toHaveLength(0);
    globalThis.game.audio.globalMute = false;
    playTick(0);
    expect(ctx.oscillators).toHaveLength(1);
  });

  it("leaves the interface volume to the gainNode and does not scale by the setting again", () => {
    playTick(0);
    playSlow();
    playReveal("common");
    expect(ctx.envelopes.map(g => g.gain.set[0][0])).toEqual([0.05, 0.03, 0.12, 0.12]);
  });
});

describe("the braking sweep and the near-miss voices", () => {
  let ctx;
  beforeEach(() => {
    ctx = fakeContext();
    globalThis.game = { audio: { locked: false, globalMute: false, interface: ctx } };
  });
  afterEach(() => { delete globalThis.game; });

  it("falls in pitch over exactly the braking time it is given, and fades out with it", () => {
    playSlow(2560);
    const [osc] = ctx.oscillators;
    const [start] = osc.frequency.set;
    const [end] = osc.frequency.ramps;
    expect(osc.type).toBe("sawtooth");
    expect(start).toEqual([260, 10]);
    expect(end[0]).toBe(90);
    expect(end[1]).toBeCloseTo(10 + 2.56, 9);
    expect(end[0]).toBeLessThan(start[0]);
    const [envelope] = ctx.envelopes;
    expect(envelope.gain.ramps.at(-1)[0]).toBeLessThan(0.001);
    expect(envelope.gain.ramps.at(-1)[1]).toBeCloseTo(10 + 2.56, 9);
    // The lowpass closes as the pitch falls.
    const [lp] = ctx.filters;
    expect(lp.frequency.ramps[0][0]).toBeLessThan(lp.frequency.set[0][0]);
  });

  it("still sweeps down on a context with no filters", () => {
    delete ctx.createBiquadFilter;
    playSlow(1000);
    expect(ctx.oscillators[0].frequency.ramps[0][0]).toBeLessThan(ctx.oscillators[0].frequency.set[0][0]);
    expect(ctx.connections.filter(([, to]) => to === ctx.gainNode)).toHaveLength(1);
  });

  const hz = osc => osc.frequency.set[0][0];

  it("teases with two quick rising notes above every strip tick", () => {
    playTick(1, { tease: true });
    expect(ctx.oscillators).toHaveLength(2);
    const [a, b] = ctx.oscillators;
    expect(hz(b)).toBeGreaterThan(hz(a));
    expect(b.frequency.set[0][1]).toBeGreaterThan(a.frequency.set[0][1]);
    expect(Math.min(hz(a), hz(b))).toBeGreaterThan(TICK_HZ[1]);
    expect([hz(a), hz(b)]).toEqual(TEASE_HZ);
  });

  it("drops back with one low, soft click below every strip tick and every tease note", () => {
    playTick(1, { back: true });
    expect(ctx.oscillators).toHaveLength(1);
    const [osc] = ctx.oscillators;
    expect(osc.type).toBe("triangle");
    expect(hz(osc)).toBe(BACK_HZ);
    expect(hz(osc)).toBeLessThan(TICK_HZ[0]);
    expect(ctx.envelopes[0].gain.set[0][0]).toBeLessThan(0.05);
  });

  it("keeps a plain tick inside the tick band, clear of both near-miss voices", () => {
    for (const p of [0, 0.25, 0.5, 0.975, 1, 1.025]) playTick(p);
    for (const osc of ctx.oscillators) {
      expect(hz(osc)).toBeGreaterThanOrEqual(TICK_HZ[0]);
      expect(hz(osc)).toBeLessThanOrEqual(TICK_HZ[1]);
      expect(osc.type).toBe("square");
    }
  });
});
