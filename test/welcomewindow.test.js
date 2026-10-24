/*
  The welcome window in Foundry's place (welcomewindow.js): what a GM and
  a player get at load, where focus goes, what each button and a plain
  close write to the world setting, and the settings menu that brings it
  back. ApplicationV2 is a stand-in that puts the window in a minimal DOM;
  the actions are called as ApplicationV2 calls them, with the window as
  `this`.
*/
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createDocument } from "./minidom.js";

vi.mock("../module/scripts/store.js", () => ({ getBoxes: vi.fn(() => ({})) }));
vi.mock("../module/scripts/manager.js", () => ({ openManager: vi.fn(), addStarterCrates: vi.fn(async () => ({ games: [] })) }));

class DomApp {
  constructor(options) { this.options = options; this.rendered = false; }
  async render() {
    const html = await this._renderHTML();
    if (!this.rendered) {
      this.element = document.createElement("section");
      this.element.className = "application loot-crates";
      const content = document.createElement("div");
      content.className = "window-content";
      this.element.append(content);
      document.body.append(this.element);
    }
    this._replaceHTML(html, this.element.children[0]);
    this.rendered = true;
    this._onRender({}, {});
    return this;
  }
  _onRender() {}
  _onClose() {}
  async close() {
    if (!this.rendered) return this;
    this.rendered = false;
    this.element.remove();
    this._onClose({});
    return this;
  }
}
const FOUNDRY = { applications: { api: { ApplicationV2: DomApp } }, utils: { escapeHTML: s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]) } };
vi.stubGlobal("foundry", FOUNDRY);
const { WelcomeWindow, WelcomeMenu, welcomeAtLoad, openWelcome, registerWelcome } = await import("../module/scripts/welcomewindow.js");
const { LATEST } = await import("../module/scripts/changelog.js");
const store = await import("../module/scripts/store.js");
const manager = await import("../module/scripts/manager.js");

const act = (app, name) => WelcomeWindow.DEFAULT_OPTIONS.actions[name].call(app, {}, null);
let doc, settings, writes, version, isGM, open;

function stubGame() {
  vi.stubGlobal("game", {
    user: { get isGM() { return isGM; } },
    modules: { get: id => (id === "loot-crates" ? { version, url: "https://github.com/clearspec11/loot-crates" } : undefined) },
    settings: {
      get: (_m, k) => settings.get(k),
      set: async (_m, k, v) => { writes.push([k, v]); settings.set(k, v); return v; },
      register: vi.fn(), registerMenu: vi.fn(),
    },
  });
}

beforeEach(() => {
  doc = createDocument();
  vi.stubGlobal("document", doc);
  vi.stubGlobal("requestAnimationFrame", fn => { fn(); return 0; });
  settings = new Map([["welcome", { seen: null, off: false }]]);
  writes = [];
  version = LATEST.version;
  isGM = true;
  stubGame();
  store.getBoxes.mockReturnValue({ b1: { id: "b1", name: "A crate" } });
  manager.openManager.mockClear();
  manager.addStarterCrates.mockClear();
});
afterEach(async () => {
  await open?.close();
  open = null;
  vi.unstubAllGlobals();
  vi.stubGlobal("foundry", FOUNDRY);
});

const heading = () => doc.querySelector(".lc-welcome__heading")?.textContent;
// The window renders without being awaited (as at load); let it finish.
const flush = () => new Promise(r => setTimeout(r, 0));

