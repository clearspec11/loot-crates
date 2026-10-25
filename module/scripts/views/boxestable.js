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
  limits.js). Every row's price is a field the GM types into (priceInputHTML
  below). Every row's last cell holds Edit, Copy (the same editor on an
  unsaved copy of the game, newgame.js copyOf) and Delete.
  Every row says whether players can see the game (shelf.js): its buttons'
  cell leads with the On the shelf toggle (aria-pressed, as the shop's own
  switch), on a line of its own as Reshuffle is, so the table is no wider
  for it; a game off the shelf is tagged so beside its kind, its row
  dimmed, its toggle unpressed, and a wheel's "Open a round"
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
import { RARITY_LABEL } from "../core/config.js";
import { oddsPills, oddsRibbon, oddsRows } from "./boxcard.js";
import { kindOf } from "../games/kinds.js";
import { wellOdds, wellOddsHTML, wellRulesText } from "../games/well.js";
import { diceOdds, diceOddsHTML, diceRulesText } from "../games/dicegame.js";
import { deckOdds, deckOddsHTML, deckRulesText } from "../games/deck.js";
import { betOdds, rouletteOddsHTML, rouletteRulesText } from "../games/roulette.js";
import { auctionLotHTML, auctionRulesText } from "../games/auction.js";
import { liveRoundOf } from "../core/round.js";
import { shopOdds, oddsModeOf } from "../core/odds.js";
import { formatPrice } from "../core/currency.js";
import { limitsText } from "../core/limits.js";
import { onShelf, shelfCountText, shelfToggleHTML } from "../core/shelf.js";
import { starterCallHTML, STARTER_LABEL } from "./starter.js";
import { t, words, onStrings } from "../core/i18n.js";

// The New buttons, in the order the kinds arrived; their action names are
// the manager's (test/actions.test.js keeps them off ApplicationV2's own).
const NEW_KEYS = [["addBox", "LOOTCRATES.Boxes.NewBox"], ["addWell", "LOOTCRATES.Boxes.NewWell"], ["addDice", "LOOTCRATES.Boxes.NewDice"], ["addDeck", "LOOTCRATES.Boxes.NewDeck"], ["addWheel", "LOOTCRATES.Boxes.NewWheel"], ["addAuction", "LOOTCRATES.Boxes.NewAuction"]];
export const NEW_BUTTONS = NEW_KEYS.map(([action, key]) => Object.defineProperty([action], 1, { enumerable: true, get: () => t(key) }));

// The table's columns, as its header reads them and as a stacked row
// captions them (the last, the buttons, needs no caption; its header is
// named for a screen reader only, tableHTML).
export const BOXES_COLUMNS = words(["LOOTCRATES.Boxes.ColBox", "LOOTCRATES.Boxes.ColPrice", "LOOTCRATES.Boxes.ColPools", "LOOTCRATES.Boxes.ColOdds", "LOOTCRATES.Boxes.ColRules", ""]);

// The table kinds' rows open their round ("Open a round", "Go to the
// table"; an auction's "Open the auction", "Go to the auction").
const TABLE_KINDS = ["roulette", "auction"];
const TABLE_WORDS = { roulette: words(["LOOTCRATES.Boxes.OpenRound", "LOOTCRATES.Boxes.GoToTable"]), auction: words(["LOOTCRATES.Boxes.OpenAuction", "LOOTCRATES.Boxes.GoToAuction"]) };
export const tableLabel = (b, rounds = {}) => (TABLE_WORDS[kindOf(b)] ?? TABLE_WORDS.roulette)[liveRoundOf(rounds, b.id) ? 1 : 0];

// Each kind's tag in the Box column, the crate's included.
const KIND_TAG = words({ crate: "LOOTCRATES.Kind.Crate", well: "LOOTCRATES.Kind.Well", dice: "LOOTCRATES.Kind.Dice", deck: "LOOTCRATES.Kind.Deck", roulette: "LOOTCRATES.Kind.Wheel", auction: "LOOTCRATES.Kind.Auction" });
export const kindTag = record => KIND_TAG[kindOf(record)] ?? kindOf(record);

// A box's odds in the Boxes table: its ribbon over its named pills.
const oddsCell = rows => rows.length ? `${oddsRibbon(rows)}<div class="lc-odds">${oddsPills(rows)}</div>` : `<em>${t("LOOTCRATES.Boxes.Empty")}</em>`;

// One cell, captioned with its column's name for a stacked row. The label
// is one of the column constants, never a user's text.
export const cell = (label, html, attrs = "") => `<td role="cell" data-label="${label}"${attrs ? ` ${attrs}` : ""}>${html}</td>`;

