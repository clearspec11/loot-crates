/*
  Runs the module's pure scripts outside Foundry with sample data, so the shop
  and the spin can be looked at and screenshotted without a world.

  ?state=shop | spin | landed | replay | manager     ?seed=<n>     ?duration=<ms>     ?buyer=1
  ?theme=dark | light (Foundry's two themes; dark by default)
  ?waiting=gm | hidden (shop: the first crate pressed and the GM slow to answer)
  ?closed=1 (shop: closed because no GM is online; ?closed=gm, closed by the GM)
  ?width=<px> (the window's width, as a GM sizes it, whatever the screen's)
  ?height=<px> (the window's height, shorter than its content: the shop must scroll its grid)
  ?characters=2 (shop: the player owns two characters, so the head has the
  character select; aria-disabled while a pull is out)
  ?pity=due (shop: Tam has gone 8 pulls without a Rare from the Adventurer's
  Crate, so its pity is due: only Rare or better shows, and its line says so)
  "landed" plays the spin at zero duration, for deterministic screenshots.
  ?watched=0 (landed: this client didn't see it spin, it landed hidden or was
  skipped, so the reveal offers Watch again beside Close, which replays the
  strip in place at full length; it goes once a replay has run to its end)
  buyer=1 shows the reveal as the buyer (or a GM) sees it: gold left and an
  Open item button; without it, as the rest of the table sees it.
  "replay" is "Watch again": the landed pull's chat card (with its button)
  under the window, and the window replaying that pull from the card's
  snapshot (revealcard.js replaySnapshot/replayReveal), as anyone at the
  table sees it: titled "Replay: ...", no gold, no Open item. Landed at once
  unless ?duration is given; the card's button replays it at full length.
  "manager" is the pool editor's Pools tab (poolview.js), with chips and
  open/close working; search, edits and Show more need Foundry.
  ?tab=boxes (manager: the Boxes tab, boxestable.js, every kind's row in
  one table; &added=1 shows it the moment "New box" was saved as the Royal
  Vault: the status line says it is on the shelf, the row carries the new
  edge and its Edit has focus, as manager.js #saveEditor leaves it)
  ?tab=log (manager: the Pull log, logtable.js, with sample.js sampleLog:
  a refunded pull, a pity pull, a late sale, a dice win, a deck loss, five
  folded throws at the well and the wheel's settled round)
  ?dropped=1 (manager: the GM had the 200-entry pool filtered to Rare, then
  dropped its last item, a Very rare one, on it: the pool opens, the chip
  clears, the row is pinned at the top and focused, and the status line says so)
  ?limit=reached (shop: Tam has bought the Pauper's Box twice, its limit
  per character, so its card reads "Limit reached: 2 of 2 for Tam
  Thornwick" with its Buy off; without it Tam has bought it once: "You can
  buy 1 more")
  "editor" is the box editor's pools, Rules and Limits groups
  (editorfields.js, limits.js) for the Royal Vault: Core magic items
  ticked with a share of 2, Leigh's homebrew unticked with its share off,
  "3 of 10 left" with Restock, one per character a day, and its "On the
  shelf" box (shelf.js), ticked.
  ?shelf=off (shop and the Boxes tab: the GM has taken the Royal Vault off
  the shelf, shelf.js. A player's shop leaves it out; with &gm=1 the GM's
  shop shows it with its Buy off and why. The Boxes tab tags and dims its
  row, its toggle reads "Put on shelf", and the toolbar counts the rest)
  ?well=capped (shop: Tam has thrown 3 of 3 coins into the Wishing Well
  today, so its card reads "The well is still until tomorrow (3 of 3 today)"
  with its Buy off; without it Tam has thrown once: "1 of 3 throws today")
  "well" is the Wishing Well's reveal (well.js): ?outcome=nothing | coin |
  item (nothing by default), played at full length unless ?duration is
  given (0 lands at once, for screenshots); buyer=1 as for landed.
  "dice" is Dragon's Teeth's reveal (dicegame.js): ?outcome=win | lose |
  prize (win by default; the faces are sample.js DICE_FACES), played at
  full length unless ?duration is given (0 lands at once); ?phase=rolling
  keeps the dice tumbling (reduced motion off) for a mid-roll screenshot,
  with the button reading Skip; buyer=1 as for landed.
  "deck" is the Deck of Many Things' reveal (deck.js): ?outcome=item | coins
  | loss | effect | blank (coins by default), played at full length unless
  ?duration is given (0 lands at once); ?phase=held freezes the card
  face-down mid-hold (reduced motion off) for a screenshot, with the button
  reading Skip; ?streak=2 makes it the third draw in a row (the head says
  so, and Draw again names the risen price); buyer=1 as for landed, and
  also shows Draw again, as the buyer alone sees it.
  ?gm=1 (shop: the GM's shop, every game on it, with "Manage crates" in the
  window's header controls, their menu drawn open; route.js)
  ?empty=1 (shop: nothing on the shelf; a player is told the GM hasn't put
  anything out, a GM (with gm=1) is pointed at Manage crates)
  ?streak=1 (shop: Tam drew from the deck a moment ago, so its card prices
  the next draw at 15 gp and says so)
  ?round=none | closed (shop: the Wheel of Fate has no round open, or its
  bets are closed, so its card says so with its Buy off; by default a
  round is open with 42 s on the clock and "Place a bet" is on)
  "table" is the shared table window (tableview.js) on the Wheel of Fate
  (roulette.js): ?phase=betting (three characters' chips on the rail, the
  clock, Tam's bet form) | waiting (bets closed, the GM's view with Spin:
  add &gm=1) | closed (bets closed, as a player sees it) | spinning (the
  ball running; ?duration=100000 holds it mid-spin, reduced motion off) |
  landed (?outcome=win lands on 7, where Tam has two bets; lose on 8,
  where Orla and Bo have theirs; ?duration=0 lands at once); gm=1 shows
  the GM's controls.
*/
import { POOLS, BOX, BOXES, WELL, DICE, DICE_FACES, DECK, ROULETTE, rouletteRound, wheelStakes, deckDraws, wellThrows, limitBuys, sampleLog, MANAGER_POOLS, MANAGER_SOURCES, MANAGER_BOXES } from "./sample.js";
import { limitsFieldset, restockPreview, stockField } from "../module/scripts/limits.js";
import { poolsFieldset, pityRow, syncShares } from "../module/scripts/editorfields.js";
import { getKind, kindOf } from "../module/scripts/kinds.js";
import { mountWell } from "../module/scripts/well.js";
import { mountDice, resolve, rollData, parseFormula } from "../module/scripts/dicegame.js";
import { mountDeck, TONE_OF, CARD_KIND_LABEL, priceAt, deckPlan } from "../module/scripts/deck.js";
import { resolve as resolveBets, pocketsOf, coloursOf, betName } from "../module/scripts/roulette.js";
import { tableBodyHTML } from "../module/scripts/tableview.js";
import { poolRows, sortRows, defaultView, poolSummary, poolBody, pinRecent, dropNotice, poolUsers } from "../module/scripts/poolview.js";
import { boxesTabHTML } from "../module/scripts/boxestable.js";
import { managerNavHTML, shopControls, shopEmptyHTML } from "../module/scripts/route.js";
import { logTableHTML } from "../module/scripts/logtable.js";
import { addedNotice } from "../module/scripts/newgame.js";
import { onShelf, shelfFor, shelfFieldHTML, shelfRules, shelfNotice } from "../module/scripts/shelf.js";
import { draw, seededRng } from "../module/scripts/odds.js";
import { buildStrip } from "../module/scripts/strip.js";
import { mountSpin } from "../module/scripts/spin.js";
import { charge, formatPrice, formatGold } from "../module/scripts/currency.js";
import { resultHTML, replaySnapshot, replayReveal, replayTitle, revealActionsHTML } from "../module/scripts/revealcard.js";
import { RARITY_LABEL } from "../module/scripts/config.js";
import { actorPicker, boxCard, oddsRibbon, shopHTML, shopNotice, patchShop } from "../module/scripts/boxcard.js";
import { shopOdds } from "../module/scripts/odds.js";

