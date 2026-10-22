/*
  The dice game's one Foundry-side piece: the bridge to Dice So Nice. The
  kind (dicegame.js) is pure and asks for the 3D roll through setDice3D;
  this file answers with game.dice3d when that module is active, rebuilding
  the Roll from the serialised data the GM broadcast (Roll.fromData), so
  the 3D dice show the faces the GM rolled, on this client only
  (synchronize false: every client got the reveal and runs its own). The
  promise resolves when the 3D roll has finished, which is when the reveal
  lands; dicegame.js caps the wait (DICE_TIMING.threeTimeout), since the
  animation runs on requestAnimationFrame and stalls in a hidden tab.

  Nothing posts a ChatMessage with the roll: that would render the total
  everywhere the moment it was created. Imported by reveal.js, so the
  bridge is set wherever reveals are shown.
*/
import { setDice3D } from "./dicegame.js";

export const dice3dActive = () => !!globalThis.game?.dice3d && typeof globalThis.game.dice3d.showForRoll === "function";

export function showDice3D(data) {
  if (!dice3dActive() || typeof globalThis.Roll?.fromData !== "function") return null;
  const roll = Roll.fromData(foundry.utils.deepClone(data));
  return game.dice3d.showForRoll(roll, game.user, false);
}

setDice3D(showDice3D);
