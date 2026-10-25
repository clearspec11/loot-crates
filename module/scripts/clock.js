/*
  The in-game day, for anything that counts "per day": the Wishing Well's
  cap (well.js) and a game's limit per character per day (limits.js).

  Two ways a day ends, the same two dnd5e uses for an item's daily uses:
  - "calendar": Foundry keeps the world's clock in game.time, which v13 and
    v14 expand through the world's calendar into components (year and the
    day of that year), moved by the GM's calendar control or by a long rest
    that advances time. The key names that day (dayKeyOf).
  - "rest" (and "manual"): dnd5e 6 ships with its calendar off, and then a
    long rest does not move game.time at all, so a key from the clock would
    name the same day forever. dnd5e instead treats a long rest's "new day"
    as the day's end (CalendarConfigSetting.manualRecovery), and so does
    this: each character's count of new-day rests is its day (`r3`),
    counted by the GM when dnd5e.restCompleted fires (socket.js).
  Either way a count keyed on it rolls over when the party's day does,
  never on the server's clock, and the GM never resets anything by hand.

  A long rest ends the day in calendar mode too. dnd5e moves game.time for
  a rest only on a GM's client (its _rest: advanceTime && game.user.isGM),
  so a player's long rest from their own sheet leaves the clock where it
  was. The GM therefore keeps each character's own day: a long rest moves
  it to the day after the clock's day when the rest began (dayAfterRest;
  socket.js newDayFor, store.js restInto), and the character's day is the
  later of that and the clock's day (laterDay). So a long rest ends a day
  at once, and the clock catches up rather than counting again: when the
  GM moves it over the same night it lands on the day the rest already
  began. A GM's rest that moved the clock began a duration earlier, so it
  rests into the clock's new day and adds nothing. The borrow ahead of the
  clock is one day at most: a second long rest on the same calendar day
  (the GM's rest that left the clock on that day, then the player's own)
  finds the character's day already past the clock's and ends no further
  day, so the well never stays shut for nights the clock hasn't reached.
  (dnd5e allows one long rest in 24 hours; with the calendar off, where
  every long rest recovers daily uses, each one still ends a day.)
  One seam: a rest begun on a year's last day rests into a day past it
  (y1492d365), which the clock never names, so the clock's move into the
  new year is one more new day.
  The rest count (calendar off) and the day rested into (calendar on) are
  kept apart, so turning the calendar on or off never reads one as the
  other. Refunds never touch either: a refund marks its row, and the
  count of unrefunded rows on today's key drops by one.

  No Foundry globals: the caller passes game.time and dnd5e's calendar
  setting (store.js dayMode and todayKey), so Vitest can hand it anything.
  Null when the world has no way to tell a day at all, in which case
  nothing is counted per day.
*/
const SECONDS_PER_DAY = 86400;

/*
  A day as something that can be compared and stepped: { y, d } from the
  calendar's components (the year and the day of that year), or { t }
  from the seconds alone, for a world whose calendar isn't set up yet.
  Null when `time` tells no day.
*/
export function dayOf(time) {
  const c = time?.components;
  if (c && Number.isFinite(c.year) && Number.isFinite(c.day)) return { y: c.year, d: c.day };
  const seconds = Number(time?.worldTime);
  if (Number.isFinite(seconds)) return { t: Math.floor(seconds / SECONDS_PER_DAY) };
  return null;
}

const isYd = day => Number.isFinite(day?.y) && Number.isFinite(day?.d);
const isT = day => !isYd(day) && Number.isFinite(day?.t);

export function keyOfDay(day) {
  if (isYd(day)) return `y${day.y}d${day.d}`;
  if (isT(day)) return `t${day.t}`;
  return null;
}

export const dayKeyOf = time => keyOfDay(dayOf(time));

// The day after `day`, in the same shape.
export function nextDay(day) {
  if (isYd(day)) return { y: day.y, d: day.d + 1 };
  if (isT(day)) return { t: day.t + 1 };
  return null;
}

/*
  The later of two days. A day in the other shape (a rest noted before the
  world's calendar was set up) or no day at all says nothing: `a` stands.
*/
export function laterDay(a, b) {
  if (isYd(a) && isYd(b)) return b.y > a.y || (b.y === a.y && b.d > a.d) ? { y: b.y, d: b.d } : a;
  if (isT(a) && isT(b)) return b.t > a.t ? { t: b.t } : a;
  return a ?? null;
}

/*
  How this world tells a day: "calendar", "rest" (dnd5e's calendar is off),
  "manual" (the calendar is on but dnd5e's daily recovery is set to the
  rest dialog), or null (no calendar and no dnd5e rest to count). `config`
  is dnd5e's calendarConfig setting (a DataModel with manualRecovery, or
  its plain data), absent before dnd5e had one; `isDnd5e` says the system
  is dnd5e, whose long rest has a new day either way.

  The setting's shape says which dnd5e this is (docs/COMPATIBILITY.md):
  dnd5e 5.0 and 5.1 have no setting; 5.2 and 5.3 have only `enabled`,
  which shows the calendar but leaves daily uses to a long rest's new day
  whether it is on or off; dnd5e 6 adds dailyRecovery (and the
  manualRecovery getter), which is what can hand the day to the clock.
*/
const choosesRecovery = config => config.manualRecovery !== undefined || config.dailyRecovery !== undefined;

export function dayModeOf({ config = null, isDnd5e = false, time = null } = {}) {
  if (config && !choosesRecovery(config)) return config.enabled ? "manual" : "rest";
  if (config) {
    const manual = config.manualRecovery ?? (config.dailyRecovery === "manual" || (!config.dailyRecovery && !config.enabled));
    if (manual) return config.enabled ? "manual" : "rest";
  } else if (isDnd5e) return "rest";
  return dayKeyOf(time) != null ? "calendar" : null;
}

// A day that ends at each character's long rest rather than on the clock.
export const byRest = mode => mode === "rest" || mode === "manual";

// The character's own day after a long rest begun on `began` (the clock's
// day then), with `was` the day its last rest moved it to: the day after
// `began`, or `was` where that is already as late (a day borrowed ahead of
// the clock is not borrowed again, nor taken back). Null when the clock
// told no day.
export function dayAfterRest(began, was = null) {
  const next = nextDay(began);
  return next ? laterDay(next, was) : null;
}

/*
  Today's key for one character. With the calendar on it is the later of
  the clock's day and the day this character's last long rest rested into
  (`restedInto`, see the header); with it off, `r` and that character's
  count of new-day rests. Either way a long rest moves only the character
  who took it.
*/
export function dayKeyFor({ time = null, calendarOn = true, restDay = 0, restedInto = null } = {}) {
  if (calendarOn) return keyOfDay(laterDay(dayOf(time), restedInto));
  const n = Number(restDay);
  return `r${Number.isInteger(n) && n > 0 ? n : 0}`;
}

// The editor's line when a day ends at a long rest, said once beside the
// well's cap and a limit per day (well.js noClockNote, limits.js).
export function restDayNote(mode) {
  return mode === "manual"
    ? "dnd5e's daily recovery is manual: a day ends at each character's long rest."
    : "dnd5e's calendar is off: a day ends at each character's long rest.";
}
