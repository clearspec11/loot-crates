// The manager's menus (module/scripts/views/menu.js) for a live check: the
// Boxes tab's News are in "New game" and a row's Make a ticket, Reshuffle,
// Print a new roll, Copy and Delete in its More, each drawn shut. A real
// click (Playwright's) can't land on a button in a shut list, so open it
// first, as a GM would.
//
//   await openMenuFor(page, selector)   opens the menu holding the one
//                                       element `selector` matches, with a
//                                       real click on its trigger; true if
//                                       it had to (false: nothing to open)
//   await pressIn(page, selector)       that, then a real click on it
//
// A check that clicks inside the page (el.click(), __lc.click) needs
// neither: a dispatched click reaches a hidden button.
async function openMenuFor(page, selector) {
  const shut = await page.locator(selector).first().evaluate(el => {
    const list = el.closest(".lc-menu__list");
    if (!list || !list.hidden) return false;
    el.closest(".lc-menu").querySelector("[data-menu]").setAttribute("data-live-menu", "1");
    return true;
  });
  if (!shut) return false;
  await page.locator('[data-live-menu="1"]').click();
  await page.evaluate(() => document.querySelector("[data-live-menu]")?.removeAttribute("data-live-menu"));
  return true;
}

async function pressIn(page, selector) {
  await openMenuFor(page, selector);
  await page.locator(selector).first().click();
}

module.exports = { openMenuFor, pressIn };
