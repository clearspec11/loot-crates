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
  ["landed", "state=landed&seed=7"],
  ["landed-legendary", "state=landed&seed=36&box=royal"],
  ["landed-buyer", "state=landed&seed=7&buyer=1"],
  ["manager", "state=manager"],
];

// The pool editor as a craft table, read from the DOM: an open pool draws at
// most a page of controls, a collapsed one none (its census still shown),
// one status line and no per-pool live regions, and the "No rarity set" chip
// shows only unset rows and says it is pressed.
async function managerProblems() {
  const out = [];
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
// names its rarity, every disabled Buy points at a visible reason.
function shopProblems() {
  const out = [];
  const text = document.querySelector(".lc-shop__body")?.innerText ?? "";
  if (/(^|[^\d<>])0%/.test(text)) out.push("shop shows a 0% chance");
  for (const pill of document.querySelectorAll(".lc-odd")) {
    if (!/^[A-Z][a-z. ]+ (<1|>99|\d{1,3})%$/.test(pill.textContent.trim())) out.push(`pill without a name: "${pill.textContent}"`);
  }
  for (const btn of document.querySelectorAll(".lc-box__buy[disabled]")) {
    const why = document.getElementById(btn.getAttribute("aria-describedby") ?? "");
    if (!why || !why.textContent.trim() || why.getBoundingClientRect().height === 0) out.push(`disabled Buy without a visible reason: ${btn.dataset.box}`);
  }
  if (!document.querySelectorAll(".lc-box__buy[disabled]").length) out.push("sample shop has no disabled Buy to check");
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
      if (name === "manager") await page.waitForSelector("body[data-ready]", { timeout: 10000 });
      await page.waitForTimeout(500);
      const wide = await page.evaluate(() => document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth + 1);
      if (name === "shop") problems0.push(...await page.evaluate(shopProblems));
      else if (name === "manager") problems0.push(...await page.evaluate(managerProblems));
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
