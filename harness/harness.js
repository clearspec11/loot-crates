/*
  Runs the module's pure scripts outside Foundry with sample data, so the shop
  and the spin can be looked at and screenshotted without a world.

  ?state=shop | spin | landed | manager     ?seed=<n>     ?duration=<ms>     ?buyer=1
  ?theme=dark | light (Foundry's two themes; dark by default)
  ?waiting=gm | hidden (shop: the first crate pressed and the GM slow to answer)
  ?closed=1 (shop: closed because no GM is online; ?closed=gm, closed by the GM)
  "landed" plays the spin at zero duration, for deterministic screenshots.
  buyer=1 shows the reveal as the buyer (or a GM) sees it: gold left and an
  Open item button; without it, as the rest of the table sees it.
  "manager" is the pool editor's Pools tab (poolview.js), with chips and
  open/close working; search, edits and Show more need Foundry.
*/
import { POOLS, BOX, BOXES, MANAGER_POOLS, MANAGER_SOURCES } from "./sample.js";
import { poolRows, sortRows, defaultView, poolSummary, poolBody } from "../module/scripts/poolview.js";
import { draw, seededRng } from "../module/scripts/odds.js";
import { buildStrip } from "../module/scripts/strip.js";
import { mountSpin } from "../module/scripts/spin.js";
import { charge, formatPrice, formatGold } from "../module/scripts/currency.js";
import { resultHTML } from "../module/scripts/revealcard.js";
import { boxCard, oddsRibbon, shopHTML, shopNotice, patchShop } from "../module/scripts/boxcard.js";
import { shopOdds } from "../module/scripts/odds.js";

const q = new URLSearchParams(location.search);
const state = q.get("state") ?? "shop";
const seed = Number(q.get("seed") ?? 7);
const duration = q.has("duration") ? Number(q.get("duration")) : state === "landed" ? 0 : undefined;
const purse = { pp: 0, gp: 420, ep: 0, sp: 7, cp: 3 };
const buyer = q.get("buyer") === "1";
const waiting = q.get("waiting");
const closed = q.get("closed");
const theme = q.get("theme") === "light" ? "light" : "dark";
document.body.classList.replace("theme-dark", `theme-${theme}`);

// The window the module would open for this state: its class and title.
const WINDOWS = { shop: ["lc-shop", "Crate Shop"], manager: ["lc-manager", "Loot Crates"] };
const [appClass, appTitle] = WINDOWS[state] ?? ["lc-reveal", "Opening a crate"];
document.getElementById("app").classList.add(appClass);
document.getElementById("title").textContent = appTitle;
// Font Awesome isn't loaded here; this stands in for the shop's fa-box-open.
const CRATE_ICON = `<svg class="lc-box__icon" viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3 8.5 12 4l9 4.5v8L12 21l-9-4.5z"/><path d="M3 8.5 12 13l9-4.5M12 13v8"/></svg>`;

