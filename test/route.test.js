/*
  The ways between the Items sidebar, the shop and the manager (route.js):
  a GM gets "Manage crates" beside "Crates", once however often the
  directory renders, and the manager's nav offers "View shop" beside the
  shop's open or closed toggle. A player gets the shop's button alone.
*/
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDocument } from "./minidom.js";
import { sidebarButtons, addDirectoryButtons, shopControls, shopEmptyHTML, managerNavHTML, MANAGE_CONTROL } from "../module/scripts/views/route.js";

// The Items directory's header as Foundry draws it, with its own buttons.
function directory(doc) {
  const root = doc.createElement("section");
  root.innerHTML = `<header class="directory-header"><div class="header-actions action-buttons"><button type="button" class="create-entry">Create Item</button><button type="button" class="create-folder">Create Folder</button></div></header><ol class="directory-list"></ol>`;
  doc.body.appendChild(root);
  return root;
}
const labels = root => root.querySelectorAll(".header-actions button").map(b => b.textContent.trim());

describe("the sidebar's buttons", () => {
  let doc;
  beforeEach(() => { doc = createDocument(); });

  it("are the shop for a player, and the shop then the manager for a GM", () => {
    expect(sidebarButtons(false)).toEqual(["shop"]);
    expect(sidebarButtons(true)).toEqual(["shop", "manager"]);
  });

  it("gives a player Crates alone", () => {
    const root = directory(doc);
    const open = { shop: vi.fn(), manager: vi.fn() };
    addDirectoryButtons(root, { isGM: false, open });
    expect(labels(root)).toEqual(["Create Item", "Create Folder", "Crates"]);
    expect(root.querySelector(".loot-crates-manage")).toBeNull();
  });

  it("gives a GM Manage crates beside Crates, and its click opens the manager", () => {
    const root = directory(doc);
    const open = { shop: vi.fn(), manager: vi.fn() };
    addDirectoryButtons(root, { isGM: true, open });
    expect(labels(root)).toEqual(["Create Item", "Create Folder", "Crates", "Manage crates"]);
    const manage = root.querySelector(".loot-crates-manage");
    expect(manage.getAttribute("type")).toBe("button");
    expect(manage.getAttribute("data-tooltip")).toBe("Open the Loot Crates manager");
    manage.dispatchEvent({ type: "click" });
    expect(open.manager).toHaveBeenCalledTimes(1);
    expect(open.shop).not.toHaveBeenCalled();
    root.querySelector(".loot-crates-open").dispatchEvent({ type: "click" });
    expect(open.shop).toHaveBeenCalledTimes(1);
  });

  it("adds nothing twice when the directory renders again", () => {
    const root = directory(doc);
    const open = { shop: vi.fn(), manager: vi.fn() };
    expect(addDirectoryButtons(root, { isGM: true, open })).toHaveLength(2);
    expect(addDirectoryButtons(root, { isGM: true, open })).toHaveLength(0);
    expect(root.querySelectorAll(".loot-crates-manage")).toHaveLength(1);
    expect(root.querySelectorAll(".loot-crates-open")).toHaveLength(1);
    // A render that kept the shop's button but not the manager's (another
    // module redrew the header) gets back only what is missing.
    root.querySelector(".loot-crates-manage").remove();
    expect(addDirectoryButtons(root, { isGM: true, open }).map(b => b.className)).toEqual(["loot-crates-manage"]);
    expect(labels(root).filter(l => l === "Crates")).toHaveLength(1);
  });

  it("does nothing without a directory header", () => {
    const root = doc.createElement("section");
    expect(addDirectoryButtons(root, { isGM: true })).toEqual([]);
    expect(addDirectoryButtons(null, { isGM: true })).toEqual([]);
  });
});

describe("the shop's way to the manager", () => {
  it("is a GM's header control, named for what it opens", () => {
    expect(shopControls(false)).toEqual([]);
    expect(shopControls(true)).toEqual([MANAGE_CONTROL]);
    expect(MANAGE_CONTROL).toMatchObject({ action: "openManager", label: "Manage crates" });
  });

  it("points a GM's empty shelf at the manager and tells a player why it is empty", () => {
    const doc = createDocument();
    const gm = doc.createElement("div");
    gm.innerHTML = shopEmptyHTML(true);
    expect(gm.querySelector(".lc-shop__empty button").getAttribute("data-action")).toBe("openManager");
    const player = doc.createElement("div");
    player.innerHTML = shopEmptyHTML(false);
    expect(player.textContent).toBe("No crates on the shelf yet. The GM hasn't put any out.");
    expect(player.querySelector("button")).toBeNull();
    expect(player.textContent).not.toMatch(/Game Settings|Manage/);
  });
});

describe("the manager's nav", () => {
  it("offers View shop beside the open or closed toggle, the tabs first", () => {
    const doc = createDocument();
    const nav = doc.createElement("div");
    nav.innerHTML = managerNavHTML({ tab: "boxes", shopOpen: false });
    const buttons = nav.querySelectorAll("button");
    expect(buttons.map(b => b.textContent.trim())).toEqual(["Boxes", "Pools", "Pull log", "View shop", "Shop open"]);
    expect(buttons.map(b => b.getAttribute("data-action"))).toEqual(["switchTab", "switchTab", "switchTab", "openShop", "toggleShop"]);
    expect(nav.querySelector('[role="tab"][aria-selected="true"]').textContent).toBe("Boxes");
    // View shop is a plain button; only the toggle is pressed or not.
    expect(nav.querySelector('[data-action="openShop"]').hasAttribute("aria-pressed")).toBe(false);
    expect(nav.querySelector('[data-action="toggleShop"]').getAttribute("aria-pressed")).toBe("false");
    // The toggle keeps its one label; only its pressed state turns.
    const open = doc.createElement("div");
    open.innerHTML = managerNavHTML({ tab: "boxes", shopOpen: true });
    const toggle = open.querySelector('[data-action="toggleShop"]');
    expect(toggle.textContent.trim()).toBe("Shop open");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.getAttribute("class")).toBe("lc-shop-toggle lc-switch");
  });
});
