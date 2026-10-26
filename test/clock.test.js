/*
  How a world tells its in-game day (clock.js): from the clock with dnd5e's
  calendar on, at each character's long rest with it off (dnd5e 6's
  default), the way dnd5e recovers daily uses; the rest count kept by
  store.js; and the editors' notes for both.
*/
import { describe, it, expect, afterEach } from "vitest";

const { dayKeyOf, dayKeyFor, dayModeOf, byRest, restDayNote, dayOf, keyOfDay, nextDay, laterDay, dayAfterRest } = await import("../module/scripts/core/clock.js");
const { registerSettings, todayKey, dayMode, countRest, restDayOf, restInto, restedIntoOf, dayAt } = await import("../module/scripts/foundry/store.js");
const { noClockNote } = await import("../module/scripts/games/well.js");
const { limitsFieldset } = await import("../module/scripts/core/limits.js");

const tick = () => new Promise(r => setTimeout(r, 0));
const TIME = { components: { year: 1492, day: 207 }, worldTime: 1 };

function world({ calendar, system = "dnd5e", time = TIME } = {}) {
  const settings = new Map();
  const game = {
    time, system: { id: system },
    settings: {
      register: (ns, key, { default: def }) => settings.set(`${ns}.${key}`, def),
      get: (ns, key) => { if (!settings.has(`${ns}.${key}`)) throw new Error(`${ns}.${key} is not registered`); return settings.get(`${ns}.${key}`); },
      async set(ns, key, value) { await tick(); settings.set(`${ns}.${key}`, value); },
    },
  };
  if (calendar !== undefined) settings.set("dnd5e.calendarConfig", calendar);
  globalThis.game = game;
  globalThis.foundry = { utils: { randomID: n => Math.random().toString(36).slice(2, 2 + n), deepClone: v => structuredClone(v) } };
  registerSettings();
  return game;
}
afterEach(() => { delete globalThis.game; delete globalThis.foundry; });

describe("the day's key", () => {
  it("is the clock's day with the calendar on, and the character's count of new-day rests with it off", () => {
    expect(dayKeyFor({ time: TIME, calendarOn: true, restDay: 4 })).toBe("y1492d207");
    expect(dayKeyFor({ time: TIME, calendarOn: true })).toBe(dayKeyOf(TIME));
    expect(dayKeyFor({ time: null, calendarOn: true })).toBeNull();
    expect(dayKeyFor({ time: TIME, calendarOn: false, restDay: 0 })).toBe("r0");
    expect(dayKeyFor({ time: TIME, calendarOn: false, restDay: 1 })).toBe("r1");
    // No clock is needed for a day that ends at a rest; a bad count is day 0.
    expect(dayKeyFor({ time: null, calendarOn: false })).toBe("r0");
    expect(dayKeyFor({ calendarOn: false, restDay: -2 })).toBe("r0");
    expect(dayKeyFor({ calendarOn: false, restDay: "x" })).toBe("r0");
  });

  it("follows dnd5e's own test for daily recovery", () => {
    // dnd5e 6's default: calendar off, no recovery chosen.
    expect(dayModeOf({ config: { enabled: false, dailyRecovery: "" }, time: TIME })).toBe("rest");
    expect(dayModeOf({ config: { enabled: true, dailyRecovery: "" }, time: TIME })).toBe("calendar");
    expect(dayModeOf({ config: { enabled: true, dailyRecovery: "manual" }, time: TIME })).toBe("manual");
    expect(dayModeOf({ config: { enabled: false, dailyRecovery: "calendar" }, time: TIME })).toBe("calendar");
    // The setting's DataModel answers manualRecovery itself.
    expect(dayModeOf({ config: { enabled: true, manualRecovery: true }, time: TIME })).toBe("manual");
    expect(dayModeOf({ config: { enabled: false, manualRecovery: false }, time: TIME })).toBe("calendar");
    // A dnd5e with no calendar setting yet recovers daily uses at a long rest.
    expect(dayModeOf({ config: null, isDnd5e: true, time: TIME })).toBe("rest");
    // Not dnd5e: the clock, or nothing at all.
    expect(dayModeOf({ time: TIME })).toBe("calendar");
    expect(dayModeOf({ time: null })).toBeNull();
    expect([byRest("rest"), byRest("manual"), byRest("calendar"), byRest(null)]).toEqual([true, true, false, false]);
  });

  it("reads r0, then r1 after one counted rest, for that character only, with the calendar off", async () => {
    world({ calendar: { enabled: false, dailyRecovery: "" } });
    expect(dayMode()).toBe("rest");
    expect(todayKey("a1")).toBe("r0");
    await expect(countRest("a1")).resolves.toBe(1);
    expect(todayKey("a1")).toBe("r1");
    expect(restDayOf("a1")).toBe(1);
    expect(todayKey("a2")).toBe("r0");
    expect(globalThis.game.settings.get("loot-crates", "actorState")).toEqual({ days: { a1: 1 } });
  });

  it("reads the clock with the calendar on, whatever was counted, and with no setting outside dnd5e", async () => {
    const game = world({ calendar: { enabled: true, dailyRecovery: "" } });
    await countRest("a1");
    expect(todayKey("a1")).toBe("y1492d207");
    game.settings.get = () => { throw new Error("not registered"); };
    game.system.id = "pf2e";
    expect(dayMode()).toBe("calendar");
  });

  it("keeps a pull's actor state beside the count", async () => {
    const game = world({ calendar: { enabled: false } });
    await game.settings.set("loot-crates", "actorState", { "a1.box": { pulls: 2 } });
    await countRest("a1");
    await countRest("a1");
    expect(game.settings.get("loot-crates", "actorState")).toEqual({ "a1.box": { pulls: 2 }, days: { a1: 2 } });
  });
});

