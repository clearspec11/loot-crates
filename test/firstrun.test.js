/*
  A first crate by hand, as the GM usability test walked it (round 30, B3):
  every action says what it did where the GM is looking, New pool behaves
  like making something, Add from compendium shows its filters, a crate
  with no pool can make one without leaving its editor, the starter set
  can go on the shelf in one press, and Make a ticket names what it made.
  Drives the real manager through its action handlers into a minimal DOM,
  with the real store writing to a stubbed world setting and DialogV2
  stubbed to a stack of dialogs the test fills in and presses.
*/
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { createDocument } from "./minidom.js";

vi.mock("../module/scripts/foundry/shop.js", () => ({ refreshShop: vi.fn() }));
vi.mock("../module/scripts/foundry/chat.js", () => ({ postRefundCard: vi.fn() }));
const PLAN = { label: "Items (SRD)", kind: "Compendium", entries: [{ uuid: "Compendium.dnd5e.items.Item.cloak", name: "Cloak of Protection", img: "", rarity: "uncommon", weight: 1 }, { uuid: "Compendium.dnd5e.items.Item.boots", name: "Boots of Elvenkind", img: "", rarity: "uncommon", weight: 1 }], skipped: { duplicates: 0, notLoot: {} } };
const drops = [];
vi.mock("../module/scripts/foundry/store.js", async importOriginal => {
  const orig = await importOriginal();
  return {
    ...orig,
    checkSources: async entries => new Map(entries.map(e => [e.uuid, { name: e.name, img: e.img, rarity: e.rarity }])),
    sweepPools: async () => [],
    packHasLoot: () => true,
    entriesFromDrop: async (data, opts) => { drops.push({ data, opts }); return structuredClone(PLAN); },
  };
});
const made = { item: null };
vi.mock("../module/scripts/foundry/tickets.js", async importOriginal => ({
  ...(await importOriginal()),
  makeTicket: vi.fn(async box => ({ item: (made.item = { id: "tix1", name: `${box.name} ticket` }), folder: { name: "Loot Crates tickets" } })),
  showInItems: vi.fn(async () => true),
}));
let starter = null;
vi.mock("../module/scripts/foundry/starterbuild.js", () => ({ addStarterSet: vi.fn(async () => starter()) }));

// Every open dialog, newest last: its title, its <form>, its buttons.
// press(action) runs that button's callback on the form as DialogV2 does,
// and resolves the dialog with what it returns (or the action's name).
let dialogs = [];
class Dialog {
  static confirm = vi.fn(async () => true);
  static wait(config) {
    return new Promise(resolve => {
      const form = document.createElement("form");
      form.innerHTML = config.content;
      document.body.appendChild(form);
      const entry = {
        title: config.window.title,
        form,
        buttons: config.buttons,
        press: action => {
          dialogs = dialogs.filter(d => d !== entry);
          form.remove();
          const b = config.buttons.find(x => x.action === action);
          resolve(b?.callback ? (b.callback(null, { form }) ?? action) : action);
        },
      };
      dialogs.push(entry);
      config.render?.({}, { element: form });
    });
  }
}
// The minidom <form> as DialogV2's own: the editor's fields are in it.
const top = () => dialogs.at(-1);
const field = (d, name) => d.form.querySelector(`[name="${name}"]`);

