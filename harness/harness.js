/*
  Runs the module's pure scripts outside Foundry with sample data, so the shop
  and the spin can be looked at and screenshotted without a world.

  ?state=shop | spin | landed     ?seed=<n>     ?duration=<ms>
  "landed" plays the spin at zero duration, for deterministic screenshots.
*/
import { POOLS, BOX, BOXES } from "./sample.js";
import { draw, seededRng } from "../module/scripts/odds.js";
import { buildStrip } from "../module/scripts/strip.js";
import { mountSpin } from "../module/scripts/spin.js";
import { RARITY_LABEL } from "../module/scripts/config.js";
import { formatPrice } from "../module/scripts/currency.js";
import { boxCard } from "../module/scripts/boxcard.js";

const q = new URLSearchParams(location.search);
const state = q.get("state") ?? "shop";
const seed = Number(q.get("seed") ?? 7);
const duration = q.has("duration") ? Number(q.get("duration")) : state === "landed" ? 0 : undefined;
const purse = { pp: 0, gp: 420, ep: 0, sp: 7, cp: 3 };

const nav = document.getElementById("nav");
for (const s of ["shop", "spin", "landed"]) {
  const a = document.createElement("a");
  a.href = `?state=${s}&seed=${seed}`;
  a.textContent = s;
  if (s === state) a.classList.add("active");
  nav.append(a);
}

const stage = document.getElementById("stage");

function renderShop() {
  stage.innerHTML = `
    <div class="lc-shop__body">
      <div class="lc-shop__head"><span class="lc-shop__who">Tam Thornwick</span><span class="lc-shop__purse">420 gp</span></div>
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
  stage.innerHTML = `
    <div class="lc-reveal__body">
      <div class="lc-reveal__head"><span class="lc-reveal__who">Tam Thornwick</span> opens <strong>${box.name}</strong> <span class="lc-reveal__price">${formatPrice(box.price)}</span></div>
      <div class="lc-reveal__spin"></div>
      <div class="lc-reveal__result" aria-live="polite"></div>
      <div class="lc-reveal__actions"><button type="button" id="again">Open another</button></div>
    </div>`;
  const out = stage.querySelector(".lc-reveal__result");
  const spin = mountSpin(stage.querySelector(".lc-reveal__spin"), strip, {
    duration,
    reducedMotion: duration === 0,
    onLand: card => { out.innerHTML = `<div class="lc-reveal__name">${card.name}</div><div class="lc-reveal__rarity">${RARITY_LABEL[card.rarity]}${result.pity ? " · pity" : ""}</div>`; },
  });
  document.getElementById("again").addEventListener("click", () => { location.search = `?state=spin&seed=${seed + 1}&box=${box.id}`; });
  await spin.play();
  document.body.dataset.landed = "1";
  window.__lootCrates = { result, strip };
}

if (state === "shop") renderShop();
else renderSpin();
