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
import { MODULE_ID, SETTINGS } from "./config.js";
import { registerSettings, setStoreListener, registerIndexFields, getPools, getBoxes, getLog, getRounds, savePool, saveBox, entriesFromCompendium, entryFromItem, sweepAllPools } from "./store.js";
import { registerSocket, requestPull, requestStake, isActiveGM, restCompleted } from "./socket.js";
import { registerKind, getKind, kindOf } from "./kinds.js";
import { openShop, refreshShop, registerShopHooks } from "./shop.js";
import { addDirectoryButtons } from "./route.js";
import { openManager, refreshManager, CrateManager, makeCrateFromTable, makeCrateMenuEntry, addStarterCrates } from "./manager.js";
import { storeRedraw } from "./redraw.js";
import { performPull } from "./pull.js";
import { showReveal, showReplay, sealChatCard, watchAgain, preSealItem, setTableWindow } from "./reveal.js";
import { openRound, closeRound, resolveRound, cancelRound, recoverRounds, refundOrphanRounds, onTable, watchTables } from "./table.js";
// The shared table window registers itself with the round's messages and
// the core's hold when imported.
import { openTable, openTableFor, refreshTables } from "./tablewindow.js";
import { draw, oddsTable, seededRng } from "./odds.js";
import { registerWelcome, welcomeAtLoad, openWelcome } from "./welcomewindow.js";
import { buildStrip } from "./strip.js";

Hooks.once("init", () => {
  registerSettings();
  registerWelcome();
  // Open windows follow the world settings as any client writes them.
  // A round whose game was deleted is called off on the active GM
  // (table.js refundOrphanRounds), so its stakes never wait for a reload.
  const redraw = storeRedraw({ refreshShop, refreshManager, refreshTables });
  setStoreListener(key => {
    redraw(key);
    if (key === SETTINGS.BOXES) refundOrphanRounds().catch(err => console.error("loot-crates | refunding the round of a deleted game failed", err));
  });
  registerIndexFields();
  game.settings.registerMenu(MODULE_ID, "manager", {
    name: "Pools, boxes and pulls",
    label: "Open Loot Crates",
    hint: "Build the pools items drop from, price the boxes, and see who pulled what.",
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
  // (table.js recoverRounds): the GM's load refunds them and says how many.
  // An auction still inside its grace then has its gavel brought down, and
  // a live one keeps its house bidders (table.js watchTables).
  if (isActiveGM()) {
    sweepAllPools();
    recoverRounds()
      .catch(err => console.error("loot-crates | refunding stale table stakes failed", err))
      .then(() => refundOrphanRounds())
      .catch(err => console.error("loot-crates | refunding the round of a deleted game failed", err))
      .finally(() => watchTables());
  }
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

// With dnd5e's calendar off, a day ends at each character's long rest
// (clock.js): the rest that starts a new day is counted on the GM.
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