class FormDataStub {
  constructor(form) {
    this.rows = [];
    for (const el of form.querySelectorAll("input")) {
      if (!el.getAttribute("name")) continue;
      if (el.getAttribute("type") === "checkbox") { if (el.checked) this.rows.push([el.getAttribute("name"), el.getAttribute("value") ?? "on"]); continue; }
      if (el.getAttribute("type") === "radio") { if (el.checked) this.rows.push([el.getAttribute("name"), el.value]); continue; }
      this.rows.push([el.getAttribute("name"), el.value]);
    }
    for (const el of form.querySelectorAll("select")) {
      if (!el.getAttribute("name") || el.hasAttribute("multiple")) continue;
      const picked = el.querySelectorAll("option").find(o => o.hasAttribute("selected")) ?? el.querySelector("option");
      this.rows.push([el.getAttribute("name"), el._value ?? picked?.getAttribute("value") ?? ""]);
    }
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

let settings;
const notifications = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let CrateManager, store, tickets;
beforeAll(async () => {
  vi.stubGlobal("document", createDocument());
  vi.stubGlobal("CSS", { escape: s => String(s) });
  vi.stubGlobal("FormData", FormDataStub);
  vi.stubGlobal("ui", { notifications });
  vi.stubGlobal("CONFIG", { Item: { typeLabels: { weapon: "Weapon", equipment: "Equipment", consumable: "Consumable", tool: "Tool", loot: "Loot", container: "Container", spell: "Spell" } } });
  vi.stubGlobal("foundry", {
    utils: { escapeHTML: s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"), deepClone: v => structuredClone(v), randomID: n => Math.random().toString(36).slice(2, 2 + (n ?? 10)) },
    applications: { api: { ApplicationV2: App, DialogV2: Dialog } },
  });
  vi.stubGlobal("game", {
    user: { isGM: true },
    i18n: { localize: k => k },
    packs: { filter: fn => [{ collection: "world.imps", metadata: { label: "imps" } }, { collection: "dnd5e.items", metadata: { label: "Items (SRD)" } }].filter(fn) },
    settings: {
      register: (_m, key, cfg) => settings.set(key, cfg.default),
      get: (_m, key) => settings.get(key),
      set: async (_m, key, v) => { await new Promise(r => setTimeout(r, 1)); settings.set(key, structuredClone(v)); },
    },
  });
  store = await import("../module/scripts/foundry/store.js");
  tickets = await import("../module/scripts/foundry/tickets.js");
  ({ CrateManager } = await import("../module/scripts/foundry/manager.js"));
});
afterAll(() => vi.unstubAllGlobals());

const POOL = (id, name, n = 2) => ({ id, name, pools: [], entries: Array.from({ length: n }, (_, i) => ({ uuid: `Item.${id}${i}`, name: `${name} ${i}`, img: "", rarity: "rare", weight: 1 })) });
beforeEach(async () => {
  settings = new Map();
  store.registerSettings();
  dialogs = [];
  drops.length = 0;
  Dialog.confirm.mockClear();
  for (const fn of Object.values(notifications)) fn.mockClear();
  document.body.replaceChildren();
  document.activeElement = document.body;
});

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 2)); };
const until = async test => { for (let i = 0; i < 200 && !test(); i++) await new Promise(r => setTimeout(r, 2)); return test(); };
const act = (app, name, target = {}) => CrateManager.DEFAULT_OPTIONS.actions[name].call(app, {}, target);
async function manager(tab = "boxes") {
  const app = new CrateManager();
  app.tab = tab;
  await app.render();
  return app;
}
const tabEl = app => app.element.querySelector(".lc-tab");
const status = app => app.element.querySelector(".lc-manager__status").textContent;

describe("the status line, where the GM is looking", () => {
  it("is the first thing in each tab's pane, its own pinned bar, not in the toolbar", async () => {
    await store.savePool(POOL("p", "Odds and ends"));
    for (const tab of ["boxes", "pools"]) {
      const app = await manager(tab);
      const first = tabEl(app).children[0];
      expect(first.className).toBe("lc-manager__statusbar");
      expect(first.querySelectorAll('[role="status"]')).toHaveLength(1);
      expect(app.element.querySelectorAll(".lc-manager__status")).toHaveLength(1);
      expect(app.element.querySelector(".lc-toolbar .lc-manager__status")).toBeNull();
    }
  });

  it("says Saved <name>. after an edit, as an add says where it went", async () => {
    await store.savePool(POOL("p", "Odds and ends"));
    await store.createBox({ id: "g", name: "Goblin Crate", price: 25, pools: [{ id: "p", share: 1 }], weights: { rare: 1 }, rules: {} });
    const app = await manager();
    const saving = act(app, "editBox", { dataset: { box: "g" } });
    await until(() => top());
    expect(top().title).toBe("Edit crate");
    field(top(), "price").value = "30 gp";
    top().press("ok");
    await saving;
    await settle();
    expect(store.getBoxes().g.price).toBe(30);
    expect(status(app)).toBe("Saved Goblin Crate.");
  });
});

