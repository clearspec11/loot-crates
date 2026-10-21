/* mountSpin against a fake DOM: just enough elements for the spin to mount,
   a viewport with a fixed width, and a requestAnimationFrame driven by hand,
   so the test can read which cards pass under the marker. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mountSpin, nearMissOvershoot, spinDistance, brakeAt, settleAt, SPIN_ACCEL, SPIN_CRUISE, SPIN_SPLIT, CARD_WIDTH, CARD_GAP, DEFAULT_DURATION } from "../module/scripts/spin.js";

const fakeElement = () => ({
  className: "", textContent: "", innerHTML: "", clientWidth: 0, dataset: {}, children: [],
  classList: { add() {}, remove() {} },
  style: { transform: "", setProperty() {} },
  setAttribute() {},
  append(...kids) { this.children.push(...kids); },
  appendChild(kid) { this.children.push(kid); },
});

let frames;
beforeEach(() => {
  frames = [];
  vi.stubGlobal("document", { createElement: fakeElement });
  vi.stubGlobal("requestAnimationFrame", cb => frames.push(cb));
});
afterEach(() => vi.unstubAllGlobals());

const strip = nearMiss => ({
  landIndex: 40,
  nearMiss,
  cards: Array.from({ length: 48 }, (_, i) => ({ uuid: `c${i}`, name: `Card ${i}`, img: "", rarity: i === 41 && nearMiss ? "rare" : "common", result: i === 40 })),
});

// Plays at 60 fps and returns every index onTick reported.
async function ticks(s, width = 900) {
  const seen = [];
  const container = fakeElement();
  const spin = mountSpin(container, s, { duration: 1800, reducedMotion: false, onTick: i => seen.push(i) });
  spin.viewport.clientWidth = width;
  const done = spin.play();
  for (let now = 0; frames.length; now += 16) frames.shift()(now);
  await done;
  expect(spin.landed).toBe(true);
  return seen;
}

describe("the near-miss overshoot", () => {
  it("crosses into the next card by a quarter card at the default size", () => {
    expect(nearMissOvershoot()).toBe(CARD_WIDTH / 2 + CARD_GAP + CARD_WIDTH / 4);
    expect(nearMissOvershoot()).toBeGreaterThan(CARD_WIDTH / 2 + CARD_GAP);
  });

  it("puts the teased card under the marker, then clicks back to the result", async () => {
    const seen = await ticks(strip(true));
    expect(seen.slice(-2)).toEqual([41, 40]);
    expect(seen.indexOf(41)).toBeGreaterThan(seen.indexOf(40));
  });

  it("never reaches the next card without a near-miss", async () => {
    const seen = await ticks(strip(false));
    expect(seen).not.toContain(41);
    expect(seen.at(-1)).toBe(40);
  });

  it("holds on a narrow viewport too", async () => {
    expect((await ticks(strip(true), 360)).slice(-2)).toEqual([41, 40]);
  });
});

describe("the spin's speed profile", () => {
  const h = 1e-6;
  const speed = p => (spinDistance(p + h) - spinDistance(p - h)) / (2 * h);

  it("starts at 0 and ends at 1, never going backwards", () => {
    expect(spinDistance(0)).toBe(0);
    expect(spinDistance(1)).toBe(1);
    let last = 0;
    for (let i = 1; i <= 1000; i++) {
      const d = spinDistance(i / 1000);
      expect(d).toBeGreaterThanOrEqual(last);
      last = d;
    }
    expect(last).toBeCloseTo(1, 12);
  });

  it("holds one speed through the cruise, and it is the top speed", () => {
    const cruise = speed(SPIN_ACCEL + SPIN_CRUISE / 2);
    for (let p = SPIN_ACCEL + 0.001; p < SPIN_ACCEL + SPIN_CRUISE - 0.001; p += 0.01) expect(speed(p)).toBeCloseTo(cruise, 6);
    for (let p = 0.001; p < 1; p += 0.01) expect(speed(p)).toBeLessThanOrEqual(cruise + 1e-6);
  });

  it("has no jolt where the phases meet, and stops dead at the end", () => {
    for (const edge of [SPIN_ACCEL, SPIN_ACCEL + SPIN_CRUISE]) {
      const before = (spinDistance(edge) - spinDistance(edge - 1e-4)) / 1e-4;
      const after = (spinDistance(edge + 1e-4) - spinDistance(edge)) / 1e-4;
      expect(after).toBeCloseTo(before, 2);
    }
    expect(speed(1 - 2e-6)).toBeLessThan(1e-3);
    expect(speed(1e-6)).toBeLessThan(1e-3);
  });

  it("cruises for 35 to 40% of the whole spin", () => {
    // mountSpin runs spinDistance over the first 86% of the duration.
    const share = SPIN_CRUISE * 0.86;
    expect(share).toBeGreaterThanOrEqual(0.35);
    expect(share).toBeLessThanOrEqual(0.4);
  });
});

/*
  The phase cues come from the frames that draw the strip, so a sound cued on
  them marks what the eye sees: "brake" when the ease-out begins, "settle"
  when the strip turns back. Default duration, a fake 60 fps clock that
  starts at an arbitrary time.
*/
describe("the spin's brake and settle cues", () => {
  const T0 = 1000;
  function mount({ reducedMotion = false, onTick } = {}) {
    const phases = [];
    const spin = mountSpin(fakeElement(), strip(false), { reducedMotion, onTick, onPhase: (phase, info) => phases.push({ phase, ...info }) });
    spin.viewport.clientWidth = 680;
    let now = T0;
    const run = (until = Infinity) => { for (; frames.length && now - T0 <= until; now += 16) frames.shift()(now); };
    return { spin, phases, run, done: spin.play() };
  }

  it("brakes where the ease-out starts: about 2773 ms into the default spin", () => {
    expect(brakeAt()).toBeCloseTo(SPIN_SPLIT * (SPIN_ACCEL + SPIN_CRUISE) * DEFAULT_DURATION, 9);
    expect(Math.round(brakeAt())).toBe(2773);
    expect(Math.round(settleAt())).toBe(5332);
    expect(brakeAt(1000)).toBeCloseTo(1000 * SPIN_SPLIT * (SPIN_ACCEL + SPIN_CRUISE), 9);
  });

  it("fires brake once, in the first frame at or after 2773 ms, and settle once at or after 5332 ms", async () => {
    const { spin, phases, run, done } = mount();
    run();
    await done;
    expect(spin.landed).toBe(true);
    expect(phases.map(p => p.phase)).toEqual(["brake", "settle"]);
    const [brake, settle] = phases;
    // 16 ms frames: 2784 is the first at or after 2772.9, 5344 the first at or after 5332.
    expect(brake.at).toBe(2784);
    expect(brake.at - 16).toBeLessThan(brakeAt());
    expect(brake.settleIn).toBeCloseTo(settleAt() - 2784, 9);
    expect(settle.at).toBe(5344);
    expect(settle.at - 16).toBeLessThan(settleAt());
    expect(settle.settleIn).toBe(0);
  });

  it("cues the brake from the frame that begins it: the strip's speed starts falling there", async () => {
    const xs = [];
    const { spin, phases, done } = mount();
    const read = () => -parseFloat(spin.track.style.transform.slice("translate3d(".length));
    // Sample x per frame alongside the run.
    for (let now = T0; frames.length; now += 16) { frames.shift()(now); xs.push([now - T0, read()]); }
    await done;
    const speed = i => xs[i][1] - xs[i - 1][1];
    const at = xs.findIndex(([t]) => t === phases[0].at);
    // Top speed held through the cruise up to the brake, falling after it.
    expect(speed(at - 1)).toBeCloseTo(speed(at - 20), 6);
    expect(speed(at + 20)).toBeLessThan(speed(at - 1) * 0.95);
  });

  it("fires neither when skip() comes before the brake", async () => {
    const { spin, phases, run, done } = mount();
    run(1500);
    spin.skip();
    run();
    await done;
    expect(spin.landed).toBe(true);
    expect(phases).toEqual([]);
  });

  it("fires no settle when skip() comes during the brake", async () => {
    const { spin, phases, run, done } = mount();
    run(3500);
    spin.skip();
    run();
    await done;
    expect(phases.map(p => p.phase)).toEqual(["brake"]);
  });

  it("fires neither under reduced motion or for a hidden land", async () => {
    const reduced = mount({ reducedMotion: true });
    await reduced.done;
    expect(reduced.spin.landed).toBe(true);
    expect(reduced.phases).toEqual([]);

    const hidden = mount();
    hidden.run(1000);
    hidden.spin.skip({ now: true });
    hidden.run();
    await hidden.done;
    expect(hidden.spin.landed).toBe(true);
    expect(hidden.phases).toEqual([]);
  });

  it("doesn't announce a brake a stalled frame leapt clean past", async () => {
    const { spin, phases, done } = mount();
    frames.shift()(T0);
    frames.shift()(T0 + 5400);
    for (let now = T0 + 5416; frames.length; now += 16) frames.shift()(now);
    await done;
    expect(spin.landed).toBe(true);
    expect(phases.map(p => p.phase)).toEqual(["settle"]);
  });
});