const q = new URLSearchParams(location.search);
const state = q.get("state") ?? "shop";
const seed = Number(q.get("seed") ?? 7);
const duration = q.has("duration") ? Number(q.get("duration")) : state === "landed" || state === "replay" ? 0 : undefined;
const purse = { pp: 0, gp: 420, ep: 0, sp: 7, cp: 3 };
const buyer = q.get("buyer") === "1";
const unwatched = q.get("watched") === "0";
const waiting = q.get("waiting");
const closed = q.get("closed");
const pityDue = q.get("pity") === "due";
const characters = q.get("characters") === "2"
  ? [{ id: "tam", name: "Tam Thornwick" }, { id: "orla", name: "Orla Vane" }]
  : [{ id: "tam", name: "Tam Thornwick" }];
const theme = q.get("theme") === "light" ? "light" : "dark";
// The games as the GM has them: with ?shelf=off the Royal Vault is off the shelf.
let GAMES = q.get("shelf") === "off" ? BOXES.map(b => (b.id === "royal" ? { ...b, rules: shelfRules(b.rules, false) } : b)) : BOXES;
document.body.classList.replace("theme-dark", `theme-${theme}`);

// The window the module would open for this state: its class and title.
const WINDOWS = { editor: ["lc-dialog", "Edit box"], shop: ["lc-shop", "Crate Shop"], manager: ["lc-manager", "Loot Crates"], well: ["lc-reveal", "A coin in the well"], dice: ["lc-reveal", "Dragon's Teeth"], deck: ["lc-reveal", "A card from the deck"], table: ["lc-table", `The wheel at ${ROULETTE.name}`] };
const [appClass, appTitle] = WINDOWS[state] ?? ["lc-reveal", "Opening a crate"];
document.getElementById("app").classList.add(appClass);
if (Number(q.get("width")) > 0) Object.assign(document.getElementById("app").style, { width: `${Number(q.get("width"))}px`, maxWidth: "100%" });
// ?height=<px>: a window shorter than its content, as Foundry caps every
// window at the screen's height (or a player sizes it down).
if (Number(q.get("height")) > 0) document.getElementById("app").style.height = `${Number(q.get("height"))}px`;
document.getElementById("title").textContent = appTitle;
// Font Awesome isn't loaded here; this stands in for the shop's fa-box-open.
const CRATE_ICON = `<svg class="lc-box__icon" viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3 8.5 12 4l9 4.5v8L12 21l-9-4.5z"/><path d="M3 8.5 12 13l9-4.5M12 13v8"/></svg>`;

const nav = document.getElementById("nav");
for (const [label, query] of [["shop", "state=shop"], ["spin", "state=spin"], ["landed", "state=landed"], ["landed, buyer", "state=landed&buyer=1"], ["missed", "state=landed&buyer=1&watched=0"], ["replay", "state=replay"], ["well", "state=well&buyer=1"], ["well, coin", "state=well&outcome=coin&buyer=1"], ["well, item", "state=well&outcome=item&buyer=1"], ["dice", "state=dice&buyer=1"], ["dice, lost", "state=dice&outcome=lose&buyer=1"], ["dice, prize", "state=dice&outcome=prize&buyer=1"], ["deck", "state=deck&buyer=1"], ["deck, item", "state=deck&outcome=item&buyer=1"], ["deck, bane", "state=deck&outcome=loss&buyer=1"], ["deck, effect", "state=deck&outcome=effect&buyer=1"], ["table", "state=table"], ["table, GM", "state=table&phase=waiting&gm=1"], ["wheel", "state=table&phase=spinning"], ["wheel, landed", "state=table&phase=landed&duration=0"], ["manager", "state=manager"], ["boxes", "state=manager&tab=boxes&added=1"], ["pull log", "state=manager&tab=log"], ["box editor", "state=editor"]]) {
  const a = document.createElement("a");
  a.href = `?${query}&seed=${seed}&theme=${theme}`;
  a.textContent = label;
  if (query === `state=${state}${buyer ? "&buyer=1" : ""}${unwatched ? "&watched=0" : ""}`) a.classList.add("active");
  nav.append(a);
}
if (state !== "shop" && state !== "manager" && state !== "well" && state !== "dice" && state !== "deck" && state !== "table" && state !== "editor") {
  const again = document.createElement("a");
  again.href = `?state=spin&seed=${seed + 1}${q.has("box") ? `&box=${q.get("box")}` : ""}${buyer ? "&buyer=1" : ""}&theme=${theme}`;
  again.textContent = "open another";
  nav.append(again);
}
{
  const flip = document.createElement("a");
  const other = new URLSearchParams(location.search);
  other.set("theme", theme === "dark" ? "light" : "dark");
  flip.href = `?${other}`;
  flip.textContent = `${theme === "dark" ? "light" : "dark"} theme`;
  nav.append(flip);
}