describe("New pool", () => {
  it("asks for the name first, focused and selected, then shows the pool open with Add from compendium focused", async () => {
    await store.savePool(POOL("a", "Armoury", 80));
    await store.savePool(POOL("b", "Baubles"));
    const app = await manager("pools");
    const button = app.element.querySelector('[data-action="addPool"]');
    const making = act(app, "addPool", button);
    await until(() => top());
    expect(top().title).toBe("New pool");
    expect(top().buttons[0].label).toBe("Make the pool");
    const name = field(top(), "name");
    expect(name.value).toBe("New pool");
    expect(name.hasAttribute("autofocus")).toBe(true);
    // Foundry focuses [autofocus]; the name is selected to type over.
    name.select = vi.fn();
    name.dispatchEvent({ type: "focus" });
    expect(name.select).toHaveBeenCalledTimes(1);
    name.value = "UX first pool";
    top().press("ok");
    const pool = await making;
    await settle();
    expect(pool.name).toBe("UX first pool");
    expect(Object.values(store.getPools()).map(p => p.name)).toEqual(["Armoury", "Baubles", "UX first pool"]);
    const details = app.element.querySelector(`.lc-pool__details[data-pool="${pool.id}"]`);
    expect(details.hasAttribute("open")).toBe(true);
    expect(document.activeElement).toBe(details.querySelector('[data-action="bulkAdd"]'));
    expect(status(app)).toBe("Made the pool UX first pool. Fill it with Add from compendium, or drop items, an Items folder or a roll table on it.");
  });

  it("makes nothing on Cancel, and focus goes back to New pool", async () => {
    const app = await manager("pools");
    const button = app.element.querySelector('[data-action="addPool"]');
    const making = act(app, "addPool", button);
    await until(() => top());
    top().press("cancel");
    await making;
    expect(Object.keys(store.getPools())).toEqual([]);
    expect(document.activeElement).toBe(button);
  });

  it("the pencil reads Rename pool, opens Rename pool with the name selected, and says what it did", async () => {
    await store.savePool(POOL("p", "Odds and ends"));
    const app = await manager("pools");
    const pencil = app.element.querySelector('[data-action="editPool"]');
    expect(pencil.getAttribute("data-tooltip")).toBe("Rename pool");
    expect(pencil.getAttribute("aria-label")).toBe("Rename Odds and ends");
    const renaming = act(app, "editPool", pencil);
    await until(() => top());
    expect(top().title).toBe("Rename pool");
    const name = field(top(), "name");
    expect(name.hasAttribute("autofocus")).toBe(true);
    name.select = vi.fn();
    name.dispatchEvent({ type: "focus" });
    expect(name.select).toHaveBeenCalled();
    name.value = "Trinkets";
    top().press("ok");
    await renaming;
    await settle();
    expect(store.getPools().p.name).toBe("Trinkets");
    expect(status(app)).toBe("Renamed the pool to Trinkets.");
  });
});

describe("the Pools tab", () => {
  it("opens with every pool collapsed but the newest, however small", async () => {
    await store.savePool(POOL("a", "Armoury", 3));
    await store.savePool(POOL("b", "Baubles", 2));
    await store.savePool(POOL("c", "Curios", 900));
    const app = await manager("pools");
    const open = [...app.element.querySelectorAll(".lc-pool__details")].filter(d => d.hasAttribute("open")).map(d => d.getAttribute("data-pool"));
    expect(open).toEqual(["c"]);
    // A collapsed pool draws no rows: the tab is its summaries.
    expect(app.element.querySelector('.lc-pool__details[data-pool="a"] .lc-entries')).toBeNull();
  });
});

