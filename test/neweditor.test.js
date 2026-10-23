/*
  Every New on the manager's Boxes tab opens its kind's editor on an
  unsaved draft (newgame.js): Cancel writes nothing, Save creates the game
  once from the form, and the GM is shown where it went: the Boxes tab, the
  new row marked and its Edit focused, the status line saying it is on the
  shelf. "New crate from this pool" on the Pools tab opens the same editor
  on a crate named for the pool. Copy on a game's row opens the editor on
  an unsaved copy of it (newgame.js copyOf), titled Copy, and Save adds it
  with no history. Drives the real manager through its
  action handlers into a minimal DOM, with the real store writing to a
  stubbed world setting and DialogV2 stubbed to a form the test fills in.
*/
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { createDocument } from "./minidom.js";

vi.mock("../module/scripts/shop.js", () => ({ refreshShop: vi.fn() }));
vi.mock("../module/scripts/chat.js", () => ({ postRefundCard: vi.fn() }));
vi.mock("../module/scripts/store.js", async importOriginal => {
  const orig = await importOriginal();
  return {
    ...orig,
    checkSources: async entries => new Map(entries.map(e => [e.uuid, { name: e.name, img: e.img, rarity: e.rarity }])),
    sweepPools: async () => [],
    createBox: vi.fn(orig.createBox),
    updateBox: vi.fn(orig.updateBox),
  };
});

// The dialog as the test sees it: its title, its form (the content parsed
// into a minidom <form>, as DialogV2 wraps it) and its buttons. Save runs
// the ok button's callback on that form, as DialogV2 does. Cancel resolves
// the string "cancel", as DialogV2 does for a button whose callback gives
// nothing (its action name stands in); closing the dialog resolves null.
let dialog = null;
class Dialog {
  static wait(config) {
    return new Promise(resolve => {
      const form = document.createElement("form");
      form.innerHTML = config.content;
      document.body.appendChild(form);
      const done = v => { form.remove(); dialog = null; resolve(v); };
      dialog = {
        title: config.window.title,
        form,
        buttons: config.buttons,
        save: () => done(config.buttons.find(b => b.action === "ok").callback(null, { form })),
        cancel: () => done(config.buttons.find(b => b.action === "cancel").callback() ?? "cancel"),
        close: () => done(null),
      };
      config.render?.({}, { element: document.body });
    });
  }
}

// FormData over the minidom form: named inputs (a ticked checkbox as "on")
// and selects, as readForm reads them.
class FormDataStub {
  constructor(form) {
    this.rows = [];
    for (const el of form.querySelectorAll("input")) {
      if (!el.getAttribute("name")) continue;
      if (el.getAttribute("type") === "checkbox") { if (el.checked) this.rows.push([el.getAttribute("name"), "on"]); continue; }
      this.rows.push([el.getAttribute("name"), el.value]);
    }
    for (const el of form.querySelectorAll("select")) if (el.getAttribute("name") && !el.hasAttribute("multiple")) this.rows.push([el.getAttribute("name"), el.value]);
  }
  entries() { return this.rows[Symbol.iterator](); }
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

let settings, sets;
const notifications = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let CrateManager, store, newgame;
beforeAll(async () => {
  vi.stubGlobal("document", createDocument());
  vi.stubGlobal("CSS", { escape: s => String(s) });
  vi.stubGlobal("FormData", FormDataStub);
  vi.stubGlobal("ui", { notifications });
  vi.stubGlobal("foundry", {
    utils: { escapeHTML: s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"), deepClone: v => structuredClone(v), randomID: n => Math.random().toString(36).slice(2, 2 + (n ?? 10)) },
    applications: { api: { ApplicationV2: App, DialogV2: Dialog } },
  });
  vi.stubGlobal("game", { user: { isGM: true }, settings: {
    register: (_m, key, cfg) => settings.set(key, cfg.default),
    get: (_m, key) => settings.get(key),
    set: async (_m, key, v) => { sets++; await new Promise(r => setTimeout(r, 1)); settings.set(key, structuredClone(v)); },
  } });
  store = await import("../module/scripts/store.js");
  newgame = await import("../module/scripts/newgame.js");
  ({ CrateManager } = await import("../module/scripts/manager.js"));
});
afterAll(() => vi.unstubAllGlobals());

const POOL = { id: "p", name: "Odds and ends", pools: [], entries: [{ uuid: "Item.a", name: "Rope", img: "", rarity: "common", weight: 1 }, { uuid: "Item.b", name: "Flame Tongue", img: "", rarity: "rare", weight: 1 }] };
beforeEach(async () => {
  settings = new Map();
  sets = 0;
  store.registerSettings();
  await store.savePool(POOL);
  sets = 0;
  store.createBox.mockClear();
  store.updateBox.mockClear();
  for (const fn of Object.values(notifications)) fn.mockClear();
  document.body.replaceChildren();
  document.activeElement = document.body;
});

const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 2)); };
const act = (app, name, target = {}) => CrateManager.DEFAULT_OPTIONS.actions[name].call(app, {}, target);
async function manager(tab = "boxes") {
  const app = new CrateManager();
  app.tab = tab;
  await app.render();
  return app;
}
const field = name => dialog.form.querySelector(`[name="${name}"]`);
const status = app => app.element.querySelector(".lc-manager__status");
const focused = () => document.activeElement;

