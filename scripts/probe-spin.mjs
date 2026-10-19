/* Motion probe for the spin: plays the harness spin at a short duration,
   samples the track's translateX every frame, and reports whether the strip
   moved, decelerated, overshot on a near-miss, and landed with the result
   centred under the marker.

     NODE_PATH=$(npm root -g) node scripts/probe-spin.mjs [seed] [box]

   Exit code 1 when any of those fail. */
import path from "node:path";
import { createRequire } from "node:module";
import { serveStatic } from "./lib/static.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require("playwright-core")); }

const seed = process.argv[2] ?? "7";
const box = process.argv[3] ?? "adventurer";
const PORT = 5283;
const root = path.resolve(import.meta.dirname, "..");
const server = await serveStatic(root, PORT);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.goto(`http://localhost:${PORT}/harness/?state=spin&seed=${seed}&box=${box}&duration=1800`, { waitUntil: "networkidle" });
  const out = await page.evaluate(async () => {
    const track = document.querySelector(".lc-spin__track");
    const viewport = document.querySelector(".lc-spin__viewport");
    const xs = [];
    const x = () => -new DOMMatrixReadOnly(getComputedStyle(track).transform).m41;
    await new Promise(resolve => {
      const tick = () => { xs.push(x()); if (document.body.dataset.landed) resolve(); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    const { strip } = window.__lootCrates;
    const landed = document.querySelector(".lc-card--landed");
    const vr = viewport.getBoundingClientRect(), cr = landed.getBoundingClientRect();
    const centreError = Math.abs((cr.left + cr.width / 2) - (vr.left + vr.width / 2));
    const final = xs[xs.length - 1];
    const peak = Math.max(...xs);
    const speeds = xs.slice(1).map((v, i) => v - xs[i]);
    const firstHalf = speeds.slice(0, Math.floor(speeds.length / 2)).reduce((a, b) => a + b, 0);
    const secondHalf = speeds.slice(Math.floor(speeds.length / 2)).reduce((a, b) => a + b, 0);
    return { frames: xs.length, start: xs[0], final, peak, overshoot: peak - final, nearMiss: strip.nearMiss, centreError, decelerated: firstHalf > secondHalf, landedRarity: landed.dataset.rarity, resultRarity: strip.cards[strip.landIndex].rarity };
  });
  const problems = [];
  if (out.frames < 20) problems.push(`only ${out.frames} frames`);
  if (out.final - out.start < 500) problems.push("strip barely moved");
  if (!out.decelerated) problems.push("did not decelerate");
  if (out.nearMiss && out.overshoot < 20) problems.push(`near-miss strip but overshoot only ${out.overshoot.toFixed(1)}px`);
  if (out.centreError > 2) problems.push(`result ${out.centreError.toFixed(1)}px off the marker`);
  if (out.landedRarity !== out.resultRarity) problems.push("landed card is not the result");
  console.log(JSON.stringify({ seed, box, ...out, problems }, null, 1));
  process.exitCode = problems.length ? 1 : 0;
} finally {
  await browser.close();
  server.close();
}
