import { describe, it, expect } from "vitest";
import { toCopper, canAfford, charge, formatPrice, refund, isWholeCoins, consolidate, settle } from "../module/scripts/currency.js";

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
    expect(formatPrice(12.5)).toBe("12 gp 5 sp");
    expect(formatPrice(17.35)).toBe("17 gp 3 sp 5 cp");
    expect(formatPrice(0)).toBe("0 gp");
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

  it("refunds a fractional price as whole gp/sp/cp, never a fractional gp", () => {
    expect(refund({ gp: 500 }, 17.35)).toEqual({ pp: 0, gp: 517, ep: 0, sp: 3, cp: 5 });
    expect(refund({ pp: 1, gp: 2, ep: 3, sp: 4, cp: 5 }, 12.5)).toEqual({ pp: 1, gp: 14, ep: 3, sp: 9, cp: 5 });
    expect(isWholeCoins(refund({ gp: 500 }, 17.35))).toBe(true);
  });

  it("refunds in consolidated coins: 100 gp comes back as 100 gp, not 99 gp 10 sp", () => {
    expect(refund({ gp: 0, sp: 9, cp: 10 }, 100)).toEqual({ pp: 0, gp: 101, ep: 0, sp: 0, cp: 0 });
    expect(refund({ gp: 0, sp: 10 }, 99)).toEqual({ pp: 0, gp: 100, ep: 0, sp: 0, cp: 0 });
    expect(refund({ gp: 4, sp: 9, cp: 9 }, 0.01)).toEqual({ pp: 0, gp: 5, ep: 0, sp: 0, cp: 0 });
    expect(refund({ gp: 1, sp: 5, cp: 5 }, 0.55)).toEqual({ pp: 0, gp: 2, ep: 0, sp: 1, cp: 0 });
  });

  it("consolidating keeps the player's pp and ep and the copper value", () => {
    expect(refund({ pp: 2, ep: 3, sp: 9 }, 0.1)).toEqual({ pp: 2, gp: 1, ep: 3, sp: 0, cp: 0 });
    const purse = { pp: 3, gp: 7, ep: 5, sp: 47, cp: 123 };
    const c = consolidate(purse);
    expect(c).toEqual({ pp: 3, gp: 12, ep: 5, sp: 9, cp: 3 });
    expect(toCopper(c)).toBe(toCopper(purse));
  });

  it("a 100 gp charge then refund on a purse of gold reads as gold again", () => {
    const purse = { pp: 0, gp: 150, ep: 0, sp: 0, cp: 0 };
    expect(refund(charge(purse, 100), 100)).toEqual(purse);
    expect(refund(charge({ gp: 120 }, 99.95), 99.95)).toEqual({ pp: 0, gp: 120, ep: 0, sp: 0, cp: 0 });
  });

  it("change from a broken coin is consolidated", () => {
    expect(charge({ gp: 0, sp: 15, cp: 7 }, 0.12)).toEqual({ pp: 0, gp: 1, ep: 0, sp: 4, cp: 5 });
  });

  it("refund of nothing is the purse itself, floored to whole coins", () => {
    expect(refund({ gp: 1 }, 0)).toEqual({ pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 });
    expect(refund({ gp: 1 }, -5)).toEqual({ pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 });
    expect(refund({ gp: 517.35 }, 0)).toEqual({ pp: 0, gp: 517, ep: 0, sp: 0, cp: 0 });
  });

  it("recognises whole coins and rejects the fractional purse the old refund wrote", () => {
    expect(isWholeCoins({ pp: 0, gp: 517, ep: 0, sp: 3, cp: 5 })).toBe(true);
    expect(isWholeCoins({})).toBe(true);
    expect(isWholeCoins({ gp: 517.35 })).toBe(false);
    expect(isWholeCoins({ gp: -1 })).toBe(false);
  });

  it("charge then refund restores the copper value, in whole coins, for 2000 purses", () => {
    let seed = 777;
    const rnd = n => { seed = (seed * 1103515245 + 12345) >>> 0; return seed % n; };
    for (let i = 0; i < 2000; i++) {
      const purse = { pp: rnd(4), gp: rnd(60), ep: rnd(5), sp: rnd(40), cp: rnd(100) };
      const price = rnd(80) + rnd(100) / 100;
      const paid = charge(purse, price);
      if (!paid) continue;
      const back = refund(paid, price);
      expect(isWholeCoins(back)).toBe(true);
      expect(toCopper(back)).toBe(toCopper(purse));
      if (Math.round(price * 100) > 0) {
        expect(back.sp).toBeLessThan(10);
        expect(back.cp).toBeLessThan(10);
      }
    }
  });

  it("settle() moves copper both ways: a charge, a payout, both at once, and null when the winnings are spent", () => {
    const purse = { pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 };
    expect(settle(purse, -5)).toEqual(charge(purse, 0.05));
    expect(settle(purse, -5)).toEqual({ pp: 0, gp: 0, ep: 0, sp: 9, cp: 5 });
    expect(settle(purse, 300)).toEqual(refund(purse, 3));
    expect(settle(purse, 300 - 5)).toEqual({ pp: 0, gp: 3, ep: 0, sp: 9, cp: 5 });
    expect(settle(purse, 0)).toEqual(purse);
    expect(settle({ gp: 2.5, cp: 3 }, 0)).toEqual({ pp: 0, gp: 2, ep: 0, sp: 0, cp: 3 });
    expect(settle({ cp: 50 }, -295)).toBeNull();
    expect(settle(purse, -100)).toEqual({ pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 });
    expect(settle(purse, -101)).toBeNull();
  });

  it("a crate's charge and refund are settle() with the price in copper", () => {
    const purse = { pp: 1, gp: 12, ep: 1, sp: 3, cp: 7 };
    expect(settle(purse, -1735)).toEqual(charge(purse, 17.35));
    expect(settle(charge(purse, 17.35), 1735)).toEqual(refund(charge(purse, 17.35), 17.35));
    expect(toCopper(settle(settle(purse, -1735), 1735))).toBe(toCopper(purse));
  });
});