const NEWS = [["addBox", "crate", "New box"], ["addWell", "well", "New well"], ["addDice", "dice", "New dice game"], ["addDeck", "deck", "New deck"], ["addWheel", "roulette", "New wheel"]];

describe("New then Cancel", () => {
  for (const [action, kind, title] of NEWS) {
    it(`${action}: opens "${title}" on a draft and writes nothing`, async () => {
      const app = await manager();
      const pending = act(app, action);
      await settle(2);
      expect(dialog).not.toBeNull();
      expect(dialog.title).toBe(title);
      expect(dialog.buttons.find(b => b.action === "ok").label).toBe("Add to shelf");
      expect(field("name").value).toBe(title);
      expect(field("name").hasAttribute("autofocus")).toBe(true);
      // While the dialog is open the shelf is as it was: no record, no write.
      expect(store.getBoxes()).toEqual({});
      expect(sets).toBe(0);
      dialog.cancel();
      await pending;
      await settle();
      expect(store.getBoxes()).toEqual({});
      expect(sets).toBe(0);
      expect(store.createBox).not.toHaveBeenCalled();
      expect(app.element.querySelector(".lc-table")).toBeNull();
      void kind;
    });
  }
});

describe("New then Save", () => {
  it("creates the crate once from the form, shows its row with Edit focused and says where it went", async () => {
    const app = await manager();
    const pending = act(app, "addBox");
    await settle(2);
    field("name").value = "Gilded Crate";
    field("price").value = "250";
    field("pool.p").checked = true;
    field("stock").value = "10";
    dialog.save();
    await pending;
    await settle();
    expect(store.createBox).toHaveBeenCalledTimes(1);
    expect(store.updateBox).not.toHaveBeenCalled();
    expect(sets).toBe(1);
    const boxes = Object.values(store.getBoxes());
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ name: "Gilded Crate", price: 250, pools: [{ id: "p", share: 1 }], rules: { stock: 10, stockMax: 10, pity: null, noDuplicates: false } });
    expect(boxes[0].kind).toBeUndefined();
    expect(app.tab).toBe("boxes");
    const edit = app.element.querySelector(`[data-action="editBox"][data-box="${boxes[0].id}"]`);
    expect(edit.getAttribute("aria-label")).toBe("Edit Gilded Crate");
    expect(focused()).toBe(edit);
    expect(edit.closest("tr").classList.contains("lc-row--new")).toBe(true);
    expect(status(app).getAttribute("role")).toBe("status");
    expect(status(app).textContent).toBe("Gilded Crate is on the shelf at 250 gp.");
    expect(notifications.warn).not.toHaveBeenCalled();
    expect(notifications.info).not.toHaveBeenCalled();
  });

  for (const [action, kind] of NEWS.slice(1)) {
    it(`${action}: creates one ${kind} with the form's values`, async () => {
      const app = await manager();
      const pending = act(app, action);
      await settle(2);
      field("name").value = `My ${kind}`;
      dialog.save();
      await pending;
      await settle();
      expect(store.createBox).toHaveBeenCalledTimes(1);
      const boxes = Object.values(store.getBoxes());
      expect(boxes).toHaveLength(1);
      expect(boxes[0]).toMatchObject({ kind, name: `My ${kind}` });
      expect(boxes[0].price).toBe(newgame.NEW_DEFAULTS[kind]().price);
      expect(focused()?.getAttribute("aria-label")).toBe(`Edit My ${kind}`);
      expect(status(app).textContent).toBe(newgame.addedNotice(boxes[0], { shopOpen: true }));
    });
  }

  it("reads Add, and says the shop is closed, while it is", async () => {
    settings.set("shopOpen", false);
    const app = await manager();
    const pending = act(app, "addDice");
    await settle(2);
    expect(dialog.buttons.find(b => b.action === "ok").label).toBe("Add");
    dialog.save();
    await pending;
    await settle();
    expect(status(app).textContent).toBe("New dice game added. The shop is closed, so players can't see it yet.");
  });

  it("marks only the newest row, and lets the mark go when the manager closes", async () => {
    const app = await manager();
    for (const name of ["First", "Second"]) {
      const pending = act(app, "addBox");
      await settle(2);
      field("name").value = name;
      dialog.save();
      await pending;
      await settle();
    }
    const marked = app.element.querySelectorAll(".lc-table tr.lc-row--new");
    expect(marked).toHaveLength(1);
    expect(marked[0].textContent).toContain("Second");
    await app._onClose({});
    await app.render();
    expect(app.element.querySelectorAll(".lc-table tr.lc-row--new")).toHaveLength(0);
  });
});

