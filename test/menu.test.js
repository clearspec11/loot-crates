/*
  The menu (views/menu.js) on the minidom: one trigger and a list drawn
  shut, opened and shut by the press, Escape, a press elsewhere and the
  arrows, one open at a time, and every item's own action left alone.
*/
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createDocument } from "./minidom.js";
import { menuHTML, wireMenus, shutMenus } from "../module/scripts/views/menu.js";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const event = (type, target, more = {}) => ({ type, target, bubbles: true, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...more });

let doc, root;
beforeEach(() => {
  doc = createDocument();
  vi.stubGlobal("document", doc);
  root = doc.createElement("div");
  doc.body.append(root);
});
afterEach(() => vi.unstubAllGlobals());

const two = () => {
  root.innerHTML = `${menuHTML({ label: "New game", cls: "lc-menu--new", items: [{ action: "addBox", label: "New crate" }, { action: "addWell", label: "New Wishing Well" }], esc })}`
    + `${menuHTML({ label: "<i></i>", name: "More for Tam's <Crate>", cls: "lc-menu--row", items: [{ action: "copyBox", box: "b1", label: "Copy", name: "Copy Tam's <Crate>" }, { action: "deleteBox", box: "b1", label: "Delete", cls: "lc-menu__item--danger" }], esc })}<button class="other">Elsewhere</button>`;
  wireMenus(root);
  const [a, b] = root.querySelectorAll("[data-menu]");
  const lists = root.querySelectorAll(".lc-menu__list");
  return { a, b, la: lists[0], lb: lists[1] };
};
const press = target => root.dispatchEvent(event("click", target));

describe("the menu's markup", () => {
  it("is a trigger and a group of plain buttons drawn shut, each with its own action", () => {
    const html = menuHTML({ label: "<i></i>", name: "More for Tam's <Crate>", id: "b1", cls: "lc-menu--row", items: [{ action: "copyBox", box: "b1", label: "Copy", name: "Copy Tam's <Crate>" }, { action: "deleteBox", box: "b1", label: "Delete", cls: "lc-menu__item--danger" }], esc });
    expect(html).toBe('<span class="lc-menu lc-menu--row"><button type="button" class="lc-menu__trigger" data-menu="b1" aria-haspopup="true" aria-expanded="false" aria-label="More for Tam&#39;s &lt;Crate&gt;"><i></i></button>'
      + '<span class="lc-menu__list" role="group" aria-label="More for Tam&#39;s &lt;Crate&gt;" hidden>'
      + '<button type="button" class="lc-menu__item" data-action="copyBox" data-box="b1" aria-label="Copy Tam&#39;s &lt;Crate&gt;">Copy</button>'
      + '<button type="button" class="lc-menu__item lc-menu__item--danger" data-action="deleteBox" data-box="b1">Delete</button></span></span>');
  });

  it("is nothing at all with nothing to hold", () => {
    expect(menuHTML({ label: "More", items: [] })).toBe("");
  });
});

describe("the menu's behaviour", () => {
  it("opens on its trigger's press and shuts on a second", () => {
    const { a, la } = two();
    expect(la.hidden).toBe(true);
    press(a);
    expect(la.hidden).toBe(false);
    expect(a.getAttribute("aria-expanded")).toBe("true");
    press(a);
    expect(la.hidden).toBe(true);
    expect(a.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps one open at a time", () => {
    const { a, b, la, lb } = two();
    press(a);
    press(b);
    expect(la.hidden).toBe(true);
    expect(a.getAttribute("aria-expanded")).toBe("false");
    expect(lb.hidden).toBe(false);
  });

  it("shuts on an item's press without stopping it, and on a press anywhere else", () => {
    const { a, b, la, lb } = two();
    press(a);
    const item = event("click", la.querySelector('[data-action="addWell"]'));
    root.dispatchEvent(item);
    expect(la.hidden).toBe(true);
    // The item's own action is somebody else's to run: the menu never stops the press.
    expect(item.stopPropagation).not.toHaveBeenCalled();
    expect(item.preventDefault).not.toHaveBeenCalled();
    press(b);
    press(root.querySelector(".other"));
    expect(lb.hidden).toBe(true);
  });

  it("Escape shuts it and puts focus back on the trigger; the arrows walk the items", () => {
    const { b, lb } = two();
    const items = [...lb.querySelectorAll(".lc-menu__item")];
    b.focus();
    // ArrowDown on a shut trigger opens it on the first item.
    root.dispatchEvent(event("keydown", b, { key: "ArrowDown" }));
    expect(lb.hidden).toBe(false);
    expect(doc.activeElement).toBe(items[0]);
    root.dispatchEvent(event("keydown", items[0], { key: "ArrowDown" }));
    expect(doc.activeElement).toBe(items[1]);
    root.dispatchEvent(event("keydown", items[1], { key: "ArrowDown" }));
    expect(doc.activeElement).toBe(items[0]);
    root.dispatchEvent(event("keydown", items[0], { key: "ArrowUp" }));
    expect(doc.activeElement).toBe(items[1]);
    const esc2 = event("keydown", items[1], { key: "Escape" });
    root.dispatchEvent(esc2);
    expect(lb.hidden).toBe(true);
    expect(doc.activeElement).toBe(b);
    // Handled here: a Foundry window behind it doesn't close on the same key.
    expect(esc2.stopPropagation).toHaveBeenCalled();
    // With nothing open, Escape is left for the window.
    const idle = event("keydown", b, { key: "Escape" });
    root.dispatchEvent(idle);
    expect(idle.stopPropagation).not.toHaveBeenCalled();
  });

  it("an item pressed with focus on it hands focus to the trigger before the list hides, and the arrows are kept from the window behind", () => {
    const { b, lb } = two();
    const items = [...lb.querySelectorAll(".lc-menu__item")];
    press(b);
    items[0].focus();
    const down = event("keydown", items[0], { key: "ArrowDown" });
    root.dispatchEvent(down);
    expect(down.stopPropagation).toHaveBeenCalled();
    press(items[1]);
    expect(lb.hidden).toBe(true);
    expect(doc.activeElement).toBe(b);
  });

  it("wiring the same root twice opens once, and a redraw inside it needs no rewiring", () => {
    const first = two();
    wireMenus(root);
    press(first.a);
    expect(first.la.hidden).toBe(false);
    // The page is drawn again, shut; the same root still answers.
    const again = two();
    expect(again.la.hidden).toBe(true);
    press(again.a);
    expect(again.la.hidden).toBe(false);
    shutMenus(root);
    expect(again.la.hidden).toBe(true);
  });
});
