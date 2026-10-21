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
  ["shop-busy", "state=shop"],
  ["landed", "state=landed&seed=7"],
  ["landed-legendary", "state=landed&seed=36&box=royal"],
  ["landed-buyer", "state=landed&seed=7&buyer=1"],
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
  if (document.querySelector('[role="tablist"] .lc-shop-toggle')) out.push("the shop switch is inside the tablist");
  if (!document.querySelector('.lc-tab[role="tabpanel"]')) out.push("no role=tabpanel");
  const pools = [...document.querySelectorAll(".lc-pool__details")];
  if (pools.length < 3) out.push(`expected 3 sample pools, got ${pools.length}`);
  for (const d of pools) {
    const selects = d.querySelectorAll("select.lc-entry__rarity").length;
    if (d.open && selects > 50) out.push(`${d.dataset.pool}: ${selects} rarity selects drawn`);
    if (!d.open && d.querySelector(".lc-entry")) out.push(`${d.dataset.pool}: collapsed but rows drawn`);
    if (!/\d+ items?/.test(d.querySelector("summary .lc-pool__count")?.textContent ?? "")) out.push(`${d.dataset.pool}: no census in the summary`);
  }
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
  // The strip is wider than its clipped viewport by design; everything else must fit.
  for (const el of document.querySelectorAll(".lc-reveal__body *:not(.lc-spin__viewport *)")) {
    const r = el.getBoundingClientRect();
    if (r.right > document.documentElement.clientWidth + 1) { out.push(`reveal overflows: ${el.className}`); break; }
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
      if (btn.textContent.trim() !== text) out.push(`after the ${label} render the Buy reads "${btn.textContent.trim()}"`);
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
      if (name.startsWith("landed")) await page.waitForSelector("body[data-landed]", { timeout: 10000 });
      if (name.startsWith("manager")) await page.waitForSelector("body[data-ready]", { timeout: 10000 });
      await page.waitForTimeout(500);
      const wide = await page.evaluate(() => document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth + 1);
      if (name.startsWith("shop")) problems0.push(...await page.evaluate(shopProblems, name.slice(5)));
      else if (name === "manager-dropped") problems0.push(...await page.evaluate(droppedProblems));
      else if (name.startsWith("manager")) problems0.push(...await page.evaluate(managerProblems, name === "manager-narrow"));
      else problems0.push(...await page.evaluate(revealProblems, name === "landed-buyer"));
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
