/*
  Open windows redraw when the module's world settings change on any client
  (store.js setStoreListener): a player's shop shows a crate sold out or the
  shop closed when it happens, not when Buy is pressed and the GM refuses,
  and the GM's Pull log shows a pull's row, or a late cancel's mark, as it is
  written.

  A pull writes three settings together (socket.js recordPull: pity state,
  log, stock), so changes are collected for `delay` ms and each window
  redraws once for the lot. The shop shows boxes, pools and the buyer's pity
  state (its odds and pity line), and whether the shop is open; which of the keys the manager's open tab shows is
  manager.js refreshManager's call. No Foundry globals here, so it is tested
  without a world.
*/
import { SETTINGS } from "./config.js";

export const SHOP_KEYS = [SETTINGS.BOXES, SETTINGS.POOLS, SETTINGS.STATE, SETTINGS.SHOP_OPEN];
export const REDRAW_DELAY_MS = 100;

export function storeRedraw({ refreshShop, refreshManager, delay = REDRAW_DELAY_MS }) {
  const keys = new Set();
  let timer = null;
  const flush = () => {
    timer = null;
    const changed = [...keys];
    keys.clear();
    const run = (what, fn) => { try { fn(); } catch (err) { console.error(`loot-crates | redrawing the ${what} failed`, err); } };
    if (changed.some(k => SHOP_KEYS.includes(k))) run("shop", refreshShop);
    run("manager", () => refreshManager(changed));
  };
  return key => {
    keys.add(key);
    clearTimeout(timer);
    timer = setTimeout(flush, delay);
  };
}
