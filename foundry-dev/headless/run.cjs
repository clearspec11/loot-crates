// Run a JS file inside a Foundry world as its Gamemaster, headless, so a
// change can be checked against real dnd5e from a machine with no browser.
//
//   FOUNDRY_URL=http://<host>:30000 node foundry-dev/headless/run.cjs check.js [--shot out.png]
//   FOUNDRY_URL=http://<host>:30000 node foundry-dev/headless/run.cjs live-tabs
//
// The check is a path, or a bare name looked up in foundry-dev/checks/
// (live-tabs and live-tabs.js both find foundry-dev/checks/live-tabs.js).
//
// The script is the body of an async function run in the page; its return
// value is printed as JSON. MODULE_BASE is in scope: point it at this
// checkout's foundry-module/ served by serve-module.py, and
// `await import(MODULE_BASE + "scripts/importer.js")` tests the working copy
// without updating the module the server has installed.
//
// Needs Playwright with Chromium 146 or newer (Foundry v14 refuses older), and
// a Gamemaster with no password: use a dev world only.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const CHECKS = path.join(__dirname, "..", "checks");
function resolveCheck(arg) {
  if (!arg) throw new Error(`Name a check: a file path, or a check in ${CHECKS} (e.g. live-tabs).`);
  if (fs.existsSync(arg) && fs.statSync(arg).isFile()) return arg;
  const named = path.join(CHECKS, arg.endsWith(".js") ? arg : `${arg}.js`);
  if (!arg.includes("/") && fs.existsSync(named)) return named;
  throw new Error(`No check "${arg}": not a file, and not in ${CHECKS}.`);
}
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const MODULE_BASE = process.env.MODULE_BASE || "http://localhost:8765/";
(async () => {
  const [file, ...rest] = process.argv.slice(2);
  const shot = rest.includes("--shot") ? rest[rest.indexOf("--shot") + 1] : null;
  let body;
  try { body = fs.readFileSync(resolveCheck(file), "utf8"); }
  catch (e) { console.error(e.message); process.exit(2); }
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errors = []; p.on("pageerror", e => errors.push(e.message));
  await p.goto(FOUNDRY + "/join", { waitUntil: "networkidle" });
  if (p.url().includes("/join")) {
    await p.selectOption("select[name=userId]", { label: process.env.FOUNDRY_USER || "Gamemaster" });
    await p.click("button[name=join], button[type=submit]");
    await p.waitForURL(/\/game/, { timeout: 30000 });
  }
  await p.waitForFunction(() => window.game?.ready, null, { timeout: 120000 });
  // What main.js does first: the branch's words, from its own lang/en.json
  // (the installed release may have no language file, or older words).
  await p.evaluate(async base => (await import(base + "scripts/core/i18n.js")).loadStrings(), MODULE_BASE);
  const out = await p.evaluate(async ({ body, MODULE_BASE }) => {
    try { return { ok: true, value: await (new Function("MODULE_BASE", `return (async () => {\n${body}\n})()`))(MODULE_BASE) }; }
    catch (e) { return { ok: false, error: String(e?.stack || e) }; }
  }, { body, MODULE_BASE });
  if (shot) await p.screenshot({ path: shot });
  console.log(JSON.stringify({ ...out, pageErrors: errors }, null, 1));
  await b.close();
  process.exit(out.ok ? 0 : 1);
})();
