/*
  Price in the Boxes row (VIB-201): each row's price is a field the GM types
  into as the shop says it ("12 gp 5 sp", currency.js parsePrice), saved on
  change through the write queue with only the price changed, so a pull's
  stock or pity written meanwhile stays. A price it can't read, or a wheel's
  lowest bet over its highest, is put back and the tab's status line says
  why; a save says nothing. Focus, and what is being typed, survive a redraw.
  The crate's and the deck's editors read the price the same way, and the
  nav's "View shop" opens the shop. Drives the real manager into a minimal
  DOM with the real store on a stubbed world setting, as neweditor.test.js.
*/
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { createDocument } from "./minidom.js";

vi.mock("../module/scripts/foundry/shop.js", () => ({ refreshShop: vi.fn(), openShop: vi.fn() }));
vi.mock("../module/scripts/foundry/chat.js", () => ({ postRefundCard: vi.fn() }));
vi.mock("../module/scripts/foundry/store.js", async importOriginal => {
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
      // DialogV2's form: the content, then its footer of buttons.
      form.innerHTML = `${config.content}<footer class="form-footer">${config.buttons.map(b => `<button type="submit" data-action="${b.action}"><span>${b.label}</span></button>`).join("")}</footer>`;
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
let CrateManager, store, shop;
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
  store = await import("../module/scripts/foundry/store.js");
  ({ CrateManager } = await import("../module/scripts/foundry/manager.js"));
  shop = await import("../module/scripts/foundry/shop.js");
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


const CRATE = { id: "c1", name: "Goblin Crate", price: 12, pools: [{ id: "p", share: 1 }], weights: {}, rules: { stock: 5, stockMax: 10 } };
const WHEEL = { id: "w1", kind: "roulette", name: "Wheel of Fate", price: 5, pools: [], roulette: { maxStake: 50 } };
const DECK = { id: "d1", kind: "deck", name: "Deck of Many Things", price: 10, pools: [], deck: { step: 1.5, cards: [] } };
const WELL = { id: "e1", kind: "well", name: "Wishing Well", price: 0.05, pools: [] };
const DICE = { id: "x1", kind: "dice", name: "Dragon's Teeth", price: 2, pools: [] };

beforeEach(async () => {
  for (const b of [CRATE, WHEEL, DECK, WELL, DICE]) await store.saveBox(structuredClone(b));
  sets = 0;
  store.updateBox.mockClear();
});

const input = (app, id) => app.element.querySelector(`input[data-box-price="${id}"]`);
const body = app => app.element.querySelector(".lc-manager__body");
// The GM types into the row's field and leaves it (Tab, Enter or a click
// away all fire change, which the manager hears on its body).
function type(app, id, text) {
  const el = input(app, id);
  el.focus();
  el.value = text;
  body(app).dispatchEvent({ type: "change", target: el });
  return el;
}

describe("the Boxes row's price", () => {
  it("is a field per row, showing the price as the shop says it, named for what it prices", async () => {
    await store.updateBox("c1", f => ({ ...f, price: 12.5 }));
    const app = await manager();
    expect(input(app, "c1").value).toBe("12 gp 5 sp");
    expect(input(app, "c1").getAttribute("type")).toBe("text");
    expect(input(app, "c1").getAttribute("aria-label")).toBe("Price of Goblin Crate");
    expect(input(app, "d1").getAttribute("aria-label")).toBe("First draw at Deck of Many Things");
    expect(input(app, "w1").getAttribute("aria-label")).toBe("Lowest bet at Wheel of Fate");
    expect(input(app, "e1").getAttribute("aria-label")).toBe("Stake at Wishing Well");
    expect(input(app, "e1").value).toBe("5 cp");
    expect(input(app, "x1").getAttribute("aria-label")).toBe("Stake at Dragon's Teeth");
  });

  it("saves a typed price, the one way money is written, and says it saved in the status line", async () => {
    const app = await manager();
    const el = type(app, "c1", "7 gp 5 sp");
    await settle();
    expect(store.getBoxes().c1.price).toBe(7.5);
    expect(sets).toBe(1);
    expect(el.value).toBe("7 gp 5 sp");
    // One sentence for a screen reader, in the tab's one status line, and
    // focus still on the row's field.
    expect(status(app).getAttribute("role")).toBe("status");
    expect(status(app).textContent).toBe("Saved: Goblin Crate, 7 gp 5 sp.");
    expect(focused()).toBe(input(app, "c1"));
    expect(input(app, "c1").value).toBe("7 gp 5 sp");
    // A bare number is gold, written back as the shop will say it.
    type(app, "c1", "12.5");
    await settle();
    expect(store.getBoxes().c1.price).toBe(12.5);
    expect(input(app, "c1").value).toBe("12 gp 5 sp");
    expect(status(app).textContent).toBe("Saved: Goblin Crate, 12 gp 5 sp.");
    // The same price again writes nothing and says nothing new.
    status(app).textContent = "";
    type(app, "c1", "12 gp 5 sp");
    await settle();
    expect(sets).toBe(2);
    expect(status(app).textContent).toBe("");
  });

  it("writes only the price: a pull's stock and pity written in the same burst stay", async () => {
    const app = await manager();
    // A pull lands first (stock down by one, a pity count); the GM's price
    // goes in behind it in the write queue, then a second pull behind that.
    const pull = store.updateBox("c1", f => ({ ...f, rules: { ...f.rules, stock: f.rules.stock - 1 }, pity: { a1: 3 } }));
    type(app, "c1", "5 sp");
    const second = store.updateBox("c1", f => ({ ...f, rules: { ...f.rules, stock: f.rules.stock - 1 } }));
    await Promise.all([pull, second]);
    await settle();
    const saved = store.getBoxes().c1;
    expect(saved.price).toBe(0.5);
    expect(saved.rules.stock).toBe(3);
    expect(saved.rules.stockMax).toBe(10);
    expect(saved.pity).toEqual({ a1: 3 });
    expect(saved.name).toBe("Goblin Crate");
  });

  it("puts back a price it can't read and says how to type one", async () => {
    const app = await manager();
    for (const bad of ["5 gold", "abc", "-5", ""]) {
      const el = type(app, "c1", bad);
      await settle();
      expect(el.value).toBe("12 gp");
      expect(status(app).getAttribute("role")).toBe("status");
      expect(status(app).textContent).toMatch(bad ? /^Couldn't read ".+"; try 5 gp or 5 sp\.$/ : /^Type a price/);
    }
    expect(status(app).textContent).toBe("Type a price, such as 5 gp or 5 sp.");
    type(app, "c1", "5 gold");
    await settle();
    expect(status(app).textContent).toBe('Couldn\'t read "5 gold"; try 5 gp or 5 sp.');
    expect(store.updateBox).not.toHaveBeenCalled();
    expect(sets).toBe(0);
    expect(store.getBoxes().c1.price).toBe(12);
  });

  it("refuses a wheel's lowest bet over its highest, and takes one under it", async () => {
    const app = await manager();
    const el = type(app, "w1", "60 gp");
    await settle();
    expect(el.value).toBe("5 gp");
    expect(status(app).textContent).toBe("The lowest bet at Wheel of Fate can't be over its highest, 50 gp.");
    expect(sets).toBe(0);
    type(app, "w1", "50 gp");
    await settle();
    expect(store.getBoxes().w1.price).toBe(50);
    expect(store.getBoxes().w1.roulette.maxStake).toBe(50);
  });

  it("refuses it too when the highest bet came down while the price was being typed", async () => {
    const app = await manager();
    const lowered = store.updateBox("w1", f => ({ ...f, roulette: { ...f.roulette, maxStake: 20 } }));
    const el = type(app, "w1", "30 gp");
    await lowered;
    await settle();
    expect(store.getBoxes().w1.price).toBe(5);
    expect(el.value).toBe("5 gp");
    expect(status(app).textContent).toBe("The lowest bet at Wheel of Fate can't be over its highest, 20 gp.");
  });

  it("keeps focus, and what is being typed in another row, through a redraw", async () => {
    const app = await manager();
    type(app, "c1", "8 gp");
    await settle();
    // Tab to the deck's row and start typing; the crate's write redraws the tab.
    const deck = input(app, "d1");
    deck.focus();
    deck.value = "2";
    await app.render();
    const again = input(app, "d1");
    expect(again).not.toBe(deck);
    expect(focused()).toBe(again);
    expect(again.value).toBe("2");
    expect(again.defaultValue).toBe("10 gp");
  });
});

describe("the editors read money the same way", () => {
  it("the crate's price is a text field that takes 12 gp 5 sp", async () => {
    const app = await manager();
    const pending = act(app, "editBox", { dataset: { box: "c1" } });
    await settle(2);
    expect(field("price").getAttribute("type")).toBe("text");
    expect(field("price").value).toBe("12 gp");
    field("price").value = "12 gp 5 sp";
    dialog.save();
    await pending;
    await settle();
    expect(store.getBoxes().c1.price).toBe(12.5);
    expect(store.getBoxes().c1.rules.stock).toBe(5);
  });

  it("turns Save off while the price can't be read, saying why under the field", async () => {
    const app = await manager();
    const pending = act(app, "editBox", { dataset: { box: "c1" } });
    await settle(2);
    const price = field("price");
    const ok = dialog.form.querySelector('button[data-action="ok"]');
    price.value = "5 gold";
    price.dispatchEvent({ type: "input" });
    const why = dialog.form.querySelector("[data-price-why]");
    expect(why.textContent).toBe('Couldn\'t read "5 gold"; try 5 gp or 5 sp.');
    expect(price.getAttribute("aria-invalid")).toBe("true");
    expect(price.getAttribute("aria-describedby")).toBe(why.getAttribute("id"));
    expect(ok.disabled).toBe(true);
    price.value = "5 sp";
    price.dispatchEvent({ type: "input" });
    price.dispatchEvent({ type: "change" });
    expect(why.textContent).toBe("");
    expect(price.getAttribute("aria-invalid")).toBe("false");
    expect(ok.disabled).toBe(false);
    price.value = "12.5";
    price.dispatchEvent({ type: "change" });
    expect(price.value).toBe("12 gp 5 sp");
    dialog.cancel();
    await pending;
  });

  it("the deck's first draw takes 5 sp", async () => {
    const app = await manager();
    const pending = act(app, "editBox", { dataset: { box: "d1" } });
    await settle(2);
    expect(field("price").getAttribute("type")).toBe("text");
    expect(field("price").value).toBe("10 gp");
    field("price").value = "5 sp";
    dialog.save();
    await pending;
    await settle();
    expect(store.getBoxes().d1.price).toBe(0.5);
  });
});

describe("the deck's streak window in its editor", () => {
  async function editDeck(set) {
    const app = await manager();
    const pending = act(app, "editBox", { dataset: { box: "d1" } });
    await settle(2);
    const shown = field("streakMinutes").value;
    if (set != null) field("streakMinutes").value = set;
    dialog.save();
    await pending;
    await settle();
    return shown;
  }

  it("opens on 2 minutes for a deck saved before it, and keeps 2 when untouched", async () => {
    expect(store.getBoxes().d1.deck.streakMinutes).toBeUndefined();
    expect(await editDeck()).toBe("2");
    expect(store.getBoxes().d1.deck).toMatchObject({ step: 1.5, streakMinutes: 2 });
  });

  it("stores the GM's minutes on the record, and blank or 0 as no streak", async () => {
    await editDeck("1");
    expect(store.getBoxes().d1.deck.streakMinutes).toBe(1);
    expect(await editDeck("")).toBe("1");
    expect(store.getBoxes().d1.deck.streakMinutes).toBe(0);
    expect(await editDeck("0")).toBe("0");
    expect(store.getBoxes().d1.deck.streakMinutes).toBe(0);
    await editDeck("5");
    expect(store.getBoxes().d1.deck.streakMinutes).toBe(5);
  });

  it("names the field and its hint for a screen reader", async () => {
    const app = await manager();
    const pending = act(app, "editBox", { dataset: { box: "d1" } });
    await settle(2);
    const input = field("streakMinutes");
    expect(input.closest("label").textContent.replace(/\s+/g, " ").trim()).toBe("Draws count as in a row within minutes");
    expect(dialog.form.querySelector(`[id="${input.getAttribute("aria-describedby")}"]`).textContent).toMatch(/Blank or 0: every draw is a first draw\.$/);
    dialog.cancel();
    await pending;
  });
});

describe("a pool row's weight and rarity", () => {
  it("say they saved in the tab's status line, as a price does", async () => {
    const app = await manager("pools");
    const weight = app.element.querySelector('input[data-curate="weight"][data-uuid="Item.b"]');
    weight.focus();
    weight.value = "3";
    body(app).dispatchEvent({ type: "change", target: weight });
    await settle();
    expect(store.getPools().p.entries.find(e => e.uuid === "Item.b").weight).toBe(3);
    expect(status(app).textContent).toBe("Saved: Flame Tongue, weight 3.");
    const rarity = app.element.querySelector('select[data-curate="rarity"][data-uuid="Item.b"]');
    rarity.value = "veryRare";
    body(app).dispatchEvent({ type: "change", target: rarity });
    await settle();
    expect(status(app).textContent).toBe("Saved: Flame Tongue, Very rare.");
  });
});

describe("View shop", () => {
  it("sits beside the shop's toggle and opens the shop window", async () => {
    const app = await manager();
    const view = app.element.querySelector('nav [data-action="openShop"]');
    expect(view.textContent.trim()).toBe("View shop");
    expect(app.element.querySelector('nav [data-action="toggleShop"]')).not.toBeNull();
    shop.openShop.mockClear();
    await act(app, "openShop", view);
    expect(shop.openShop).toHaveBeenCalledTimes(1);
    expect(sets).toBe(0);
  });
});