describe("Add from compendium", () => {
  it("shows Types and Rarities as ticked chips, picks dnd5e's item pack, and its first button reads Preview", async () => {
    await store.savePool(POOL("p", "Odds and ends"));
    const app = await manager("pools");
    const adding = act(app, "bulkAdd", app.element.querySelector('[data-action="bulkAdd"]'));
    await until(() => top());
    const d = top();
    expect(d.title).toBe("Add from compendium");
    expect(d.buttons[0].label).toBe("Preview");
    expect(d.form.querySelector('option[value="dnd5e.items"]').hasAttribute("selected")).toBe(true);
    expect(d.form.querySelectorAll("select[multiple]")).toHaveLength(0);
    const chips = name => d.form.querySelectorAll(`input[name="${name}"]`);
    expect(chips("types").map(c => c.getAttribute("value"))).toEqual(["weapon", "equipment", "consumable", "tool", "loot", "container"]);
    expect(chips("types").filter(c => c.checked).map(c => c.getAttribute("value"))).toEqual(["weapon", "equipment", "consumable", "tool"]);
    expect(chips("rarities").filter(c => c.checked).map(c => c.getAttribute("value"))).toEqual(["uncommon", "rare", "veryRare", "legendary", "artifact"]);
    // Every chip is a labelled checkbox: its words are in sight, and a screen reader hears them.
    for (const c of [...chips("types"), ...chips("rarities")]) expect(c.closest("label").textContent.trim()).not.toBe("");
    // The GM ticks Loot and unticks Artifact, then Preview.
    chips("types").find(c => c.getAttribute("value") === "loot").checked = true;
    chips("rarities").find(c => c.getAttribute("value") === "artifact").checked = false;
    field(d, "name").value = "cloak";
    d.press("ok");
    await until(() => dialogs.length);
    expect(drops.at(-1).data).toEqual({ type: "Compendium", collection: "dnd5e.items", filter: { types: ["weapon", "equipment", "consumable", "tool", "loot"], rarities: ["uncommon", "rare", "veryRare", "legendary"], name: "cloak" } });
    // The preview is its own step, and its Add says how many.
    expect(top().title).toBe("Add to Odds and ends");
    expect(top().buttons[0].label).toBe("Add 2 items");
    top().press("add");
    await adding;
    await settle();
    expect(store.getPools().p.entries).toHaveLength(4);
    expect(status(app)).toMatch(/^Added 2 items from Items \(SRD\) to Odds and ends/);
  });
});

