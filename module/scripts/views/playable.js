/*
  Whether a game as its editor would save it can be played at all, and if
  not, why: one verdict per kind, read from the warning its own editor
  readout already gives (nothing new is ruled here). A crate that can drop
  nothing, a well that is dry, a dragon nobody can beat, a deck with no
  card that can be drawn, a wheel of fewer than two pockets, an auction
  with no lot, and a scratch ticket whose item prizes have no pool or
  whose every ticket is a dud.

  The editor keeps such a game off the shelf (manager.js): its default
  button reads "Save off the shelf" and the On the shelf box is unticked
  and off with this reason beside it, and Save writes it off the shelf, so
  players never see a game the GM would refuse. Once the GM fixes it the
  button and the box come back. A softer warning (a well with no pool for
  its rare find, a scratch prize waiting on a rarity no pool holds yet)
  doesn't stop a game: some plays still work.

  A deck whose cards are all drawn is not judged here: that is the state
  of the deck, which Reshuffle fixes, not how it is built.

  No Foundry globals.
*/
import { kindOf } from "../games/kinds.js";
import { boxPreview } from "./boxcard.js";
import { wellPreview } from "../games/well.js";
import { dicePreview } from "../games/dicegame.js";
import { deckPreview } from "../games/deck.js";
import { roulettePreview } from "../games/roulette.js";
import { auctionPreview } from "../games/auction.js";
import { scratchPreview } from "../games/scratch.js";
import { t } from "../core/i18n.js";

const VERDICTS = {
  crate: (game, pools) => { const p = boxPreview(game, pools); return p.empty ? p.note : ""; },
  well: (game, pools) => { const p = wellPreview(game, pools); return p.dry ? p.note : ""; },
  dice: (game, pools) => { const p = dicePreview(game, pools); return p.warn ? p.note : ""; },
  deck: (game, pools) => { const p = deckPreview(game, pools, []); return p.warn ? p.note : ""; },
  roulette: (game, pools) => { const p = roulettePreview(game, pools); return p.warn ? p.note : ""; },
  auction: game => { const p = auctionPreview(game); return p.warn ? p.note : ""; },
  scratch: (game, pools) => {
    const p = scratchPreview(game, pools);
    // Item prizes with no pool ticked at all: the top prize printed on the
    // ticket could never be won.
    if (p.roll.prizes.some(line => line.items.length) && !game.pools?.length) return t("LOOTCRATES.Scratch.NoPool");
    if (!p.odds.wins) return t("LOOTCRATES.Scratch.AllDudsWhy");
    // With pools ticked, a prize at a rarity they don't hold waits in the
    // roll undrawn: a soft warning while another prize can still be won.
    // When none can, every ticket is refused or a dud.
    const drawable = line => line.count > 0 && line.items.every(r => p.held.has(r));
    return p.roll.prizes.some(drawable) ? "" : t("LOOTCRATES.Scratch.NoDrawable");
  },
};

// Why `game` can't be played as it stands, in one sentence, or "" when it
// can. A kind another module registered has no verdict here: "".
export function unplayableReason(game, pools = {}) {
  const verdict = VERDICTS[kindOf(game)];
  return verdict ? verdict(game, pools ?? {}) || "" : "";
}
