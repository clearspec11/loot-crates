// Live check: the payoff after the spin. Part 1 buys one crate as the GM
// through the socket path (requestPull) for Crate Tester and reports, from
// the real reveal window: the action button enabled mid-spin (it reads Skip),
// the result text naming the inventory and the gold left, focus on Close
// after landing, that Open item renders the granted item's sheet, and that
// the newest chat card carries a content link whose data-uuid resolves via
// fromUuid to the granted item.
//
// Part 2 makes no purchase: it opens two reveal windows for the same item
// with distinct requestIds a frame apart, reports their origins (they must
// differ), closes the first mid-spin, and confirms its chat card still posts
// (the same showReveal -> landed -> postPullCard chain socket.js runs).
//
//   FOUNDRY_URL=http://192.168.0.57:30000 MODULE_BASE=http://192.168.0.190:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/headless/run.cjs foundry-dev/checks/live-payoff.js [--shot out.png]
//
// Never deletes anything. Writes the module's own settings (one pool, one
// box, one log row); each run adds one item to the test actor and posts
// three chat cards.
if (!document.querySelector("link[data-loot-crates]")) {
  const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: MODULE_BASE + "styles/module.css" });
  link.dataset.lootCrates = "1";
  document.head.appendChild(link);
}
const store = await import(MODULE_BASE + "scripts/foundry/store.js");
const { registerSocket, requestPull } = await import(MODULE_BASE + "scripts/foundry/socket.js");
const { showReveal } = await import(MODULE_BASE + "scripts/foundry/reveal.js");
const { postPullCard } = await import(MODULE_BASE + "scripts/foundry/chat.js");
try { store.registerSettings(); } catch (e) { if (!/already registered/i.test(String(e))) throw e; }
store.registerIndexFields();
try { registerSocket(); } catch { /* registered on an earlier run of the same page */ }

const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(test, ms, what) {
  const t0 = performance.now();
  for (;;) {
    const v = test();
    if (v) return v;
    if (performance.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await wait(25);
  }
}
const appFor = requestId => foundry.applications.instances.get(`loot-crates-reveal-${requestId}`);
const cards = () => game.messages.contents.filter(m => m.flags?.["loot-crates"] && !m.flags["loot-crates"].refunded);

const FOLDER = "Loot Crates Test";
let folder = game.folders.find(f => f.type === "Actor" && f.name === FOLDER);
folder ??= await Folder.create({ name: FOLDER, type: "Actor" });
const name = "Crate Tester";
let actor = game.actors.find(a => a.name === name && a.folder?.id === folder.id);
actor ??= await Actor.create({ name, type: "character", folder: folder.id, system: { currency: { pp: 0, gp: 500, ep: 0, sp: 0, cp: 0 } } });
if (actor.system.currency.gp < 50) await actor.update({ "system.currency.gp": 500 });

const live = await store.entriesFromCompendium("dnd5e.items", { types: ["weapon", "equipment", "consumable"], rarities: ["uncommon", "rare"] });
if (!live.length) throw new Error("no uncommon/rare items in dnd5e.items");
const pool = await store.savePool({ id: "live-payoff", name: "Live payoff check", pools: [], entries: live.slice(0, 40) });
const box = await store.saveBox({ id: "live-payoff-box", name: "Live Payoff Crate", price: 50, pools: [{ id: pool.id, share: 1 }], weights: { uncommon: 80, rare: 20 }, rules: {} });
if (!store.isShopOpen()) await store.setShopOpen(true);

// ---------- Part 1: one real pull ----------
const cardsBefore = cards().length;
const reveal = await requestPull({ boxId: box.id, actorId: actor.id });
const app = await until(() => appFor(reveal.requestId)?.element?.querySelector(".lc-reveal__close"), 5000, "the reveal window") && appFor(reveal.requestId);
const root = app.element;
const btn = root.querySelector(".lc-reveal__close");
await wait(800);
const midSpin = {
  landed: !!root.querySelector(".lc-card--landed"),
  label: btn.textContent, enabled: !btn.disabled,
  stripHidden: root.querySelector(".lc-spin__track")?.getAttribute("aria-hidden"),
};
await until(() => root.querySelector(".lc-card--landed"), 12000, "the landed card");
await wait(800); // the where-line fades in after the 420 ms lift
const result = root.querySelector(".lc-reveal__result");
const afterLand = {
  text: result.innerText,
  nameColour: getComputedStyle(root.querySelector(".lc-reveal__name")).color,
  label: btn.textContent,
  focusOnClose: document.activeElement === btn,
  openItemShown: !root.querySelector(".lc-reveal__open").hidden,
};

root.querySelector(".lc-reveal__open").click();
const granted = actor.items.get(reveal.itemId);
const sheetOpened = !!(await until(() => granted?.sheet?.rendered, 5000, "the item sheet").catch(() => false));
await granted?.sheet?.close();

const msg = await until(() => cards().length > cardsBefore && cards().at(-1), 5000, "the chat card");
const anchor = new DOMParser().parseFromString(msg.content, "text/html").querySelector("a.content-link");
const linked = anchor ? await fromUuid(anchor.dataset.uuid) : null;
const chat = {
  link: anchor ? { uuid: anchor.dataset.uuid, text: anchor.textContent } : null,
  resolvesToGranted: !!linked && linked.id === reveal.itemId && linked.parent?.id === actor.id,
  renderedLink: !!document.querySelector(`#chat [data-message-id="${msg.id}"] a.content-link[data-uuid="${reveal.itemUuid}"]`),
};
await app.close();

// ---------- Part 2: two reveals at once, the first closed mid-spin ----------
const fake = n => ({ ...reveal, requestId: `payoff${n}${foundry.utils.randomID(6)}`, purse: { ...actor.system.currency } });
const a = fake("a"), b = fake("b");
const chainA = showReveal(a).then(w => w.landed).then(() => postPullCard(a));
const appA = await until(() => appFor(a.requestId)?.element, 5000, "reveal A") && appFor(a.requestId);
await wait(50);
const chainB = showReveal(b).then(w => w.landed).then(() => postPullCard(b));
const appB = await until(() => appFor(b.requestId)?.element, 5000, "reveal B") && appFor(b.requestId);
await wait(300);
const box_ = w => { const r = w.element.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width) }; };
const origins = { a: box_(appA), b: box_(appB), viewport: { width: innerWidth, height: innerHeight } };
const twoCardsBefore = cards().length;
const aLandedBeforeClose = !!appA.element.querySelector(".lc-card--landed");
await appA.close();
await Promise.race([chainA, wait(3000)]);
const aCardPosted = cards().length === twoCardsBefore + 1;
const bStillSpinning = !appB.element.querySelector(".lc-card--landed");
await appB.close();
await Promise.race([chainB, wait(3000)]);

const ok = !midSpin.landed && midSpin.enabled && midSpin.label === "Skip" && midSpin.stripHidden === "true"
  && /inventory/.test(afterLand.text) && /[gsc]p left/.test(afterLand.text) && afterLand.label === "Close" && afterLand.focusOnClose
  && afterLand.openItemShown && sheetOpened && chat.resolvesToGranted
  && (origins.a.left !== origins.b.left || origins.a.top !== origins.b.top) && !aLandedBeforeClose && aCardPosted && bStillSpinning;
return {
  ok,
  pull: { requestId: reveal.requestId, item: granted?.name, itemUuid: reveal.itemUuid, rarity: reveal.result.rarity, purse: reveal.purse },
  midSpin, afterLand, sheetOpened, chat,
  twoReveals: { origins, aLandedBeforeClose, aCardPosted, bStillSpinning },
};
