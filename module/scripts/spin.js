/*
  The crate-opening reveal: a strip of item cards picks up speed, runs past a
  centre marker at a constant speed for a beat (the cards blur, the tick
  rattles), slows with a long ease-out, overshoots into the next card when it outranks the
  result (the marker sits a quarter into it, then clicks back), settles, then
  the winning card lifts out of the strip, ringed in its rarity colour.

  Pure DOM plus one requestAnimationFrame loop driving a single translateX.
  No Foundry globals, so the harness page can run it for screenshots.

    const spin = mountSpin(container, strip, { duration, reducedMotion, onTick, onLand });
    await spin.play();
    spin.skip();   // land on the next frame, through the same land() path

  The strip is aria-hidden: a screen reader would otherwise read every filler
  card's name before the result the host announces.
*/
import { RARITY_LABEL } from "./config.js";

export const CARD_WIDTH = 120;
export const CARD_GAP = 8;
export const DEFAULT_DURATION = 6200;

const easeOutCubic = p => 1 - Math.pow(1 - p, 3);

// The run to the overshoot point, as shares of its time: a short linear
// run-up, a cruise at full speed, then the cubic ease-out. With the 86% split
// below the cruise is about 39% of the whole spin.
export const SPIN_ACCEL = 0.07;
export const SPIN_CRUISE = 0.45;

/* Share of the distance covered at share p of the run's time. Velocity is
   continuous: it ramps from 0 to v, holds v, and the ease-out starts at v
   (cubic ease-out's initial slope is 3, over a third of the distance it
   covers per unit time) and ends at 0. v is whatever makes the total 1. */
export function spinDistance(p, accel = SPIN_ACCEL, cruise = SPIN_CRUISE) {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const decel = 1 - accel - cruise;
  const v = 1 / (accel / 2 + cruise + decel / 3);
  if (p < accel) return v * p * p / (2 * accel);
  if (p < accel + cruise) return v * (accel / 2 + p - accel);
  return v * (accel / 2 + cruise + (decel / 3) * easeOutCubic((p - accel - cruise) / decel));
}

const easeInOutQuad = p => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

// How far past the result's centre the marker travels on a near-miss: out of
// the result card, across the gap, and a quarter of the way into the tease.
export const nearMissOvershoot = (cardWidth = CARD_WIDTH, gap = CARD_GAP) => cardWidth / 2 + gap + cardWidth * 0.25;

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
  track.setAttribute("aria-hidden", "true");
  const marker = document.createElement("div");
  marker.className = "lc-spin__marker";
  marker.setAttribute("aria-hidden", "true");
  const cards = strip.cards.map(cardElement);
  track.append(...cards);
  viewport.append(track, marker);
  container.append(viewport);

  // Centre of the landing card must end under the marker (viewport centre).
  // The width is read every frame, never cached: the window that hosts the
  // spin is sized after its first frame (ApplicationV2 applies position.width
  // once rendered) and can be dragged or resized mid-spin, and the one promise
  // the marker makes is that what sits under it is what you got.
  const width = () => viewport.clientWidth;
  const target = w => strip.landIndex * step + cardWidth / 2 - w / 2;
  const start = w => Math.max(0, Math.min(2, strip.landIndex) * step - w / 2);
  const setX = x => { track.style.transform = `translate3d(${-x}px, 0, 0)`; };

  let lastIndex = -1;
  const tick = (x, w) => {
    const index = Math.floor((x + w / 2) / step);
    if (index !== lastIndex) {
      lastIndex = index;
      options.onTick?.(index, strip.cards[index]);
    }
  };

  let landed = false;
  let skipped = false;
  const land = () => {
    if (landed) return;
    landed = true;
    const el = cards[strip.landIndex];
    el.classList.add("lc-card--landed");
    container.classList.add("lc-spin--landed");
    container.dataset.rarity = strip.cards[strip.landIndex].rarity;
    // Once landed, keep the result under the marker whatever happens to the
    // window: a late size, a drag onto another monitor, a reduced-motion land
    // on a viewport that had no width yet.
    if (typeof ResizeObserver === "function") new ResizeObserver(() => setX(target(width()))).observe(viewport);
    options.onLand?.(strip.cards[strip.landIndex]);
  };

  // Phase 1 (most of the time): run up, cruise, then ease out to the target
  // plus the overshoot (spinDistance).
  // Phase 2: settle back. On a near-miss the overshoot crosses the boundary
  // into the better card (half the result card plus the gap) and goes a
  // quarter card further, so the teased card really sits under the marker for
  // a beat, onTick fires for it, and the settle crosses back with a click.
  // Otherwise the overshoot stays inside the result card.
  const overshoot = strip.nearMiss ? nearMissOvershoot(cardWidth, gap) : cardWidth * 0.18;
  const split = 0.86;
  const MAX_UNSIZED_FRAMES = 10;

  function play() {
    setX(start(width()));
    if (reducedMotion || duration <= 0 || skipped) {
      setX(target(width()));
      land();
      return Promise.resolve();
    }
    return new Promise(resolve => {
      let t0 = null;
      let unsized = 0;
      const frame = now => {
        const w = width();
        // Don't start the clock on a viewport that has no width yet, or the
        // first sized frame is a jump; give up waiting after a few frames so a
        // hidden host still lands.
        if (!w && !skipped && unsized++ < MAX_UNSIZED_FRAMES) { requestAnimationFrame(frame); return; }
        t0 ??= now;
        const x0 = start(w);
        const x1 = target(w);
        // Skip is the clock running out early: the same frame, the same land.
        const p = skipped ? 1 : Math.min(1, (now - t0) / duration);
        let x;
        if (p < split) {
          x = x0 + (x1 + overshoot - x0) * spinDistance(p / split);
        } else {
          x = x1 + overshoot - overshoot * easeInOutQuad((p - split) / (1 - split));
        }
        setX(x);
        tick(x, w);
        if (p < 1) requestAnimationFrame(frame);
        else { setX(target(width())); land(); resolve(); }
      };
      requestAnimationFrame(frame);
    });
  }

  // Ends the spin on the next frame. Before play() it makes play() land at
  // once; after landing it does nothing.
  function skip() { skipped = true; }

  return { play, skip, viewport, track, cards, get landed() { return landed; } };
}
