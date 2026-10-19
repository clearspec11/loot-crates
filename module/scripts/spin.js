/*
  The crate-opening reveal: a strip of item cards scrolls past a centre marker,
  slows with an ease-out, overshoots the result by half a card when the next
  card outranks it, settles back, then the winning card lifts and glows.

  Pure DOM plus one requestAnimationFrame loop driving a single translateX.
  No Foundry globals, so the harness page can run it for screenshots.

    const spin = mountSpin(container, strip, { duration, reducedMotion, onTick, onLand });
    await spin.play();
*/
import { RARITY_LABEL } from "./config.js";

export const CARD_WIDTH = 120;
export const CARD_GAP = 8;
export const DEFAULT_DURATION = 6200;

const easeOutCubic = p => 1 - Math.pow(1 - p, 3);
const easeInOutQuad = p => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

export function cardElement(card) {
  const el = document.createElement("div");
  el.className = `lc-card lc-rarity-${card.rarity}${card.result ? " lc-card--result" : ""}`;
  el.dataset.rarity = card.rarity;
  const art = document.createElement("div");
  art.className = "lc-card__art";
  if (card.img) {
    const img = document.createElement("img");
    img.src = card.img;
    img.alt = "";
    img.draggable = false;
    art.appendChild(img);
  } else {
    art.textContent = (card.name ?? "?").slice(0, 2).toUpperCase();
  }
  const name = document.createElement("div");
  name.className = "lc-card__name";
  name.textContent = card.name ?? "";
  const bar = document.createElement("div");
  bar.className = "lc-card__bar";
  bar.title = RARITY_LABEL[card.rarity] ?? card.rarity;
  el.append(art, name, bar);
  return el;
}

export function mountSpin(container, strip, options = {}) {
  const duration = options.duration ?? DEFAULT_DURATION;
  const reducedMotion = options.reducedMotion ?? (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const cardWidth = options.cardWidth ?? CARD_WIDTH;
  const gap = options.cardGap ?? CARD_GAP;
  const step = cardWidth + gap;

  container.classList.add("lc-spin");
  container.innerHTML = "";
  const viewport = document.createElement("div");
  viewport.className = "lc-spin__viewport";
  const track = document.createElement("div");
  track.className = "lc-spin__track";
  track.style.setProperty("--lc-card-w", `${cardWidth}px`);
  track.style.setProperty("--lc-card-gap", `${gap}px`);
  const marker = document.createElement("div");
  marker.className = "lc-spin__marker";
  marker.setAttribute("aria-hidden", "true");
  const cards = strip.cards.map(cardElement);
  track.append(...cards);
  viewport.append(track, marker);
  container.append(viewport);

  // Centre of the landing card must end under the marker (viewport centre).
  const target = () => strip.landIndex * step + cardWidth / 2 - viewport.clientWidth / 2;
  const setX = x => { track.style.transform = `translate3d(${-x}px, 0, 0)`; };
  const start = () => Math.max(0, Math.min(2, strip.landIndex) * step - viewport.clientWidth / 2);

  let lastIndex = -1;
  const tick = x => {
    const index = Math.floor((x + viewport.clientWidth / 2) / step);
    if (index !== lastIndex) {
      lastIndex = index;
      options.onTick?.(index, strip.cards[index]);
    }
  };

  const land = () => {
    const el = cards[strip.landIndex];
    el.classList.add("lc-card--landed");
    container.classList.add("lc-spin--landed");
    container.dataset.rarity = strip.cards[strip.landIndex].rarity;
    options.onLand?.(strip.cards[strip.landIndex]);
  };

  // Phase 1 (most of the time): ease out to the target plus the overshoot.
  // Phase 2: settle back. The overshoot is the near-miss: half a card past
  // the result, so the better card next door sits under the marker for a beat.
  const overshoot = strip.nearMiss ? cardWidth * 0.55 : cardWidth * 0.18;
  const split = 0.86;

  function play() {
    const x0 = start();
    const x1 = target();
    setX(x0);
    if (reducedMotion || duration <= 0) {
      setX(x1);
      land();
      return Promise.resolve();
    }
    return new Promise(resolve => {
      const t0 = performance.now();
      const frame = now => {
        const p = Math.min(1, (now - t0) / duration);
        let x;
        if (p < split) {
          x = x0 + (x1 + overshoot - x0) * easeOutCubic(p / split);
        } else {
          x = x1 + overshoot - overshoot * easeInOutQuad((p - split) / (1 - split));
        }
        setX(x);
        tick(x);
        if (p < 1) requestAnimationFrame(frame);
        else { setX(x1); land(); resolve(); }
      };
      requestAnimationFrame(frame);
    });
  }

  return { play, viewport, track, cards };
}
