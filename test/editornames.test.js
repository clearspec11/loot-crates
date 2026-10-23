/*
  Every editor field says what it sets (editorfields.js): each input and
  select in the crate, well, dice, deck and wheel editors has an
  accessible name of its own (a label[for], a wrapping label holding only
  that control, or an aria-label), and no two in one editor are the same.
  A pool's share is named for its pool and is off while the pool is
  unticked. Plus Vex's round 17 nits: Restock in the editor is written by
  Save (Cancel leaves the stock as it was), and a copy of a copy counts on
  ("(copy 2)"). Drives the real manager into a minimal DOM, as
  neweditor.test.js does.
*/
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { createDocument } from "./minidom.js";
import { poolPicks, poolsFieldset, syncShares, pityRow, stakeRow, betRangeRow, dragonRow, field as fieldHTML, CARD_FIELDS } from "../module/scripts/editorfields.js";
import { limitsFieldset } from "../module/scripts/limits.js";

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
        save: () => done(config.buttons.find(b => b.action === "ok").callback(null, { form })),
        cancel: () => done(config.buttons.find(b => b.action === "cancel").callback() ?? "cancel"),
      };
      config.render?.({}, { element: document.body });
    });
  }
}

// FormData as a browser builds it: named inputs and selects, a ticked
// checkbox as "on", and nothing from a disabled control.
class FormDataStub {
  constructor(form) {
    this.rows = [];
    const off = el => el.disabled === true || (el.disabled === undefined && el.hasAttribute("disabled"));
    for (const el of form.querySelectorAll("input")) {
      if (!el.getAttribute("name") || off(el)) continue;
      if (el.getAttribute("type") === "checkbox") { if (el.checked) this.rows.push([el.getAttribute("name"), "on"]); continue; }
      this.rows.push([el.getAttribute("name"), el.value]);
    }
    for (const el of form.querySelectorAll("select")) if (el.getAttribute("name") && !el.hasAttribute("multiple")) this.rows.push([el.getAttribute("name"), el.value]);
  }
  entries() { return this.rows[Symbol.iterator](); }
}

class App {
  element = null;
  async render() {
    const root = await this._renderHTML();
    if (!this.element) { this.element = document.createElement("div"); document.body.appendChild(this.element); }
    this._replaceHTML(root, this.element);
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

const entry = (uuid, name, rarity) => ({ uuid, name, img: "", rarity, weight: 1 });
const POOLS = [
  { id: "core", name: "Core magic items", pools: [], entries: [entry("Item.a", "Rope", "common"), entry("Item.b", "Flame Tongue", "rare")] },
  { id: "pots", name: "Potions", pools: [], entries: [entry("Item.c", "Potion of Healing", "common")] },
  { id: "trin", name: "Trinkets", pools: [], entries: [entry("Item.d", "Bone die", "common")] },
];
// Two pools ticked (shares 2 and 1), the third not.
const REFS = [{ id: "core", share: 2 }, { id: "pots", share: 1 }];
const GAMES = {
  crate: () => newgame.newDraft("crate", { id: "crate", name: "Goblin Crate", pools: REFS, rules: { pity: { minRarity: "rare", after: 6 }, stock: 3, stockMax: 10, perCharacter: { max: 2, per: "ever" } } }),
  well: () => newgame.newDraft("well", { id: "well", name: "Old Well", pools: REFS }),
  dice: () => newgame.newDraft("dice", { id: "dice", name: "Dragon's Teeth", pools: REFS }),
  deck: () => newgame.newDraft("deck", { id: "deck", name: "Thornwick Deck", pools: REFS }),
  roulette: () => newgame.newDraft("roulette", { id: "roulette", name: "Red Wheel", pools: REFS }),
};

beforeEach(async () => {
  settings = new Map();
  sets = 0;
  store.registerSettings();
  for (const p of POOLS) await store.savePool(p);
  for (const make of Object.values(GAMES)) await store.saveBox(make());
  sets = 0;
  store.createBox.mockClear();
  store.updateBox.mockClear();
  document.body.replaceChildren();
  document.activeElement = document.body;
});

const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 2)); };
const act = (app, name, target = {}) => CrateManager.DEFAULT_OPTIONS.actions[name].call(app, {}, target);
async function manager() {
  const app = new CrateManager();
  app.tab = "boxes";
  await app.render();
  return app;
}
// The open editor's promise, wrapped so awaiting the opening doesn't wait for the close.
async function openEdit(app, id) {
  const pending = act(app, "editBox", { dataset: { box: id } });
  await settle(2);
  return [pending];
}
const field = name => dialog.form.querySelector(`[name="${name}"]`);

