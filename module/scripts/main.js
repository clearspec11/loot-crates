/*
  Loot Crates, Foundry VTT entry point.

  Players: a "Crates" button in the Items sidebar opens the Crate Shop.
  GM: "Manage crates" beside it opens the manager (pools, boxes, pull log),
  as does Game Settings, Loot Crates (route.js has every way between them).
  Purchases go over the module socket to the active GM, who grants the item
  and broadcasts the reveal (socket.js). This file uses Foundry globals and is
  exercised in a world, not by the Vitest suite; the pure parts (odds.js,
  currency.js, strip.js, spin.js) are.
*/
import { MODULE_ID, SETTINGS } from "./core/config.js";
import { registerSettings, setStoreListener, registerIndexFields, getPools, getBoxes, getLog, getRounds, savePool, saveBox, entriesFromCompendium, entryFromItem, sweepAllPools } from "./foundry/store.js";
import { registerSocket, requestPull, requestStake, isActiveGM, restCompleted, settleOwedRests } from "./foundry/socket.js";
import { registerKind, getKind, kindOf } from "./games/kinds.js";
import { openShop, refreshShop, registerShopHooks } from "./foundry/shop.js";
import { addDirectoryButtons } from "./views/route.js";
import { openManager, refreshManager, CrateManager, makeCrateFromTable, makeCrateMenuEntry, addStarterCrates } from "./foundry/manager.js";
import { storeRedraw } from "./core/redraw.js";
import { performPull } from "./foundry/pull.js";
import { showReveal, showReplay, sealChatCard, watchAgain, preSealItem, setTableWindow } from "./foundry/reveal.js";
import { openRound, closeRound, resolveRound, cancelRound, recoverRounds, refundOrphanRounds, onTable, watchTables, watchStale } from "./foundry/table.js";
// The shared table window registers itself with the round's messages and
// the core's hold when imported.
import { openTable, openTableFor, refreshTables } from "./foundry/tablewindow.js";
import { draw, oddsTable, seededRng } from "./core/odds.js";
import { registerWelcome, welcomeAtLoad, openWelcome } from "./foundry/welcomewindow.js";
import { buildStrip } from "./core/strip.js";
import { t, setLocalizer, loadStrings } from "./core/i18n.js";

// The module's words (i18n.js): this module's own lang/en.json, fetched as
// the script loads, for a copy whose keys Foundry doesn't know (the
// working copy a live check serves beside an installed release); then,
// once Foundry's translations are in, game.i18n for every key it has, so a
// translation in lang/<code>.json wins. i18n.js fills the placeholders
// either way, so a missing name never reads "undefined". Nothing reads a word before a
// window opens, by when both are here.
loadStrings().catch(err => console.error("loot-crates | loading the module's words (lang/en.json) failed", err));
Hooks.once("i18nInit", () => setLocalizer(key => (game.i18n.has(key) ? game.i18n.localize(key) : null)));

Hooks.once("init", () => {
  registerSettings();
  registerWelcome();
  // Open windows follow the world settings as any client writes them.
  // A round whose game was deleted is called off on the active GM
  // (table.js refundOrphanRounds), so its stakes never wait for a reload,
  // and a change to the rounds moves the GM's timer for the next one to
  // go stale (table.js watchStale).
  const redraw = storeRedraw({ refreshShop, refreshManager, refreshTables });
  setStoreListener(key => {
    redraw(key);
    if (key === SETTINGS.BOXES) refundOrphanRounds().catch(err => console.error("loot-crates | refunding the round of a deleted game failed", err));
    if (key === SETTINGS.ROUNDS) watchStale();
  });
  registerIndexFields();
  game.settings.registerMenu(MODULE_ID, "manager", {
    // Getters: Foundry keeps this object and reads its words when Game
    // Settings renders, by when the module's words have arrived.
    get name() { return t("LOOTCRATES.Settings.ManagerName"); },
    get label() { return t("LOOTCRATES.Settings.ManagerLabel"); },
    get hint() { return t("LOOTCRATES.Settings.ManagerHint"); },
    icon: "fas fa-box-open",
    type: CrateManager,
    restricted: true,
  });
});