const stage = document.getElementById("stage");

/*
  The shop window's header controls as Foundry draws them for a GM
  (shop.js _getHeaderControls, route.js shopControls): the ellipsis beside
  the title, and its menu, shown open here, holding "Manage crates". A
  player's shop has none of the module's, so none are drawn (Foundry's
  own, such as v14's Detach Window, aren't drawn here for anyone). Font
  Awesome isn't loaded, so a character stands in for the icon. "Manage
  crates" goes to the manager's Boxes tab, and the manager's "View shop"
  back to the GM's shop.
*/
if (state === "shop") {
  const controls = shopControls(q.get("gm") === "1");
  if (controls.length) {
    const header = document.querySelector("#app .window-header");
    header.insertAdjacentHTML("beforeend", `<button type="button" class="header-control lc-harness-toggle" aria-label="Toggle Controls" aria-expanded="true">\u22EE</button>
      <menu class="lc-harness-controls" aria-label="Window controls">${controls.map(c => `<li class="header-control" data-action="${c.action}"><button type="button" class="control"><span class="control-label">${c.label}</span></button></li>`).join("")}</menu>`);
    header.querySelector('[data-action="openManager"] button')?.addEventListener("click", () => { location.search = `?state=manager&tab=boxes&theme=${theme}`; });
  }
}
document.getElementById("app").addEventListener("click", e => {
  if (e.target.closest?.('[data-action="openShop"]')) location.search = `?state=shop&gm=1&theme=${theme}`;
  else if (state === "shop" && e.target.closest?.('.lc-shop__manage')) location.search = `?state=manager&tab=boxes&theme=${theme}`;
});

// The shop as shop.js draws it: one notice in the header (a live region kept
// across renders by patchShop), the cards pointing at it. window.__lootCrates
// .renderShop(extra) re-renders with extra ctx, as the shop does on each
// change, so the smoke can check the notice node survives.
// A game's card is its kind's (the well's), else the crate's, as shop.js picks it.
const cardFor = (box, pools, ctx) => (getKind(kindOf(box))?.shop?.card ?? boxCard)(box, pools, ctx);
function renderShop(extra = {}) {
  const ctx = {
    purse, hasActor: true, actorId: "tam", actorName: "Tam Thornwick", open: !closed, gmOnline: closed !== "1", art: CRATE_ICON,
    stateOf: id => (pityDue && id === BOX.id ? { sinceRare: BOX.rules.pity.after } : {}),
    // The in-game day and the log the well counts today's throws from, and
    // the deck its draws in a row.
    today: "y1d1", log: [...deckDraws(Number(q.get("streak")) || 0), ...wellThrows(q.get("well") === "capped" ? WELL.rules.cap : 1), ...wheelStakes(), ...limitBuys(q.get("limit") === "reached" ? 2 : 1)],
    // The wheel's round, as the card reads it: open on the clock, closed, or none.
    rounds: q.get("round") === "none" ? {} : { R1: q.get("round") === "closed" ? rouletteRound(Date.now(), { status: "closed", closesAt: Date.now() - 1000 }) : rouletteRound() },
    isGM: q.get("gm") === "1", now: Date.now(),
    ...(waiting ? { busy: true, busyBox: BOXES[0].id, waiting } : {}), ...extra,
  };
  const fresh = document.createElement("div");
  fresh.className = "lc-shop__body";
  const notice = shopNotice(ctx);
  fresh.innerHTML = shopHTML({
    fields: `${actorPicker({ actors: characters, actorId: "tam", busy: !!ctx.busy })}
        <div class="lc-shop__field lc-shop__field--purse"><span class="lc-label">Purse</span><span class="lc-shop__purse">${formatGold(purse)}</span></div>`,
    cards: q.get("empty") === "1" ? shopEmptyHTML(ctx.isGM) : shelfFor(GAMES, { isGM: ctx.isGM }).map(b => cardFor(b, POOLS, ctx)).join(""),
    notice,
  });
  patchShop(stage, fresh, notice);
  window.__lootCrates = { renderShop };
}
// One listener for every Buy, since patchShop keeps the buttons across
// renders; an aria-disabled one is off.
stage.addEventListener("click", e => {
  const btn = e.target.closest?.(".lc-box__buy");
  if (state !== "shop" || !btn || btn.getAttribute("aria-disabled") === "true") return;
  location.search = `?state=spin&seed=${Date.now() % 100000}&box=${btn.dataset.box}&buyer=1&theme=${theme}`;
});

