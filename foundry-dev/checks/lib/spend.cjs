// A Buy, a Buy to keep or a reveal's play-again whose price is more than
// half the character's purse asks first (module/scripts/views/spendguard.js):
// its first press only arms the button ("Spend 150 gp?"), and a second press
// on it sends. A check that buys through the real button presses it with
// pressSpend, which presses once and, when that press only armed the button,
// waits out the arming gesture's grace (ARM_GRACE_MS, 400 ms) and presses
// again, so the check buys whatever the test character's purse holds. A
// press that sent at once is left as it was. Returns whether it took two.
//
//   const { pressSpend } = require("./lib/spend.cjs");
//   await pressSpend(pl.page.locator(`#loot-crates-shop .lc-box__buy[data-box="${id}"]`));
const GRACE_MS = 450;

async function pressSpend(locator, options = {}) {
  await locator.click(options);
  const armed = await locator.evaluate(b => b.hasAttribute("data-armed")).catch(() => false);
  if (!armed) return false;
  await locator.page().waitForTimeout(GRACE_MS);
  await locator.click(options);
  return true;
}

module.exports = { pressSpend };
