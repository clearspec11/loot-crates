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
import { t } from "../core/i18n.js";

// The sidebar buttons a user gets, in order.
export const sidebarButtons = isGM => (isGM ? ["shop", "manager"] : ["shop"]);

// Each sidebar button: its class (the guard against adding it twice), icon,
// words and tooltip. The words are its accessible name; the tooltip adds to them.
export const SIDEBAR_BUTTONS = {
  shop: { cls: "loot-crates-open", icon: "fas fa-box-open", get label() { return t("LOOTCRATES.Route.Crates"); }, get tip() { return t("LOOTCRATES.Route.CratesTip"); } },
  manager: { cls: "loot-crates-manage", icon: "fas fa-screwdriver-wrench", get label() { return t("LOOTCRATES.Route.Manage"); }, get tip() { return t("LOOTCRATES.Route.ManageTip"); } },
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

/*
  A sidebar menu entry (a right-click on a directory entry) in the shape
  both Foundry versions read: v14 reads label, visible and onClick(event,
  li) and prefers them when present; v13 reads name, condition and
  callback(li). `li` is the entry's element, or a jQuery object around it
  where a menu still asks for one. `run(id)` gets the entry's document id
  (its data-entry-id); an entry without one does nothing.
  docs/COMPATIBILITY.md has the evidence for both shapes.
*/
export const entryIdOf = li => {
  const el = li?.[0] ?? li;
  return el?.closest?.("[data-entry-id]")?.dataset?.entryId ?? el?.dataset?.entryId ?? null;
};

export function directoryMenuEntry({ label, icon, visible = () => true, run = () => {} }) {
  const go = li => { const id = entryIdOf(li); if (id) run(id); };
  return { label, name: label, icon, visible, condition: visible, onClick: (_event, li) => go(li), callback: li => go(li) };
}

// The shop window's header controls (ApplicationV2 _getHeaderControls): a
// GM's "Manage crates", whose action the shop declares (shop.js).
export const MANAGE_CONTROL = { action: "openManager", icon: "fa-solid fa-screwdriver-wrench", get label() { return t("LOOTCRATES.Route.Manage"); } };
export const shopControls = isGM => (isGM ? [{ ...MANAGE_CONTROL }] : []);

// An empty shelf: a GM is pointed at the manager, a player told why.
export function shopEmptyHTML(isGM) {
  return isGM
    ? `<p class="lc-shop__empty">${t("LOOTCRATES.Route.EmptyGM", { manage: `<button type="button" class="lc-shop__manage" data-action="openManager"><i class="fas fa-screwdriver-wrench" inert></i> ${t("LOOTCRATES.Route.Manage")}</button>` })}</p>`
    : `<p class="lc-shop__empty">${t("LOOTCRATES.Route.EmptyPlayer")}</p>`;
}

export const shopToggleLabel = () => t("LOOTCRATES.Route.ShopOpen");

const TAB_KEYS = [["pools", "LOOTCRATES.Manager.TabPools"], ["boxes", "LOOTCRATES.Manager.TabBoxes"], ["log", "LOOTCRATES.Manager.TabLog"]];
export const MANAGER_TABS = TAB_KEYS.map(([tab, key]) => Object.defineProperty([tab], 1, { enumerable: true, get: () => t(key) }));

// The manager's nav: the tabs (the ARIA tabs pattern, manager.js), then
// "View shop" and the shop's toggle: one fixed label, "Shop open", pressed
// while players can buy (the ARIA toggle-button pattern, as each Boxes
// row's "On the shelf"); its switch (module.css) shows the state.
export function managerNavHTML({ tab = "pools", shopOpen = false } = {}) {
  return `<nav class="lc-tabs">
        <div class="lc-tabs__list" role="tablist" aria-label="${t("LOOTCRATES.Manager.Sections")}">${MANAGER_TABS.map(([k, l]) => `<button type="button" role="tab" id="lc-manager-tab-${k}" aria-controls="lc-manager-panel" aria-selected="${k === tab}" tabindex="${k === tab ? 0 : -1}" data-action="switchTab" data-tab="${k}" class="${k === tab ? "active" : ""}">${l}</button>`).join("")}</div>
        <span class="lc-tabs__spacer"></span>
        <span class="lc-tabs__shop"><button type="button" data-action="openShop" class="lc-view-shop" title="${t("LOOTCRATES.Manager.ViewShopTip")}"><i class="fas fa-store" inert></i> ${t("LOOTCRATES.Manager.ViewShop")}</button>
        <button type="button" data-action="toggleShop" class="lc-shop-toggle lc-switch" data-open="${shopOpen}" aria-pressed="${shopOpen}" title="${shopOpen ? t("LOOTCRATES.Manager.ShopOpenTip") : t("LOOTCRATES.Manager.ShopClosedTip")}">${shopToggleLabel()}</button></span>
      </nav>`;
}