/*
  A control's accessible name, as the HTML-AAM gives it for these three
  sources only: aria-label, a label[for] its id, or a wrapping label
  holding no other control (a label names only its first control, so a
  label with two names neither well: the check refuses it). A label's
  words leave out the control itself and anything aria-hidden.
*/
const isControl = el => (el.nodeName === "INPUT" && el.getAttribute("type") !== "hidden") || el.nodeName === "SELECT" || el.nodeName === "TEXTAREA";
const controlsIn = root => [...root.querySelectorAll("input"), ...root.querySelectorAll("select"), ...root.querySelectorAll("textarea")].filter(isControl);
function words(node, skip) {
  if (node === skip) return "";
  if (node.nodeType === 3) return node.nodeValue;
  if (node.getAttribute("aria-hidden") === "true") return "";
  return node.childNodes.map(n => words(n, skip)).join("");
}
const tidy = s => s.replace(/\s+/g, " ").trim();
function accessibleName(el, root) {
  const aria = tidy(el.getAttribute("aria-label") ?? "");
  if (aria) return aria;
  const id = el.getAttribute("id");
  const byFor = id ? root.querySelectorAll("label").find(l => l.getAttribute("for") === id) : null;
  if (byFor) return tidy(words(byFor, el));
  const wrap = el.closest("label");
  if (wrap && controlsIn(wrap).length === 1) return tidy(words(wrap, el));
  return "";
}
const namesOf = root => controlsIn(root).map(el => ({ field: el.getAttribute("name"), name: accessibleName(el, root) }));

describe("every editor field has a name of its own", () => {
  for (const kind of Object.keys(GAMES)) {
    it(`${kind}: every input and select is named, and no two names are the same`, async () => {
      const app = await manager();
      const [pending] = await openEdit(app, kind);
      const names = namesOf(dialog.form);
      expect(names.length).toBeGreaterThan(5);
      const unnamed = names.filter(n => !n.name).map(n => n.field);
      expect(unnamed).toEqual([]);
      const seen = new Map();
      const twice = names.filter(n => { const dup = seen.has(n.name); seen.set(n.name, n.field); return dup; }).map(n => `${n.field}: ${n.name}`);
      expect(twice).toEqual([]);
      // Nothing is just "Share", or a placeholder standing in for a name.
      for (const n of names) expect(n.name).not.toMatch(/^(Share|any|)$/);
      dialog.cancel();
      await pending;
      await settle();
      expect(sets).toBe(0);
    });
  }

  it("names each pool's share for its pool, and the pool's checkbox for the pool alone", async () => {
    const app = await manager();
    const [pending] = await openEdit(app, "crate");
    const name = n => accessibleName(field(n), dialog.form);
    expect(name("pool.core")).toBe("Core magic items");
    expect(name("share.core")).toBe("Share of pulls from Core magic items");
    expect(name("share.trin")).toBe("Share of pulls from Trinkets");
    expect(name("pityRarity")).toBe("Pity: guarantee");
    expect(name("pityAfter")).toBe("Pulls before the guarantee");
    expect(name("limitMax")).toBe("Each character may buy");
    expect(name("limitPer")).toBe("How often");
    dialog.cancel();
    await pending;
  });

  it("names the well's pity count in throws, the stake and its coin, and the wheel's two bounds", async () => {
    const app = await manager();
    let [pending] = await openEdit(app, "well");
    expect(accessibleName(field("pityAfter"), dialog.form)).toBe("Throws before the guarantee");
    expect(accessibleName(field("stake"), dialog.form)).toBe("Stake");
    expect(accessibleName(field("coin"), dialog.form)).toBe("Coin");
    dialog.cancel();
    await pending;
    [pending] = await openEdit(app, "roulette");
    expect(accessibleName(field("price"), dialog.form)).toBe("Smallest bet in gp");
    expect(accessibleName(field("maxStake"), dialog.form)).toBe("Largest bet in gp, blank for any");
    expect(accessibleName(field("pool.pots"), dialog.form)).toBe("Potions");
    dialog.cancel();
    await pending;
    [pending] = await openEdit(app, "dice");
    expect(accessibleName(field("formula"), dialog.form)).toBe("Roll");
    expect(accessibleName(field("target"), dialog.form)).toBe("The dragon's number");
    dialog.cancel();
    await pending;
  });

  it("numbers the deck's card fields, and renumbers them when a card is removed", async () => {
    const app = await manager();
    const [pending] = await openEdit(app, "deck");
    const rows = dialog.form.querySelector(".lc-cards__rows");
    const weights = () => rows.querySelectorAll(".lc-card-row__weight").map(el => el.getAttribute("aria-label"));
    const n = rows.children.length;
    expect(n).toBeGreaterThan(2);
    expect(weights()).toEqual(Array.from({ length: n }, (_, i) => `Weight of card ${i + 1}`));
    const remove = rows.children[0].querySelector(".lc-card-row__remove");
    dialog.form.dispatchEvent({ type: "click", target: remove });
    expect(weights()).toEqual(Array.from({ length: n - 1 }, (_, i) => `Weight of card ${i + 1}`));
    expect(rows.children[0].querySelector(".lc-card-row__once input").getAttribute("aria-label")).toBe("Card 1 once per deck");
    dialog.form.querySelector(".lc-cards__add").dispatchEvent({ type: "click" });
    expect(rows.children.at(-1).querySelector(".lc-card-row__label").getAttribute("aria-label")).toBe(`Name of card ${n}`);
    const names = namesOf(dialog.form).map(x => x.name);
    expect(new Set(names).size).toBe(names.length);
    dialog.cancel();
    await pending;
  });
});

