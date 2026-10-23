/*
  The ways between the GM's two windows and the Items sidebar, in one place
  so main.js, the shop, the manager and the harness draw them alike:

  - The Items sidebar: "Crates" (the shop) for everyone, and for a GM
    "Manage crates" (the manager) beside it, each added once however often
    the directory renders (addDirectoryButtons).
  - The manager's nav: the tabs, then "View shop" beside the shop's open or
    closed toggle (managerNavHTML). "View shop" only opens the window; the
    toggle is what lets players buy.
  - The shop: for a GM, "Manage crates" in its window's header controls
    (shopControls), and an empty shelf that points at the manager
    (shopEmptyHTML). A player's empty shelf says the GM hasn't put anything
    out, with no talk of settings they can't open.

  Game Settings, Loot Crates still opens the manager too (main.js
  registerMenu). No Foundry globals: the caller says whether this is a GM
  and passes the window openers and the escape.
*/

// The sidebar buttons a user gets, in order.
export const sidebarButtons = isGM => (isGM ? ["shop", "manager"] : ["shop"]);

// Each sidebar button: its class (the guard against adding it twice), icon,
// words and tooltip. The words are its accessible name; the tooltip adds to them.
export const SIDEBAR_BUTTONS = {
  shop: { cls: "loot-crates-open", icon: "fas fa-box-open", label: "Crates", tip: "Open the Crate Shop" },
  manager: { cls: "loot-crates-manage", icon: "fas fa-screwdriver-wrench", label: "Manage crates", tip: "Open the Loot Crates manager" },
};

/*
  Adds this user's sidebar buttons to the Items directory's header (`root`,
  the directory's element). A button already there is left alone, so a
  re-render never doubles it. `open` maps each button to what it opens.
  Returns the buttons it added.
*/
export function addDirectoryButtons(root, { isGM = false, open = {} } = {}) {
  const header = root?.querySelector(".directory-header .header-actions") ?? root?.querySelector(".directory-header");
  if (!header) return [];
  const doc = header.ownerDocument ?? globalThis.document;
  const added = [];
  for (const key of sidebarButtons(isGM)) {
    const spec = SIDEBAR_BUTTONS[key];
    if (root.querySelector(`.${spec.cls}`)) continue;
    const button = doc.createElement("button");
    button.setAttribute("type", "button");
    button.className = spec.cls;
    button.setAttribute("data-tooltip", spec.tip);
    button.innerHTML = `<i class="${spec.icon}" inert></i> ${spec.label}`;
    button.addEventListener("click", () => open[key]?.());
    header.appendChild(button);
    added.push(button);
  }
  return added;
}

// The shop window's header controls (ApplicationV2 _getHeaderControls): a
// GM's "Manage crates", whose action the shop declares (shop.js).
export const MANAGE_CONTROL = { action: "openManager", icon: "fa-solid fa-screwdriver-wrench", label: "Manage crates" };
export const shopControls = isGM => (isGM ? [{ ...MANAGE_CONTROL }] : []);

// An empty shelf: a GM is pointed at the manager, a player told why.
export function shopEmptyHTML(isGM) {
  return isGM
    ? `<p class="lc-shop__empty">No crates on the shelf yet. Make one in <button type="button" class="lc-shop__manage" data-action="openManager"><i class="fas fa-screwdriver-wrench" inert></i> Manage crates</button>.</p>`
    : `<p class="lc-shop__empty">No crates on the shelf yet. The GM hasn't put any out.</p>`;
}

export const MANAGER_TABS = [["pools", "Pools"], ["boxes", "Boxes"], ["log", "Pull log"]];

// The manager's nav: the tabs (the ARIA tabs pattern, manager.js), then
// "View shop" and the shop's open or closed toggle.
export function managerNavHTML({ tab = "pools", shopOpen = false } = {}) {
  return `<nav class="lc-tabs">
        <div class="lc-tabs__list" role="tablist" aria-label="Loot Crates sections">${MANAGER_TABS.map(([k, l]) => `<button type="button" role="tab" id="lc-manager-tab-${k}" aria-controls="lc-manager-panel" aria-selected="${k === tab}" tabindex="${k === tab ? 0 : -1}" data-action="switchTab" data-tab="${k}" class="${k === tab ? "active" : ""}">${l}</button>`).join("")}</div>
        <span class="lc-tabs__spacer"></span>
        <span class="lc-tabs__shop"><button type="button" data-action="openShop" class="lc-view-shop" title="Open the Crate Shop window"><i class="fas fa-store" inert></i> View shop</button>
        <button type="button" data-action="toggleShop" class="lc-shop-toggle" data-open="${shopOpen}" aria-pressed="${shopOpen}" title="${shopOpen ? "Players can buy now. Click to close the shop." : "Players can't buy now. Click to open the shop."}">${shopOpen ? "Shop open" : "Shop closed"}</button></span>
      </nav>`;
}
