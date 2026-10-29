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
  // Tam has bought the Pauper's Box twice, its limit per character: its
  // card reads "Limit reached: 2 of 2 for Tam Thornwick" with the Buy off
  // (the plain shop shows "You can buy 1 more" and "3 of 10 left").
  ["shop-limit", "state=shop&limit=reached"],
  // The Royal Vault is off the shelf: a player's shop leaves it out.
  ["shop-shelf", "state=shop&shelf=off"],
  // The GM's shop (route.js): every game on it, and "Manage crates" in the
  // window's header controls, their menu drawn open beside the title.
  ["shop-gm", "state=shop&gm=1"],
  // An empty shelf: a player is told the GM hasn't put anything out (no
  // talk of Game Settings); a GM is pointed at Manage crates.
  ["shop-empty", "state=shop&empty=1"],
  ["shop-empty-gm", "state=shop&empty=1&gm=1"],
  // The box editor's Limits group: the stock with what is left and
  // Restock, then the limit per character, each with its help.
  ["box-limits", "state=editor"],
  // The deck editor's head (deck.js deckRiseFieldsHTML): the step, then
  // "Draws count as in a row within 2 minutes" with its hint.
  ["editor-deck", "state=editor&deck=1"],
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
  // The Wheel of Fate has no round open: its card says so, "Place a bet" off.
  ["shop-no-round", "state=shop&round=none"],
  // The shared table window (tableview.js) on the wheel (roulette.js):
  // three characters' chips on the rail with the clock and Tam's bet form
  // (a bad stake refused on the line, a bet placed drops a chip); bets
  // closed as the GM sees it, with Spin; bets closed as a player sees it;
  // the ball mid-spin (the button reads Skip, no result, reduced motion
  // off); landed on 7 where Tam's two bets win, and on 8 where they lose.
  ["table-betting", "state=table&phase=betting"],
  ["table-waiting", "state=table&phase=waiting&gm=1"],
  ["table-closed", "state=table&phase=closed"],
  ["roulette-spinning", "state=table&phase=spinning&duration=100000"],
  ["roulette-won", "state=table&phase=landed&outcome=win&duration=0"],
  ["roulette-lost", "state=table&phase=landed&outcome=lose&duration=0"],
  // The Auction (auction.js) in the same window: open with no bids yet
  // (the lot, the opening bid, the gavel draining, Tam's "Bid 20 gp");
  // bids from players and a house bidder (the house's 40 gp on top,
  // Orla's struck through and said to have come back), where a bid under
  // the next legal one is refused on the line and Tam's 50 gp lands on
  // top, beats the house and fills the gavel again; the GM's view (the
  // gavel and Call it off, no form); the hammer (Sold to Tam for 45 gp,
  // the stamp, the verdict in the live region, Close focused); and a
  // sealed crate's strip landed on Tam's draw.
  ["auction-open", "state=auction&phase=open"],
  ["auction-bid", "state=auction&phase=bid"],
  ["auction-gm", "state=auction&phase=bid&gm=1"],
  ["auction-hammer", "state=auction&phase=hammer&duration=0"],
  ["auction-crate", "state=auction&phase=hammer&lot=crate&duration=0"],
  ["manager", "state=manager"],
  // A manager window sized 480 px wide, on any screen: its rows follow the
  // window (a container query), so names wrap in full rather than cut off.
  ["manager-narrow", "state=manager&width=480"],
  // A dropped item on a big pool that was collapsed and filtered to Rare:
  // opened, the chip cleared, the row pinned first and focused, and said.
  ["manager-dropped", "state=manager&dropped=1"],
  // The Boxes tab the moment "New box" was saved as the Royal Vault
  // (boxestable.js, manager.js #saveEditor): every kind's row in one table,
  // the status line saying it is on the shelf, the new row's edge and its
  // Edit focused and in view; the toolbar's five New buttons and the line
  // wrap in a 480 px window instead of overflowing.
  ["manager-boxes", "state=manager&tab=boxes&added=1"],
  ["manager-boxes-narrow", "state=manager&tab=boxes&added=1&width=480"],
  // On the shelf (shelf.js): the GM took the Royal Vault off it. Its row is
  // tagged "Off the shelf" and dimmed, its toggle (focused, as the click
  // leaves it) is unpressed, every other row's is pressed, the
  // wheel keeps its live round's button, the toolbar counts 7 of 8.
  ["manager-boxes-shelf", "state=manager&tab=boxes&shelf=off"],
  // The Pull log (logtable.js) with one of everything: a refunded pull
  // struck through and muted, a pity pull tracing its rarity, a sale called
  // off too late, a dice win with its faces and payout, a deck draw that
  // took coins, five throws at the well folded into one line with "Refund
  // one", and the wheel's settled round with its stakes under it. In a 480
  // px window (and at 390) the rows stack as cards with every Refund in view.
  ["manager-log", "state=manager&tab=log"],
  ["manager-log-narrow", "state=manager&tab=log&width=480"],
  // A crate made from a roll table (B1): Goblin's Pockets leads the shelf,
  // drawing at the table's own odds, so its card names its items with
  // their real chances (the 1-in-100 Flame Tongue first, "<1%"), "and 3
  // more" and "Nothing 25%", in place of the rarity pills.
  ["shop-table", "state=shop&table=1"],
  // Its editor, as "Make a crate" opens it: the copy note, the odds as
  // one choice with a sentence each (the table's odds picked, the rarity
  // weights gone), "Count text results as nothing" ticked, the named
  // chances; switched to By rarity, the weights and pills come back.
  ["box-odds", "state=editor&odds=weight"],
  // The table dropped on a pool: its weights, the nested table it
  // flattened and what it left out, two text results among them.
  ["drop-preview", "state=preview"],
  // A pull that found nothing: the strip on a blank, "Nothing this time."
  // and the gold left for the buyer, no Open item.
  ["landed-nothing", "state=landed&nothing=1&buyer=1"],
  // The Midnight Lot's card leads the shelf: the lot, the top bid and who
  // holds it, the reserve met, the gavel's countdown, "Join the bidding".
  ["shop-auction", "state=shop&auction=1"],
  // A new world (starter.js): the empty Pools tab and the empty Boxes tab,
  // each saying what the tab holds and offering "Add starter crates" as
  // the window's one gold button; then the Boxes tab as that button leaves
  // it: ten games, every kind (three crates, two scratch tickets), every one off the shelf (dimmed,
  // "On the shelf" unpressed, "0 of 10 on the shelf"), the first game's Edit focused,
  // the status line naming what came in, the button kept on the toolbar.
  // Scratch tickets (scratch.js): the Fortune Ticket leads the shelf, 43
  // of its 100 tickets sold: "57 of 100 tickets left", a row per prize with
  // what is left of it (both 100 gp struck through), the odds of what is
  // left and the guarantee, "Buy a ticket for 5 gp" on. Then the Market
  // Scratchie's roll 2 sold out: "Roll 2 is sold out", Sold out under an
  // off Buy, no odds. Its editor: the layout and grid, the bonus spot, the
  // roll with its note (43 sold), the prize rows and the live readout.
  // The Boxes tab with its row: the prizes left as pills, the roll in the
  // rules, Print a new roll on a line of its own over the icons.
  ["shop-scratch", "state=shop&scratch=1"],
  // The same ticket with "Players see what is left in the roll" off, as a
  // player's shop shows it: the price, the top prize and the guarantee, as
  // a printed ticket says them, and no tickets left, prizes left or odds.
  ["shop-scratch-hidden", "state=shop&scratch=hidden"],
  ["shop-scratch-soldout", "state=shop&scratch=soldout"],
  ["editor-scratch", "state=editor&scratch=1"],
  ["manager-boxes-scratch", "state=manager&tab=boxes&scratch=1"],
  // The scratch itself (scratch.js mountScratch, the foil in foil.js), as
  // the approved mockup has it, played with motion on: the buyer's card
  // untouched (foil on every panel and the bonus spot, no win showing
  // through, each panel "covered" to a screen reader, the coin over the
  // second panel with the pointer hidden, Reveal all and the help under
  // it); scratched with real pointer strokes (five panels open, the sixth
  // part-scraped under 60% and still shut); the card open as a coin win,
  // a dud, the item and a match 3 win (winners lit, the result, Close
  // focused, no foil, coin or tools left); and the table's view mid
  // auto-scratch (the coin scraping by itself, some panels open, no
  // Reveal all, the pointer its own). Every state reads the print the
  // approved mockup settled (scratchPrintProblems): the band, the ribbon,
  // the coins, the EXTRA box, the corners, the foot and near-square
  // panels; scratch-theme-fey is the coin win printed in Fey market
  // green, the same ticket in another colour.
  ["scratch-unscratched", "state=scratch&buyer=1&phase=covered"],
  ["scratch-half", "state=scratch&buyer=1&phase=half"],
  ["scratch-won", "state=scratch&outcome=coins&buyer=1&duration=0"],
  ["scratch-dud", "state=scratch&outcome=nothing&buyer=1&duration=0"],
  ["scratch-item", "state=scratch&outcome=item&buyer=1&duration=0"],
  ["scratch-match3-won", "state=scratch&layout=match3&outcome=coins&buyer=1&duration=0"],
  ["scratch-spectator", "state=scratch&phase=sweep&duration=8000"],
  ["scratch-theme-fey", "state=scratch&outcome=coins&buyer=1&duration=0&ticket=fey"],
  // A prize line that pays three ways at once (the Rare item, 25 gp and
  // the gem): the item and the coins each lit on a panel of their own, the
  // gem in the bonus spot, the ribbon naming the line in full, and the
  // result naming the item with the coins going into the purse.
  ["scratch-combo", "state=scratch&outcome=combo&buyer=1&duration=0"],
  ["manager-empty", "state=manager&empty=1"],
  ["manager-boxes-empty", "state=manager&tab=boxes&empty=1"],
  ["manager-boxes-starter", "state=manager&tab=boxes&starter=1"],
  // The GM's welcome (welcome.js): in a world with games, Open the manager
  // is the primary and has focus; in a new world, Add starter crates is;
  // after an update, "What's new in 0.14.0" with Close. Each has one
  // labelled heading, the guide or changelog link, Don't show again beside
  // the line saying how it comes back, nothing under 11px, no caps.
  ["welcome", "state=welcome"],
  ["welcome-empty", "state=welcome&empty=1"],
  ["welcome-news", "state=welcome&view=news"],
  // A finished window closes by itself (linger.js, VIB-206): once the
  // result shows, "Closes in 30 s" and Keep open at the start of the
  // actions row, 12px mute ink, no live region, the vault not moved by an
  // inch; a second later it reads 29. Over the window it reads "Paused,
  // N s left", and Keep open takes the line away for good. A crate as the
  // buyer sees it, the same held (as the pointer over it would), the
  // dice, the wheel's settled round, and the setting at Off: no line.
  ["linger-crate", "state=landed&seed=7&buyer=1&linger=30"],
  ["linger-paused", "state=landed&seed=7&buyer=1&linger=30&paused=1"],
  ["linger-dice", "state=dice&outcome=win&buyer=1&duration=0&linger=30"],
  ["linger-table", "state=table&phase=landed&outcome=win&duration=0&linger=30"],
  ["linger-off", "state=landed&seed=7&buyer=1&linger=0"],
];

// The manager's tables at any width, read from the DOM: the pane never
// scrolls sideways, the toolbar fits it, every button (Edit, Copy, Delete,
// Reshuffle, Open a round, Refund) sits inside the pane and the window, and
// the rows stack as cards exactly when the pane is narrow, with the header
// row out of sight but kept, the table's roles and every cell's caption in
// place, and nothing under the 11px floor. The next column added to the
// Boxes table fails here before anyone reads a screenshot.
function panelProblems() {
  const out = [];
  const panel = document.querySelector(".lc-tab");
  if (!panel) return ["no tab panel"];
  const pr = panel.getBoundingClientRect();
  if (panel.scrollWidth > panel.clientWidth + 1) out.push(`the pane scrolls sideways by ${panel.scrollWidth - panel.clientWidth} px`);
  for (const bar of panel.querySelectorAll(".lc-toolbar")) if (bar.scrollWidth > bar.clientWidth + 1 || bar.getBoundingClientRect().right > pr.right + 1) out.push("a toolbar overflows the pane");
  const label = b => b.getAttribute("aria-label") ?? b.textContent.trim();
  const off = [...panel.querySelectorAll("button")].filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && (r.right > pr.right + 1 || r.left < pr.left - 1); });
  if (off.length) out.push(`${off.length} buttons past the pane's edge, e.g. "${label(off[0])}"`);
  const win = document.getElementById("app").getBoundingClientRect();
  const outside = [...panel.querySelectorAll('[data-action="editBox"], [data-action="refund"]')].filter(b => { const r = b.getBoundingClientRect(); return r.left < win.left - 1 || r.right > win.right + 1; });
  if (outside.length) out.push(`${outside.length} Edit or Refund buttons outside the window, e.g. "${label(outside[0])}"`);
  const table = panel.querySelector(".lc-table--stack");
  if (!table) return [...out, "no stacking table"];
  const style = getComputedStyle(panel);
  const inner = panel.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const stacked = getComputedStyle(table.querySelector("tbody tr")).display === "grid";
  if (stacked !== inner <= 560) out.push(stacked ? `rows stacked in a ${Math.round(inner)} px pane` : `rows not stacked in a ${Math.round(inner)} px pane`);
  // In a wide pane, the table's narrowest layout must fit the pane where the
  // rows begin to stack, or a pane between the two shows a table wider than
  // itself with its buttons past the edge (the buttons' cell is the one that
  // never wraps, so it must stay as narrow as its icons).
  if (!stacked) {
    const was = table.style.width;
    table.style.width = "min-content";
    const narrowest = table.getBoundingClientRect().width;
    table.style.width = was;
    if (narrowest > 560) out.push(`the table's narrowest layout is ${Math.round(narrowest)} px, wider than the 560 px pane where its rows begin to stack`);
  }
  const thead = table.querySelector("thead");
  if (!thead?.querySelectorAll("th").length) out.push("no header row");
  else if (stacked && thead.getBoundingClientRect().width > 2) out.push("the header row shows over stacked rows");
  else if (!stacked && thead.getBoundingClientRect().height < 10) out.push("the header row is hidden in a wide pane");
  if (table.getAttribute("role") !== "table" || [...table.querySelectorAll("tr")].some(tr => tr.getAttribute("role") !== "row") || [...table.querySelectorAll("td")].some(td => td.getAttribute("role") !== "cell")) out.push("the table lost its roles");
  // The buttons' column is named for a screen reader only (boxestable.js
  // tableHTML) and its cells carry no caption, so it compares as "".
  const heads = [...thead.querySelectorAll("th")].map(th => (th.querySelector(".lc-sr-only") ? "" : th.textContent));
  const unnamed = [...thead.querySelectorAll("th")].filter(th => !th.textContent.trim());
  if (unnamed.length) out.push(`${unnamed.length} column headers have no name`);
  for (const tr of table.querySelectorAll("tbody tr")) {
    const labels = [...tr.children].map(td => td.dataset.label);
    if (labels.join("|") !== heads.join("|")) { out.push(`a row's captions read ${labels.join(", ")}, not the header's ${heads.join(", ")}`); break; }
  }
  if (stacked) {
    // Each caption is drawn (the name's and the buttons' are not), and the
    // buttons sit on a line of their own after everything else.
    const captioned = [...table.querySelectorAll("tbody td[data-label]")].filter(td => td.dataset.label && getComputedStyle(td, "::before").content !== "none" && getComputedStyle(td, "::before").content !== "normal");
    if (!captioned.length) out.push("no cell shows its caption");
    for (const tr of table.querySelectorAll("tbody tr")) {
      const last = tr.lastElementChild;
      if (!last.querySelector("button")) continue;
      const above = [...tr.children].slice(0, -1).filter(td => getComputedStyle(td).display !== "none").map(td => td.getBoundingClientRect().bottom);
      if (above.length && last.getBoundingClientRect().top < Math.max(...above) - 1) { out.push("a row's buttons overlap its text"); break; }
    }
  }
  const small = [...table.querySelectorAll("td, td *")].filter(el => el.childNodes.length && [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && parseFloat(getComputedStyle(el).fontSize) < 11);
  if (small.length) out.push(`${small.length} texts under 11px, e.g. "${small[0].textContent.trim().slice(0, 30)}"`);
  return out;
}

