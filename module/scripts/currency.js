/*
  dnd5e coins: actor.system.currency is { pp, gp, ep, sp, cp }. A price is in
  gp. charge() pays it from the purse with the fewest coin moves it can, paying
  with the largest coins first and making change back into gp/sp/cp, and returns
  the new purse or null when the actor can't afford it.
*/
export const COPPER_PER = { pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1 };
const ORDER = ["pp", "gp", "ep", "sp", "cp"];

export function toCopper(purse = {}) {
  return ORDER.reduce((n, k) => n + (Math.max(0, Number(purse[k]) || 0) * COPPER_PER[k]), 0);
}

export function canAfford(purse, priceGp) {
  return toCopper(purse) >= Math.round(priceGp * 100);
}

// How much more the purse needs for priceGp, in gp (0 when it can afford it).
export function shortfall(purse, priceGp) {
  return Math.max(0, Math.round(priceGp * 100) - toCopper(purse)) / 100;
}

// A price in the coins charge() takes for it: 12.5 gp is "12 gp 5 sp", not
// "125 sp", so what the button says is what leaves the purse.
export function formatPrice(priceGp) {
  let cp = Math.round(priceGp * 100);
  if (!(cp > 0)) return "0 gp";
  const parts = [];
  for (const c of ["gp", "sp", "cp"]) {
    const n = Math.floor(cp / COPPER_PER[c]);
    if (n) parts.push(`${n} ${c}`);
    cp -= n * COPPER_PER[c];
  }
  return parts.join(" ");
}

export function charge(purse = {}, priceGp) {
  const cost = Math.round(priceGp * 100);
  if (cost < 0) return null;
  if (!canAfford(purse, priceGp)) return null;
  const next = Object.fromEntries(ORDER.map(k => [k, Math.max(0, Math.floor(Number(purse[k]) || 0))]));
  let owed = cost;

  // Exact coins first, smallest first, so a 3 gp price takes 3 gp, not a pp.
  for (const k of [...ORDER].reverse()) {
    const use = Math.min(next[k], Math.floor(owed / COPPER_PER[k]));
    next[k] -= use;
    owed -= use * COPPER_PER[k];
  }
  if (owed === 0) return next;

  // Break one larger coin and return the change.
  for (const k of [...ORDER].reverse()) {
    if (next[k] > 0 && COPPER_PER[k] > owed) {
      next[k] -= 1;
      let change = COPPER_PER[k] - owed;
      for (const c of ["gp", "sp", "cp"]) {
        const n = Math.floor(change / COPPER_PER[c]);
        next[c] += n;
        change -= n * COPPER_PER[c];
      }
      return next;
    }
  }
  return null;
}

// True when every coin in the purse is a whole, non-negative number: the only
// shape charge() and refund() ever write, and what the dnd5e sheet shows.
export function isWholeCoins(purse = {}) {
  return ORDER.every(k => {
    const n = Number(purse[k] ?? 0);
    return Number.isInteger(n) && n >= 0;
  });
}

// The inverse of charge(): gives priceGp back in whole gp/sp/cp on top of the
// purse (never as a fractional gp), so toCopper(refund(charge(p, x), x)) is
// toCopper(p). Coins are floored the way charge() floors them, so the result is
// always whole coins. A zero or negative price returns the purse unchanged.
export function refund(purse = {}, priceGp) {
  const next = Object.fromEntries(ORDER.map(k => [k, Math.max(0, Math.floor(Number(purse[k]) || 0))]));
  let owed = Math.round(priceGp * 100);
  if (!(owed > 0)) return next;
  for (const c of ["gp", "sp", "cp"]) {
    const n = Math.floor(owed / COPPER_PER[c]);
    next[c] += n;
    owed -= n * COPPER_PER[c];
  }
  return next;
}
