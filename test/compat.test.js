/*
  The fallbacks docs/COMPATIBILITY.md names, one test each: what the module
  does where Foundry v13 or dnd5e 5 differs from the v14 / dnd5e 6 it is
  tested on live. The shapes here are read from v13's API docs and dnd5e
  5.x's source (the links are in the doc); none of it ran on v13.
*/
import { describe, it, expect, afterEach, vi } from "vitest";
import { createDocument } from "./minidom.js";
import { entryIdOf, directoryMenuEntry } from "../module/scripts/route.js";
import { dayModeOf, byRest } from "../module/scripts/clock.js";
import { rawRarityOf, normalizeRarity } from "../module/scripts/odds.js";
import { STARTER_POOLS, STARTER_PACKS, starterPackPlan, takesRow, entryOfRow } from "../module/scripts/starter.js";
import { settle, isWholeCoins } from "../module/scripts/currency.js";

const { registerSettings, registerIndexFields, dayMode, RARITY_FIELDS } = await import("../module/scripts/store.js");
const { starterPlan } = await import("../module/scripts/starterbuild.js");

afterEach(() => vi.unstubAllGlobals());

// A Roll Tables directory entry, as both versions draw it.
function directoryEntry(id) {
  const document = createDocument();
  const li = document.createElement("li");
  li.setAttribute("data-entry-id", id);
  const name = document.createElement("a");
  li.appendChild(name);
  document.body.appendChild(li);
  return { li, name };
}

describe("the Roll Tables menu entry (getRollTableContextOptions)", () => {
  const made = () => {
    const runs = [];
    const entry = directoryMenuEntry({ label: "Make a crate", icon: "<i></i>", visible: () => true, run: id => runs.push(id) });
    return { entry, runs };
  };

  it("carries v14's label, visible and onClick(event, li), and v13's name, condition and callback(li)", () => {
    const { entry } = made();
    expect(entry.label).toBe("Make a crate");
    expect(entry.name).toBe("Make a crate");
    expect(entry.icon).toBe("<i></i>");
    expect(entry.visible).toBe(entry.condition);
    expect(typeof entry.onClick).toBe("function");
    expect(typeof entry.callback).toBe("function");
  });

  it("v14: onClick(event, li) with the entry's element runs on that table", () => {
    const { entry, runs } = made();
    entry.onClick({ type: "click" }, directoryEntry("t14").li);
    expect(runs).toEqual(["t14"]);
  });

  it("v13: callback(li) with the element, or a jQuery object around it, runs on that table", () => {
    const { entry, runs } = made();
    entry.callback(directoryEntry("t13").li);
    entry.callback([directoryEntry("tjq").li]);
    expect(runs).toEqual(["t13", "tjq"]);
  });

  it("finds the entry's id from a child the menu was opened on, and does nothing without one", () => {
    const { entry, runs } = made();
    expect(entryIdOf(directoryEntry("child").name)).toBe("child");
    expect(entryIdOf(null)).toBeNull();
    entry.callback(null);
    entry.onClick({}, createDocument().createElement("li"));
    expect(runs).toEqual([]);
  });

  it("asks the caller whether it shows, in either version's key", () => {
    let gm = false;
    const entry = directoryMenuEntry({ label: "x", visible: () => gm });
    expect([entry.visible(), entry.condition()]).toEqual([false, false]);
    gm = true;
    expect([entry.visible(), entry.condition()]).toEqual([true, true]);
  });
});

describe("rarity (dnd5e 5's system.rarity, dnd5e 6's system.rarities)", () => {
  it("reads dnd5e 5's string and dnd5e 6's set to the same key", () => {
    expect(normalizeRarity(rawRarityOf({ rarity: "veryRare" }))).toBe("veryRare");
    expect(normalizeRarity(rawRarityOf({ rarities: ["veryRare"] }))).toBe("veryRare");
    expect(normalizeRarity(rawRarityOf({ rarities: new Set(["veryRare"]) }))).toBe("veryRare");
  });

  it("asks a compendium index for both fields, so a dnd5e 5 pack's rows carry a rarity", () => {
    expect(RARITY_FIELDS).toEqual(["system.rarities", "system.rarity"]);
  });

  it("fills a starter pool from a dnd5e 5 index row, which has only system.rarity", () => {
    const potions = STARTER_POOLS.find(p => p.key === "potions");
    const row = { _id: "p1", name: "Potion of Healing", type: "consumable", img: "p.webp", system: { rarity: "common", type: { value: "potion" } } };
    expect(takesRow(potions, row)).toBe(true);
    expect(entryOfRow("dnd5e.items", row)).toMatchObject({ uuid: "Compendium.dnd5e.items.Item.p1", rarity: "common", sourceRarity: "common" });
  });

  it("leaves Foundry's index fields alone when CONFIG has no list to add to", () => {
    vi.stubGlobal("CONFIG", { Item: {} });
    expect(() => registerIndexFields()).not.toThrow();
    vi.stubGlobal("CONFIG", undefined);
    expect(() => registerIndexFields()).not.toThrow();
  });
});

