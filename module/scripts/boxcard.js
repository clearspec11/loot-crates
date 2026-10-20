/*
  The shop's box card, odds pills and odds ribbon, as HTML strings with no
  Foundry in them, so the shop, the manager, the reveal and the harness show
  one format. The caller passes its own escape function
  (foundry.utils.escapeHTML in a world).

  The card reads like a dnd5e card: the crate's name on a band, its bet as a
  ribbon (one bar of its real drop chances) over named odds, the price on the
  button. A disabled Buy says why in visible text, linked to the button with
  aria-describedby, so keyboard, screen-reader and touch users all learn it:
  a reason that is the crate's own under the card, a reason that holds for
  the whole shop once in its header.
*/
import { RARITIES, RARITY_SHORT, RARITY_LABEL } from "./config.js";
import { shopOdds, oddsTable, flattenPool, rarityRank } from "./odds.js";
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
  the buyer's. The shop and the cards split this in two: shopReason is said
  once in the shop's header, crateReason under the card it belongs to.
*/
export function buyReason(box, odds, ctx = {}) {
  return crateState(box, odds) || shopReason(ctx) || crateReason(box, odds, ctx);
}

// Why no crate can be bought at all, or "": the shop is shut, no GM is there
// to roll, or there's no character to pay. Said once, not under every card.
export function shopReason({ hasActor = false, open = true, gmOnline = true } = {}) {
  if (!open) return gmOnline ? "The GM has closed the shop." : "Closed until a GM is online.";
  if (!hasActor) return "You have no character to buy for.";
  return "";
}

// Why this crate in particular can't be bought, or "": it holds nothing, it
// sold out, or this character is short (said even while the shop is shut,
// so a player knows what to save for).
export function crateReason(box, odds, { purse = {}, hasActor = false } = {}) {
  const state = crateState(box, odds);
  if (state) return state;
  if (hasActor && !canAfford(purse, box.price)) return `Needs ${formatPrice(shortfall(purse, box.price))} more`;
  return "";
}

function crateState(box, odds) {
  if (!odds.rows.length) return "Nothing inside";
  if (box.rules?.stock != null && box.rules.stock <= 0) return "Sold out";
  return "";
}

/*
  The shop's one notice: the shop-wide reason, or while a pull is slow, that
  it is waiting for the GM and why. Its text goes in the shop header's single
  live region (SHOP_NOTICE_ID), which stays the same node across renders
  (patchShop), so a screen reader announces it when it changes. `tone` is
  "warn" for a reason nothing can be bought, "wait" for a slow GM, "" when
  there is nothing to say.
*/
export const SHOP_NOTICE_ID = "lc-shop-notice";

const WAITING = {
  gm: "Waiting for the GM: their client hasn't rolled yet.",
  hidden: "Waiting for the GM: their Foundry tab is in the background, which slows it down.",
};

export function shopNotice(ctx = {}) {
  const reason = shopReason(ctx);
  if (reason) return { text: reason, tone: "warn" };
  if (ctx.busy && WAITING[ctx.waiting]) return { text: WAITING[ctx.waiting], tone: "wait" };
  return { text: "", tone: "" };
}

/*
  One box in the shop grid. `ctx` adds { busy, busyBox, waiting, art, esc }
  to buyReason's. While a pull is out, every Buy is off, and only the one that
  was pressed (busyBox) says "Opening…"; with no busyBox, all of them do.
  When the GM is slow to answer (`waiting`, from socket.js onWait) it says
  "Waiting for the GM…" instead; why is in the shop's notice.
  A disabled Buy is described by every reason that applies: the shop's
  notice (shared, by id) and the card's own line. A shop-wide reason is never
  repeated under the cards.
  The card keeps a lc-rarity-<best> class naming the best rarity it can drop;
  its colour is not painted over the card, since the ribbon shows how likely
  that is.
*/
export function boxCard(box, pools, ctx) {
  const esc = ctx.esc ?? (s => String(s ?? ""));
  const odds = shopOdds(box, pools);
  const reason = crateReason(box, odds, ctx);
  const notice = shopNotice(ctx).text;
  const whyId = `lc-why-${box.id}`;
  const describedBy = [notice ? SHOP_NOTICE_ID : "", reason ? whyId : ""].filter(Boolean).join(" ");
  const disabled = !!(reason || notice || ctx.busy);
  const rarityClass = odds.top ? `lc-rarity-${odds.top}` : "lc-box--empty";
  const opening = ctx.busy && (ctx.busyBox == null || ctx.busyBox === box.id);
  const waiting = opening && WAITING[ctx.waiting];
  const peek = peekItems(box, pools, odds);
  const stock = odds.rows.length && box.rules?.stock != null ? `<div class="lc-box__stock">${esc(box.rules.stock)} left</div>` : "";
  return `
      <div class="lc-box ${rarityClass}">
        <div class="lc-box__band"><h3 class="lc-box__name">${esc(box.name)}</h3></div>
        <div class="lc-box__body">
          <div class="lc-box__art" aria-hidden="true">${peek.length ? peekHTML(peek, esc) : ctx.art ?? ""}</div>
          ${odds.rows.length ? `${oddsRibbon(odds.rows)}<div class="lc-box__odds">${oddsPills(odds.rows)}</div>` : ""}
          ${stock}
          <button type="button" class="lc-box__buy" data-action="buy" data-box="${esc(box.id)}"${disabled ? " disabled" : ""}${disabled && describedBy ? ` aria-describedby="${esc(describedBy)}"` : ""}>
            ${opening ? (waiting ? "Waiting for the GM…" : "Opening…") : `Open for ${esc(formatPrice(box.price))}`}
          </button>
          ${reason ? `<div class="lc-box__why" id="${esc(whyId)}">${esc(reason)}</div>` : ""}
        </div>
      </div>`;
}

