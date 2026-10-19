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

export function formatPrice(priceGp) {
  const cp = Math.round(priceGp * 100);
  if (cp % 100 === 0) return `${cp / 100} gp`;
  if (cp % 10 === 0) return `${cp / 10} sp`;
  return `${cp} cp`;
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
