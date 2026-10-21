/*
  Synthesised crate sounds through WebAudio, so the module ships no audio
  files. Short tick per card, a slow-down whoosh, and a reveal sting whose
  pitch and length grow with rarity.

  Every sound plays on Foundry's interface channel (game.audio.interface),
  wired into its gainNode, so the interface volume slider and the hotbar
  Mute apply at once, even to a sound already playing. Foundry makes that
  context on the client's first gesture; before it exists (game.audio
  .locked) or while the channel is muted or at zero, nothing is built.
*/
import { rarityRank } from "./odds.js";

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

// progress 0..1 along the strip: the tick drops in pitch as the strip slows.
export function playTick(progress) {
  const ctx = channel();
  if (ctx) blip(ctx, 900 - 300 * Math.min(1, progress), 0.03, { type: "square", gain: 0.05 });
}

export function playSlow() {
  const ctx = channel();
  if (ctx) blip(ctx, 220, 0.9, { type: "sawtooth", gain: 0.03 });
}

export function playReveal(rarity) {
  const ctx = channel();
  if (!ctx) return;
  const rank = Math.max(0, rarityRank(rarity));
  const base = 440 + rank * 80;
  const notes = [0, 4, 7, 12].slice(0, 2 + Math.min(2, rank));
  notes.forEach((semi, i) => blip(ctx, base * Math.pow(2, semi / 12), 0.35 + rank * 0.08, { type: "triangle", gain: 0.12, at: i * 0.09 }));
}
