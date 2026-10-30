/*
  Delete on a Boxes row (manager.js #deleteBox, P13): a table game with a
  round not yet settled has that round called off first (table.js
  cancelRound: every open stake refunded) and only then is the game
  removed, so no stake waits in escrow for a game that can't be spun. The
  confirm, titled in the kind's own word, names how many stakes the round
  holds and their gold; the tab's status line says the refund once. A crate
  with no round deletes as before. A call-off that fails deletes nothing.
  Drives the real manager into a minimal DOM with the real store on a
  stubbed world setting, as boxprice.test.js; table.js is a stub that
  records the order of the calls.
*/
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { createDocument } from "./minidom.js";
import { SETTINGS } from "../module/scripts/core/config.js";

const calls = [];
vi.mock("../module/scripts/foundry/shop.js", () => ({ refreshShop: vi.fn(), openShop: vi.fn() }));
vi.mock("../module/scripts/foundry/chat.js", () => ({ postRefundCard: vi.fn() }));
vi.mock("../module/scripts/foundry/table.js", () => ({ cancelRound: vi.fn() }));
vi.mock("../module/scripts/foundry/store.js", async importOriginal => {
  const orig = await importOriginal();
  return {
    ...orig,
    checkSources: async entries => new Map(entries.map(e => [e.uuid, { name: e.name, img: e.img, rarity: e.rarity }])),
    sweepPools: async () => [],
    removeBox: vi.fn(id => { calls.push(["removeBox", id]); return orig.removeBox(id); }),
  };
});

// DialogV2.confirm as the test sees it: its title and content are kept,
// and it answers what the test says the GM pressed.
let confirms = [];
let answer = true;
class Dialog {
  static confirm(config) { confirms.push(config); return Promise.resolve(answer); }
}

class App {
  rendered = false;
  element = null;
  async render() {
    const root = await this._renderHTML();
    if (!this.element) { this.element = document.createElement("div"); document.body.appendChild(this.element); }
    this._replaceHTML(root, this.element);
    this.rendered = true;
    return this;
  }
  async close() {}
}

