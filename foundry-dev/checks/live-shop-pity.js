// Live check: the Crate Shop shows Crate Tester's own odds for a box with
// noDuplicates and pity, and follows a pull. With the branch's socket and
// redraw listener in place of the installed module's (as player-pull.cjs
// does), it saves a test pool "Live pity pool" (two entries of the lowest
// rarity in "Live UI pool", one of its highest) and a 1 gp box "Live pity
// crate" (pity after 2 for the high rarity, no duplicates), picks Crate
// Tester in the shop's character select, then sets Crate Tester's pity state
// for that box and reads the card each time:
//   fresh (sinceRare 1)   both rarities, "<High> or better within 2 pulls"
//   owns all three        "Nothing new for Crate Tester", Buy aria-disabled
//                          with that visible reason
//   due (sinceRare 2)     only the high rarity, "... guaranteed this pull"
// Every card's pills must equal shopOdds(box, pools, state). Then it presses
// Buy once with a pointer press (one real 1 gp purchase, from the fresh
// state) and watches every frame until the reveal lands. Since 0.7.0 the
// buyer's shop holds the result back until their spin lands (reveal.js
// heldState): the GM writes the new state ~0.3 s into the spin, but the
// card's pity line and pills must stay as they were before the click on
// every frame from that write until this pull's card is under the marker
// (.lc-card--landed), then change to what the new state says within 1 s of
// the landing. A pull of the pool's one high-rarity entry leaves Crate
// Tester owning it, so the card then has no pity line and the low rarity
// alone (branch "owns-every-high"); either branch passes on the module.
// It also checks the reveal's odds were the shop's.
//
//   FOUNDRY_URL=http://<foundry>:30000 MODULE_BASE=http://<this machine>:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/headless/run.cjs foundry-dev/checks/live-shop-pity.js --shot /tmp/pity.png
//
// Writes only the module's own settings (the test pool and box, Crate
// Tester's state for that box, the log row) and the one purchase on Crate
// Tester. Needs "Crate Tester" in "Loot Crates Test" and "Live UI pool"
// (live-pull.js and live-ui.js make them).
if (!document.querySelector("link[data-loot-crates]")) {
  const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: MODULE_BASE + "styles/module.css" });
  link.dataset.lootCrates = "1";
  document.head.appendChild(link);
}
globalThis.canvas?.app?.ticker?.stop();
game.socket.off("module.loot-crates");
const store = await import(MODULE_BASE + "scripts/foundry/store.js");
try { store.registerSettings(); } catch { /* the installed module registered them */ }
try { store.registerIndexFields(); } catch { /* already in CONFIG */ }
const socket = await import(MODULE_BASE + "scripts/foundry/socket.js");
socket.registerSocket();
const { storeRedraw } = await import(MODULE_BASE + "scripts/core/redraw.js");
const { openShop, refreshShop } = await import(MODULE_BASE + "scripts/foundry/shop.js");
const { refreshManager } = await import(MODULE_BASE + "scripts/foundry/manager.js");
const { shopOdds, flattenPool, rarityRank } = await import(MODULE_BASE + "scripts/core/odds.js");
const { RARITY_SHORT, RARITY_LABEL } = await import(MODULE_BASE + "scripts/core/config.js");
const redraw = storeRedraw({ refreshShop, refreshManager });
store.setStoreListener(redraw);
for (const key of store.WORLD_KEYS) {
  const cfg = game.settings.settings.get(`loot-crates.${key}`);
  if (cfg && !String(cfg.onChange ?? "").includes("storeChanged")) cfg.onChange = () => redraw(key);
}
if (!socket.isActiveGM()) throw new Error("this page is not the active GM");

const folder = game.folders.find(f => f.type === "Actor" && f.name === "Loot Crates Test");
const actor = game.actors.find(a => a.name === "Crate Tester" && a.folder?.id === folder?.id);
if (!actor) throw new Error("no Crate Tester in Loot Crates Test: run live-pull.js first");
if ((actor.system.currency.gp ?? 0) < 5) await actor.update({ "system.currency.gp": 1000 });

const live = Object.values(store.getPools()).find(p => p.name === "Live UI pool");
if (!live) throw new Error("no Live UI pool: run live-ui.js first");
const ranked = flattenPool(live.id, store.getPools()).sort((a, b) => rarityRank(a.rarity) - rarityRank(b.rarity));
const low = ranked.filter(e => e.rarity === ranked[0].rarity).slice(0, 2);
const high = ranked[ranked.length - 1];
if (low.length < 2 || high.rarity === low[0].rarity) throw new Error("Live UI pool needs two rarities");
const strip = ({ uuid, name, img, rarity, sourceRarity, weight }) => ({ uuid, name, img, rarity, sourceRarity, weight });
const entries = [...low, high].map(strip);
const oldPool = Object.values(store.getPools()).find(p => p.name === "Live pity pool");
const pool = await store.savePool({ ...(oldPool ? { id: oldPool.id } : {}), name: "Live pity pool", entries, pools: [] });
const oldBox = Object.values(store.getBoxes()).find(b => b.name === "Live pity crate");
const box = await store.saveBox({
  ...(oldBox ? { id: oldBox.id } : {}), name: "Live pity crate", price: 1, pools: [{ id: pool.id, share: 1 }],
  weights: { [low[0].rarity]: 90, [high.rarity]: 10 },
  rules: { pity: { after: 2, minRarity: high.rarity }, noDuplicates: true, stock: null },
});

