// Live check: open the player's Crate Shop for the test actor with the
// branch's scripts and read what a buyer sees: every odds pill names its
// rarity and none reads "0%", each box's colour is the best rarity it can
// actually drop, and every disabled Buy points (aria-describedby) at a reason
// shown as visible text. --shot for a screenshot.
//
//   FOUNDRY_URL=http://192.168.0.57:30000 MODULE_BASE=http://192.168.0.190:8766/ \
//     NODE_PATH=$(npm root -g) node foundry-dev/headless/run.cjs foundry-dev/checks/live-shop.js --shot /tmp/shop.png
//
// Writes nothing: no purchase, no actor, no settings beyond registering the
// module's own. Needs "Crate Tester" in the Actor folder "Loot Crates Test"
// (live-pull.js makes it).
if (!document.querySelector("link[data-loot-crates]")) {
  const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: MODULE_BASE + "styles/module.css" });
  link.dataset.lootCrates = "1";
  document.head.appendChild(link);
}
const store = await import(MODULE_BASE + "scripts/store.js");
const { registerSocket } = await import(MODULE_BASE + "scripts/socket.js");
const { openShop } = await import(MODULE_BASE + "scripts/shop.js");
const { shopOdds } = await import(MODULE_BASE + "scripts/odds.js");
try { store.registerSettings(); } catch (e) { if (!/already registered/i.test(String(e))) throw e; }
try { registerSocket(); } catch { /* registered on an earlier run of the same page */ }

const folder = game.folders.find(f => f.type === "Actor" && f.name === "Loot Crates Test");
const actor = game.actors.find(a => a.name === "Crate Tester" && a.folder?.id === folder?.id);
if (!actor) throw new Error("no Crate Tester in Loot Crates Test: run live-pull.js first");

const app = openShop();
app.actorId = actor.id;
await app.render({ force: true });
await new Promise(r => setTimeout(r, 1000));
const el = app.element;

const pools = store.getPools();
const boxes = [...el.querySelectorAll(".lc-box")].map(card => {
  const btn = card.querySelector(".lc-box__buy");
  const box = store.getBoxes()[btn.dataset.box];
  const why = btn.getAttribute("aria-describedby") ? el.querySelector(`#${CSS.escape(btn.getAttribute("aria-describedby"))}`) : null;
  const top = shopOdds(box, pools).top;
  return {
    name: card.querySelector(".lc-box__name").textContent,
    pills: [...card.querySelectorAll(".lc-odd")].map(p => p.textContent),
    colour: [...card.classList].find(c => c.startsWith("lc-rarity-") || c === "lc-box--empty"),
    expectedColour: top ? `lc-rarity-${top}` : "lc-box--empty",
    disabled: btn.disabled,
    title: btn.getAttribute("title"),
    reason: why ? { text: why.textContent, visible: why.getBoundingClientRect().height > 0 && getComputedStyle(why).visibility !== "hidden" } : null,
  };
});
const pills = boxes.flatMap(b => b.pills);
const problems = [
  ...pills.filter(t => /(^|[^\d<>])0%/.test(t)).map(t => `pill shows 0%: ${t}`),
  ...pills.filter(t => !/^[A-Z][a-z. ]+ (<1|>99|\d{1,3})%$/.test(t)).map(t => `pill without a name: ${t}`),
  ...boxes.filter(b => b.colour !== b.expectedColour).map(b => `${b.name} coloured ${b.colour}, best drop ${b.expectedColour}`),
  ...boxes.filter(b => b.disabled && !(b.reason?.text && b.reason.visible)).map(b => `${b.name}: disabled Buy with no visible reason`),
  ...boxes.filter(b => b.title).map(b => `${b.name}: Buy still has a title`),
];
const blockers = boxes.filter(b => b.disabled && /Nothing inside|Needs .* more/.test(b.reason?.text ?? ""));
if (!blockers.length) problems.push("no empty or unaffordable box to check a reason on");
return {
  ok: !problems.length,
  problems,
  actor: actor.name,
  purse: actor.system.currency,
  boxes,
};
