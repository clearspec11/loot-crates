/* mountSpin against a fake DOM: just enough elements for the spin to mount,
   a viewport with a fixed width, and a requestAnimationFrame driven by hand,
   so the test can read which cards pass under the marker. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mountSpin, nearMissOvershoot, spinDistance, SPIN_ACCEL, SPIN_CRUISE, CARD_WIDTH, CARD_GAP } from "../module/scripts/spin.js";

const fakeElement = () => ({
  className: "", textContent: "", innerHTML: "", clientWidth: 0, dataset: {}, children: [],
  classList: { add() {} },
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
