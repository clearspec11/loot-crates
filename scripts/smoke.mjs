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
  // The Wishing Well's three results (well.js), landed, as the buyer sees
  // them: a quiet line for nothing and for the coin back, the item block
  // for a find, each in the window's live region; no Watch again.
  ["well-missed", "state=well&outcome=nothing&buyer=1&duration=0"],
  ["well-coin", "state=well&outcome=coin&buyer=1&duration=0"],
  ["well-won", "state=well&outcome=item&buyer=1&duration=0&seed=3"],
  // Tam has thrown today's three coins: the well's Buy is off with the
  // "still until tomorrow" line under it.
  ["shop-well-capped", "state=shop&well=capped"],
  // Dragon's Teeth (dicegame.js): the dice still tumbling (the button reads
  // Skip, no total, no result yet), then landed on a win and on a loss as
  // the buyer sees them: the verdict in the live region, the faces, the
  // coins and the purse; no Watch again.
  ["dice-rolling", "state=dice&outcome=win&buyer=1&phase=rolling&duration=100000"],
  ["dice-won", "state=dice&outcome=win&buyer=1&duration=0"],
  ["dice-lost", "state=dice&outcome=lose&buyer=1&duration=0"],
  // The Deck of Many Things (deck.js): the card held face-down mid-hold
  // (the button reads Skip, nothing of the face shows), then landed on an
  // item (a boon), a loss (the bane: cold slate, a dimmed vault, no gold
  // and no amber) and an effect (the GM's text), as the buyer sees them
  // with Draw again beside Close; the loss is the third draw in a row, so
  // the head says so and Draw again names the risen price.
  ["deck-held", "state=deck&outcome=coins&buyer=1&phase=held"],
  ["deck-boon", "state=deck&outcome=item&buyer=1&duration=0&seed=3"],
  ["deck-bane", "state=deck&outcome=loss&buyer=1&duration=0&streak=2"],
  ["deck-effect", "state=deck&outcome=effect&buyer=1&duration=0"],
  // Tam drew from the deck a moment ago: its card prices the next draw at
  // 15 gp and says why.
  ["shop-deck-streak", "state=shop&streak=1"],
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

