/*
  The manager's Boxes tab as markup, drawn by the manager (manager.js
  _boxes) and by the harness: the toolbar with one New button per kind and
  the tab's status line (the manager writes there what a New did), then one
  row per game the shop sells.

  Every row's name carries its kind's tag (Crate, Well, Dice, Deck, Wheel),
  so the six kinds read the same way in one table and a crate is told from
  the rest by its row alone. A crate's row: its odds as the shop shows them
  (the ribbon over the pills), its pity and no-duplicates rules. A well's:
  its three outcomes, its cap and pity in throws. A dice game's: win and
  lose, the dragon's number, the payout and the prize. A deck's: the kinds
  of card still in it, its cards and how many are drawn, and Reshuffle
  beside Edit. A wheel's: its odds per bet type and "Open a round" or "Go
  to the table" from the live rounds. Every pulled game's row shows its
  stock and limit per character ("3 of 10 left, 1 per character",
  limits.js). Every row's last cell holds Edit, Copy (the same editor on an
  unsaved copy of the game, newgame.js copyOf) and Delete.
  Every row says whether players can see the game (shelf.js): its buttons'
  cell leads with the On the shelf toggle (aria-pressed, as the shop's own
  switch), on a line of its own as Reshuffle is, so the table is no wider
  for it; a game off the shelf is tagged so beside its kind, its row
  dimmed, its toggle reading "Put on shelf", and a wheel's "Open a round"
  left out (a round already open still offers "Go to the table"). The
  toolbar counts them: "4 of 6 on the shelf".
  The row a New just added carries lc-row--new (an edge in the gold rule,
  as a dropped item's row carries its rarity) until the next New or the
  manager closes.

  Every cell names its column (data-label), so a narrow panel (a phone, or
  a manager window sized down on a desktop) stacks the row as a card with
  each value captioned and the buttons on a line of their own, instead of
  pushing Edit and Delete off the right edge (module.css, the lc-tab
  container). The table keeps its roles so a screen reader still reads it
  as one once its cells are no longer displayed as table cells. The Pull
  log (logtable.js) is built the same way.

  No Foundry globals: the caller passes the records, the pools as the last
  source check found them, the log, the rounds and the escape.
*/
import { RARITY_LABEL } from "./config.js";
import { oddsPills, oddsRibbon } from "./boxcard.js";
import { kindOf } from "./kinds.js";
import { wellOdds, wellOddsHTML, wellRulesText } from "./well.js";
import { diceOdds, diceOddsHTML, diceRulesText } from "./dicegame.js";
import { deckOdds, deckOddsHTML, deckRulesText } from "./deck.js";
import { betOdds, rouletteOddsHTML, rouletteRulesText } from "./roulette.js";
import { liveRoundOf } from "./round.js";
import { shopOdds } from "./odds.js";
import { formatPrice } from "./currency.js";
import { limitsText } from "./limits.js";
import { onShelf, shelfCountText, shelfToggleHTML } from "./shelf.js";

// The New buttons, in the order the kinds arrived; their action names are
// the manager's (test/actions.test.js keeps them off ApplicationV2's own).
export const NEW_BUTTONS = [["addBox", "New box"], ["addWell", "New well"], ["addDice", "New dice game"], ["addDeck", "New deck"], ["addWheel", "New wheel"]];

// The table's columns, as its header reads them and as a stacked row
// captions them (the last, the buttons, needs no caption).
export const BOXES_COLUMNS = ["Box", "Price", "Pools", "Odds", "Rules", ""];

// Each kind's tag in the Box column, the crate's included.
const KIND_TAG = { crate: "Crate", well: "Well", dice: "Dice", deck: "Deck", roulette: "Wheel" };
export const kindTag = record => KIND_TAG[kindOf(record)] ?? kindOf(record);

// A box's odds in the Boxes table: its ribbon over its named pills.
const oddsCell = rows => rows.length ? `${oddsRibbon(rows)}<div class="lc-odds">${oddsPills(rows)}</div>` : "<em>empty</em>";

// One cell, captioned with its column's name for a stacked row. The label
// is one of the column constants, never a user's text.
export const cell = (label, html, attrs = "") => `<td role="cell" data-label="${label}"${attrs ? ` ${attrs}` : ""}>${html}</td>`;

// A manager table: the header row from its columns, then the body rows.
// The roles say what the display property no longer does once a narrow
// panel stacks the rows.
export function tableHTML(cls, columns, rowsHTML) {
  return `<table class="lc-table lc-table--stack ${cls}" role="table"><thead role="rowgroup"><tr role="row">${columns.map(c => `<th role="columnheader">${c}</th>`).join("")}</tr></thead><tbody role="rowgroup">
        ${rowsHTML}</tbody></table>`;
}