async function renderSpin() {
  const rng = seededRng(seed);
  const box = BOXES.find(b => b.id === q.get("box")) ?? BOX;
  const result = draw({ box, pools: POOLS, rng, state: {} });
  let strip = buildStrip({ result, box, pools: POOLS, rng });
  const odds = shopOdds(box, POOLS).rows;
  // A replay plays what the chat card stored, nothing more: the snapshot
  // round-trips through JSON as a message's flags do.
  const replay = state === "replay"
    ? replayReveal(JSON.parse(JSON.stringify(replaySnapshot({ strip, odds, box, actorName: "Tam Thornwick", result: { name: result.entry.name, rarity: result.rarity, pity: result.pity } }))), "harness")
    : null;
  if (replay) {
    strip = replay.strip;
    document.getElementById("title").textContent = replayTitle(replay);
    chatCard(replay, box);
  }
  // The same markup and result block as reveal.js, with sample ids standing
  // in for the granted item.
  const reveal = replay ?? { actorName: "Tam Thornwick", userId: "buyer", itemUuid: "Actor.sample.Item.sample", purse: charge(purse, box.price) ?? {}, result: { name: result.entry.name, rarity: result.rarity, pity: result.pity } };
  const canSee = buyer && !replay;
  stage.innerHTML = `
    <div class="lc-reveal__body">
      <div class="lc-reveal__head"><span class="lc-reveal__who">Tam Thornwick</span> opens <strong class="lc-reveal__crate">${box.name}</strong> <span class="lc-reveal__price">${formatPrice(box.price)}</span></div>
      <div class="lc-vault lc-rarity-${result.rarity}">
        ${oddsRibbon(replay ? replay.odds : odds)}
        <div class="lc-reveal__spin"></div>
        <div class="lc-reveal__result lc-rarity-${result.rarity}" aria-live="polite"></div>
      </div>
      ${revealActionsHTML()}
    </div>`;
  const out = stage.querySelector(".lc-reveal__result");
  const btn = stage.querySelector(".lc-reveal__close");
  const open = stage.querySelector(".lc-reveal__open");
  const watch = stage.querySelector(".lc-reveal__watch");
  const host = stage.querySelector(".lc-reveal__spin");
  let landed = false;
  let spin = mountSpin(host, strip, {
    duration,
    reducedMotion: duration === 0,
    onLand: () => {
      landed = true;
      out.innerHTML = resultHTML(reveal, { canSee });
      open.hidden = !canSee;
      watch.hidden = !unwatched;
      btn.textContent = "Close";
      btn.focus({ preventScroll: true });
    },
  });
  btn.addEventListener("click", () => { if (landed) location.search = `?state=${replay ? "replay" : "shop"}&seed=${seed}&theme=${theme}`; else spin.skip(); });
  // Watch again as reveal.js plays it: the same strip in the same host, the
  // button reading Skip and the result hidden until it lands again.
  let replaying = false;
  watch.addEventListener("click", () => {
    if (replaying) { spin.skip(); return; }
    replaying = true;
    watch.textContent = "Skip";
    out.hidden = true;
    const again = mountSpin(host, strip, {
      duration: 6200,
      reducedMotion: false,
      onLand: () => {
        replaying = false;
        out.hidden = false;
        if (again.skipped) { watch.textContent = "Watch again"; return; }
        const had = document.activeElement === watch;
        watch.hidden = true;
        if (had) btn.focus({ preventScroll: true });
      },
    });
    spin = again;
    again.play();
  });
  await spin.play();
  document.body.dataset.landed = "1";
  window.__lootCrates = { result, strip };
}

// The pull's chat card as chat.js posts it, with the Watch again button
// reveal.js watchAgain adds, in a strip of chat-log width under the window.
function chatCard(r, box) {
  const log = document.createElement("div");
  log.className = "harness-chat";
  log.innerHTML = `
    <div class="loot-crates lc-chat lc-rarity-${r.result.rarity}">
      <div class="lc-chat__head">${r.actorName} opened <strong>${box.name}</strong> <span class="lc-chat__price">${formatPrice(box.price)}</span></div>
      <div class="lc-chat__item">
        <img src="${r.strip.cards[r.strip.landIndex].img}" alt="">
        <div>
          <div class="lc-chat__name">${r.result.name}</div>
          <div class="lc-chat__rarity">${RARITY_LABEL[r.result.rarity]}${r.result.pity ? " · pity" : ""}</div>
        </div>
      </div>
      <button type="button" class="lc-chat__replay" aria-label="Watch again: ${r.actorName} opens ${box.name}">Watch again</button>
    </div>`;
  log.querySelector(".lc-chat__replay").addEventListener("click", () => {
    location.search = `?state=replay&seed=${seed}${q.has("box") ? `&box=${q.get("box")}` : ""}&duration=6200&theme=${theme}`;
  });
  document.getElementById("app").after(log);
}

// The pool editor with sample pools. The compendium pool is shown open (as a
// GM who opened it sees it); the 200-entry one keeps its collapsed default.
function renderManager() {
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const srcOf = e => MANAGER_SOURCES.has(e.uuid) ? MANAGER_SOURCES.get(e.uuid) : { name: e.name, img: e.img, rarity: e.sourceRarity || null, rawRarity: e.sourceRarity ?? null };
  const views = new Map(MANAGER_POOLS.map(p => [p.id, { ...defaultView(p), open: p.id === "compendium" ? true : defaultView(p).open }]));
  const rowsOf = p => sortRows(poolRows(p, srcOf), views.get(p.id).recent);
  const managerPools = Object.fromEntries(MANAGER_POOLS.map(p => [p.id, p]));
  // The manager's #pinDrop, with the same pure steps.
  let status = "", dropped = null;
  if (q.get("dropped") === "1") {
    const pool = MANAGER_POOLS.find(p => p.id === "everything");
    dropped = pool.entries.at(-1).uuid;
    const { view, cleared } = pinRecent({ ...views.get(pool.id), chip: "rare" }, poolRows(pool, srcOf), [dropped]);
    views.set(pool.id, view);
    status = dropNotice({ pool, rows: rowsOf(pool).filter(r => r.recent), cleared });
  }
  stage.innerHTML = `
    <div class="lc-manager__body">
      ${managerNavHTML({ tab: "pools", shopOpen: true })}
      <section class="lc-tab" role="tabpanel">
        <div class="lc-toolbar"><button type="button"><i class="fas fa-plus"></i> New pool</button><span class="lc-pool__hint lc-manager__status" role="status">${esc(status)}</span></div>
        ${MANAGER_POOLS.map(p => `
        <article class="lc-pool" data-drop-pool="${esc(p.id)}">
          <details class="lc-pool__details" data-pool="${esc(p.id)}"${views.get(p.id).open ? " open" : ""}>
            ${poolSummary(p, rowsOf(p), esc, poolUsers(p.id, managerPools, MANAGER_BOXES).map(b => b.name))}
            <div class="lc-pool__body">${views.get(p.id).open ? poolBody(p, rowsOf(p), views.get(p.id), esc) : ""}</div>
          </details>
        </article>`).join("")}
      </section>
    </div>`;
  const fill = details => {
    const pool = MANAGER_POOLS.find(p => p.id === details.dataset.pool);
    const view = views.get(pool.id);
    view.open = details.open;
    details.querySelector(".lc-pool__body").innerHTML = view.open ? poolBody(pool, rowsOf(pool), view, esc) : "";
  };
  stage.querySelectorAll(".lc-pool__details").forEach(d => d.addEventListener("toggle", () => { if (d.open !== !!d.querySelector(".lc-pool__body").childElementCount) fill(d); }));
  stage.addEventListener("click", e => {
    const chip = e.target.closest("[data-chip]");
    if (!chip) return;
    const view = views.get(chip.dataset.pool);
    view.chip = view.chip === chip.dataset.chip ? null : chip.dataset.chip;
    fill(chip.closest(".lc-pool__details"));
    stage.querySelector(`.lc-pool__details[data-pool="${chip.dataset.pool}"] [data-chip="${chip.dataset.chip}"]`)?.focus();
  });
  if (dropped) {
    const li = stage.querySelector(`[data-entry="${CSS.escape(dropped)}"]`);
    li?.querySelector("select, input, button")?.focus({ preventScroll: true });
    li?.scrollIntoView({ block: "nearest" });
  }
  document.body.dataset.ready = "1";
}

