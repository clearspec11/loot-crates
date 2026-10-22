/*
  Open windows follow the world settings: every world key tells the one
  listener which key changed, the shop redraws for what it shows, and the
  manager redraws only when its open tab shows the key (never the pools tab
  on a pools change, which would undo its paging).
*/
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";

vi.mock("../module/scripts/shop.js", () => ({ refreshShop: vi.fn() }));
vi.mock("../module/scripts/chat.js", () => ({ postRefundCard: vi.fn() }));

const { registerSettings, setStoreListener, WORLD_KEYS } = await import("../module/scripts/store.js");
const { storeRedraw, REDRAW_DELAY_MS } = await import("../module/scripts/redraw.js");
const { SETTINGS } = await import("../module/scripts/config.js");

const ALL = Object.values(SETTINGS).filter(k => k !== SETTINGS.SOUND);

afterEach(() => { setStoreListener(null); vi.useRealTimers(); });

describe("the world settings", () => {
  it("each tell the store listener their key when they change", () => {
    const registered = new Map();
    vi.stubGlobal("game", { settings: { register: (_ns, key, cfg) => registered.set(key, cfg) } });
    try { registerSettings(); } finally { vi.unstubAllGlobals(); }
    expect([...WORLD_KEYS].sort()).toEqual([...ALL].sort());
    const heard = [];
    setStoreListener(key => heard.push(key));
    for (const key of WORLD_KEYS) {
      expect(registered.get(key).scope).toBe("world");
      expect(registered.get(key).onChange).toEqual(expect.any(Function));
      registered.get(key).onChange("new value");
    }
    expect(heard).toEqual(WORLD_KEYS);
    // A client setting is no one else's business.
    expect(registered.get(SETTINGS.SOUND).onChange).toBeUndefined();
  });

  it("keeps a failing listener from breaking the write", () => {
    const registered = new Map();
    vi.stubGlobal("game", { settings: { register: (_ns, key, cfg) => registered.set(key, cfg) } });
    try { registerSettings(); } finally { vi.unstubAllGlobals(); }
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    setStoreListener(() => { throw new Error("boom"); });
    expect(() => registered.get(SETTINGS.LOG).onChange([])).not.toThrow();
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});

describe("storeRedraw", () => {
  const make = () => {
    vi.useFakeTimers();
    const refreshShop = vi.fn();
    const refreshManager = vi.fn();
    return { refreshShop, refreshManager, listen: storeRedraw({ refreshShop, refreshManager }) };
  };

  it("redraws each window once for a burst of changes", () => {
    const { refreshShop, refreshManager, listen } = make();
    listen(SETTINGS.STATE);
    listen(SETTINGS.LOG);
    listen(SETTINGS.BOXES);
    vi.advanceTimersByTime(REDRAW_DELAY_MS - 1);
    expect(refreshShop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refreshShop).toHaveBeenCalledOnce();
    expect(refreshManager).toHaveBeenCalledOnce();
    expect(refreshManager.mock.calls[0][0].sort()).toEqual([SETTINGS.BOXES, SETTINGS.LOG, SETTINGS.STATE].sort());
    // The next burst is its own redraw.
    listen(SETTINGS.SHOP_OPEN);
    vi.advanceTimersByTime(REDRAW_DELAY_MS);
    expect(refreshShop).toHaveBeenCalledTimes(2);
    expect(refreshManager.mock.calls[1][0]).toEqual([SETTINGS.SHOP_OPEN]);
  });

  it("redraws the shop for a log change too: a well's card counts today's throws from it", () => {
    const { refreshShop, refreshManager, listen } = make();
    listen(SETTINGS.LOG);
    vi.advanceTimersByTime(REDRAW_DELAY_MS);
    expect(refreshShop).toHaveBeenCalledOnce();
    expect(refreshManager).toHaveBeenCalledOnce();
  });

  it("redraws the shop for a pity state change, so its odds and pity line follow a pull", () => {
    const { refreshShop, listen } = make();
    listen(SETTINGS.STATE);
    vi.advanceTimersByTime(REDRAW_DELAY_MS);
    expect(refreshShop).toHaveBeenCalledOnce();
  });

  it("redraws the shop for boxes, pools, pity state and the shop being opened or closed", () => {
    for (const key of [SETTINGS.BOXES, SETTINGS.POOLS, SETTINGS.STATE, SETTINGS.SHOP_OPEN]) {
      const { refreshShop, listen } = make();
      listen(key);
      vi.advanceTimersByTime(REDRAW_DELAY_MS);
      expect(refreshShop, key).toHaveBeenCalledOnce();
    }
  });

  it("still redraws the manager when the shop's redraw fails", () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const refreshManager = vi.fn();
    const listen = storeRedraw({ refreshShop: () => { throw new Error("boom"); }, refreshManager });
    listen(SETTINGS.BOXES);
    vi.advanceTimersByTime(REDRAW_DELAY_MS);
    expect(refreshManager).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});

describe("the manager", () => {
  let managerShows, refreshManager, openManager, CrateManager;
  let renders = 0;
  beforeAll(async () => {
    class ApplicationV2 {
      rendered = false;
      render() { renders++; this.rendered = true; return this; }
    }
    vi.stubGlobal("foundry", { utils: { escapeHTML: s => String(s), deepClone: v => structuredClone(v) }, applications: { api: { ApplicationV2, DialogV2: class {} } } });
    ({ managerShows, refreshManager, openManager, CrateManager } = await import("../module/scripts/manager.js"));
  });
  afterAll(() => vi.unstubAllGlobals());

  it("shows the log only on the Pull log tab, and never redraws the pools tab for a pools change", () => {
    expect(managerShows("log", SETTINGS.LOG)).toBe(true);
    expect(managerShows("pools", SETTINGS.LOG)).toBe(false);
    expect(managerShows("boxes", SETTINGS.LOG)).toBe(false);
    // A deck's row reads the log (its cards drawn, its odds): shown while one is on the tab.
    expect(managerShows("boxes", SETTINGS.LOG, { c: { kind: "crate" } })).toBe(false);
    expect(managerShows("boxes", SETTINGS.LOG, { c: { kind: "crate" }, d: { kind: "deck" } })).toBe(true);
    expect(managerShows("pools", SETTINGS.LOG, { d: { kind: "deck" } })).toBe(false);
    expect(managerShows("pools", SETTINGS.POOLS)).toBe(false);
    expect(managerShows("boxes", SETTINGS.POOLS)).toBe(true);
    expect(managerShows("boxes", SETTINGS.BOXES)).toBe(true);
    expect(managerShows("log", SETTINGS.BOXES)).toBe(false);
    for (const tab of ["pools", "boxes", "log"]) {
      expect(managerShows(tab, SETTINGS.SHOP_OPEN), tab).toBe(true);
      expect(managerShows(tab, SETTINGS.STATE), tab).toBe(false);
    }
  });

  it("renders an open manager once for the keys its tab shows, and not at all otherwise", () => {
    refreshManager([SETTINGS.LOG]);
    expect(renders).toBe(0);
    const app = openManager();
    renders = 0;
    app.tab = "pools";
    refreshManager([SETTINGS.LOG, SETTINGS.POOLS, SETTINGS.STATE]);
    expect(renders).toBe(0);
    app.tab = "log";
    refreshManager([SETTINGS.LOG, SETTINGS.STATE, SETTINGS.BOXES]);
    expect(renders).toBe(1);
    refreshManager(SETTINGS.LOG);
    expect(renders).toBe(2);
    app.tab = "pools";
    refreshManager([SETTINGS.SHOP_OPEN]);
    expect(renders).toBe(3);
    app.rendered = false;
    refreshManager([SETTINGS.SHOP_OPEN]);
    expect(renders).toBe(3);
  });

  /*
    A GM action on the Boxes or Pull log tab (add, edit or delete a box, a
    refund, the shop switch) awaits its write, whose onChange the store
    listener hears, then renders the manager itself; the batch 100 ms later
    must not render it a second time. A change the manager hasn't drawn yet
    (another client's pull) still does.
  */
  it("renders once for a GM's own action, not again when its write's batch lands", async () => {
    vi.useFakeTimers();
    const app = openManager();
    app.rendered = true;
    app.tab = "boxes";
    const { changeCount } = await import("../module/scripts/redraw.js");
    // The real _renderHTML notes the count before it reads anything.
    vi.stubGlobal("document", { createElement: () => { throw new Error("stop here"); } });
    const before = changeCount();
    await expect(CrateManager.prototype._renderHTML.call(app)).rejects.toThrow("stop here");
    expect(app.seen).toBe(before);
    vi.unstubAllGlobals();
    vi.stubGlobal("foundry", { utils: { escapeHTML: s => String(s), deepClone: v => structuredClone(v) }, applications: { api: { ApplicationV2: class {}, DialogV2: class {} } } });
    // Then a render is that: count, then draw.
    app.render = function () { renders++; this.seen = changeCount(); return this; };
    const listen = storeRedraw({ refreshShop: () => {}, refreshManager });
    renders = 0;
    // #addBox: await createBox (heard) then this.render().
    listen(SETTINGS.BOXES);
    app.render();
    vi.advanceTimersByTime(REDRAW_DELAY_MS);
    expect(renders).toBe(1);
    // #refund on the log tab: log, actor and stock written, then a render.
    app.tab = "log";
    listen(SETTINGS.LOG);
    listen(SETTINGS.BOXES);
    app.render();
    vi.advanceTimersByTime(REDRAW_DELAY_MS);
    expect(renders).toBe(2);
    // Another client's pull: nothing here rendered after it, so it draws.
    listen(SETTINGS.LOG);
    vi.advanceTimersByTime(REDRAW_DELAY_MS);
    expect(renders).toBe(3);
    // A change heard while a render is under way, after it read the
    // settings, is drawn again.
    listen(SETTINGS.LOG);
    app.render();
    listen(SETTINGS.LOG);
    vi.advanceTimersByTime(REDRAW_DELAY_MS);
    expect(renders).toBe(5);
  });
});