describe("a pool's share is off while the pool is unticked", () => {
  it("opens with the unticked pool's share off and the ticked ones on", async () => {
    const app = await manager();
    const [pending] = await openEdit(app, "crate");
    expect(field("share.core").disabled).toBe(false);
    expect(field("share.pots").disabled).toBe(false);
    expect(field("share.trin").disabled).toBe(true);
    dialog.cancel();
    await pending;
  });

  for (const kind of ["crate", "well", "dice", "deck"]) {
    it(`${kind}: unticking a pool turns its share off, ticking it turns it on, and Save reads only ticked pools`, async () => {
      const app = await manager();
      const [pending] = await openEdit(app, kind);
      const core = field("pool.core");
      core.checked = false;
      dialog.form.dispatchEvent({ type: "change", target: core });
      expect(field("share.core").disabled).toBe(true);
      expect(field("share.pots").disabled).toBe(false);
      const trin = field("pool.trin");
      trin.checked = true;
      dialog.form.dispatchEvent({ type: "input", target: trin });
      expect(field("share.trin").disabled).toBe(false);
      field("share.trin").value = "3";
      dialog.save();
      await pending;
      await settle();
      expect(store.getBoxes()[kind].pools).toEqual([{ id: "pots", share: 1 }, { id: "trin", share: 3 }]);
    });
  }

  it("syncShares follows each checkbox (pure, on the markup alone)", () => {
    const form = document.createElement("div");
    form.innerHTML = poolsFieldset("Pools", POOLS, REFS);
    const share = id => form.querySelector(`input[data-share="${id}"]`);
    expect(share("trin").hasAttribute("disabled")).toBe(true);
    expect(share("core").hasAttribute("disabled")).toBe(false);
    form.querySelector('input[name="pool.core"]').checked = false;
    form.querySelector('input[name="pool.trin"]').checked = true;
    syncShares(form);
    expect(share("core").disabled).toBe(true);
    expect(share("trin").disabled).toBe(false);
    expect(share("pots").disabled).toBe(false);
  });
});