/*
  The Wishing Well's reveal as reveal.js opens it, with the well kind's own
  head, play, result and buttons (no Watch again). The outcome is picked by
  the query, the item by the seed.
*/
async function renderWell() {
  const outcome = ["nothing", "coin", "item"].includes(q.get("outcome")) ? q.get("outcome") : "nothing";
  const kind = getKind("well").reveal;
  const esc = s => String(s ?? "");
  const drawn = outcome === "item" ? draw({ box: WELL, pools: POOLS, rng: seededRng(seed), state: {} }) : null;
  const reveal = {
    kind: "well", outcome, actorName: "Tam Thornwick", userId: "buyer",
    box: { id: WELL.id, name: WELL.name, price: WELL.price },
    result: outcome === "item" ? { uuid: drawn.entry.uuid, name: drawn.entry.name, img: drawn.entry.img, rarity: drawn.rarity, pity: false } : outcome === "coin" ? { name: "Coin back", outcome: "coin" } : null,
    itemUuid: outcome === "item" ? "Actor.sample.Item.sample" : null,
    purse: outcome === "coin" ? purse : charge(purse, WELL.price) ?? {},
    payoutCp: outcome === "coin" ? Math.round(WELL.price * 100) : 0,
    thrown: 2, cap: WELL.rules.cap,
  };
  const rarity = reveal.result?.rarity ?? "none";
  stage.innerHTML = `
    <div class="lc-reveal__body">
      <div class="lc-reveal__head">${kind.head(reveal, { esc })}</div>
      <div class="lc-vault lc-rarity-${rarity}">
        <div class="lc-reveal__spin"></div>
        <div class="lc-reveal__result lc-rarity-${rarity}" aria-live="polite"></div>
      </div>
      ${revealActionsHTML()}
    </div>`;
  const out = stage.querySelector(".lc-reveal__result");
  const btn = stage.querySelector(".lc-reveal__close");
  const open = stage.querySelector(".lc-reveal__open");
  let landed = false;
  const ctrl = mountWell(stage.querySelector(".lc-reveal__spin"), {
    outcome, img: outcome === "item" ? reveal.result.img : "", rarity, duration,
    onLand: () => {
      landed = true;
      out.innerHTML = kind.result(reveal, { esc, canSee: buyer });
      open.hidden = !(buyer && outcome === "item");
      btn.dataset.action = "dismiss";
      btn.textContent = "Close";
      btn.focus({ preventScroll: true });
    },
  });
  btn.addEventListener("click", () => { if (landed) location.search = `?state=shop&seed=${seed}&theme=${theme}`; else ctrl.skip(); });
  await ctrl.play();
  document.body.dataset.landed = "1";
  window.__lootCrates = { reveal };
}

