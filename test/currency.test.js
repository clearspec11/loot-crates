import { describe, it, expect } from "vitest";
import { toCopper, canAfford, charge, formatPrice } from "../module/scripts/currency.js";

describe("currency", () => {
  it("values a purse in copper", () => {
    expect(toCopper({ pp: 1, gp: 2, ep: 1, sp: 3, cp: 4 })).toBe(1000 + 200 + 50 + 30 + 4);
    expect(toCopper({})).toBe(0);
    expect(toCopper({ gp: -5 })).toBe(0);
  });

  it("formats prices in the largest whole coin", () => {
    expect(formatPrice(150)).toBe("150 gp");
    expect(formatPrice(0.5)).toBe("5 sp");
    expect(formatPrice(0.07)).toBe("7 cp");
  });

  it("pays with exact smaller coins before breaking a larger one", () => {
    expect(charge({ pp: 1, gp: 5, ep: 0, sp: 0, cp: 0 }, 3)).toEqual({ pp: 1, gp: 2, ep: 0, sp: 0, cp: 0 });
    expect(charge({ pp: 0, gp: 0, ep: 0, sp: 15, cp: 0 }, 1)).toEqual({ pp: 0, gp: 0, ep: 0, sp: 5, cp: 0 });
  });

  it("breaks a platinum piece and returns change", () => {
    expect(charge({ pp: 1, gp: 0, ep: 0, sp: 0, cp: 30 }, 1)).toEqual({ pp: 0, gp: 9, ep: 0, sp: 3, cp: 0 });
    expect(toCopper(charge({ pp: 2, gp: 3, ep: 1, sp: 2, cp: 9 }, 17.35))).toBe(toCopper({ pp: 2, gp: 3, ep: 1, sp: 2, cp: 9 }) - 1735);
  });

  it("refuses what the purse can't cover and ignores negative prices", () => {
    expect(canAfford({ gp: 99 }, 100)).toBe(false);
    expect(charge({ gp: 99 }, 100)).toBeNull();
    expect(charge({ gp: 1 }, -1)).toBeNull();
    expect(charge({ gp: 1 }, 0)).toEqual({ pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 });
  });

  it("never produces a negative coin and always conserves value", () => {
    let seed = 12345;
    const rnd = n => { seed = (seed * 1103515245 + 12345) >>> 0; return seed % n; };
    for (let i = 0; i < 2000; i++) {
      const purse = { pp: rnd(4), gp: rnd(60), ep: rnd(5), sp: rnd(40), cp: rnd(100) };
      const price = rnd(80) + rnd(100) / 100;
      const next = charge(purse, price);
      if (!canAfford(purse, price)) { expect(next).toBeNull(); continue; }
      for (const k of Object.keys(next)) expect(next[k]).toBeGreaterThanOrEqual(0);
      expect(toCopper(next)).toBe(toCopper(purse) - Math.round(price * 100));
    }
  });
});
