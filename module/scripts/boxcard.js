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
  if (!open) return gmOnline ? "The GM has closed the shop." : "Closed until a GM is online.";
  if (!hasActor) return "You have no character to buy for.";
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
  if (hasActor && !canAfford(purse, game.price)) return `Needs ${formatPrice(shortfall(purse, game.price))} more`;
  return "";
}

// A crate that can't give this character anything new can't be bought,
// rather than failing after a round trip to the GM (pull.js "nothing left").
// Nor can one whose last pull is still spinning on this client (`held`,
// reveal.js heldState): its card shows the odds from before that pull, to
// keep the result secret, and the GM would roll a second pull at the new
// ones ("guaranteed this pull" after the pity was spent on the spin).
function crateState(box, odds, { actorName = "", held } = {}) {
  if (held?.(box.id)) return "Still spinning";
  if (!odds.rows.length && !odds.nothingNew) return "Nothing inside";
  if (box.rules?.stock != null && box.rules.stock <= 0) return "Sold out";
  if (odds.nothingNew) return actorName ? `Nothing new for ${actorName}` : "Nothing new for this character";
  return "";
}

/*
  The pity rule as this buyer stands with it, under the odds: "Rare or
  better guaranteed this pull" once it is due (the odds above then show only
  those rarities), else "Rare or better within 4 pulls". "" when the box
  has no pity this buyer can reach.
*/
export function pityLine(odds, noun = "pulls") {
  const pity = odds?.pity;
  if (!pity) return "";
  const what = `${RARITY_LABEL[pity.minRarity] ?? pity.minRarity} or better`;
  const one = noun.replace(/s$/, "");
  return pity.due ? `${what} guaranteed this ${one}` : `${what} within ${pity.left} ${noun}`;
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
    const due = to >= pity.after ? ` (${RARITY_LABEL[pity.minRarity] ?? pity.minRarity} or better is due on the next pull)` : "";
    parts.push(`${actorName}'s pity count ${to === from ? "stays at" : "goes back to"} ${to} of ${pity.after} pulls${due}`);
  }
  const freed = box?.rules?.noDuplicates && (before.owned ?? []).length > (after.owned ?? []).length;
  if (freed) parts.push(`${itemName} can drop for ${actorName} again`);
  if (!parts.length) return "";
  const line = parts.join(", and ");
  return `${line[0].toUpperCase()}${line.slice(1)}.`;
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
  What the shop's notice says when a Buy that looked live did nothing, or ""
  when the shop has nothing to add. The redraw that follows can come ~100 ms
  later and, for a press, said nothing: the cards were drawn a moment before
  the data changed. `box` is the crate as it stands now (undefined once the
  GM took it off the shelf), `reason` its fresh crateReason, `shown` the
  price on the pressed Buy (its data-price). A price the GM changed to one
  past this character's purse is named with the new figure, since the card
  the player pressed still says the old one. A shop-wide reason is the notice's own, so
  the caller leaves those out.
*/
export function refusalLine({ box, reason = "", shown, purse = {}, actorName = "" }) {
  if (!box) return "That crate is no longer on the shelf.";
  const who = actorName || "this character";
  const raised = shown != null && shown !== "" && Number(shown) !== Number(box.price);
  if (raised && !canAfford(purse, box.price)) return `${box.name} now costs ${formatPrice(box.price)}, more than ${who} has.`;
  if (!reason) return "";
  return `Couldn't open ${box.name}: ${reason[0].toLowerCase()}${reason.slice(1)}.`;
}

// The shop re-picked its character (pickActor) between the redraw and the
// press: the cards were someone else's, so nothing was sent.
export function changedCharacterLine(name) {
  return `Your character changed to ${name}; check the crate and press Buy again.`;
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
    return `<label class="lc-shop__field"><span class="lc-label">Character</span><select class="lc-shop__actor"${busy ? ` aria-disabled="true"` : ""}>${options}</select></label>`;
  }
  // Focusable as a target only (tabindex -1), for focus on a select that
  // gives way to it (patchShop); morph keeps the attribute on later renders.
  const name = actors.find(a => a.id === actorId)?.name ?? "No character";
  return `<div class="lc-shop__field"><span class="lc-label">Character</span><span class="lc-shop__who" tabindex="-1">${esc(name)}</span></div>`;
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
  const stock = odds.rows.length && box.rules?.stock != null ? `<div class="lc-box__stock">${esc(box.rules.stock)} left</div>` : "";
  const pity = pityLine(odds);
  const middle = [
    odds.rows.length ? `${oddsRibbon(odds.rows)}<div class="lc-box__odds">${oddsPills(odds.rows)}</div>` : "",
    pity ? `<div class="lc-box__pity lc-rarity-${odds.pity.minRarity}${odds.pity.due ? " lc-box__pity--due" : ""}">${esc(pity)}</div>` : "",
    stock,
  ];
  return cardShell(box, ctx, { rarityClass, art: peek.length ? peekHTML(peek, esc) : ctx.art ?? "", middle, reason, label: `Open for ${esc(formatPrice(box.price))}` });
}

/*
  The card every kind of game shares: the band with the name, the art, the
  kind's own lines (`middle`: odds, pity, stock, whatever it says), the one
  Buy with its price (`label`) and the reason it is off. `reason` is the
  game's own (the crate's crateReason, the well's); the shop-wide reason and
  "Opening…" are handled here for all of them, with the rules above (data-box,
  data-price, aria-disabled, aria-describedby, the screen-reader name).
*/
export function cardShell(box, ctx, { rarityClass, art = "", middle = [], reason = "", label }) {
  const esc = ctx.esc ?? (s => String(s ?? ""));
  const notice = shopNotice(ctx).text;
  const whyId = `lc-why-${box.id}`;
  const describedBy = [notice ? SHOP_NOTICE_ID : "", reason ? whyId : ""].filter(Boolean).join(" ");
  const off = !!(reason || notice || ctx.busy);
  const opening = ctx.busy && (ctx.busyBox == null || ctx.busyBox === box.id);
  const waiting = opening && WAITING[ctx.waiting];
  // The price this Buy says, which the shop sends with the pull (shop.js #buy).
  const price = Number.isFinite(Number(box.price)) && box.price !== "" && box.price != null ? String(Number(box.price)) : "";
  return `
      <div class="lc-box ${rarityClass}" data-box="${esc(box.id)}">
        <div class="lc-box__band"><h3 class="lc-box__name">${esc(box.name)}</h3></div>
        <div class="lc-box__body">
          <div class="lc-box__art" aria-hidden="true">${art}</div>
          ${middle.join("\n          ")}
          <button type="button" class="lc-box__buy" data-action="buy" data-box="${esc(box.id)}"${price ? ` data-price="${esc(price)}"` : ""}${off ? ` aria-disabled="true"` : ""}${off && describedBy ? ` aria-describedby="${esc(describedBy)}"` : ""}>
            <span class="lc-sr-only">${esc(box.name)}: </span>${opening ? (waiting ? "Waiting for the GM…" : "Opening…") : label}
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