const frames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { for (let t = 0; t < ms && !fn(); t += 50) await wait(50); return fn(); };
// A person's press: pointer and mouse down (which focuses a button), up,
// then the click.
const press = el => {
  const at = { bubbles: true, cancelable: true, composed: true, button: 0, view: window };
  el.dispatchEvent(new PointerEvent("pointerdown", { ...at, pointerType: "mouse", isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mousedown", at));
  el.focus();
  el.dispatchEvent(new PointerEvent("pointerup", { ...at, pointerType: "mouse", isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mouseup", at));
  el.dispatchEvent(new MouseEvent("click", at));
};

// Crate Tester, chosen in the shop's character select as a person does.
const app = openShop();
await app.render({ force: true });
const picker = () => app.element?.querySelector(".lc-shop__actor");
if (picker() && picker().value !== actor.id) {
  picker().focus();
  picker().value = actor.id;
  picker().dispatchEvent(new Event("input", { bubbles: true }));
  picker().dispatchEvent(new Event("change", { bubbles: true }));
}
if (!await until(() => app.actorId === actor.id && app.element?.querySelector(`.lc-box[data-box="${CSS.escape(box.id)}"] .lc-box__buy`))) {
  throw new Error(`the shop did not switch to Crate Tester (on ${app.actor?.name ?? "nobody"})`);
}
const card = () => app.element.querySelector(`.lc-box[data-box="${CSS.escape(box.id)}"]`);
const read = () => {
  const c = card();
  const btn = c?.querySelector(".lc-box__buy");
  const ids = (btn?.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
  const whys = ids.map(id => app.element.querySelector(`#${CSS.escape(id)}`));
  return {
    pills: [...(c?.querySelectorAll(".lc-odd") ?? [])].map(p => p.textContent.trim()),
    pity: c?.querySelector(".lc-box__pity")?.textContent.trim() ?? null,
    off: btn?.getAttribute("aria-disabled") === "true",
    why: whys.map(w => w?.textContent.trim() ?? "").join(" "),
    whyShown: whys.length > 0 && whys.every(w => w && w.getBoundingClientRect().height > 0),
  };
};
const expectPills = state => shopOdds(box, store.getPools(), state).rows.map(r => `${RARITY_SHORT[r.rarity]} ${r.label}`);
const what = `${RARITY_LABEL[high.rarity]} or better`;
const problems = [];
const cases = {};
const setState = async state => {
  await store.setActorState(actor.id, box.id, state);
  await wait(400);
  await frames();
};

// Fresh, one pull since the floor.
await setState({ sinceRare: 1, owned: [] });
cases.fresh = read();
if (JSON.stringify(cases.fresh.pills) !== JSON.stringify(expectPills({ sinceRare: 1 }))) problems.push(`fresh pills ${cases.fresh.pills} != ${expectPills({ sinceRare: 1 })}`);
if (cases.fresh.pills.length !== 2) problems.push("fresh card should show both rarities");
if (cases.fresh.pity !== `${what} within 2 pulls`) problems.push(`fresh pity line "${cases.fresh.pity}"`);

// Owns everything.
await setState({ sinceRare: 1, owned: entries.map(e => e.uuid) });
cases.ownsAll = read();
if (!cases.ownsAll.off || cases.ownsAll.why !== "Nothing new for Crate Tester" || !cases.ownsAll.whyShown) problems.push(`owns-all card: ${JSON.stringify(cases.ownsAll)}`);
if (cases.ownsAll.pills.length) problems.push("owns-all card still shows odds");

// Pity due.
await setState({ sinceRare: 2, owned: [] });
cases.due = read();
if (JSON.stringify(cases.due.pills) !== JSON.stringify(expectPills({ sinceRare: 2 })) || cases.due.pills.length !== 1) problems.push(`due pills ${cases.due.pills}`);
if (cases.due.pity !== `${what} guaranteed this pull`) problems.push(`due pity line "${cases.due.pity}"`);

// One real pull from the fresh state, through the shop's Buy.
await setState({ sinceRare: 1, owned: [] });
const before = store.getActorState(actor.id, box.id);
const shownBefore = read();
const purseBefore = { ...actor.system.currency };
const revealsBefore = new Set(document.querySelectorAll(".lc-reveal"));
const t0 = performance.now();
press(card().querySelector(".lc-box__buy"));
// Every frame from the click: when the GM's state write arrives, when this
// pull's reveal opens and lands, and the first frame the card differs from
// the card before the click. The write comes ~0.3 s into the spin; the card
// must hold until the landing, then follow within 1 s.
let stateMs = null, revealMs = null, landedMs = null, lineMs = null, revealEl = null;
const early = [];
let heldFrames = 0;
const deadline = t0 + 20000;
while (performance.now() < deadline) {
  await new Promise(r => requestAnimationFrame(r));
  const now = performance.now() - t0;
  const s = store.getActorState(actor.id, box.id);
  if (stateMs == null && (s.pulls ?? 0) !== (before.pulls ?? 0)) stateMs = now;
  revealEl ??= [...document.querySelectorAll(".lc-reveal")].find(el => !revealsBefore.has(el)) ?? null;
  if (revealEl && revealMs == null) revealMs = now;
  if (revealEl && landedMs == null && revealEl.querySelector(".lc-card--landed")) landedMs = now;
  const shown = read();
  const changed = shown.pity !== shownBefore.pity || JSON.stringify(shown.pills) !== JSON.stringify(shownBefore.pills);
  if (landedMs == null) {
    if (stateMs != null && !changed) heldFrames++;
    if (changed && early.length < 3) early.push({ ms: Math.round(now), pity: shown.pity, pills: shown.pills });
  } else if (changed) { lineMs = now; break; }
  else if (now - landedMs > 3000) break;
}
const after = store.getActorState(actor.id, box.id);
const row = store.getLog().find(r => r.boxId === box.id && r.actorId === actor.id);
// The pull may drop the pool's only high-rarity entry: Crate Tester then
// owns every one of that rarity (noDuplicates), so the card has no pity
// line and shows the low rarity alone. Otherwise the pity line counts on.
const ownsEveryHigh = entries.filter(e => e.rarity === high.rarity).every(e => (after.owned ?? []).includes(e.uuid));
const branch = ownsEveryHigh ? "owns-every-high" : "pity-counting";
const wantLine = ownsEveryHigh ? null : after.sinceRare >= 2 ? `${what} guaranteed this pull` : `${what} within ${2 - after.sinceRare + 1} pulls`;
if (stateMs == null) problems.push("the pull's state was never written");
if (revealMs == null) problems.push("no reveal opened for the pull");
else if (landedMs == null) problems.push("the reveal never landed (.lc-card--landed)");
if (stateMs != null && landedMs != null && stateMs >= landedMs) problems.push(`the state write (${Math.round(stateMs)} ms) came after the landing (${Math.round(landedMs)} ms), so the hold was not tested`);
if (early.length) problems.push(`the card changed during the spin, before the landing: ${JSON.stringify(early)}`);
if (landedMs != null && lineMs == null) problems.push("the open shop's pity line never changed after the landing");
else if (lineMs != null && lineMs - landedMs > 1000) problems.push(`pity line redrew ${Math.round(lineMs - landedMs)} ms after the landing (> 1 s)`);
if (lineMs != null) await frames();
cases.afterPull = { ...read(), state: after, got: row?.name, rarity: row?.rarity, branch };
if (cases.afterPull.pity !== wantLine) problems.push(`after the pull the line reads "${cases.afterPull.pity}", want "${wantLine}"`);
if (ownsEveryHigh && (cases.afterPull.pills.length !== 1 || !cases.afterPull.pills[0].startsWith(RARITY_SHORT[low[0].rarity]))) problems.push(`owning every ${high.rarity}, the card should show ${low[0].rarity} alone: ${cases.afterPull.pills}`);
if (JSON.stringify(cases.afterPull.pills) !== JSON.stringify(expectPills(after))) problems.push(`after-pull pills ${cases.afterPull.pills} != ${expectPills(after)}`);
// The reveal's ribbon is the odds the shop showed before the click.
const ribbon = [...(revealEl?.querySelectorAll(".lc-ribbon__seg") ?? [])].map(s => s.getAttribute("title"));
const reveal = { ribbon, shownBefore: shownBefore.pills };
const wantRibbon = shopOdds(box, store.getPools(), before).rows.map(r => `${RARITY_LABEL[r.rarity]} ${r.label}`);
if (JSON.stringify(ribbon) !== JSON.stringify(wantRibbon)) problems.push(`reveal ribbon ${ribbon} != shop's ${wantRibbon}`);

return {
  ok: !problems.length,
  problems,
  box: { id: box.id, low: low[0].rarity, high: high.rarity },
  cases,
  timings: {
    stateWrittenMs: stateMs && Math.round(stateMs),
    revealMs: revealMs && Math.round(revealMs),
    landedMs: landedMs && Math.round(landedMs),
    lineRedrawnMs: lineMs && Math.round(lineMs),
    // How long the line stayed as it was after the GM wrote the new state,
    // and how soon after the landing it changed (<= 1 s).
    heldAfterWriteMs: stateMs != null && landedMs != null ? Math.round(landedMs - stateMs) : null,
    heldFrames,
    changedAfterLandingMs: lineMs != null && landedMs != null ? Math.round(lineMs - landedMs) : null,
  },
  reveal,
  purse: { before: purseBefore, after: actor.system.currency },
};
