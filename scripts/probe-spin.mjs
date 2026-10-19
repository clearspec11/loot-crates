/* Motion probe for the spin: plays the harness spin at a short duration,
   samples the track's translateX every frame, and reports whether the strip
   moved, decelerated, overshot on a near-miss, and landed with the result
   centred under the marker.

     NODE_PATH=$(npm root -g) node scripts/probe-spin.mjs [seed] [box] [resize]

   With "resize" the page starts 480px wide and grows to 1000px at 40% of the
   spin, the way the reveal window is sized after its first frame in Foundry,
   and the result must still land under the marker.

   On a near-miss strip the card under the marker at the peak must be the
   teased one (landIndex + 1) and the final card the result; otherwise the
   peak must stay on the result card.

   Exit code 1 when any of those fail. */
import path from "node:path";
import { createRequire } from "node:module";
import { serveStatic } from "./lib/static.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require("playwright-core")); }

const seed = process.argv[2] ?? "7";
const box = process.argv[3] ?? "adventurer";
const resize = process.argv[4] === "resize";
const DURATION = 1800;
const PORT = 5283;
const root = path.resolve(import.meta.dirname, "..");
const server = await serveStatic(root, PORT);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: resize ? 480 : 1000, height: 700 } });
  await page.goto(`http://localhost:${PORT}/harness/?state=spin&seed=${seed}&box=${box}&duration=${DURATION}`, { waitUntil: "networkidle" });
  // Sample every frame until the harness marks the body landed. The sampler
  // runs on the page while this side may resize the browser mid-spin.
  await page.evaluate(() => {
    const track = document.querySelector(".lc-spin__track");
    const viewport = document.querySelector(".lc-spin__viewport");
    const xs = [], widths = [];
    const x = () => -new DOMMatrixReadOnly(getComputedStyle(track).transform).m41;
    window.__probe = new Promise(resolve => {
      const tick = () => { xs.push(x()); widths.push(viewport.clientWidth); if (document.body.dataset.landed) resolve({ xs, widths }); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
  });
  if (resize) {
    await page.waitForTimeout(DURATION * 0.4);
    await page.setViewportSize({ width: 1000, height: 700 });
  }
  const out = await page.evaluate(async () => {
    const { xs, widths } = await window.__probe;
    const viewport = document.querySelector(".lc-spin__viewport");
    const { strip } = window.__lootCrates;
    const landed = document.querySelector(".lc-card--landed");
    const vr = viewport.getBoundingClientRect(), cr = landed.getBoundingClientRect();
    const centreError = Math.abs((cr.left + cr.width / 2) - (vr.left + vr.width / 2));
    const final = xs[xs.length - 1];
    const peak = Math.max(...xs);
    // The card under the marker, by the same rule spin.js's onTick uses.
    const track = document.querySelector(".lc-spin__track");
    const step = parseFloat(track.style.getPropertyValue("--lc-card-w")) + parseFloat(track.style.getPropertyValue("--lc-card-gap"));
    // Track the marker's position along the strip, not raw x: x shifts by
    // half the width change when the viewport resizes mid-spin.
    const marks = xs.map((x, i) => x + widths[i] / 2);
    const peakIndex = Math.floor(Math.max(...marks) / step);
    const finalIndex = Math.floor(marks[marks.length - 1] / step);
    const speeds = xs.slice(1).map((v, i) => v - xs[i]);
    const firstHalf = speeds.slice(0, Math.floor(speeds.length / 2)).reduce((a, b) => a + b, 0);
    const secondHalf = speeds.slice(Math.floor(speeds.length / 2)).reduce((a, b) => a + b, 0);
    return { frames: xs.length, start: xs[0], final, peak, overshoot: Math.max(...marks) - marks[marks.length - 1], nearMiss: strip.nearMiss, landIndex: strip.landIndex, peakIndex, finalIndex, teaseRarity: strip.nearMiss ? strip.cards[strip.landIndex + 1].rarity : null, centreError, decelerated: firstHalf > secondHalf, widthFirst: widths[0], widthEnd: widths[widths.length - 1], landedRarity: landed.dataset.rarity, resultRarity: strip.cards[strip.landIndex].rarity };
  });
  const problems = [];
  if (out.frames < 20) problems.push(`only ${out.frames} frames`);
  if (out.final - out.start < 500) problems.push("strip barely moved");
  if (!out.decelerated) problems.push("did not decelerate");
  if (out.nearMiss && out.peakIndex !== out.landIndex + 1) problems.push(`near-miss strip but the marker peaked on card ${out.peakIndex}, not the teased card ${out.landIndex + 1}`);
  if (!out.nearMiss && out.peakIndex !== out.landIndex) problems.push(`no near-miss but the marker overshot onto card ${out.peakIndex}`);
  if (out.finalIndex !== out.landIndex) problems.push(`marker ended on card ${out.finalIndex}, not the result ${out.landIndex}`);
  if (out.centreError > 2) problems.push(`result ${out.centreError.toFixed(1)}px off the marker`);
  if (out.landedRarity !== out.resultRarity) problems.push("landed card is not the result");
  if (resize && out.widthEnd - out.widthFirst < 200) problems.push(`viewport only grew ${out.widthFirst}px to ${out.widthEnd}px; the resize case did not resize`);
  console.log(JSON.stringify({ seed, box, resize, ...out, problems }, null, 1));
  process.exitCode = problems.length ? 1 : 0;
} finally {
  await browser.close();
  server.close();
}