describe("the starter crates' packs", () => {
  // dnd5e 5.0.0's system.json, its Item packs (release-5.0.0).
  const DND5E_500 = ["items", "tradegoods", "spells", "backgrounds", "classes", "subclasses", "classfeatures", "races", "monsterfeatures", "classes24", "origins24", "feats24", "spells24", "equipment24"];

  it("dnd5e 5.0.0 lists both packs the set reads", () => {
    for (const p of STARTER_PACKS) expect(DND5E_500).toContain(p.name);
    expect(starterPackPlan({ listed: DND5E_500, rules: "legacy" })).toEqual({ packs: ["dnd5e.items", "dnd5e.equipment24"], notes: [] });
  });

  it("a dnd5e without equipment24 builds from items alone, without a word", () => {
    expect(starterPackPlan({ listed: DND5E_500.filter(n => n !== "equipment24") })).toEqual({ packs: ["dnd5e.items"], notes: [] });
  });

  it("reads the 2024 pack first when dnd5e's rulesVersion setting can't be read", () => {
    vi.stubGlobal("game", {
      system: { id: "dnd5e", packs: new Set(DND5E_500.map(name => ({ name }))) },
      packs: new Map([["dnd5e.items", {}], ["dnd5e.equipment24", {}]]),
      settings: { get: () => { throw new Error("dnd5e.rulesVersion is not registered"); } },
    });
    expect(starterPlan().packs).toEqual(["dnd5e.equipment24", "dnd5e.items"]);
  });
});

describe("the day (dnd5e's calendarConfig setting)", () => {
  const TIME = { components: { year: 1492, day: 207 }, worldTime: 1 };

  function world(calendar) {
    const settings = new Map();
    vi.stubGlobal("foundry", { utils: { deepClone: v => structuredClone(v) } });
    vi.stubGlobal("game", {
      time: TIME, system: { id: "dnd5e" },
      settings: {
        register: (ns, key, { default: def }) => settings.set(`${ns}.${key}`, def),
        get: (ns, key) => { if (!settings.has(`${ns}.${key}`)) throw new Error(`${ns}.${key} is not registered`); return settings.get(`${ns}.${key}`); },
        set: async (ns, key, value) => settings.set(`${ns}.${key}`, value),
      },
    });
    if (calendar !== undefined) settings.set("dnd5e.calendarConfig", calendar);
    registerSettings();
  }

  it("dnd5e 5.0 and 5.1 have no setting: a day ends at each long rest", () => {
    world();
    expect(dayMode()).toBe("rest");
  });

  it("dnd5e 5.2 and 5.3 have only `enabled`: a day ends at each long rest with the calendar off or on", () => {
    world({ enabled: false });
    expect(dayMode()).toBe("rest");
    world({ enabled: true });
    expect(dayMode()).toBe("manual");
    expect(byRest(dayModeOf({ config: { enabled: true }, isDnd5e: true, time: TIME }))).toBe(true);
  });

  it("dnd5e 6's dailyRecovery still decides as before", () => {
    expect(dayModeOf({ config: { enabled: true, dailyRecovery: "" }, time: TIME })).toBe("calendar");
    expect(dayModeOf({ config: { enabled: false, dailyRecovery: "" }, time: TIME })).toBe("rest");
    expect(dayModeOf({ config: { enabled: true, dailyRecovery: "manual" }, time: TIME })).toBe("manual");
    expect(dayModeOf({ config: { enabled: true, manualRecovery: false }, time: TIME })).toBe("calendar");
  });
});

describe("coins (dnd5e 5's currency fields are integers)", () => {
  it("every settle writes whole coins, so dnd5e 5's integer fields accept the purse", () => {
    const purses = [{ gp: 0 }, { gp: 3, sp: 7, cp: 9 }, { pp: 2, ep: 1, gp: 0, sp: 0, cp: 0 }, { gp: 1000 }, { gp: 12.5, sp: 3 }];
    const moves = [-1, -5, -55, -1250, -10000, 1, 5, 99, 1234, 0];
    for (const purse of purses) {
      for (const cp of moves) {
        const next = settle(purse, cp);
        if (next) expect(isWholeCoins(next), `${JSON.stringify(purse)} ${cp}`).toBe(true);
      }
    }
  });
});
