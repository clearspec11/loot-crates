/*
  The reveal's result block and where its window opens, with no Foundry in
  them, so the reveal window, the harness and Vitest share one format. The
  caller passes its own escape function (foundry.utils.escapeHTML in a world).

  After the spin the result says three things, in this order of loudness: the
  item's name in its rarity colour (the moment), its rarity, then one quiet
  line with where it went and, for the buyer and GMs only, the gold left.
*/
import { RARITY_LABEL } from "./config.js";
import { formatGold } from "./currency.js";

export const REVEAL_WIDTH = 720;
// The reveal's rendered height in cc-dev at 1440x900, used only to centre the
// first window before it has been measured.
export const REVEAL_HEIGHT = 384;
export const CASCADE_STEP = 32;
export const CASCADE_WRAP = 4;
const GUTTER = 16;
// How long after landing a click on the button (now Close) is still taken as
// the tail of a Skip.
export const CLOSE_GRACE_MS = 500;

// The lowest cascade slot no open reveal holds; when all are taken, the
// next one round (slots wrap at CASCADE_WRAP anyway).
export function freeSlot(used = []) {
  const taken = new Set(used.filter(Number.isInteger).map(n => n % CASCADE_WRAP));
  for (let k = 0; k < CASCADE_WRAP; k++) if (!taken.has(k)) return k;
  return used.length;
}

/*
  Where the nth open reveal window goes in a viewport { width, height }: the
  first centred, each later one 32px down and right of the last, starting over
  at the fifth, never wider than the viewport less a 16px gutter each side and
  never past its edges. Two pulls a second apart no longer open on top of
  each other, and a half-width Foundry tab doesn't cut the window off.
*/
export function cascadeOffset(n, viewport, { width: want = REVEAL_WIDTH, height = REVEAL_HEIGHT } = {}) {
  const vw = Math.max(0, viewport?.width ?? 0);
  const vh = Math.max(0, viewport?.height ?? 0);
  const width = Math.max(0, Math.min(want, vw - 2 * GUTTER));
  const k = ((Math.floor(n) || 0) % CASCADE_WRAP + CASCADE_WRAP) % CASCADE_WRAP;
  const step = CASCADE_STEP * k;
  const clamp = (v, max) => Math.max(0, Math.min(v, Math.max(0, max)));
  return {
    width,
    left: Math.round(clamp((vw - width) / 2 + step, vw - width)),
    top: Math.round(clamp((vh - height) / 2 + step, vh - height)),
  };
}

// The buyer and GMs see the purse; the rest of the table sees only the item.
export function canSeePurse(reveal, viewer = {}) {
  return !!viewer.isGM || (!!reveal?.userId && reveal.userId === viewer.userId);
}

export function resultHTML(reveal, { esc = String, canSee = false } = {}) {
  const res = reveal.result;
  const where = [];
  if (reveal.itemUuid) where.push(`Added to ${esc(reveal.actorName)}'s inventory`);
  if (canSee && reveal.purse) where.push(`${esc(formatGold(reveal.purse))} left`);
  return `<div class="lc-reveal__name">${esc(res.name)}</div>`
    + `<div class="lc-reveal__rarity">${esc(RARITY_LABEL[res.rarity] ?? res.rarity)}${res.pity ? " · pity" : ""}</div>`
    + (where.length ? `<div class="lc-reveal__where">${where.join(" · ")}</div>` : "");
}
