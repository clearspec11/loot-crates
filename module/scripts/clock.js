/*
  The in-game day, for anything that counts "per day": the Wishing Well's
  cap (well.js). Foundry keeps the world's clock in game.time: v13 and v14
  expand it through the world's calendar into components (year and the day
  of that year), which is what the GM moves with a calendar control or a
  long rest that advances time. The key names that day, so a count keyed on
  it rolls over when the party's day does, never on the server's clock, and
  the GM never resets anything by hand.

  No Foundry globals: the caller passes game.time (store.js todayKey), so
  Vitest can hand it any clock. Null when the world has no clock at all, in
  which case nothing is counted per day.
*/
const SECONDS_PER_DAY = 86400;

export function dayKeyOf(time) {
  const c = time?.components;
  if (c && Number.isFinite(c.year) && Number.isFinite(c.day)) return `y${c.year}d${c.day}`;
  // A world whose calendar isn't set up yet still has the seconds.
  const seconds = Number(time?.worldTime);
  if (Number.isFinite(seconds)) return `t${Math.floor(seconds / SECONDS_PER_DAY)}`;
  return null;
}
