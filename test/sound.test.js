/*
  Crate sounds play on Foundry's interface channel: every oscillator's
  envelope connects to game.audio.interface.gainNode, never straight to the
  speakers, so the hotbar Mute and the interface volume slider apply. With
  no channel yet (before the first gesture) or a muted one, nothing is built.
*/
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { playTick, playSlow, playReveal } from "../module/scripts/sound.js";

const param = () => ({ value: 1, set: [], setValueAtTime(v, t) { this.set.push([v, t]); }, exponentialRampToValueAtTime() {} });

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
      const [, envelope] = ctx.connections.find(([from]) => from === osc);
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