// The Pull log sample (harness sample.js sampleLog), read from the DOM.
function logProblems(narrow) {
  const out = [];
  const app = document.getElementById("app").getBoundingClientRect();
  if (narrow && app.width > 484) out.push(`narrow manager is ${Math.round(app.width)} px wide`);
  const tabs = [...document.querySelectorAll('.lc-tabs [role="tablist"] > [role="tab"]')];
  if (tabs.find(t => t.getAttribute("aria-selected") === "true")?.textContent !== "Pull log") out.push("the Pull log tab is not the selected one");
  const toggle = document.querySelector('[data-action="toggleMisses"]');
  if (toggle?.textContent !== "Hide misses" || toggle.getAttribute("aria-pressed") !== "false") out.push("no Hide misses button");
  if (!/^5 throws that gave nothing, folded by day$/.test(document.querySelector(".lc-toolbar .lc-pool__hint")?.textContent ?? "")) out.push(`the misses line reads "${document.querySelector(".lc-toolbar .lc-pool__hint")?.textContent}"`);
  const rows = [...document.querySelectorAll(".lc-table tbody tr")];
  if (rows.length !== 13) out.push(`expected 13 rows, got ${rows.length}`);
  const plain = rows.find(r => !r.className);
  const refunded = document.querySelector(".lc-row--refunded");
  if (!refunded || !refunded.querySelector("s") || !/^refunded \S/.test(refunded.querySelector(".lc-log__status")?.textContent ?? "")) out.push("no refunded row reading as withdrawn");
  else if (refunded.querySelector('[data-action="refund"]')) out.push("the refunded row still offers Refund");
  else if (plain && getComputedStyle(refunded.querySelector("td")).color === getComputedStyle(plain.querySelector("td")).color) out.push("the refunded row isn't muted");
  const groups = [...document.querySelectorAll(".lc-row--group")];
  const misses = groups.find(tr => /5 throws, nothing/.test(tr.textContent));
  if (!misses) out.push("no folded misses row");
  else if (misses.querySelector('[data-action="refund"]')?.textContent !== "Refund one") out.push("the folded row has no Refund one");
  const round = groups.find(tr => /^Round$/.test(tr.children[1].textContent.trim()));
  if (!round || !/5 stakes, settled/.test(round.textContent) || !/45 gp staked/.test(round.textContent)) out.push(`no settled round line: "${round?.textContent.replace(/\s+/g, " ").trim()}"`);
  else if (round.querySelector("button")) out.push("the round's line has a button");
  const late = document.querySelector(".lc-row--late");
  if (!late || !/Called off by the buyer after the charge/.test(late.textContent)) out.push("the late sale isn't explained");
  else if (getComputedStyle(late.querySelector("td")).boxShadow === "none" && getComputedStyle(late).boxShadow === "none") out.push("the late sale has no edge");
  const text = document.querySelector(".lc-table").textContent;
  if (!/Rolled 4, 6, 5 · won 30 gp/.test(text)) out.push("the dice row has no faces and payout");
  if (!/Loss card · took 20 gp/.test(text)) out.push("the deck's bane row doesn't say what it took");
  if (!/Rare, set by GM \(source Uncommon\)/.test(text)) out.push("the pity row doesn't trace its rarity");
  if (!/· pity/.test(text)) out.push("the pity row isn't marked");
  if (!/Lost at the spin\./.test(text)) out.push("a losing stake doesn't say so");
  const refunds = [...document.querySelectorAll('[data-action="refund"]')];
  if (refunds.length !== 11) out.push(`expected 11 Refund buttons (one per live row, one per folded group), got ${refunds.length}`);
  for (const b of refunds) { const r = b.getBoundingClientRect(); if (r.width < 20 || r.height < 20) { out.push(`"${b.textContent}" is not visible`); break; } }
  return out;
}

// The Boxes tab after a New, read from the DOM (manager-boxes states).
// The player's shop with the Royal Vault off the shelf leaves its card out
// and keeps every other; the plain shop shows all eight.
function shelfShopProblems(off) {
  const ids = [...document.querySelectorAll(".lc-box")].map(c => c.dataset.box);
  if (off) return [ids.includes("royal") ? "the Royal Vault is off the shelf but on a player's shop" : "", ids.length !== 7 ? `expected 7 cards with one off the shelf, got ${ids.length}` : ""].filter(Boolean);
  return ids.includes("royal") ? [] : ["the Royal Vault is missing from the shop"];
}

// The editor's "On the shelf" box (shelf.js): one checkbox, ticked, its
// words beside it and at the 11px floor or over.
function shelfEditorProblems() {
  const out = [];
  const label = document.querySelector(".lc-form__shelf");
  const box = label?.querySelector('input[type="checkbox"][name="onShelf"]');
  if (!box) return ["the editor has no On the shelf box"];
  if (!box.checked) out.push("the On the shelf box isn't ticked");
  if (!/^On the shelf/.test(label.textContent.trim())) out.push(`the On the shelf box reads "${label.textContent.trim()}"`);
  if (parseFloat(getComputedStyle(label).fontSize) < 11) out.push("the On the shelf words are under 11px");
  const r = box.getBoundingClientRect();
  if (r.width < 10 || r.height < 10) out.push("the On the shelf box is not visible");
  return out;
}

// The Boxes tab with the Royal Vault off the shelf (shelf.js).
function shelfBoxesProblems() {
  const out = [];
  const app = document.getElementById("app").getBoundingClientRect();
  const count = document.querySelector(".lc-toolbar--boxes .lc-shelf-count");
  if (count?.textContent !== "7 of 8 on the shelf") out.push(`the toolbar count reads "${count?.textContent}"`);
  const rows = [...document.querySelectorAll(".lc-table tbody tr")];
  if (rows.length !== 8) out.push(`expected 8 sample games, got ${rows.length}`);
  const off = rows.filter(r => r.classList.contains("lc-row--off"));
  if (off.length !== 1 || !/Royal Vault/.test(off[0]?.textContent ?? "")) out.push("the Royal Vault's row isn't the one marked off the shelf");
  const tag = off[0]?.querySelector(".lc-kind--off");
  if (tag?.textContent !== "Off the shelf") out.push("the off-the-shelf row has no tag");
  else {
    // In sentence case, on one line, inside its cell.
    const cs = getComputedStyle(tag);
    if (cs.textTransform !== "none") out.push(`the Off the shelf tag is ${cs.textTransform}`);
    const lines = tag.getClientRects().length;
    if (lines !== 1 || tag.getBoundingClientRect().height > parseFloat(cs.lineHeight) + 4) out.push("the Off the shelf tag wraps");
    const cell = tag.closest("td").getBoundingClientRect(), r = tag.getBoundingClientRect();
    if (r.right > cell.right + 1 || r.left < cell.left - 1) out.push("the Off the shelf tag spills out of its cell");
    if (parseFloat(cs.fontSize) < 11) out.push("the Off the shelf tag is under 11px");
  }
  for (const r of rows) {
    const name = r.querySelector(".lc-table__name")?.firstChild?.textContent.trim();
    const t = r.querySelector('[data-action="toggleShelf"]');
    if (!t) { out.push(`${name} has no shelf toggle`); continue; }
    const isOff = r.classList.contains("lc-row--off");
    const want = isOff ? ["false", "On the shelf"] : ["true", "On the shelf"];
    if (t.getAttribute("aria-pressed") !== want[0] || t.textContent.trim() !== want[1]) out.push(`${name}'s toggle is ${t.getAttribute("aria-pressed")} "${t.textContent.trim()}"`);
    if (t.getAttribute("aria-label") !== `${want[1]}: ${name}`) out.push(`${name}'s toggle is labelled "${t.getAttribute("aria-label")}"`);
    const tr = t.getBoundingClientRect();
    if (tr.width < 20 || tr.height < 20 || tr.right > app.right + 1) out.push(`${name}'s toggle is not fully visible`);
    if (parseFloat(getComputedStyle(t).fontSize) < 11) out.push(`${name}'s toggle is under 11px`);
    // Its switch shows the state the label no longer says.
    const sw = getComputedStyle(t, "::before");
    if (parseFloat(sw.width) < 20) out.push(`${name}'s toggle has no switch`);
    else if ((sw.backgroundImage.match(/calc|100%/) != null) !== !isOff) out.push(`${name}'s switch doesn't show ${isOff ? "off" : "on"}`);
  }
  const royal = document.querySelector('[data-action="toggleShelf"][data-box="royal"]');
  if (document.activeElement !== royal) out.push("focus is not on the Royal Vault's toggle");
  const status = document.querySelector(".lc-manager__status");
  if (status?.textContent !== "Royal Vault is off the shelf; players can't see it.") out.push(`status line says "${status?.textContent}"`);
  if (!document.querySelector('[data-action="openTable"]')) out.push("the wheel's table button is missing");
  return out;
}

/*
  The manager's nav, every tab (route.js managerNavHTML): the three tabs on
  the rule they underline, then "View shop" beside the shop's open or
  closed toggle, both whole, inside the window, at the 11px floor or over,
  and clear of the tabs and of each other; in a narrow window the two go
  to a line above the tabs rather than off the edge.
*/
function navProblems() {
  const out = [];
  const nav = document.querySelector(".lc-manager__body > nav.lc-tabs");
  if (!nav) return ["no manager nav"];
  const win = document.getElementById("app").getBoundingClientRect();
  const view = nav.querySelector('[data-action="openShop"]');
  const toggle = nav.querySelector('[data-action="toggleShop"]');
  if (!view || view.textContent.trim() !== "View shop") return [...out, `no View shop in the nav (got "${view?.textContent.trim()}")`];
  if (!toggle) return [...out, "no shop toggle in the nav"];
  if (toggle.textContent.trim() !== "Shop open" || !["true", "false"].includes(toggle.getAttribute("aria-pressed"))) out.push(`the shop toggle reads "${toggle.textContent.trim()}", pressed ${toggle.getAttribute("aria-pressed")}`);
  if (parseFloat(getComputedStyle(toggle, "::before").width) < 20) out.push("the shop toggle has no switch");
  if (view.hasAttribute("aria-pressed")) out.push("View shop reads as a toggle");
  const rects = [view, toggle].map(b => b.getBoundingClientRect());
  for (const [b, r] of [[view, rects[0]], [toggle, rects[1]]]) {
    if (r.width < 20 || r.height < 20) out.push(`"${b.textContent.trim()}" is not visible`);
    if (r.left < win.left - 1 || r.right > win.right + 1) out.push(`"${b.textContent.trim()}" is outside the window`);
    if (parseFloat(getComputedStyle(b).fontSize) < 11) out.push(`"${b.textContent.trim()}" is under 11px`);
    if (b.scrollWidth > b.clientWidth + 1) out.push(`"${b.textContent.trim()}" is cut off`);
  }
  const overlap = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
  if (overlap(rects[0], rects[1])) out.push("View shop overlaps the shop toggle");
  const tabs = [...nav.querySelectorAll('[role="tab"]')];
  for (const t of tabs) { const r = t.getBoundingClientRect(); if (rects.some(b => overlap(b, r))) { out.push(`the ${t.textContent} tab is under a shop button`); break; } }
  const rule = nav.getBoundingClientRect().bottom;
  if (tabs.some(t => Math.abs(t.getBoundingClientRect().bottom - rule) > 2)) out.push("a tab is not on the nav's rule");
  if (nav.scrollWidth > nav.clientWidth + 1) out.push("the nav scrolls sideways");
  return out;
}

/*
  Each Boxes row's price as a field (boxestable.js priceInputHTML): the
  price as the shop says it, named for what it prices, at the 11px floor or
  over, whole inside its cell and the pane at every width.
*/
function priceProblems() {
  const out = [];
  const pane = document.querySelector(".lc-tab")?.getBoundingClientRect();
  const NAME = { Crate: "Price of", Deck: "First draw at", Wheel: "Lowest bet at", Well: "Stake at", Dice: "Stake at", Auction: "Opening bid at", Scratch: "Ticket price at" };
  const rows = [...document.querySelectorAll(".lc-table--boxes tbody tr")];
  if (!rows.length) return ["no Boxes rows"];
  for (const r of rows) {
    const name = r.querySelector(".lc-table__name")?.firstChild?.textContent.trim();
    const kind = r.querySelector(".lc-kind")?.textContent.trim();
    const input = r.querySelector("input[data-box-price]");
    if (!input) { out.push(`${name} has no price field`); continue; }
    if (input.type !== "text") out.push(`${name}'s price field is ${input.type}, not text`);
    if (!/^\d[\d,]* (gp|sp|cp)( \d+ (sp|cp))*$/.test(input.value)) out.push(`${name}'s price reads "${input.value}"`);
    if (input.getAttribute("aria-label") !== `${NAME[kind]} ${name}`) out.push(`${name}'s price is labelled "${input.getAttribute("aria-label")}"`);
    if (input.closest("td")?.dataset.label !== "Price") out.push(`${name}'s price field is not in the Price cell`);
    if (parseFloat(getComputedStyle(input).fontSize) < 11) out.push(`${name}'s price is under 11px`);
    const ir = input.getBoundingClientRect(), cr = input.closest("td").getBoundingClientRect();
    if (ir.width < 40 || ir.height < 20) out.push(`${name}'s price field is not visible`);
    if (ir.right > cr.right + 1 || ir.left < cr.left - 1) out.push(`${name}'s price field overflows its cell`);
    if (pane && (ir.right > pane.right + 1 || ir.left < pane.left - 1)) out.push(`${name}'s price field is past the pane's edge`);
    if (input.scrollWidth > input.clientWidth + 1) out.push(`${name}'s price "${input.value}" is cut off in its field`);
  }
  return out;
}

// A GM's shop (route.js shopControls): "Manage crates" in the header
// controls, their toggle beside the title and clear of it, the title whole;
// a player's shop has no header controls at all.
function shopControlProblems(gm) {
  const out = [];
  const header = document.querySelector("#app .window-header");
  const toggle = header.querySelector(".lc-harness-toggle");
  const items = [...header.querySelectorAll('.lc-harness-controls [data-action]')];
  if (!gm) return toggle || items.length ? ["a player's shop has header controls"] : [];
  if (!toggle) return ["the GM's shop has no header controls"];
  if (items.map(i => `${i.dataset.action}:${i.textContent.trim()}`).join("|") !== "openManager:Manage crates") out.push(`header controls read ${items.map(i => i.textContent.trim()).join(", ")}`);
  const title = header.querySelector(".window-title");
  const tr = title.getBoundingClientRect(), br = toggle.getBoundingClientRect(), hr = header.getBoundingClientRect();
  if (title.scrollWidth > title.clientWidth + 1) out.push("the shop's title is cut off beside its header controls");
  if (br.left < tr.right - 1) out.push("the header controls crowd the title");
  if (br.right > hr.right + 1) out.push("the header controls are past the window's edge");
  const menu = header.querySelector(".lc-harness-controls")?.getBoundingClientRect();
  const app = document.getElementById("app").getBoundingClientRect();
  if (menu && (menu.right > app.right + 1 || menu.left < app.left - 1)) out.push("the header controls' menu is past the window's edge");
  for (const i of items) if (parseFloat(getComputedStyle(i.querySelector("button")).fontSize) < 11) out.push("a header control is under 11px");
  return out;
}

// An empty shelf (route.js shopEmptyHTML): one line for a player, naming no
// settings; a GM's points at Manage crates with a button in the sentence.
function emptyShopProblems(gm) {
  const out = [];
  const empty = document.querySelector(".lc-shop__grid > .lc-shop__empty");
  if (!empty) return ["no empty-shelf line"];
  if (document.querySelector(".lc-box")) out.push("an empty shelf shows a crate");
  const text = empty.textContent.replace(/\s+/g, " ").trim();
  if (/Game Settings/.test(text)) out.push("the empty shelf talks of Game Settings");
  if (parseFloat(getComputedStyle(empty).fontSize) < 11) out.push("the empty-shelf line is under 11px");
  const button = empty.querySelector("button");
  if (!gm) {
    if (text !== "No crates on the shelf yet. The GM hasn't put any out.") out.push(`a player's empty shelf reads "${text}"`);
    if (button) out.push("a player's empty shelf has a button");
    return out;
  }
  if (text !== "No crates on the shelf yet. Make one in Manage crates.") out.push(`a GM's empty shelf reads "${text}"`);
  if (button?.dataset.action !== "openManager") return [...out, "a GM's empty shelf has no Manage crates button"];
  const r = button.getBoundingClientRect(), app = document.getElementById("app").getBoundingClientRect();
  if (r.width < 40 || r.height < 20 || r.right > app.right + 1) out.push("the Manage crates button is not whole in the window");
  if (parseFloat(getComputedStyle(button).fontSize) < 11) out.push("the Manage crates button is under 11px");
  return out;
}

