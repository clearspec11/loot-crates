/*
  Loot Crates, Foundry VTT entry point.

  Players: a "Crates" button in the Items sidebar opens the Crate Shop.
  GM: Game Settings, Loot Crates opens the manager (pools, boxes, pull log).
  Purchases go over the module socket to the active GM, who grants the item
  and broadcasts the reveal (socket.js). This file uses Foundry globals and is
  exercised in a world, not by the Vitest suite; the pure parts (odds.js,
  currency.js, strip.js, spin.js) are.
*/
import { MODULE_ID } from "./config.js";
import { registerSettings, setStoreListener, registerIndexFields, getPools, getBoxes, getLog, savePool, saveBox, entriesFromCompendium, entryFromItem, sweepAllPools } from "./store.js";
import { registerSocket, requestPull, isActiveGM } from "./socket.js";
import { openShop, refreshShop } from "./shop.js";
import { openManager, refreshManager, CrateManager } from "./manager.js";
import { storeRedraw } from "./redraw.js";
import { performPull } from "./pull.js";
import { showReveal, sealChatCard } from "./reveal.js";
import { draw, oddsTable, seededRng } from "./odds.js";
import { buildStrip } from "./strip.js";

Hooks.once("init", () => {
  registerSettings();
  // Open windows follow the world settings as any client writes them.
  setStoreListener(storeRedraw({ refreshShop, refreshManager }));
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
  if (mod) mod.api = { openShop, openManager, requestPull, performPull, showReveal, draw, oddsTable, buildStrip, seededRng, getPools, getBoxes, getLog, savePool, saveBox, entriesFromCompendium, entryFromItem };
  // Flag dead pool entries once at load, so the shop's odds are honest before
  // anyone buys; each pull sweeps its own box again (socket.js).
  if (isActiveGM()) sweepAllPools();
});

Hooks.on("renderItemDirectory", (_app, html) => {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector(`.${MODULE_ID}-open`)) return;
  const header = root.querySelector(".directory-header .header-actions") || root.querySelector(".directory-header");
  if (!header) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = `${MODULE_ID}-open`;
  button.innerHTML = `<i class="fas fa-box-open"></i> Crates`;
  button.addEventListener("click", () => openShop());
  header.appendChild(button);
});

// Purse changes show in the shop without reopening it.
Hooks.on("updateActor", (actor, change) => {
  if (change.system?.currency) refreshShop();
});
Hooks.on("userConnected", () => refreshShop());
// A pull's chat card keeps its result back while that pull spins here.
Hooks.on("renderChatMessageHTML", sealChatCard);