describe("Copy", () => {
  const SOURCE = { id: "b1", name: "Goblin Crate", price: 50, pools: [{ id: "p", share: 2 }], weights: { common: 10, uncommon: 5, rare: 2, veryRare: 1, legendary: 0, artifact: 0 }, rules: { pity: { minRarity: "rare", after: 6 }, noDuplicates: true, stock: 3, stockMax: 10, perCharacter: { max: 2, per: "ever" } } };
  const history = async () => {
    await store.appendLog({ id: "row1", boxId: "b1", boxName: "Goblin Crate", actorId: "A", actorName: "Tam", price: 50, itemId: "i1", at: 1000 });
    await store.setActorState("A", "b1", { pity: 4, owned: ["Item.a"] });
  };

  it("is on every row, naming the game, beside Edit", async () => {
    await store.saveBox(SOURCE);
    await store.saveBox({ id: "w1", kind: "well", name: "Old Well", price: 0.1, pools: [], weights: {}, odds: { nothing: 90, coin: 8, item: 2 }, rules: { cap: 3 } });
    const app = await manager();
    for (const [id, name] of [["b1", "Goblin Crate"], ["w1", "Old Well"]]) {
      const copy = app.element.querySelector(`.lc-table [data-action="copyBox"][data-box="${id}"]`);
      expect(copy).not.toBeNull();
      expect(copy.getAttribute("aria-label")).toBe(`Copy ${name}`);
      expect(copy.getAttribute("data-tooltip")).toBe("Copy");
      const cell = copy.closest("td");
      const actions = [...cell.querySelectorAll("[data-action]")].map(b => b.getAttribute("data-action"));
      expect(actions).toEqual(["toggleShelf", "editBox", "copyBox", "deleteBox"]);
    }
  });

  it("opens the crate's editor on a copy, titled Copy box with the name focused, and Cancel writes nothing", async () => {
    await store.saveBox(SOURCE);
    await history();
    const was = structuredClone(store.getBoxes());
    sets = 0;
    const app = await manager();
    for (const end of ["cancel", "close"]) {
      const pending = act(app, "copyBox", { dataset: { box: "b1" } });
      await settle(2);
      expect(dialog).not.toBeNull();
      expect(dialog.title).toBe("Copy box");
      expect(dialog.buttons.find(b => b.action === "ok").label).toBe("Add to shelf");
      expect(field("name").value).toBe("Goblin Crate (copy)");
      expect(field("name").hasAttribute("autofocus")).toBe(true);
      expect(field("price").value).toBe("50");
      expect(field("pool.p").checked).toBe(true);
      expect(field("share.p").value).toBe("2");
      expect(field("w.common").value).toBe("10");
      expect(field("pityRarity").value).toBe("rare");
      expect(field("pityAfter").value).toBe("6");
      expect(field("noDuplicates").checked).toBe(true);
      // The copy's stock is full again: the GM's number, as a New's would open.
      expect(field("stock").value).toBe("10");
      expect(field("limitMax").value).toBe("2");
      // A draft has no record to restock.
      expect(dialog.form.querySelector("[data-restock]")).toBeNull();
      expect(store.getBoxes()).toEqual(was);
      expect(sets).toBe(0);
      dialog[end]();
      await pending;
      await settle();
    }
    expect(store.getBoxes()).toEqual(was);
    expect(sets).toBe(0);
    expect(store.createBox).not.toHaveBeenCalled();
    expect(store.updateBox).not.toHaveBeenCalled();
    expect(app.element.querySelectorAll(".lc-table tbody tr")).toHaveLength(1);
  });

  it("Save adds one box with the source's settings and no history, focused and announced like a New", async () => {
    await store.saveBox(SOURCE);
    await history();
    const was = structuredClone(store.getBoxes().b1);
    sets = 0;
    const app = await manager();
    const pending = act(app, "copyBox", { dataset: { box: "b1" } });
    await settle(2);
    field("name").value = "Goblin Crate (Deluxe)";
    field("price").value = "120";
    dialog.save();
    await pending;
    await settle();
    expect(store.createBox).toHaveBeenCalledTimes(1);
    expect(store.updateBox).not.toHaveBeenCalled();
    expect(sets).toBe(1);
    const boxes = Object.values(store.getBoxes());
    expect(boxes).toHaveLength(2);
    const copy = boxes.find(b => b.id !== "b1");
    expect(copy).toMatchObject({ name: "Goblin Crate (Deluxe)", price: 120, pools: [{ id: "p", share: 2 }], weights: SOURCE.weights, rules: { pity: { minRarity: "rare", after: 6 }, noDuplicates: true, stock: 10, stockMax: 10, perCharacter: { max: 2, per: "ever" } } });
    expect(copy.kind).toBeUndefined();
    expect(store.getBoxes().b1).toEqual(was);
    // Its log and every character's pity and collection are empty; the source keeps its own.
    expect(store.getLog().filter(r => r.boxId === copy.id)).toEqual([]);
    expect(store.getActorState("A", copy.id)).toEqual({});
    expect(store.getActorState("A", "b1")).toEqual({ pity: 4, owned: ["Item.a"] });
    expect(app.tab).toBe("boxes");
    const edit = app.element.querySelector(`[data-action="editBox"][data-box="${copy.id}"]`);
    expect(focused()).toBe(edit);
    expect(edit.closest("tr").classList.contains("lc-row--new")).toBe(true);
    expect(status(app).textContent).toBe("Goblin Crate (Deluxe) is on the shelf at 120 gp.");
    expect(notifications.warn).not.toHaveBeenCalled();
  });

  it("copies a deck with its cards, the shuffle mark fresh so nothing counts as drawn", async () => {
    const cards = [{ id: "a", label: "Sun", kind: "item", weight: 2, once: true, gp: 0, text: "" }, { id: "b", label: "Ruin", kind: "loss", weight: 1, once: false, gp: 25, text: "" }, { id: "c", label: "Fates", kind: "effect", weight: 1, once: true, gp: 0, text: "Undo one thing." }];
    await store.saveBox({ id: "k1", kind: "deck", name: "Thornwick Deck", price: 10, pools: [{ id: "p", share: 1 }], weights: { common: 0, uncommon: 2, rare: 1, veryRare: 0, legendary: 0, artifact: 0 }, deck: { step: 1.5, shuffledAt: 1000, cards }, rules: {} });
    await store.appendLog({ id: "row1", kind: "deck", boxId: "k1", boxName: "Thornwick Deck", actorId: "A", actorName: "Tam", price: 10, cardId: "a", at: 2000 });
    const before = Date.now();
    const app = await manager();
    const pending = act(app, "copyBox", { dataset: { box: "k1" } });
    await settle(2);
    expect(dialog.title).toBe("Copy deck");
    expect(field("name").value).toBe("Thornwick Deck (copy)");
    expect(dialog.form.querySelectorAll(".lc-card-row")).toHaveLength(3);
    dialog.save();
    await pending;
    await settle();
    const copy = Object.values(store.getBoxes()).find(b => b.id !== "k1");
    expect(copy).toMatchObject({ kind: "deck", name: "Thornwick Deck (copy)", price: 10, deck: { step: 1.5, cards } });
    expect(copy.deck.shuffledAt).toBeGreaterThanOrEqual(before);
    const { drawnIds } = await import("../module/scripts/deck.js");
    expect(drawnIds(store.getBoxes().k1, store.getLog())).toEqual(new Set(["a"]));
    expect(drawnIds(copy, store.getLog())).toEqual(new Set());
    expect(store.getBoxes().k1.deck.shuffledAt).toBe(1000);
    expect(status(app).textContent).toBe("Thornwick Deck (copy) is on the shelf at 10 gp.");
  });

  it("does nothing for a game that is gone", async () => {
    const app = await manager();
    await act(app, "copyBox", { dataset: { box: "nope" } });
    expect(dialog).toBeNull();
    expect(store.getBoxes()).toEqual({});
  });
});

