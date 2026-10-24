/*
  On the shelf or off it: whether players can see and buy a game.

  A GM builds a crate, a wheel or a deck ahead of the session and keeps it
  off the shelf until the moment it goes out: the players never watch a
  half-priced game appear in an open shop, and putting it out is one click
  on its Boxes row (the reveal is the GM's to stage). A record is on the
  shelf unless its rules say `shelved: false`, so every record from before
  this, which has no flag, is on the shelf as it always was; nothing is
  migrated, and putting a game back on the shelf drops the flag again.

  Off the shelf, a game is left out of every player's shop (the GM's shop
  still shows it, its Buy off with the reason), and the GM refuses a pull
  or a stake on it inside the write queue (pull.js guardPlay), so a shop
  drawn before the change, or a request made by hand, charges nothing. A
  table game off the shelf opens no round (table.js openRound); a round
  already open runs to its resolve.

  No Foundry globals.
*/

export const onShelf = game => game?.rules?.shelved !== false;

// The rules with the game put on the shelf (`on`) or taken off it.
export function shelfRules(rules = {}, on = true) {
  const rest = { ...(rules ?? {}) };
  delete rest.shelved;
  return on ? rest : { ...rest, shelved: false };
}

// The games a shop shows: all of them to a GM, the ones on the shelf to a player.
export const shelfFor = (games = [], { isGM = false } = {}) => (isGM ? [...games] : games.filter(onShelf));

// The Boxes toolbar's count: "4 of 6 on the shelf", "" with no games.
export function shelfCountText(games = []) {
  if (!games.length) return "";
  return `${games.filter(onShelf).length} of ${games.length} on the shelf`;
}

// The GM's shop card for a game off the shelf: why its Buy is off.
export const OFF_SHELF_REASON = "Off the shelf: players can't see it";

// The GM's refusal of a pull or stake on a game off the shelf.
export const shelfRefusal = game => `${game?.name || "That game"} is no longer on the shelf. Nothing was charged.`;

// A table window's bet button while its game is off the shelf: the GM
// would refuse the stake (pull.js guardPlay), so it is not offered.
export const shelfBetsClosed = (game, verb = "bets") => `${game?.name || "This game"} is off the shelf: no ${verb} until the GM puts it back.`;

// A table game off the shelf opens no round.
export const shelfRoundRefusal = game => `${game?.name || "That game"} is off the shelf. Put it on the shelf to open a round.`;

/*
  The editor's "On the shelf" checkbox: ticked for a New (its default
  button reads "Add to shelf", so it keeps its word), as the record has it
  for an edit or a copy. Unticked, a new game is added for the GM alone.
*/
export function shelfFieldHTML(game, { isNew = false, copy = false } = {}) {
  const on = isNew && !copy ? true : onShelf(game);
  return `<label class="lc-row lc-form__shelf"><input type="checkbox" name="onShelf"${on ? " checked" : ""}> On the shelf, where players can see and buy it</label>`;
}

/*
  The Boxes row's toggle: one fixed label, "On the shelf", pressed while
  the game is out (the ARIA toggle-button pattern: the name stays, the
  pressed state says on or off). Its switch (module.css) shows the same
  state to the eye, and the row's "Off the shelf" tag says it in words.
  Its action and data-box keep focus on it across the redraw (manager.js
  focusKey).
*/
export const SHELF_TOGGLE_LABEL = "On the shelf";
export function shelfToggleHTML(game, esc = s => String(s ?? "")) {
  const on = onShelf(game);
  const tip = on ? "Players can see and buy it. Click to take it off the shelf." : "Players can't see it. Click to put it on the shelf.";
  return `<button type="button" class="lc-shelf-toggle lc-switch" data-action="toggleShelf" data-box="${esc(game.id)}" data-on="${on}" aria-pressed="${on}" aria-label="${SHELF_TOGGLE_LABEL}: ${esc(game.name)}" title="${tip}">${SHELF_TOGGLE_LABEL}</button>`;
}

// The Boxes tab's status line once the toggle wrote.
export function shelfNotice(game) {
  const name = game?.name || "The game";
  return onShelf(game) ? `${name} is on the shelf; players can see it.` : `${name} is off the shelf; players can't see it.`;
}
