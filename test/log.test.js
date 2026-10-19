/*
  The manager's pull log shows where a GM-set rarity came from, so a
  Legendary rope can be traced to the Uncommon one in the compendium.
*/
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

vi.mock("../module/scripts/shop.js", () => ({ refreshShop: vi.fn() }));
vi.mock("../module/scripts/chat.js", () => ({ postRefundCard: vi.fn() }));

let log = [];
let CrateManager, logRarityNote;
beforeAll(async () => {
  const escapeHTML = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  vi.stubGlobal("foundry", { utils: { escapeHTML, deepClone: v => structuredClone(v) }, applications: { api: { ApplicationV2: class {}, DialogV2: class {} } } });
  vi.stubGlobal("game", { settings: { get: (_m, key) => (key === "pullLog" ? log : {}) } });
  ({ CrateManager, logRarityNote } = await import("../module/scripts/manager.js"));
});
afterAll(() => vi.unstubAllGlobals());

const row = over => ({ id: "r1", at: 0, actorName: "Crate Tester", boxName: "Test Crate", price: 10, name: "Rope", rarity: "legendary", ...over });

describe("the pull log", () => {
  it("says a GM set the rarity, and what the source had", () => {
    log = [row({ sourceRarity: ["uncommon"] })];
    const html = new CrateManager()._log();
    expect(html).toContain("Legendary, set by GM (source Uncommon)");
    expect(html).toContain('class="lc-rarity-legendary"');
  });

  it("names every rarity of a multi-rarity source, and a source with none", () => {
    expect(logRarityNote(row({ rarity: "veryRare", sourceRarity: ["uncommon", "rare"] }))).toContain("Very rare, set by GM (source Uncommon or Rare)");
    expect(logRarityNote(row({ rarity: "rare", sourceRarity: [] }))).toContain("Rare, set by GM (source had none)");
  });

  it("adds nothing to a row drawn at its source's rarity, or one logged before this was recorded", () => {
    log = [row({ rarity: "uncommon" })];
    expect(new CrateManager()._log()).not.toContain("set by GM");
  });
});

describe("a refunded row", () => {
  it("strikes the name through and says when it was refunded", () => {
    const at = Date.UTC(2026, 9, 20, 3, 0);
    log = [row({ refunded: at, sourceRarity: ["uncommon"] })];
    const html = new CrateManager()._log();
    expect(html).toContain('class="lc-row--refunded"');
    expect(html).toContain("<s>Rope</s>");
    expect(html).toMatch(/refunded \S/);
    expect(html).not.toContain('data-action="refund"');
  });
});
