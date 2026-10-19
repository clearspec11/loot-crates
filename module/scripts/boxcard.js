/*
  The shop's box card and odds pills, as HTML strings with no Foundry in them,
  so the shop, the manager and the harness show one format. The caller passes
  its own escape function (foundry.utils.escapeHTML in a world).

  A disabled Buy says why in visible text under it, linked to the button with
  aria-describedby, so keyboard, screen-reader and touch users all learn it.
*/
import { RARITY_SHORT } from "./config.js";
import { shopOdds } from "./odds.js";
import { canAfford, formatPrice, shortfall } from "./currency.js";

// "Rare 12%": the rarity's name is on screen, not only its colour.
export function oddPill(row) {
  return `<span class="lc-odd lc-rarity-${row.rarity}">${RARITY_SHORT[row.rarity]} ${row.label}</span>`;
}

export function oddsPills(rows) {
  return rows.map(oddPill).join("");
}

/*
  Why this box can't be bought now, or "" when it can. `ctx`:
  { purse, hasActor, open, gmOnline }. The box's own state comes first (an
  empty or sold-out box stays unbuyable whoever asks), then the shop's, then
  the buyer's.
*/
export function buyReason(box, odds, { purse = {}, hasActor = false, open = true, gmOnline = true } = {}) {
  if (!odds.rows.length) return "Nothing inside";
  if (box.rules?.stock != null && box.rules.stock <= 0) return "Sold out";
  if (!open) return gmOnline ? "The GM has closed the shop" : "Closed until a GM is online";
  if (!hasActor) return "Pick a character";
  if (!canAfford(purse, box.price)) return `Needs ${formatPrice(shortfall(purse, box.price))} more`;
  return "";
}

// One box in the shop grid. `ctx` adds { busy, art, esc } to buyReason's.
export function boxCard(box, pools, ctx) {
  const esc = ctx.esc ?? (s => String(s ?? ""));
  const odds = shopOdds(box, pools);
  const reason = buyReason(box, odds, ctx);
  const whyId = `lc-why-${box.id}`;
  const rarityClass = odds.top ? `lc-rarity-${odds.top}` : "lc-box--empty";
  return `
      <div class="lc-box ${rarityClass}">
        <div class="lc-box__art">${ctx.art ?? ""}</div>
        <div class="lc-box__name">${esc(box.name)}</div>
        ${odds.rows.length
          ? `<div class="lc-box__odds">${oddsPills(odds.rows)}</div>`
          : `<div class="lc-box__nothing">No items in its pools yet</div>`}
        ${box.rules?.stock != null ? `<div class="lc-box__stock">${esc(box.rules.stock)} left</div>` : ""}
        <button type="button" class="lc-box__buy" data-action="buy" data-box="${esc(box.id)}"${reason || ctx.busy ? " disabled" : ""}${reason ? ` aria-describedby="${esc(whyId)}"` : ""}>
          ${ctx.busy ? "Opening…" : `Open for ${esc(formatPrice(box.price))}`}
        </button>
        ${reason ? `<div class="lc-box__why" id="${esc(whyId)}">${esc(reason)}</div>` : ""}
      </div>`;
}
