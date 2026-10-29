/*
  The shop's box card, odds pills and odds ribbon, as HTML strings with no
  Foundry in them, so the shop, the manager, the reveal and the harness show
  one format. The caller passes its own escape function
  (foundry.utils.escapeHTML in a world).

  The card reads like a dnd5e card: the crate's name on a band, its bet as a
  ribbon (one bar of its real drop chances) over named odds, the price on the
  button. An unbuyable Buy says why in visible text, linked to the button with
  aria-describedby, so keyboard, screen-reader and touch users all learn it:
  a reason that is the crate's own under the card, a reason that holds for
  the whole shop once in its header.
*/
import { RARITIES, RARITY_SHORT, RARITY_LABEL } from "../core/config.js";
import { shopOdds, oddsTable, flattenPool, rarityRank, chanceLabel, missChanceOf, oddsModeOf } from "../core/odds.js";
import { canAfford, formatPrice, shortfall } from "../core/currency.js";
import { stockOf, stockText, limitState, limitLine, withLimit } from "../core/limits.js";
import { onShelf, offShelfReason } from "../core/shelf.js";
import { t, words } from "../core/i18n.js";
import { ticketable } from "../games/ticket.js";

// What an odds row is called: its rarity, or "Nothing" for a crate's miss.
const rowName = (row, names = RARITY_SHORT) => (row.rarity === "none" ? t("LOOTCRATES.Odds.Nothing") : names[row.rarity] ?? row.rarity);

// "Rare 12%": the rarity's name is on screen, not only its colour.
export function oddPill(row) {
  return `<span class="lc-odd lc-rarity-${row.rarity}">${rowName(row)} ${row.label}</span>`;
}

export function oddsPills(rows) {
  return rows.map(oddPill).join("");
}

// A box's odds rows and, when it can find nothing, a "Nothing" row after
// them: what the pills and the ribbon show.
export const oddsRows = odds => (odds?.nothing ? [...odds.rows, { rarity: "none", chance: odds.nothing.chance, label: odds.nothing.label }] : odds?.rows ?? []);

/*
  A crate that draws by the table's odds (odds.js oddsModeOf "weight")
  names its items with their real chances: best finds first, up to `max`
  of them, then "and N more" with what those add up to, then "Nothing"
  when it can find nothing. Every chance under 1% reads "<1%", never "0%".
  A list one longer than `max` shows in full rather than "and 1 more".
*/
export const CARD_CHANCES = 4;
export function chanceLines(odds, max = CARD_CHANCES) {
  const items = odds?.items ?? [];
  const shown = items.length > max + 1 ? items.slice(0, max) : items;
  const rest = items.slice(shown.length);
  const lines = shown.map(it => ({ name: it.name, rarity: it.rarity, label: it.label }));
  if (rest.length) {
    const chance = rest.reduce((n, it) => n + it.chance, 0);
    const pct = rest.reduce((n, it) => n + (it.pct ?? 0), 0);
    lines.push({ name: t("LOOTCRATES.Card.AndMore", { count: rest.length }), rarity: "rest", label: chanceLabel(chance, pct), rest: true });
  }
  if (odds?.nothing) lines.push({ name: t("LOOTCRATES.Odds.Nothing"), rarity: "none", label: odds.nothing.label });
  return lines;
}

// The name and the chance are two spans; a screen reader hears "Flame
// Tongue: <1%" (the shop's morph drops the whitespace between elements).
export function chanceLinesHTML(odds, { max = CARD_CHANCES, esc = s => String(s ?? "") } = {}) {
  const lines = chanceLines(odds, max);
  if (!lines.length) return "";
  return `<ul class="lc-chances">${lines.map(l => `<li class="lc-chance lc-rarity-${esc(l.rarity)}${l.rest ? " lc-chance--rest" : ""}"><span class="lc-chance__name">${esc(l.name)}</span><span class="lc-sr-only">: </span><span class="lc-chance__pct">${esc(l.label)}</span></li>`).join("")}</ul>`;
}

