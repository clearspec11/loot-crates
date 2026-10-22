/*
  The crate: the first kind of game (kinds.js), and the one every record
  without a `kind` is. The GM prices a box that draws an item from pools at
  rarity odds with pity, stock and no-duplicates rules; the reveal is the
  CS:GO-style strip (strip.js, spin.js) with the tick, brake and sting
  sounds, and the chat card names the item. The money path, the log, the
  refund and the hold are the core's (pull.js, socket.js, refund.js,
  reveal.js); this file only decides the item and shows it.

  No Foundry globals: the core passes resolveSource (fromUuid in a world),
  so Vitest runs the roll as it is.
*/
import { RARITIES, RARITY_LABEL } from "./config.js";
import { draw, nextState, markEntriesMissing, shopOdds, resetsPity, undoPull } from "./odds.js";
import { buildStrip } from "./strip.js";
import { mountSpin } from "./spin.js";
import { playTick, playSlow, playReveal } from "./sound.js";
import { resultHTML } from "./revealcard.js";
import { boxCard, buyReason } from "./boxcard.js";
import { formatPrice } from "./currency.js";
import { PullError, registerKind } from "./kinds.js";

// A source's own rarities as stored: dnd5e 6's set (an array once copied, more
// than one for a "Varies" item), dnd5e 5's string, or none.
export function sourceRaritiesOf(data) {
  const sys = data?.system ?? {};
  if (Array.isArray(sys.rarities)) return [...sys.rarities];
  if (sys.rarities instanceof Set) return [...sys.rarities];
  return typeof sys.rarity === "string" && sys.rarity ? [sys.rarity] : [];
}

/*
  `onMissing(entry)` is told about a rolled entry whose source turned out to be
  gone (the socket handler marks it in the pool setting and warns the GM).
  The caller is expected to have swept the box for dead sources already, so
  this only happens when one vanished in between: the entry is excluded and the
  roll is made again, up to MAX_REDRAWS times. Nothing is charged until a live
  source is in hand. The pools the roll was finally made from (any lost entry
  marked missing) come back as `pools`, so the reveal shows the odds of that
  roll even when onMissing couldn't save the mark.

  drawItem is the draw and the resolving, shared with every kind that hands
  out an item from a pool (the Wishing Well's rare find, well.js): it
  resolves to { result, source, pools }, with result null when the box has
  nothing to give, and throws only when every entry it drew was dead.
*/
const MAX_REDRAWS = 3;
export async function drawItem({ game: box, pools, state = {}, rng, resolveSource, onMissing = null }) {
  let result = draw({ box, pools, rng, state });
  let source = result && await resolveSource(result.entry.uuid);
  let lost = null;
  for (let redraws = 0; result && !source; redraws++) {
    lost = result.entry;
    await onMissing?.(lost);
    if (redraws === MAX_REDRAWS) throw new PullError(`${lost.name} is missing from its compendium. Tell the GM.`);
    console.warn(`loot-crates | ${lost.name} (${lost.uuid}) in pool ${lost.poolId} has no source; excluding it and rolling again`);
    pools = markEntriesMissing(pools, lost.poolId, [lost.uuid], true);
    result = draw({ box, pools, rng, state });
    source = result && await resolveSource(result.entry.uuid);
  }
  // Every entry left was dead: say so rather than "nothing left".
  if (!result && lost) throw new PullError(`${lost.name} is missing from its compendium. Tell the GM.`);
  return { result, source, pools };
}

/*
  The Item data to put on the buyer's sheet for a drawn entry, from its
  resolved source: the source's own rarity is kept on the copy and in the
  log when the GM's differs, so a Legendary rope can be traced back to an
  Uncommon one. Shared with every kind that grants an item (well.js).
*/
export function grantData(source, result, box) {
  const data = source.toObject();
  const sourceRarity = sourceRaritiesOf(data);
  const overridden = RARITIES.includes(result.entry.rarityOverride);
  delete data._id;
  delete data.folder;
  const marks = { boxId: box.id, sourceUuid: result.entry.uuid, at: Date.now() };
  // A rarity the GM set in the pool editor is the one the reveal and chat
  // announce, so the copy on the sheet says it too (one value, never a
  // "Varies" set). dnd5e 6 stores a set, system.rarities (system.rarity is
  // a getter on it); dnd5e 5 a string. An unedited entry keeps its source's.
  if (overridden) {
    data.system ??= {};
    if (Array.isArray(data.system.rarities)) data.system.rarities = [result.rarity];
    else data.system.rarity = result.rarity;
    marks.sourceRarity = sourceRarity;
    marks.rarityOverride = true;
  }
  data.flags = { ...(data.flags ?? {}), "loot-crates": marks };
  // Foundry's provenance convention for a copy taken from a compendium.
  if (source.pack || String(source.uuid ?? "").startsWith("Compendium.")) {
    data._stats = { ...(data._stats ?? {}), compendiumSource: source.uuid };
  }
  return {
    result: { uuid: result.entry.uuid, name: source.name, img: source.img, rarity: result.rarity, pity: result.pity },
    grant: data,
    sourceRarity,
    rarityOverride: overridden,
  };
}