// The toolbar: every New, how many games players can see, then the one
// status line the tab speaks through.
export function boxesToolbarHTML(status = "", esc = s => String(s ?? ""), boxes = []) {
  const count = shelfCountText(boxes);
  return `<div class="lc-toolbar lc-toolbar--boxes">${NEW_BUTTONS.map(([action, label]) => `<button type="button" data-action="${action}"><i class="fas fa-plus"></i> ${label}</button>`).join("")}${count ? `<span class="lc-shelf-count">${esc(count)}</span>` : ""}<span class="lc-pool__hint lc-manager__status" role="status">${esc(status)}</span></div>`;
}

export function boxesTableHTML({ boxes, pools, log = [], rounds = {}, recent = null, esc }) {
  if (!boxes.length) return `<p class="lc-empty">No boxes. A box prices a pull from one or more pools.</p>`;
  const kind = b => kindOf(b);
  const tag = b => ` <span class="lc-kind">${esc(kindTag(b))}</span>${onShelf(b) ? "" : ` <span class="lc-kind lc-kind--off">Off the shelf</span>`}`;
  const odds = b => ({
    well: () => wellOddsHTML(wellOdds(b, pools)) || "<em>dry</em>",
    dice: () => diceOddsHTML(diceOdds(b, pools)) || "<em>unbeatable</em>",
    deck: () => deckOddsHTML(deckOdds(b, pools, log)) || "<em>empty</em>",
    roulette: () => rouletteOddsHTML(betOdds(b), esc) || "<em>no pockets</em>",
  }[kind(b)] ?? (() => oddsCell(shopOdds(b, pools).rows)))();
  const own = b => ({
    well: () => wellRulesText(b),
    dice: () => diceRulesText(b),
    deck: () => deckRulesText(b, log),
    roulette: () => rouletteRulesText(b),
  }[kind(b)] ?? (() => [b.rules?.pity ? `${RARITY_LABEL[b.rules.pity.minRarity] ?? b.rules.pity.minRarity} or better after ${b.rules.pity.after} pulls` : "", b.rules?.noDuplicates ? "no dupes" : ""].filter(Boolean).join(", ")))();
  const rules = b => esc([own(b), kind(b) === "roulette" ? "" : limitsText(b)].filter(Boolean).join(", "));
  // A deck's row reshuffles; a wheel's opens its round (or brings the open one
  // forward). The text button sits on a line of its own over the icons
  // (module.css lc-table__extra), so the buttons' cell, the one that never
  // wraps, is never wider than the three icons and the table fits every
  // pane down to where its rows stack.
  const extra = b => (kind(b) === "deck" ? `<button type="button" class="lc-table__extra" data-action="reshuffle" data-box="${esc(b.id)}" aria-label="Reshuffle ${esc(b.name)}">Reshuffle</button> `
    : kind(b) === "roulette" && (onShelf(b) || liveRoundOf(rounds, b.id)) ? `<button type="button" class="lc-table__extra" data-action="openTable" data-box="${esc(b.id)}" aria-label="${liveRoundOf(rounds, b.id) ? "Go to the table" : "Open a round"} at ${esc(b.name)}">${liveRoundOf(rounds, b.id) ? "Go to the table" : "Open a round"}</button> ` : "");
  const [BOX, PRICE, POOLS, ODDS, RULES, ACT] = BOXES_COLUMNS;
  const rowClass = b => [b.id === recent ? "lc-row--new" : "", onShelf(b) ? "" : "lc-row--off"].filter(Boolean).join(" ");
  return tableHTML("lc-table--boxes", BOXES_COLUMNS, boxes.map(b => `<tr${rowClass(b) ? ` class="${rowClass(b)}"` : ""} role="row">
          ${cell(BOX, `<span class="lc-table__name">${esc(b.name)}${tag(b)}</span>`)}${cell(PRICE, esc(formatPrice(b.price)))}
          ${cell(POOLS, (b.pools ?? []).map(r => esc(pools[r.id]?.name ?? "missing")).join(", ") || "<em>none</em>")}
          ${cell(ODDS, odds(b))}
          ${cell(RULES, rules(b))}
          ${cell(ACT, `${shelfToggleHTML(b, esc)} ${extra(b)}<button type="button" data-action="editBox" data-box="${esc(b.id)}" aria-label="Edit ${esc(b.name)}" data-tooltip="Edit"><i class="fas fa-pen" inert></i></button> <button type="button" data-action="copyBox" data-box="${esc(b.id)}" aria-label="Copy ${esc(b.name)}" data-tooltip="Copy"><i class="fas fa-copy" inert></i></button> <button type="button" data-action="deleteBox" data-box="${esc(b.id)}" aria-label="Delete ${esc(b.name)}" data-tooltip="Delete"><i class="fas fa-trash" inert></i></button>`)}
        </tr>`).join(""));
}

// The whole tab.
export function boxesTabHTML({ status = "", ...rest }) {
  return `${boxesToolbarHTML(status, rest.esc, rest.boxes)}${boxesTableHTML(rest)}`;
}