// A manager table: the header row from its columns, then the body rows.
// The roles say what the display property no longer does once a narrow
// panel stacks the rows. A column without words (the buttons') is named
// "Actions" for a screen reader, so every columnheader has a name.
export let UNNAMED_COLUMN = "";
onStrings(() => { UNNAMED_COLUMN = t("LOOTCRATES.Boxes.ColActions"); });
export function tableHTML(cls, columns, rowsHTML) {
  return `<table class="lc-table lc-table--stack ${cls}" role="table"><thead role="rowgroup"><tr role="row">${columns.map(c => `<th role="columnheader">${c || `<span class="lc-sr-only">${UNNAMED_COLUMN}</span>`}</th>`).join("")}</tr></thead><tbody role="rowgroup">
        ${rowsHTML}</tbody></table>`;
}

// The toolbar: every New, "Add starter crates" once there are games (an
// empty tab offers it in its body, starter.js starterCallHTML), how many
// games players can see, then the one status line the tab speaks through.
export function boxesToolbarHTML(status = "", esc = s => String(s ?? ""), boxes = []) {
  const count = shelfCountText(boxes);
  const starter = boxes.length ? `<button type="button" class="lc-toolbar__starter" data-action="starterCrates"><i class="fas fa-box-open" inert></i> ${STARTER_LABEL}</button>` : "";
  return `<div class="lc-toolbar lc-toolbar--boxes">${NEW_BUTTONS.map(([action, label]) => `<button type="button" data-action="${action}"><i class="fas fa-plus"></i> ${label}</button>`).join("")}${starter}${count ? `<span class="lc-shelf-count">${esc(count)}</span>` : ""}<span class="lc-pool__hint lc-manager__status" role="status">${esc(status)}</span></div>`;
}

export function boxesTableHTML({ boxes, pools, log = [], rounds = {}, recent = null, esc }) {
  if (!boxes.length) return starterCallHTML("boxes", esc);
  const kind = b => kindOf(b);
  const tag = b => ` <span class="lc-kind">${esc(kindTag(b))}</span>${onShelf(b) ? "" : ` <span class="lc-kind lc-kind--off">${t("LOOTCRATES.Boxes.OffShelfTag")}</span>`}`;
  const odds = b => ({
    well: () => wellOddsHTML(wellOdds(b, pools)) || `<em>${t("LOOTCRATES.Boxes.Dry")}</em>`,
    dice: () => diceOddsHTML(diceOdds(b, pools)) || `<em>${t("LOOTCRATES.Boxes.Unbeatable")}</em>`,
    deck: () => deckOddsHTML(deckOdds(b, pools, log)) || `<em>${t("LOOTCRATES.Boxes.Empty")}</em>`,
    roulette: () => rouletteOddsHTML(betOdds(b), esc) || `<em>${t("LOOTCRATES.Boxes.NoPockets")}</em>`,
    auction: () => auctionLotHTML(b, esc),
  }[kind(b)] ?? (() => oddsCell(oddsRows(shopOdds(b, pools)))))();
  const own = b => ({
    well: () => wellRulesText(b),
    dice: () => diceRulesText(b),
    deck: () => deckRulesText(b, log),
    roulette: () => rouletteRulesText(b),
    auction: () => auctionRulesText(b),
  }[kind(b)] ?? (() => [oddsModeOf(b) === "weight" ? (b.fromTable ? t("LOOTCRATES.Boxes.RuleTableOdds") : t("LOOTCRATES.Boxes.RuleByWeight")) : "", b.rules?.pity ? t("LOOTCRATES.Boxes.RulePityPulls", { rarity: RARITY_LABEL[b.rules.pity.minRarity] ?? b.rules.pity.minRarity, after: b.rules.pity.after }) : "", b.rules?.noDuplicates ? t("LOOTCRATES.Boxes.RuleNoDupes") : ""].filter(Boolean).join(", ")))();
  const rules = b => esc([own(b), TABLE_KINDS.includes(kind(b)) ? "" : limitsText(b)].filter(Boolean).join(", "));
  // A deck's row reshuffles; a wheel's opens its round (or brings the open one
  // forward). The text button sits on a line of its own over the icons
  // (module.css lc-table__extra), so the buttons' cell, the one that never
  // wraps, is never wider than the three icons and the table fits every
  // pane down to where its rows stack.
  const extra = b => (kind(b) === "deck" ? `<button type="button" class="lc-table__extra" data-action="reshuffle" data-box="${esc(b.id)}" aria-label="${t("LOOTCRATES.Boxes.ReshuffleLabel", { name: esc(b.name) })}">${t("LOOTCRATES.Boxes.Reshuffle")}</button> `
    : TABLE_KINDS.includes(kind(b)) && (onShelf(b) || liveRoundOf(rounds, b.id)) ? `<button type="button" class="lc-table__extra" data-action="openTable" data-box="${esc(b.id)}" aria-label="${t("LOOTCRATES.Boxes.TableAt", { label: tableLabel(b, rounds), name: esc(b.name) })}">${tableLabel(b, rounds)}</button> ` : "");
  const [BOX, PRICE, POOLS, ODDS, RULES, ACT] = BOXES_COLUMNS;
  const rowClass = b => [b.id === recent ? "lc-row--new" : "", onShelf(b) ? "" : "lc-row--off"].filter(Boolean).join(" ");
  return tableHTML("lc-table--boxes", BOXES_COLUMNS, boxes.map(b => `<tr${rowClass(b) ? ` class="${rowClass(b)}"` : ""} role="row">
          ${cell(BOX, `<span class="lc-table__name">${esc(b.name)}${tag(b)}</span>`)}${cell(PRICE, priceInputHTML(b, esc))}
          ${cell(POOLS, (b.pools ?? []).map(r => esc(pools[r.id]?.name ?? t("LOOTCRATES.Boxes.MissingPool"))).join(", ") || `<em>${t("LOOTCRATES.Boxes.NoPools")}</em>`)}
          ${cell(ODDS, odds(b))}
          ${cell(RULES, rules(b))}
          ${cell(ACT, `${shelfToggleHTML(b, esc)} ${extra(b)}<button type="button" data-action="editBox" data-box="${esc(b.id)}" aria-label="${t("LOOTCRATES.Boxes.EditLabel", { name: esc(b.name) })}" data-tooltip="${t("LOOTCRATES.Boxes.Edit")}"><i class="fas fa-pen" inert></i></button> <button type="button" data-action="copyBox" data-box="${esc(b.id)}" aria-label="${t("LOOTCRATES.Boxes.CopyLabel", { name: esc(b.name) })}" data-tooltip="${t("LOOTCRATES.Boxes.Copy")}"><i class="fas fa-copy" inert></i></button> <button type="button" data-action="deleteBox" data-box="${esc(b.id)}" aria-label="${t("LOOTCRATES.Boxes.DeleteLabel", { name: esc(b.name) })}" data-tooltip="${t("LOOTCRATES.Boxes.Delete")}"><i class="fas fa-trash" inert></i></button>`)}
        </tr>`).join(""));
}