/*
  Dragon's Teeth's reveal as reveal.js opens it, with the dice kind's own
  head, play, result and buttons (no Watch again). The outcome picks the
  faces (sample.js DICE_FACES); the roll data is the shape Foundry's
  Roll.toJSON gives, so the window reads it as a client would.
*/
async function renderDice() {
  const outcome = ["win", "lose", "prize"].includes(q.get("outcome")) ? q.get("outcome") : "win";
  const rolling = q.get("phase") === "rolling";
  const kind = getKind("dice").reveal;
  const esc = s => String(s ?? "");
  const faces = DICE_FACES[outcome];
  const { number, sides } = parseFormula(DICE.dice.formula);
  const out = resolve(faces, { target: DICE.dice.target, multiplier: DICE.dice.multiplier, stakeCp: DICE.price * 100, sides });
  const drawn = outcome === "prize" ? draw({ box: DICE, pools: POOLS, rng: seededRng(seed), state: {} }) : null;
  const reveal = {
    kind: "dice", actorName: "Tam Thornwick", userId: "buyer",
    box: { id: DICE.id, name: DICE.name, price: DICE.price },
    faces, roll: rollData(DICE.dice.formula, { number, sides, faces }), total: out.total, target: DICE.dice.target, formula: DICE.dice.formula, multiplier: DICE.dice.multiplier,
    win: out.win, perfect: out.perfect, payoutCp: out.payoutCp, prize: !!drawn,
    result: drawn ? { uuid: drawn.entry.uuid, name: drawn.entry.name, img: drawn.entry.img, rarity: drawn.rarity, pity: false } : out.win ? { name: "win", outcome: "win" } : null,
    itemUuid: drawn ? "Actor.sample.Item.sample" : null,
    purse: charge(purse, DICE.price) ?? {},
  };
  if (out.win) reveal.purse = charge({ ...purse, gp: purse.gp + out.payoutCp / 100 }, DICE.price) ?? reveal.purse;
  const rarity = drawn ? drawn.rarity : out.win ? "coin" : "none";
  stage.innerHTML = `
    <div class="lc-reveal__body">
      <div class="lc-reveal__head">${kind.head(reveal, { esc })}</div>
      <div class="lc-vault lc-rarity-${rarity}">
        <div class="lc-reveal__spin"></div>
        <div class="lc-reveal__result lc-rarity-${rarity}" aria-live="polite"></div>
      </div>
      ${revealActionsHTML()}
    </div>`;
  const outEl = stage.querySelector(".lc-reveal__result");
  const btn = stage.querySelector(".lc-reveal__close");
  const open = stage.querySelector(".lc-reveal__open");
  let landed = false;
  const ctrl = mountDice(stage.querySelector(".lc-reveal__spin"), {
    faces, sides, target: DICE.dice.target, outcome: out.win ? "win" : "lose", rarity, duration, rng: seededRng(seed),
    reducedMotion: rolling ? false : undefined,
    onLand: () => {
      landed = true;
      outEl.innerHTML = kind.result(reveal, { esc, canSee: buyer });
      open.hidden = !(buyer && drawn);
      btn.dataset.action = "dismiss";
      btn.textContent = "Close";
      btn.focus({ preventScroll: true });
    },
  });
  btn.addEventListener("click", () => { if (landed) location.search = `?state=shop&seed=${seed}&theme=${theme}`; else ctrl.skip(); });
  window.__lootCrates = { reveal, faces };
  await ctrl.play();
  document.body.dataset.landed = "1";
}

/*
  The Deck of Many Things' reveal as reveal.js opens it, with the deck kind's
  own head, play, result, Draw again and buttons (no Watch again). The
  outcome picks the card (sample.js DECK), the item by the seed; the streak
  makes it a draw in a row, which the head says and the next price follows.
*/
async function renderDeck() {
  const outcome = ["item", "coins", "loss", "effect", "blank"].includes(q.get("outcome")) ? q.get("outcome") : "coins";
  const held = q.get("phase") === "held";
  const streak = Math.max(0, Number(q.get("streak")) || 0) + 1;
  const kind = getKind("deck").reveal;
  const esc = s => String(s ?? "");
  const card = DECK.deck.cards.find(c => c.kind === outcome);
  const drawn = outcome === "item" ? draw({ box: DECK, pools: POOLS, rng: seededRng(seed), state: {} }) : null;
  const price = priceAt(DECK, streak - 1);
  const plan = deckPlan(DECK, POOLS, []);
  const lossCp = outcome === "loss" ? card.gp * 100 : 0;
  const payoutCp = outcome === "coins" ? card.gp * 100 : -lossCp;
  const reveal = {
    kind: "deck", actorId: "tam", actorName: "Tam Thornwick", userId: "buyer",
    box: { id: DECK.id, name: DECK.name, price },
    card: { id: card.id, label: card.label, kind: card.kind, once: !!card.once }, tone: TONE_OF[outcome],
    cardsLeft: plan.left - (card.once ? 1 : 0), size: plan.size, streak, nextPrice: priceAt(DECK, streak),
    result: drawn ? { uuid: drawn.entry.uuid, name: drawn.entry.name, img: drawn.entry.img, rarity: drawn.rarity, pity: false } : { name: card.label, outcome },
    itemUuid: drawn ? "Actor.sample.Item.sample" : null,
    payoutCp, lossCp, takenCp: lossCp, text: card.text ?? "",
    purse: charge(purse, price) ?? {},
  };
  if (payoutCp) reveal.purse = charge({ ...purse, gp: purse.gp + payoutCp / 100 }, price) ?? reveal.purse;
  const rarity = drawn ? drawn.rarity : outcome === "coins" ? "coin" : outcome === "loss" ? "bane" : "none";
  stage.innerHTML = `
    <div class="lc-reveal__body">
      <div class="lc-reveal__head">${kind.head(reveal, { esc })}</div>
      <div class="lc-vault lc-rarity-${drawn ? drawn.rarity : "none"}">
        <div class="lc-reveal__spin"></div>
        <div class="lc-reveal__result lc-rarity-${drawn ? drawn.rarity : "none"}" aria-live="polite"></div>
      </div>
      ${revealActionsHTML()}
    </div>`;
  const outEl = stage.querySelector(".lc-reveal__result");
  const btn = stage.querySelector(".lc-reveal__close");
  const open = stage.querySelector(".lc-reveal__open");
  const again = stage.querySelector(".lc-reveal__again");
  let landed = false;
  const ctrl = mountDeck(stage.querySelector(".lc-reveal__spin"), {
    tone: reveal.tone, swatch: rarity, label: card.label, kindLabel: drawn ? RARITY_LABEL[drawn.rarity] : CARD_KIND_LABEL[outcome], img: drawn ? drawn.entry.img : "",
    duration, reducedMotion: held ? false : undefined, freezeAt: held ? 300 + 450 : null,
    onLand: () => {
      landed = true;
      outEl.innerHTML = kind.result(reveal, { esc, canSee: buyer });
      open.hidden = !(buyer && drawn);
      // Draw again, as the core offers it to the buyer: the next draw's price from the record.
      const offer = buyer ? kind.again(reveal, { game: DECK, log: deckDraws(streak), pools: POOLS, purse: reveal.purse, now: Date.now() }) : null;
      again.hidden = !offer;
      if (offer) again.textContent = offer.label;
      btn.dataset.action = "dismiss";
      btn.textContent = "Close";
      btn.focus({ preventScroll: true });
    },
  });
  btn.addEventListener("click", () => { if (landed) location.search = `?state=shop&seed=${seed}&theme=${theme}`; else ctrl.skip(); });
  again.addEventListener("click", () => { location.search = `?state=deck&seed=${seed + 1}&buyer=1&streak=${streak}&theme=${theme}`; });
  window.__lootCrates = { reveal };
  await ctrl.play();
  document.body.dataset.landed = "1";
}