async function roll(ctx) {
  const { game: box, actor } = ctx;
  const { result, source, pools } = await drawItem(ctx);
  if (!result) throw new PullError(`${box.name} has nothing left to give ${actor.name}.`);
  const strip = buildStrip({ result, box, pools, rng: ctx.rng, state: ctx.state ?? {} });
  return { ...grantData(source, result, box), strip, state: nextState(box, ctx.state ?? {}, result), pools };
}

// The pull log's own columns: what dropped, at what rarity, and what the
// refund needs to undo the pity count and no-duplicates record (odds.js
// undoPull). Provenance for a GM-set rarity: the source's own, only when it
// differs.
export function crateLogRow({ game: box, state, out }) {
  const row = { name: out.result.name, uuid: out.result.uuid, rarity: out.result.rarity, pity: out.result.pity, before: { sinceRare: state.sinceRare ?? 0, hadItem: (state.owned ?? []).includes(out.result.uuid) }, resetPity: resetsPity(box, out.result.rarity) };
  const src = out.sourceRarity ?? [];
  if (out.rarityOverride && !(src.length === 1 && src[0] === out.result.rarity)) row.sourceRarity = src;
  return row;
}

// The odds are the ones this roll was made at: the buyer's state before
// it, and the pools the roll drew from, so an entry that went missing
// mid-pull isn't counted even if marking it in the setting failed.
// stateBefore is the buyer's pity and owned record before this pull: a
// client whose spin is still playing shows the shop from it until the
// spin lands (reveal.js heldState), since the new state is written
// just after this and would tell the result early.
function revealExtra({ game: box, state, out }) {
  return {
    odds: shopOdds(box, out.pools, state).rows.map(({ rarity, chance, label }) => ({ rarity, chance, label })),
    stateBefore: { sinceRare: state.sinceRare ?? 0, owned: [...(state.owned ?? [])], pulls: state.pulls ?? 0 },
  };
}

// The strip's tick for each card that passes the marker, one voice per
// mount. On a near-miss the card past the result is a tease, and the next
// tick back on the result is the drop back; every other tick falls in pitch
// with progress as before.
export function stripVoice(strip) {
  let teased = false;
  return index => {
    if (strip.nearMiss && index === strip.landIndex + 1) {
      teased = true;
      playTick(1, { tease: true });
    } else if (teased && index === strip.landIndex) {
      teased = false;
      playTick(1, { back: true });
    } else playTick(index / strip.landIndex);
  };
}

/*
  The spin in the reveal window's host, with its sounds. The braking sweep
  starts with the ease-out and lasts until the strip turns back, both read
  from the spin's own frames; a strip that lands early (Skip, Close, hidden)
  cuts the sweep with it. The sting is the core's call (sting below), once
  the result is shown.
*/
function play(host, reveal, { sound = false, pageHidden = () => false, onLand }) {
  let sweep = null;
  return mountSpin(host, reveal.strip, {
    onTick: sound ? stripVoice(reveal.strip) : null,
    onPhase: sound ? (phase, { settleIn }) => { if (phase === "brake" && !pageHidden()) sweep = playSlow(settleIn); } : null,
    onLand: () => {
      sweep?.();
      sweep = null;
      onLand();
    },
  });
}

// Foundry's own content link (what @UUID[...]{name} enriches to), written out
// so the stored message carries it: it looks like every other link in chat,
// opens the sheet on click and drags onto a sheet. Points at the granted copy
// in the buyer's inventory, or at the pool's source when there isn't one.
function chatCard(reveal, { esc, itemLink }) {
  const r = reveal.result;
  return `
    <div class="loot-crates lc-chat lc-rarity-${esc(r.rarity)}">
      <div class="lc-chat__head">${esc(reveal.actorName)} opened <strong>${esc(reveal.box.name)}</strong> <span class="lc-chat__price">${esc(formatPrice(reveal.box.price))}</span></div>
      <div class="lc-chat__item">
        <img src="${esc(r.img)}" alt="">
        <div>
          <div class="lc-chat__name">${itemLink(reveal.itemUuid ?? r.uuid, r.name)}</div>
          <div class="lc-chat__rarity">${esc(RARITY_LABEL[r.rarity] ?? r.rarity)}${r.pity ? " · pity" : ""}</div>
        </div>
      </div>
    </div>`;
}

export const CRATE = registerKind({
  id: "crate",
  noun: "crate",
  roll,
  logRow: crateLogRow,
  revealExtra,
  undo: undoPull,
  reveal: {
    title: "Opening a crate",
    play,
    result: resultHTML,
    sting: reveal => playReveal(reveal.result.rarity),
    replayable: true,
  },
  chat: { card: chatCard },
  shop: {
    card: boxCard,
    reason: (box, pools, ctx) => buyReason(box, shopOdds(box, pools, ctx.stateOf?.(box.id) ?? {}), ctx),
  },
});
