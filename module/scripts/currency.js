/*
  dnd5e coins: actor.system.currency is { pp, gp, ep, sp, cp }. A price is in
  gp. charge() pays it from the purse with the fewest coin moves it can, paying
  with the smallest exact coins first and making change back into gp/sp/cp
  (carried 10 cp to 1 sp, 10 sp to 1 gp, so change never reads "12 sp"), and
  returns the new purse or null when the actor can't afford it.
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

/*
  A price as a GM types it, back to gp: the inverse of formatPrice, so what
  the Boxes row and the editors show can be typed back as it reads. "50",
  "50 gp", "5 sp", "12 gp 5 sp", "1gp 2sp 3cp" and "12.5" (a bare number is
  gold) all read; so do pp and ep, the coins a stake select offers, and
  "1,200 gp". Each coin once, in any order, any case. Anything else is null:
  "", "abc", "-5", "5 gold", "5 gp gp", or a part of a copper.
*/
const PRICE_PART = /^(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?|\.\d+)\s*(pp|gp|ep|sp|cp)?$/i;
export function parsePrice(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const parts = raw.match(/(?:\d[\d,]*(?:\.\d+)?|\.\d+)\s*[a-z]*/gi);
  if (!parts || parts.join("").replace(/\s+/g, "") !== raw.replace(/\s+/g, "")) return null;
  const seen = new Set();
  let cp = 0;
  for (const part of parts) {
    const m = part.trim().match(PRICE_PART);
    if (!m) return null;
    const coin = (m[2] ?? "").toLowerCase();
    // A bare number is gold, and only on its own: "12 5 sp" is a typo.
    if (!coin && parts.length > 1) return null;
    const key = coin || "gp";
    if (seen.has(key)) return null;
    seen.add(key);
    cp += Number(m[1].replace(/,/g, "")) * COPPER_PER[key];
  }
  const whole = Math.round(cp);
  if (!Number.isFinite(cp) || Math.abs(cp - whole) > 1e-6) return null;
  return whole / 100;
}

// What the Boxes row and the editors say about a price they can't read.
export const unreadablePrice = text => (String(text ?? "").trim() ? `Couldn't read "${String(text).trim()}"; try 5 gp or 5 sp.` : "Type a price, such as 5 gp or 5 sp.");

// A purse as gold, the way the shop's header and the reveal show it, in the
// same coins as every price beside it: "450 gp", or "450 gp 5 sp 3 cp" when
// there's silver or copper in it (never "450.53 gp" next to "12 gp 5 sp").
export function formatGold(purse = {}) {
  return formatPrice(toCopper(purse) / 100);
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
      return consolidate(next);
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

// Carry copper into silver and silver into gold, 10 to 1, the way a player
// tidies a purse on the sheet: { gp: 0, sp: 9, cp: 10 } reads 1 gp. pp and ep
// are left as the player keeps them; the copper value is unchanged.
export function consolidate(purse = {}) {
  const next = Object.fromEntries(ORDER.map(k => [k, Math.max(0, Math.floor(Number(purse[k]) || 0))]));
  next.sp += Math.floor(next.cp / 10); next.cp %= 10;
  next.gp += Math.floor(next.sp / 10); next.sp %= 10;
  return next;
}

// The inverse of charge(): gives priceGp back on top of the purse in whole
// coins, then consolidates gp/sp/cp so a 100 gp price comes back as 100 gp,
// never "99 gp 10 sp". toCopper(refund(charge(p, x), x)) is toCopper(p). Coins
// are floored the way charge() floors them. A zero or negative price returns
// the purse floored to whole coins, unconsolidated.
export function refund(purse = {}, priceGp) {
  const next = Object.fromEntries(ORDER.map(k => [k, Math.max(0, Math.floor(Number(purse[k]) || 0))]));
  const owed = Math.round(priceGp * 100);
  if (!(owed > 0)) return next;
  next.cp += owed;
  return consolidate(next);
}

/*
  Coins both ways, in copper, for every game of chance: a negative amount is
  charged (charge(), null when the purse can't cover it), a positive one is
  paid out (refund()), and zero leaves the purse as it is in whole coins. A
  crate's pull is settle(purse, -priceCp); a dice win is settle(purse,
  payoutCp - stakeCp); a refund gives the stake back and takes the payout
  back in one move, settle(purse, stakeCp - payoutCp), which is null when
  the winnings have been spent. Copper, not gp, so a copper stake is exact.
*/
export function settle(purse = {}, cp) {
  const n = Math.round(Number(cp) || 0);
  if (n < 0) return charge(purse, -n / 100);
  return refund(purse, n / 100);
}