describe("Make a pool from a compendium, inside an empty crate editor", () => {
  it("is offered with no pool in the world, makes a pool named for the crate, ticks it, and the crate saves with it", async () => {
    const app = await manager();
    const adding = act(app, "addBox");
    await until(() => top());
    const editor = top();
    expect(editor.title).toBe("New crate");
    const offer = editor.form.querySelector("[data-make-pool]");
    expect(offer?.textContent.trim()).toBe("Make a pool from a compendium");
    field(editor, "name").value = "Goblin Crate";
    editor.form.dispatchEvent({ type: "click", target: offer });
    await until(() => dialogs.length === 2);
    expect(top().title).toBe("Add from compendium");
    top().press("ok");
    await until(() => dialogs.length === 2 && top().title !== "Add from compendium");
    expect(top().title).toBe("Add to Goblin Crate");
    top().press("add");
    await until(() => editor.form.querySelector(".lc-pool-picker__made")?.textContent);
    const pool = Object.values(store.getPools())[0];
    expect(pool).toMatchObject({ name: "Goblin Crate" });
    expect(pool.entries).toHaveLength(2);
    // Ticked, first, the offer gone with it, and said under the picker.
    const tick = editor.form.querySelector(`input[name="pool.${pool.id}"]`);
    expect(tick.hasAttribute("checked")).toBe(true);
    expect(document.activeElement).toBe(tick);
    expect(editor.form.querySelector(".lc-pool-picker__make").hasAttribute("hidden")).toBe(true);
    expect(editor.form.querySelector(".lc-pool-picker__made").textContent).toBe("Made the pool Goblin Crate with 2 items and ticked it.");
    field(editor, "price").value = "25 gp";
    editor.press("ok");
    await adding;
    await settle();
    const crate = Object.values(store.getBoxes())[0];
    expect(crate).toMatchObject({ name: "Goblin Crate", price: 25, pools: [{ id: pool.id, share: 1 }] });
  });

  it("is offered while no pool is ticked, and goes once one is", async () => {
    await store.savePool(POOL("p", "Odds and ends"));
    const app = await manager();
    act(app, "addBox");
    await until(() => top());
    const make = top().form.querySelector(".lc-pool-picker__make");
    // The world's only pool is ticked for a new crate already.
    expect(make.hasAttribute("hidden")).toBe(true);
  });

  it("makes nothing when the compendium is cancelled", async () => {
    const app = await manager();
    act(app, "addBox");
    await until(() => top());
    const editor = top();
    editor.form.dispatchEvent({ type: "click", target: editor.form.querySelector("[data-make-pool]") });
    await until(() => dialogs.length === 2);
    top().press("cancel");
    await settle();
    expect(store.getPools()).toEqual({});
    expect(document.activeElement).toBe(editor.form.querySelector("[data-make-pool]"));
  });
});

describe("Put all on the shelf, after starter crates", () => {
  it("is offered beside the status line, puts every playable starter game out in one write, and names the one kept off", async () => {
    await store.savePool(POOL("p", "Starter pool"));
    await store.setShopOpen(true);
    starter = async () => {
      const a = await store.createBox({ id: "s1", name: "Pauper's Box", price: 5, pools: [{ id: "p", share: 1 }], weights: { rare: 1 }, rules: { shelved: false } });
      const b = await store.createBox({ id: "s2", name: "Wishing Well", kind: "well", price: 0.1, pools: [{ id: "p", share: 1 }], weights: { rare: 1 }, odds: { nothing: 90, coin: 9, item: 1 }, rules: { shelved: false } });
      const c = await store.createBox({ id: "s3", name: "Empty Crate", price: 5, pools: [], weights: { rare: 1 }, rules: { shelved: false } });
      return { pools: [], games: [a, b, c], notes: [] };
    };
    const app = await manager();
    await app.addStarterCrates();
    expect(status(app)).toBe("Added 3 starter games, all off the shelf. Players can't see them yet: look each one over and press On the shelf on its row, or Put all on the shelf.");
    const all = app.element.querySelector('[data-action="shelfAll"]');
    expect(all.textContent.trim()).toBe("Put all on the shelf");
    // Beside the words, not inside the region a screen reader reads out.
    expect(all.closest(".lc-manager__statusbar")).not.toBeNull();
    expect(all.closest('[role="status"]')).toBeNull();
    const writes = vi.spyOn(store, "updateBoxes");
    await act(app, "shelfAll", all);
    expect(writes).toHaveBeenCalledTimes(1);
    const boxes = store.getBoxes();
    expect([boxes.s1, boxes.s2, boxes.s3].map(b => b.rules.shelved)).toEqual([undefined, undefined, false]);
    expect(status(app)).toBe("2 games are on the shelf now. Empty Crate can't be played yet, so it stays off the shelf.");
    expect(app.element.querySelector('[data-action="shelfAll"]')).toBeNull();
  });

  it("goes with the next thing the status line says", async () => {
    await store.savePool(POOL("p", "Starter pool"));
    starter = async () => ({ pools: [], games: [await store.createBox({ id: "s1", name: "Pauper's Box", price: 5, pools: [{ id: "p", share: 1 }], weights: { rare: 1 }, rules: { shelved: false } })], notes: [] });
    const app = await manager();
    await app.addStarterCrates();
    expect(app.element.querySelector('[data-action="shelfAll"]')).not.toBeNull();
    await act(app, "toggleShelf", { dataset: { box: "s1" } });
    expect(app.element.querySelector('[data-action="shelfAll"]')).toBeNull();
  });
});

