/*
  Synthesised crate sounds through WebAudio, so the module ships no audio
  files. Short tick per card, a falling sweep while the strip brakes, and a
  reveal sting whose pitch and length grow with rarity. On a near-miss the
  card past the result gets a tease (two quick rising notes, above every
  tick) and the click back onto the result a low, soft knock, so the pull
  forward and the drop back sound like what they are.

  Every sound plays on Foundry's interface channel (game.audio.interface),
  wired into its gainNode, so the interface volume slider and the hotbar
  Mute apply at once, even to a sound already playing. Foundry makes that
  context on the client's first gesture; before it exists (game.audio
  .locked) or while the channel is muted or at zero, nothing is built.
*/
import { rarityRank } from "../core/odds.js";

function channel() {
  const audio = globalThis.game?.audio;
  const ctx = audio?.interface;
  if (!ctx?.gainNode || audio.locked) return null;
  if (audio.globalMute || ctx.gainNode.gain.value === 0) return null;
  return ctx;
}

function blip(ctx, freq, duration, { type = "square", gain = 0.08, at = 0 } = {}) {
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(g).connect(ctx.gainNode);
  osc.start(t);
  osc.stop(t + duration);
}

// Strip ticks fall from 900 Hz to 600 Hz with progress; the near-miss
// voices sit outside that band so the ear can't mistake them for a tick.
export const TICK_HZ = [600, 900];
export const TEASE_HZ = [1175, 1568];
export const BACK_HZ = 330;
export const SWEEP_HZ = [260, 90];

// progress 0..1 along the strip: the tick drops in pitch as the strip slows.
// { tease } is the marker crossing into the better card past the result;
// { back } is the strip dropping back onto the result after a tease.
export function playTick(progress, { tease = false, back = false } = {}) {
  const ctx = channel();
  if (!ctx) return;
  if (tease) TEASE_HZ.forEach((hz, i) => blip(ctx, hz, 0.06, { type: "triangle", gain: 0.06, at: i * 0.07 }));
  else if (back) blip(ctx, BACK_HZ, 0.09, { type: "triangle", gain: 0.04 });
  else blip(ctx, TICK_HZ[1] - (TICK_HZ[1] - TICK_HZ[0]) * Math.min(1, progress), 0.03, { type: "square", gain: 0.05 });
}

// The strip braking: a sawtooth falling from 260 Hz to 90 Hz through a
// lowpass that closes with it, fading out over `ms` (the braking's length),
// so it winds down with the strip instead of buzzing at one pitch.
// Returns stop(): a strip that lands early (Skip, Close, a hidden page)
// cuts the sweep in a few ms rather than letting it wind down for seconds
// under the reveal's sting. Nothing built, nothing to stop.
const SWEEP_CUT_S = 0.04;
export function playSlow(ms = 900) {
  const ctx = channel();
  if (!ctx) return () => {};
  const t = ctx.currentTime;
  const end = t + Math.max(0.2, ms / 1000);
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(SWEEP_HZ[0], t);
  osc.frequency.exponentialRampToValueAtTime(SWEEP_HZ[1], end);
  g.gain.setValueAtTime(0.03, t);
  g.gain.exponentialRampToValueAtTime(0.0001, end);
  let head = osc;
  if (typeof ctx.createBiquadFilter === "function") {
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(1400, t);
    lp.frequency.exponentialRampToValueAtTime(200, end);
    head = osc.connect(lp);
  }
  head.connect(g).connect(ctx.gainNode);
  osc.start(t);
  osc.stop(end);
  let cut = false;
  return () => {
    const now = ctx.currentTime;
    if (cut || now >= end) return;
    cut = true;
    try {
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(g.gain.value, now);
      g.gain.linearRampToValueAtTime(0, now + SWEEP_CUT_S);
      osc.stop(now + SWEEP_CUT_S);
    } catch (err) {
      console.error("loot-crates | could not cut the braking sweep", err);
    }
  };
}

export function playReveal(rarity) {
  const ctx = channel();
  if (!ctx) return;
  const rank = Math.max(0, rarityRank(rarity));
  const base = 440 + rank * 80;
  const notes = [0, 4, 7, 12].slice(0, 2 + Math.min(2, rank));
  notes.forEach((semi, i) => blip(ctx, base * Math.pow(2, semi / 12), 0.35 + rank * 0.08, { type: "triangle", gain: 0.12, at: i * 0.09 }));
}

/*
  The Wishing Well's three small sounds (well.js). The plop as the coin meets
  the water: a low sine knocked down an octave in a tenth of a second. The
  plink of a throw that gave nothing: one high, short triangle note, soft,
  so a miss is heard and not announced. The coin back: two rising notes,
  the tease's shape at a lower pitch. An item plays the rarity sting above.
*/
export function playPlop() {
  const ctx = channel();
  if (!ctx) return;
  blip(ctx, 220, 0.12, { type: "sine", gain: 0.08 });
  blip(ctx, 110, 0.2, { type: "sine", gain: 0.05, at: 0.04 });
}