/*
  The Wishing Well's reveal, read from the DOM: the result text is the
  outcome's (and sits in a live region, so a screen reader hears it land),
  the buyer sees the gold left, Close is focused, there is no Watch again,
  the stage names the outcome and shows what it should (the coin back over
  the water, the find surfaced), and nothing leaves the window.
*/
function wellProblems(outcome) {
  const out = [];
  const shown = el => !!el && !el.hidden && el.getBoundingClientRect().height > 0;
  const result = document.querySelector(".lc-reveal__result");
  const text = result?.innerText ?? "";
  const want = { nothing: "The coin sinks. Nothing.", coin: "The coin comes back." }[outcome];
  if (want && !text.includes(want)) out.push(`result reads "${text}"`);
  if (!result?.closest("[aria-live]")) out.push("the result is not in a live region");
  if (!/\d [gsc]p left/.test(text)) out.push("the buyer can't see the gold left");
  if (!/\d of \d throws today/.test(text)) out.push("the buyer isn't told today's count");
  if (outcome === "item") {
    if (!document.querySelector(".lc-reveal__name")?.textContent) out.push("no item name in the result");
    if (!/Added to .+'s inventory/.test(text)) out.push("a find doesn't say where it went");
  } else if (/inventory/.test(text)) out.push("a quiet throw mentions the inventory");
  const stage = document.querySelector(".lc-well");
  if (!stage?.classList.contains("lc-well--landed")) out.push("the well never landed");
  if (stage?.dataset.outcome !== outcome) out.push(`the stage says "${stage?.dataset.outcome}"`);
  const coin = document.querySelector(".lc-well__coin");
  const coinShown = !!coin && parseFloat(getComputedStyle(coin).opacity) > 0.5;
  if ((outcome === "coin") !== coinShown) out.push(outcome === "coin" ? "the coin didn't come back" : "the coin is still showing");
  const prize = document.querySelector(".lc-well__prize");
  if (outcome === "item" && !(prize && parseFloat(getComputedStyle(prize).opacity) > 0.9 && prize.querySelector("img"))) out.push("the find didn't surface");
  const close = document.querySelector(".lc-reveal__close");
  if (close?.textContent !== "Close" || close.disabled || document.activeElement !== close) out.push("landed well has no focused Close");
  if (shown(document.querySelector(".lc-reveal__watch"))) out.push("Watch again on a well");
  if ((outcome === "item") !== shown(document.querySelector(".lc-reveal__open"))) out.push(outcome === "item" ? "no Open item for a find" : "Open item for a throw with no item");
  const quiet = document.querySelector(".lc-reveal__quiet");
  if (quiet && parseFloat(getComputedStyle(quiet).fontSize) < 11) out.push("the quiet line is under 11px");
  const head = document.querySelector(".lc-reveal__head")?.innerText.replace(/\s+/g, " ") ?? "";
  if (!/throws a coin into Wishing Well 1 sp/.test(head)) out.push(`head reads "${head}"`);
  for (const el of document.querySelectorAll(".lc-reveal__body *")) {
    const r = el.getBoundingClientRect();
    if (r.right > document.documentElement.clientWidth + 1) { out.push(`well overflows: ${el.className}`); break; }
  }
  return out;
}

/*
  Dragon's Teeth's reveal, read from the DOM. Landed: the verdict names the
  total and the dragon's number and sits in a live region, the faces shown
  are the sample's (4, 6, 5 or 2, 3, 4), the total under them is their
  sum, the buyer sees the coins and the purse, Close is focused, there is
  no Watch again and no Open item, the stage names the outcome. Rolling:
  the button reads Skip, the result is empty, no total shows, the faces
  tumble (none is blank), the dragon's number is on the stage.
*/
function diceProblems(outcome) {
  const out = [];
  const shown = el => !!el && !el.hidden && el.getBoundingClientRect().height > 0;
  const stage = document.querySelector(".lc-dice");
  if (!stage) return ["no dice stage"];
  const faces = [...document.querySelectorAll(".lc-dice__tray .lc-dice__face")].map(f => f.textContent.trim());
  const dragon = document.querySelector(".lc-dice__dragon")?.textContent.replace(/\s+/g, " ").trim() ?? "";
  if (dragon !== "The dragon's 12") out.push(`the dragon line reads "${dragon}"`);
  const total = document.querySelector(".lc-dice__total");
  const head = document.querySelector(".lc-reveal__head")?.innerText.replace(/\s+/g, " ") ?? "";
  if (!/rolls 3d6 to beat the dragon's 12 at Dragon's Teeth 10 gp/.test(head)) out.push(`head reads "${head}"`);
  for (const el of document.querySelectorAll(".lc-reveal__body *")) {
    const r = el.getBoundingClientRect();
    if (r.right > document.documentElement.clientWidth + 1) { out.push(`dice overflow: ${el.className}`); break; }
  }
  const btn = document.querySelector(".lc-reveal__close");
  if (outcome === "rolling") {
    if (stage.classList.contains("lc-dice--landed")) out.push("the dice landed before the screenshot");
    if (btn?.textContent !== "Skip") out.push(`mid-roll button reads "${btn?.textContent}"`);
    if (document.querySelector(".lc-reveal__result")?.innerHTML.trim()) out.push("the result shows mid-roll");
    if (total?.textContent.trim() || parseFloat(getComputedStyle(total).opacity) > 0.05) out.push("the total shows mid-roll");
    if (faces.length !== 3 || faces.some(f => !/^[1-6]$/.test(f))) out.push(`tumbling faces: ${faces.join(",")}`);
    if (faces.join(",") === "4,6,5") out.push("the tumbling dice already show the result");
    return out;
  }
  const want = { win: ["4", "6", "5"], lose: ["2", "3", "4"] }[outcome];
  if (faces.join(",") !== want.join(",")) out.push(`landed faces: ${faces.join(",")}`);
  const sum = String(want.reduce((n, f) => n + Number(f), 0));
  if (total?.textContent.trim() !== sum || parseFloat(getComputedStyle(total).opacity) < 0.95) out.push(`total reads "${total?.textContent}"`);
  if (!stage.classList.contains("lc-dice--landed")) out.push("the dice never landed");
  if (stage.dataset.outcome !== outcome) out.push(`the stage says "${stage.dataset.outcome}"`);
  if (document.querySelectorAll(".lc-dice__die--set").length !== 3) out.push("not every die settled");
  const result = document.querySelector(".lc-reveal__result");
  const text = result?.innerText.replace(/\s+/g, " ") ?? "";
  const verdict = outcome === "win" ? "15 beats the dragon's 12" : "9 doesn't beat the dragon's 12";
  if (!text.includes(verdict)) out.push(`result reads "${text}"`);
  if (!result?.closest("[aria-live]")) out.push("the result is not in a live region");
  if (!text.includes(`Rolled ${want.join(", ")} on 3d6`)) out.push("the result doesn't name the faces");
  if (!text.includes(outcome === "win" ? "Won 30 gp" : "Lost 10 gp")) out.push("the result doesn't say what the coins did");
  if (!/\d [gsc]p in the purse/.test(text)) out.push("the buyer can't see the purse");
  if (/inventory/.test(text)) out.push("a coin result mentions the inventory");
  const verdictEl = document.querySelector(".lc-dice__verdict");
  if (verdictEl && parseFloat(getComputedStyle(verdictEl).fontSize) < 11) out.push("the verdict is under 11px");
  if (btn?.textContent !== "Close" || btn.disabled || document.activeElement !== btn) out.push("landed dice have no focused Close");
  if (shown(document.querySelector(".lc-reveal__watch"))) out.push("Watch again on the dice");
  if (shown(document.querySelector(".lc-reveal__open"))) out.push("Open item for a coin result");
  return out;
}

/*
  The Deck of Many Things' reveal, read from the DOM. Held: the card is up
  and face-down (its back faces the viewer, the front's label is not
  visible), the button reads Skip, the result is empty. Landed: the card
  has turned (its front shows the card's name), the stage names the tone,
  the result is in a live region and says the card's name, what it did, the
  gold left and the cards left; Draw again is shown to the buyer with the
  next price; no Watch again. A bane's name is set in the bane token, which
  is neither the gold rim, the pin gold, the warn amber nor a rarity; the
  vault is dimmed, not washed.
*/
function deckProblems(outcome) {
  const out = [];
  const shown = el => !!el && !el.hidden && el.getBoundingClientRect().height > 0;
  const stage = document.querySelector(".lc-deck");
  if (!stage) return ["no deck stage"];
  const card = stage.querySelector(".lc-deck__card");
  const front = stage.querySelector(".lc-deck__face--front");
  const label = stage.querySelector(".lc-deck__label");
  const btn = document.querySelector(".lc-reveal__close");
  const head = document.querySelector(".lc-reveal__head")?.innerText.replace(/\s+/g, " ") ?? "";
  if (!/draws from The Thornwick Deck \d+ gp/.test(head)) out.push(`head reads "${head}"`);
  for (const el of document.querySelectorAll(".lc-reveal__body *")) {
    const r = el.getBoundingClientRect();
    if (r.right > document.documentElement.clientWidth + 1) { out.push(`deck overflows: ${el.className}`); break; }
  }
  // Which face is toward the viewer: the card's rotateY, read from its matrix.
  const turned = () => { const m = new DOMMatrix(getComputedStyle(card).transform); return m.m11 < 0; };
  if (outcome === "held") {
    if (stage.classList.contains("lc-deck--landed")) out.push("the card landed before the screenshot");
    if (btn?.textContent !== "Skip") out.push(`mid-hold button reads "${btn?.textContent}"`);
    if (document.querySelector(".lc-reveal__result")?.innerHTML.trim()) out.push("the result shows mid-hold");
    if (turned()) out.push("the card is already turned mid-hold");
    if (getComputedStyle(card).transform === "none" || new DOMMatrix(getComputedStyle(card).transform).m42 > -10) out.push("the card hasn't lifted");
    if (!label?.textContent) out.push("the front has no label");
    if (shown(document.querySelector(".lc-reveal__again"))) out.push("Draw again before the card turned");
    return out;
  }
  if (!stage.classList.contains("lc-deck--landed")) out.push("the deck never landed");
  if (!turned()) out.push("the card hasn't turned");
  const want = { item: "boon", loss: "bane", effect: "effect", coins: "coin", blank: "blank" }[outcome];
  if (stage.dataset.tone !== want) out.push(`the stage says "${stage.dataset.tone}"`);
  const result = document.querySelector(".lc-reveal__result");
  const text = result?.innerText.replace(/\s+/g, " ") ?? "";
  if (!result?.closest("[aria-live]")) out.push("the result is not in a live region");
  if (!/\d of \d cards left/.test(text)) out.push("the result doesn't count the cards left");
  if (!/\d [gsc]p left/.test(text)) out.push("the buyer can't see the gold left");
  if (outcome === "item") {
    if (!document.querySelector(".lc-reveal__name")?.textContent) out.push("no item name in the result");
    if (!/Added to .+'s inventory/.test(text)) out.push("a boon doesn't say where it went");
    if (label?.textContent !== "Fortune") out.push(`the card reads "${label?.textContent}"`);
  } else {
    if (/inventory/.test(text)) out.push("a card with no item mentions the inventory");
    if (!shown(document.querySelector(".lc-reveal__quiet"))) out.push("no quiet line for the card");
  }
  if (outcome === "loss") {
    if (!text.includes("Ruin") || !text.includes("The card takes 20 gp")) out.push(`bane result reads "${text}"`);
    if (!/3rd in a row/.test(head)) out.push(`the third draw's head reads "${head}"`);
    const quiet = document.querySelector(".lc-reveal__quiet");
    const colour = getComputedStyle(quiet).color;
    const vault = document.querySelector(".lc-vault");
    const tokens = Object.fromEntries(["--lc-bane", "--lc-gold-rim", "--lc-pin", "--lc-warn", "--lc-common", "--lc-uncommon", "--lc-rare", "--lc-veryRare", "--lc-legendary", "--lc-artifact"].map(k => [k, getComputedStyle(vault).getPropertyValue(k).trim()]));
    const rgb = hex => { const n = parseInt(hex.slice(1), 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`; };
    if (colour !== rgb(tokens["--lc-bane"])) out.push(`the bane's name is ${colour}, not the bane token ${tokens["--lc-bane"]}`);
    for (const [k, v] of Object.entries(tokens)) if (k !== "--lc-bane" && v && rgb(v) === colour) out.push(`the bane reads in ${k}`);
    if (getComputedStyle(front).borderTopColor !== rgb(tokens["--lc-bane"])) out.push("the turned card isn't edged in the bane token");
    const again = document.querySelector(".lc-reveal__again");
    if (again?.textContent !== "Draw again for 33 gp 7 sp 5 cp") out.push(`the third draw's Draw again reads "${again?.textContent}"`);
  }
  if (outcome === "effect") {
    if (!document.querySelector(".lc-deck__text")?.textContent.includes("long rest")) out.push("the effect's text isn't shown");
    if (!text.includes("The GM plays it out")) out.push(`effect result reads "${text}"`);
  }
  if (btn?.textContent !== "Close" || btn.disabled || document.activeElement !== btn) out.push("landed deck has no focused Close");
  if (shown(document.querySelector(".lc-reveal__watch"))) out.push("Watch again on the deck");
  if ((outcome === "item") !== shown(document.querySelector(".lc-reveal__open"))) out.push(outcome === "item" ? "no Open item for a boon" : "Open item for a card with no item");
  const again = document.querySelector(".lc-reveal__again");
  if (!shown(again) || !/^Draw again for \d+ gp/.test(again.textContent)) out.push(`Draw again reads "${again?.textContent}"`);
  if (parseFloat(getComputedStyle(again).fontSize) < 11) out.push("Draw again is under 11px");
  const kindEl = stage.querySelector(".lc-deck__kind");
  if (parseFloat(getComputedStyle(kindEl).fontSize) < 11) out.push("the card's kind line is under 11px");
  return out;
}

// The deck's card in the shop: the kinds of card as pills (no 0%), a
// ribbon, the cards left, "Draw for 10 gp" on the Buy, and after a draw in
// a row the risen price with the line that says so.
function deckCardProblems({ streak, closed, busy }) {
  const out = [];
  const card = document.querySelector('.lc-box[data-box="deck"]');
  if (!card) return ["no deck card in the shop"];
  const buy = card.querySelector(".lc-box__buy");
  const pills = [...card.querySelectorAll(".lc-odd")].map(p => p.textContent.trim()).join(", ");
  if (pills !== "Item 20%, Coins 20%, Loss 20%, Effect 10%, Blank 30%") out.push(`deck pills: ${pills}`);
  if (card.querySelectorAll(".lc-ribbon__seg").length !== 5) out.push("the deck's ribbon doesn't show its five kinds");
  if (card.querySelector(".lc-box__stock")?.textContent.trim() !== "5 of 5 cards left") out.push(`cards left reads "${card.querySelector(".lc-box__stock")?.textContent}"`);
  const rule = card.querySelector(".lc-box__rule")?.textContent.trim() ?? "";
  if (streak) {
    if (!buy.textContent.includes("Draw for 15 gp")) out.push(`the second draw's Buy reads "${buy.textContent.trim()}"`);
    if (buy.dataset.price !== "15") out.push(`the second draw's data-price is ${buy.dataset.price}`);
    if (rule !== "2nd draw in a row: 15 gp (back to 10 gp after two minutes)") out.push(`the streak line reads "${rule}"`);
    if (parseFloat(getComputedStyle(card.querySelector(".lc-box__rule")).fontSize) < 11) out.push("the streak line is under 11px");
  } else {
    if (!buy.textContent.includes("Draw for 10 gp")) out.push(`deck Buy reads "${buy.textContent.trim()}"`);
    if (rule) out.push(`a first draw has a streak line: "${rule}"`);
  }
  if (!closed && !busy && buy.getAttribute("aria-disabled") === "true") out.push(`the deck Buy is off for "${card.querySelector(".lc-box__why")?.textContent}"`);
  return out;
}

// The dice card in the shop: the rule in words, Win and Lose as pills (no
// 0%), a ribbon, the payout line, the prize line in its rarity, and "Bet
// 10 gp" on the Buy, which is on in an open shop with no pull out.
function diceCardProblems({ closed, busy }) {
  const out = [];
  const card = document.querySelector('.lc-box[data-box="dice"]');
  if (!card) return ["no dice card in the shop"];
  const buy = card.querySelector(".lc-box__buy");
  const pills = [...card.querySelectorAll(".lc-odd")].map(p => p.textContent.trim()).join(", ");
  if (pills !== "Win 26%, Lose 74%") out.push(`dice pills: ${pills}`);
  if (card.querySelectorAll(".lc-ribbon__seg").length !== 2) out.push("the dice ribbon doesn't show win and lose");
  const rule = card.querySelector(".lc-box__rule")?.textContent.trim();
  if (rule !== "Roll 3d6 over the dragon's 12") out.push(`dice rule reads "${rule}"`);
  if (card.querySelector(".lc-box__stock")?.textContent.trim() !== "Pays 3× the stake: 30 gp") out.push(`dice payout reads "${card.querySelector(".lc-box__stock")?.textContent}"`);
  const prize = card.querySelector(".lc-box__prize");
  if (prize?.textContent.trim() !== "A perfect 18 also wins an item") out.push(`dice prize reads "${prize?.textContent}"`);
  if (prize && !prize.classList.contains("lc-rarity-legendary")) out.push("the prize line isn't in its best rarity");
  if (!buy.textContent.includes("Bet 10 gp")) out.push(`dice Buy reads "${buy.textContent.trim()}"`);
  if (!closed && !busy && buy.getAttribute("aria-disabled") === "true") out.push(`the dice Buy is off for "${card.querySelector(".lc-box__why")?.textContent}"`);
  for (const el of [rule, prize].map((_, i) => card.querySelectorAll(".lc-box__rule, .lc-box__prize")[i]).filter(Boolean)) {
    if (parseFloat(getComputedStyle(el).fontSize) < 11) out.push(`${el.className} is under 11px`);
  }
  return out;
}

// The well's card in the shop: the three outcomes named as pills (no 0%, no
// rarity colour on paper beyond the diamond), a ribbon, "Throw 1 sp" on the
// Buy, today's count under it, and at the cap the Buy off with the "still
// until tomorrow" line as its visible reason.
function wellCardProblems({ capped, closed }) {
  const out = [];
  const card = document.querySelector('.lc-box[data-box="well"]');
  if (!card) return ["no well card in the shop"];
  const buy = card.querySelector(".lc-box__buy");
  const pills = [...card.querySelectorAll(".lc-odd")].map(p => p.textContent.trim()).join(", ");
  if (pills !== "Nothing 90%, Coin back 8%, Item 2%") out.push(`well pills: ${pills}`);
  if (card.querySelectorAll(".lc-ribbon__seg").length !== 3) out.push("the well's ribbon doesn't show its three outcomes");
  const why = card.querySelector(".lc-box__why")?.textContent.trim() ?? "";
  const count = card.querySelector(".lc-box__stock")?.textContent.trim() ?? "";
  if (!buy.textContent.includes("Throw 1 sp")) out.push(`well Buy reads "${buy.textContent.trim()}"`);
  if (capped) {
    if (buy.getAttribute("aria-disabled") !== "true") out.push("the capped well's Buy is on");
    if (why !== "The well is still until tomorrow (3 of 3 today)") out.push(`the capped well says "${why}"`);
    if (count) out.push(`the capped well still counts: "${count}"`);
    if (parseFloat(getComputedStyle(card.querySelector(".lc-box__why")).fontSize) < 11) out.push("the still line is under 11px");
  } else {
    if (count !== "1 of 3 throws today") out.push(`the well's count reads "${count}"`);
    if (!closed && why) out.push(`the well is off for "${why}"`);
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
      if (name.startsWith("landed") || name === "replay" || name.startsWith("well") || (name.startsWith("dice") && name !== "dice-rolling") || (name.startsWith("deck") && name !== "deck-held")) await page.waitForSelector("body[data-landed]", { timeout: 10000 });
      // Mid-hold: the card is posed face-down (reduced motion is off for
      // this state); a frame in, it has lifted.
      if (name === "deck-held") await page.waitForFunction(() => getComputedStyle(document.querySelector(".lc-deck__card")).transform !== "none", null, { timeout: 10000 });
      // Mid-roll: the dice are tumbling (reduced motion is off for this
      // state); two frames in, they have faces to show.
      if (name === "dice-rolling") await page.waitForFunction(() => [...document.querySelectorAll(".lc-dice__tray .lc-dice__face")].every(f => f.textContent.trim()), null, { timeout: 10000 });
      if (name.startsWith("manager")) await page.waitForSelector("body[data-ready]", { timeout: 10000 });
      await page.waitForTimeout(500);
      const wide = await page.evaluate(() => document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth + 1);
      if (name.startsWith("shop")) {
        problems0.push(...await page.evaluate(shopProblems, name.slice(5)));
        problems0.push(...await page.evaluate(wellCardProblems, { capped: name === "shop-well-capped", closed: name === "shop-closed" }));
        problems0.push(...await page.evaluate(diceCardProblems, { closed: name === "shop-closed", busy: name === "shop-busy" }));
        problems0.push(...await page.evaluate(deckCardProblems, { streak: name === "shop-deck-streak", closed: name === "shop-closed", busy: name === "shop-busy" }));
      }
      else if (name.startsWith("dice")) problems0.push(...await page.evaluate(diceProblems, { "dice-rolling": "rolling", "dice-won": "win", "dice-lost": "lose" }[name]));
      else if (name.startsWith("deck")) problems0.push(...await page.evaluate(deckProblems, { "deck-held": "held", "deck-boon": "item", "deck-bane": "loss", "deck-effect": "effect" }[name]));
      else if (name === "manager-dropped") problems0.push(...await page.evaluate(droppedProblems));
      else if (name.startsWith("manager")) problems0.push(...await page.evaluate(managerProblems, name === "manager-narrow"));
      else if (name === "replay") problems0.push(...await page.evaluate(replayProblems));
      else if (name.startsWith("well")) problems0.push(...await page.evaluate(wellProblems, { "well-missed": "nothing", "well-coin": "coin", "well-won": "item" }[name]));
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
