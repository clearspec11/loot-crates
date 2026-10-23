/*
  ApplicationV2 handles the actions "close", "tab" and "toggleControls" itself
  and never calls a window's own handler for them: data-action="tab" goes to
  changeTab, which throws without a data-group, so the manager's tabs never
  switched. No script may use those names, as an action key or in markup.
*/
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const RESERVED = ["close", "tab", "toggleControls"];
const DIR = new URL("../module/scripts/", import.meta.url).pathname;
const scripts = readdirSync(DIR).filter(f => f.endsWith(".js")).map(f => [f, readFileSync(join(DIR, f), "utf8")]);

// Keys of every `actions: { ... }` object (the handlers' DEFAULT_OPTIONS).
function actionKeys(src) {
  const keys = [];
  for (const [, body] of src.matchAll(/\bactions\s*:\s*\{([^}]*)\}/g)) {
    for (const [, key] of body.replace(/\/\/[^\n]*/g, "").matchAll(/(?:^|[,{\s])["']?([A-Za-z_$][\w$]*)["']?\s*:/g)) keys.push(key);
  }
  return keys;
}

// Every action named in markup or set on an element's dataset.
function markupActions(src) {
  return [
    ...[...src.matchAll(/data-action=\\?["']([^"'\\$]+)/g)].map(m => m[1]),
    ...[...src.matchAll(/dataset\.action\s*=\s*["']([^"']+)/g)].map(m => m[1]),
  ];
}

describe("window actions", () => {
  it("finds the actions the scripts declare and use", () => {
    const all = scripts.flatMap(([, src]) => [...actionKeys(src), ...markupActions(src)]);
    expect(all).toEqual(expect.arrayContaining(["switchTab", "buy", "dismiss", "skip", "refund", "openShop", "openManager"]));
  });

  it("catches a reserved name in an actions object or in markup", () => {
    expect(actionKeys(`actions: {\n tab: A.#tab, addPool: A.#addPool,\n}`)).toEqual(["tab", "addPool"]);
    expect(markupActions('`<button data-action="tab" data-tab="${k}">`')).toEqual(["tab"]);
    expect(markupActions('btn.dataset.action = "close";')).toEqual(["close"]);
  });

  for (const [file, src] of scripts) {
    it(`${file} uses none of ApplicationV2's own action names`, () => {
      const used = [...actionKeys(src), ...markupActions(src)].filter(a => RESERVED.includes(a));
      expect(used).toEqual([]);
    });
  }

  it("the manager's tabs switch through switchTab and carry tab semantics", () => {
    const src = scripts.find(([f]) => f === "manager.js")[1];
    // The nav is drawn by route.js (managerNavHTML), shared with the harness.
    const nav = scripts.find(([f]) => f === "route.js")[1];
    expect(actionKeys(src)).toContain("switchTab");
    expect(nav).toMatch(/role="tablist"/);
    expect(nav).toMatch(/role="tab"[^>]*aria-selected="\$\{k === tab\}"[^>]*data-action="switchTab"/);
    expect(src).toMatch(/role="tabpanel"/);
  });

  it("the routes between the shop and the manager are declared where they are drawn", () => {
    const manager = scripts.find(([f]) => f === "manager.js")[1];
    const shop = scripts.find(([f]) => f === "shop.js")[1];
    const route = scripts.find(([f]) => f === "route.js")[1];
    expect(actionKeys(manager)).toContain("openShop");
    expect(actionKeys(shop)).toContain("openManager");
    expect(markupActions(route)).toEqual(expect.arrayContaining(["openShop", "openManager", "toggleShop", "switchTab"]));
  });
});
