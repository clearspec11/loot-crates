/*
  A small menu: one button that opens a short list of the things it holds,
  for the places where a row of buttons was too many at one weight (the
  Boxes tab's seven News, a row's Copy, Delete and the rest).

    menuHTML({ label, name, cls, items, esc })   the markup
    wireMenus(root)                              the behaviour, once per root

  The trigger is a button (aria-haspopup, aria-expanded) and the list a
  group of plain buttons after it in the page, so Tab walks into it and
  each item keeps its own data-action: whoever handles the page's actions
  (the manager's ApplicationV2 actions, the harness) needs to know nothing
  about the menu. The list is `hidden` until opened, so a closed menu's
  items take no focus and no space.

  wireMenus listens on `root` (delegated, so a redraw inside it needs no
  rewiring; a second call on the same root does nothing):
  - a press on a trigger opens its list and shuts any other; a second
    press shuts it;
  - a press on an item, or anywhere else, shuts it (the item's own action
    still runs: this never stops the event);
  - Escape shuts it and puts focus back on the trigger;
  - ArrowDown and ArrowUp move between the items, from the trigger too.
  A list opens under its trigger, or over it when the scrolling pane it
  sits in (`[role="tabpanel"]`, else the root) has no room beneath: the
  last row's menu is never cut off or left to be scrolled to.

  A redraw of the page shuts an open menu, since the markup is drawn shut:
  what was under the pointer is gone rather than changed for another.

  Focus never falls off the page: a menu that shuts with focus inside it
  (an item pressed, Escape) hands focus to its trigger first, and the
  trigger carries the menu's `id` (data-menu), so a page that redraws
  after the item's action can find the same trigger again.

  No Foundry globals.
*/

/*
  `label` is the trigger's own markup (the caller's words or icon, already
  escaped); `name` its accessible name when the label is an icon or says
  less than a screen reader needs ("More for Royal Vault"); `id` what
  tells this menu from the page's others (a game's id, "new"). Each item:
  { action, label, box?, name?, cls? }: the data-action, the words, the
  game it acts on, an accessible name where the words alone don't say
  what on, and a class (lc-menu__item--danger for a delete).
*/
export function menuHTML({ label, name = "", id = "", cls = "", items = [], esc = s => String(s ?? "") }) {
  if (!items.length) return "";
  const list = items.map(i => `<button type="button" class="lc-menu__item${i.cls ? ` ${i.cls}` : ""}" data-action="${esc(i.action)}"${i.box != null ? ` data-box="${esc(i.box)}"` : ""}${i.name ? ` aria-label="${esc(i.name)}"` : ""}>${esc(i.label)}</button>`).join("");
  return `<span class="lc-menu${cls ? ` ${cls}` : ""}"><button type="button" class="lc-menu__trigger" data-menu="${esc(id)}" aria-haspopup="true" aria-expanded="false"${name ? ` aria-label="${esc(name)}"` : ""}>${label}</button><span class="lc-menu__list" role="group"${name ? ` aria-label="${esc(name)}"` : ""} hidden>${list}</span></span>`;
}

const wired = new WeakSet();
const outside = new WeakMap();
const listOf = trigger => trigger?.parentNode?.querySelector?.(".lc-menu__list") ?? null;

export function shutMenus(root, except = null) {
  for (const t of root.querySelectorAll('[data-menu][aria-expanded="true"]')) {
    if (t === except) continue;
    t.setAttribute("aria-expanded", "false");
    const list = listOf(t);
    if (!list) continue;
    // Focus inside the list goes to the trigger before the list hides.
    const active = (root.ownerDocument ?? globalThis.document)?.activeElement;
    if (active && list.contains(active)) t.focus?.();
    list.hidden = true;
    list.classList.remove("lc-menu__list--up");
  }
}

function open(root, trigger) {
  shutMenus(root, trigger);
  const list = listOf(trigger);
  if (!list) return;
  trigger.setAttribute("aria-expanded", "true");
  list.classList.remove("lc-menu__list--up");
  list.hidden = false;
  // Over the trigger when the pane has no room under it and has room above.
  const pane = trigger.closest?.('[role="tabpanel"]') ?? root;
  const p = pane?.getBoundingClientRect?.(), l = list.getBoundingClientRect?.(), t = trigger.getBoundingClientRect?.();
  if (p && l && t && l.bottom > p.bottom && t.top - l.height >= p.top) list.classList.add("lc-menu__list--up");
}

export function wireMenus(root) {
  if (!root || wired.has(root)) return;
  wired.add(root);
  root.addEventListener("click", e => {
    const trigger = e.target?.closest?.("[data-menu]");
    if (trigger && root.contains(trigger)) {
      if (trigger.getAttribute("aria-expanded") === "true") shutMenus(root);
      else open(root, trigger);
      return;
    }
    // An item's press, or a press anywhere else in the page.
    shutMenus(root);
  });
  root.addEventListener("keydown", e => {
    const menu = e.target?.closest?.(".lc-menu");
    if (!menu) return;
    const trigger = menu.querySelector("[data-menu]");
    const isOpen = trigger?.getAttribute("aria-expanded") === "true";
    if (e.key === "Escape" && isOpen) {
      shutMenus(root);
      trigger.focus?.();
      e.preventDefault?.();
      e.stopPropagation?.();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if (!isOpen) { if (e.target !== trigger) return; open(root, trigger); }
    const items = [...menu.querySelectorAll(".lc-menu__item")];
    if (!items.length) return;
    const at = items.indexOf(e.target);
    const next = e.key === "ArrowDown" ? (at + 1) % items.length : at <= 0 ? items.length - 1 : at - 1;
    items[next].focus?.();
    // Handled here, and kept from Foundry's keybindings on the window
    // behind it (the arrows move tokens).
    e.preventDefault?.();
    e.stopPropagation?.();
  });
  // Focus leaving the menu by Tab shuts it: nothing stays open behind the GM.
  root.addEventListener("focusout", e => {
    const menu = e.target?.closest?.(".lc-menu");
    if (menu && e.relatedTarget && !menu.contains(e.relatedTarget)) shutMenus(root);
  });
  // A press outside the root (another window, the canvas) shuts it too:
  // one listener a document, for every root wired in it; a root that has
  // left the page (a closed window) is dropped the next time it is met.
  const doc = root.ownerDocument ?? globalThis.document;
  if (!doc?.addEventListener) return;
  let roots = outside.get(doc);
  if (!roots) {
    roots = new Set();
    outside.set(doc, roots);
    const mine = roots;
    doc.addEventListener("pointerdown", e => {
      for (const r of [...mine]) {
        if (r.isConnected === false) { mine.delete(r); continue; }
        if (!r.contains?.(e.target)) shutMenus(r);
      }
    });
  }
  roots.add(root);
}