/*
  The Price cell is the price, typed in place as a pool row's weight is
  (manager.js #onPrice): a text field holding the price as the shop says it
  ("12 gp 5 sp", currency.js formatPrice) and reading it back the same way
  (parsePrice), so "5 sp" and "12 gp 5 sp" go in as they read. Its name
  says what the price is for the game's kind: a crate's price, a deck's
  first draw, a wheel's lowest bet, a well's or dice game's stake.
*/
const PRICE_NAME = { deck: "LOOTCRATES.Boxes.PriceDeck", roulette: "LOOTCRATES.Boxes.PriceWheel", well: "LOOTCRATES.Boxes.PriceStake", dice: "LOOTCRATES.Boxes.PriceStake", auction: "LOOTCRATES.Boxes.PriceAuction" };
export const priceLabel = b => t(PRICE_NAME[kindOf(b)] ?? "LOOTCRATES.Boxes.PriceCrate", { name: b.name ?? "" }).trim();
export function priceInputHTML(b, esc = s => String(s ?? "")) {
  return `<input type="text" class="lc-price-input" data-box-price="${esc(b.id)}" value="${esc(formatPrice(b.price))}" aria-label="${esc(priceLabel(b))}" autocomplete="off" spellcheck="false">`;
}

// Under the table, how a roll table becomes a crate (manager.js
// makeCrateFromTable): the tab takes a dropped table, as a pool takes items.
export const tableDropHint = () => t("LOOTCRATES.Boxes.TableDropHint");

// The whole tab. An empty one says where a dropped table goes in its own
// first line, so the hint under the table is left out.
export function boxesTabHTML({ status = "", ...rest }) {
  const hint = rest.boxes?.length ? `<p class="lc-form__hint lc-boxes__drop">${tableDropHint()}</p>` : "";
  return `${boxesToolbarHTML(status, rest.esc, rest.boxes)}${boxesTableHTML(rest)}${hint}`;
}
