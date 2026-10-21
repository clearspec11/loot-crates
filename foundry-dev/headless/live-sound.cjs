// Live check: crate sounds play on Foundry's interface channel, so the
// hotbar Mute silences them.
//
//   FOUNDRY_URL=http://<host>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/headless/live-sound.cjs
//
// Joins as the Gamemaster (only when that seat is free), clicks the chat tab
// as a real gesture so Foundry creates game.audio.interface, and swaps the
// newest pull card's Watch again for the branch's (the installed module drew
// the first one). It counts the oscillators the interface context builds and
// where every audio connection goes, then, as a person would: Watch again
// (sounds, all into the interface gainNode), Close, the hotbar Mute, Watch
// again (no oscillators), Close, Unmute, Watch again (sounds again), Close.
// A replay is display only: nothing in the world changes.
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8766/";

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(FOUNDRY + "/join", { waitUntil: "networkidle" });
  const free = await page.$eval("select[name=userId]", s => [...s.options].some(o => o.textContent.trim() === "Gamemaster" && !o.disabled));
  if (!free) { console.log(JSON.stringify({ ok: false, error: "the Gamemaster seat is taken" })); await browser.close(); process.exit(2); }
  await page.selectOption("select[name=userId]", { label: "Gamemaster" });
  await page.click("button[name=join], button[type=submit]");
  await page.waitForURL(/\/game/, { timeout: 30000 });
  await page.waitForFunction(() => window.game?.ready, null, { timeout: 120000 });
  const lockedBefore = await page.evaluate(() => { globalThis.canvas?.app?.ticker?.stop(); return { locked: game.audio.locked, interface: !!game.audio.interface }; });

  // The first gesture: open the chat tab with a real click.
  await page.locator('#sidebar [data-tab="chat"]').first().click();
  await page.waitForFunction(() => !!game.audio.interface?.gainNode, null, { timeout: 10000 });
  await page.waitForTimeout(600);

  const setup = await page.evaluate(async base => {
    game.socket.off("module.loot-crates");
    const store = await import(base + "scripts/store.js");
    try { store.registerSettings(); } catch { /* the installed module registered them */ }
    const { watchAgain } = await import(base + "scripts/reveal.js");
    const msg = game.messages.contents.filter(m => m.flags?.["loot-crates"]?.replay).at(-1);
    const li = msg && document.querySelector(`#chat .chat-log [data-message-id="${msg.id}"]`);
    if (!li) return { error: "no pull card with a replay snapshot in the chat log" };
    li.querySelector(".lc-chat__replay")?.remove();
    watchAgain(msg, li);
    const ctx = game.audio.interface;
    const rec = globalThis.__lcSound = { osc: 0, toGainNode: 0, toDestination: 0 };
    const createOscillator = ctx.createOscillator;
    ctx.createOscillator = function (...a) { rec.osc++; return createOscillator.apply(this, a); };
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (target, ...a) {
      if (target === ctx.gainNode) rec.toGainNode++;
      else if (target instanceof AudioDestinationNode) rec.toDestination++;
      return connect.call(this, target, ...a);
    };
    return { messageId: msg.id, sound: game.settings.get("loot-crates", "sound"), volume: ctx.gainNode.gain.value, state: ctx.state };
  }, MODULE_BASE);
  if (setup.error) { console.log(JSON.stringify({ ok: false, ...setup })); await browser.close(); process.exit(1); }

  const facts = () => page.evaluate(() => {
    const actor = game.actors.find(a => a.name === "Crate Tester");
    return { messages: game.messages.size, purse: JSON.stringify(actor?.system.currency), items: actor?.items.size };
  });
  const before = await facts();
  const btn = page.locator(`#chat .chat-log [data-message-id="${setup.messageId}"] .lc-chat__replay`);
  async function replay() {
    await page.evaluate(() => Object.assign(globalThis.__lcSound, { osc: 0, toGainNode: 0, toDestination: 0 }));
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    await page.waitForSelector(".application.lc-reveal .lc-card--landed", { timeout: 15000 });
    await page.waitForTimeout(1200); // the sting's last note
    const counts = await page.evaluate(() => ({ ...globalThis.__lcSound, gain: game.audio.interface.gainNode.gain.value, muted: game.audio.globalMute }));
    await page.locator(".application.lc-reveal .lc-reveal__close").first().click();
    await page.waitForFunction(() => !document.querySelector(".application.lc-reveal"), null, { timeout: 5000 });
    return counts;
  }
  const mute = page.locator('#hotbar [data-action="mute"]');

  const heard = await replay();
  await mute.click();
  await page.waitForTimeout(300);
  const muted = await replay();
  await mute.click();
  await page.waitForTimeout(300);
  const unmuted = await replay();
  const after = await facts();
  const unchanged = JSON.stringify(before) === JSON.stringify(after);

  const ok = !lockedBefore.interface && setup.sound === true
    && heard.osc > 30 && heard.toGainNode === heard.osc && heard.toDestination === 0
    && muted.muted && muted.osc === 0 && muted.toDestination === 0
    && !unmuted.muted && unmuted.osc > 30 && unmuted.toGainNode === unmuted.osc && unmuted.toDestination === 0
    && unchanged && !errors.length;
  console.log(JSON.stringify({ ok, lockedBefore, setup, heard, muted, unmuted, unchanged, errors }, null, 1));
  await browser.close();
  process.exit(ok ? 0 : 1);
})();