describe("Make a ticket", () => {
  it("names the ticket, \"<game> ticket\", and its folder in the status line, and shows it in the Items sidebar", async () => {
    await store.savePool(POOL("p", "Odds and ends"));
    await store.createBox({ id: "g", name: "Goblin Crate", price: 25, pools: [{ id: "p", share: 1 }], weights: { rare: 1 }, rules: {} });
    const app = await manager();
    await act(app, "makeTicket", { dataset: { box: "g" } });
    expect(status(app)).toBe("Goblin Crate ticket is in the Items sidebar, in the folder Loot Crates tickets. Drag it onto a character's sheet, a loot sheet or a pool.");
    expect(tickets.showInItems).toHaveBeenCalledWith(made.item, { name: "Loot Crates tickets" });
    expect(notifications.info).not.toHaveBeenCalled();
  });
});

describe("the vocabulary", () => {
  it("titles each editor by the game's shop name, and a crate's as a crate", async () => {
    const { editorTitle, deleteTitle, NEW_DEFAULTS } = await import("../module/scripts/views/newgame.js");
    const titles = kind => [editorTitle({ kind }, true), editorTitle({ kind }, false), editorTitle({ kind }, true, true), deleteTitle({ kind })];
    expect(titles("crate")).toEqual(["New crate", "Edit crate", "Copy crate", "Delete crate"]);
    expect(titles("well")).toEqual(["New Wishing Well", "Edit Wishing Well", "Copy Wishing Well", "Delete Wishing Well"]);
    expect(titles("dice")).toEqual(["New Dragon's Teeth", "Edit Dragon's Teeth", "Copy Dragon's Teeth", "Delete Dragon's Teeth"]);
    expect(titles("deck")).toEqual(["New Deck of Many Things", "Edit Deck of Many Things", "Copy Deck of Many Things", "Delete Deck of Many Things"]);
    expect(titles("roulette")).toEqual(["New Roulette wheel", "Edit Roulette wheel", "Copy Roulette wheel", "Delete Roulette wheel"]);
    expect(NEW_DEFAULTS.crate().name).toBe("New crate");
  });

  it("calls the scratch ticket's bonus the bonus spot in its prize lines", async () => {
    const { prizeText } = await import("../module/scripts/games/scratch.js");
    expect(prizeText({ parts: [{ kind: "item", rarity: "rare" }, { kind: "gp", gp: 5 }, { kind: "bonus", gp: 10 }] })).toBe("Rare item + 5 gp + the bonus spot (10 gp)");
  });
});

describe("Make a crate on a roll table's menu", () => {
  it("goes straight after the table's own Draw, not last under Delete", async () => {
    const { placeMenuEntry } = await import("../module/scripts/views/route.js");
    const options = [{ label: "TABLE.ACTIONS.DrawResult" }, { label: "OWNERSHIP.Configure" }, { label: "SIDEBAR.Duplicate" }, { label: "SIDEBAR.Delete" }];
    expect(placeMenuEntry(options, { label: "Make a crate" })).toBe(1);
    expect(options.map(o => o.label)).toEqual(["TABLE.ACTIONS.DrawResult", "Make a crate", "OWNERSHIP.Configure", "SIDEBAR.Duplicate", "SIDEBAR.Delete"]);
    // v13's shape (name), and a menu with no Draw: first.
    const old = [{ name: "SIDEBAR.Edit" }, { name: "SIDEBAR.Delete" }];
    expect(placeMenuEntry(old, { name: "Make a crate" })).toBe(0);
    expect(old[0].name).toBe("Make a crate");
  });
});
