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

  No Foundry globals: the caller passes game.time and dnd5e's calendar
  setting (store.js dayMode and todayKey), so Vitest can hand it anything.
  Null when the world has no way to tell a day at all, in which case
  nothing is counted per day.
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

/*
  How this world tells a day: "calendar", "rest" (dnd5e's calendar is off),
  "manual" (the calendar is on but dnd5e's daily recovery is set to the
  rest dialog), or null (no calendar and no dnd5e rest to count). `config`
  is dnd5e's calendarConfig setting (a DataModel with manualRecovery, or
  its plain data), absent before dnd5e had one; `isDnd5e` says the system
  is dnd5e, whose long rest has a new day either way.
*/
export function dayModeOf({ config = null, isDnd5e = false, time = null } = {}) {
  if (config) {
    const manual = config.manualRecovery ?? (config.dailyRecovery === "manual" || (!config.dailyRecovery && !config.enabled));
    if (manual) return config.enabled ? "manual" : "rest";
  } else if (isDnd5e) return "rest";
  return dayKeyOf(time) != null ? "calendar" : null;
}

// A day that ends at each character's long rest rather than on the clock.
export const byRest = mode => mode === "rest" || mode === "manual";

/*
  Today's key for one character. With the calendar on it is the clock's
  day (dayKeyOf); with it off, `r` and that character's count of new-day
  rests, so a long rest moves only the character who took it.
*/
export function dayKeyFor({ time = null, calendarOn = true, restDay = 0 } = {}) {
  if (calendarOn) return dayKeyOf(time);
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
