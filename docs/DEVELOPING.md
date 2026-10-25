# Developing Loot Crates

Start here to work on the module by hand. It covers setup, the four ways to see a change, where the code lives and what to run before a pull request. How the module works is in [ARCHITECTURE.md](ARCHITECTURE.md), the look in [DESIGN.md](DESIGN.md), and releasing in [RELEASE.md](RELEASE.md).

## Setup

You need Node 22 or newer and git. Playwright with Chromium is needed only for the screenshot run and the live checks.

```
git clone https://github.com/clearspec11/loot-crates.git
cd loot-crates
npm install
npm run test:run
```

The module is plain ES modules that Foundry loads as they are. There is no bundler and no build step between editing a file and running it.

## Four ways to see a change

| Loop | Command | Needs | Use it for |
|---|---|---|---|
| Unit tests | `npm run test:run` (or `npm test` to watch) | nothing | Rules, money maths, words, markup |
| Harness | `npm run harness`, then open `http://localhost:5281/harness/` | a browser | Looking at any window without Foundry, with sample data |
| Smoke | `NODE_PATH=$(npm root -g) npm run smoke` | Playwright | Screenshots of every harness state at 1440 and 390 wide, dark and light, in `screenshots/smoke/` |
| Live checks | `npm run live -- <check>` | a dev Foundry world | The real thing: a player and a GM clicking through it |

**The harness** is the fastest way to look at UI. Each state is a URL: `?state=shop`, `?state=landed`, `?state=manager&tab=boxes`, with `&theme=light` for the light theme. The buttons at the top list every state. Set `FOUNDRY_URL` before `npm run harness` and it borrows that world's fonts and textures, so it looks like the real thing.

**The smoke run** takes a few minutes in full. While working on one screen, run only its states:

```
NODE_PATH=$(npm root -g) npm run smoke -- --only=deck,well --width=1440 --theme=dark
```

**Live checks** are set up once with a `.env` file. [foundry-dev/README.md](../foundry-dev/README.md) explains them and lists every check.

## Trying it in your own Foundry

To play with your working copy in a world, link the checkout's `module/` folder into Foundry's data folder as the module:

```
ln -s "$PWD/module" "<Foundry user data>/Data/modules/loot-crates"
```

Reload the world after each edit. Two cautions:

- **Don't press Update on a linked install.** Foundry would write the released zip over your checkout.
- **Don't link it into a world that already has the module installed** from a manifest. Remove that install first, or use a separate world.

The live checks don't need either. They import the branch's scripts from `npm run foundry:serve` into a world whatever version it has installed.

## Where the code lives

```
module/                 what ships: Foundry loads this folder
  module.json           the manifest
  lang/en.json          every word the module shows, by key
  styles/module.css     every style, scoped under .loot-crates
  scripts/
    main.js             the entry point: settings, hooks, the module API
    games/              the game contract (kinds.js) and one file per game
    core/               rules, money, words, days, stock, the countdown
    views/              markup and DOM for cards, tables, editors, windows
    foundry/            everything that talks to Foundry
harness/                the no-Foundry page the smoke run screenshots
test/                   Vitest, one file per behaviour
foundry-dev/            live checks against a real world
tools/                  build, smoke, the live runner, the dev release
docs/                   how it works, the design, compatibility, releasing
```

**The one structural rule:** `games/`, `core/` and `views/` never touch Foundry (`game`, `Hooks`, `ui`, `foundry`, `fromUuid` and the like). That is what lets the tests and the harness run them. Lint enforces it: Foundry's globals are allowed only in `main.js` and `foundry/`. Anything that reads or writes the world, opens a window or listens to a hook goes in `foundry/`, and calls the pure files for the logic and the markup.

[ARCHITECTURE.md](ARCHITECTURE.md) has a line on every file.

## Common changes

**Some text.** Add a key to `module/lang/en.json` and read it with `t("LOOTCRATES.<Area>.<Name>", data)` from `core/i18n.js`. Never write a sentence into a script. `test/i18n.test.js` fails if a key is used but missing, or present but unused.

**A screen or a state of one.** Draw it with a pure function in `views/` (or the game's own file), use it from the window in `foundry/`, and add a harness state (`harness/harness.js`) and a smoke entry (`STATES` in `tools/smoke.mjs`).

**A game.** Write `games/<game>.js`: its defaults, roll, reveal, chat card, shop card and editor, ending in `registerKind({...})`. The contract is the comment at the top of `games/kinds.js`, and `games/well.js` is a small example to copy. The money path, refunds, the log and the reveal's hold are the core's, so a game never charges or grants by itself. Then add its New button and editor in `foundry/manager.js`, its words in `en.json`, tests, harness states and a live check.

## Before a pull request

```
npm run lint && npm run test:run && npm run build
NODE_PATH=$(npm root -g) npm run smoke      # any UI change; look at the PNGs
npm run live -- player-pull                 # anything touching a purchase, plus the checks for what you changed
```

`main` takes changes only through a pull request, and CI runs lint, tests and build on it. Add a line under **Unreleased** in `CHANGELOG.md` for anything a GM or player would notice. [CLAUDE.md](../CLAUDE.md) holds the rules that keep the module working: dice, the seal, only the GM writes, styling and motion.
