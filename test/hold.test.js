/*
  The result is held until this client's spin lands, in the sheet and the
  shop as in chat. The GM creates the item before the reveal goes out and
  writes the buyer's pity record just after, so without a hold an open sheet
  listed the item and the buyer's shop redrew its pity line seconds before
  the marker stopped. Real reveal.js and shop.js on a minimal DOM; the spin
  is the real one, driven frame by frame.
*/
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createDocument } from "./minidom.js";
import { POOLS, BOXES } from "../harness/sample.js";

vi.mock("../module/scripts/sound.js", () => ({ playTick: vi.fn(), playSlow: vi.fn(), playReveal: vi.fn() }));
const boxes = Object.fromEntries(BOXES.map(b => [b.id, b]));
// The world setting, as the GM's write leaves it.
let states = {};
vi.mock("../module/scripts/store.js", () => ({ getBoxes: () => boxes, getPools: () => POOLS, getLog: () => [], getRounds: () => ({}), todayKey: () => null, isShopOpen: () => true, getActorState: (a, b) => states[`${a}.${b}`] ?? {} }));
vi.mock("../module/scripts/socket.js", () => ({ requestPull: vi.fn(async () => ({})) }));

const fakeElement = () => ({
  className: "", textContent: "", innerHTML: "", clientWidth: 600, dataset: {}, children: [], hidden: false,
  classList: { add() {}, remove() {} },
  style: { transform: "", setProperty() {} },
  setAttribute() {},
  append(...kids) { this.children.push(...kids); },
  appendChild(kid) { this.children.push(kid); },
  replaceChildren() {},
  focus() {},
  contains: () => false,
});

// ApplicationV2 stand-in. A reveal renders into fake parts (as in
// reveal.test.js); the shop keeps its last rendered markup and counts renders.
class FakeApp {
  constructor(options = {}) { this.options = { ...this.constructor.DEFAULT_OPTIONS, ...options }; this.state = 0; this.renders = 0; }
  get rendered() { return this.state > 0; }
  async render() {
    this.renders++;
    const html = await this._renderHTML();
    this.state = 1;
    if (!this.options.classes?.includes("lc-reveal")) { this.html = html; return this; }
    if (this.options.id) globalThis.foundry.applications.instances.set(this.options.id, this);
    const parts = new Map();
    this.element = { querySelector: sel => parts.get(sel) ?? parts.set(sel, fakeElement()).get(sel), contains: el => [...parts.values()].includes(el) };
    this._replaceHTML(html, fakeElement());
    this._onRender();
    return this;
  }
  _onClose() {}
  close() { this.state = 0; globalThis.foundry.applications.instances.delete(this.options.id); this._onClose({}); }
}

let frames, doc;
const stubs = () => {
  vi.stubGlobal("foundry", { applications: { api: { ApplicationV2: FakeApp }, instances: new Map() }, utils: { escapeHTML: s => String(s) } });
};
stubs();
const actor = { id: "a1", type: "character", name: "Tam", system: { currency: { gp: 900 } }, testUserPermission: () => true };
const actors = [actor];
actors.get = id => actors.find(a => a.id === id);

