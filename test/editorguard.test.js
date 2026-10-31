/*
  The editors' guard rails (round 30, B1): no edit is lost to Cancel, the
  window's X or Escape, and no game that can't be played reaches the shelf.

  First the dialog itself (foundry/editordialog.js guardDialog) on a
  stand-in that behaves as DialogV2 does: Cancel runs its callback, then
  the `submit` that resolves DialogV2.wait, then close({ submitted: true });
  X and Escape call close(). Then the real manager's editors on that same
  stand-in, with the real store writing to a stubbed world setting: the
  discard prompt, Save off the shelf, the stock refused below 0, the price
  of 0 asked once.
*/
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { createDocument } from "./minidom.js";
import { guardDialog } from "../module/scripts/foundry/editordialog.js";

vi.mock("../module/scripts/foundry/shop.js", () => ({ refreshShop: vi.fn() }));
vi.mock("../module/scripts/foundry/chat.js", () => ({ postRefundCard: vi.fn() }));
vi.mock("../module/scripts/foundry/store.js", async importOriginal => {
  const orig = await importOriginal();
  return { ...orig, checkSources: async entries => new Map(entries.map(e => [e.uuid, { name: e.name, img: e.img, rarity: e.rarity }])), sweepPools: async () => [] };
});

/*
  DialogV2 as far as the guard meets it (foundry.mjs, v14): wait() builds
  the dialog, resolves on `submit` or on close (null); _onSubmit runs the
  button's callback (or its action name), submit, then close({ submitted:
  true }); Escape and the header's X call close(). Its confirm answers
  from `answers` (Keep editing, the default, when none is queued) and
  keeps what it was asked.
*/
let open = null;
class FakeDialog {
  static asked = [];
  static answers = [];
  static async confirm(config) { FakeDialog.asked.push(config); return FakeDialog.answers.length ? FakeDialog.answers.shift() : false; }
  static wait(config) {
    return new Promise(resolve => {
      const submit = config.submit;
      const dialog = new this({ ...config, submit: async (result, d) => { await submit?.(result, d); resolve(result); } });
      dialog.addEventListener("close", () => resolve(null));
      if (config.render) dialog.addEventListener("render", e => config.render(e, dialog));
      dialog.render({ force: true });
    });
  }
  constructor(config) {
    this.options = { ...config, buttons: Object.fromEntries(config.buttons.map(b => [b.action, b])) };
    this.listeners = {};
    this.rendered = false;
    this.closes = 0;
    open = this;
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  emit(type) { for (const fn of this.listeners[type] ?? []) fn({ type }); }
  async render() {
    this.element = document.createElement("dialog");
    const buttons = Object.values(this.options.buttons).map(b => `<button type="submit" data-action="${b.action}"><span>${b.label}</span></button>`).join("");
    this.element.innerHTML = `<form><div class="dialog-content">${this.options.content ?? ""}</div><footer class="form-footer">${buttons}</footer></form>`;
    document.body.appendChild(this.element);
    this.rendered = true;
    this.emit("render");
    return this;
  }
  async _onSubmit(target, event) {
    event?.preventDefault?.();
    const button = this.options.buttons[target?.dataset.action];
    const result = (await button?.callback?.(event, target, this)) ?? button?.action;
    await this.options.submit?.(result, this);
    return this.close({ submitted: true });
  }
  async close() {
    if (!this.rendered) return this;
    this.rendered = false;
    this.closes++;
    this.element.remove();
    this.emit("close");
    return this;
  }
  _onKeyDown(event) { if (event.key === "Escape") { event.preventDefault?.(); this.close(); } }
  // What a GM does: press a footer button, press Escape, click the header's X.
  press(action) { return this._onSubmit(this.element.querySelector(`button[data-action="${action}"]`), { preventDefault() {} }); }
  escape() { return this._onKeyDown({ key: "Escape", preventDefault() {} }); }
  clickX() { return this.close(); }
}

const tick = (n = 4) => new Promise(r => { let i = 0; const go = () => (++i >= n ? r() : setTimeout(go, 1)); setTimeout(go, 1); });

describe("guardDialog: Cancel, X and Escape ask only once something changed", () => {
  const Guarded = guardDialog(FakeDialog);
  let changed, discards, saves;
  const guarded = (answer = false, { beforeSave = null } = {}) => {
    changed = false;
    discards = 0;
    saves = 0;
    const result = Guarded.wait({
      window: { title: "Edit crate" },
      content: `<div class="lc-form"><input name="price" value="25 gp"></div>`,
      buttons: [{ action: "ok", label: "Save", default: true, callback: () => ({ saved: true }) }, { action: "cancel", label: "Cancel", callback: () => null }],
      render: (_e, dialog) => { dialog.lcGuard = { dirty: () => changed, discard: async () => { discards++; return answer; }, ...(beforeSave ? { beforeSave: async () => { saves++; return beforeSave(); } } : {}) }; },
    });
    return { dialog: open, result };
  };

  for (const [how, act] of [["Cancel", d => d.press("cancel")], ["X", d => d.clickX()], ["Escape", d => d.escape()]]) {
    // Cancel resolves its action's name, as DialogV2 does; X and Escape null.
    const closed = how === "Cancel" ? "cancel" : null;
    it(`${how} with nothing changed closes at once, no question`, async () => {
      const { dialog, result } = guarded();
      await act(dialog);
      await tick();
      expect(discards).toBe(0);
      expect(dialog.rendered).toBe(false);
      expect(await result).toBe(closed);
    });

    it(`${how} with a change asks; Keep editing keeps the form open and the promise waiting`, async () => {
      const { dialog, result } = guarded(false);
      changed = true;
      await act(dialog);
      await tick();
      expect(discards).toBe(1);
      expect(dialog.rendered).toBe(true);
      expect(dialog.closes).toBe(0);
      expect(await Promise.race([result.then(() => "settled"), tick().then(() => "waiting")])).toBe("waiting");
      // Save still works afterwards.
      await dialog.press("ok");
      expect(await result).toEqual({ saved: true });
    });

    it(`${how} with a change asks; Discard closes and saves nothing`, async () => {
      const { dialog, result } = guarded(true);
      changed = true;
      await act(dialog);
      await tick();
      expect(discards).toBe(1);
      expect(dialog.rendered).toBe(false);
      expect(dialog.closes).toBe(1);
      expect(await result).toBe(closed);
    });
  }

  it("asks once for a second Escape while the question is up", async () => {
    let release;
    changed = true;
    const result = Guarded.wait({
      window: { title: "Edit crate" }, content: "<div class=\"lc-form\"></div>",
      buttons: [{ action: "ok", label: "Save", callback: () => ({}) }, { action: "cancel", label: "Cancel", callback: () => null }],
      render: (_e, dialog) => { dialog.lcGuard = { dirty: () => true, discard: () => { discards++; return new Promise(r => { release = r; }); } }; },
    });
    discards = 0;
    const dialog = open;
    dialog.escape();
    dialog.escape();
    dialog.press("cancel");
    await tick();
    expect(discards).toBe(1);
    // The first Escape's question: Discard closes it.
    release(true);
    expect(await result).toBeNull();
    expect(open.closes).toBe(1);
  });

  it("Save waits for beforeSave: false keeps the dialog open, true saves", async () => {
    let allow = false;
    const { dialog, result } = guarded(false, { beforeSave: () => allow });
    await dialog.press("ok");
    expect(saves).toBe(1);
    expect(dialog.rendered).toBe(true);
    allow = true;
    await dialog.press("ok");
    expect(await result).toEqual({ saved: true });
  });

  it("a dialog with no guard is DialogV2 as it is", async () => {
    const result = Guarded.wait({ window: { title: "Edit" }, content: "<p></p>", buttons: [{ action: "ok", label: "Save", callback: () => ({ ok: 1 }) }, { action: "cancel", label: "Cancel", callback: () => null }] });
    await open.escape();
    expect(await result).toBeNull();
  });
});

/* ---------- The manager's editors on the stand-in ---------- */

class FormDataStub {
  constructor(form) {
    this.rows = [];
    for (const el of form.querySelectorAll("input")) {
      if (!el.getAttribute("name") || el.disabled) continue;
      if (el.getAttribute("type") === "checkbox") { if (el.checked) this.rows.push([el.getAttribute("name"), "on"]); continue; }
      if (el.getAttribute("type") === "radio") { if (el.checked) this.rows.push([el.getAttribute("name"), el.value]); continue; }
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

let settings;
const notifications = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let CrateManager, store, shelf;
beforeAll(async () => {
  vi.stubGlobal("document", createDocument());
  vi.stubGlobal("CSS", { escape: s => String(s) });
  vi.stubGlobal("FormData", FormDataStub);
  vi.stubGlobal("ui", { notifications });
  vi.stubGlobal("foundry", {
    utils: { escapeHTML: s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"), deepClone: v => structuredClone(v), randomID: n => Math.random().toString(36).slice(2, 2 + (n ?? 10)) },
    applications: { api: { ApplicationV2: App, DialogV2: FakeDialog } },
  });
  vi.stubGlobal("game", { user: { isGM: true }, settings: {
    register: (_m, key, cfg) => settings.set(key, cfg.default),
    get: (_m, key) => settings.get(key),
    set: async (_m, key, v) => { await new Promise(r => setTimeout(r, 1)); settings.set(key, structuredClone(v)); },
  } });
  store = await import("../module/scripts/foundry/store.js");
  shelf = await import("../module/scripts/core/shelf.js");
  ({ CrateManager } = await import("../module/scripts/foundry/manager.js"));
});
afterAll(() => vi.unstubAllGlobals());

const POOL = { id: "p", name: "Odds and ends", pools: [], entries: [{ uuid: "Item.a", name: "Rope", img: "", rarity: "common", weight: 1 }, { uuid: "Item.b", name: "Flame Tongue", img: "", rarity: "rare", weight: 1 }] };
const OTHER = { id: "q", name: "Empty shelf", pools: [], entries: [] };
const CRATE = { id: "c1", name: "Goblin Crate", price: 25, pools: [{ id: "p", share: 1 }], weights: {}, rules: { stock: 3, stockMax: 10 } };
beforeEach(async () => {
  settings = new Map();
  store.registerSettings();
  await store.savePool(POOL);
  await store.savePool(OTHER);
  await store.saveBox(CRATE);
  for (const fn of Object.values(notifications)) fn.mockClear();
  FakeDialog.asked = [];
  FakeDialog.answers = [];
  open = null;
  document.body.replaceChildren();
  document.activeElement = document.body;
});

const act = (app, name, target = {}) => CrateManager.DEFAULT_OPTIONS.actions[name].call(app, {}, target);
async function manager() {
  const app = new CrateManager();
  app.tab = "boxes";
  await app.render();
  return app;
}
const field = name => open.element.querySelector(`[name="${name}"]`);
const okWords = () => open.element.querySelector('button[data-action="ok"]').textContent;
const okOff = () => !!open.element.querySelector('button[data-action="ok"]').disabled;
const form = () => open.element.querySelector("form");
const type = (name, value, event = "input") => { const el = field(name); el.value = value; el.dispatchEvent({ type: event }); form().dispatchEvent({ type: event, target: el }); };
const tickBox = (name, on) => { const el = field(name); el.checked = on; el.dispatchEvent({ type: "change" }); form().dispatchEvent({ type: "change", target: el }); };
const status = app => app.element.querySelector(".lc-manager__status").textContent;

// Opens Edit on the crate; resolves to [the editor's promise] once it is up.
async function editCrate(app) {
  const pending = act(app, "editBox", { dataset: { box: "c1" } });
  await tick();
  return [pending];
}

describe("the editors ask before throwing a change away", () => {
  it("Escape on an edited price asks to discard it; Keep editing keeps the price; Cancel then Discard closes and the price is unchanged", async () => {
    const app = await manager();
    const [pending] = await editCrate(app);
    const dialog = open;
    type("price", "40 gp");
    dialog.escape();
    await tick();
    expect(FakeDialog.asked.map(c => [c.window.title, c.content, c.no.default, c.no.label, c.yes.label])).toEqual([["Discard changes?", "<p>Discard your changes to <strong>Goblin Crate</strong>? Nothing you changed has been saved.</p>", true, "Keep editing", "Discard"]]);
    // Keep editing (the default) leaves the form as it was.
    expect(dialog.rendered).toBe(true);
    expect(field("price").value).toBe("40 gp");
    FakeDialog.answers = [true];
    await dialog.press("cancel");
    await pending;
    expect(FakeDialog.asked).toHaveLength(2);
    expect(dialog.rendered).toBe(false);
    expect(store.getBoxes().c1.price).toBe(25);
  });

  it("the window's X asks too, and with nothing changed Cancel, X and Escape close at once", async () => {
    const app = await manager();
    let [pending] = await editCrate(app);
    open.clickX();
    await pending;
    [pending] = await editCrate(app);
    open.escape();
    await pending;
    [pending] = await editCrate(app);
    await open.press("cancel");
    await pending;
    expect(FakeDialog.asked).toEqual([]);
    [pending] = await editCrate(app);
    type("stock", "12");
    open.clickX();
    await tick();
    expect(FakeDialog.asked).toHaveLength(1);
    FakeDialog.answers = [true];
    open.clickX();
    await pending;
    expect(store.getBoxes().c1.rules).toMatchObject({ stock: 3, stockMax: 10 });
  });

  it("a change put back as it was asks nothing", async () => {
    const app = await manager();
    const [pending] = await editCrate(app);
    type("price", "40 gp");
    type("price", "25 gp");
    open.escape();
    await pending;
    expect(FakeDialog.asked).toEqual([]);
  });

  it("names a new game by what the GM typed, and guards the pool's rename", async () => {
    const app = await manager();
    let pending = act(app, "addDice");
    await tick();
    type("name", "Bones of the Dragon");
    open.escape();
    await tick();
    expect(FakeDialog.asked[0].content).toContain("<strong>Bones of the Dragon</strong>");
    FakeDialog.answers = [true];
    open.escape();
    await pending;
    expect(Object.values(store.getBoxes()).map(b => b.name)).toEqual(["Goblin Crate"]);
    pending = act(app, "editPool", { dataset: { pool: "p" } });
    await tick();
    type("name", "Junk");
    open.escape();
    await tick();
    expect(FakeDialog.asked.at(-1).content).toContain("<strong>Odds and ends</strong>");
    await open.press("ok");
    await pending;
    expect(store.getPools().p.name).toBe("Junk");
  });
});

describe("a game that can't be played saves off the shelf", () => {
  it("New crate with no pool: Save off the shelf, the box off with the reason; ticking a pool brings Add to shelf back", async () => {
    const app = await manager();
    const pending = act(app, "addBox");
    await tick();
    expect(okWords()).toBe("Save off the shelf");
    expect(field("onShelf").checked).toBe(false);
    expect(field("onShelf").disabled).toBe(true);
    const why = open.element.querySelector("[data-shelf-why]");
    expect(why.textContent).toBe("This crate can drop nothing: tick a pool above.");
    expect(field("onShelf").getAttribute("aria-describedby")).toBe(why.id);
    tickBox("pool.p", true);
    expect(okWords()).toBe("Add to shelf");
    expect(field("onShelf").checked).toBe(true);
    expect(field("onShelf").disabled).toBe(false);
    expect(why.textContent).toBe("");
    // The GM's own choice comes back when the game can't be played again and then can.
    tickBox("onShelf", false);
    expect(okWords()).toBe("Add");
    tickBox("pool.p", false);
    expect(okWords()).toBe("Save off the shelf");
    tickBox("pool.p", true);
    expect(field("onShelf").checked).toBe(false);
    tickBox("onShelf", true);
    tickBox("pool.p", false);
    type("name", "Empty Crate");
    await open.press("ok");
    await pending;
    await tick();
    const made = Object.values(store.getBoxes()).find(b => b.name === "Empty Crate");
    expect(made.rules.shelved).toBe(false);
    // A player's shop leaves it out.
    expect(shelf.shelfFor(Object.values(store.getBoxes())).map(b => b.name)).toEqual(["Goblin Crate"]);
    expect(status(app)).toBe("Empty Crate added off the shelf. This crate can drop nothing: tick a pool above.");
  });

  it("an edit that leaves a game on the shelf unplayable saves it off the shelf, and the status says why", async () => {
    const app = await manager();
    const [pending] = await editCrate(app);
    expect(okWords()).toBe("Save");
    tickBox("pool.p", false);
    expect(okWords()).toBe("Save off the shelf");
    await open.press("ok");
    await pending;
    await tick();
    expect(store.getBoxes().c1.rules.shelved).toBe(false);
    expect(status(app)).toBe("Goblin Crate is saved off the shelf. This crate can drop nothing: tick a pool above.");
  });

  it("the save path holds even when the form's box says on the shelf", async () => {
    const app = await manager();
    const [pending] = await editCrate(app);
    // A form whose box was left ticked and on (as a stale form could be).
    tickBox("pool.p", false);
    field("onShelf").disabled = false;
    field("onShelf").checked = true;
    await open.press("ok");
    await pending;
    expect(store.getBoxes().c1.rules.shelved).toBe(false);
  });

  it("New auction with no lot, and New scratch ticket with no pool for its Rare item, save off the shelf", async () => {
    const app = await manager();
    for (const [action, why] of [["addAuction", "Pick a lot: an auction with none can't be opened."], ["addScratch", "Tick a pool for the item prizes, or those tickets can't be sold."]]) {
      const pending = act(app, action);
      await tick();
      expect(okWords()).toBe("Save off the shelf");
      expect(open.element.querySelector("[data-shelf-why]").textContent).toBe(why);
      await open.press("ok");
      await pending;
    }
    expect(Object.values(store.getBoxes()).filter(b => b.kind).map(b => [b.kind, b.rules.shelved])).toEqual([["auction", false], ["scratch", false]]);
  });
});

describe("stock below 0 is refused in the editor", () => {
  it("-3 says so under the field and turns Save off; 10 turns it on, and the line says what Save will leave", async () => {
    const app = await manager();
    const [pending] = await editCrate(app);
    const left = open.element.querySelector(".lc-limits__left");
    const why = open.element.querySelector("[data-stock-why]");
    expect(left.textContent).toBe("3 of 10 left");
    type("stock", "-3");
    expect(why.textContent).toBe("Stock can't be below 0. Leave it blank for unlimited.");
    expect(field("stock").getAttribute("aria-invalid")).toBe("true");
    expect(field("stock").getAttribute("aria-describedby")).toContain(why.id);
    expect(okOff()).toBe(true);
    expect(left.textContent).toBe("3 of 10 left");
    type("stock", "12");
    expect(why.textContent).toBe("");
    expect(okOff()).toBe(false);
    expect(left.textContent).toBe("5 of 12 left once you save");
    // A price that can't be read keeps Save off on its own say.
    type("price", "lots");
    type("stock", "-1");
    type("stock", "12");
    expect(okOff()).toBe(true);
    type("price", "30 gp");
    expect(okOff()).toBe(false);
    await open.press("ok");
    await pending;
    expect(store.getBoxes().c1.rules).toMatchObject({ stock: 5, stockMax: 12 });
  });

  it("a new crate's stock line follows the field: 10 of 10 once you save", async () => {
    const app = await manager();
    const pending = act(app, "addBox");
    await tick();
    const left = open.element.querySelector(".lc-limits__left");
    expect(left.textContent).toBe("Unlimited");
    type("stock", "10");
    expect(left.textContent).toBe("10 of 10 left once you save");
    FakeDialog.answers = [true];
    open.escape();
    await pending;
  });
});

describe("a price of 0 asks once", () => {
  it("Free to play? Set a price keeps the editor open on the price; Keep it free saves at 0 and asks no more", async () => {
    const app = await manager();
    const [pending] = await editCrate(app);
    type("price", "0");
    await open.press("ok");
    expect(FakeDialog.asked.map(c => [c.window.title, c.content, c.yes.label, c.no.label, c.no.default])).toEqual([["Free to play?", "<p><strong>Goblin Crate</strong> costs nothing, so players can play it for free as often as its limits allow.</p>", "Keep it free", "Set a price", true]]);
    expect(open.rendered).toBe(true);
    expect(document.activeElement).toBe(field("price"));
    FakeDialog.answers = [true];
    await open.press("ok");
    await pending;
    expect(store.getBoxes().c1.price).toBe(0);
    // Already free: an edit doesn't ask again.
    const [again] = await editCrate(app);
    await open.press("ok");
    await again;
    expect(FakeDialog.asked).toHaveLength(2);
  });

  it("asks nothing for a price above 0", async () => {
    const app = await manager();
    const [pending] = await editCrate(app);
    type("price", "30 gp");
    await open.press("ok");
    await pending;
    expect(FakeDialog.asked).toEqual([]);
    expect(store.getBoxes().c1.price).toBe(30);
  });
});
