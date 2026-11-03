/*
  A Pull log row's GM-only columns: a scratch ticket's prize tier, its
  number in the roll and its winning panels (scratch.js hiddenRow). They
  are kept off the row and read and written only through here, so where
  they are kept is one decision: beside the tallies (core/tally.js
  `hidden`, by row id, in the STATE setting), written in the same write as
  the row and dropped when the row leaves the log. Off the row means off
  every screen and every broadcast, not out of a player's reach: Foundry
  14.369 sends a player's client every world setting, every flag, every
  journal entry whatever its ownership, other users' settings and a GM-only
  compendium's documents (probed in round 31, live-storage.cjs), so no
  Foundry storage hides a value from a player's console. Should one appear,
  this is the one place to point at it.
*/
import { MODULE_ID, SETTINGS } from "../core/config.js";

// The columns kept for this row in `tally`, or null.
export const hiddenOf = (tally, rowId) => tally?.hidden?.[rowId] ?? null;

// Keeps a row's columns in `tally` (changes it). Nothing for none.
export function setHidden(tally, rowId, cols) {
  if (!tally || !rowId || !cols) return tally;
  tally.hidden = { ...(tally.hidden ?? {}), [rowId]: { ...cols } };
  return tally;
}

// Forgets the columns of rows that left the log (changes `tally`).
export function dropHidden(tally, ids = []) {
  if (!tally?.hidden || !ids.length) return tally;
  for (const id of ids) delete tally.hidden[id];
  return tally;
}

// One row's columns as the world holds them now, on any client.
export function readHidden(rowId) {
  try { return hiddenOf(game.settings.get(MODULE_ID, SETTINGS.STATE)?.tally, rowId); } catch { return null; }
}