function boxesProblems(narrow) {
  const out = [];
  const app = document.getElementById("app").getBoundingClientRect();
  if (narrow && app.width > 484) out.push(`narrow manager is ${Math.round(app.width)} px wide`);
  const tabs = [...document.querySelectorAll('.lc-tabs [role="tablist"] > [role="tab"]')];
  if (tabs.find(t => t.getAttribute("aria-selected") === "true")?.textContent !== "Boxes") out.push("the Boxes tab is not the selected one");
  const toolbar = document.querySelector(".lc-toolbar--boxes");
  if (!toolbar) return [...out, "no Boxes toolbar"];
  const news = [...toolbar.querySelectorAll('[data-action^="add"]')].map(b => b.textContent.trim());
  if (news.join("|") !== "New box|New well|New dice game|New deck|New wheel|New auction|New scratch ticket") out.push(`the New buttons read ${news.join(", ")}`);
  if (toolbar.scrollWidth > toolbar.clientWidth + 1 || toolbar.getBoundingClientRect().right > app.right + 1) out.push("the Boxes toolbar overflows the window");
  if (document.querySelectorAll('[role="status"]').length !== 1) out.push("expected one role=status");
  const status = document.querySelector(".lc-manager__status");
  if (!/^Royal Vault is on the shelf at 1,?200 gp\.$/.test(status?.textContent ?? "")) out.push(`status line says "${status?.textContent}"`);
  if (status && (status.scrollWidth > status.clientWidth + 1 || status.getBoundingClientRect().right > app.right + 1)) out.push("the status line is cut off");
  const rows = [...document.querySelectorAll(".lc-table tbody tr")];
  if (rows.length !== 8) out.push(`expected 8 sample games, got ${rows.length}`);
  const tags = [...document.querySelectorAll(".lc-table .lc-kind")].map(t => t.textContent);
  if (tags.join("|") !== "Crate|Crate|Crate|Crate|Well|Dice|Deck|Wheel") out.push(`kind tags read ${tags.join(", ")}`);
  const row = document.querySelector(".lc-table tr.lc-row--new");
  if (!row || !/Royal Vault/.test(row.textContent)) out.push("the new row isn't marked");
  // The gold edge sits on the first cell, or on the row once it stacks as a card.
  if (row && getComputedStyle(row.children[0]).boxShadow === "none" && getComputedStyle(row).boxShadow === "none") out.push("the new row has no edge");
  if (document.querySelectorAll(".lc-table tr.lc-row--new").length > 1) out.push("more than one row marked new");
  const edit = row?.querySelector('[data-action="editBox"]');
  if (!edit || edit.getAttribute("aria-label") !== "Edit Royal Vault") out.push("the new row has no Edit Royal Vault");
  if (document.activeElement !== edit) out.push("focus is not on the new row's Edit");
  const tab = document.querySelector(".lc-tab")?.getBoundingClientRect();
  const er = edit?.getBoundingClientRect();
  if (tab && er && (er.top < tab.top - 1 || er.bottom > tab.bottom + 1)) out.push("the new row is out of view");
  if (!document.querySelector('[data-action="openTable"]') || !document.querySelector('[data-action="reshuffle"]')) out.push("the wheel's Open a round or the deck's Reshuffle is missing");
  // Every row has a visible Copy naming its game, between Edit and Delete.
  for (const r of rows) {
    const name = r.querySelector(".lc-table__name")?.firstChild?.textContent.trim();
    const copy = r.querySelector('[data-action="copyBox"]');
    if (!copy) { out.push(`${name} has no Copy`); continue; }
    if (copy.getAttribute("aria-label") !== `Copy ${name}`) out.push(`${name}'s Copy is labelled "${copy.getAttribute("aria-label")}"`);
    if (copy.getBoundingClientRect().width < 20 || copy.getBoundingClientRect().height < 20) out.push(`${name}'s Copy is not visible`);
    if ((copy.querySelector("i")?.getBoundingClientRect().width ?? 0) < 10) out.push(`${name}'s Copy has no icon`);
    const order = [...r.lastElementChild.querySelectorAll("[data-action]")].map(b => b.dataset.action).slice(-3).join("|");
    if (order !== "editBox|copyBox|deleteBox") out.push(`${name}'s row actions end ${order}`);
  }
  return out;
}

/*
  An empty tab in a new world (starter.js starterCallHTML): the selected
  tab, the line saying what it holds, the offer, and one "Add starter
  crates" as the gold button, whole in the window, in the tab order, at
  the 11px floor or over; the pane never scrolls sideways.
*/
function starterEmptyProblems(where) {
  const out = [];
  const app = document.getElementById("app").getBoundingClientRect();
  const tabs = [...document.querySelectorAll('.lc-tabs [role="tablist"] > [role="tab"]')];
  const want = where === "pools" ? "Pools" : "Boxes";
  if (tabs.find(t => t.getAttribute("aria-selected") === "true")?.textContent !== want) out.push(`the ${want} tab is not the selected one`);
  const block = document.querySelector(".lc-tab .lc-starter");
  if (!block) return [...out, "no starter offer on the empty tab"];
  const line = block.querySelector(".lc-empty")?.textContent ?? "";
  if (!(where === "pools" ? /^No pools yet\. A pool is the set of items a box can give out/ : /^No games yet\. A box prices a pull/).test(line)) out.push(`the empty line reads "${line}"`);
  const offer = block.querySelector(".lc-starter__offer");
  if (!/added off the shelf/.test(offer?.textContent ?? "")) out.push("the offer doesn't say the games come off the shelf");
  if (block.getAttribute("aria-labelledby") !== offer?.id) out.push("the offer doesn't name its group");
  const buttons = [...document.querySelectorAll('[data-action="starterCrates"]')];
  if (buttons.length !== 1) out.push(`expected one Add starter crates, got ${buttons.length}`);
  const b = buttons[0];
  if (b) {
    if (b.textContent.trim() !== "Add starter crates") out.push(`the button reads "${b.textContent.trim()}"`);
    const r = b.getBoundingClientRect();
    if (r.width < 120 || r.height < 30 || r.right > app.right + 1 || r.left < app.left - 1) out.push("Add starter crates is not whole in the window");
    if (b.tabIndex !== 0) out.push("Add starter crates is not in the tab order");
    if (getComputedStyle(b).backgroundColor === getComputedStyle(document.querySelector(".lc-toolbar button")).backgroundColor) out.push("Add starter crates looks like a quiet button");
  }
  for (const el of [block.querySelector(".lc-empty"), offer, b].filter(Boolean)) if (parseFloat(getComputedStyle(el).fontSize) < 11) out.push(`"${el.textContent.trim().slice(0, 30)}" is under 11px`);
  if (document.querySelectorAll('[role="status"]').length !== 1) out.push("expected one role=status");
  const pane = document.querySelector(".lc-tab");
  if (pane.scrollWidth > pane.clientWidth + 1) out.push("the pane scrolls sideways");
  return out;
}