describe("the shared field markup", () => {
  it("puts one control in each label", () => {
    const root = document.createElement("div");
    root.innerHTML = [
      poolPicks(POOLS, REFS),
      poolPicks(POOLS, REFS, { share: false }).replace(/name="pool\./g, 'name="wheelpool.'),
      pityRow({ minRarity: "rare", after: 4 }),
      stakeRow({ amount: 5, coin: "sp" }),
      betRangeRow(1, null),
      dragonRow(["2d6", "3d6"], { formula: "3d6", target: 10 }),
      limitsFieldset({ id: "b", rules: { stock: 3, stockMax: 10 } }),
      fieldHTML("Name", '<input name="name">'),
    ].join("");
    for (const label of root.querySelectorAll("label")) expect(controlsIn(label).length).toBeLessThanOrEqual(1);
    const names = namesOf(root);
    expect(names.filter(n => !n.name)).toEqual([]);
    expect(root.querySelector('input[name="maxStake"]').getAttribute("placeholder")).toBe("any");
    expect(root.querySelector('input[name="pityAfter"]').getAttribute("value")).toBe("4");
    expect(root.querySelector('select[name="pityRarity"]').value).toBe("rare");
    expect(root.querySelector('select[name="coin"]').value).toBe("sp");
  });

  it("says when there are no pools", () => {
    expect(poolPicks([], [])).toBe("<p>No pools yet.</p>");
  });

  it("names every card field by the card's place", () => {
    expect(Object.values(CARD_FIELDS).map(f => f(3))).toEqual(["Name of card 3", "What card 3 does", "Gold pieces for card 3", "Weight of card 3", "Card 3 once per deck", "Effect text of card 3"]);
  });
});

describe("Restock in the editor is written by Save", () => {
  it("Restock then Cancel: the line says what Save would leave, and the stock is as it was", async () => {
    const app = await manager();
    const [pending] = await openEdit(app, "crate");
    const left = dialog.form.querySelector(".lc-limits__left");
    expect(left.textContent).toBe("3 of 10 left");
    const restock = dialog.form.querySelector("[data-restock]");
    restock.dispatchEvent({ type: "click" });
    expect(left.textContent).toBe("10 of 10 left once you save");
    expect(restock.getAttribute("aria-disabled")).toBe("true");
    await settle();
    expect(sets).toBe(0);
    expect(store.updateBox).not.toHaveBeenCalled();
    dialog.cancel();
    await pending;
    await settle();
    expect(sets).toBe(0);
    expect(store.getBoxes().crate.rules).toMatchObject({ stock: 3, stockMax: 10 });
  });

  it("Restock then Save fills the stock to the GM's number", async () => {
    const app = await manager();
    const [pending] = await openEdit(app, "crate");
    dialog.form.querySelector("[data-restock]").dispatchEvent({ type: "click" });
    dialog.save();
    await pending;
    await settle();
    expect(store.updateBox).toHaveBeenCalledTimes(1);
    expect(store.getBoxes().crate.rules).toMatchObject({ stock: 10, stockMax: 10 });
  });

  it("Restock with a new number fills to that number at Save, and says so", async () => {
    const app = await manager();
    const [pending] = await openEdit(app, "crate");
    field("stock").value = "12";
    dialog.form.querySelector("[data-restock]").dispatchEvent({ type: "click" });
    expect(dialog.form.querySelector(".lc-limits__left").textContent).toBe("12 of 12 left once you save");
    dialog.save();
    await pending;
    await settle();
    expect(store.getBoxes().crate.rules).toMatchObject({ stock: 12, stockMax: 12 });
  });

  it("Save without Restock keeps the stock pulls left", async () => {
    const app = await manager();
    const [pending] = await openEdit(app, "crate");
    dialog.save();
    await pending;
    await settle();
    expect(store.getBoxes().crate.rules).toMatchObject({ stock: 3, stockMax: 10 });
  });
});

describe("Copy names count on", () => {
  it("a copy of '<name> (copy)' opens as '<name> (copy 2)', and a second copy of the original skips the taken name", async () => {
    await store.saveBox({ ...GAMES.crate(), id: "c1", name: "Goblin Crate (copy)" });
    const app = await manager();
    let pending = act(app, "copyBox", { dataset: { box: "c1" } });
    await settle(2);
    expect(field("name").value).toBe("Goblin Crate (copy 2)");
    dialog.cancel();
    await pending;
    pending = act(app, "copyBox", { dataset: { box: "crate" } });
    await settle(2);
    expect(field("name").value).toBe("Goblin Crate (copy 2)");
    dialog.save();
    await pending;
    await settle();
    pending = act(app, "copyBox", { dataset: { box: "crate" } });
    await settle(2);
    expect(field("name").value).toBe("Goblin Crate (copy 3)");
    dialog.cancel();
    await pending;
  });
});
