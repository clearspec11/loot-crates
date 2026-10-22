/*
  The manager's Boxes tab follows the pull log while a deck is on it: a
  deck's row reads its cards drawn and its odds from the log (deck.js
  deckOdds, deckRulesText), so a draw or a refund on any client redraws
  that row there and then, not when the tab is next opened. Without a deck
  a log change leaves the tab alone (a crate's row reads nothing from the
  log). Drives the real manager and the real redraw batching (redraw.js),
  the Boxes tab rendered into a minimal DOM, the store stubbed.
*/
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { createDocument } from "./minidom.js";

vi.mock("../module/scripts/shop.js", () => ({ refreshShop: vi.fn() }));
vi.mock("../module/scripts/chat.js", () => ({ postRefundCard: vi.fn() }));

let pools, boxes, log;
vi.mock("../module/scripts/store.js", async importOriginal => ({
  ...(await importOriginal()),
  getPools: () => structuredClone(pools),
  getBoxes: () => structuredClone(boxes),
  getLog: () => structuredClone(log),
  getRounds: () => ({}),
  isShopOpen: () => true,
  checkSources: async entries => new Map(entries.map(e => [e.uuid, { name: e.name, img: e.img, rarity: e.rarity }])),
  sweepPools: async () => [],
}));

let renders = 0;
class App {
  rendered = false;
  async render() {
    renders++;
    const root = await this._renderHTML();
    document.body.replaceChildren(root);
    this.element = root;
    this.rendered = true;
    return this;
  }
}

let openManager, refreshManager, storeRedraw, SETTINGS;
beforeAll(async () => {
  vi.stubGlobal("document", createDocument());
  vi.stubGlobal("CSS", { escape: s => String(s) });
  vi.stubGlobal("ui", { notifications: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  vi.stubGlobal("foundry", {
    utils: { escapeHTML: s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"), deepClone: v => structuredClone(v) },
    applications: { api: { ApplicationV2: App, DialogV2: class {} } },
  });
  vi.stubGlobal("game", { settings: { get: () => true }, user: { isGM: true } });
  ({ openManager, refreshManager } = await import("../module/scripts/manager.js"));
  ({ storeRedraw } = await import("../module/scripts/redraw.js"));
  ({ SETTINGS } = await import("../module/scripts/config.js"));
});
afterAll(() => vi.unstubAllGlobals());

const CARDS = [
  { id: "windfall", label: "Windfall", kind: "coins", weight: 1, gp: 50 },
  { id: "omen", label: "Omen", kind: "effect", weight: 1, once: true, text: "A sign." },
];
const DECK = { id: "deck", kind: "deck", name: "The Deck", price: 10, pools: [], weights: {}, deck: { step: 1.5, shuffledAt: 0, cards: CARDS }, rules: {} };
const CRATE = { id: "crate", name: "Pauper's Box", price: 25, pools: [{ id: "p", share: 1 }], weights: { common: 1 }, rules: {} };
const draw = cardId => ({ id: `r${log.length}`, kind: "deck", boxId: "deck", actorId: "a1", actorName: "Tam", boxName: "The Deck", cardId, at: 1000 + log.length, price: 10, payoutCp: 0 });
const settle = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  pools = { p: { id: "p", name: "Odds and ends", pools: [], entries: [{ uuid: "Item.a", name: "Rope", img: "", rarity: "common", weight: 1 }] } };
  boxes = { crate: CRATE, deck: DECK };
  log = [];
});

async function boxesTab() {
  const app = openManager();
  app.tab = "boxes";
  await app.render();
  return app;
}
const deckRow = app => [...app.element.querySelectorAll("tr")].find(tr => /The Deck/.test(tr.textContent));

describe("the Boxes tab and the pull log", () => {
  it("redraws a deck's drawn count and odds when the log changes, through the store's batched redraw", async () => {
    vi.useFakeTimers();
    try {
      const app = await boxesTab();
      expect(deckRow(app).textContent).toMatch(/2 cards, ×1\.5/);
      expect(deckRow(app).textContent).toMatch(/Effect/);
      const listen = storeRedraw({ refreshShop: () => {}, refreshManager });
      renders = 0;
      // Another client's draw of the once card: only the log changes.
      log.unshift(draw("omen"));
      listen(SETTINGS.LOG);
      await vi.advanceTimersByTimeAsync(200);
      expect(renders).toBe(1);
      expect(deckRow(app).textContent).toMatch(/2 cards, 1 drawn/);
      expect(deckRow(app).textContent).not.toMatch(/Effect/);
      // Its refund puts the card back, on the same tab.
      log[0].refunded = 2000;
      listen(SETTINGS.LOG);
      await vi.advanceTimersByTimeAsync(200);
      expect(renders).toBe(2);
      expect(deckRow(app).textContent).toMatch(/2 cards, ×1\.5/);
      expect(deckRow(app).textContent).toMatch(/Effect/);
    } finally { vi.useRealTimers(); }
  });

  it("leaves the tab alone on a log change when no deck is on it", async () => {
    boxes = { crate: CRATE };
    await boxesTab();
    renders = 0;
    refreshManager([SETTINGS.LOG]);
    await settle();
    expect(renders).toBe(0);
    boxes = { crate: CRATE, deck: DECK };
    refreshManager([SETTINGS.LOG]);
    await settle();
    expect(renders).toBe(1);
  });
});
