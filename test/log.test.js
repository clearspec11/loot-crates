/*
  The manager's pull log shows where a GM-set rarity came from, so a
  Legendary rope can be traced to the Uncommon one in the compendium.
*/
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

vi.mock("../module/scripts/foundry/shop.js", () => ({ refreshShop: vi.fn() }));
vi.mock("../module/scripts/foundry/chat.js", () => ({ postRefundCard: vi.fn() }));

let log = [];
let CrateManager, logRarityNote;
beforeAll(async () => {
  const escapeHTML = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  vi.stubGlobal("foundry", { utils: { escapeHTML, deepClone: v => structuredClone(v) }, applications: { api: { ApplicationV2: class {}, DialogV2: class {} } } });
  vi.stubGlobal("game", { settings: { get: (_m, key) => (key === "pullLog" ? log : {}) } });
  ({ CrateManager, logRarityNote } = await import("../module/scripts/foundry/manager.js"));
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

describe("a row its buyer called off after the charge", () => {
  it("is marked, with the Refund still there", () => {
    log = [row({ lateCancel: 1 })];
    const html = new CrateManager()._log();
    expect(html).toContain('class="lc-row--late"');
    expect(html).toContain("Called off by the buyer after the charge. Refund it if the table agrees.");
    expect(html).toContain('data-action="refund"');
  });

  it("drops the mark once refunded", () => {
    log = [row({ lateCancel: 1, refunded: 2 })];
    const html = new CrateManager()._log();
    expect(html).toContain('class="lc-row--refunded"');
    expect(html).not.toContain("Called off by the buyer");
  });
});

/*
  A well's misses (well.js) fold into one line per character and day with a
  Refund that gives the newest throw back; "Hide misses" leaves the rest.
*/
describe("a well's throws that gave nothing", () => {
  const miss = (id, at, over = {}) => ({ id, at, kind: "well", outcome: "nothing", boxId: "well", boxName: "Wishing Well", actorId: "a1", actorName: "Brinn", day: "y1d7", price: 0.1, name: "Nothing", ...over });

  it("fold into one row naming the count, whose Refund one gives back the newest throw", () => {
    log = [miss("n1", 30), miss("n2", 20), row({ id: "c1", at: 10 }), miss("n3", 5, { day: "y1d6" })];
    const html = new CrateManager()._log();
    expect(html).toContain('class="lc-row--group"');
    expect(html).toContain("2 throws, nothing");
    expect(html).toContain("1 throw, nothing");
    expect(html).toContain('data-action="refund" data-row="n1" aria-label="Refund one of 2 throws">Refund one</button>');
    expect(html).toContain('data-action="refund" data-row="n3" aria-label="Refund the throw">Refund</button>');
    expect(html).not.toContain('data-row="n2"');
    expect(html).toContain("Rope");
    expect(html).toContain("Wishing Well (1 sp)");
    expect(html).toContain('class="lc-switch" data-action="toggleMisses" aria-pressed="false">Hide misses</button>');
    expect(html).toContain("3 throws that gave nothing, folded by day");
    expect((html.match(/<tr class=/g) ?? []).length).toBe(3);
  });

  it("a refunded group reads as withdrawn, and Hide misses leaves only the pulls that gave something", () => {
    log = [miss("n1", 30, { refunded: 40 }), miss("n2", 20), row({ id: "c1", at: 10 })];
    const app = new CrateManager();
    let html = app._log();
    expect(html).toContain('class="lc-row--group lc-row--refunded"');
    expect(html).toContain("<s>1 throw, nothing</s>");
    expect(html).toContain('data-row="n1">refunded');
    app.hideMisses = true;
    html = app._log();
    expect(html).not.toContain("throw, nothing");
    expect(html).toContain("Rope");
    // One label; the pressed state says the misses are hidden.
    expect(html).toContain('aria-pressed="true">Hide misses</button>');
    expect(html).toContain("2 throws that gave nothing hidden");
    log = [miss("n2", 20)];
    expect(app._log()).toContain("Only misses so far; show them with the button above.");
  });

  it("folds a crate's Nothing pulls by the same rule, in its own word, and hides them with the well's", () => {
    const nothing = (id, at, over = {}) => ({ id, at, kind: "crate", outcome: "nothing", boxId: "goblin", boxName: "Goblin's Pockets", actorId: "a1", actorName: "Brinn", day: "y1d7", price: 2, name: "Nothing", itemId: null, ...over });
    log = [nothing("p1", 40), miss("n1", 30), nothing("p2", 25), row({ id: "c1", at: 10 }), nothing("p3", 5, { day: "y1d6" })];
    const app = new CrateManager();
    let html = app._log();
    expect(html).toContain("2 pulls, nothing");
    expect(html).toContain("1 pull, nothing");
    expect(html).toContain("1 throw, nothing");
    expect(html).toContain('data-action="refund" data-row="p1" aria-label="Refund one of 2 pulls">Refund one</button>');
    expect(html).toContain('data-action="refund" data-row="p3" aria-label="Refund the pull">Refund</button>');
    expect(html).not.toContain('data-row="p2"');
    expect(html).toContain("3 pulls and 1 throw that gave nothing, folded by day");
    expect((html.match(/<tr class=/g) ?? []).length).toBe(4);
    app.hideMisses = true;
    html = app._log();
    expect(html).not.toContain(", nothing");
    expect(html).toContain("Rope");
    expect(html).toContain("3 pulls and 1 throw that gave nothing hidden");
  });

  it("leaves a crate's log exactly as it was: no toolbar, no groups", () => {
    log = [row({ id: "r1" }), row({ id: "r2", refunded: 5 })];
    const html = new CrateManager()._log();
    expect(html).not.toContain("toggleMisses");
    expect(html).not.toContain("lc-row--group");
    expect(html.startsWith("<table")).toBe(true);
  });
});