const nav = document.getElementById("nav");
for (const [label, query] of [["shop", "state=shop"], ["spin", "state=spin"], ["landed", "state=landed"], ["landed, buyer", "state=landed&buyer=1"], ["manager", "state=manager"]]) {
  const a = document.createElement("a");
  a.href = `?${query}&seed=${seed}&theme=${theme}`;
  a.textContent = label;
  if (query === `state=${state}${buyer ? "&buyer=1" : ""}`) a.classList.add("active");
  nav.append(a);
}
if (state !== "shop" && state !== "manager") {
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
function renderShop(extra = {}) {
  const ctx = {
    purse, hasActor: true, open: !closed, gmOnline: closed !== "1", art: CRATE_ICON,
    ...(waiting ? { busy: true, busyBox: BOXES[0].id, waiting } : {}), ...extra,
  };
  const fresh = document.createElement("div");
  fresh.className = "lc-shop__body";
  const notice = shopNotice(ctx);
  fresh.innerHTML = shopHTML({
    fields: `<div class="lc-shop__field"><span class="lc-label">Character</span><span class="lc-shop__who">Tam Thornwick</span></div>
        <div class="lc-shop__field lc-shop__field--purse"><span class="lc-label">Purse</span><span class="lc-shop__purse">${formatGold(purse)}</span></div>`,
    cards: BOXES.map(b => boxCard(b, POOLS, ctx)).join(""),
    notice,
  });
  patchShop(stage, fresh, notice);
  stage.querySelectorAll(".lc-box__buy:not([disabled])").forEach(btn => btn.addEventListener("click", () => { location.search = `?state=spin&seed=${Date.now() % 100000}&box=${btn.dataset.box}&buyer=1&theme=${theme}`; }));
  window.__lootCrates = { renderShop };
}

async function renderSpin() {
  const rng = seededRng(seed);
  const box = BOXES.find(b => b.id === q.get("box")) ?? BOX;
  const result = draw({ box, pools: POOLS, rng, state: {} });
  const strip = buildStrip({ result, box, pools: POOLS, rng });
  // The same markup and result block as reveal.js, with sample ids standing
  // in for the granted item.
  const reveal = { actorName: "Tam Thornwick", userId: "buyer", itemUuid: "Actor.sample.Item.sample", purse: charge(purse, box.price) ?? {}, result: { name: result.entry.name, rarity: result.rarity, pity: result.pity } };
  stage.innerHTML = `
    <div class="lc-reveal__body">
      <div class="lc-reveal__head"><span class="lc-reveal__who">Tam Thornwick</span> opens <strong class="lc-reveal__crate">${box.name}</strong> <span class="lc-reveal__price">${formatPrice(box.price)}</span></div>
      <div class="lc-vault lc-rarity-${result.rarity}">
        ${oddsRibbon(shopOdds(box, POOLS).rows)}
        <div class="lc-reveal__spin"></div>
        <div class="lc-reveal__result lc-rarity-${result.rarity}" aria-live="polite"></div>
      </div>
      <div class="lc-reveal__actions">
        <button type="button" class="lc-reveal__open" hidden>Open item</button>
        <button type="button" class="lc-reveal__close">Skip</button>
      </div>
    </div>`;
  const out = stage.querySelector(".lc-reveal__result");
  const btn = stage.querySelector(".lc-reveal__close");
  const open = stage.querySelector(".lc-reveal__open");
  let landed = false;
  const spin = mountSpin(stage.querySelector(".lc-reveal__spin"), strip, {
    duration,
    reducedMotion: duration === 0,
    onLand: () => {
      landed = true;
      out.innerHTML = resultHTML(reveal, { canSee: buyer });
      open.hidden = !buyer;
      btn.textContent = "Close";
      btn.focus({ preventScroll: true });
    },
  });
  btn.addEventListener("click", () => { if (landed) location.search = `?state=shop&theme=${theme}`; else spin.skip(); });
  await spin.play();
  document.body.dataset.landed = "1";
  window.__lootCrates = { result, strip };
}

// The pool editor with sample pools. The compendium pool is shown open (as a
// GM who opened it sees it); the 200-entry one keeps its collapsed default.
function renderManager() {
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const srcOf = e => MANAGER_SOURCES.has(e.uuid) ? MANAGER_SOURCES.get(e.uuid) : { name: e.name, img: e.img, rarity: e.sourceRarity || null, rawRarity: e.sourceRarity ?? null };
  const views = new Map(MANAGER_POOLS.map(p => [p.id, { ...defaultView(p), open: p.id === "compendium" ? true : defaultView(p).open }]));
  const rowsOf = p => sortRows(poolRows(p, srcOf));
  stage.innerHTML = `
    <div class="lc-manager__body">
      <nav class="lc-tabs"><button type="button" class="active">Pools</button><button type="button">Boxes</button><button type="button">Pull log</button><span class="lc-tabs__spacer"></span><button type="button" class="lc-shop-toggle" data-open="true" aria-pressed="true">Shop open</button></nav>
      <section class="lc-tab">
        <div class="lc-toolbar"><button type="button"><i class="fas fa-plus"></i> New pool</button><span class="lc-pool__hint lc-manager__status" role="status"></span></div>
        ${MANAGER_POOLS.map(p => `
        <article class="lc-pool" data-drop-pool="${esc(p.id)}">
          <details class="lc-pool__details" data-pool="${esc(p.id)}"${views.get(p.id).open ? " open" : ""}>
            ${poolSummary(p, rowsOf(p), esc)}
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
  document.body.dataset.ready = "1";
}

if (state === "shop") renderShop();
else if (state === "manager") renderManager();
else renderSpin();
