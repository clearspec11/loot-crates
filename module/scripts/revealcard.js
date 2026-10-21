/*
  The reveal's result block and where its window opens, with no Foundry in
  them, so the reveal window, the harness and Vitest share one format. The
  caller passes its own escape function (foundry.utils.escapeHTML in a world).

  After the spin the result says three things, in this order of loudness: the
  item's name in its rarity colour (the moment), its rarity, then one quiet
  line with where it went and, for the buyer and GMs only, the gold left.
*/
import { RARITY_LABEL, RARITIES } from "./config.js";
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
  if (canSee && reveal.purse) where.push(`<span class="lc-reveal__gold">${esc(formatGold(reveal.purse))} left</span>`);
  return `<div class="lc-reveal__name">${esc(res.name)}</div>`
    + `<div class="lc-reveal__rarity">${esc(RARITY_LABEL[res.rarity] ?? res.rarity)}${res.pity ? " · pity" : ""}</div>`
    + (where.length ? `<div class="lc-reveal__where">${where.join(" · ")}</div>` : "");
}

/*
  "Watch again": what a pull's chat card keeps so anyone at the table can
  replay the spin later (a hidden tab, a Skip, joining late). Display only:
  each card's name, art and rarity, where it lands, whether it teases, the
  odds ribbon, the crate and the result. No uuid, no granted item, no purse,
  so a replay can neither open the item nor say what gold is left. About 5 KB
  for a 48-card strip, stored once in the message's flags.
*/
export function replaySnapshot(reveal) {
  const strip = reveal?.strip;
  if (!Array.isArray(strip?.cards) || !strip.cards.length || !reveal.result) return null;
  return {
    strip: {
      cards: strip.cards.map(c => ({ name: String(c?.name ?? ""), img: String(c?.img ?? ""), rarity: c?.rarity, ...(c?.result ? { result: true } : {}) })),
      landIndex: strip.landIndex,
      nearMiss: !!strip.nearMiss,
    },
    odds: (reveal.odds ?? []).map(({ rarity, chance, label }) => ({ rarity, chance, label })),
    box: { name: String(reveal.box?.name ?? ""), price: reveal.box?.price ?? 0 },
    actorName: String(reveal.actorName ?? ""),
    result: { name: String(reveal.result.name ?? ""), rarity: reveal.result.rarity, pity: !!reveal.result.pity },
  };
}

const rarityOr = r => (RARITIES.includes(r) ? r : "common");

/*
  The reveal a replay window plays, from a stored snapshot, or null when the
  snapshot can't be played (anything can be in a message's flags). `key`
  names the window (the chat message's id), so a second Watch again on the
  same card brings the open replay forward instead of opening another.
*/
export function replayReveal(snapshot, key) {
  const cards = snapshot?.strip?.cards;
  const land = snapshot?.strip?.landIndex;
  if (!Array.isArray(cards) || !cards.length || !Number.isInteger(land) || land < 0 || land >= cards.length || !snapshot.result) return null;
  return {
    replay: true,
    replayKey: String(key ?? ""),
    actorName: String(snapshot.actorName ?? ""),
    box: { name: String(snapshot.box?.name ?? ""), price: Number(snapshot.box?.price) || 0 },
    odds: Array.isArray(snapshot.odds) ? snapshot.odds.filter(o => RARITIES.includes(o?.rarity) && Number.isFinite(o.chance)) : [],
    result: { name: String(snapshot.result.name ?? ""), rarity: rarityOr(snapshot.result.rarity), pity: !!snapshot.result.pity },
    strip: {
      cards: cards.map(c => ({ name: String(c?.name ?? ""), img: String(c?.img ?? ""), rarity: rarityOr(c?.rarity), ...(c?.result ? { result: true } : {}) })),
      landIndex: land,
      nearMiss: !!snapshot.strip.nearMiss,
    },
  };
}

// The replay window's title: says it is a replay, so nobody takes it for a
// second purchase.
export const replayTitle = reveal => `Replay: ${reveal.actorName} opens ${reveal.box.name}`;
export const replayWindowId = key => `loot-crates-reveal-replay-${key}`;

/*
  The reveal's buttons, in reading order. Open item (the buyer and GMs, once
  landed). Watch again (once landed, only on a client that didn't see the
  spin play out: it landed hidden or was skipped; it reads Skip while its
  replay plays). Then the one button that reads Skip and becomes Close.
  Watch again sits beside Close, not in the vault: it is an action on the
  window, like Close, and needs no new pattern.
*/
export const revealActionsHTML = () => `<div class="lc-reveal__actions">
        <button type="button" class="lc-reveal__open" data-action="openItem" hidden>Open item</button>
        <button type="button" class="lc-reveal__watch" data-action="watchAgain" hidden>Watch again</button>
        <button type="button" class="lc-reveal__close" data-action="skip">Skip</button>
      </div>`;