describe("Edit then Cancel", () => {
  it("writes nothing, whether the dialog is cancelled or closed", async () => {
    await store.saveBox({ id: "b1", name: "Old Crate", price: 50, pools: [{ id: "p", share: 2 }], weights: { common: 1 }, rules: { stock: 3, stockMax: 3 } });
    const was = store.getBoxes().b1;
    sets = 0;
    const app = await manager();
    for (const end of ["cancel", "close"]) {
      const pending = act(app, "editBox", { dataset: { box: "b1" } });
      await settle(2);
      field("price").value = "0";
      dialog[end]();
      await pending;
      await settle();
    }
    expect(store.updateBox).not.toHaveBeenCalled();
    expect(sets).toBe(0);
    expect(store.getBoxes().b1).toEqual(was);
  });
});

describe("Edit", () => {
  it("still updates the record in place, titled Edit, reading Save, and warns only when it is gone", async () => {
    await store.saveBox({ id: "b1", name: "Old Crate", price: 50, pools: [], weights: {}, rules: {} });
    sets = 0;
    const app = await manager();
    const pending = act(app, "editBox", { dataset: { box: "b1" } });
    await settle(2);
    expect(dialog.title).toBe("Edit box");
    expect(dialog.buttons.find(b => b.action === "ok").label).toBe("Save");
    expect(field("name").hasAttribute("autofocus")).toBe(false);
    field("price").value = "60";
    dialog.save();
    await pending;
    await settle();
    expect(store.updateBox).toHaveBeenCalledTimes(1);
    expect(store.createBox).not.toHaveBeenCalled();
    expect(store.getBoxes().b1).toMatchObject({ name: "Old Crate", price: 60 });
    expect(Object.keys(store.getBoxes())).toEqual(["b1"]);
    expect(notifications.warn).not.toHaveBeenCalled();

    const again = act(app, "editBox", { dataset: { box: "b1" } });
    await settle(2);
    await store.removeBox("b1");
    dialog.save();
    await again;
    await settle();
    expect(notifications.warn).toHaveBeenCalledWith("Old Crate was deleted while you were editing it.");
    expect(store.getBoxes()).toEqual({});
  });
});

