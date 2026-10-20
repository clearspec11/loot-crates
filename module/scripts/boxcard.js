/*
  The shop's box card, odds pills and odds ribbon, as HTML strings with no
  Foundry in them, so the shop, the manager, the reveal and the harness show
  one format. The caller passes its own escape function
  (foundry.utils.escapeHTML in a world).

  The card reads like a dnd5e card: the crate's name on a band, its bet as a
  ribbon (one bar of its real drop chances) over named odds, the price on the
  button. A disabled Buy says why in visible text under it, linked to the
  button with aria-describedby, so keyboard, screen-reader and touch users
  all learn it.
*/
import { RARITY_SHORT, RARITY_LABEL } from "./config.js";
import { shopOdds, flattenPool, rarityRank } from "./odds.js";
import { canAfford, formatPrice, shortfall } from "./currency.js";

// "Rare 12%": the rarity's name is on screen, not only its colour.
export function oddPill(row) {
  return `<span class="lc-odd lc-rarity-${row.rarity}">${RARITY_SHORT[row.rarity]} ${row.label}</span>`;
}

export function oddsPills(rows) {
  return rows.map(oddPill).join("");
}

/*
  The bet at a glance: one bar split by each rarity's real chance, in the
  rarity's colour. Decorative to assistive tech (the pills carry the words),
  but titled for a mouse. A sliver under 1% keeps a visible minimum width.
*/
export function oddsRibbon(rows) {
  if (!rows?.length) return "";
  const segs = rows.map(row => {
    const share = Math.max(0, Number(row.chance) || 0);
    return `<span class="lc-ribbon__seg lc-rarity-${row.rarity}" style="flex-grow:${+share.toFixed(4)}" title="${RARITY_LABEL[row.rarity] ?? row.rarity} ${row.label}"></span>`;
  }).join("");
  return `<div class="lc-ribbon" aria-hidden="true">${segs}</div>`;
}

/*
  A peek inside: up to three real items this box can drop, one from each of
  its best droppable rarities (highest first), so each crate looks like what
  it holds rather than like every other crate. Only entries with art and a
  chance above 0 count; with none, the caller's icon stands in.
*/
export function peekItems(box, pools, odds = shopOdds(box, pools), max = 3) {
  const droppable = new Set(odds.rows.map(row => row.rarity));
  const entries = (box.pools ?? []).flatMap(ref => flattenPool(ref.id, pools))
    .filter(e => e.img && droppable.has(e.rarity) && (e.weight ?? 1) > 0);
  const byRarity = [...droppable].sort((a, b) => rarityRank(b) - rarityRank(a));
  const out = [];
  for (const r of byRarity) {
    const pick = entries.filter(x => x.rarity === r && !out.includes(x));
    // Which item stands for a rarity depends on the crate, so two crates
    // sharing a pool don't show the same three.
    if (pick.length) out.push(pick[hash(`${box.id}:${r}`) % pick.length]);
    if (out.length >= max) break;
  }
  return out;
}

// A small stable string hash (FNV-1a), for the peek's per-crate pick.
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

// The best find sits in the middle of the fan, on top.
function peekHTML(items, esc) {
  const fan = items.length === 3 ? [items[1], items[0], items[2]] : items.length === 2 ? [items[1], items[0]] : items;
  return `<span class="lc-peek">${fan.map(e => `<img class="lc-peek__item lc-rarity-${e.rarity}" src="${esc(e.img)}" alt="" loading="lazy">`).join("")}</span>`;
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

/*
  One box in the shop grid. `ctx` adds { busy, busyBox, waiting, art, esc }
  to buyReason's. While a pull is out, every Buy is off, and only the one that
  was pressed (busyBox) says "Opening…"; with no busyBox, all of them do.
  When the GM is slow to answer (`waiting`, from socket.js onWait) it says
  "Waiting for the GM…" instead, with a status line saying why when the GM's
  tab is in the background.
  The card keeps a lc-rarity-<best> class naming the best rarity it can drop;
  its colour is not painted over the card, since the ribbon shows how likely
  that is.
*/
const WAITING = {
  gm: { label: "Waiting for the GM…", why: "The GM's client hasn't rolled yet." },
  hidden: { label: "Waiting for the GM…", why: "The GM's Foundry tab is in the background, which slows it down." },
};

export function boxCard(box, pools, ctx) {
  const esc = ctx.esc ?? (s => String(s ?? ""));
  const odds = shopOdds(box, pools);
  const reason = buyReason(box, odds, ctx);
  const whyId = `lc-why-${box.id}`;
  const rarityClass = odds.top ? `lc-rarity-${odds.top}` : "lc-box--empty";
  const opening = ctx.busy && (ctx.busyBox == null || ctx.busyBox === box.id);
  const waiting = opening ? WAITING[ctx.waiting] : null;
  const peek = peekItems(box, pools, odds);
  const stock = odds.rows.length && box.rules?.stock != null ? `<div class="lc-box__stock">${esc(box.rules.stock)} left</div>` : "";
  return `
      <div class="lc-box ${rarityClass}">
        <div class="lc-box__band"><h3 class="lc-box__name">${esc(box.name)}</h3></div>
        <div class="lc-box__body">
          <div class="lc-box__art" aria-hidden="true">${peek.length ? peekHTML(peek, esc) : ctx.art ?? ""}</div>
          ${odds.rows.length ? `${oddsRibbon(odds.rows)}<div class="lc-box__odds">${oddsPills(odds.rows)}</div>` : ""}
          ${stock}
          <button type="button" class="lc-box__buy" data-action="buy" data-box="${esc(box.id)}"${reason || ctx.busy ? " disabled" : ""}${reason ? ` aria-describedby="${esc(whyId)}"` : ""}>
            ${opening ? (waiting?.label ?? "Opening…") : `Open for ${esc(formatPrice(box.price))}`}
          </button>
          ${reason ? `<div class="lc-box__why" id="${esc(whyId)}">${esc(reason)}</div>` : ""}
          ${waiting ? `<div class="lc-box__why lc-box__wait" role="status">${esc(waiting.why)}</div>` : ""}
        </div>
      </div>`;
}