Hooks.once("ready", () => {
  registerSocket();
  const mod = game.modules.get(MODULE_ID);
  // registerKind adds a game of chance that runs on the crate's core (kinds.js).
  if (mod) mod.api = { openShop, openManager, requestPull, performPull, showReveal, showReplay, draw, oddsTable, buildStrip, seededRng, getPools, getBoxes, getLog, savePool, saveBox, entriesFromCompendium, entryFromItem, registerKind, getKind, kindOf, openRound, closeRound, resolveRound, cancelRound, requestStake, onTable, setTableWindow, getRounds, openTable, openTableFor, makeCrateFromTable, addStarterCrates, openWelcome };
  // Flag dead pool entries once at load, so the shop's odds are honest before
  // anyone buys; each pull sweeps its own box again (socket.js).
  // A table round's open stakes don't outlive their window across a reload
  // (table.js recoverRounds): the GM's load refunds them and says how many,
  // and a timer refunds the next round to go stale while the GM stays
  // (table.js watchStale). An auction still inside its grace then has its
  // gavel brought down, and a live one keeps its house bidders (table.js
  // watchTables).
  if (isActiveGM()) {
    sweepAllPools();
    recoverRounds()
      .catch(err => console.error("loot-crates | refunding stale table stakes failed", err))
      .then(() => refundOrphanRounds())
      .catch(err => console.error("loot-crates | refunding the round of a deleted game failed", err))
      .finally(() => { watchTables(); watchStale(); });
  }
  // Long rests taken while no GM was online reach the GM now (socket.js).
  try { settleOwedRests(); } catch (err) { console.error("loot-crates | sending the rests taken while no GM was online failed", err); }
  // A GM's welcome once per world, then a short note once per newer
  // version (welcome.js); a player gets neither.
  try { welcomeAtLoad(); } catch (err) { console.error("loot-crates | the welcome failed to open", err); }
});

// "Crates" for everyone, and "Manage crates" for a GM, once each however
// often the directory renders.
Hooks.on("renderItemDirectory", (_app, html) => {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (root) addDirectoryButtons(root, { isGM: !!game.user?.isGM, open: { shop: () => openShop(), manager: () => openManager() } });
});

// "Make a crate" on a roll table's menu in the Roll Tables sidebar (a GM's).
Hooks.on("getRollTableContextOptions", (_app, options) => { if (Array.isArray(options)) options.push(makeCrateMenuEntry()); });

// Who the active GM is can change while the world runs: a GM joins or
// leaves (userConnected, on connect and disconnect), or a user's role
// changes (updateUser). The GM's timer for the next stale round
// (table.js watchStale) and the auction's watch, its gavel and house
// bidders (table.js watchTables), follow: armed on the client that is now
// the active GM, cleared on the one that no longer is, so a stake left in
// a round is refunded and a live auction's gavel falls while any GM is
// online, not at the next load.
const followActiveGM = () => { watchStale(); watchTables(); };
Hooks.on("userConnected", () => { if (game.ready) followActiveGM(); });
Hooks.on("updateUser", (_user, change) => { if (game.ready && change && "role" in change) followActiveGM(); });

// A day ends at each character's long rest (clock.js), calendar or not:
// the rest that starts a new day is noted on the GM (socket.js).
Hooks.on("dnd5e.restCompleted", (actor, result, config) => {
  try { restCompleted(actor, result, config); } catch (err) { console.error("loot-crates | counting a long rest failed", err); }
});

// Purse and ownership changes show in the shop without reopening it.
registerShopHooks(Hooks);
// A pull's chat card keeps its result back while that pull spins here.
Hooks.on("renderChatMessageHTML", sealChatCard);
// A pull's card with a replay snapshot offers "Watch again" (display only).
Hooks.on("renderChatMessageHTML", watchAgain);
// A pull's item reaches the sheet just before its reveal: hidden until the
// spin lands here (reveal.js hold), as the chat card is.
Hooks.on("createItem", preSealItem);
