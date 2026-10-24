/*
  How a world tells its in-game day (clock.js): from the clock with dnd5e's
  calendar on, at each character's long rest with it off (dnd5e 6's
  default), the way dnd5e recovers daily uses; the rest count kept by
  store.js; and the editors' notes for both.
*/
import { describe, it, expect, afterEach } from "vitest";

const { dayKeyOf, dayKeyFor, dayModeOf, byRest, restDayNote } = await import("../module/scripts/clock.js");
const { registerSettings, todayKey, dayMode, countRest, restDayOf } = await import("../module/scripts/store.js");
const { noClockNote } = await import("../module/scripts/well.js");
const { limitsFieldset } = await import("../module/scripts/limits.js");

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
    expect(calendar).toContain("so a refund gives the purchase back; a day is the world's calendar.</p>");
    expect(calendar).not.toContain("long rest");
    expect(limitsFieldset(game, { stock: false, hasClock: false, day: null })).toContain("No calendar: a limit per day will not apply.");
  });
});
