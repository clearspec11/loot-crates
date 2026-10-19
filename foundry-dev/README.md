# Checking against a real Foundry world

`headless/run.cjs` joins a world as its Gamemaster in headless Chromium and runs a script as an async function body in the page, printing its return value as JSON. `headless/serve-module.py` serves this checkout's `module/` folder with CORS so the script can `import(MODULE_BASE + "scripts/x.js")` and test the working copy without installing anything on the Foundry host.

```
python3 foundry-dev/headless/serve-module.py module 8766 &
FOUNDRY_URL=http://192.168.0.57:30000 MODULE_BASE=http://<this machine>:8766/ \
  NODE_PATH=$(npm root -g) node foundry-dev/headless/run.cjs foundry-dev/checks/live-pull.js
```

Needs Playwright with Chromium 146 or newer (Foundry v14 refuses older) and a Gamemaster with no password: a dev world only. `checks/live-pull.js` does one real purchase on a test actor in the "Loot Crates Test" folder and reports the purse and the granted item. `checks/live-reveal.js` plays the reveal window with a strip built from the items compendium, writes nothing, and reports how far the landed card sits from the marker (`--shot` for a screenshot).

Rules for the dev world: test actors only in that folder, never delete anything, never touch other folders' actors.