/*
  The shared table window as tablewindow.js opens it on the Wheel of Fate:
  tableview.js's body, the wheel kind's stage and rail with three
  characters' chips, the bet form (Tam's, placing a bet drops a chip),
  the GM's Spin, and the spin to the landing with the verdict and each
  character's net in the live region.
*/
async function renderTable() {
  const phase = ["betting", "waiting", "closed", "spinning", "landed"].includes(q.get("phase")) ? q.get("phase") : "betting";
  const gm = q.get("gm") === "1";
  const outcome = q.get("outcome") === "lose" ? "lose" : "win";
  const kind = getKind("roulette");
  const view = kind.tableView;
  const esc = s => String(s ?? "");
  const now = Date.now();
  const round = phase === "betting" ? rouletteRound(now) : phase === "waiting" || phase === "closed" ? rouletteRound(now, { status: "closed", closesAt: null }) : rouletteRound(now, { status: "resolved", closesAt: null });
  let stakes = wheelStakes(now);
  // The landing: 7 (red, uncommon: Tam's two bets win) or 8 (black, common: Orla's even and Bo's black win).
  const index = outcome === "win" ? 6 : 7;
  const pocket = pocketsOf(ROULETTE)[index];
  const reveal = phase === "spinning" || phase === "landed" ? {
    type: "round", event: "resolve", roundId: "R1", boxId: ROULETTE.id, kind: "roulette", box: { id: ROULETTE.id, name: ROULETTE.name },
    outcome: { index, number: pocket.n, colour: pocket.colour, colourName: pocket.colourName, rarity: pocket.rarity },
    pockets: ROULETTE.roulette.pockets, colours: coloursOf(ROULETTE),
    stakes: stakes.map(r => ({ logId: r.id, actorId: r.actorId, actorName: r.actorName, userId: r.userId, price: r.price, stake: r.stake, action: "settle", reason: null, payoutCp: resolveBets(pocket, [{ ...r.stake, stakeCp: r.price * 100 }], ROULETTE)[0].payoutCp, name: null, result: null })),
  } : null;
  if (reveal) stakes = reveal.stakes.map(s => ({ id: s.logId, actorId: s.actorId, actorName: s.actorName, price: s.price, stake: s.stake, name: s.stake.label, status: "settled", payoutCp: s.payoutCp }));
  const viewer = { isGM: gm, actors: gm ? [] : characters };
  // "closed" is a player's view of the GM's "waiting" (tableview.js phaseOf).
  const bodyPhase = reveal ? "spinning" : phase === "closed" ? "waiting" : phase;
  const draw = () => {
    stage.innerHTML = `<div class="lc-table__body">${tableBodyHTML({ kind, game: ROULETTE, round, stakes, viewer, phase: bodyPhase, now, esc })}</div>`;
  };
  draw();
  const host = stage.querySelector(".lc-table__host");
  const ctrl = view.mount(host, { pockets: view.pockets(ROULETTE), esc });
  // The GM bets with no character here, so none of the chips are theirs.
  const actorIds = gm ? [] : characters.map(a => a.id);
  const paintRail = (landed = false) => ctrl.rail(view.rail(ROULETTE, stakes, { esc, outcome: landed ? reveal.outcome : null, actorIds }));
  paintRail(false);
  const btn = stage.querySelector(".lc-reveal__close");
  const form = stage.querySelector(".lc-table__form");
  if (form) {
    form.addEventListener("change", e => {
      if (!e.target.matches(".lc-table__type")) return;
      form.querySelector(".lc-table__pick").innerHTML = view.pickOptions(ROULETTE, e.target.value, null, esc);
    });
    // A bet placed drops a chip for Tam, as the GM's "staked" would.
    form.addEventListener("submit", e => {
      e.preventDefault();
      const why = form.querySelector(".lc-table__why");
      const values = Object.fromEntries(new FormData(form).entries());
      try {
        const { bet, price } = view.readBet(ROULETTE, values);
        const actor = characters.find(a => a.id === values.actorId) ?? characters[0];
        const id = `bet${stakes.length}`;
        stakes = [{ id, kind: "roulette", boxId: ROULETTE.id, boxName: ROULETTE.name, actorId: actor.id, actorName: actor.name, price, payoutCp: 0, status: "open", roundId: "R1", at: Date.now(), stake: { label: labelOf(bet), type: bet.type, pick: bet.pick, swatch: view.betSwatch(bet) }, name: labelOf(bet) }, ...stakes];
        ctrl.rail(view.rail(ROULETTE, stakes, { esc, fresh: [id], actorIds }));
        stage.querySelector(".lc-table__count").textContent = `${stakes.length} bets from 3 characters`;
        stage.querySelector(".lc-table__live").textContent = `${actor.name} bets ${price} gp on ${labelOf(bet)}.`;
        why.textContent = "";
      } catch (err) { why.textContent = err.message; }
    });
  }
  const labelOf = bet => betName(ROULETTE, bet);
  stage.querySelector(".lc-table__spin")?.addEventListener("click", () => { location.search = `?state=table&phase=spinning&gm=1&seed=${seed}&theme=${theme}`; });
  if (!reveal) { btn.addEventListener("click", () => { location.search = `?state=shop&seed=${seed}&theme=${theme}`; }); window.__lootCrates = { stakes }; document.body.dataset.ready = "1"; return; }
  let landed = false;
  const spin = ctrl.spin({
    index, duration, reducedMotion: duration === 0 ? true : duration != null ? false : undefined,
    onLand: () => {
      landed = true;
      stage.querySelector(".lc-vault").className = `lc-vault lc-rarity-${view.rarityOf(reveal)}`;
      stage.querySelector(".lc-table__result").innerHTML = view.result(reveal, { esc });
      paintRail(true);
      const state = stage.querySelector(".lc-table__state");
      state.textContent = "Settled";
      state.dataset.state = "landed";
      btn.dataset.action = "dismiss";
      btn.textContent = "Close";
      btn.focus({ preventScroll: true });
    },
  });
  btn.addEventListener("click", () => { if (landed) location.search = `?state=shop&seed=${seed}&theme=${theme}`; else spin.skip(); });
  window.__lootCrates = { reveal, stakes };
  await spin.play();
  document.body.dataset.landed = "1";
}

