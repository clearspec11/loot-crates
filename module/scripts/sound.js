/*
  Synthesised crate sounds through WebAudio, so the module ships no audio
  files. Short tick per card, a slow-down whoosh, and a reveal sting whose
  pitch and length grow with rarity. Volume follows Foundry's interface
  slider when it is there.
*/
import { rarityRank } from "./odds.js";

let ctx = null;
function audio() {
  if (ctx) return ctx;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  return ctx;
}

function volume() {
  const v = globalThis.game?.settings?.get?.("core", "globalInterfaceVolume");
  return typeof v === "number" ? v : 0.5;
}

function blip(freq, duration, { type = "square", gain = 0.08, at = 0 } = {}) {
  const c = audio();
  if (!c || c.state === "suspended") return;
  const t = c.currentTime + at;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(gain * volume(), t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(g).connect(c.destination);
  osc.start(t);
  osc.stop(t + duration);
}

// progress 0..1 along the strip: the tick drops in pitch as the strip slows.
export function playTick(progress) {
  blip(900 - 300 * Math.min(1, progress), 0.03, { type: "square", gain: 0.05 });
}

export function playSlow() {
  const c = audio();
  if (!c) return;
  blip(220, 0.9, { type: "sawtooth", gain: 0.03 });
}

export function playReveal(rarity) {
  const rank = Math.max(0, rarityRank(rarity));
  const base = 440 + rank * 80;
  const notes = [0, 4, 7, 12].slice(0, 2 + Math.min(2, rank));
  notes.forEach((semi, i) => blip(base * Math.pow(2, semi / 12), 0.35 + rank * 0.08, { type: "triangle", gain: 0.12, at: i * 0.09 }));
}
