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
try { registerSocket(); } catch { /* registered on an earlier run of the same page */ }

// Seed a pool and a box if the world has none yet, so the windows show something.
if (!Object.keys(store.getPools()).length) {
  const entries = await store.entriesFromCompendium("dnd5e.items", { types: ["weapon", "equipment"], rarities: ["uncommon", "rare"] });
  const pool = await store.savePool({ name: "Live UI pool", entries: entries.slice(0, 40) });
  await store.saveBox({ name: "Live UI crate", price: 75, pools: [{ id: pool.id, share: 1 }], weights: { uncommon: 75, rare: 25 } });
}

const app = WHICH === "shop" ? openShop() : openManager();
await new Promise(r => setTimeout(r, 1500));
const el = app.element;
return {
  rendered: !!el && el.isConnected,
  windowTitle: el?.querySelector(".window-title")?.textContent?.trim(),
  text: el?.querySelector(".window-content")?.innerText?.slice(0, 600),
  pools: Object.values(store.getPools()).map(p => ({ name: p.name, entries: p.entries.length })),
  boxes: Object.values(store.getBoxes()).map(b => ({ name: b.name, price: b.price })),
};