/*
  The GM's welcome and the note after an update (welcome.js): one heading
  that names the section, one primary (dnd5e's black button) holding focus,
  the buttons and link whole in the window, Don't show again, nothing under
  the 11px floor, no upper-case text, no emoji, no sideways scroll.
*/
function welcomeProblems({ view, empty }) {
  const out = [];
  const app = document.getElementById("app").getBoundingClientRect();
  const section = document.querySelector(".lc-welcome");
  if (!section) return ["no welcome window"];
  const h = document.getElementById(section.getAttribute("aria-labelledby") ?? "");
  const wantHead = view === "news" ? /^What's new in \d+\.\d+\.\d+$/ : /^Welcome to Loot Crates$/;
  if (!h || h.tagName !== "H2" || !wantHead.test(h.textContent.trim())) out.push(`the heading reads "${h?.textContent}"`);
  const primary = [...document.querySelectorAll("[data-primary]")];
  const want = view === "news" ? "Close" : empty ? "Add starter crates" : "Open the manager";
  if (primary.length !== 1 || primary[0].textContent.trim() !== want) out.push(`the primary is ${primary.map(b => `"${b.textContent.trim()}"`).join(", ") || "missing"}, not "${want}"`);
  if (document.activeElement !== primary[0]) out.push(`focus is on ${document.activeElement?.tagName} "${document.activeElement?.textContent?.trim().slice(0, 30)}", not the primary`);
  const quiet = document.querySelector('[data-action="welcomeQuiet"]');
  if (quiet?.textContent.trim() !== "Don't show again") out.push("no Don't show again");
  if (primary[0] && quiet && getComputedStyle(primary[0]).backgroundColor === getComputedStyle(quiet).backgroundColor) out.push("the primary looks like a quiet button");
  const link = section.querySelector("a.lc-welcome__link");
  const linkWant = view === "news" ? "Read the full changelog" : "Read the guide";
  if (link?.textContent.trim() !== linkWant || link.target !== "_blank" || !/noopener/.test(link.rel) || !/^https:\/\//.test(link.href)) out.push(`the link is not "${linkWant}" opening safely in a new tab`);
  if (view === "news") {
    const n = section.querySelectorAll(".lc-welcome__news li").length;
    if (n < 3 || n > 5) out.push(`What's new has ${n} lines`);
  } else {
    if (section.querySelectorAll(".lc-welcome__steps li").length !== 3) out.push("not three first steps");
    if (!/Items sidebar/.test(section.textContent) || !/Manage crates/.test(section.textContent)) out.push("doesn't say where the shop and the manager are");
    for (const a of ["welcomeStarter", "welcomeManager"]) if (!section.querySelector(`[data-action="${a}"]`)) out.push(`no ${a} button`);
  }
  for (const b of section.querySelectorAll("button, a")) {
    const r = b.getBoundingClientRect();
    if (r.left < app.left - 1 || r.right > app.right + 1 || r.height < 28) out.push(`"${b.textContent.trim()}" is not whole in the window`);
    if (b.tabIndex !== 0) out.push(`"${b.textContent.trim()}" is not in the tab order`);
  }
  for (const el of section.querySelectorAll("*")) {
    if (!el.textContent.trim() || el.children.length && [...el.childNodes].every(n => n.nodeType !== 3 || !n.textContent.trim())) continue;
    const cs = getComputedStyle(el);
    if (parseFloat(cs.fontSize) < 11) out.push(`"${el.textContent.trim().slice(0, 30)}" is under 11px`);
    if (cs.textTransform === "uppercase") out.push(`"${el.textContent.trim().slice(0, 30)}" is set in capitals`);
  }
  if (/\p{Extended_Pictographic}/u.test(section.textContent)) out.push("emoji in the text");
  if (section.scrollWidth > section.clientWidth + 1) out.push("the welcome scrolls sideways");
  return out;
}

/*
  The Boxes tab as "Add starter crates" leaves it (manager.js
  addStarterCrates): one game of every kind, every one off the shelf, the
  first game's Edit focused, the status line saying what came in and how
  to put it out, the button kept on the toolbar.
*/
function starterBoxesProblems() {
  const out = [];
  const rows = [...document.querySelectorAll(".lc-table tbody tr")];
  if (rows.length !== 10) out.push(`expected 10 starter games, got ${rows.length}`);
  const tags = [...document.querySelectorAll(".lc-table .lc-kind:not(.lc-kind--off)")].map(t => t.textContent);
  if (tags.join("|") !== "Crate|Crate|Crate|Well|Dice|Deck|Wheel|Auction|Scratch|Scratch") out.push(`kind tags read ${tags.join(", ")}`);
  if (rows.some(r => !r.classList.contains("lc-row--off") || r.querySelector('[data-action="toggleShelf"]')?.getAttribute("aria-pressed") !== "false")) out.push("a starter game is on the shelf");
  const count = document.querySelector(".lc-toolbar--boxes .lc-shelf-count")?.textContent;
  if (count !== "0 of 10 on the shelf") out.push(`the toolbar count reads "${count}"`);
  const starter = document.querySelectorAll('.lc-toolbar--boxes [data-action="starterCrates"]');
  if (starter.length !== 1 || starter[0].textContent.trim() !== "Add starter crates") out.push("the toolbar has no Add starter crates");
  const news = [...document.querySelectorAll('.lc-toolbar--boxes [data-action^="add"]')].map(b => b.textContent.trim());
  if (news.join("|") !== "New box|New well|New dice game|New deck|New wheel|New auction|New scratch ticket") out.push(`the New buttons read ${news.join(", ")}`);
  const status = document.querySelector(".lc-manager__status")?.textContent ?? "";
  if (status !== "Added 4 starter pools and 10 starter games, all off the shelf. Players can't see them yet: look each one over, then press On the shelf on its row.") out.push(`status line says "${status}"`);
  const first = rows[0]?.querySelector('[data-action="editBox"]');
  if (document.activeElement !== first) out.push("focus is not on the first starter game's Edit");
  const pools = rows.map(r => r.querySelector('td[data-label="Pools"]')?.textContent.trim());
  if ([...pools.slice(0, 6), ...pools.slice(8)].some(p => !p || /none|missing/.test(p))) out.push(`a starter game draws from no pool: ${pools.join(" / ")}`);
  if (!/A sealed Dragon's hoard chest/.test(rows[7]?.textContent ?? "")) out.push("the auction's lot isn't the sealed hoard chest");
  if (document.querySelectorAll('[role="status"]').length !== 1) out.push("expected one role=status");
  return out;
}

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

// The finished window's countdown (linger.js), read from the DOM.
async function lingerProblems({ off, paused }) {
  const out = [];
  const lines = [...document.querySelectorAll(".lc-linger")];
  if (!window.__linger) return ["the harness started no countdown"];
  if (off) {
    if (lines.length) out.push("the setting is Off but a countdown line shows");
    if (window.__linger.linger.view.running) out.push("the setting is Off but the countdown runs");
    return out;
  }
  if (lines.length !== 1) return [`expected one countdown line, got ${lines.length}`];
  const [line] = lines;
  const row = document.querySelector(".lc-reveal__actions");
  if (line.parentNode !== row || row.firstElementChild !== line) out.push("the line isn't first in the actions row");
  const text = line.querySelector(".lc-linger__text")?.textContent ?? "";
  const want = paused ? /^Paused, 30 s left$/ : /^Closes in (30|29) s$/;
  if (!want.test(text)) out.push(`the line reads "${text}"`);
  const keep = line.querySelector("button.lc-linger__keep");
  if (keep?.textContent !== "Keep open" || keep.type !== "button") out.push("no Keep open button");
  const described = keep && document.getElementById(keep.getAttribute("aria-describedby") ?? "");
  if (!described || described !== line.querySelector(".lc-linger__text")) out.push("Keep open isn't described by the countdown");
  if (line.closest("[aria-live], [role=status], [role=timer], [role=alert]")) out.push("the ticking line is in a live region");
  for (const el of [line, line.querySelector(".lc-linger__text"), keep]) if (el && parseFloat(getComputedStyle(el).fontSize) < 11) out.push(`"${el.textContent}" is under 11px`);
  if (window.__linger.shift) out.push(`the vault moved ${window.__linger.shift}px when the line came in`);
  const lr = line.getBoundingClientRect();
  const win = document.getElementById("app").getBoundingClientRect();
  if (lr.left < win.left - 1 || lr.right > win.right + 1) out.push("the line runs outside the window");
  for (const b of row.querySelectorAll(":scope > button")) {
    const r = b.getBoundingClientRect();
    if (r.width && r.left < lr.right - 1 && r.right > lr.left + 1 && r.top < lr.bottom - 1 && r.bottom > lr.top + 1) { out.push(`the line overlaps "${b.textContent}"`); break; }
  }
  // A second on, it has counted down (or, held, it hasn't).
  await new Promise(r => setTimeout(r, 1100));
  const later = line.querySelector(".lc-linger__text")?.textContent ?? "";
  if (paused ? later !== text : !/^Closes in (29|28) s$/.test(later)) out.push(`a second later the line reads "${later}"`);
  return out;
}

// Over the window the countdown holds; off it, it runs on; Keep open
// takes the line away and stops it for good (after the screenshot).
async function lingerUseProblems(page) {
  const out = [];
  const read = () => page.evaluate(() => document.querySelector(".lc-linger__text")?.textContent ?? null);
  const app = await page.$("#app");
  const box = await app.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 20);
  await page.waitForTimeout(100);
  const over = await read();
  if (!/^Paused, \d+ s left$/.test(over ?? "")) out.push(`with the pointer over the window the line reads "${over}"`);
  await page.mouse.move(box.x + box.width / 2, Math.min(box.y + box.height + 40, (page.viewportSize()?.height ?? 900) - 2));
  await page.mouse.move(1, (page.viewportSize()?.height ?? 900) - 2);
  await page.waitForTimeout(100);
  const left = await read();
  if (!/^Closes in \d+ s$/.test(left ?? "")) out.push(`with the pointer gone the line reads "${left}"`);
  await page.click(".lc-linger__keep");
  await page.waitForTimeout(100);
  const after = await page.evaluate(() => ({ line: document.querySelectorAll(".lc-linger").length, view: window.__linger.linger.view, focus: document.activeElement?.className ?? "" }));
  if (after.line) out.push("Keep open left the line");
  if (!after.view.kept || after.view.running) out.push("Keep open didn't stop the countdown");
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
    if (rule !== "2nd draw in a row: 15 gp (back to 10 gp after 2 minutes)") out.push(`the streak line reads "${rule}"`);
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

// The wheel's card in the shop: the rarity bands as pills (no 0%) and a
// ribbon, the three plain bets in words with what they pay, the stake
// bounds, what the round is doing (a clock that ticks, or that no round is
// open with "Place a bet" off for that reason), and "Place a bet" on the Buy.
function rouletteCardProblems({ noRound, closed, busy, gm = false }) {
  const out = [];
  const card = document.querySelector('.lc-box[data-box="wheel"]');
  if (!card) return ["no wheel card in the shop"];
  const buy = card.querySelector(".lc-box__buy");
  const pills = [...card.querySelectorAll(".lc-odd")].map(p => p.textContent.trim()).join(", ");
  if (pills !== "Common 42%, Uncommon 33%, Rare 17%, Legendary 8%") out.push(`wheel pills: ${pills}`);
  if (card.querySelectorAll(".lc-ribbon__seg").length !== 4) out.push("the wheel's ribbon doesn't show its four bands");
  const rule = card.querySelector(".lc-box__rule")?.innerText.replace(/\s+/g, " ").trim() ?? "";
  if (!/Evocation red or Abjuration black 1 in 2, pays 2×/.test(rule) || !/One number 1 in 12, pays 12×/.test(rule) || !/A rarity pays 3×/.test(rule)) out.push(`the bet lines read "${rule}"`);
  if (card.querySelector(".lc-box__stock")?.textContent.trim() !== "Stake 5 gp to 50 gp, 3 bets a round") out.push(`the bounds read "${card.querySelector(".lc-box__stock")?.textContent}"`);
  const round = card.querySelector(".lc-box__round");
  // A GM's Buy takes them to the table they run (shop-gm).
  if (!buy.textContent.includes(gm ? "Go to the table" : "Place a bet")) out.push(`wheel Buy reads "${buy.textContent.trim()}"`);
  if (buy.dataset.price !== "5") out.push(`the wheel's data-price is ${buy.dataset.price}`);
  if (noRound) {
    if (round?.textContent.trim() !== "No round open yet") out.push(`with no round the card says "${round?.textContent}"`);
    if (buy.getAttribute("aria-disabled") !== "true") out.push("Place a bet is on with no round open");
    if (card.querySelector(".lc-box__why")?.textContent.trim() !== "No round open yet") out.push(`the no-round reason reads "${card.querySelector(".lc-box__why")?.textContent}"`);
  } else {
    if (!/^Bets close in \d:\d\d$/.test(round?.textContent.trim() ?? "")) out.push(`the round line reads "${round?.textContent}"`);
    if (!round?.dataset.lcCountdown) out.push("the clock line carries no data-lc-countdown");
    if (!closed && !busy && buy.getAttribute("aria-disabled") === "true") out.push(`Place a bet is off for "${card.querySelector(".lc-box__why")?.textContent}"`);
  }
  for (const el of [card.querySelector(".lc-box__rule"), round].filter(Boolean)) if (parseFloat(getComputedStyle(el).fontSize) < 11) out.push(`${el.className} is under 11px`);
  return out;
}

/*
  The shared table window, read from the DOM. Every phase: the head names
  the game and the bets, the state line is a live region reading the
  phase's words, five chips sit on the rail (Tam's two ringed as the
  viewer's), the stakes are listed for a screen reader, nothing leaves the
  window. Betting: the form offers the bet types and picks, the stake
  within 5 to 50, "Place a bet" on; changing the type repopulates the pick;
  a stake under the floor is refused on the line; a good bet drops a sixth
  chip. Waiting (the GM): no form, Spin. Closed (a player): no form, no
  Spin. Spinning: the stage is spinning, the ball shows, the disc has
  turned, no result, the button reads Skip. Landed: the stage names the
  pocket, the disc rests with that pocket under the pin, the verdict and
  each character's net sit in the live region, the winning spots are lit
  and the rest step back, the vault is in the pocket's rarity, Close is
  focused.
*/
async function tableProblems({ phase, outcome, gm }) {
  const out = [];
  const frames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const shown = el => !!el && !el.hidden && el.getBoundingClientRect().height > 0;
  const head = document.querySelector(".lc-table__head")?.innerText.replace(/\s+/g, " ") ?? "";
  if (!/Wheel of Fate/.test(head)) out.push(`head reads "${head}"`);
  // The clock (betting) is a timer, not a status region: it ticks once a
  // second and must not be read aloud each time.
  const stateEl = document.querySelector(".lc-table__state");
  if (stateEl?.getAttribute("role") !== (phase === "betting" ? "timer" : "status")) out.push(`the round's state has role "${stateEl?.getAttribute("role")}" while ${phase}`);
  const want = { betting: /^Bets close in \d:\d\d$/, waiting: /^Bets are closed: waiting for the GM to spin$/, closed: /^Bets are closed: waiting for the GM to spin$/, spinning: /^The wheel is turning$/, landed: /^Settled$/ }[phase];
  if (!want.test(stateEl?.textContent.trim() ?? "")) out.push(`the state reads "${stateEl?.textContent}"`);
  const count = document.querySelector(".lc-table__count")?.textContent.trim();
  if (count !== "5 bets from 3 characters") out.push(`the count reads "${count}"`);
  const chips = document.querySelectorAll(".lc-rail .lc-token");
  if (chips.length !== 5) out.push(`${chips.length} chips on the rail`);
  if (document.querySelectorAll(".lc-token--mine").length !== (gm ? 0 : 2)) out.push("the viewer's own chips aren't ringed (or the GM's are)");
  if (document.querySelectorAll(".lc-table__list li").length !== 5) out.push("the screen-reader list doesn't name every bet");
  if (document.querySelectorAll(".lc-wheel__rim").length !== 12 || document.querySelectorAll(".lc-wheel__n").length !== 12) out.push("the wheel doesn't show twelve pockets with their rims");
  for (const el of document.querySelectorAll(".lc-table__body *")) {
    const r = el.getBoundingClientRect();
    if (r.right > document.documentElement.clientWidth + 1) { out.push(`the table overflows: ${el.className}`); break; }
  }
  for (const el of document.querySelectorAll(".lc-spot__label, .lc-table__state, .lc-table__count")) if (parseFloat(getComputedStyle(el).fontSize) < 11) { out.push(`${el.className} is under 11px`); break; }
  const form = document.querySelector(".lc-table__form");
  const spin = document.querySelector(".lc-table__spin");
  const btn = document.querySelector(".lc-reveal__close");
  const stage = document.querySelector(".lc-table__stage");
  if (phase === "betting") {
    if (!form) return [...out, "no bet form while betting"];
    const type = form.querySelector(".lc-table__type"), pick = form.querySelector(".lc-table__pick"), stake = form.querySelector(".lc-table__stake"), bet = form.querySelector(".lc-table__bet");
    if ([...type.options].map(o => o.value).join() !== "colour,parity,number,rarity") out.push(`bet types: ${[...type.options].map(o => o.textContent).join("; ")}`);
    if (stake.min !== "5" || stake.max !== "50" || stake.value !== "5") out.push(`stake field ${stake.min}-${stake.max}, at ${stake.value}`);
    if (bet.textContent.trim() !== "Place a bet" || bet.getAttribute("aria-disabled") === "true") out.push(`the button reads "${bet.textContent.trim()}"`);
    if (btn?.textContent !== "Close") out.push(`the close button reads "${btn?.textContent}" while betting`);
    type.value = "number";
    type.dispatchEvent(new Event("change", { bubbles: true }));
    if (pick.options.length !== 12 || !/^1, 1 in 12$/.test(pick.options[0].textContent)) out.push(`a number bet offers ${pick.options.length} picks ("${pick.options[0]?.textContent}")`);
    type.value = "rarity";
    type.dispatchEvent(new Event("change", { bubbles: true }));
    if ([...pick.options].map(o => o.textContent).join("; ") !== "Common, 42%; Uncommon, 33%; Rare, 17%; Legendary, 8%") out.push(`a rarity bet offers "${[...pick.options].map(o => o.textContent).join("; ")}"`);
    stake.value = "1";
    bet.focus();
    bet.click();
    await frames();
    const why = form.querySelector(".lc-table__why");
    if (why?.textContent !== "Stake at least 5 gp." || !shown(why)) out.push(`a 1 gp stake is refused with "${why?.textContent}"`);
    if (document.activeElement !== bet) out.push("focus left Place a bet on a refusal");
    stake.value = "5";
    pick.value = "rare";
    bet.click();
    await frames();
    if (document.querySelectorAll(".lc-rail .lc-token").length !== 6) out.push("a good bet didn't drop a chip");
    if (document.querySelectorAll('.lc-spot[data-spot="rarity:rare"] .lc-token').length !== 2) out.push("the new chip isn't on the Rare spot");
    if (why?.textContent) out.push(`a good bet still says "${why.textContent}"`);
    if (!document.querySelector(".lc-token--new")) out.push("the new chip isn't marked as just landed");
    if (!/Tam Thornwick bets 5 gp on Rare/.test(document.querySelector(".lc-table__live")?.textContent ?? "")) out.push("the new bet isn't said in the status line");
    return out;
  }
  if (phase === "waiting") {
    if (form) out.push("a bet form while bets are closed");
    if (!shown(spin) || spin.textContent.trim() !== "Spin") out.push("the GM has no Spin");
    if (parseFloat(getComputedStyle(spin).fontSize) < 11) out.push("Spin is under 11px");
    return out;
  }
  if (phase === "closed") {
    if (form) out.push("a bet form while bets are closed");
    if (spin) out.push("a player sees Spin");
    return out;
  }
  if (phase === "spinning") {
    if (!stage?.classList.contains("lc-table__stage--spinning")) out.push("the stage isn't spinning");
    if (stage?.classList.contains("lc-table__stage--landed")) out.push("the stage landed before the screenshot");
    if (parseFloat(getComputedStyle(document.querySelector(".lc-wheel__ball")).opacity) < 0.9) out.push("the ball doesn't show mid-spin");
    if (getComputedStyle(document.querySelector(".lc-wheel__turn")).transform === "none") out.push("the disc hasn't turned");
    if (document.querySelector(".lc-table__result")?.innerHTML.trim()) out.push("the result shows mid-spin");
    if (btn?.textContent !== "Skip") out.push(`mid-spin button reads "${btn?.textContent}"`);
    if (form || spin) out.push("controls shown mid-spin");
    return out;
  }
  // Landed.
  const n = outcome === "win" ? 7 : 8;
  if (!stage?.classList.contains("lc-table__stage--landed")) out.push("the stage never landed");
  if (stage?.dataset.pocket !== String(n)) out.push(`the stage says pocket ${stage?.dataset.pocket}`);
  // The disc rests with the pocket's centre under the pin at the top.
  const m = new DOMMatrix(getComputedStyle(document.querySelector(".lc-wheel__turn")).transform);
  const turned = ((Math.atan2(m.b, m.a) * 180 / Math.PI) + 360) % 360;
  const rest = (((n - 0.5) * 30 + turned) % 360 + 360) % 360;
  if (Math.min(rest, 360 - rest) > 1) out.push(`pocket ${n} rests ${rest.toFixed(1)} degrees off the pin`);
  const result = document.querySelector(".lc-table__result");
  const text = result?.innerText.replace(/\s+/g, " ").trim() ?? "";
  const verdict = outcome === "win" ? "The ball lands on 7, evocation red, Uncommon." : "The ball lands on 8, abjuration black, Common.";
  if (!text.startsWith(verdict)) out.push(`the verdict reads "${text}"`);
  if (!result?.closest("[aria-live]")) out.push("the verdict is not in a live region");
  const nets = outcome === "win" ? ["Tam Thornwick wins 75 gp on 7, Evocation red", "Orla Vane loses 10 gp", "Bo Marrow loses 10 gp"] : ["Bo Marrow wins 10 gp on Abjuration black", "Orla Vane breaks even on Even", "Tam Thornwick loses 25 gp"];
  for (const line of nets) if (!text.includes(line)) out.push(`the nets don't say "${line}"`);
  const won = [...document.querySelectorAll(".lc-spot--won")].map(s => s.dataset.spot).sort().join();
  const wantWon = outcome === "win" ? "colour:0,number:7,parity:odd,rarity:uncommon" : "colour:1,number:8,parity:even,rarity:common";
  if (won !== wantWon) out.push(`the lit spots are ${won}`);
  if (![...document.querySelectorAll(".lc-spot:not(.lc-spot--won)")].every(s => s.classList.contains("lc-spot--out"))) out.push("a losing spot didn't step back");
  if (!document.querySelector(".lc-vault")?.classList.contains(outcome === "win" ? "lc-rarity-uncommon" : "lc-rarity-common")) out.push("the vault isn't in the pocket's rarity");
  if (btn?.textContent !== "Close" || document.activeElement !== btn) out.push("landed table has no focused Close");
  if (form || spin) out.push("controls shown after the landing");
  const quiet = document.querySelector(".lc-table__verdict");
  if (quiet && parseFloat(getComputedStyle(quiet).fontSize) < 11) out.push("the verdict is under 11px");
  return out;
}

/*
  The auction's table window (auction.js on tablewindow.js), read from the
  DOM: the head's gavel is a timer; the board shows the lot, the top bid
  and who holds it, whether the reserve is met (never its amount), the
  last bids with the beaten ones struck through; the gavel's bar is drawn
  with a transform; the player's one primary action names the next legal
  bid, refuses one under it on the line and places one that lands on top
  and fills the gavel again; the GM gets the gavel and Call it off; at the
  hammer the stamp, the verdict in the live region and a focused Close,
  and for a sealed crate its strip landed on the draw the verdict names.
*/
async function auctionProblems({ phase, gm, crate }) {
  const out = [];
  const frames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const text = sel => document.querySelector(sel)?.textContent.replace(/\s+/g, " ").trim() ?? "";
  const shown = el => !!el && !el.hidden && el.getBoundingClientRect().height > 0;
  const name = crate ? "The Sealed Lot" : "The Midnight Lot";
  if (!text(".lc-table__head").startsWith(name)) out.push(`head reads "${text(".lc-table__head")}"`);
  const stateEl = document.querySelector(".lc-table__state");
  const landed = phase === "hammer";
  if (stateEl?.getAttribute("role") !== (landed ? "status" : "timer")) out.push(`the gavel's state has role "${stateEl?.getAttribute("role")}"`);
  if (!(landed ? /^Settled$/ : /^The gavel falls in 0:\d\d$/).test(stateEl?.textContent.trim() ?? "")) out.push(`the state reads "${stateEl?.textContent}"`);
  const lot = text(".lc-auction__lotname strong");
  if (lot !== (crate ? "A sealed Adventurer's Crate" : "Flame Tongue")) out.push(`the lot reads "${lot}"`);
  const want = { open: ["Opening bid", "20 gp", "No bids yet"], bid: ["Top bid", "40 gp", "House bidder 1"], hammer: ["Sold for", "45 gp", "Tam Thornwick"] }[phase];
  const got = [text(".lc-auction__line"), text(".lc-auction__amount"), text(".lc-auction__who")];
  if (got.join("|") !== want.join("|")) out.push(`the bid block reads ${got.join(" | ")}`);
  const reserve = text(".lc-auction__reserve");
  const wantReserve = crate ? "" : phase === "open" ? "Reserve not met yet" : "Reserve met";
  if (reserve !== wantReserve) out.push(`the reserve line reads "${reserve}"`);
  if (/40 gp/.test(reserve)) out.push("the reserve's amount is shown");
  const past = [...document.querySelectorAll(".lc-auction__past")];
  const wantPast = { open: 0, bid: 4, hammer: 5 }[phase];
  if (!crate && past.length !== wantPast) out.push(`${past.length} past bids on the board`);
  if (phase === "bid" && (!past[0]?.classList.contains("lc-auction__past--top") || past.slice(1).some(p => !p.classList.contains("lc-auction__past--beaten")))) out.push("the top bid or the beaten ones aren't marked");
  if (phase === "bid" && getComputedStyle(past[1].querySelector(".lc-auction__past-amount")).textDecorationLine !== "line-through") out.push("a beaten bid isn't struck through");
  for (const el of document.querySelectorAll(".lc-auction__board *, .lc-table__state, .lc-table__count, .lc-table__bet, .lc-table__spin, .lc-table__cancel")) {
    if (el.childElementCount || !el.textContent.trim()) continue;
    if (parseFloat(getComputedStyle(el).fontSize) < 11) { out.push(`${el.className} is under 11px`); break; }
  }
  // The strip's track runs past its viewport by design (spin.js); the viewport itself must fit.
  for (const el of document.querySelectorAll(".lc-table__body *:not(.lc-spin__track, .lc-spin__track *)")) {
    const r = el.getBoundingClientRect();
    if (r.right > document.documentElement.clientWidth + 1) { out.push(`the table overflows: ${el.className}`); break; }
  }
  const bar = document.querySelector(".lc-gavel__bar");
  const scale = bar ? new DOMMatrix(getComputedStyle(bar).transform).a : -1;
  if (!landed && !(scale > 0.4 && scale < 0.9)) out.push(`the gavel's bar is at ${scale.toFixed(2)}, not draining from 14 s of 20`);
  const form = document.querySelector(".lc-table__form");
  const spin = document.querySelector(".lc-table__spin");
  const cancel = document.querySelector(".lc-table__cancel");
  const btn = document.querySelector(".lc-reveal__close");
  if (gm) {
    if (form) out.push("the GM has a bid form with no character");
    if (!shown(spin) || spin.textContent.trim() !== "Bring the gavel down") out.push(`the GM's gavel reads "${spin?.textContent.trim()}"`);
    if (!shown(cancel) || cancel.textContent.trim() !== "Call it off") out.push(`the GM's Call it off reads "${cancel?.textContent.trim()}"`);
    return out;
  }
  if (spin || cancel) out.push("a player sees the GM's buttons");
  if (!landed) {
    if (!form) return [...out, "no bid form while bidding"];
    const input = form.querySelector('input[name="amount"]');
    const bet = form.querySelector(".lc-table__bet");
    const next = phase === "open" ? "20" : "45";
    if (input?.value !== next || input.min !== next) out.push(`the bid field holds ${input?.value} (least ${input?.min})`);
    if (bet?.textContent.trim() !== `Bid ${next} gp`) out.push(`the primary action reads "${bet?.textContent.trim()}"`);
    if (btn?.textContent !== "Close") out.push(`the close button reads "${btn?.textContent}" while bidding`);
    if (phase !== "bid") return out;
    if (!/^House bidder 1 bids 40 gp, the top bid; Orla Vane's bid came back\.$/.test(text(".lc-table__live"))) out.push(`the status line reads "${text(".lc-table__live")}"`);
    if (text(".lc-table__list") !== "House bidder 1 bids 40 gp") out.push(`the screen-reader list reads "${text(".lc-table__list")}"`);
    input.value = "42";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    if (bet.textContent.trim() !== "Bid 45 gp") out.push(`under the least bid the button reads "${bet.textContent.trim()}"`);
    bet.focus();
    bet.click();
    await frames();
    const why = form.querySelector(".lc-table__why");
    if (why?.textContent !== "Bid at least 45 gp." || !shown(why)) out.push(`a 42 gp bid is refused with "${why?.textContent}"`);
    if (document.activeElement !== bet) out.push("focus left the bid button on a refusal");
    input.value = "50";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    if (bet.textContent.trim() !== "Bid 50 gp") out.push(`a typed 50 gp reads "${bet.textContent.trim()}"`);
    bet.click();
    await frames();
    if (text(".lc-auction__amount") !== "50 gp" || text(".lc-auction__who") !== "Tam Thornwick") out.push(`after Tam's bid the board reads ${text(".lc-auction__amount")} by ${text(".lc-auction__who")}`);
    if (document.querySelectorAll(".lc-auction__past").length !== 5 || !document.querySelector(".lc-auction__past--new.lc-auction__past--mine")) out.push("Tam's bid isn't on the board as new and his own");
    if (!document.querySelectorAll(".lc-auction__past")[1]?.classList.contains("lc-auction__past--beaten")) out.push("the house's bid isn't struck once beaten");
    if (!/^Tam Thornwick bids 50 gp, the top bid; House bidder 1 is outbid\.$/.test(text(".lc-table__live"))) out.push(`after the bid the status line reads "${text(".lc-table__live")}"`);
    if (bet.textContent.trim() !== "Bid 55 gp" || input.value !== "55") out.push(`after the bid the form offers "${bet.textContent.trim()}" (${input.value})`);
    if (!document.querySelector(".lc-gavel--reset")) out.push("the gavel doesn't show its reset");
    await frames();
    const full = new DOMMatrix(getComputedStyle(bar).transform).a;
    if (!(full > 0.9)) out.push(`the gavel's bar didn't fill again (${full.toFixed(2)})`);
    if (why?.textContent) out.push(`a good bid still says "${why.textContent}"`);
    return out;
  }
  const stage = document.querySelector(".lc-table__stage");
  if (!stage?.classList.contains("lc-table__stage--landed")) out.push("the hammer never landed");
  if (text(".lc-auction__stamp") !== "Sold") out.push(`the stamp reads "${text(".lc-auction__stamp")}"`);
  const result = document.querySelector(".lc-table__result");
  const verdict = result?.innerText.replace(/\s+/g, " ").trim() ?? "";
  if (!verdict.startsWith("Sold to Tam Thornwick for 45 gp.")) out.push(`the verdict reads "${verdict}"`);
  if (!result?.closest("[aria-live]")) out.push("the verdict is not in a live region");
  if (btn?.textContent !== "Close" || document.activeElement !== btn) out.push("the landed auction has no focused Close");
  if (form) out.push("a bid form after the hammer");
  if (crate) {
    const card = document.querySelector(".lc-auction__strip.lc-spin--landed .lc-card--landed .lc-card__name")?.textContent.trim();
    if (!card) out.push("the sealed crate's strip didn't land");
    else if (!verdict.includes(`The crate gave ${card}.`)) out.push(`the strip landed on "${card}" but the verdict reads "${verdict}"`);
  } else if (!document.querySelector(".lc-vault")?.classList.contains("lc-rarity-rare")) out.push("the vault isn't in the lot's rarity");
  return out;
}

// The auction's card in the shop (auction.js): the lot, the top bid and its
// bidder, the reserve met, the gavel's countdown, and "Join the bidding" on,
// its data-price the next legal bid.
function auctionCardProblems(on) {
  const card = document.querySelector('.lc-box[data-box="auction"]');
  if (!on) return card ? ["an auction card in a shop without one"] : [];
  if (!card) return ["no auction card in the shop"];
  const out = [];
  const text = card.innerText.replace(/\s+/g, " ");
  for (const bit of ["Flame Tongue", "Rare", "Top bid 40 gp by House bidder 1. Reserve met.", "The gavel falls in 0:"]) if (!text.includes(bit)) out.push(`the auction card doesn't say "${bit}"`);
  const buy = card.querySelector(".lc-box__buy");
  if (!/Join the bidding$/.test(buy?.textContent.trim() ?? "") || buy.getAttribute("aria-disabled") === "true") out.push(`the auction's Buy reads "${buy?.textContent.trim()}"`);
  if (buy?.dataset.price !== "45") out.push(`the auction's data-price is ${buy?.dataset.price}`);
  if (!card.querySelector(".lc-box__round[data-lc-countdown]")) out.push("the auction card's gavel isn't a countdown");
  return out;
}

// The shop's honesty rules, read from the DOM: no "0%" anywhere, every pill
// names its rarity, every unbuyable Buy (aria-disabled, never disabled, so it
// keeps focus) points at visible reasons, a shop-wide
// reason is said once (in the header's notice, never under a card), and the
// shop has one live region, which keeps its node across a re-render.
// The stock and the limit per character on the shop's cards (limits.js):
// the Royal Vault reads "3 of 10 left"; the Pauper's Box says Tam can buy
// one more, or once reached, says so as its reason with the Buy off.
// The scratch ticket's card in the shop (scratch.js): the tickets left,
// a row per prize with what is left (a prize gone struck through), the
// odds of what is left with the guarantee and an on Buy; sold out, the
// roll said sold out, Sold out under an off Buy and no odds. Nothing in
// the card under the 11px floor, nothing past its edge.
function scratchCardProblems(mode) {
  const out = [];
  const card = document.querySelector('.lc-box[data-box="fortune"], .lc-box[data-box="market"]');
  if (!mode) return card ? ["a scratch card in a shop without one"] : [];
  if (!card) return ["no scratch card in the shop"];
  const text = card.innerText.replace(/\s+/g, " ");
  const buy = card.querySelector(".lc-box__buy");
  const rows = [...card.querySelectorAll(".lc-scratch__tier")];
  if (mode === "hidden") {
    for (const bit of ["Top prize: Rare item", "All prizes 5 gp or more"]) if (!text.includes(bit)) out.push(`the hidden scratch card doesn't say "${bit}"`);
    for (const bit of ["tickets left", "tickets wins", "of 100", "of 2", "Players don't see"]) if (text.includes(bit)) out.push(`a player's hidden scratch card says "${bit}"`);
    if (rows.length || card.querySelector(".lc-scratch__prizes")) out.push("a player's hidden scratch card lists the prizes left");
    if (buy?.getAttribute("aria-disabled") === "true" || !/Buy a ticket for 5 gp$/.test(buy?.textContent.trim() ?? "")) out.push(`the hidden scratch Buy reads "${buy?.textContent.trim()}"`);
  } else if (mode === "left") {
    for (const bit of ["57 of 100 tickets left", "Rare item", "1 of 1", "0 of 2", "14 of 20", "1 in 2 tickets wins, the top prize (Rare item) 1 in 57, all prizes 5 gp or more"]) if (!text.includes(bit)) out.push(`the scratch card doesn't say "${bit}"`);
    if (rows.length !== 6) out.push(`expected 6 prize rows, got ${rows.length}`);
    const gone = card.querySelectorAll(".lc-scratch__tier--gone s");
    if (gone.length !== 1 || gone[0].textContent !== "100 gp") out.push("the 100 gp prize isn't struck through");
    if (buy?.getAttribute("aria-disabled") === "true" || !/Buy a ticket for 5 gp$/.test(buy?.textContent.trim() ?? "")) out.push(`the scratch Buy reads "${buy?.textContent.trim()}"`);
    const bar = card.querySelector(".lc-scratch__tier:not(.lc-scratch__tier--gone) .lc-scratch__bar");
    if (!bar || bar.getBoundingClientRect().width < 16) out.push("a prize's bar is too narrow to read");
  } else {
    if (!text.includes("Roll 2 is sold out")) out.push("the sold-out card doesn't say its roll is sold out");
    if (buy?.getAttribute("aria-disabled") !== "true") out.push("the sold-out Buy is on");
    const why = card.querySelector(".lc-box__why");
    if (why?.textContent !== "Sold out") out.push(`the sold-out reason reads "${why?.textContent}"`);
    if (/tickets wins/.test(text)) out.push("a sold-out card still gives odds");
    if (card.querySelectorAll(".lc-scratch__tier--gone").length !== rows.length) out.push("a sold-out roll's prize isn't struck through");
  }
  const cr = card.getBoundingClientRect();
  for (const el of card.querySelectorAll(".lc-scratch__prizes *")) {
    const r = el.getBoundingClientRect();
    if (r.width && (r.right > cr.right + 1 || r.left < cr.left - 1)) { out.push(`the prize list overflows the card: ${el.className}`); break; }
  }
  const small = [...card.querySelectorAll("*")].filter(el => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && parseFloat(getComputedStyle(el).fontSize) < 11);
  if (small.length) out.push(`${small.length} texts under 11px in the scratch card, e.g. "${small[0].textContent.trim().slice(0, 30)}"`);
  return out;
}

// The scratch ticket's editor (scratch.js scratchFieldsHTML): the two
// layouts as radios with a sentence each, the grid, the bonus spot, the
// roll's size and its live-roll note, six prize rows each naming its
// fields by number, the readout. Add prize adds a seventh with its count
// focused and the readout follows; its remove takes it again.
async function scratchEditorProblems() {
  const out = [];
  const form = document.querySelector(".lc-form");
  const radios = [...form.querySelectorAll('input[name="layout"]')];
  if (radios.map(r => r.value).join("|") !== "lucky|match3" || !radios[0].checked) out.push("the layout radios are wrong");
  for (const r of radios) if (!document.getElementById(r.getAttribute("aria-describedby"))?.textContent.trim()) out.push(`the ${r.value} layout has no sentence`);
  if (form.querySelector('input[name="cols"]')?.value !== "4" || form.querySelector('input[name="rows"]')?.value !== "3") out.push("the grid isn't 4 x 3");
  if (form.querySelector(".lc-scratch-form__bonus")?.hidden) out.push("the bonus spot is hidden for lucky numbers");
  if (!/Roll 1 has sold 43 so far/.test(form.textContent)) out.push("the live roll's note is missing");
  const rows = () => [...form.querySelectorAll(".lc-prize-row")];
  if (rows().length !== 6) out.push(`expected 6 prize rows, got ${rows().length}`);
  const labels = rows().map(r => r.querySelector(".lc-prize-row__count").getAttribute("aria-label"));
  if (labels.join("|") !== [1, 2, 3, 4, 5, 6].map(n => `Tickets that win prize ${n}`).join("|")) out.push(`the counts are named ${labels.join(", ")}`);
  if (rows().filter(r => getComputedStyle(r.querySelector(".lc-prize-row__gp")).visibility === "visible").length !== 4) out.push("the gold field shows on a row that isn't coins");
  const readout = () => form.querySelector(".lc-scratch-form__readout")?.textContent;
  if (readout() !== "1 in 2.3 tickets wins, the top prize (Rare item) 1 in 100, all prizes 5 gp or more") out.push(`the readout reads "${readout()}"`);
  form.querySelector(".lc-prizes__add").click();
  const added = rows()[6];
  if (!added || document.activeElement !== added.querySelector(".lc-prize-row__count")) out.push("Add prize didn't add a row with its count focused");
  else {
    added.querySelector(".lc-prize-row__gp").value = "1";
    added.querySelector(".lc-prize-row__count").value = "10";
    added.querySelector(".lc-prize-row__count").dispatchEvent(new Event("input", { bubbles: true }));
    if (readout() !== "1 in 1.9 tickets wins, the top prize (Rare item) 1 in 100") out.push(`after Add prize the readout reads "${readout()}"`);
    added.querySelector(".lc-prize-row__remove").click();
    if (rows().length !== 6 || readout() !== "1 in 2.3 tickets wins, the top prize (Rare item) 1 in 100, all prizes 5 gp or more") out.push("removing the added row didn't put the readout back");
  }
  // Add a part: the Rare item's row pays 25 gp too; the part's choice is
  // focused, the line's parts are named by number, and its remove puts it back.
  const first = rows()[0];
  const and = first.querySelector(".lc-prize-row__and");
  if (!and || and.textContent.trim() !== "Add a part" || and.getAttribute("aria-label") !== "Add a part to prize 1") out.push(`the first row's Add a part reads "${and?.textContent.trim()}"`);
  else {
    if (getComputedStyle(first.querySelector(".lc-prize-part__remove")).display !== "none") out.push("a line of one part shows a part remove");
    and.click();
    const parts = [...first.querySelectorAll(".lc-prize-part")];
    if (parts.length !== 2 || document.activeElement !== parts[1].querySelector(".lc-prize-row__what")) out.push("Add a part didn't add a part with its choice focused");
    else {
      if (parts[1].querySelector(".lc-prize-row__what").getAttribute("aria-label") !== "What part 2 of prize 1 is") out.push(`the new part is named "${parts[1].querySelector(".lc-prize-row__what").getAttribute("aria-label")}"`);
      parts[1].querySelector(".lc-prize-row__gp").value = "25";
      parts[1].querySelector(".lc-prize-row__gp").dispatchEvent(new Event("input", { bubbles: true }));
      if (readout() !== "1 in 2.3 tickets wins, the top prize (Rare item + 25 gp) 1 in 100, all prizes 5 gp or more") out.push(`after Add a part the readout reads "${readout()}"`);
      parts[1].querySelector(".lc-prize-part__remove").click();
      if (first.querySelectorAll(".lc-prize-part").length !== 1 || readout() !== "1 in 2.3 tickets wins, the top prize (Rare item) 1 in 100, all prizes 5 gp or more") out.push("removing the part didn't put the line back");
    }
  }
  const left = form.querySelector('input[name="showLeft"]');
  if (!left?.checked || !/Players see what is left in the roll/.test(left.closest("label")?.textContent ?? "")) out.push("no \"Players see what is left in the roll\" switch, on");
  const small = [...form.querySelectorAll("*")].filter(el => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && parseFloat(getComputedStyle(el).fontSize) < 11);
  if (small.length) out.push(`${small.length} texts under 11px, e.g. "${small[0].textContent.trim().slice(0, 30)}"`);
  const fr = form.getBoundingClientRect();
  const over = [...form.querySelectorAll("input, select, button")].filter(el => { const r = el.getBoundingClientRect(); return r.width && (r.right > fr.right + 1 || r.left < fr.left - 1); });
  if (over.length) out.push(`${over.length} controls past the form's edge, e.g. ${over[0].name || over[0].className}`);
  return out;
}

// The Boxes tab with the Fortune Ticket's row: tagged Scratch, its prizes
// left as pills, its roll in the rules, Print a new roll named for it.
function scratchBoxesProblems() {
  const out = [];
  const row = [...document.querySelectorAll(".lc-table--boxes tbody tr")].find(r => /Fortune Ticket/.test(r.querySelector(".lc-table__name")?.textContent ?? ""));
  if (!row) return ["no Fortune Ticket row"];
  if (row.querySelector(".lc-kind")?.textContent !== "Scratch") out.push("the scratch row isn't tagged Scratch");
  const pills = [...row.querySelectorAll(".lc-odd")].map(p => p.textContent.trim());
  if (pills.join("|") !== "Rare item 1/1|100 gp 0/2|25 gp 4/5|10 gp 8/12|5 gp 14/20|Bonus, 25 gp 2/3") out.push(`the scratch row's pills read ${pills.join(", ")}`);
  if (!/Lucky numbers 4 × 3, bonus 25 gp, Roll 1: 57 of 100 tickets left/.test(row.querySelector('td[data-label="Rules"]')?.textContent ?? "")) out.push(`the scratch row's rules read "${row.querySelector('td[data-label="Rules"]')?.textContent}"`);
  const print = row.querySelector('[data-action="printRoll"]');
  if (print?.textContent.trim() !== "Print a new roll" || print.getAttribute("aria-label") !== "Print a new roll of Fortune Ticket") out.push("the scratch row has no Print a new roll");
  return out;
}

async function limitCardProblems({ reached, off, shelved = false }) {
  const out = [];
  const card = id => document.querySelector(`.lc-box[data-box="${id}"]`);
  const stock = card("royal")?.querySelector(".lc-box__stock")?.textContent.trim();
  // Off the shelf, the Royal Vault isn't on a player's shop (shelfShopProblems).
  if (!shelved && stock !== "3 of 10 left") out.push(`Royal Vault's stock reads "${stock}"`);
  const pauper = card("common");
  const line = pauper?.querySelector(".lc-box__limit")?.textContent.trim() ?? "";
  const why = pauper?.querySelector(".lc-box__why")?.textContent.trim() ?? "";
  const buy = pauper?.querySelector(".lc-box__buy");
  if (reached) {
    if (why !== "Limit reached: 2 of 2 for Tam Thornwick") out.push(`Pauper's Box at its limit says "${why}"`);
    if (line) out.push(`Pauper's Box at its limit still says "${line}"`);
    if (buy?.getAttribute("aria-disabled") !== "true" || !(buy.getAttribute("aria-describedby") ?? "").includes("lc-why-common")) out.push("Pauper's Box's Buy isn't off with its reason at the limit");
  } else {
    if (line !== "You can buy 1 more") out.push(`Pauper's Box's limit line reads "${line}"`);
    if (why) out.push(`Pauper's Box has a reason under the limit: "${why}"`);
    if (!off && buy?.getAttribute("aria-disabled") === "true") out.push("Pauper's Box's Buy is off under its limit");
  }
  const small = [...document.querySelectorAll(".lc-box__limit")].filter(el => parseFloat(getComputedStyle(el).fontSize) < 11);
  if (small.length) out.push("a limit line is under 11px");
  return out;
}

// The box editor's Limits group: one group with the stock, what is left of
// it beside Restock (a status, on), the limit per character with its
// period, and plain help tied to the fields.
// The deck editor's streak window: a number field in its sentence, the
// deck's 2 minutes, its hint named and at the 11px floor or over, inside the form.
function deckEditorProblems() {
  const out = [];
  const input = document.querySelector('input[name="streakMinutes"]');
  if (!input) return ["the deck editor has no streak window field"];
  const label = input.closest("label");
  if (label?.textContent.replace(/\s+/g, " ").trim() !== "Draws count as in a row within minutes") out.push(`the window's label reads "${label?.textContent.trim()}"`);
  if (input.value !== "2" || input.type !== "number" || input.min !== "0") out.push(`the window field is ${input.type} ${input.value} (min ${input.min})`);
  const help = document.getElementById(input.getAttribute("aria-describedby") ?? "");
  if (!/Blank or 0: every draw is a first draw\./.test(help?.textContent ?? "")) out.push(`the window's hint reads "${help?.textContent}"`);
  if (help && parseFloat(getComputedStyle(help).fontSize) < 11) out.push("the window's hint is under 11px");
  const form = document.querySelector(".lc-form").getBoundingClientRect(), r = input.getBoundingClientRect();
  if (r.width < 30 || r.height < 20 || r.right > form.right + 1) out.push("the window field is not fully visible");
  if (parseFloat(getComputedStyle(label).fontSize) < 11) out.push("the window's label is under 11px");
  if (!document.querySelector('input[name="step"]')) out.push("the step field is missing");
  return out;
}

async function limitsEditorProblems() {
  const out = [];
  const group = [...document.querySelectorAll(".lc-form fieldset")].find(f => f.querySelector("legend")?.textContent.trim() === "Limits");
  if (!group) return ["no Limits group"];
  if (group.querySelector('input[name="stock"]')?.value !== "10") out.push("the stock field doesn't show the GM's 10");
  const left = group.querySelector('.lc-limits__left[role="status"]');
  if (left?.textContent.trim() !== "3 of 10 left") out.push(`the stock line reads "${left?.textContent}"`);
  const restock = group.querySelector("[data-restock]");
  if (!restock || restock.disabled || restock.getAttribute("aria-disabled") === "true") out.push("Restock isn't on with 3 of 10 left");
  if (group.querySelector('input[name="limitMax"]')?.value !== "1" || group.querySelector('select[name="limitPer"]')?.value !== "day") out.push("the limit per character isn't 1 a day");
  for (const input of group.querySelectorAll("input[aria-describedby]")) {
    const help = document.getElementById(input.getAttribute("aria-describedby"));
    if (!help?.textContent.trim()) out.push(`${input.name}'s help is missing`);
  }
  const hints = [...group.querySelectorAll(".lc-form__hint")].filter(el => parseFloat(getComputedStyle(el).fontSize) < 11);
  if (hints.length) out.push("a hint is under 11px");
  const r = restock?.getBoundingClientRect();
  const g = group.getBoundingClientRect();
  if (r && (r.right > g.right + 1 || r.left < g.left - 1)) out.push("Restock spills out of the group");
  return out;
}

/*
  A table crate's card (boxcard.js chanceLinesHTML): its items by name with
  their real chances, best find first, "and 3 more", then "Nothing"; no
  rarity pills beside them; the percents add up to 100 (99 with the
  "<1%"); every line inside the card and at 11px or more. Without
  ?table=1 there is no such card.
*/
function tableCardProblems(on) {
  const card = document.querySelector('.lc-box[data-box="pockets-crate"]');
  if (!on) return card ? ["the table crate is on a shelf without ?table=1"] : [];
  if (!card) return ["no table crate card"];
  const out = [];
  const lines = [...card.querySelectorAll(".lc-chance")];
  const text = lines.map(l => `${l.querySelector(".lc-chance__name")?.textContent.trim()} ${l.querySelector(".lc-chance__pct")?.textContent.trim()}`);
  if (lines.some(l => !/^.+: .+%$/.test(l.textContent.trim()))) out.push("a chance line doesn't read as name: chance to a screen reader");
  const want = ["Flame Tongue <1%", "Boots of Elvenkind 4%", "Bag of Holding 6%", "Pole of Collapsing 8%", "and 3 more 56%", "Nothing 25%"];
  if (text.join("|") !== want.join("|")) out.push(`table crate's lines read "${text.join(", ")}"`);
  if (card.querySelector(".lc-odd")) out.push("the table crate shows rarity pills as well as its items");
  const sum = text.reduce((n, t) => n + (Number(t.match(/(\d+)%$/)?.[1]) || 0), 0);
  if (sum < 99 || sum > 100) out.push(`the table crate's chances add up to ${sum}%`);
  const c = card.getBoundingClientRect();
  for (const l of lines) {
    const r = l.getBoundingClientRect();
    if (r.left < c.left - 0.5 || r.right > c.right + 0.5) { out.push(`a chance line leaves the card: "${l.textContent.trim()}"`); break; }
    if (parseFloat(getComputedStyle(l).fontSize) < 11) { out.push("a chance line is under 11px"); break; }
  }
  return out;
}

/*
  The crate editor on a table's draft: the Odds group, two radios each
  named and described by its sentence, the table's odds picked and the
  rarity weights hidden, the copy note, "Count text results as nothing"
  ticked, and the preview naming the items and the nothing. By rarity
  brings the weights and the pills back; unticking the nothing takes it
  out of the preview. Left as it opened, for the screenshot.
*/
async function oddsEditorProblems() {
  const out = [];
  const frames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const group = [...document.querySelectorAll(".lc-form fieldset")].find(f => f.querySelector("legend")?.textContent.trim() === "Odds");
  if (!group) return ["no Odds group in the crate editor"];
  const radios = [...group.querySelectorAll('input[type="radio"][name="oddsMode"]')];
  if (radios.map(r => r.value).join() !== "rarity,weight") return [`the Odds group's choices are ${radios.map(r => r.value).join()}`];
  if (!radios[1].checked) out.push("a crate made from a table doesn't open on the table's odds");
  for (const r of radios) {
    if (!r.closest("label")?.textContent.trim()) out.push(`the ${r.value} choice has no label`);
    if (!document.getElementById(r.getAttribute("aria-describedby") ?? "")?.textContent.trim()) out.push(`the ${r.value} choice has no sentence`);
  }
  if (!/^Copied from Goblin's Pockets .*make the crate again to pick up changes\.$/.test(document.querySelector(".lc-form__from")?.textContent.trim() ?? "")) out.push("no 'Copied from' note");
  const weights = document.querySelector(".lc-form__weights");
  if (!weights?.hidden) out.push("rarity weights shown while the crate draws by the table's odds");
  const nothing = document.querySelector('input[name="countNothing"]');
  if (!nothing?.checked || !/Count text results as nothing/.test(nothing.closest("label")?.textContent ?? "")) out.push("'Count text results as nothing' isn't there, named and ticked");
  const preview = () => document.querySelector(".lc-form__preview");
  if (!preview().querySelector(".lc-chances")) out.push("the editor's preview doesn't name the items");
  if (!/Nothing:?\s*25%/.test(preview().textContent)) out.push("the editor's preview doesn't show the nothing");
  radios[0].click();
  await frames();
  if (weights?.hidden) out.push("By rarity doesn't bring the rarity weights back");
  if (!preview().querySelector(".lc-odd") || preview().querySelector(".lc-chances")) out.push("By rarity doesn't show the rarity pills");
  nothing?.click();
  await frames();
  if (/Nothing/.test(preview().textContent)) out.push("unticked, the nothing still shows in the preview");
  nothing?.click();
  radios[1].click();
  await frames();
  if (!weights?.hidden || !preview().querySelector(".lc-chances")) out.push("back on the table's odds, the editor doesn't return to named chances");
  if ([...document.querySelectorAll(".lc-form .lc-form__hint")].some(el => el.textContent.trim() && parseFloat(getComputedStyle(el).fontSize) < 11)) out.push("a hint is under 11px");
  return out;
}

/*
  The preview before a table goes into a pool: the lead names the count,
  the table and the pool; the notes say what was flattened and skipped;
  each row keeps its weight inside it, rows never overlapping.
*/
function dropPreviewProblems() {
  const out = [];
  const lead = document.querySelector(".lc-preview__lead")?.textContent.replace(/\s+/g, " ").trim();
  if (lead !== "Add 6 items from Goblin's Pockets to Goblin's Pockets.") out.push(`preview lead reads "${lead}"`);
  const notes = [...document.querySelectorAll(".lc-preview__skipped li")].map(li => li.textContent.trim());
  for (const want of ["1 nested table flattened into its items", "2 text results skipped", "1 spell skipped, not loot"]) if (!notes.includes(want)) out.push(`preview doesn't say "${want}"`);
  const rows = [...document.querySelectorAll(".lc-preview__list li")];
  if (!rows.some(li => /weight 40/.test(li.textContent))) out.push("preview doesn't show the weights");
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].getBoundingClientRect();
    const w = rows[i].querySelector(".lc-preview__weight")?.getBoundingClientRect();
    if (w && (w.bottom > r.bottom + 0.5 || w.top < r.top - 0.5)) { out.push(`a row's weight spills out of it: ${rows[i].textContent.trim()}`); break; }
    const next = rows[i + 1]?.getBoundingClientRect();
    if (next && next.top < r.bottom - 0.5) { out.push("preview rows overlap"); break; }
  }
  return out;
}

// The ticket's print, the approved mockup's (scratch.js ticketHTML,
// module.css): 560px at most and centred; the band with the name in
// chrome between two emblems and its sheen still under reduced motion;
// the chevron ribbon naming the top prize and the roll's prizes; the
// caption strips; the lucky numbers as round gold coins; every panel
// near-square (about 1 : 1.04), no wider than 118px, the grid as wide as
// the card says (four across on the Fortune Ticket, even at 390), an
// open panel's number centred; the bonus spot in its EXTRA box; four
// corners; the foot with the roll line, the tagline and the guarantee;
// the theme's two tokens on the ticket (the Fortune Ticket Dragon's
// hoard, the Market Scratchie and ?ticket=fey Fey market); and on an
// untouched panel the foil's stamp painted over its centre.
function scratchPrintProblems(mode) {
  const out = [];
  const ticket = document.querySelector(".lc-scratch__ticket");
  if (!ticket) return out;
  const tr = ticket.getBoundingClientRect();
  const stage = ticket.closest(".lc-scratch__stage")?.getBoundingClientRect();
  if (tr.width > 561) out.push(`the ticket is ${Math.round(tr.width)}px wide`);
  if (stage && Math.abs((stage.left + stage.right) / 2 - (tr.left + tr.right) / 2) > 2) out.push("the ticket isn't centred in the window");
  const match3 = ticket.dataset.layout === "match3";
  const band = ticket.querySelector(".lc-scratch__band");
  const title = band?.querySelector(".lc-scratch__title");
  if (!band || !title?.textContent.trim()) out.push("no band with the ticket's name");
  if (band && band.querySelectorAll(".lc-scratch__emblem svg").length !== 2) out.push("the band hasn't an emblem each side");
  if (title && getComputedStyle(title).textTransform !== "uppercase") out.push("the name isn't in capitals");
  if (band && getComputedStyle(band, "::before").animationName !== "none") out.push("the band's sheen runs under reduced motion");
  const ribbon = ticket.querySelector(".lc-scratch__ribbon");
  const words = el => (el ? [...el.children].map(c => c.textContent.trim()).join(" ") : "");
  const ribbonText = words(ribbon);
  if (!ribbon) out.push("no ribbon");
  else if (!/^Top prize/.test(ribbonText) || !/in prizes in this roll$/.test(ribbonText)) out.push(`the ribbon reads "${ribbonText}"`);
  else if (getComputedStyle(ribbon).clipPath === "none") out.push("the ribbon has no chevron ends");
  const wantRibbon = mode === "combo" ? "Top prize Rare item + 25 gp + the gem (25 gp) 670 gp and 1 item in prizes in this roll" : "Top prize Rare item 620 gp and 1 item in prizes in this roll";
  if (!match3 && ribbonText !== wantRibbon) out.push(`the Fortune Ticket's ribbon reads "${ribbonText}"`);
  const caps = [...ticket.querySelectorAll(".lc-scratch__cap")].map(words);
  const wantCaps = match3 ? ["Three the same win that prize", "Your numbers"] : ["Lucky numbers Match any of yours to win its prize", "Your numbers Wins add up"];
  if (caps.join("|") !== wantCaps.join("|")) out.push(`the caption strips read ${caps.join(", ")}`);
  for (const c of ticket.querySelectorAll(".lc-scratch__cap")) if (getComputedStyle(c).backgroundColor === "rgba(0, 0, 0, 0)") out.push("a caption strip has no colour");
  if (!match3) {
    const coins = [...ticket.querySelectorAll(".lc-scratch__ball")];
    if (coins.length !== 3) out.push(`${coins.length} lucky numbers`);
    for (const c of coins) {
      const r = c.getBoundingClientRect();
      if (Math.abs(r.width - r.height) > 1 || getComputedStyle(c).borderRadius !== "50%") out.push("a lucky number isn't a round coin");
    }
    const extra = ticket.querySelector(".lc-scratch__extra");
    if (!ticket.querySelector(".lc-scratch__bonus") || extra?.textContent.trim() !== "Extra 25 gp") out.push(`the EXTRA box reads "${extra?.textContent.trim()}"`);
    if (ticket.querySelector(".lc-scratch__bonus p")?.textContent.trim() !== "Reveal the gem to win it on top of the card.") out.push("no line under Extra saying how");
    const spot = ticket.querySelector(".lc-scratch__spot")?.getBoundingClientRect();
    if (!spot || Math.abs(spot.width - spot.height) > 1) out.push("the bonus spot isn't square");
  }
  if (ticket.querySelectorAll(".lc-scratch__corner").length !== 4) out.push("the ticket hasn't four corners");
  const foot = ticket.querySelector(".lc-scratch__foot");
  const tag = foot?.querySelector(".lc-scratch__tag")?.textContent.trim();
  if (!foot?.querySelector(".lc-scratch__roll")) out.push("no roll line in the foot");
  if (tag !== "Fortune favours the bold") out.push(`the tagline reads "${tag}"`);
  if (!foot?.querySelector(".lc-scratch__guarantee")?.textContent.trim()) out.push("no guarantee line in the foot");
  if (foot && getComputedStyle(foot).borderTopWidth === "0px") out.push("the foot has no rule over it");
  // The panels: near-square, capped, centred in their cells, the grid as wide as the card.
  const panels = [...ticket.querySelectorAll(".lc-scratch__panel:not(.lc-scratch__spot)")];
  const cols = Number(ticket.querySelector(".lc-scratch__grid")?.style.getPropertyValue("--lc-cols")) || 0;
  const rects = panels.map(p => p.getBoundingClientRect());
  const widths = new Set(rects.map(r => Math.round(r.width)));
  if (widths.size > 1) out.push(`panels of ${[...widths].join(", ")}px`);
  for (const r of rects) {
    const ratio = r.height / r.width;
    if (ratio < 0.98 || ratio > 1.12) out.push(`a panel is ${Math.round(r.width)} x ${Math.round(r.height)}px, not near-square`);
    if (r.width > 119) out.push(`a panel is ${Math.round(r.width)}px wide, over the 118px cap`);
    break;
  }
  if (cols && rects.length >= cols + 1) {
    const row = rects.slice(0, cols);
    if (new Set(row.map(r => Math.round(r.top))).size !== 1 || Math.round(rects[cols].top) <= Math.round(row[0].top)) out.push(`the grid isn't ${cols} wide`);
  }
  for (const p of panels.filter(x => x.classList.contains("lc-scratch__panel--open"))) {
    const r = p.getBoundingClientRect(), n = p.querySelector(".lc-scratch__num, .lc-scratch__sym")?.getBoundingClientRect();
    if (n && Math.abs((n.left + n.right) / 2 - (r.left + r.right) / 2) > 2) out.push("an open panel's number isn't centred");
    if (n && !match3 && Math.abs((n.top + n.bottom) / 2 - (r.top + r.bottom) / 2) > r.height * 0.22) out.push("an open panel's number sits at its foot");
    if (n && !p.querySelector(".lc-scratch__prize, .lc-scratch__sym")) out.push("an open panel has no prize pill");
    break;
  }
  // The theme: the ticket says it, and its deep colour is the theme's.
  const theme = mode === "fey" || match3 ? "fey" : "hoard";
  const deep = { hoard: "#6e1a2b", fey: "#1f5a3a" }[theme];
  if (ticket.dataset.theme !== theme || ticket.closest(".lc-scratch")?.dataset.theme !== theme) out.push(`the ticket is printed in ${ticket.dataset.theme}, not ${theme}`);
  if (getComputedStyle(ticket).getPropertyValue("--lc-ticket-deep").trim() !== deep) out.push(`the ${theme} ticket's deep colour is ${getComputedStyle(ticket).getPropertyValue("--lc-ticket-deep").trim()}`);
  if (getComputedStyle(ticket).borderTopColor !== getComputedStyle(ticket.querySelector(".lc-scratch__cap")).backgroundColor) out.push("the ticket's edge and its caption strips aren't the one deep colour");
  // The foil's stamp: an untouched panel's canvas is opaque at its centre (the stamp's fill), painted, not flat.
  if (mode === "covered") {
    const c = panels[0]?.querySelector(".lc-scratch__foil");
    if (c?.width) {
      const d = c.getContext("2d").getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
      if (d[3] < 200) out.push("no stamp at the centre of an untouched panel");
      // The lattice's threads: the foil's pixels aren't one colour along a row near the top.
      const row = c.getContext("2d").getImageData(0, 3, c.width, 1).data;
      const tones = new Set(); for (let i = 0; i < row.length; i += 4) tones.add(`${row[i]},${row[i + 1]},${row[i + 2]}`);
      if (tones.size < 6) out.push("the foil has no lattice");
    }
  }
  return out;
}

// A scratch ticket's reveal (scratch.js, foil.js). `mode`: covered | half
// (the buyer's, scratching) | won | dud | item | match3 (landed) |
// spectator (mid auto-scratch) | fey (the coin win in Fey market green).
// The foil's pixels are read back, so a panel counts as scraped only
// where the coin really took the foil off.
function scratchRevealProblems(mode) {
  const out = [];
  if (mode === "fey") mode = "won";
  const shown = el => !!el && !el.hidden && el.getBoundingClientRect().height > 0;
  const ticket = document.querySelector(".lc-scratch__ticket");
  if (!ticket) return ["no scratch ticket"];
  const panels = [...ticket.querySelectorAll("[data-panel]")];
  const open = panels.filter(p => p.classList.contains("lc-scratch__panel--open"));
  const coin = ticket.querySelector(".lc-scratch__coin");
  const coinOn = !!coin && coin.classList.contains("lc-scratch__coin--on") && getComputedStyle(coin).opacity !== "0";
  const tools = document.querySelector(".lc-scratch__tools");
  // The share of a panel's foil scraped off, from its canvas's alpha on a coarse grid.
  const scraped = p => {
    const c = p.querySelector(".lc-scratch__foil");
    if (!c?.width) return null;
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let clear = 0, n = 0;
    for (let y = 2; y < c.height; y += 6) for (let x = 2; x < c.width; x += 6) { n++; if (d[(y * c.width + x) * 4 + 3] < 40) clear++; }
    return clear / n;
  };
  if (mode === "covered" || mode === "half" || mode === "spectator") {
    if (!ticket.classList.contains("lc-scratch__ticket--covered")) out.push("the ticket isn't covered while it is being scratched");
    if (document.body.dataset.landed) out.push("the card landed before every panel was open");
    for (const p of panels) {
      const isOpen = p.classList.contains("lc-scratch__panel--open");
      const foil = p.querySelector(".lc-scratch__foil");
      if (!isOpen && !(foil?.classList.contains("lc-scratch__foil--painted") && foil.getBoundingClientRect().width > 0)) out.push(`panel ${p.dataset.panel} has no painted foil`);
      if (!isOpen && (p.classList.contains("lc-scratch__panel--win") || [...p.classList].some(c => c.startsWith("lc-rarity-")))) out.push(`panel ${p.dataset.panel} shows its win through the foil`);
      if (!isOpen && !/covered/.test(p.getAttribute("aria-label") ?? "")) out.push(`covered panel ${p.dataset.panel} reads "${p.getAttribute("aria-label")}"`);
      if (isOpen && /covered/.test(p.getAttribute("aria-label") ?? "")) out.push(`open panel ${p.dataset.panel} still reads covered`);
    }
    if (!coinOn) out.push("no coin on the foil");
  }
  if (mode === "covered") {
    if (open.length) out.push(`${open.length} panels open on an untouched card`);
    const foil = panels[1]?.querySelector(".lc-scratch__foil");
    if (foil && getComputedStyle(foil).cursor !== "none") out.push("the pointer isn't hidden over the buyer's foil");
    if (foil && getComputedStyle(foil).touchAction !== "none") out.push("the buyer's foil takes scroll gestures");
    if (scraped(panels[0]) !== 0) out.push("the untouched foil isn't whole");
    const r = panels[1].getBoundingClientRect(), c = coin.getBoundingClientRect();
    if (Math.abs(c.left + c.width / 2 - (r.left + r.width * 0.55)) > 3 || Math.abs(c.top + c.height / 2 - (r.top + r.height * 0.4)) > 3) out.push("the coin isn't where the pointer is");
    if (!document.querySelector(".lc-scratch__ticket[data-buyer]") || !panels.some(p => p.getAttribute("tabindex") === "0")) out.push("the buyer's panels aren't a keyboard group");
  }
  if (mode === "covered" || mode === "half") {
    const all = tools?.querySelector(".lc-scratch__all");
    if (!shown(all) || all.textContent.trim() !== "Reveal all") out.push("no Reveal all under the buyer's card");
    if (!/R reveals the whole card/.test(tools?.querySelector(".lc-scratch__help")?.textContent ?? "")) out.push("no keyboard help under the buyer's card");
  }
  // The window is capped at the screen and clips what runs past it (the
  // harness frame as Foundry's): the ticket scrolls in its stage, so Reveal
  // all, the result line and Skip or Close stay inside the frame.
  const frame = ticket.closest(".window-content")?.getBoundingClientRect();
  if (frame) for (const [sel, what] of [[".lc-scratch__all", "Reveal all"], [".lc-reveal__result", "the result line"], [".lc-reveal__close", "Skip or Close"]]) {
    const el = document.querySelector(sel);
    if (!shown(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.top < frame.top - 0.5 || r.bottom > frame.bottom + 0.5) out.push(`${what} runs out of the window (${Math.round(r.top)} to ${Math.round(r.bottom)}, the window ${Math.round(frame.top)} to ${Math.round(frame.bottom)})`);
  }
  if (mode === "half") {
    if (open.length !== 5 || open.some(p => Number(p.dataset.panel) > 4)) out.push(`${open.length} panels open after five scratched (${open.map(p => p.dataset.panel).join(", ")})`);
    for (const p of open) if (shown(p.querySelector(".lc-scratch__foil"))) out.push(`open panel ${p.dataset.panel} keeps its foil`);
    const part = scraped(panels[5]);
    if (part == null || part < 0.08 || part >= 0.6) out.push(`the part-scraped panel is ${part == null ? "unpainted" : `${Math.round(part * 100)}% scraped`}`);
    if (panels[5].classList.contains("lc-scratch__panel--open")) out.push("a panel under 60% opened");
  }
  if (mode === "spectator") {
    if (open.length < 2 || open.length >= panels.length) out.push(`${open.length} of ${panels.length} panels open mid auto-scratch`);
    if (tools) out.push("the table's view has the buyer's tools");
    if (ticket.dataset.buyer) out.push("the table's card takes the pointer");
  }
  if (["won", "dud", "item", "match3", "combo"].includes(mode)) {
    if (!document.body.dataset.landed) out.push("the card never landed");
    if (open.length !== panels.length) out.push(`${open.length} of ${panels.length} panels open once landed`);
    if (ticket.classList.contains("lc-scratch__ticket--covered") || !ticket.classList.contains("lc-scratch__ticket--open")) out.push("the landed ticket is still covered");
    if (panels.some(p => shown(p.querySelector(".lc-scratch__foil")))) out.push("foil left on a landed card");
    if (coinOn) out.push("the coin is still up once landed");
    if (tools) out.push("Reveal all is still there once landed");
    if (document.activeElement !== document.querySelector(".lc-reveal__close")) out.push("focus didn't move to Close on landing");
    const lit = panels.filter(p => p.classList.contains("lc-scratch__panel--win"));
    const text = document.querySelector(".lc-reveal__result")?.innerText.trim() ?? "";
    if (mode === "won" && (!lit.length || !/^Won 25 gp/.test(text))) out.push(`a coin win lit ${lit.length} panels and reads "${text}"`);
    if (mode === "dud" && (lit.length || !/^A dud/.test(text))) out.push(`a dud lit ${lit.length} panels and reads "${text}"`);
    if (mode === "item" && (lit.length !== 1 || ![...lit[0].classList].some(c => c.startsWith("lc-rarity-")) || !shown(document.querySelector(".lc-reveal__open")))) out.push("the item's panel isn't lit with its rarity, or no Open item");
    if (mode === "match3" && (lit.length !== 3 || new Set(lit.map(p => p.querySelector("[data-symbol]")?.dataset.symbol)).size !== 1)) out.push(`a match 3 win lit ${lit.length} panels`);
    if (mode === "combo") {
      // Three parts, three lit: the item's panel with its rarity, the 25 gp panel, the gem's spot.
      const item = lit.filter(p => [...p.classList].some(c => c.startsWith("lc-rarity-")));
      const coins = lit.filter(p => p.dataset.panel !== "bonus" && !item.includes(p));
      if (lit.length !== 3 || item.length !== 1 || coins.length !== 1 || !lit.some(p => p.dataset.panel === "bonus")) out.push(`a combination line lit ${lit.length} panels (${item.length} item, ${coins.length} coin)`);
      if (coins[0] && coins[0].querySelector(".lc-scratch__prize")?.textContent.trim() !== "25 gp") out.push(`the combination's coin panel shows "${coins[0].querySelector(".lc-scratch__prize")?.textContent.trim()}"`);
      if (item[0] && coins[0] && item[0].querySelector(".lc-scratch__num")?.textContent === coins[0].querySelector(".lc-scratch__num")?.textContent) out.push("the item and the coins share a lucky number");
      if (!/50 gp into Tam Thornwick's purse/.test(text) || !/inventory/.test(text)) out.push(`a combination line reads "${text}"`);
      if (!shown(document.querySelector(".lc-reveal__open"))) out.push("no Open item for the combination's item");
    }
  }
  const small = [...document.querySelectorAll(".lc-scratch *, .lc-reveal__result *")].filter(el => el.childElementCount === 0 && el.textContent.trim() && parseFloat(getComputedStyle(el).fontSize) < 11);
  if (small.length) out.push(`${small.length} texts under 11px in the scratch, e.g. "${small[0].textContent.trim().slice(0, 30)}"`);
  return out;
}

// A crate pull that found nothing: the quiet line, the buyer's gold, no
// Open item and nothing said about an inventory; the strip landed on the
// blank (no art), and focus on Close.
function nothingRevealProblems() {
  const out = [];
  const shown = el => !!el && !el.hidden && el.getBoundingClientRect().height > 0;
  const text = document.querySelector(".lc-reveal__result")?.innerText.trim() ?? "";
  if (!text.startsWith("Nothing this time.")) out.push(`a miss reads "${text}"`);
  if (/inventory/.test(text)) out.push("a miss says something went into an inventory");
  if (!/\d [gsc]p left/.test(text)) out.push("the buyer can't see the gold left after a miss");
  if (shown(document.querySelector(".lc-reveal__open"))) out.push("Open item after a miss");
  const landed = document.querySelector(".lc-card--landed");
  if (landed?.dataset.rarity !== "none" || !landed.querySelector(".lc-card__art--empty")) out.push("the strip didn't land on the blank");
  if (document.activeElement !== document.querySelector(".lc-reveal__close")) out.push("focus didn't move to Close on landing");
  return out;
}

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
  if (!(pressed?.getAttribute("aria-describedby") ?? "").split(" ").includes("lc-shop-notice")) out.push("the waiting Buy doesn't point at the notice");
  window.__lootCrates.renderShop();
  if (document.querySelector(".lc-shop__notice") !== notice || notice.textContent) out.push("the notice didn't clear in place");
  return out;
}

/*
  Forced colours (Windows high contrast): every gradient and colour is the
  system's, so a switch whose label no longer says its state must still
  draw its knob where the state is (module.css, forced-colors). Run in a
  context with forcedColors "active" on the Boxes tab (each game's "On the
  shelf", one off) and with the shop closed (the nav's "Shop open" off),
  in both themes: each switch is photographed and its knob found in the
  pixels, at the left while off and at the right while on.
*/
const FORCED_STATES = [
  ["forced-boxes", "state=manager&tab=boxes&shelf=off"],
  ["forced-boxes-closed", "state=manager&tab=boxes&shelf=off&shop=closed"],
];

async function forcedSwitchProblems(page, { shopOpen }) {
  const out = [];
  if (!await page.evaluate(() => matchMedia("(forced-colors: active)").matches)) return ["forced colours are not active"];
  const seen = { true: [], false: [] };
  for (const sw of await page.$$(".lc-switch")) {
    const info = await sw.evaluate(el => {
      const r = el.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(el);
      const textLeft = Math.min(...[...range.getClientRects()].map(x => x.left));
      const cs = getComputedStyle(el), knob = getComputedStyle(el, "::before");
      const kw = parseFloat(knob.width), kh = parseFloat(knob.height);
      return { pressed: el.getAttribute("aria-pressed"), name: el.getAttribute("aria-label") || el.textContent.trim(), w: r.width, h: r.height, x: textLeft - (parseFloat(cs.columnGap) || 0) - kw - r.left, y: (r.height - kh) / 2, kw, kh, nav: !!el.closest("nav") };
    });
    if (!(info.w > 0 && info.h > 0)) continue;
    if (!(info.kw >= 20)) { out.push(`${info.name}: no switch drawn`); continue; }
    const png = await sw.screenshot();
    // Where the knob's ink sits across the track, 0 (left) to 1 (right):
    // pixels inside the track's border unlike the track's middle, which
    // lies between the two knob positions.
    const knob = await page.evaluate(async ({ b64, info }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      const k = img.width / info.w;
      const x0 = Math.round(info.x * k), y0 = Math.round(info.y * k), w = Math.round(info.kw * k), h = Math.round(info.kh * k);
      const px = g.getImageData(x0, y0, w, h).data;
      const at = (x, y) => px.slice((y * w + x) * 4, (y * w + x) * 4 + 3);
      const bg = at(Math.floor(w / 2), Math.floor(h / 2));
      let n = 0, sx = 0;
      const edge = Math.ceil(2 * k);
      for (let y = edge; y < h - edge; y++) for (let x = edge; x < w - edge; x++) {
        const p = at(x, y);
        if (Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) > 120) { n++; sx += x; }
      }
      return { ink: n / (k * k), at: n ? sx / n / w : null };
    }, { b64: png.toString("base64"), info });
    if (knob.ink < 8 || knob.at == null) { out.push(`${info.name}: no knob to see in forced colours`); continue; }
    if (info.pressed === "true" && knob.at < 0.6) out.push(`${info.name} is on but its knob sits at ${knob.at.toFixed(2)} of the track`);
    if (info.pressed === "false" && knob.at > 0.4) out.push(`${info.name} is off but its knob sits at ${knob.at.toFixed(2)} of the track`);
    seen[info.pressed]?.push(knob.at);
    if (info.nav && (info.pressed === "true") !== shopOpen) out.push(`the nav's shop switch reads ${info.pressed}`);
  }
  if (!seen.true.length || !seen.false.length) out.push(`expected switches both on and off, got ${seen.true.length} on and ${seen.false.length} off`);
  else if (Math.min(...seen.true) - Math.max(...seen.false) < 0.3) out.push("on and off knobs sit too close to tell apart");
  return out;
}

// A subset while iterating: `npm run smoke -- --only=deck,well --width=1440
// --theme=dark` (or SMOKE_ONLY / SMOKE_WIDTH / SMOKE_THEME). --only matches a
// state name exactly or by prefix ("deck" takes deck-held, deck-boon, ...).
// The subset is for iterating; the full run is the gate before a commit.
const flag = (name) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? process.env[`SMOKE_${name.toUpperCase()}`] ?? "";
const only = flag("only").split(",").map(x => x.trim()).filter(Boolean);
const pick = ([name]) => !only.length || only.some(o => name === o || name.startsWith(`${o}-`));
const RUN_WIDTHS = WIDTHS.filter(w => !flag("width") || w.tag === flag("width"));
const RUN_THEMES = THEMES.filter(t => !flag("theme") || t === flag("theme"));
const RUN_STATES = STATES.filter(pick);
const RUN_FORCED = FORCED_STATES.filter(pick);
if (only.length || flag("width") || flag("theme")) {
  if (!RUN_STATES.length && !RUN_FORCED.length) { console.error(`smoke: no state matches --only=${only.join(",")}; states are ${STATES.map(([n]) => n).join(", ")}`); process.exit(2); }
  console.log(`smoke: subset, ${RUN_STATES.length + RUN_FORCED.length} of ${STATES.length + FORCED_STATES.length} states, widths ${RUN_WIDTHS.map(w => w.tag).join("/")}, themes ${RUN_THEMES.join("/")} (run the full smoke before committing)`);
}

const server = await serveStatic(root, PORT);
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
let failures = 0;
try {
  for (const w of RUN_WIDTHS) {
    const ctx = await browser.newContext({ viewport: w.viewport, isMobile: w.isMobile, hasTouch: w.hasTouch, reducedMotion: "reduce" });
    await mkdir(path.join(OUT, w.tag), { recursive: true });
    for (const theme of RUN_THEMES) for (const [name, query0] of RUN_STATES) {
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
      if (name.startsWith("landed") || name.startsWith("linger") || name === "replay" || name.startsWith("well") || (name.startsWith("dice") && name !== "dice-rolling") || (name.startsWith("deck") && name !== "deck-held") || (name.startsWith("roulette") && name !== "roulette-spinning")) await page.waitForSelector("body[data-landed]", { timeout: 10000 });
      if (name.startsWith("table")) await page.waitForSelector("body[data-ready]", { timeout: 10000 });
      if (name.startsWith("auction")) await page.waitForSelector("body[data-ready], body[data-landed]", { timeout: 10000 });
      // Mid-spin: the disc has turned (reduced motion is off for this state).
      if (name === "roulette-spinning") await page.waitForFunction(() => getComputedStyle(document.querySelector(".lc-wheel__turn")).transform !== "none", null, { timeout: 10000 });
      // Mid-hold: the card is posed face-down (reduced motion is off for
      // this state); a frame in, it has lifted.
      if (name === "deck-held") await page.waitForFunction(() => getComputedStyle(document.querySelector(".lc-deck__card")).transform !== "none", null, { timeout: 10000 });
      // Mid-roll: the dice are tumbling (reduced motion is off for this
      // state); two frames in, they have faces to show.
      if (name === "dice-rolling") await page.waitForFunction(() => [...document.querySelectorAll(".lc-dice__tray .lc-dice__face")].every(f => f.textContent.trim()), null, { timeout: 10000 });
      if (name.startsWith("welcome")) await page.waitForSelector("body[data-ready]", { timeout: 10000 });
      if (name.startsWith("scratch")) await page.waitForSelector(name === "scratch-unscratched" || name === "scratch-half" || name === "scratch-spectator" ? "body[data-ready]" : "body[data-landed]", { timeout: 10000 });
      // Mid auto-scratch: the coin has opened a few panels by itself.
      if (name === "scratch-spectator") await page.waitForFunction(() => document.querySelectorAll(".lc-scratch__panel--open").length >= 3, null, { timeout: 10000 });
      if (name.startsWith("manager") || name === "box-limits" || name === "editor-deck" || name === "editor-scratch" || name === "box-odds" || name === "drop-preview") await page.waitForSelector("body[data-ready]", { timeout: 10000 });
      await page.waitForTimeout(500);
      const wide = await page.evaluate(() => document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth + 1);
      if (name.startsWith("shop")) problems0.push(...await page.evaluate(shopControlProblems, name.endsWith("-gm")));
      if (name.startsWith("shop-empty")) problems0.push(...await page.evaluate(emptyShopProblems, name.endsWith("-gm")));
      else if (name.startsWith("shop")) {
        problems0.push(...await page.evaluate(shopProblems, name.slice(5)));
        problems0.push(...await page.evaluate(wellCardProblems, { capped: name === "shop-well-capped", closed: name === "shop-closed" }));
        problems0.push(...await page.evaluate(diceCardProblems, { closed: name === "shop-closed", busy: name === "shop-busy" }));
        problems0.push(...await page.evaluate(deckCardProblems, { streak: name === "shop-deck-streak", closed: name === "shop-closed", busy: name === "shop-busy" }));
        problems0.push(...await page.evaluate(rouletteCardProblems, { noRound: name === "shop-no-round", closed: name === "shop-closed", busy: name === "shop-busy", gm: name === "shop-gm" }));
        problems0.push(...await page.evaluate(limitCardProblems, { reached: name === "shop-limit", off: name === "shop-closed" || name === "shop-busy", shelved: name === "shop-shelf" }));
        problems0.push(...await page.evaluate(shelfShopProblems, name === "shop-shelf"));
        problems0.push(...await page.evaluate(tableCardProblems, name === "shop-table"));
        problems0.push(...await page.evaluate(auctionCardProblems, name === "shop-auction"));
        problems0.push(...await page.evaluate(scratchCardProblems, { "shop-scratch": "left", "shop-scratch-hidden": "hidden", "shop-scratch-soldout": "soldout" }[name] ?? null));
      }
      else if (name.startsWith("welcome")) problems0.push(...await page.evaluate(welcomeProblems, { view: name === "welcome-news" ? "news" : "welcome", empty: name === "welcome-empty" }));
      else if (name === "box-limits") {
        problems0.push(...await page.evaluate(limitsEditorProblems), ...await page.evaluate(shelfEditorProblems));
        // Restock, then a new number: the line follows the field (a press and keys, as a GM does).
        await page.click("[data-restock]");
        const said = [];
        for (const v of ["12", "", "10"]) { await page.fill('input[name="stock"]', v); said.push((await page.textContent(".lc-limits__left")).trim()); }
        if (said.join(" | ") !== "12 of 12 left once you save | Unlimited once you save | 10 of 10 left once you save") problems0.push(`the Restock line reads ${said.join(" | ")}`);
      }
      else if (name === "editor-deck") problems0.push(...await page.evaluate(deckEditorProblems), ...await page.evaluate(shelfEditorProblems));
      else if (name === "editor-scratch") problems0.push(...await page.evaluate(scratchEditorProblems), ...await page.evaluate(shelfEditorProblems));
      else if (name === "box-odds") problems0.push(...await page.evaluate(oddsEditorProblems));
      else if (name === "drop-preview") problems0.push(...await page.evaluate(dropPreviewProblems));
      else if (name === "landed-nothing") problems0.push(...await page.evaluate(nothingRevealProblems));
      else if (name.startsWith("scratch")) {
        const mode = { "scratch-unscratched": "covered", "scratch-half": "half", "scratch-won": "won", "scratch-dud": "dud", "scratch-item": "item", "scratch-match3-won": "match3", "scratch-spectator": "spectator", "scratch-theme-fey": "fey", "scratch-combo": "combo" }[name];
        problems0.push(...await page.evaluate(scratchPrintProblems, mode), ...await page.evaluate(scratchRevealProblems, mode));
      }
      else if (name.startsWith("linger")) {
        problems0.push(...await page.evaluate(lingerProblems, { off: name === "linger-off", paused: name === "linger-paused" }));
        if (name === "linger-dice") problems0.push(...await page.evaluate(diceProblems, "win"));
        else if (name === "linger-table") problems0.push(...await page.evaluate(tableProblems, { phase: "landed", outcome: "win", gm: false }));
        else problems0.push(...await page.evaluate(revealProblems, true));
      }
      else if (name.startsWith("auction")) problems0.push(...await page.evaluate(auctionProblems, { phase: { "auction-open": "open", "auction-bid": "bid", "auction-gm": "bid", "auction-hammer": "hammer", "auction-crate": "hammer" }[name], gm: name === "auction-gm", crate: name === "auction-crate" }));
      else if (name.startsWith("table") || name.startsWith("roulette")) problems0.push(...await page.evaluate(tableProblems, { phase: { "table-betting": "betting", "table-waiting": "waiting", "table-closed": "closed", "roulette-spinning": "spinning", "roulette-won": "landed", "roulette-lost": "landed" }[name], outcome: name === "roulette-lost" ? "lose" : "win", gm: name === "table-waiting" }));
      else if (name.startsWith("dice")) problems0.push(...await page.evaluate(diceProblems, { "dice-rolling": "rolling", "dice-won": "win", "dice-lost": "lose" }[name]));
      else if (name.startsWith("deck")) problems0.push(...await page.evaluate(deckProblems, { "deck-held": "held", "deck-boon": "item", "deck-bane": "loss", "deck-effect": "effect" }[name]));
      else if (name === "manager-dropped") problems0.push(...await page.evaluate(droppedProblems));
      else if (name === "manager-empty") problems0.push(...await page.evaluate(starterEmptyProblems, "pools"));
      else if (name === "manager-boxes-empty") problems0.push(...await page.evaluate(starterEmptyProblems, "boxes"));
      else if (name === "manager-boxes-starter") problems0.push(...await page.evaluate(starterBoxesProblems), ...await page.evaluate(panelProblems));
      else if (name === "manager-boxes-shelf") problems0.push(...await page.evaluate(shelfBoxesProblems), ...await page.evaluate(panelProblems));
      else if (name === "manager-boxes-scratch") problems0.push(...await page.evaluate(scratchBoxesProblems), ...await page.evaluate(panelProblems));
      else if (name.startsWith("manager-boxes")) problems0.push(...await page.evaluate(boxesProblems, name.endsWith("narrow")), ...await page.evaluate(panelProblems));
      else if (name.startsWith("manager-log")) problems0.push(...await page.evaluate(logProblems, name.endsWith("narrow")), ...await page.evaluate(panelProblems));
      else if (name.startsWith("manager")) problems0.push(...await page.evaluate(managerProblems, name === "manager-narrow"));
      else if (name === "replay") problems0.push(...await page.evaluate(replayProblems));
      else if (name.startsWith("well")) problems0.push(...await page.evaluate(wellProblems, { "well-missed": "nothing", "well-coin": "coin", "well-won": "item" }[name]));
      else problems0.push(...await page.evaluate(revealProblems, name === "landed-buyer" || name === "landed-missed"));
      if (name.startsWith("manager")) problems0.push(...await page.evaluate(navProblems));
      if (name.startsWith("manager-boxes") && name !== "manager-boxes-empty") problems0.push(...await page.evaluate(priceProblems));
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
      if (name.startsWith("linger") && name !== "linger-off" && name !== "linger-paused") problems0.push(...await lingerUseProblems(page));
      const problems = [...errors, ...problems0, ...(wide ? ["page scrolls sideways"] : [])];
      if (problems.length) { failures++; console.error(`FAIL ${w.tag}/${shot}: ${problems.join("; ")}`); }
      else console.log(`ok   ${w.tag}/${shot}`);
      await page.close();
    }
    await ctx.close();
    if (!RUN_FORCED.length) continue;
    const forced = await browser.newContext({ viewport: w.viewport, isMobile: w.isMobile, hasTouch: w.hasTouch, reducedMotion: "reduce", forcedColors: "active" });
    for (const theme of RUN_THEMES) for (const [name, query0] of RUN_FORCED) {
      const shot = `${name}${theme === "light" ? "-light" : ""}`;
      const page = await forced.newPage();
      const errors = [];
      page.on("pageerror", e => errors.push(e.message));
      page.on("console", m => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text()); });
      await page.goto(`http://localhost:${PORT}/harness/?${query0}&theme=${theme}`, { waitUntil: "networkidle" });
      await page.waitForSelector("body[data-ready]", { timeout: 10000 });
      await page.waitForTimeout(300);
      const wide = await page.evaluate(() => document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth + 1);
      const problems = [...errors, ...await forcedSwitchProblems(page, { shopOpen: !query0.includes("shop=closed") }), ...(wide ? ["page scrolls sideways"] : [])];
      await page.screenshot({ path: path.join(OUT, w.tag, `${shot}.png`), fullPage: true });
      if (problems.length) { failures++; console.error(`FAIL ${w.tag}/${shot}: ${problems.join("; ")}`); }
      else console.log(`ok   ${w.tag}/${shot}`);
      await page.close();
    }
    await forced.close();
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failures ? 1 : 0);
