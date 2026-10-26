// Finished game windows close by themselves after each client's "Close
// finished game windows" delay (the closeFinished client setting, 30 s by
// default: module/scripts/core/linger.js). A check that reads a reveal or a
// table window after it lands turns that off on every page it drives, for
// the run, and puts each back in its finally, so a slow run never finds the
// window gone; its timing then doesn't hang on a player's setting.
// live-linger, which checks the closing itself, doesn't use this.
//
//   const linger = keepWindowsOpen();
//   await linger.hold(pl.page, PLAYER);          // after each join
//   out.closeFinished = await linger.restore(); // in the finally
//
// restore() reports { <label>: { was, now, restored } } per page and sets
// a failing exit code if any page didn't take its old value back.
/* global game */
const KEY = "closeFinished";

function keepWindowsOpen() {
  const held = [];
  return {
    async hold(page, label) {
      if (!page) return null;
      const got = await page.evaluate(async key => {
        const was = game.settings.get("loot-crates", key);
        await game.settings.set("loot-crates", key, 0);
        return { was, now: game.settings.get("loot-crates", key) };
      }, KEY);
      if (got.now !== 0) throw new Error(`${label}'s ${KEY} reads ${got.now} after setting it to 0 (never)`);
      held.push({ page, label, was: got.was });
      return got.was;
    },
    async restore() {
      const out = {};
      for (const { page, label, was } of held.splice(0)) {
        try {
          const now = await page.evaluate(async ({ key, was }) => {
            await game.settings.set("loot-crates", key, was);
            return game.settings.get("loot-crates", key);
          }, { key: KEY, was });
          out[label] = { was, now, restored: now === was };
        } catch (err) {
          out[label] = { was, error: String(err?.message || err), restored: false };
        }
        if (!out[label].restored) process.exitCode = 1;
      }
      return out;
    },
  };
}

module.exports = { keepWindowsOpen };
