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
  ?dropped=1 (manager: the GM had the 200-entry pool filtered to Rare, then
  dropped its last item, a Very rare one, on it: the pool opens, the chip
  clears, the row is pinned at the top and focused, and the status line says so)
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
*/
import { POOLS, BOX, BOXES, WELL, DICE, DICE_FACES, wellThrows, MANAGER_POOLS, MANAGER_SOURCES, MANAGER_BOXES } from "./sample.js";
import { getKind, kindOf } from "../module/scripts/kinds.js";
import { mountWell } from "../module/scripts/well.js";
import { mountDice, resolve, rollData, parseFormula } from "../module/scripts/dicegame.js";
import { poolRows, sortRows, defaultView, poolSummary, poolBody, pinRecent, dropNotice, poolUsers } from "../module/scripts/poolview.js";
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
document.body.classList.replace("theme-dark", `theme-${theme}`);

// The window the module would open for this state: its class and title.
const WINDOWS = { shop: ["lc-shop", "Crate Shop"], manager: ["lc-manager", "Loot Crates"], well: ["lc-reveal", "A coin in the well"], dice: ["lc-reveal", "Dragon's Teeth"] };
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
for (const [label, query] of [["shop", "state=shop"], ["spin", "state=spin"], ["landed", "state=landed"], ["landed, buyer", "state=landed&buyer=1"], ["missed", "state=landed&buyer=1&watched=0"], ["replay", "state=replay"], ["well", "state=well&buyer=1"], ["well, coin", "state=well&outcome=coin&buyer=1"], ["well, item", "state=well&outcome=item&buyer=1"], ["dice", "state=dice&buyer=1"], ["dice, lost", "state=dice&outcome=lose&buyer=1"], ["dice, prize", "state=dice&outcome=prize&buyer=1"], ["manager", "state=manager"]]) {
  const a = document.createElement("a");
  a.href = `?${query}&seed=${seed}&theme=${theme}`;
  a.textContent = label;
  if (query === `state=${state}${buyer ? "&buyer=1" : ""}${unwatched ? "&watched=0" : ""}`) a.classList.add("active");
  nav.append(a);
}
if (state !== "shop" && state !== "manager" && state !== "well" && state !== "dice") {
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
    // The in-game day and the log the well counts today's throws from.
    today: "y1d1", log: wellThrows(q.get("well") === "capped" ? WELL.rules.cap : 1),
    ...(waiting ? { busy: true, busyBox: BOXES[0].id, waiting } : {}), ...extra,
  };
  const fresh = document.createElement("div");
  fresh.className = "lc-shop__body";
  const notice = shopNotice(ctx);
  fresh.innerHTML = shopHTML({
    fields: `${actorPicker({ actors: characters, actorId: "tam", busy: !!ctx.busy })}
        <div class="lc-shop__field lc-shop__field--purse"><span class="lc-label">Purse</span><span class="lc-shop__purse">${formatGold(purse)}</span></div>`,
    cards: BOXES.map(b => cardFor(b, POOLS, ctx)).join(""),
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
      <nav class="lc-tabs"><div class="lc-tabs__list" role="tablist" aria-label="Loot Crates sections"><button type="button" role="tab" aria-selected="true" tabindex="0" class="active">Pools</button><button type="button" role="tab" aria-selected="false" tabindex="-1">Boxes</button><button type="button" role="tab" aria-selected="false" tabindex="-1">Pull log</button></div><span class="lc-tabs__spacer"></span><button type="button" class="lc-shop-toggle" data-open="true" aria-pressed="true">Shop open</button></nav>
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

if (state === "shop") renderShop();
else if (state === "manager") renderManager();
else if (state === "well") renderWell();
else if (state === "dice") renderDice();
else renderSpin();
