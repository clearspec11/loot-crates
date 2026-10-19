/* mountSpin against a fake DOM: just enough elements for the spin to mount,
   a viewport with a fixed width, and a requestAnimationFrame driven by hand,
   so the test can read which cards pass under the marker. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mountSpin, nearMissOvershoot, CARD_WIDTH, CARD_GAP } from "../module/scripts/spin.js";

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