describe("New crate from this pool", () => {
  it("is on the pool's bar, naming the pool", async () => {
    const app = await manager("pools");
    const bar = app.element.querySelector('[data-action="crateFromPool"][data-pool="p"]');
    expect(bar).not.toBeNull();
    expect(bar.getAttribute("aria-label")).toBe("New crate from Odds and ends");
    expect(bar.textContent).toContain("New crate from this pool");
  });

  it("opens the crate editor named for the pool, drawing from it, the price focused, and adds it on Save", async () => {
    const app = await manager("pools");
    const pending = act(app, "crateFromPool", { dataset: { pool: "p" } });
    await settle(2);
    expect(dialog.title).toBe("New box");
    expect(field("name").value).toBe("Odds and ends");
    expect(field("name").hasAttribute("autofocus")).toBe(false);
    expect(field("price").hasAttribute("autofocus")).toBe(true);
    expect(field("pool.p").checked).toBe(true);
    // The preview already shows the pool's odds, as the shop would.
    expect(dialog.form.querySelector(".lc-form__preview").textContent).toMatch(/Common \d+%/);
    expect(store.getBoxes()).toEqual({});
    field("price").value = "40";
    dialog.save();
    await pending;
    await settle();
    expect(store.createBox).toHaveBeenCalledTimes(1);
    const [box] = Object.values(store.getBoxes());
    expect(box).toMatchObject({ name: "Odds and ends", price: 40, pools: [{ id: "p", share: 1 }] });
    expect(app.tab).toBe("boxes");
    expect(focused()?.getAttribute("aria-label")).toBe("Edit Odds and ends");
    expect(status(app).textContent).toBe("Odds and ends is on the shelf at 40 gp.");
  });

  it("does nothing for a pool that is gone", async () => {
    const app = await manager("pools");
    await act(app, "crateFromPool", { dataset: { pool: "nope" } });
    expect(dialog).toBeNull();
    expect(store.getBoxes()).toEqual({});
  });
});