describe("a long rest with the calendar on", () => {
  it("reads a day from the clock's components, else its seconds, and steps and compares days of one shape", () => {
    expect(dayOf(TIME)).toEqual({ y: 1492, d: 207 });
    expect(dayOf({ worldTime: 86400 * 3 + 5 })).toEqual({ t: 3 });
    expect(dayOf(null)).toBeNull();
    expect(keyOfDay({ y: 1, d: 2 })).toBe("y1d2");
    expect(keyOfDay({ t: 9 })).toBe("t9");
    expect(keyOfDay({})).toBeNull();
    expect(nextDay({ y: 1, d: 364 })).toEqual({ y: 1, d: 365 });
    expect(nextDay({ t: 9 })).toEqual({ t: 10 });
    expect(laterDay({ y: 1, d: 5 }, { y: 1, d: 6 })).toEqual({ y: 1, d: 6 });
    expect(laterDay({ y: 2, d: 0 }, { y: 1, d: 365 })).toEqual({ y: 2, d: 0 });
    expect(laterDay({ t: 4 }, { t: 3 })).toEqual({ t: 4 });
    // Another shape, or none, says nothing.
    expect(laterDay({ y: 1, d: 5 }, { t: 99 })).toEqual({ y: 1, d: 5 });
    expect(laterDay({ y: 1, d: 5 }, null)).toEqual({ y: 1, d: 5 });
  });

  it("keys today on the later of the clock's day and the day the rest rested into", () => {
    expect(dayKeyFor({ time: TIME, calendarOn: true, restedInto: { y: 1492, d: 208 } })).toBe("y1492d208");
    // The clock caught up, or passed it: the clock's day.
    expect(dayKeyFor({ time: TIME, calendarOn: true, restedInto: { y: 1492, d: 207 } })).toBe("y1492d207");
    expect(dayKeyFor({ time: TIME, calendarOn: true, restedInto: { y: 1492, d: 100 } })).toBe("y1492d207");
    // The rest count of calendar-off mode never reaches the calendar's key.
    expect(dayKeyFor({ time: TIME, calendarOn: true, restDay: 4, restedInto: null })).toBe("y1492d207");
    expect(dayKeyFor({ time: TIME, calendarOn: false, restDay: 2, restedInto: { y: 1492, d: 300 } })).toBe("r2");
  });

  it("moves the character's own day to the day after the clock's, borrowing one day ahead of it at most", () => {
    expect(dayAfterRest({ y: 1, d: 5 })).toEqual({ y: 1, d: 6 });
    // Already a day ahead of the clock: a second rest that day ends no further day.
    expect(dayAfterRest({ y: 1, d: 5 }, { y: 1, d: 6 })).toEqual({ y: 1, d: 6 });
    // A day borrowed further ahead (noted before the cap) stays; it is never taken back.
    expect(dayAfterRest({ y: 1, d: 5 }, { y: 1, d: 8 })).toEqual({ y: 1, d: 8 });
    // The clock has caught up with the character's day: one more.
    expect(dayAfterRest({ y: 1, d: 6 }, { y: 1, d: 6 })).toEqual({ y: 1, d: 7 });
    // The clock has passed the character's day: from the clock's.
    expect(dayAfterRest({ y: 1, d: 9 }, { y: 1, d: 6 })).toEqual({ y: 1, d: 10 });
    expect(dayAfterRest({ y: 1, d: 365 }, { y: 1, d: 6 })).toEqual({ y: 1, d: 366 });
    expect(dayAfterRest({ t: 3 }, { y: 1, d: 6 })).toEqual({ t: 4 });
    expect(dayAfterRest(null, { y: 1, d: 6 })).toBeNull();
  });

  it("ends a day at a long rest on the GM, once per calendar day, the clock catching up without another, and leaves the counts and actor state alone", async () => {
    const game = world({ calendar: { enabled: true, dailyRecovery: "" } });
    await game.settings.set("loot-crates", "actorState", { "a1.box": { pulls: 2 }, days: { a1: 3 } });
    await expect(restInto("a1", { y: 1492, d: 207 })).resolves.toBe("y1492d208");
    // A second rest with the clock still on 207: no further day.
    await expect(restInto("a1", { y: 1492, d: 207 })).resolves.toBe("y1492d208");
    expect(restedIntoOf("a1")).toEqual({ y: 1492, d: 208 });
    expect(todayKey("a2")).toBe("y1492d207");
    // The clock catches up to 208 without a new day.
    game.time = { components: { year: 1492, day: 208 }, worldTime: 2 };
    expect(todayKey("a1")).toBe("y1492d208");
    // A rest on the clock's next day moves on.
    await expect(restInto("a1", { y: 1492, d: 208 })).resolves.toBe("y1492d209");
    game.time = { components: { year: 1492, day: 210 }, worldTime: 3 };
    expect(todayKey("a1")).toBe("y1492d210");
    expect(game.settings.get("loot-crates", "actorState")).toEqual({ "a1.box": { pulls: 2 }, days: { a1: 3 }, restedInto: { a1: { y: 1492, d: 209 } } });
  });

  it("reads a past moment's day through the world's calendar, and now's from the clock", () => {
    const game = world({ calendar: { enabled: true, dailyRecovery: "" }, time: { worldTime: 86400 * 10, components: { year: 3, day: 10 }, calendar: { timeToComponents: s => ({ year: 3, day: Math.floor(s / 86400) }) } } });
    expect(dayAt(86400 * 10)).toEqual({ y: 3, d: 10 });
    expect(dayAt(86400 * 9.5)).toEqual({ y: 3, d: 9 });
    game.time.calendar = null;
    expect(dayAt(86400 * 9.5)).toEqual({ t: 9 });
  });
});

