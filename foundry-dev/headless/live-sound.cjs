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
//
// It also times the sounds against the spin, from Foundry's own audio clock:
// each oscillator's ctx.currentTime and first frequency, and the spin's first
// frame (the frame loop's first sized frame, which starts its clock). The
// braking sweep (the one sawtooth) must start within 50 ms of brakeAt() after
// that first frame. Two more Watch agains, on the newest near-miss card and
// the newest plain one: the near-miss must voice the tease (two rising notes
// above every tick) and then the drop back (one low note), with different
// frequencies; the plain one neither.
/* global game -- used inside page.evaluate, which runs in the Foundry page */
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
  // What main.js does first: the branch's words, from its own lang/en.json
  // (the installed release may have no language file, or older words).
  await page.evaluate(async base => (await import(base + "scripts/i18n.js")).loadStrings(), MODULE_BASE);
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
    // A refunded card has no Watch again: the newest one that wasn't refunded.
    const msg = game.messages.contents.filter(m => m.flags?.["loot-crates"]?.replay && !m.flags["loot-crates"].refundedAt).at(-1);
    const li = msg && document.querySelector(`#chat .chat-log [data-message-id="${msg.id}"]`);
    if (!li) return { error: "no unrefunded pull card with a replay snapshot in the chat log" };
    li.querySelector(".lc-chat__replay")?.remove();
    watchAgain(msg, li);
    if (!li.querySelector(".lc-chat__replay")) return { error: `the card for ${msg.id} drew no Watch again` };
    const ctx = game.audio.interface;
    const rec = globalThis.__lcSound = { osc: 0, toGainNode: 0, toDestination: 0, voices: [], firstFrame: null };
    const nodes = globalThis.__lcNodes = [];
    const createOscillator = ctx.createOscillator;
    ctx.createOscillator = function (...a) {
      rec.osc++;
      const o = createOscillator.apply(this, a);
      const v = { ctxMs: ctx.currentTime * 1000, perf: performance.now() };
      const set = o.frequency.setValueAtTime;
      o.frequency.setValueAtTime = function (value, t) { v.hz ??= value; return set.call(this, value, t); };
      rec.voices.push(v);
      nodes.push([v, o]);
      return o;
    };
    // The spin's frame loop is the function named "frame" in spin.js; its first
    // frame with a sized viewport starts the spin's clock.
    const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = function (cb) {
      if (cb.name !== "frame") return raf.call(window, cb);
      return raf.call(window, now => {
        if (!rec.firstFrame && document.querySelector(".application.lc-reveal .lc-spin__viewport")?.clientWidth) {
          rec.firstFrame = { now, ctxMs: ctx.currentTime * 1000, perf: performance.now() };
        }
        cb(now);
      });
    };
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (target, ...a) {
      if (target === ctx.gainNode) rec.toGainNode++;
      else if (target instanceof AudioDestinationNode) rec.toDestination++;
      return connect.call(this, target, ...a);
    };
    // The newest near-miss card and the newest plain one, each with the branch's Watch again.
    const cards = game.messages.contents.filter(m => m.flags?.["loot-crates"]?.replay && !m.flags["loot-crates"].refundedAt);
    const pick = nearMiss => {
      const m = cards.filter(c => !!c.flags["loot-crates"].replay.strip?.nearMiss === nearMiss).at(-1);
      const el = m && document.querySelector(`#chat .chat-log [data-message-id="${m.id}"]`);
      if (!el) return null;
      if (m.id !== msg.id) { el.querySelector(".lc-chat__replay")?.remove(); watchAgain(m, el); }
      return m.id;
    };
    const { brakeAt } = await import(base + "scripts/spin.js");
    const { TICK_HZ, TEASE_HZ, BACK_HZ } = await import(base + "scripts/sound.js");
    return { messageId: msg.id, nearMissId: pick(true), plainId: pick(false), brakeMs: brakeAt(), TICK_HZ, TEASE_HZ, BACK_HZ, sound: game.settings.get("loot-crates", "sound"), volume: ctx.gainNode.gain.value, state: ctx.state };
  }, MODULE_BASE);
  if (setup.error) { console.log(JSON.stringify({ ok: false, ...setup })); await browser.close(); process.exit(1); }

  const facts = () => page.evaluate(() => {
    const actor = game.actors.find(a => a.name === "Crate Tester");
    return { messages: game.messages.size, purse: JSON.stringify(actor?.system.currency), items: actor?.items.size };
  });
  const before = await facts();
  const button = id => page.locator(`#chat .chat-log [data-message-id="${id}"] .lc-chat__replay`);
  async function replay(id = setup.messageId) {
    const btn = button(id);
    await page.evaluate(() => { Object.assign(globalThis.__lcSound, { osc: 0, toGainNode: 0, toDestination: 0, voices: [], firstFrame: null }); globalThis.__lcNodes.length = 0; });
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    await page.waitForSelector(".application.lc-reveal .lc-card--landed", { timeout: 15000 });
    await page.waitForTimeout(1200); // the sting's last note
    const counts = await page.evaluate(() => {
      const { voices: _voices, firstFrame, ...rest } = globalThis.__lcSound;
      const typed = globalThis.__lcNodes.map(([v, o]) => ({ ...v, type: o.type }));
      return { ...rest, voices: typed, firstFrame, gain: game.audio.interface.gainNode.gain.value, muted: game.audio.globalMute };
    });
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
  const nearMissRun = setup.nearMissId ? await replay(setup.nearMissId) : null;
  const plainRun = setup.plainId ? await replay(setup.plainId) : null;
  const after = await facts();
  const unchanged = JSON.stringify(before) === JSON.stringify(after);

  // When the braking sweep started, after the spin's first frame, on both clocks.
  const sweepTiming = run => {
    const sweeps = run.voices.filter(v => v.type === "sawtooth");
    if (sweeps.length !== 1 || !run.firstFrame) return { sweeps: sweeps.length, firstFrame: !!run.firstFrame };
    const ctxMs = Math.round(sweeps[0].ctxMs - run.firstFrame.ctxMs);
    const frameMs = Math.round(sweeps[0].perf - run.firstFrame.now);
    return { sweeps: 1, ctxMs, frameMs, offByMs: ctxMs - Math.round(setup.brakeMs), ok: Math.abs(ctxMs - setup.brakeMs) <= 50 };
  };
  const isTease = v => v.type === "triangle" && setup.TEASE_HZ.includes(v.hz);
  const isBack = v => v.type === "triangle" && v.hz === setup.BACK_HZ;
  const voicing = run => {
    if (!run) return null;
    const order = run.voices.filter(v => isTease(v) || isBack(v)).map(v => (isTease(v) ? "tease" : "back"));
    const teaseHz = run.voices.filter(isTease).map(v => v.hz);
    const backHz = run.voices.filter(isBack).map(v => v.hz);
    const ticks = run.voices.filter(v => v.type === "square").map(v => v.hz);
    return { order, teaseHz, backHz, tickHz: [Math.min(...ticks), Math.max(...ticks)], sweep: sweepTiming(run) };
  };
  const timing = { heard: sweepTiming(heard), unmuted: sweepTiming(unmuted) };
  const nearMiss = voicing(nearMissRun);
  const plain = voicing(plainRun);
  const voicesOk = !!nearMiss && !!plain
    && JSON.stringify(nearMiss.order) === JSON.stringify(["tease", "tease", "back"])
    && nearMiss.teaseHz.every(hz => !nearMiss.backHz.includes(hz) && hz > nearMiss.tickHz[1])
    && nearMiss.backHz.every(hz => hz < nearMiss.tickHz[0])
    && plain.order.length === 0 && nearMiss.sweep.ok && plain.sweep.ok;

  const ok = !lockedBefore.interface && setup.sound === true
    && heard.osc > 30 && heard.toGainNode === heard.osc && heard.toDestination === 0
    && muted.muted && muted.osc === 0 && muted.toDestination === 0
    && !unmuted.muted && unmuted.osc > 30 && unmuted.toGainNode === unmuted.osc && unmuted.toDestination === 0
    && timing.heard.ok && timing.unmuted.ok && voicesOk
    && unchanged && !errors.length;
  const brief = run => run && { osc: run.osc, toGainNode: run.toGainNode, toDestination: run.toDestination, muted: run.muted, gain: run.gain };
  console.log(JSON.stringify({ ok, lockedBefore, setup, heard: brief(heard), muted: brief(muted), unmuted: brief(unmuted), timing, nearMiss, plain, unchanged, errors }, null, 1));
  await browser.close();
  process.exit(ok ? 0 : 1);
})();