let settings;
const notifications = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let CrateManager, store, table, PullError;
beforeAll(async () => {
  vi.stubGlobal("document", createDocument());
  vi.stubGlobal("CSS", { escape: s => String(s) });
  vi.stubGlobal("ui", { notifications });
  vi.stubGlobal("foundry", {
    utils: { escapeHTML: s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"), deepClone: v => structuredClone(v), randomID: n => Math.random().toString(36).slice(2, 2 + (n ?? 10)) },
    applications: { api: { ApplicationV2: App, DialogV2: Dialog } },
  });
  vi.stubGlobal("game", { user: { isGM: true }, settings: {
    register: (_m, key, cfg) => settings.set(key, cfg.default),
    get: (_m, key) => settings.get(key),
    set: async (_m, key, v) => { await new Promise(r => setTimeout(r, 1)); settings.set(key, structuredClone(v)); },
  } });
  store = await import("../module/scripts/foundry/store.js");
  table = await import("../module/scripts/foundry/table.js");
  ({ PullError } = await import("../module/scripts/games/kinds.js"));
  ({ CrateManager } = await import("../module/scripts/foundry/manager.js"));
});
afterAll(() => vi.unstubAllGlobals());

const CRATE = { id: "c1", name: "Goblin Crate", price: 12, pools: [], weights: {}, rules: {} };
const WHEEL = { id: "w1", kind: "roulette", name: "Wheel of Fate", price: 5, pools: [], roulette: { maxStake: 50 } };
const ROUND = { id: "R1", boxId: "w1", kind: "roulette", status: "open", opensAt: 1, closesAt: null };
const stake = (id, price, extra = {}) => ({ id, kind: "roulette", boxId: "w1", boxName: "Wheel of Fate", roundId: "R1", status: "open", actorId: `a${id}`, actorName: `Char ${id}`, price, ...extra });

beforeEach(async () => {
  settings = new Map();
  store.registerSettings();
  for (const b of [CRATE, WHEEL]) await store.saveBox(structuredClone(b));
  confirms = [];
  answer = true;
  calls.length = 0;
  store.removeBox.mockClear();
  table.cancelRound.mockReset();
  table.cancelRound.mockImplementation(async id => { calls.push(["cancelRound", id]); return { status: "cancelled", refunded: 3, gone: 0 }; });
  for (const fn of Object.values(notifications)) fn.mockClear();
  document.body.replaceChildren();
  document.activeElement = document.body;
});

async function withRound(rows) {
  await globalThis.game.settings.set("loot-crates", SETTINGS.ROUNDS, { R1: ROUND });
  await globalThis.game.settings.set("loot-crates", SETTINGS.LOG, rows);
}
async function manager() {
  const app = new CrateManager();
  app.tab = "boxes";
  await app.render();
  return app;
}
// The row's real Delete, pressed: the button the GM clicks, its action.
async function pressDelete(app, id) {
  const button = app.element.querySelector(`button[data-action="deleteBox"][data-box="${id}"]`);
  expect(button).toBeTruthy();
  await CrateManager.DEFAULT_OPTIONS.actions.deleteBox.call(app, {}, button);
  return button;
}
const status = app => app.element.querySelector(".lc-manager__status");

describe("Delete on a table game with a live round", () => {
  it("names the round's stakes and gold in the confirm, titled in the kind's word", async () => {
    await withRound([stake("1", 10), stake("2", 20), stake("3", 5), stake("h", 0, { house: true }), stake("4", 50, { refunded: 1 })]);
    answer = false;
    const app = await manager();
    await pressDelete(app, "w1");
    expect(confirms).toHaveLength(1);
    expect(confirms[0].window.title).toBe("Delete Roulette wheel");
    expect(confirms[0].content).toBe("<p>Delete <strong>Wheel of Fate</strong>? Its round still holds 3 stakes (35 gp); they are refunded first.</p>");
    // No: nothing is called off and nothing is deleted.
    expect(table.cancelRound).not.toHaveBeenCalled();
    expect(store.removeBox).not.toHaveBeenCalled();
    expect(store.getBoxes().w1).toBeTruthy();
  });

  it("calls the round off before the game is removed, and says the refund once in the status line", async () => {
    await withRound([stake("1", 10), stake("2", 20), stake("3", 5)]);
    const app = await manager();
    await pressDelete(app, "w1");
    expect(calls).toEqual([["cancelRound", "R1"], ["removeBox", "w1"]]);
    expect(store.getBoxes().w1).toBeUndefined();
    expect(status(app).textContent).toBe("Deleted Wheel of Fate. Its round was called off: 3 stakes were refunded.");
    expect(notifications.warn).not.toHaveBeenCalled();
  });

  it("calls off a live round with no stakes yet too", async () => {
    await withRound([]);
    table.cancelRound.mockImplementation(async id => { calls.push(["cancelRound", id]); return { status: "cancelled", refunded: 0, gone: 0 }; });
    const app = await manager();
    await pressDelete(app, "w1");
    expect(confirms[0].content).toBe("<p>Delete <strong>Wheel of Fate</strong>? Its round is still open, with no stakes yet; it is called off first.</p>");
    expect(calls).toEqual([["cancelRound", "R1"], ["removeBox", "w1"]]);
    expect(status(app).textContent).toBe("Deleted Wheel of Fate. Its round was called off.");
  });

  it("keeps the game when the round can't be called off, and says why", async () => {
    await withRound([stake("1", 10)]);
    table.cancelRound.mockRejectedValue(new PullError("Only the GM running the game can do that."));
    const app = await manager();
    const button = await pressDelete(app, "w1");
    expect(store.removeBox).not.toHaveBeenCalled();
    expect(store.getBoxes().w1).toBeTruthy();
    expect(notifications.warn).toHaveBeenCalledWith("Only the GM running the game can do that. Wheel of Fate was not deleted.");
    expect(document.activeElement).toBe(button);
  });
});

describe("Delete on a game with no round", () => {
  it("asks only the name and removes it, as before", async () => {
    const app = await manager();
    await pressDelete(app, "c1");
    expect(confirms[0].window.title).toBe("Delete crate");
    expect(confirms[0].content).toBe("<p>Delete <strong>Goblin Crate</strong>?</p>");
    expect(table.cancelRound).not.toHaveBeenCalled();
    expect(calls).toEqual([["removeBox", "c1"]]);
    expect(store.getBoxes().c1).toBeUndefined();
    expect(status(app).textContent).toBe("Deleted Goblin Crate.");
  });

  it("asks only the name for a wheel whose last round has resolved", async () => {
    await globalThis.game.settings.set("loot-crates", SETTINGS.ROUNDS, { R1: { ...ROUND, status: "resolved", resolvedAt: 2 } });
    const app = await manager();
    await pressDelete(app, "w1");
    expect(confirms[0].content).toBe("<p>Delete <strong>Wheel of Fate</strong>?</p>");
    expect(table.cancelRound).not.toHaveBeenCalled();
    expect(calls).toEqual([["removeBox", "w1"]]);
  });
});