describe("the editors' notes about the day", () => {
  const REST = "dnd5e's calendar is off: a day ends at each character's long rest.";
  it("says a day ends at a long rest beside the well's cap with the calendar off, and keeps the warning only for a world with no day", () => {
    expect(restDayNote("rest")).toBe(REST);
    expect(restDayNote("manual")).toBe("dnd5e's daily recovery is manual: a day ends at each character's long rest.");
    expect(noClockNote({ day: "rest", hasClock: true, cap: 3 })).toBe(`<p class="lc-form__hint">${REST}</p>`);
    expect(noClockNote({ day: "calendar", hasClock: true, cap: 3 })).toBe("");
    expect(noClockNote({ day: null, hasClock: false, cap: 3 })).toBe('<p class="lc-form__hint lc-form__hint--warn">No calendar: the daily cap will not apply.</p>');
  });

  it("says the same in a game's Limits, and names the calendar only when it is the day", () => {
    const game = { id: "d", rules: { perCharacter: { max: 2, per: "day" } } };
    const rest = limitsFieldset(game, { stock: false, hasClock: true, day: "rest" });
    expect(rest).toContain(`<p class="lc-form__hint">${REST}</p>`);
    expect(rest).toContain("so a refund gives the purchase back.</p>");
    expect(rest).not.toContain("world's calendar");
    expect(rest).not.toContain("--warn");
    const calendar = limitsFieldset(game, { stock: false, hasClock: true, day: "calendar" });
    expect(calendar).toContain("so a refund gives the purchase back; a day ends on the world's calendar or at the character's long rest.</p>");
    expect(limitsFieldset(game, { stock: false, hasClock: false, day: null })).toContain("No calendar: a limit per day will not apply.");
  });
});
