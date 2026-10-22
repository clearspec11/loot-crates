// Boot the branch's module inside the live world without installing it, then
// open the manager (GM) or the shop and take a screenshot with --shot.
// Hooks have already fired by the time this runs, so the registrations
// main.js does at init/ready are called here by hand.
//
//   FOUNDRY_URL=... MODULE_BASE=http://192.168.0.190:8766/ NODE_PATH=$(npm root -g) \
//     node foundry-dev/headless/run.cjs foundry-dev/checks/live-ui.js --shot /tmp/manager.png
//
// Edit WHICH below to "shop" to open the player's shop instead.
const WHICH = "manager";
// The module is not installed in the world, so its stylesheet is not loaded: add it.
if (!document.querySelector("link[data-loot-crates]")) {
  const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: MODULE_BASE + "styles/module.css" });
  link.dataset.lootCrates = "1";
  document.head.appendChild(link);
}
const store = await import(MODULE_BASE + "scripts/store.js");
const { registerSocket } = await import(MODULE_BASE + "scripts/socket.js");
const { openManager } = await import(MODULE_BASE + "scripts/manager.js");
const { openShop } = await import(MODULE_BASE + "scripts/shop.js");

try { store.registerSettings(); } catch (e) { if (!/already registered/i.test(String(e))) throw e; }
store.registerIndexFields();
try { registerSocket(); } catch { /* registered on an earlier run of the same page */ }

// Seed "Live UI pool" and "Live UI crate" by name whenever either is
// missing, through the write queue: the other live checks find them by
// these names, and a world trimmed of them still holds other pools (seeding
// only an empty world left every dependent check failing "no Live UI
// pool"). A crate left pointing at a pool that is gone is pointed back at
// the Live UI pool. Records already there are not touched.
const seeded = [];
let pool = Object.values(store.getPools()).find(p => p.name === "Live UI pool");
if (!pool) {
  const entries = await store.entriesFromCompendium("dnd5e.items", { types: ["weapon", "equipment"], rarities: ["uncommon", "rare"] });
  pool = await store.createPool({ name: "Live UI pool", entries: entries.slice(0, 40) });
  seeded.push("Live UI pool");
}
const crate = Object.values(store.getBoxes()).find(b => b.name === "Live UI crate");
if (!crate) {
  await store.createBox({ name: "Live UI crate", price: 75, pools: [{ id: pool.id, share: 1 }], weights: { uncommon: 75, rare: 25 } });
  seeded.push("Live UI crate");
} else if (!(crate.pools ?? []).some(r => store.getPools()[r.id])) {
  await store.updateBox(crate.id, b => ({ ...b, pools: [{ id: pool.id, share: 1 }] }));
  seeded.push("Live UI crate's pool");
}

const app = WHICH === "shop" ? openShop() : openManager();
await new Promise(r => setTimeout(r, 1500));
const el = app.element;
return {
  seeded,
  rendered: !!el && el.isConnected,
  windowTitle: el?.querySelector(".window-title")?.textContent?.trim(),
  text: el?.querySelector(".window-content")?.innerText?.slice(0, 600),
  pools: Object.values(store.getPools()).map(p => ({ name: p.name, entries: p.entries.length })),
  boxes: Object.values(store.getBoxes()).map(b => ({ name: b.name, price: b.price })),
};