beforeEach(() => {
  frames = [];
  doc = createDocument();
  const make = doc.createElement;
  // The spin sets a transform and two custom properties on its track.
  doc.createElement = tag => Object.assign(make(tag), { style: { transform: "", setProperty() {} } });
  doc.visibilityState = "visible";
  doc.addEventListener = () => {};
  doc.removeEventListener = () => {};
  stubs();
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", { innerWidth: 1440, innerHeight: 900 });
  vi.stubGlobal("requestAnimationFrame", cb => frames.push(cb));
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("ui", { notifications: { warn: vi.fn() } });
  vi.stubGlobal("game", { user: { id: "u", isGM: false, character: actor }, actors, users: { activeGM: { id: "gm" } }, settings: { get: () => false } });
  vi.stubGlobal("fromUuidSync", () => null);
  states = {};
});
afterEach(() => {
  _resetHolds();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const { showReveal, showReplay, heldState, isSealedItem, sealedItemIds, sealCSS, preSealItem, onRelease, PRESEAL_MS, CrateReveal, _resetHolds } = await import("../module/scripts/reveal.js");
const { replaySnapshot } = await import("../module/scripts/revealcard.js");
const { openShop, CrateShop } = await import("../module/scripts/shop.js");

const strip = { landIndex: 30, cards: Array.from({ length: 36 }, (_, i) => ({ uuid: `c${i}`, name: `Card ${i}`, img: "", rarity: "common", result: i === 30 })) };
const pull = (extra = {}) => ({
  requestId: "r1", userId: "u", actorId: "a1", actorName: "Tam", box: { id: "adventurer", name: "Adventurer's Crate", price: 150 },
  result: { name: "Rope", rarity: "common", img: "" }, strip, itemId: "item1", logId: "L1",
  stateBefore: { sinceRare: 5, owned: [], pulls: 5 }, ...extra,
});
const land = async app => {
  for (let now = 0; frames.length; now += 16) frames.shift()(now);
  await app.landed;
  await Promise.resolve();
};
const sealStyle = () => doc.getElementById("loot-crates-sealed-items");
const pressSkip = app => CrateReveal.DEFAULT_OPTIONS.actions.skip.call(app, { detail: 1 }, app.element.querySelector(".lc-reveal__close"));
const created = (id, { at = Date.now(), boxId = "adventurer", parent = { documentName: "Actor" } } = {}) => ({ id, parent, flags: { "loot-crates": { boxId, at } } });

describe("heldState", () => {
  it("is the reveal's stateBefore while it spins here, then null", async () => {
    expect(heldState("a1", "adventurer")).toBeNull();
    const app = await showReveal(pull());
    expect(heldState("a1", "adventurer")).toEqual({ sinceRare: 5, owned: [], pulls: 5 });
    expect(heldState("a1", "common")).toBeNull();
    expect(heldState("a2", "adventurer")).toBeNull();
    await land(app);
    expect(heldState("a1", "adventurer")).toBeNull();
  });

  it("holds the oldest pull's state when two of one crate spin at once, then the next", async () => {
    const first = await showReveal(pull());
    const second = await showReveal(pull({ requestId: "r2", itemId: "item2", logId: "L2", stateBefore: { sinceRare: 6, owned: [], pulls: 6 } }));
    expect(heldState("a1", "adventurer").sinceRare).toBe(5);
    first.close();
    await first.landed;
    await Promise.resolve();
    expect(heldState("a1", "adventurer").sinceRare).toBe(6);
    await land(second);
    expect(heldState("a1", "adventurer")).toBeNull();
  });

  it("holds nothing on a hidden page or under reduced motion: those land at once", async () => {
    doc.visibilityState = "hidden";
    await showReveal(pull());
    await Promise.resolve();
    expect(heldState("a1", "adventurer")).toBeNull();
    expect(sealedItemIds()).toEqual([]);
    doc.visibilityState = "visible";
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    await showReveal(pull({ requestId: "r3" }));
    await Promise.resolve();
    expect(heldState("a1", "adventurer")).toBeNull();
  });

  it("is released by Skip and by Close, item and state together", async () => {
    const a = await showReveal(pull());
    frames.shift()(0);
    pressSkip(a);
    for (let now = 16; frames.length; now += 16) frames.shift()(now);
    await a.landed;
    await Promise.resolve();
    expect(heldState("a1", "adventurer")).toBeNull();
    expect(isSealedItem("item1")).toBe(false);
    const b = await showReveal(pull({ requestId: "r4", itemId: "item4" }));
    expect(isSealedItem("item4")).toBe(true);
    b.close();
    await b.landed;
    await Promise.resolve();
    expect(isSealedItem("item4")).toBe(false);
    expect(heldState("a1", "adventurer")).toBeNull();
    expect(sealStyle()).toBeNull();
  });

  // A reveal that can't be drawn would otherwise hold its item and its
  // crate (Buy off, "Still spinning") until the page is reloaded.
  it("is released when the reveal fails to render", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = pull({ requestId: "r9", itemId: "item9", strip: null });
    await expect(showReveal(broken)).rejects.toThrow();
    await Promise.resolve();
    expect(isSealedItem("item9")).toBe(false);
    expect(heldState("a1", "adventurer")).toBeNull();
    err.mockRestore();
  });

  it("is never set by a replay, and a replay's snapshot doesn't carry the state", async () => {
    const snapshot = replaySnapshot(pull());
    expect(snapshot).not.toHaveProperty("stateBefore");
    expect(JSON.stringify(snapshot)).not.toContain("sinceRare");
    const app = await showReplay(snapshot, "m1");
    expect(heldState("a1", "adventurer")).toBeNull();
    expect(sealedItemIds()).toEqual([]);
    expect(sealStyle()).toBeNull();
    await land(app);
  });
});

describe("the shop while its crate spins here", () => {
  const pityText = html => html.querySelector('.lc-box[data-box="adventurer"] .lc-box__pity')?.textContent.trim();

  it("keeps the pity line from before the pull until the landing, then redraws with the new one", async () => {
    states["a1.adventurer"] = { sinceRare: 5, owned: [], pulls: 5 };
    const shop = openShop();
    await Promise.resolve();
    const before = pityText(shop.html);
    expect(before).toBe("Rare or better within 4 pulls");
    const app = await showReveal(pull());
    // The GM's write lands ~0.3 s after the reveal; the settings redraw follows.
    states["a1.adventurer"] = { sinceRare: 6, owned: [], pulls: 6 };
    await shop.render();
    expect(pityText(shop.html)).toBe(before);
    const renders = shop.renders;
    await land(app);
    await Promise.resolve();
    // Redrawn by the landing, not by anything the test did.
    expect(shop.renders).toBe(renders + 1);
    expect(pityText(shop.html)).toBe("Rare or better within 3 pulls");
  });

  it("keeps a Rare's reset back too, and a pill a no-duplicates crate would lose", async () => {
    const all = POOLS.homebrew.entries.map(e => e.uuid);
    boxes.crown = { ...boxes.adventurer, id: "crown", pools: [{ id: "homebrew", share: 1 }], rules: { noDuplicates: true, pity: { after: 8, minRarity: "rare" } } };
    try {
      states["a1.crown"] = { sinceRare: 5, owned: [], pulls: 5 };
      const shop = openShop();
      await Promise.resolve();
      const card = () => shop.html.querySelector('.lc-box[data-box="crown"]');
      const pills = () => card().querySelector(".lc-box__odds").textContent.replace(/\s+/g, " ").trim();
      const was = { pity: card().querySelector(".lc-box__pity")?.textContent.trim(), pills: pills(), cls: card().className };
      const legendary = POOLS.homebrew.entries.find(e => e.rarity === "legendary");
      const app = await showReveal(pull({ box: { id: "crown", name: "Crown", price: 150 }, result: { name: legendary.name, rarity: "legendary", img: "" } }));
      states["a1.crown"] = { sinceRare: 0, owned: [legendary.uuid], pulls: 6 };
      await shop.render();
      expect({ pity: card().querySelector(".lc-box__pity")?.textContent.trim(), pills: pills(), cls: card().className }).toEqual(was);
      expect(was.pills).toMatch(/Legendary/);
      expect(was.cls).toContain("lc-rarity-legendary");
      await land(app);
      await Promise.resolve();
      // At the landing: the reset count, the Legendary pill gone, and the
      // crate's edge down to the best rarity it can still drop.
      expect(card().querySelector(".lc-box__pity")?.textContent.trim()).toBe("Rare or better within 9 pulls");
      expect(pills()).not.toMatch(/Legendary/);
      expect(card().className).not.toContain("lc-rarity-legendary");
      expect(all).toContain(legendary.uuid);
    } finally { delete boxes.crown; }
  });

  // The held card shows the odds of the pull still spinning, not the ones a
  // second Buy would be rolled at: "guaranteed this pull" while the GM has
  // already spent the pity on the spin. So that crate can't be bought until
  // its spin lands here (the Buy says why), and the action checks it too.
  it("won't sell a crate again at its held odds while its spin plays", async () => {
    const { requestPull } = await import("../module/scripts/socket.js");
    requestPull.mockClear();
    boxes.crown = { ...boxes.adventurer, id: "crown", rules: { pity: { after: 3, minRarity: "rare" } } };
    try {
      states["a1.crown"] = { sinceRare: 3, owned: [], pulls: 3 };
      const shop = openShop();
      await Promise.resolve();
      const buy = () => shop.html.querySelector('.lc-box[data-box="crown"] .lc-box__buy');
      const why = () => shop.html.querySelector('.lc-box[data-box="crown"] .lc-box__why')?.textContent.trim();
      expect(buy().getAttribute("aria-disabled")).toBeNull();
      const app = await showReveal(pull({ box: { id: "crown", name: "Crown", price: 150 }, result: { name: "Wand", rarity: "rare", img: "" }, stateBefore: { sinceRare: 3, owned: [], pulls: 3 } }));
      states["a1.crown"] = { sinceRare: 0, owned: [], pulls: 4 };
      await shop.render();
      expect(shop.html.querySelector('.lc-box[data-box="crown"] .lc-box__pity').textContent.trim()).toBe("Rare or better guaranteed this pull");
      expect(buy().getAttribute("aria-disabled")).toBe("true");
      expect(why()).toBe("Still spinning");
      await CrateShop.DEFAULT_OPTIONS.actions.buy.call(shop, {}, { dataset: { box: "crown" } });
      expect(requestPull).not.toHaveBeenCalled();
      // The other crates stay on sale.
      expect(shop.html.querySelector('.lc-box[data-box="adventurer"] .lc-box__buy').getAttribute("aria-disabled")).toBeNull();
      await land(app);
      await Promise.resolve();
      expect(buy().getAttribute("aria-disabled")).toBeNull();
      expect(why()).toBeUndefined();
    } finally { delete boxes.crown; }
  });

  it("tells every release listener which pull landed", async () => {
    const heard = [];
    const stop = onRelease(e => heard.push(e));
    const app = await showReveal(pull());
    expect(heard).toEqual([]);
    await land(app);
    stop();
    expect(heard).toEqual([{ actorId: "a1", boxId: "adventurer", itemId: "item1" }]);
  });
});

describe("the item on a sheet while its crate spins here", () => {
  const sheet = () => {
    const root = doc.createElement("section");
    root.className = "application sheet actor";
    root.innerHTML = `<ol class="items"><li class="item" data-item-id="old1">Old</li><li class="item" data-item-id="item1">Rope</li></ol>`;
    doc.body.append(root);
    return root;
  };
  // What the seal stylesheet hides, read the way a browser matches it.
  const hiddenRows = root => {
    const css = sealStyle()?.textContent ?? "";
    const selectors = css.split("{")[0].split(",").map(s => s.trim()).filter(Boolean);
    return root.querySelectorAll("[data-item-id]").filter(el => selectors.some(sel => el.matches(sel))).map(el => el.dataset.itemId);
  };

  it("hides the granted row while the spin plays, in a sheet open before or after, and shows it on landing", async () => {
    const open = sheet();
    const app = await showReveal(pull());
    expect(hiddenRows(open)).toEqual(["item1"]);
    expect(sealStyle().textContent).toContain("display: none !important");
    // A sheet rendered mid-spin is covered by the same rule.
    const later = sheet();
    expect(hiddenRows(later)).toEqual(["item1"]);
    await land(app);
    expect(hiddenRows(open)).toEqual([]);
    expect(sealStyle()).toBeNull();
  });

  it("pre-seals a pull's item on createItem until its reveal takes over, then holds it to the landing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    preSealItem(created("item1"));
    expect(isSealedItem("item1")).toBe(true);
    expect(hiddenRows(sheet())).toEqual(["item1"]);
    vi.advanceTimersByTime(250);
    const app = await showReveal(pull());
    // The pre-seal's timer no longer releases it.
    vi.advanceTimersByTime(PRESEAL_MS * 2);
    expect(isSealedItem("item1")).toBe(true);
    // The createItem may come after the reveal: nothing changes.
    preSealItem(created("item1"));
    await land(app);
    expect(isSealedItem("item1")).toBe(false);
    vi.advanceTimersByTime(PRESEAL_MS * 2);
    expect(isSealedItem("item1")).toBe(false);
  });

  it("shows a pre-sealed item after PRESEAL_MS when no reveal claims it", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    preSealItem(created("lone1"));
    vi.advanceTimersByTime(PRESEAL_MS - 1);
    expect(isSealedItem("lone1")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isSealedItem("lone1")).toBe(false);
    expect(sealStyle()).toBeNull();
  });

  it("doesn't pre-seal an item no pull just granted", () => {
    preSealItem(created("old", { at: Date.now() - 10 * 60 * 1000 }));
    preSealItem(created("nobox", { boxId: null }));
    preSealItem(created("world", { parent: null }));
    preSealItem(created('bad"]{x}'));
    preSealItem({ id: "plain", parent: { documentName: "Actor" }, flags: {} });
    preSealItem(null);
    expect(sealedItemIds()).toEqual([]);
  });

  it("writes one selector per sealed id, and no CSS when none is", () => {
    expect(sealCSS([])).toBe("");
    expect(sealCSS(["a1", "b2"])).toBe('[data-item-id="a1"],\n[data-item-id="b2"] { display: none !important; }');
  });

  it("never seals for a replay, even one given an itemId", async () => {
    const app = new CrateReveal({ replay: true, replayKey: "k", actorName: "Tam", box: { name: "C", price: 1 }, result: { name: "Rope", rarity: "common" }, strip, itemId: "item1", stateBefore: { sinceRare: 1 } });
    await app.render({ force: true });
    expect(isSealedItem("item1")).toBe(false);
    expect(heldState(undefined, undefined)).toBeNull();
  });
});