export function playPlink() {
  const ctx = channel();
  if (!ctx) return;
  blip(ctx, 1760, 0.09, { type: "triangle", gain: 0.04 });
}

export function playCoinBack() {
  const ctx = channel();
  if (!ctx) return;
  [660, 990].forEach((hz, i) => blip(ctx, hz, 0.12, { type: "triangle", gain: 0.06, at: i * 0.09 }));
}

/*
  The wheel's ball dropping into its pocket (roulette.js): one short, soft
  sine knock, lower and shorter than the well's plop (which is two notes
  and means water), so the drop reads as the ball meeting wood.
*/
export function playDrop() {
  const ctx = channel();
  if (!ctx) return;
  blip(ctx, 180, 0.08, { type: "sine", gain: 0.07 });
}

/*
  The deck's bane (deck.js): the one sound in the module that falls. Two
  notes a fifth apart, the second lower and longer, soft, so a card that
  takes coins is heard as a loss where every other sting rises with what
  was won. Nothing else uses it.
*/
export const BANE_HZ = [294, 196];
export function playBane() {
  const ctx = channel();
  if (!ctx) return;
  blip(ctx, BANE_HZ[0], 0.22, { type: "triangle", gain: 0.07 });
  blip(ctx, BANE_HZ[1], 0.4, { type: "triangle", gain: 0.06, at: 0.18 });
}

/*
  The scratch ticket's sounds (scratch.js), as the approved mockup has them.
  The rasp: a brown-ish noise (white noise through a one-pole lowpass, made
  once per context and looped) through a bandpass whose centre and level
  follow the coin's speed, from 900 Hz and .04 at a crawl to 3300 Hz and .16
  at a fast stroke. Each movement sets the level and lets it fall to nothing
  over 140 ms, so a coin held still goes quiet. playScratch starts one voice
  on pointerdown (or the spectators' sweep) and returns { rasp(speed),
  stop() }; stop fades it in about 30 ms and ends the source. With no
  channel, a voice that does nothing. The tick as a panel gives: one short
  square note at 1400 Hz, above the strip's ticks.
*/
export const SCRATCH_HZ = [900, 3300];
export const SCRATCH_GAIN = [0.04, 0.16];
export const FOIL_TICK_HZ = 1400;
const RASP_FALL_S = 0.14;

// The rasp's centre and level at a speed (css px the coin moved since the last event).
export function scratchLevel(speed = 0) {
  const s = Math.max(0, Number(speed) || 0);
  return { hz: SCRATCH_HZ[0] + Math.min(SCRATCH_HZ[1] - SCRATCH_HZ[0], s * 120), gain: Math.min(SCRATCH_GAIN[1], SCRATCH_GAIN[0] + s * 0.012) };
}

const noiseBuffers = new WeakMap();
function brownNoise(ctx) {
  let buf = noiseBuffers.get(ctx);
  if (buf) return buf;
  buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b = 0;
  for (let i = 0; i < d.length; i++) { b = b * 0.6 + (Math.random() * 2 - 1) * 0.4; d[i] = b * 1.6; }
  noiseBuffers.set(ctx, buf);
  return buf;
}

const SILENT = Object.freeze({ rasp() {}, stop() {} });

export function playScratch(speed = 0) {
  const ctx = channel();
  if (!ctx || typeof ctx.createBufferSource !== "function" || typeof ctx.createBiquadFilter !== "function") return SILENT;
  let src, filt, g;
  try {
    src = ctx.createBufferSource();
    src.buffer = brownNoise(ctx);
    src.loop = true;
    filt = ctx.createBiquadFilter();
    filt.type = "bandpass";
    filt.frequency.setValueAtTime(SCRATCH_HZ[0], ctx.currentTime);
    if (filt.Q) filt.Q.value = 0.9;
    g = ctx.createGain();
    g.gain.setValueAtTime(0, ctx.currentTime);
    src.connect(filt).connect(g).connect(ctx.gainNode);
    src.start();
  } catch (err) {
    console.error("loot-crates | could not start the scratch rasp", err);
    return SILENT;
  }
  let stopped = false;
  const voice = {
    rasp(v = 6) {
      if (stopped) return;
      const t = ctx.currentTime;
      const { hz, gain } = scratchLevel(v);
      filt.frequency.setTargetAtTime(hz, t, 0.02);
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(gain, t);
      g.gain.linearRampToValueAtTime(0, t + RASP_FALL_S);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      const t = ctx.currentTime;
      try {
        g.gain.cancelScheduledValues(t);
        g.gain.setTargetAtTime(0, t, 0.03);
        src.stop(t + 0.2);
      } catch (err) {
        console.error("loot-crates | could not stop the scratch rasp", err);
      }
    },
  };
  if (speed > 0) voice.rasp(speed);
  return voice;
}

export function playFoilTick() {
  const ctx = channel();
  if (!ctx) return;
  blip(ctx, FOIL_TICK_HZ, 0.06, { type: "square", gain: 0.04 });
}
