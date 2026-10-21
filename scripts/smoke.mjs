/* Visual smoke: the harness's shop, a landed spin and the pool editor, at a desktop and a
   phone width. Screenshots land in screenshots/smoke/<width>/<state>.png.
   The run fails when a page throws or scrolls sideways.

     NODE_PATH=$(npm root -g) npm run smoke
     FOUNDRY_URL=http://<foundry>:30000 NODE_PATH=$(npm root -g) npm run smoke
                                    # with dnd5e's real fonts and textures

   Needs Playwright (global is fine) with its Chromium. The landed spin uses a
   fixed seed and zero duration, so two runs give the same pixels. */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { serveStatic } from "./lib/static.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require("playwright-core")); }

const PORT = 5282;
const root = path.resolve(import.meta.dirname, "..");
const OUT = path.join(root, "screenshots/smoke");
const WIDTHS = [
  { tag: "1440", viewport: { width: 1440, height: 900 } },
  { tag: "390", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
];
// Foundry's two themes; the light run's files end in -light.
const THEMES = ["dark", "light"];
const STATES = [
  ["shop", "state=shop"],
  ["shop-closed", "state=shop&closed=1"],
  // Tam's pity on the Adventurer's Crate is due: its odds are only what the
  // roll can give (Rare or better) and its line says it is guaranteed.
  ["shop-pity", "state=shop&pity=due"],
  // The Buy a keyboard user pressed, mid-pull: it keeps focus (and its node)
  // through every re-render, and the others are off without losing theirs.
  // The player owns two characters: the select is off (aria-disabled, still
  // legible) while the pull is out, and on again once it settles.
  ["shop-busy", "state=shop&characters=2"],
  // A shop window shorter than its crates (Foundry caps windows at the
  // screen's height; a player can size it down): the grid scrolls under the
  // head, which stays in view, and a wheel over the grid reaches the last crate.
  ["shop-short", "state=shop&height=420"],
  ["landed", "state=landed&seed=7"],
  ["landed-legendary", "state=landed&seed=36&box=royal"],
  ["landed-buyer", "state=landed&seed=7&buyer=1"],
  // The buyer's reveal that landed while their tab was hidden (or was
  // skipped): Watch again beside Close, three buttons that wrap cleanly at
  // 390. Pressing it replays the strip in place, reading Skip.
  ["landed-missed", "state=landed&seed=7&buyer=1&watched=0"],
  // "Watch again" from the chat card: the replay window, titled as a replay,
  // shows the item and no gold or Open item; the card shows the button.
  ["replay", "state=replay&seed=7"],
  ["manager", "state=manager"],
  // A manager window sized 480 px wide, on any screen: its rows follow the
  // window (a container query), so names wrap in full rather than cut off.
  ["manager-narrow", "state=manager&width=480"],
  // A dropped item on a big pool that was collapsed and filtered to Rare:
  // opened, the chip cleared, the row pinned first and focused, and said.
  ["manager-dropped", "state=manager&dropped=1"],
];

// The pool editor as a craft table, read from the DOM: an open pool draws at
// most a page of controls, a collapsed one none (its census still shown),
// one status line and no per-pool live regions, and the "No rarity set" chip
// shows only unset rows and says it is pressed.
async function managerProblems(narrow) {
  const out = [];
  if (narrow) {
    const app = document.getElementById("app").getBoundingClientRect().width;
    if (app > 484) out.push(`narrow manager is ${Math.round(app)} px wide`);
    const cut = [...document.querySelectorAll(".lc-entry__name, .lc-entry__status")].filter(el => el.scrollWidth > el.clientWidth + 1);
    if (cut.length) out.push(`${cut.length} names or statuses cut off in a 480 px window, e.g. "${cut[0].textContent}"`);
    if (!document.querySelector(".lc-entry")) out.push("no rows to check");
  }
  // The tabs as a tablist: three tabs, one selected and underlined, the shop
  // switch outside the list.
  const tabs = [...document.querySelectorAll('.lc-tabs [role="tablist"] > [role="tab"]')];
  if (tabs.length !== 3) out.push(`expected 3 role=tab in a tablist, got ${tabs.length}`);
  const selected = tabs.filter(t => t.getAttribute("aria-selected") === "true");
  if (selected.length !== 1) out.push(`expected one selected tab, got ${selected.length}`);
  else if (getComputedStyle(selected[0]).borderBottomColor === getComputedStyle(tabs.find(t => t !== selected[0])).borderBottomColor) out.push("the selected tab is not underlined");
  // One stop in the tab order: the selected tab (arrows move between them).
  const stops = tabs.filter(t => t.tabIndex === 0);
  if (stops.length !== 1 || stops[0] !== selected[0]) out.push(`expected only the selected tab in the tab order, got ${stops.length}`);
  if (document.querySelector('[role="tablist"] .lc-shop-toggle')) out.push("the shop switch is inside the tablist");
  if (!document.querySelector('.lc-tab[role="tabpanel"]')) out.push("no role=tabpanel");
  const pools = [...document.querySelectorAll(".lc-pool__details")];
  if (pools.length < 3) out.push(`expected 3 sample pools, got ${pools.length}`);
  for (const d of pools) {
    const selects = d.querySelectorAll("select.lc-entry__rarity").length;
    if (d.open && selects > 50) out.push(`${d.dataset.pool}: ${selects} rarity selects drawn`);
    if (!d.open && d.querySelector(".lc-entry")) out.push(`${d.dataset.pool}: collapsed but rows drawn`);
    if (!/\d+ items?/.test(d.querySelector("summary .lc-pool__count")?.textContent ?? "")) out.push(`${d.dataset.pool}: no census in the summary`);
    // The boxes that draw from the pool, on a line of its own that wraps
    // rather than cuts off, at any width.
    const users = d.querySelector("summary .lc-pool__users");
    if (!users) out.push(`${d.dataset.pool}: no line naming its boxes`);
    else if (users.scrollWidth > users.clientWidth + 1 || users.getBoundingClientRect().right > d.getBoundingClientRect().right + 1) out.push(`${d.dataset.pool}: its boxes line is cut off`);
  }
  const usersOf = id => document.querySelector(`.lc-pool__details[data-pool="${id}"] .lc-pool__users`)?.textContent;
  if (usersOf("core") !== "In Adventurer's Crate, Pauper's Box, Royal Vault and 1 more") out.push(`core's boxes line reads "${usersOf("core")}"`);
  if (usersOf("everything") !== "Not in any box") out.push(`the unused pool's line reads "${usersOf("everything")}"`);
  const everything = document.querySelector('.lc-pool__details[data-pool="everything"]');
  if (everything?.open) out.push("the 200-entry pool should start collapsed");
  if (document.querySelectorAll('[role="status"]').length !== 1) out.push("expected one role=status");
  if (document.querySelector(".lc-manager__body [aria-live]")) out.push("a per-pool aria-live region is back");
  const big = document.querySelector('.lc-pool__details[data-pool="compendium"]');
  if (!/Show 50 more \(\d+ left\)/.test(big?.querySelector(".lc-pool__more")?.textContent ?? "")) out.push("no Show 50 more on the open 130-entry pool");
  const chip = big?.querySelector('[data-chip="unset"]');
  if (!chip) return [...out, "no 'No rarity set' chip"];
  const n = Number(chip.textContent.match(/\d+/)?.[0]);
  chip.click();
  await new Promise(r => requestAnimationFrame(r));
  const rows = [...big.querySelectorAll(".lc-entry")];
  if (big.querySelector('[data-chip="unset"]')?.getAttribute("aria-pressed") !== "true") out.push("the pressed chip doesn't say so");
  if (!rows.length || rows.some(li => !li.classList.contains("lc-entry--unset"))) out.push("the 'No rarity set' chip shows other rows");
  if (rows.length !== Math.min(50, n)) out.push(`chip says ${n}, shows ${rows.length}`);
  big.querySelector('[data-chip="unset"]').click();
  return out;
}

// The drop, read from the DOM: the collapsed 200-entry pool is open, its Rare
// chip cleared, the dropped row first on page one with "Just added" and its
// rarity edge, its rarity select focused, and the status line names it.
function droppedProblems() {
  const out = [];
  const uuid = "sample.everything.199";
  const d = document.querySelector('.lc-pool__details[data-pool="everything"]');
  if (!d?.open) out.push("the pool dropped on is not open");
  if (d?.querySelector('[data-chip][aria-pressed="true"]')) out.push("a chip that hides the dropped item is still pressed");
  const first = d?.querySelector(".lc-entries > .lc-entry");
  if (first?.dataset.entry !== uuid) out.push(`first row is ${first?.dataset.entry}, not the dropped item`);
  if (!first?.classList.contains("lc-entry--recent") || !/Just added/.test(first?.textContent ?? "")) out.push("the dropped row isn't marked Just added");
  if (first && getComputedStyle(first).boxShadow === "none") out.push("the dropped row has no rarity edge");
  if (document.activeElement !== first?.querySelector("select.lc-entry__rarity")) out.push("focus is not on the dropped row's rarity select");
  const status = document.querySelector(".lc-manager__status")?.textContent ?? "";
  if (!/Staff of Power 199 added to Every dnd5e item, Very rare, at the top\. Cleared the Rare filter/.test(status)) out.push(`status line says "${status}"`);
  if (document.querySelectorAll(".lc-entry--recent").length !== 1) out.push("more than one row pinned");
  return out;
}

// The payoff, read from the DOM: everyone sees where the item went; only the
// buyer (and GMs) see the gold left and Open item; Close is the focused button.
function revealProblems(buyer) {
  const out = [];
  const shown = el => !!el && !el.hidden && el.getBoundingClientRect().height > 0;
  const text = document.querySelector(".lc-reveal__result")?.innerText ?? "";
  if (!/Added to .+'s inventory/.test(text)) out.push(`reveal doesn't say where the item went: "${text}"`);
  if (buyer !== /\d [gsc]p left/.test(text)) out.push(buyer ? "buyer can't see the gold left" : "the table can see the buyer's gold");
  if (buyer !== shown(document.querySelector(".lc-reveal__open"))) out.push(buyer ? "no Open item for the buyer" : "Open item shown to the table");
  const close = document.querySelector(".lc-reveal__close");
  if (close?.textContent !== "Close" || close.disabled) out.push("landed reveal has no enabled Close");
  if (document.activeElement !== close) out.push("focus didn't move to Close on landing");
  // A spin that played out (or, here, landed with no motion) offers no Watch again.
  if (new URLSearchParams(location.search).get("watched") !== "0" && shown(document.querySelector(".lc-reveal__watch"))) out.push("Watch again after a spin this client saw");
  // The strip is wider than its clipped viewport by design; everything else must fit.
  for (const el of document.querySelectorAll(".lc-reveal__body *:not(.lc-spin__viewport *)")) {
    const r = el.getBoundingClientRect();
    if (r.right > document.documentElement.clientWidth + 1) { out.push(`reveal overflows: ${el.className}`); break; }
  }
  return out;
}

// Watch again in a reveal this client didn't see spin: shown beside Close
// (to its left, after Open item), the three buttons apart and inside the
// window. Pressed, it keeps focus, reads Skip, hides the result and remounts
// the strip; its Skip lands the same result and it reads Watch again again.
// Focus goes back to Close for the screenshot.
async function missedProblems() {
  const out = [];
  const frames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const shown = el => !!el && !el.hidden && el.getBoundingClientRect().height > 0;
  const [open, watch, close] = [".lc-reveal__open", ".lc-reveal__watch", ".lc-reveal__close"].map(s => document.querySelector(s));
  if (!shown(watch) || watch.textContent !== "Watch again") return ["no Watch again on a reveal this client didn't see spin"];
  const buttons = [...document.querySelectorAll(".lc-reveal__actions button")].filter(shown);
  if (buttons.map(b => b.className).join() !== [open, watch, close].map(b => b.className).join()) out.push("expected Open item, Watch again, Close in that order");
  const rects = buttons.map(b => b.getBoundingClientRect());
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const [a, b] = [rects[i], rects[j]];
    if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) out.push(`${buttons[i].textContent} overlaps ${buttons[j].textContent}`);
  }
  const app = document.getElementById("app").getBoundingClientRect();
  if (rects.some(r => r.left < app.left || r.right > app.right)) out.push("a reveal button leaves the window");
  const w = watch.getBoundingClientRect(), c = close.getBoundingClientRect();
  if (Math.abs(w.top - c.top) < 2 && w.right > c.left) out.push("Watch again isn't left of Close");
  if (parseFloat(getComputedStyle(watch).fontSize) < 11) out.push("Watch again is under 11px");
  const name = document.querySelector(".lc-reveal__name")?.textContent;
  watch.focus();
  watch.click();
  await frames();
  const result = document.querySelector(".lc-reveal__result");
  if (watch.textContent !== "Skip") out.push(`replaying, Watch again reads "${watch.textContent}"`);
  if (document.activeElement !== watch) out.push("focus left the pressed Watch again");
  if (getComputedStyle(result).visibility !== "hidden") out.push("the result shows during the replay");
  if (document.querySelector(".lc-spin--landed")) out.push("the strip wasn't remounted for the replay");
  watch.click();
  await frames();
  if (!document.querySelector(".lc-spin--landed")) out.push("Skip didn't land the replay");
  if (watch.textContent !== "Watch again" || !shown(watch)) out.push("after a skipped replay Watch again is gone");
  if (document.activeElement !== watch) out.push("focus left Watch again after its Skip");
  if (getComputedStyle(result).visibility === "hidden" || document.querySelector(".lc-reveal__name")?.textContent !== name) out.push("the replay didn't show the same result");
  close.focus();
  return out;
}

// A replay is display only: it says so in its title, lands on the card's
// item, and shows nobody's gold and no Open item. The card's Watch again is a
// visible button at the 11px floor.
function replayProblems() {
  const out = [];
  const shown = el => !!el && !el.hidden && el.getBoundingClientRect().height > 0;
  const title = document.getElementById("title")?.textContent ?? "";
  if (!/^Replay: .+ opens .+/.test(title)) out.push(`replay title doesn't say Replay: "${title}"`);
  const text = document.querySelector(".lc-reveal__result")?.innerText ?? "";
  if (/\d [gsc]p left/.test(text)) out.push("a replay shows gold left");
  if (shown(document.querySelector(".lc-reveal__open"))) out.push("a replay offers Open item");
  const card = document.querySelector(".lc-chat__name")?.textContent;
  const name = document.querySelector(".lc-reveal__name")?.textContent;
  if (!name || name !== card) out.push(`replay landed on "${name}", the card says "${card}"`);
  const landed = document.querySelector(".lc-card--landed .lc-card__name")?.textContent;
  if (landed !== card) out.push(`the strip landed on "${landed}"`);
  const close = document.querySelector(".lc-reveal__close");
  if (close?.textContent !== "Close" || document.activeElement !== close) out.push("landed replay has no focused Close");
  const btn = document.querySelector(".lc-chat .lc-chat__replay");
  if (!shown(btn) || btn.textContent !== "Watch again") out.push("chat card has no Watch again");
  else if (parseFloat(getComputedStyle(btn).fontSize) < 11) out.push("Watch again is under 11px");
  for (const el of document.querySelectorAll(".lc-reveal__body *:not(.lc-spin__viewport *), .lc-chat *")) {
    const r = el.getBoundingClientRect();
    if (r.right > document.documentElement.clientWidth + 1) { out.push(`replay overflows: ${el.className}`); break; }
  }
  return out;
}

// The shop's honesty rules, read from the DOM: no "0%" anywhere, every pill
// names its rarity, every unbuyable Buy (aria-disabled, never disabled, so it
// keeps focus) points at visible reasons, a shop-wide
// reason is said once (in the header's notice, never under a card), and the
// shop has one live region, which keeps its node across a re-render.
async function shopProblems(mode) {
  const closed = mode === "closed";
  const out = [];
  const text = document.querySelector(".lc-shop__body")?.innerText ?? "";
  if (/(^|[^\d<>])0%/.test(text)) out.push("shop shows a 0% chance");
  for (const pill of document.querySelectorAll(".lc-odd")) {
    if (!/^[A-Z][a-z. ]+ (<1|>99|\d{1,3})%$/.test(pill.textContent.trim())) out.push(`pill without a name: "${pill.textContent}"`);
  }
  if (document.querySelector(".lc-box__buy[disabled]")) out.push("a Buy is disabled (it can't keep focus); use aria-disabled");
  for (const btn of document.querySelectorAll('.lc-box__buy[aria-disabled="true"]')) {
    const ids = (btn.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
    const whys = ids.map(id => document.getElementById(id));
    if (!whys.length || whys.some(why => !why || !why.textContent.trim() || why.getBoundingClientRect().height === 0)) out.push(`unbuyable Buy without a visible reason: ${btn.dataset.box}`);
  }
  if (!document.querySelectorAll('.lc-box__buy[aria-disabled="true"]').length) out.push("sample shop has no unbuyable Buy to check");
  // Each Buy's name starts with its crate's, said only to screen readers:
  // the crate name in the Buy takes no visible room.
  for (const btn of document.querySelectorAll(".lc-box__buy")) {
    const name = btn.closest(".lc-box")?.querySelector(".lc-box__name")?.textContent.trim();
    const sr = btn.querySelector(".lc-sr-only");
    if (!name || !btn.textContent.trim().startsWith(`${name}: `)) out.push(`Buy doesn't name its crate: "${btn.textContent.trim()}"`);
    const box = sr?.getBoundingClientRect();
    if (!sr || box.width > 1 || box.height > 1) out.push(`the crate name in ${btn.dataset.box}'s Buy is visible`);
  }
  const status = document.querySelectorAll('[role="status"]');
  if (status.length !== 1 || !status[0].matches(".lc-shop__head .lc-shop__notice")) out.push(`expected one role=status, the header notice; got ${status.length}`);
  const notice = document.querySelector(".lc-shop__notice");
  const shopWide = /closed|GM is online|no character/i;
  for (const why of document.querySelectorAll(".lc-box__why")) if (shopWide.test(why.textContent)) out.push(`shop-wide reason under a card: "${why.textContent}"`);
  if (closed) {
    if (notice?.textContent !== "Closed until a GM is online.") out.push(`closed shop's notice reads "${notice?.textContent}"`);
    if ((text.match(/Closed until a GM is online/g) ?? []).length !== 1) out.push("the closed reason isn't said exactly once");
    if (document.querySelectorAll('.lc-box__buy:not([aria-disabled="true"])').length) out.push("a Buy is on in a closed shop");
    if (![...document.querySelectorAll(".lc-box__why")].some(w => /Needs .* more|Nothing inside/.test(w.textContent))) out.push("per-crate reasons are gone from a closed shop");
    return out;
  }
  if (notice?.textContent) out.push(`open shop's notice isn't empty: "${notice.textContent}"`);
  // The pity line: on the crate with a pity rule only, at the reason lines' 12px,
  // and when due, the odds are only the guaranteed rarities.
  const pity = [...document.querySelectorAll(".lc-box__pity")];
  if (pity.length !== 1 || pity[0].closest(".lc-box")?.dataset.box !== "adventurer") out.push(`expected one pity line, on the Adventurer's Crate; got ${pity.length}`);
  else {
    const want = mode === "pity" ? "Rare or better guaranteed this pull" : "Rare or better within 9 pulls";
    if (pity[0].textContent.trim() !== want) out.push(`pity line reads "${pity[0].textContent.trim()}", not "${want}"`);
    if (parseFloat(getComputedStyle(pity[0]).fontSize) < 12) out.push("pity line under 12px");
    const names = [...pity[0].closest(".lc-box").querySelectorAll(".lc-odd")].map(p => p.textContent.trim().split(" ")[0]);
    if (mode === "pity" && names.some(n => ["Common", "Uncommon"].includes(n))) out.push(`a due pity still shows ${names.join(", ")}`);
    if (mode !== "pity" && !names.includes("Common")) out.push("the Adventurer's Crate lost its Common odds before pity is due");
  }
  if (mode === "busy") {
    // As shop.js #buy does: focus the Buy, then busy, waiting, the purse
    // charged and idle renders. After each (two frames, for Chrome's focus
    // fixup) the same button and cards are there and the Buy has focus.
    const frames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const btn = document.querySelector('.lc-box__buy[data-box="common"]');
    const cards = [...document.querySelectorAll(".lc-box")];
    const select = document.querySelector(".lc-shop__actor");
    if (!select) out.push("the two-character shop has no character select");
    btn.focus();
    const steps = [
      ["busy", { busy: true, busyBox: "common" }, "Opening…"],
      ["waiting", { busy: true, busyBox: "common", waiting: "gm" }, "Waiting for the GM…"],
      ["charged", { busy: true, busyBox: "common", purse: { gp: 395, sp: 7, cp: 3 } }, "Opening…"],
      ["idle", {}, "Open for 25 gp"],
      // Left pressed for the screenshot.
      ["busy again", { busy: true, busyBox: "common" }, "Opening…"],
    ];
    for (const [label, extra, text] of steps) {
      window.__lootCrates.renderShop(extra);
      await frames();
      if (document.activeElement !== btn) out.push(`after the ${label} render, focus is on ${document.activeElement?.tagName}`);
      if (document.querySelector('.lc-box__buy[data-box="common"]') !== btn) out.push(`the ${label} render replaced the pressed Buy`);
      if ([...document.querySelectorAll(".lc-box")].some((c, i) => c !== cards[i])) out.push(`the ${label} render replaced a card`);
      if (btn.textContent.trim() !== `Pauper's Box: ${text}`) out.push(`after the ${label} render the Buy reads "${btn.textContent.trim()}"`);
      if (document.querySelector(".lc-shop__actor") !== select) out.push(`the ${label} render replaced the character select`);
      const off = select?.getAttribute("aria-disabled") === "true";
      if (off !== !!extra.busy) out.push(`after the ${label} render the select is ${off ? "off" : "on"}`);
      if (select?.disabled) out.push("the select is disabled (it can't keep focus); use aria-disabled");
    }
    if (btn.getAttribute("aria-disabled") !== "true") out.push("the pressed Buy isn't aria-disabled while busy");
    if (document.querySelectorAll('.lc-box__buy:not([aria-disabled="true"])').length) out.push("a Buy is on while a pull is out");
    return out;
  }
  // Re-render as the shop does when the GM is slow, then back: same node, new text.
  window.__lootCrates.renderShop({ busy: true, busyBox: "common", waiting: "gm" });
  const after = document.querySelector(".lc-shop__notice");
  if (after !== notice) out.push("the notice node was replaced on re-render");
  if (!/^Waiting for the GM/.test(after?.textContent ?? "")) out.push(`waiting notice reads "${after?.textContent}"`);
  const pressed = document.querySelector('.lc-box__buy[data-box="common"]');
  if (pressed?.getAttribute("aria-describedby") !== "lc-shop-notice") out.push("the waiting Buy doesn't point at the notice");
  window.__lootCrates.renderShop();
  if (document.querySelector(".lc-shop__notice") !== notice || notice.textContent) out.push("the notice didn't clear in place");
  return out;
}

const server = await serveStatic(root, PORT);
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
let failures = 0;
try {
  for (const w of WIDTHS) {
    const ctx = await browser.newContext({ viewport: w.viewport, isMobile: w.isMobile, hasTouch: w.hasTouch, reducedMotion: "reduce" });
    await mkdir(path.join(OUT, w.tag), { recursive: true });
    for (const theme of THEMES) for (const [name, query0] of STATES) {
      const query = `${query0}&theme=${theme}`;
      const shot = `${name}${theme === "light" ? "-light" : ""}`;
      const page = await ctx.newPage();
      const errors = [];
      const problems0 = [];
      page.on("pageerror", e => errors.push(e.message));
      // A missing borrowed asset (no FOUNDRY_URL, or Foundry is off) falls
      // back to system fonts and plain grounds; that isn't a failure.
      page.on("console", m => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text()); });
      await page.goto(`http://localhost:${PORT}/harness/?${query}`, { waitUntil: "networkidle" });
      if (name.startsWith("landed") || name === "replay") await page.waitForSelector("body[data-landed]", { timeout: 10000 });
      if (name.startsWith("manager")) await page.waitForSelector("body[data-ready]", { timeout: 10000 });
      await page.waitForTimeout(500);
      const wide = await page.evaluate(() => document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth + 1);
      if (name.startsWith("shop")) problems0.push(...await page.evaluate(shopProblems, name.slice(5)));
      else if (name === "manager-dropped") problems0.push(...await page.evaluate(droppedProblems));
      else if (name.startsWith("manager")) problems0.push(...await page.evaluate(managerProblems, name === "manager-narrow"));
      else if (name === "replay") problems0.push(...await page.evaluate(replayProblems));
      else problems0.push(...await page.evaluate(revealProblems, name === "landed-buyer" || name === "landed-missed"));
      if (name === "landed-missed") problems0.push(...await page.evaluate(missedProblems));
      if (name === "shop-short") {
        const grid = await page.$(".lc-shop__grid");
        const box = await grid.boundingBox();
        const before = await page.evaluate(() => ({ scrollable: (g => g.scrollHeight > g.clientHeight + 1)(document.querySelector(".lc-shop__grid")), top: document.querySelector(".lc-shop__grid").scrollTop }));
        if (!before.scrollable) problems0.push("short shop: the grid doesn't overflow, so the state tests nothing");
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 400);
        await page.waitForTimeout(300);
        problems0.push(...await page.evaluate(() => {
          const out = [];
          const grid = document.querySelector(".lc-shop__grid"), head = document.querySelector(".lc-shop__head");
          const win = document.getElementById("app").getBoundingClientRect(), g = grid.getBoundingClientRect(), h = head.getBoundingClientRect();
          if (grid.scrollTop < 1) out.push("short shop: a mouse wheel over the crates doesn't scroll them");
          const last = [...grid.querySelectorAll(".lc-box")].at(-1)?.getBoundingClientRect();
          if (!last || last.bottom > g.bottom + 1 || last.bottom > win.bottom + 1) out.push("short shop: the last crate can't be scrolled into view");
          if (h.top < win.top || h.bottom > g.top + 1) out.push("short shop: the head (character, purse) scrolled away");
          return out;
        }));
      }
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: path.join(OUT, w.tag, `${shot}.png`), fullPage: true });
      const problems = [...errors, ...problems0, ...(wide ? ["page scrolls sideways"] : [])];
      if (problems.length) { failures++; console.error(`FAIL ${w.tag}/${shot}: ${problems.join("; ")}`); }
      else console.log(`ok   ${w.tag}/${shot}`);
      await page.close();
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failures ? 1 : 0);