// The same in words, for a screen reader's one line: "Dragon Scale 1%, ...".
export const chanceText = (odds, max = CARD_CHANCES) => chanceLines(odds, max).map(l => `${l.name} ${l.label}`).join(", ");

/*
  The bet at a glance: one bar split by each rarity's real chance, in the
  rarity's colour. Decorative to assistive tech (the pills carry the words),
  but titled for a mouse. A sliver under 1% keeps a visible minimum width.
*/
export function oddsRibbon(rows) {
  if (!rows?.length) return "";
  const segs = rows.map(row => {
    const share = Math.max(0, Number(row.chance) || 0);
    return `<span class="lc-ribbon__seg lc-rarity-${row.rarity}" style="flex-grow:${+share.toFixed(4)}" title="${rowName(row, RARITY_LABEL)} ${row.label}"></span>`;
  }).join("");
  return `<div class="lc-ribbon" aria-hidden="true">${segs}</div>`;
}

/*
  A peek inside: up to three real items this box can drop, one from each of
  its best droppable rarities (highest first), so each crate looks like what
  it holds rather than like every other crate. Only entries with art and a
  chance above 0 count; with none, the caller's icon stands in.
*/
export function peekItems(box, pools, odds = shopOdds(box, pools), max = 3, state = {}) {
  const droppable = new Set(odds.rows.map(row => row.rarity));
  // What this buyer already owns can't drop for them under noDuplicates.
  const owned = new Set(box.rules?.noDuplicates ? state.owned ?? [] : []);
  const entries = (box.pools ?? []).flatMap(ref => flattenPool(ref.id, pools))
    .filter(e => e.img && droppable.has(e.rarity) && (e.weight ?? 1) > 0 && !owned.has(e.uuid));
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
  { purse, hasActor, actorName, open, gmOnline }. `odds` is shopOdds for the
  buyer's state. The box's own state comes first (an empty or sold-out box
  stays unbuyable whoever asks), then the shop's, then the buyer's. The
  shop and the cards split this in two: shopReason is said once in the
  shop's header, crateReason under the card it belongs to.
*/
export function buyReason(box, odds, ctx = {}) {
  return crateState(box, odds, ctx) || shopReason(ctx) || crateReason(box, odds, ctx);
}

/*
  Which character the shop buys for, picked again on every render and Buy:
  ownership changes while the shop is open (the GM takes a character away,
  gives one, assigns the player's own), and a pick made once at open sent
  pulls the GM refused ("You don't own that character."). `actors` are the
  characters the player owns now (shop.js buyableActors); `storedId` is the
  one the shop had, kept while it is still among them; else the user's own
  character (an actor or its id) if owned, else the first owned, else null.
*/
export function pickActor(storedId, actors = [], mainCharacter = null) {
  const owned = id => id != null && actors.some(a => a.id === id);
  if (owned(storedId)) return storedId;
  const main = typeof mainCharacter === "string" ? mainCharacter : mainCharacter?.id;
  if (owned(main)) return main;
  return actors[0]?.id ?? null;
}

// Why no crate can be bought at all, or "": the shop is shut, no GM is there
// to roll, or there's no character to pay. Said once, not under every card.
export function shopReason({ hasActor = false, open = true, gmOnline = true } = {}) {
  if (!open) return gmOnline ? t("LOOTCRATES.Shop.ClosedByGM") : t("LOOTCRATES.Shop.ClosedNoGM");
  if (!hasActor) return t("LOOTCRATES.Shop.NoCharacter");
  return "";
}

// Why this crate in particular can't be bought, or "": it holds nothing, it
// sold out, it has nothing this character doesn't own yet (noDuplicates), or
// this character is short (said even while the shop is shut, so a player
// knows what to save for).
export function crateReason(box, odds, ctx = {}) {
  return crateState(box, odds, ctx) || shortReason(box, ctx);
}

// "Needs 3 gp more": this character is short of the price, said even while
// the shop is shut, so a player knows what to save for. Every kind's last word.
export function shortReason(game, { purse = {}, hasActor = false } = {}) {
  if (hasActor && !canAfford(purse, game.price)) return t("LOOTCRATES.Card.Needs", { price: formatPrice(shortfall(purse, game.price)) });
  return "";
}

// A crate that can't give this character anything new can't be bought,
// rather than failing after a round trip to the GM (pull.js "nothing left").
// Nor can one whose last pull is still spinning on this client (`held`,
// reveal.js heldState): its card shows the odds from before that pull, to
// keep the result secret, and the GM would roll a second pull at the new
// ones ("guaranteed this pull" after the pity was spent on the spin).
function crateState(box, odds, { actorName = "", held } = {}) {
  if (held?.(box.id)) return t("LOOTCRATES.Card.StillSpinning");
  if (!odds.rows.length && !odds.nothingNew) return t("LOOTCRATES.Card.NothingInside");
  if (box.rules?.stock != null && box.rules.stock <= 0) return t("LOOTCRATES.Card.SoldOut");
  if (odds.nothingNew) return actorName ? t("LOOTCRATES.Card.NothingNewFor", { name: actorName }) : t("LOOTCRATES.Card.NothingNew");
  return "";
}

/*
  The pity rule as this buyer stands with it, under the odds: "Rare or
  better guaranteed this pull" once it is due (the odds above then show only
  those rarities), else "Rare or better within 4 pulls". "" when the box
  has no pity this buyer can reach.
*/
const PITY_LINE = {
  pulls: { due: "LOOTCRATES.Pity.DuePull", within: "LOOTCRATES.Pity.WithinPulls" },
  throws: { due: "LOOTCRATES.Pity.DueThrow", within: "LOOTCRATES.Pity.WithinThrows" },
};
export function pityLine(odds, noun = "pulls") {
  const pity = odds?.pity;
  if (!pity) return "";
  const keys = PITY_LINE[noun] ?? PITY_LINE.pulls;
  return t(pity.due ? keys.due : keys.within, { rarity: RARITY_LABEL[pity.minRarity] ?? pity.minRarity, left: pity.left });
}

/*
  For the refund dialog, what the refund does to the buyer's rules for the
  box (before/after are their state, odds.js undoPull): "Brannoc's pity
  count goes back to 2 of 3 pulls, and Cloak of Elvenkind can drop for
  Brannoc again." Each half only when the box has that rule, and the item
  half only when it really leaves the no-duplicates record. "" when neither.
*/
export function refundRulesLine({ actorName, itemName, box, before = {}, after = {} }) {
  const pity = box?.rules?.pity;
  const parts = [];
  if (pity?.after && pity.minRarity) {
    const from = Math.min(before.sinceRare ?? 0, pity.after), to = Math.min(after.sinceRare ?? 0, pity.after);
    const count = t(to === from ? "LOOTCRATES.Refund.PityStays" : "LOOTCRATES.Refund.PityBack", { name: actorName, to, after: pity.after });
    parts.push(to >= pity.after ? t("LOOTCRATES.Refund.PityDue", { count, rarity: RARITY_LABEL[pity.minRarity] ?? pity.minRarity }) : count);
  }
  const freed = box?.rules?.noDuplicates && (before.owned ?? []).length > (after.owned ?? []).length;
  if (freed) parts.push(t("LOOTCRATES.Refund.Freed", { item: itemName, name: actorName }));
  if (!parts.length) return "";
  const line = parts.length > 1 ? t("LOOTCRATES.Refund.RulesBoth", { pity: parts[0], item: parts[1] }) : parts[0];
  return t("LOOTCRATES.Common.Sentence", { text: `${line[0].toUpperCase()}${line.slice(1)}` });
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

const WAITING = words({
  gm: "LOOTCRATES.Shop.WaitingGM",
  hidden: "LOOTCRATES.Shop.WaitingHidden",
});

export function shopNotice(ctx = {}) {
  const reason = shopReason(ctx);
  if (reason) return { text: reason, tone: "warn" };
  if (ctx.busy && WAITING[ctx.waiting]) return { text: WAITING[ctx.waiting], tone: "wait" };
  return { text: "", tone: "" };
}

/*
  What the shop's notice says when a Buy that looked live did nothing, or ""
  when the shop has nothing to add. The redraw that follows can come ~100 ms
  later and, for a press, said nothing: the cards were drawn a moment before
  the data changed. `box` is the crate as it stands now (undefined once the
  GM took it off the shelf), `reason` its fresh crateReason, `shown` the
  price on the pressed Buy (its data-price), `price` what a play costs this
  character now: the kind's (a deck's risen draw, kinds.js priceOf), the
  one the GM checks, else the record's. A price that changed to one past
  this character's purse is named with the new figure and the pressed one,
  in the sentence the GM refuses a stale price with (pull.js, the shop's
  #staleRefusal), so a changed price reads the same whether or not the
  purse still covers it; the card says what is short. A shop-wide reason
  is the notice's own, so the caller leaves those out.
*/
export function refusalLine({ box, reason = "", shown, price = box?.price, purse = {} }) {
  if (!box) return t("LOOTCRATES.Shop.GoneFromShelf");
  const raised = shown != null && shown !== "" && Number(shown) !== Number(price);
  if (raised && !canAfford(purse, price)) return t("LOOTCRATES.Error.PriceChanged", { name: box.name, price: formatPrice(price), pressed: formatPrice(Number(shown)) });
  if (!reason) return "";
  return t("LOOTCRATES.Shop.CouldNotOpen", { name: box.name, reason: `${reason[0].toLowerCase()}${reason.slice(1)}` });
}

// The shop re-picked its character (pickActor) between the redraw and the
// press: the cards were someone else's, so nothing was sent.
export function changedCharacterLine(name) {
  return t("LOOTCRATES.Shop.CharacterChanged", { name });
}

/*
  The shop head's character field. With more than one character it is a
  <select>; while a pull is out (`busy`) that select is aria-disabled, not
  disabled, so one a keyboard user has focused keeps focus, and the shop
  ignores changes to it (shop.js #choose): the pull charges the character it
  was sent for, so the shown character and purse stay that one until it
  settles. `actors` are { id, name }.
*/
export function actorPicker({ actors = [], actorId = null, busy = false, esc = s => String(s ?? "") }) {
  if (actors.length > 1) {
    const options = actors.map(a => `<option value="${esc(a.id)}"${a.id === actorId ? " selected" : ""}>${esc(a.name)}</option>`).join("");
    return `<label class="lc-shop__field"><span class="lc-label">${t("LOOTCRATES.Shop.Character")}</span><select class="lc-shop__actor"${busy ? ` aria-disabled="true"` : ""}>${options}</select></label>`;
  }
  // Focusable as a target only (tabindex -1), for focus on a select that
  // gives way to it (patchShop); morph keeps the attribute on later renders.
  const name = actors.find(a => a.id === actorId)?.name ?? t("LOOTCRATES.Shop.NoCharacterName");
  return `<div class="lc-shop__field"><span class="lc-label">${t("LOOTCRATES.Shop.Character")}</span><span class="lc-shop__who" tabindex="-1">${esc(name)}</span></div>`;
}

/*
  One box in the shop grid. `ctx` adds { busy, busyBox, waiting, art, esc,
  stateOf } to buyReason's (which also takes held(boxId), see crateState);
  stateOf(boxId) is the buyer's pity and ownership state for that box
  (store.js getActorState), so the odds, the pity line and "Nothing new"
  are this character's, as draw() will roll them. While a pull is out, every Buy is off, and only the one that was
  pressed (busyBox) says "Opening…"; with no busyBox, all of them do.
  When the GM is slow to answer (`waiting`, from socket.js onWait) it says
  "Waiting for the GM…" instead; why is in the shop's notice.
  An unbuyable Buy is aria-disabled, never `disabled`: a disabled button
  can't hold focus, so the Buy a keyboard user just pressed would drop them
  on the page's body the moment it said "Opening…". It stays focusable and
  says it is off; the shop's action checks again before buying (shop.js).
  It is described by every reason that applies: the shop's notice (shared,
  by id) and the card's own line. A shop-wide reason is never repeated under
  the cards. The card carries data-box, so patchShop can find it again.
  Every Buy starts with the crate's name, for screen readers only (a list of
  buttons read out of context said "Open for 25 gp" twice for two crates at
  one price); the visible label follows it, so the label a sighted user
  says is still part of the button's name (WCAG 2.5.3), in every state.
  The card keeps a lc-rarity-<best> class naming the best rarity it can drop;
  its colour is not painted over the card, since the ribbon shows how likely
  that is.
*/
export function boxCard(box, pools, ctx) {
  const esc = ctx.esc ?? (s => String(s ?? ""));
  const state = ctx.stateOf?.(box.id) ?? {};
  const odds = shopOdds(box, pools, state);
  const reason = crateReason(box, odds, ctx);
  const rarityClass = odds.top ? `lc-rarity-${odds.top}` : "lc-box--empty";
  const peek = peekItems(box, pools, odds, 3, state);
  const stock = odds.rows.length && stockOf(box) ? `<div class="lc-box__stock">${esc(stockText(box))}</div>` : "";
  const pity = pityLine(odds);
  // A crate on the table's odds names its items; one on rarity odds shows
  // the rarities. Either way the ribbon is the rarities, and a crate that
  // can find nothing says how often.
  const named = odds.mode === "weight" && odds.rows.length;
  const middle = [
    odds.rows.length ? `${oddsRibbon(oddsRows(odds))}${named ? chanceLinesHTML(odds, { esc }) : `<div class="lc-box__odds">${oddsPills(oddsRows(odds))}</div>`}` : "",
    pity ? `<div class="lc-box__pity lc-rarity-${odds.pity.minRarity}${odds.pity.due ? " lc-box__pity--due" : ""}">${esc(pity)}</div>` : "",
    stock,
  ];
  return cardShell(box, ctx, { rarityClass, art: peek.length ? peekHTML(peek, esc) : ctx.art ?? "", middle, reason, label: t("LOOTCRATES.Card.OpenFor", { price: esc(formatPrice(box.price)) }) });
}

/*
  The card every kind of game shares: the band with the name, the art, the
  kind's own lines (`middle`: odds, pity, stock, whatever it says), the one
  Buy with its price (`label`) and the reason it is off. `reason` is the
  game's own (the crate's crateReason, the well's); the shop-wide reason and
  "Opening…" are handled here for all of them, with the rules above (data-box,
  data-price, aria-disabled, aria-describedby, the screen-reader name).
  `price` is what this Buy charges when it isn't the record's (the deck's
  rising draw price): it goes on the Buy as data-price, which the pull
  carries and the GM checks (pull.js expectedPrice). The limit per
  character (limits.js) is added here for every kind, from ctx's log,
  actorId, actorName and today. A game off the shelf (shelf.js) reaches
  only the GM's shop, where its card says so over every other reason: the
  GM refuses a pull on it from anyone, the GM included.

  Every game a player pulls (games/ticket.js ticketable: not a table game)
  has a second, quieter button under the Buy: Buy to keep (data-action
  "keep"), at the same price and off for the same reasons, described by the
  same lines, which puts a ticket in the character's pack instead of
  playing now (shop.js, socket.js doKeep). Its name starts with the game's
  and ends with the price and what it does, for screen readers only; the
  visible words stay "Buy to keep". While one is out (`ctx.busyKeep`) the
  pressed card's keep button says "Buying…" and its Buy keeps its label.
  It names its game in data-keep, not data-box: patchShop's morph pairs
  nodes by data-box, and two buttons with one key in a card would swap.
*/
export function cardShell(box, ctx, { rarityClass, art = "", middle: lines = [], reason: own = "", label, price: cost = box.price }) {
  const esc = ctx.esc ?? (s => String(s ?? ""));
  // The limit per character is the core's (limits.js), for every kind:
  // "You can buy 1 more" while there is some left, and once it is reached
  // the card's reason, whatever the kind said.
  const limit = limitState(box, ctx);
  const more = limitLine(limit);
  const reason = onShelf(box) ? withLimit(box, own, ctx) : offShelfReason();
  const middle = more ? [...lines, `<div class="lc-box__limit">${esc(more)}</div>`] : lines;
  const notice = shopNotice(ctx).text;
  const whyId = `lc-why-${box.id}`;
  const describedBy = [notice ? SHOP_NOTICE_ID : "", reason ? whyId : ""].filter(Boolean).join(" ");
  const off = !!(reason || notice || ctx.busy);
  const pressed = ctx.busy && (ctx.busyBox == null || ctx.busyBox === box.id);
  const opening = pressed && !ctx.busyKeep;
  const keeping = pressed && !!ctx.busyKeep;
  const waiting = pressed && WAITING[ctx.waiting];
  // The price this Buy says, which the shop sends with the pull (shop.js #buy).
  const price = Number.isFinite(Number(cost)) && cost !== "" && cost != null ? String(Number(cost)) : "";
  return `
      <div class="lc-box ${rarityClass}" data-box="${esc(box.id)}">
        <div class="lc-box__band"><h3 class="lc-box__name">${esc(box.name)}</h3></div>
        <div class="lc-box__body">
          <div class="lc-box__art" aria-hidden="true">${art}</div>
          ${middle.join("\n          ")}
          <button type="button" class="lc-box__buy" data-action="buy" data-box="${esc(box.id)}"${price ? ` data-price="${esc(price)}"` : ""}${off ? ` aria-disabled="true"` : ""}${off && describedBy ? ` aria-describedby="${esc(describedBy)}"` : ""}>
            <span class="lc-sr-only">${esc(box.name)}: </span>${opening ? (waiting ? t("LOOTCRATES.Card.Waiting") : t("LOOTCRATES.Card.Opening")) : label}
          </button>
          ${ticketable(box) ? `<button type="button" class="lc-box__keep" data-action="keep" data-keep="${esc(box.id)}"${price ? ` data-price="${esc(price)}"` : ""}${off ? ` aria-disabled="true"` : ""}${off && describedBy ? ` aria-describedby="${esc(describedBy)}"` : ""}>
            <span class="lc-sr-only">${esc(box.name)}: </span>${keeping ? (waiting ? t("LOOTCRATES.Card.Waiting") : t("LOOTCRATES.Card.Keeping")) : `${t("LOOTCRATES.Card.Keep")}<span class="lc-sr-only">${t("LOOTCRATES.Card.KeepHint", { price: esc(formatPrice(cost)) })}</span>`}
          </button>` : ""}
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
  the whole body in; after that it morphs the fields and the grid into the
  fresh ones (morph), so every node that is still wanted stays the same node:
  the Buy a keyboard user pressed keeps focus through "Opening…", the GM's
  charge and back, and the character <select> through a pick. The notice
  only has its text rewritten, so the live region node survives.
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
  if (body.className !== fresh.className) body.className = fresh.className;
  const doc = content.ownerDocument;
  // The character select gives way to a plain name when the player is down
  // to one character (the GM took one away, even mid-pull): focus on it
  // goes to that name rather than to the page's body.
  const head = body.querySelector(".lc-shop__fields");
  const inHead = !!(doc?.activeElement && head.contains(doc.activeElement));
  morph(head, fresh.querySelector(".lc-shop__fields"));
  if (inHead && !content.contains(doc.activeElement)) {
    const who = body.querySelector(".lc-shop__actor") ?? body.querySelector(".lc-shop__who") ?? live;
    if (!who.matches("select") && !who.hasAttribute("tabindex")) who.setAttribute("tabindex", "-1");
    who.focus();
  }
  const grid = body.querySelector(".lc-shop__grid");
  // The crates after the focused one, then those before it, nearest first:
  // where focus goes if its crate is taken off the shelf (keepFocus).
  const focused = doc?.activeElement && grid.contains(doc.activeElement) ? doc.activeElement : null;
  const cards = [...grid.children].filter(c => c.getAttribute("data-box") != null);
  const at = focused ? cards.findIndex(c => c.contains(focused)) : -1;
  const near = at < 0 ? [] : [...cards.slice(at + 1), ...cards.slice(0, at).reverse()];
  const kept = morph(grid, fresh.querySelector(".lc-shop__grid"));
  if (live.textContent !== notice.text) live.textContent = notice.text;
  live.dataset.tone = notice.tone;
  if (focused && !content.contains(doc.activeElement)) keepFocus(kept, near, live);
  return live;
}

/*
  A crate the GM deletes (or a grid rebuilt) while a player's focus is in it
  takes the focus with it, which drops a keyboard or screen-reader user on
  the page's body. Focus goes to the nearest crate still on the shelf (the
  next one, else the one before), else to the empty shelf's line, else to
  the shop's notice; a line that isn't a control is focused as a target
  only (tabindex -1).
*/
function keepFocus(grid, near, live) {
  const card = near.find(c => c.parentNode === grid);
  const target = card?.querySelector(".lc-box__buy") ?? grid.querySelector(".lc-shop__empty") ?? live;
  if (!target.matches("button, select, input, a[href]") && !target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus();
}

/*
  Makes `old` (in the page) look like `fresh` (detached) while keeping every
  node that can be kept, and returns the node that ends up in the page.
  Elements match by tag and key (data-box, else id): a crate is the same
  card however the grid around it changes. A match has its attributes and
  text brought up to date in place; a node is moved only when the order
  really changed, added only when new and removed only when gone, since
  moving or removing a focused node drops its focus. A <select> keeps its
  node and takes the fresh one's value. Plain DOM, no Foundry.
*/
const ELEMENT = 1;
const keyOf = node => node.nodeType === ELEMENT ? node.getAttribute("data-box") ?? node.getAttribute("id") ?? null : null;
const sameKind = (a, b) => a.nodeType === b.nodeType && a.nodeName === b.nodeName && keyOf(a) === keyOf(b);

export function morph(old, fresh) {
  if (!sameKind(old, fresh)) {
    old.replaceWith(fresh);
    return fresh;
  }
  if (old.nodeType !== ELEMENT) {
    if (old.nodeValue !== fresh.nodeValue) old.nodeValue = fresh.nodeValue;
    return old;
  }
  for (const name of old.getAttributeNames()) if (!fresh.hasAttribute(name)) old.removeAttribute(name);
  for (const name of fresh.getAttributeNames()) {
    const value = fresh.getAttribute(name);
    if (old.getAttribute(name) !== value) old.setAttribute(name, value);
  }
  morphChildren(old, fresh);
  if (old.nodeName === "SELECT" && old.value !== fresh.value) old.value = fresh.value;
  return old;
}

// Whitespace between elements is the markup's indentation (every container
// here is a flex or grid box, where it draws nothing). It is dropped rather
// than paired by position, since pairing it would move the cards between it.
const blank = node => node.nodeType === 3 && !node.nodeValue.trim();

function morphChildren(parent, freshParent) {
  const olds = [...parent.childNodes].filter(n => !blank(n) || n.remove());
  const keyed = new Map(olds.filter(n => keyOf(n) != null).map(n => [keyOf(n), n]));
  const loose = olds.filter(n => keyOf(n) == null);
  const used = new Set();
  // Pair each fresh child with an old one first, so nothing is moved or
  // dropped on a guess.
  const pairs = [...freshParent.childNodes].filter(n => !blank(n)).map(fresh => {
    const key = keyOf(fresh);
    let match = key != null ? keyed.get(key) : loose.find(n => !used.has(n) && sameKind(n, fresh));
    if (match && (used.has(match) || !sameKind(match, fresh))) match = null;
    if (match) used.add(match);
    return [match, fresh];
  });
  for (const node of olds) if (!used.has(node)) node.remove();
  pairs.forEach(([match, fresh], i) => {
    const at = parent.childNodes[i] ?? null;
    const node = match ?? fresh;
    if (node !== at) parent.insertBefore(node, at);
    if (match) morph(match, fresh);
  });
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
  const out = {
    ...box,
    pools: poolIds.filter(id => values[`pool.${id}`] === true || values[`pool.${id}`] === "on").map(id => ({ id, share: num(values[`share.${id}`]) })),
    weights: Object.fromEntries(RARITIES.map(r => [r, num(values[`w.${r}`])])),
  };
  // The crate editor's odds choice and "Count text results as nothing"
  // (editorfields.js oddsModeFieldset, nothingRow); other editors have neither.
  if ("oddsMode" in values || "countNothing" in values) out.rules = oddsRules(box.rules ?? {}, values, box.fromTable);
  return out;
}

/*
  The crate's odds rules from its editor: rules.oddsMode "weight" for the
  table's odds (rarity, the default, is stored as no oddsMode at all), and
  rules.missChance, the table's text results' share of pulls, while "Count
  text results as nothing" is ticked. Other rules are kept as they are.
*/
export function oddsRules(rules, values, fromTable) {
  const out = { ...rules };
  if ("oddsMode" in values) {
    if (values.oddsMode === "weight") out.oddsMode = "weight";
    else delete out.oddsMode;
  }
  if ("countNothing" in values) {
    const chance = missChanceOf({ rules: { missChance: fromTable?.textChance } });
    if (values.countNothing === true && chance > 0) out.missChance = chance;
    else delete out.missChance;
  }
  return out;
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
  if (!box.pools?.length) note = t("LOOTCRATES.Editor.DropsNothingTick");
  else if (!odds.rows.length) note = t("LOOTCRATES.Editor.DropsNothingPools");
  else if (oddsModeOf(box) === "rarity" && oddsTable(box, pools).every(row => row.chance === 0)) note = t("LOOTCRATES.Editor.AllWeighZero");
  return { odds, held, note, empty: !odds.rows.length };
}

// The editor names more of a table crate's items than a shop card does.
export const PREVIEW_CHANCES = 8;

export function boxPreviewHTML(preview, esc = s => String(s ?? "")) {
  const { odds, note, empty } = preview;
  const named = odds.mode === "weight";
  const lines = named ? chanceLinesHTML(odds, { max: PREVIEW_CHANCES, esc }) : `<div class="lc-odds">${oddsPills(oddsRows(odds))}</div>`;
  return `${odds.rows.length ? `${oddsRibbon(oddsRows(odds))}${lines}` : ""}${note ? `<p class="lc-form__hint${empty ? " lc-form__hint--warn" : ""}">${esc(note)}</p>` : ""}`;
}

/*
  The box editor's preview in one line for a screen reader: "Uncommon 75%,
  Rare 25%", plus the note when there is one. The ribbon and pills stay
  silent; this is what the editor announces.
*/
export function oddsSummary(preview) {
  const odds = preview.odds.mode === "weight" ? chanceText(preview.odds, PREVIEW_CHANCES) : oddsRows(preview.odds).map(row => `${rowName(row, RARITY_LABEL)} ${row.label}`).join(", ");
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