/*
  The shop window's head, notice and grid. The notice is a role=status live
  region: patchShop keeps it as one node for the window's life, so it is
  announced when its text changes, rather than being recreated each render
  already holding its text (which screen readers often don't announce).
  `fields` is the head's picker and purse, `cards` the grid's markup.
*/
export function shopHTML({ fields, cards, notice }) {
  return `
      <div class="lc-shop__head">
        <div class="lc-shop__fields">${fields}</div>
        <p class="lc-shop__notice" id="${SHOP_NOTICE_ID}" role="status" data-tone="${notice.tone}"></p>
      </div>
      <div class="lc-shop__grid">${cards}</div>`;
}

/*
  Puts a freshly rendered shop body (`fresh`, an element holding shopHTML
  with its notice text in `notice`) into `content`. The first time it moves
  the whole body in; after that it swaps the fields and the grid and only
  rewrites the existing notice's text, so the live region node survives.
  Returns the notice element.
*/
export function patchShop(content, fresh, notice) {
  const live = content.querySelector(`.lc-shop__notice`);
  if (!live) {
    const node = fresh.querySelector(".lc-shop__notice");
    content.replaceChildren(fresh);
    // Set after insertion, so even the first message is a change.
    node.textContent = notice.text;
    return node;
  }
  const body = live.closest(".lc-shop__body");
  body.className = fresh.className;
  body.querySelector(".lc-shop__fields").replaceWith(fresh.querySelector(".lc-shop__fields"));
  body.querySelector(".lc-shop__grid").replaceWith(fresh.querySelector(".lc-shop__grid"));
  if (live.textContent !== notice.text) live.textContent = notice.text;
  live.dataset.tone = notice.tone;
  return live;
}

/*
  The box editor's draft: the box as Save would store it from the form's
  current values, so the editor can show its odds before saving. `values` is
  what the form reads (`pool.<id>` ticked, `share.<id>`, `w.<rarity>`), and
  `poolIds` the pools the form offers, in its order. Shares and weights are
  whole-or-not numbers, 0 or more; a blank or nonsense field is 0, as Save
  has always read it.
*/
export function draftBox(box, values, poolIds) {
  const num = v => Math.max(0, Number(v) || 0);
  return {
    ...box,
    pools: poolIds.filter(id => values[`pool.${id}`] === true || values[`pool.${id}`] === "on").map(id => ({ id, share: num(values[`share.${id}`]) })),
    weights: Object.fromEntries(RARITIES.map(r => [r, num(values[`w.${r}`])])),
  };
}

/*
  What the box editor shows under the weights: the shop's own ribbon and
  pills for `box` (a draft), so the GM sees exactly what a player will, plus
  a line when the box would drop nothing or when every rarity it holds
  weighs 0 (draw() then treats them as equal, and so do the pills). `held`
  is the rarities its ticked pools can drop, so each weight can say when it
  has nothing to act on.
*/
export function boxPreview(box, pools) {
  const odds = shopOdds(box, pools);
  const held = new Set();
  for (const ref of box.pools ?? []) for (const e of flattenPool(ref.id, pools)) held.add(e.rarity);
  let note = "";
  if (!box.pools?.length) note = "This box can drop nothing: tick a pool above.";
  else if (!odds.rows.length) note = "This box can drop nothing: its pools have no item that can drop.";
  else if (oddsTable(box, pools).every(row => row.chance === 0)) note = "Every rarity these pools hold weighs 0, so each is equally likely.";
  return { odds, held, note, empty: !odds.rows.length };
}

export function boxPreviewHTML(preview, esc = s => String(s ?? "")) {
  const { odds, note, empty } = preview;
  return `${odds.rows.length ? `${oddsRibbon(odds.rows)}<div class="lc-odds">${oddsPills(odds.rows)}</div>` : ""}${note ? `<p class="lc-form__hint${empty ? " lc-form__hint--warn" : ""}">${esc(note)}</p>` : ""}`;
}

/*
  The box editor's preview in one line for a screen reader: "Uncommon 75%,
  Rare 25%", plus the note when there is one. The ribbon and pills stay
  silent; this is what the editor announces.
*/
export function oddsSummary(preview) {
  const odds = preview.odds.rows.map(row => `${RARITY_LABEL[row.rarity] ?? row.rarity} ${row.label}`).join(", ");
  return [odds, preview.note].filter(Boolean).join(odds && preview.note ? ". " : "");
}

export const ANNOUNCE_DELAY_MS = 600;

/*
  Says `text` through `say` once typing pauses for `ms`, and only when it
  differs from the last thing said: a GM typing "125" into a weight hears the
  odds once, for 125, not for 1, 12 and 125. `last` is what the region
  already holds (the dialog's opening odds go unsaid).
*/
export function quietAnnouncer(say, { ms = ANNOUNCE_DELAY_MS, last = "", timers = globalThis } = {}) {
  let timer = null;
  return text => {
    timers.clearTimeout(timer);
    timer = timers.setTimeout(() => {
      timer = null;
      if (text === last) return;
      last = text;
      say(text);
    }, ms);
  };
}