/*
  On the shelf (shelf.js): every editor has the box, ticked for a New so its
  "Add to shelf" keeps its word; unticked, the game is added for the GM
  alone. Each Boxes row's toggle puts a game out or takes it back in one
  click, keeping focus on itself, and the toolbar counts what players see.
*/
describe("On the shelf", () => {
  for (const [action, kind, title] of NEWS) {
    it(`${action}: the box is ticked; unticked, the ${kind} is added off the shelf and the status line says so`, async () => {
      const app = await manager();
      const pending = act(app, action);
      await settle(2);
      expect(dialog.title).toBe(title);
      expect(field("onShelf").checked).toBe(true);
      field("onShelf").checked = false;
      dialog.save();
      await pending;
      await settle();
      const [game] = Object.values(store.getBoxes());
      expect(game.rules.shelved).toBe(false);
      expect(status(app).textContent).toBe(`${title} added off the shelf. Players can't see it until you put it on the shelf.`);
      const row = app.element.querySelector(`.lc-table [data-action="editBox"][data-box="${game.id}"]`).closest("tr");
      expect(row.classList.contains("lc-row--off")).toBe(true);
      expect(app.element.querySelector(".lc-shelf-count").textContent).toBe("0 of 1 on the shelf");
    });
  }

  it("a New left ticked writes no flag, as every record before it", async () => {
    const app = await manager();
    const pending = act(app, "addBox");
    await settle(2);
    dialog.save();
    await pending;
    await settle();
    const [game] = Object.values(store.getBoxes());
    expect("shelved" in game.rules).toBe(false);
    expect(app.element.querySelector(".lc-shelf-count").textContent).toBe("1 of 1 on the shelf");
  });

  it("an edit shows the record's state and Save writes the box as left", async () => {
    await store.saveBox({ id: "b1", name: "Hidden Crate", price: 50, pools: [{ id: "p", share: 1 }], weights: {}, rules: { shelved: false, stock: 2, stockMax: 5 } });
    const app = await manager();
    let pending = act(app, "editBox", { dataset: { box: "b1" } });
    await settle(2);
    expect(field("onShelf").checked).toBe(false);
    field("onShelf").checked = true;
    dialog.save();
    await pending;
    await settle();
    expect(store.getBoxes().b1.rules).toEqual({ stock: 2, stockMax: 5, pity: null, noDuplicates: false, perCharacter: null });
    pending = act(app, "editBox", { dataset: { box: "b1" } });
    await settle(2);
    expect(field("onShelf").checked).toBe(true);
    dialog.cancel();
    await pending;
  });

  it("the row's toggle flips the flag in one click, keeps focus on itself and says what players see", async () => {
    await store.saveBox({ id: "b1", name: "Gilded Crate", price: 50, pools: [{ id: "p", share: 1 }], weights: {}, rules: {} });
    await store.saveBox({ id: "w1", kind: "well", name: "Old Well", price: 0.1, pools: [], weights: {}, odds: { nothing: 90, coin: 8, item: 2 }, rules: { cap: 3 } });
    const app = await manager();
    const toggle = () => app.element.querySelector('.lc-table [data-action="toggleShelf"][data-box="b1"]');
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(app.element.querySelector(".lc-shelf-count").textContent).toBe("2 of 2 on the shelf");
    toggle().focus();
    await act(app, "toggleShelf", toggle());
    await settle();
    expect(store.getBoxes().b1.rules.shelved).toBe(false);
    expect(store.getBoxes().w1.rules).toEqual({ cap: 3 });
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(toggle().textContent).toBe("Put on shelf");
    expect(focused()).toBe(toggle());
    expect(status(app).textContent).toBe("Gilded Crate is off the shelf; players can't see it.");
    expect(app.element.querySelector(".lc-shelf-count").textContent).toBe("1 of 2 on the shelf");
    await act(app, "toggleShelf", toggle());
    await settle();
    expect("shelved" in store.getBoxes().b1.rules).toBe(false);
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(focused()).toBe(toggle());
    expect(status(app).textContent).toBe("Gilded Crate is on the shelf; players can see it.");
  });

  it("a new crate draws from the world's one pool, already ticked", async () => {
    const app = await manager();
    const pending = act(app, "addBox");
    await settle(2);
    expect(field("pool.p").checked).toBe(true);
    dialog.cancel();
    await pending;
    expect(store.getBoxes()).toEqual({});
  });
});