/*
  The manager's Boxes tab (boxestable.js) with the sample games, one of
  every kind, and the log and round their rows read. With ?added=1 it is
  the tab as "New box" leaves it once saved as the Royal Vault (manager.js
  #saveEditor): the status line written after the render, the row marked
  and its Edit focused and scrolled into view. The New buttons and Edit
  need Foundry here.
*/
function renderBoxes({ toggled = null } = {}) {
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const added = q.get("added") === "1" ? BOXES.find(b => b.id === "royal") : null;
  const now = Date.now();
  stage.innerHTML = `
    <div class="lc-manager__body">
      ${managerNavHTML({ tab: "boxes", shopOpen: true })}
      <section class="lc-tab" role="tabpanel">
        ${boxesTabHTML({ boxes: GAMES, pools: POOLS, log: [...deckDraws(1, now), ...limitBuys(1)], rounds: { R1: rouletteRound(now) }, recent: added?.id ?? null, esc })}
      </section>
    </div>`;
  if (added) {
    const edit = stage.querySelector(`.lc-table [data-action="editBox"][data-box="${CSS.escape(added.id)}"]`);
    edit?.focus({ preventScroll: true });
    edit?.closest("tr")?.scrollIntoView({ block: "nearest" });
    stage.querySelector(".lc-manager__status").textContent = addedNotice(added, { shopOpen: true });
  }
  // With ?shelf=off, the tab as the Royal Vault's toggle leaves it once
  // pressed (manager.js #toggleShelf): focus kept on the toggle, the status
  // line saying what players see. A press here flips the game the same way.
  const shown = toggled ?? (q.get("shelf") === "off" ? "royal" : null);
  if (shown) {
    stage.querySelector(`[data-action="toggleShelf"][data-box="${CSS.escape(shown)}"]`)?.focus({ preventScroll: true });
    stage.querySelector(".lc-manager__status").textContent = shelfNotice(GAMES.find(b => b.id === shown));
  }
  document.body.dataset.ready = "1";
}
stage.addEventListener("click", e => {
  const btn = e.target.closest?.('[data-action="toggleShelf"]');
  if (!btn || state !== "manager") return;
  const id = btn.dataset.box;
  GAMES = GAMES.map(b => (b.id === id ? { ...b, rules: shelfRules(b.rules, !onShelf(b)) } : b));
  renderBoxes({ toggled: id });
});

/*
  The manager's Pull log (logtable.js) on the sample log, with the wheel's
  round settled. Refund and Hide misses need Foundry here.
*/
function renderLog() {
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const now = Date.now();
  stage.innerHTML = `
    <div class="lc-manager__body">
      ${managerNavHTML({ tab: "log", shopOpen: true })}
      <section class="lc-tab" role="tabpanel">
        ${logTableHTML({ log: sampleLog(now), rounds: { R1: rouletteRound(now - 400000, { status: "resolved", closesAt: now - 380000 }) }, esc })}
      </section>
    </div>`;
  document.body.dataset.ready = "1";
}

/*
  The box editor's pools, Rules and Limits groups (manager.js #editCrate,
  editorfields.js, limits.js limitsFieldset) as the dialog shows them for
  the Royal Vault, from the same helpers: one pool ticked and one not (its
  share off until it is ticked), 3 of its 10 left with Restock, one per
  character a day. Restock says what Save will leave as the manager's does
  (the button goes off and keeps focus); nothing is written.
*/
function renderEditor() {
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const royal = BOXES.find(b => b.id === "royal");
  const box = { ...royal, pools: [{ id: "core", share: 2 }], rules: { ...royal.rules, perCharacter: { max: 1, per: "day" } } };
  stage.innerHTML = `
    <div class="dialog-form">
      <div class="dialog-content"><div class="lc-form">
        <label>Name <input name="name" value="${esc(box.name)}"></label>
        <label class="lc-form__price">Price <input name="price" type="text" data-price-field value="${esc(formatPrice(box.price))}" placeholder="50 gp, 5 sp or 12 gp 5 sp" autocomplete="off" spellcheck="false"></label>
        ${poolsFieldset("Pools and their share of pulls", Object.values(POOLS), box.pools, { esc })}
        <fieldset><legend>Rules</legend>
          ${pityRow(box.rules?.pity, { noun: "pulls", esc })}
          <label class="lc-row"><input type="checkbox" name="noDuplicates"> No duplicates per character</label>
        </fieldset>
        ${limitsFieldset(box, { hasClock: true, esc })}
        ${shelfFieldHTML(box)}
      </div></div>
      <footer class="form-footer"><button type="button">Save</button><button type="button">Cancel</button></footer>
    </div>`;
  const btn = stage.querySelector("[data-restock]");
  btn?.addEventListener("click", () => {
    if (btn.getAttribute("aria-disabled") === "true") return;
    btn.setAttribute("aria-disabled", "true");
    stage.querySelector('input[name="restock"]').value = "1";
    stage.querySelector(".lc-limits__left").textContent = restockPreview(stockField(box));
  });
  stage.addEventListener("change", () => syncShares(stage));
  document.body.dataset.ready = "1";
}

if (state === "shop") renderShop();
else if (state === "editor") renderEditor();
else if (state === "manager" && q.get("tab") === "boxes") renderBoxes();
else if (state === "manager" && q.get("tab") === "log") renderLog();
else if (state === "manager") renderManager();
else if (state === "table") renderTable();
else if (state === "well") renderWell();
else if (state === "dice") renderDice();
else if (state === "deck") renderDeck();
else renderSpin();
