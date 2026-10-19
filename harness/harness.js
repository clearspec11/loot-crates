/*
  Runs the module's pure scripts outside Foundry with sample data, so the shop
  and the spin can be looked at and screenshotted without a world.

  ?state=shop | spin | landed     ?seed=<n>     ?duration=<ms>     ?buyer=1
  "landed" plays the spin at zero duration, for deterministic screenshots.
  buyer=1 shows the reveal as the buyer (or a GM) sees it: gold left and an
  Open item button; without it, as the rest of the table sees it.
*/
import { POOLS, BOX, BOXES } from "./sample.js";
import { draw, seededRng } from "../module/scripts/odds.js";
import { buildStrip } from "../module/scripts/strip.js";
import { mountSpin } from "../module/scripts/spin.js";
import { charge, formatPrice, formatGold } from "../module/scripts/currency.js";
import { resultHTML } from "../module/scripts/revealcard.js";
import { boxCard } from "../module/scripts/boxcard.js";

const q = new URLSearchParams(location.search);
const state = q.get("state") ?? "shop";
const seed = Number(q.get("seed") ?? 7);
const duration = q.has("duration") ? Number(q.get("duration")) : state === "landed" ? 0 : undefined;
const purse = { pp: 0, gp: 420, ep: 0, sp: 7, cp: 3 };
const buyer = q.get("buyer") === "1";

const nav = document.getElementById("nav");
for (const [label, query] of [["shop", "state=shop"], ["spin", "state=spin"], ["landed", "state=landed"], ["landed, buyer", "state=landed&buyer=1"]]) {
  const a = document.createElement("a");
  a.href = `?${query}&seed=${seed}`;
  a.textContent = label;
  if (query === `state=${state}${buyer ? "&buyer=1" : ""}`) a.classList.add("active");
  nav.append(a);
}
if (state !== "shop") {
  const again = document.createElement("a");
  again.href = `?state=spin&seed=${seed + 1}${q.has("box") ? `&box=${q.get("box")}` : ""}${buyer ? "&buyer=1" : ""}`;
  again.textContent = "open another";
  nav.append(again);
}

const stage = document.getElementById("stage");

function renderShop() {
  stage.innerHTML = `
    <div class="lc-shop__body">
      <div class="lc-shop__head"><span class="lc-shop__who">Tam Thornwick</span><span class="lc-shop__purse">${formatGold(purse)}</span></div>
      <div class="lc-shop__grid">
        ${BOXES.map(b => boxCard(b, POOLS, { purse, hasActor: true, open: true, art: "▣" })).join("")}
      </div>
    </div>`;
  stage.querySelectorAll(".lc-box__buy:not([disabled])").forEach(btn => btn.addEventListener("click", () => { location.search = `?state=spin&seed=${Date.now() % 100000}&box=${btn.dataset.box}`; }));
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
      <div class="lc-reveal__head"><span class="lc-reveal__who">Tam Thornwick</span> opens <strong>${box.name}</strong> <span class="lc-reveal__price">${formatPrice(box.price)}</span></div>
      <div class="lc-reveal__spin"></div>
      <div class="lc-reveal__result lc-rarity-${result.rarity}" aria-live="polite"></div>
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
  btn.addEventListener("click", () => { if (landed) location.search = "?state=shop"; else spin.skip(); });
  await spin.play();
  document.body.dataset.landed = "1";
  window.__lootCrates = { result, strip };
}

if (state === "shop") renderShop();
else renderSpin();