describe("the welcome at load", () => {
  it("opens for a GM in a world that has never seen it, focused on the primary button", async () => {
    open = welcomeAtLoad();
    await flush();
    expect(heading()).toBe("Welcome to Loot Crates");
    const primary = doc.querySelectorAll("[data-primary]");
    expect(primary).toHaveLength(1);
    expect(doc.activeElement).toBe(primary[0]);
    expect(primary[0].textContent.trim()).toBe("Open the manager");
    expect(writes).toEqual([]);
  });

  it("makes Add starter crates the focused primary in a world with no games", async () => {
    store.getBoxes.mockReturnValue({});
    open = welcomeAtLoad();
    await flush();
    expect(doc.activeElement?.textContent.trim()).toBe("Add starter crates");
  });

  it("shows nothing to a player, and writes nothing, in any state", () => {
    isGM = false;
    for (const state of [{ seen: null, off: false }, { seen: "0.1.0", off: false }]) {
      settings.set("welcome", state);
      expect(welcomeAtLoad()).toBe(null);
    }
    expect(openWelcome("welcome")).toBe(null);
    expect(doc.querySelector(".lc-welcome")).toBe(null);
    expect(writes).toEqual([]);
  });

  it("stays closed after the first close (the title bar or Escape): the version is marked seen", async () => {
    open = welcomeAtLoad();
    await flush();
    await open.close();
    await open.saved;
    expect(writes).toEqual([["welcome", { seen: LATEST.version, off: false }]]);
    expect(welcomeAtLoad()).toBe(null);
  });

  it("Don't show again closes it and keeps both the welcome and the update notes away", async () => {
    open = welcomeAtLoad();
    await flush();
    await act(open, "welcomeQuiet");
    await open.saved;
    expect(open.rendered).toBe(false);
    expect(settings.get("welcome")).toEqual({ seen: LATEST.version, off: true });
    expect(welcomeAtLoad()).toBe(null);
    version = "99.0.0";
    expect(welcomeAtLoad()).toBe(null);
  });

  it("Open the manager closes it, marks it seen and opens the manager", async () => {
    open = welcomeAtLoad();
    await flush();
    await act(open, "welcomeManager");
    await open.saved;
    expect(open.rendered).toBe(false);
    expect(manager.openManager).toHaveBeenCalledTimes(1);
    expect(settings.get("welcome")).toEqual({ seen: LATEST.version, off: false });
  });

  it("Add starter crates closes it and presses the manager's Add starter crates", async () => {
    store.getBoxes.mockReturnValue({});
    open = welcomeAtLoad();
    await flush();
    await act(open, "welcomeStarter");
    expect(open.rendered).toBe(false);
    expect(manager.addStarterCrates).toHaveBeenCalledTimes(1);
  });
});

describe("What's new after an update", () => {
  it("shows the changelog's lines once for a newer version, focused on Close", async () => {
    settings.set("welcome", { seen: "0.1.0", off: false });
    open = welcomeAtLoad();
    await flush();
    expect(heading()).toBe(`What's new in ${LATEST.version}`);
    expect(doc.querySelectorAll(".lc-welcome__news li").map(li => li.textContent)).toEqual(LATEST.lines);
    expect(doc.activeElement?.textContent.trim()).toBe("Close");
    await act(open, "welcomeDone");
    await open.saved;
    expect(settings.get("welcome")).toEqual({ seen: LATEST.version, off: false });
    expect(welcomeAtLoad()).toBe(null);
  });

  it("shows nothing on the same version or a downgrade, and leaves what was seen alone", () => {
    settings.set("welcome", { seen: "99.0.0", off: false });
    expect(welcomeAtLoad()).toBe(null);
    expect(writes).toEqual([]);
  });

  it("marks a newer version with no lines of its own seen without showing anything", async () => {
    settings.set("welcome", { seen: LATEST.version, off: false });
    version = "99.0.1";
    expect(welcomeAtLoad()).toBe(null);
    await Promise.resolve();
    expect(writes).toEqual([["welcome", { seen: "99.0.1", off: false }]]);
  });
});

describe("Show the welcome, in Game Settings", () => {
  it("is a GM-only menu over a world setting the GM can't see in the list", () => {
    registerWelcome();
    const reg = globalThis.game.settings.register.mock.calls[0];
    expect(reg[1]).toBe("welcome");
    expect(reg[2]).toMatchObject({ scope: "world", config: false });
    const menu = globalThis.game.settings.registerMenu.mock.calls[0][2];
    expect(menu).toMatchObject({ label: "Show the welcome", restricted: true, type: WelcomeMenu });
  });

  it("opens the welcome even after Don't show again, and closing it turns the update notes back on", async () => {
    settings.set("welcome", { seen: LATEST.version, off: true });
    open = new WelcomeMenu().render(true);
    await flush();
    expect(heading()).toBe("Welcome to Loot Crates");
    await open.close();
    await open.saved;
    expect(settings.get("welcome")).toEqual({ seen: LATEST.version, off: false });
  });
});
