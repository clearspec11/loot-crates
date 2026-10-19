/*
  The row of cards that scrolls past the marker. It is built around a result
  that was already rolled, so the animation cannot disagree with the roll.
  Fillers are real entries from the box's pools, drawn with the box's odds, so
  what flies past is loot the player could have had.
*/
import { flattenPool, weightedPick, rarityRank, shopOdds } from "./odds.js";
import { DEFAULT_WEIGHTS, RARITIES } from "./config.js";

export const STRIP_LENGTH = 48;
export const LAND_INDEX = 40;

export function fillerSource(box, pools) {
  const entries = (box.pools ?? []).flatMap(ref => flattenPool(ref.id, pools));
  const weights = { ...DEFAULT_WEIGHTS, ...(box.weights ?? {}) };
  const byRarity = Object.fromEntries(RARITIES.map(r => [r, entries.filter(e => e.rarity === r)]));
  const rarities = RARITIES.filter(r => byRarity[r].length);
  return { byRarity, rarities, weights };
}

export function pickFiller(source, rng) {
  const rarity = weightedPick(source.rarities, r => source.weights[r], rng) ?? weightedPick(source.rarities, () => 1, rng);
  if (!rarity) return null;
  return weightedPick(source.byRarity[rarity], e => e.weight, rng);
}

/*
  Returns { cards, landIndex, nearMiss }. `nearMiss` is true when the card right
  after the result outranks it, which is what the overshoot-and-settle beat in
  spin.js plays against.

  The tease is honest: it is a rarity this box can actually drop (weight above
  0, the same set the shop's odds show) and only a step above the result, the
  next droppable rank most of the time and two ranks up now and then. It is
  never the box's jackpot just because that is the top, and there is no tease
  on a result at the box's best rarity, on a pity result (the floor already
  decided it), or on a box that drops only one rarity.
*/
export const TEASE_RATE = 0.6;
export const TEASE_TWO_UP = 0.2;

export function teaseRarity(result, droppable, rng) {
  if (result.pity || droppable.length < 2) return null;
  const up = droppable.filter(r => rarityRank(r) > rarityRank(result.rarity));
  if (!up.length || rng() >= TEASE_RATE) return null;
  return up.length > 1 && rng() < TEASE_TWO_UP ? up[1] : up[0];
}

export function buildStrip({ result, box, pools, rng = Math.random, length = STRIP_LENGTH, landIndex = LAND_INDEX, nearMiss = true }) {
  const source = fillerSource(box, pools);
  const cards = [];
  for (let i = 0; i < length; i++) {
    const f = pickFiller(source, rng) ?? result.entry;
    cards.push({ uuid: f.uuid, name: f.name, img: f.img, rarity: f.rarity });
  }
  cards[landIndex] = { uuid: result.entry.uuid, name: result.entry.name, img: result.entry.img, rarity: result.rarity, result: true };

  let miss = false;
  if (nearMiss && landIndex + 1 < length) {
    const droppable = shopOdds(box, pools).rows.map(row => row.rarity).filter(r => source.byRarity[r]?.length);
    const r = teaseRarity(result, droppable, rng);
    const tease = r && weightedPick(source.byRarity[r], e => e.weight, rng);
    if (tease) {
      cards[landIndex + 1] = { uuid: tease.uuid, name: tease.name, img: tease.img, rarity: r };
      miss = true;
    }
  }
  return { cards, landIndex, nearMiss: miss };
}
