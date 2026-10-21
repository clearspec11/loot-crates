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

/*
  Every change heard, counted. A window that reads the settings when it
  renders notes the count then (changeCount); a batch whose last change it
  had already counted is already on screen, so it isn't drawn again. That is
  what keeps a GM's own action from drawing the manager twice: the action
  awaits its write (the change is heard), renders, and the batch that
  arrives 100 ms later carries nothing new.
*/
let heard = 0;
export const changeCount = () => heard;

export function storeRedraw({ refreshShop, refreshManager, delay = REDRAW_DELAY_MS }) {
  const keys = new Set();
  let timer = null;
  let last = 0;
  const flush = () => {
    timer = null;
    const changed = [...keys];
    keys.clear();
    const run = (what, fn) => { try { fn(); } catch (err) { console.error(`loot-crates | redrawing the ${what} failed`, err); } };
    if (changed.some(k => SHOP_KEYS.includes(k))) run("shop", refreshShop);
    run("manager", () => refreshManager(changed, last));
  };
  return key => {
    keys.add(key);
    last = ++heard;
    clearTimeout(timer);
    timer = setTimeout(flush, delay);
  };
}
