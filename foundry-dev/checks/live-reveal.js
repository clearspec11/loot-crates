// Live check: play the reveal window in the dev world with the branch's
// scripts and no module installed, and measure where the result lands.
// Builds a pool from dnd5e's items compendium, rolls a result, builds the
// strip around it and calls showReveal, exactly as the socket path does, then
// waits for the landed card and reports how far its centre sits from the
// marker, plus the spin viewport's width at the first frame and at the end
// (the window is sized after the first frame, which is the case that used to
// land the wrong card under the marker).
//
//   FOUNDRY_URL=http://192.168.0.57:30000 MODULE_BASE=http://192.168.0.190:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/headless/run.cjs foundry-dev/checks/live-reveal.js --shot /tmp/reveal.png
//
// Writes nothing to the world: no actor, no purchase, no settings beyond
// registering the module's own.
const SEED = 7;
if (!document.querySelector("link[data-loot-crates]")) {
  const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: MODULE_BASE + "styles/module.css" });
  link.dataset.lootCrates = "1";
  document.head.appendChild(link);
}
const store = await import(MODULE_BASE + "scripts/store.js");
const { draw, seededRng } = await import(MODULE_BASE + "scripts/odds.js");
const { buildStrip } = await import(MODULE_BASE + "scripts/strip.js");
const { showReveal } = await import(MODULE_BASE + "scripts/reveal.js");
try { store.registerSettings(); } catch (e) { if (!/already registered/i.test(String(e))) throw e; }
store.registerIndexFields();

const packId = game.packs.find(p => p.collection === "dnd5e.items" || (p.documentName === "Item" && /items/i.test(p.collection)))?.collection;
const entries = await store.entriesFromCompendium(packId, { types: ["weapon", "equipment", "consumable"] });
if (!entries.length) throw new Error(`no items in ${packId}`);
const pools = { live: { id: "live", name: "Live reveal", entries, pools: [] } };
const box = { id: "live-box", name: "Live Reveal Crate", price: 50, pools: [{ id: "live", share: 1 }], weights: { common: 50, uncommon: 30, rare: 15, veryRare: 4, legendary: 1 }, rules: {} };
const rng = seededRng(SEED);
const result = draw({ box, pools, rng, state: {} });
const strip = buildStrip({ result, box, pools, rng });
const reveal = {
  type: "reveal", actorName: "Crate Tester", box: { id: box.id, name: box.name, price: box.price },
  result: { uuid: result.entry.uuid, name: result.entry.name, img: result.entry.img, rarity: result.rarity, pity: result.pity },
  strip, purse: { gp: 450 },
};

// Record the spin viewport's width the first frame it exists, before the
// window has been sized, so the report shows whether the late sizing happened.
let widthFirst = null;
const firstFrame = new Promise(resolve => {
  const look = () => {
    const v = document.querySelector(".lc-reveal .lc-spin__viewport");
    if (v) { widthFirst = v.clientWidth; resolve(); } else requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
});
const t0 = performance.now();
const app = await showReveal(reveal);
await firstFrame;
await new Promise((resolve, reject) => {
  const giveUp = setTimeout(() => reject(new Error("no landed card after 12s")), 12000);
  const look = () => {
    if (document.querySelector(".lc-reveal .lc-card--landed")) { clearTimeout(giveUp); resolve(); } else requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
});
await new Promise(r => setTimeout(r, 500)); // let the landed card's lift transition finish before measuring

const root = app.element;
const viewport = root.querySelector(".lc-spin__viewport");
const marker = root.querySelector(".lc-spin__marker");
const landed = root.querySelector(".lc-card--landed");
const tease = landed.nextElementSibling;
const vr = viewport.getBoundingClientRect(), mr = marker.getBoundingClientRect(), cr = landed.getBoundingClientRect();
const centreError = Math.abs((cr.left + cr.width / 2) - (mr.left + mr.width / 2));
return {
  pack: packId, poolSize: entries.length, seed: SEED,
  playedMs: Math.round(performance.now() - t0),
  widthFirst, widthEnd: viewport.clientWidth, windowWidth: root.getBoundingClientRect().width,
  centreError: Math.round(centreError * 10) / 10,
  landed: { name: landed.querySelector(".lc-card__name").textContent, rarity: landed.dataset.rarity },
  result: reveal.result.name, resultRarity: reveal.result.rarity, nearMiss: strip.nearMiss,
  tease: tease ? { name: tease.querySelector(".lc-card__name").textContent, rarity: tease.dataset.rarity, leftOfMarkerPx: Math.round((tease.getBoundingClientRect().left + tease.getBoundingClientRect().width / 2) - (mr.left + mr.width / 2)) } : null,
  resultText: root.querySelector(".lc-reveal__result")?.innerText,
  ok: centreError <= 2 && landed.dataset.rarity === reveal.result.rarity,
};
