# CLAUDE.md

Guidance for Claude Code in this repository.

## What this is

Loot Crates is a Foundry VTT module (v13/v14, dnd5e 5/6) for GM-curated item pools, gold-priced boxes and a crate-opening spin. Plain ES modules loaded by Foundry, no bundler, no framework. See docs/ARCHITECTURE.md for how it works and the layout (README.md is the guide for GMs and players).

## Rules that keep it working

- **Pure first.** `i18n.js`, `kinds.js`, `crate.js`, `well.js`, `dicegame.js`, `deck.js`, `roulette.js`, `auction.js`, `round.js`, `tableview.js`, `clock.js`, `limits.js`, `shelf.js`, `newgame.js`, `starter.js`, `welcome.js`, `changelog.js`, `editorfields.js`, `boxestable.js`, `route.js`, `logtable.js`, `odds.js`, `currency.js`, `boxcard.js`, `revealcard.js`, `chatcard.js`, `poolview.js`, `strip.js` and `spin.js` must not touch Foundry globals (`game`, `Hooks`, `ui`, `foundry`, `fromUuid`), so Vitest and the harness can run them. Put anything Foundry-aware in the other scripts (`dicegame.js` reaches Foundry's `Roll` through `globalThis` with a pure fallback, as `pull.js` reaches `CONFIG`; its Dice So Nice bridge is `dicereveal.js`).
- **Dice are Foundry's, rolled on the GM with `allowInteractive: false`,** inside the write queue, decided and logged before any client shows a die; the faces travel as the serialised Roll and every client rebuilds them from it. Never create a ChatMessage carrying a Roll: it renders the total everywhere at once, past the seal.
- **The result is rolled before the strip is built** (the kind's roll, then `strip.js`). The animation never decides the outcome.
- **Every game runs on the core.** A game is a kind (`kinds.js`): it supplies the roll, the reveal's animation and result, the chat card and the shop card, nothing else. The money path (`pull.js`), the request and broadcast (`socket.js`), the log row, the refund (`refund.js`) and the hold (`reveal.js`) are one copy; never duplicate them in a kind. A roll may give no item, pay coins out or take coins (`payoutCp`, negative for a loss: the deck's bane); a kind may price a play (`priceOf`: the deck's rising draw price) and the core charges, checks and logs that price; coins move only through `currency.js` `settle()`. Anything counted "per day" is keyed on the in-game day (`clock.js`: with dnd5e's calendar on, the later of the clock's day and the character's own day after their last long rest; with it off, from each character's long rests, as dnd5e recovers daily uses; a rest taken with no GM online is kept in the player's browser and sent once a GM joins) and counted from unrefunded log rows, never reset by hand (the well's cap).
- **Only a GM client writes.** Players send a `pull` over the socket; `socket.js` on the active GM does the purse check, the roll, the grant and the log, then broadcasts the reveal. Don't add client-side writes to actors, settings or compendia.
- **Pools hold UUID references, not copies.** A missing source resolves to null and must be reported, not silently skipped.
- **Rarity keys are dnd5e's** (`common, uncommon, rare, veryRare, legendary, artifact`), normalised through `normalizeRarity`.
- **Styling:** tokens in `module/styles/module.css`, scoped under `.loot-crates`; one `--lc-rarity` per rarity class and everything reads it. The bane token (`--lc-bane`), the dimmed vault and `playBane()` mean a loss of coins and nothing else. `docs/DESIGN.md` is the source of truth. No emoji in UI text, no caps kickers, body text no smaller than 11px.
- **Motion:** one `requestAnimationFrame` loop and one `translateX`; respect `prefers-reduced-motion` (skip to the reveal). The wheel (`roulette.js`) keeps the one loop: one rotation transform for the disc and one for the ball, never a second loop. The auction's board (`auction.js`) runs one loop at a time: the gavel's bar drains on one scaleX until the hammer stops it, then the gavel's one swing, then a sealed crate's strip (`spin.js`), one after another, never two at once.
- **A table game** (`table: true`) is staked, never pulled: its round, escrow, resolve and hold are the core's (`round.js`, `table.js`, `reveal.js` showRound); the shared table window (`tablewindow.js`, words in `tableview.js`) is one copy for every table kind, which plugs its pieces in through `tableView` (`kinds.js`).
- **Sounds are synthesised** (`sound.js`); don't add audio files unless they're CC0 and credited.

## Checks

- `npm run lint` (0 errors)
- `npm run test:run`
- `npm run build`
- `NODE_PATH=$(npm root -g) npm run smoke` for any UI change; look at the PNGs. While iterating, run only what you touched: `npm run smoke -- --only=deck,well --width=1440 --theme=dark` (a state name or prefix); the full run is the gate before a commit.
- For anything touching the purchase path or the data model: the live check in `foundry-dev/README.md`.

## Conventions

- Foundry windows are `ApplicationV2` subclasses with `_renderHTML` returning an element and `_replaceHTML` replacing the content; actions go in `DEFAULT_OPTIONS.actions`. Escape every string that reaches `innerHTML` with `foundry.utils.escapeHTML`.
- Errors a player should see are `PullError`s with a plain sentence; anything else is logged with the `loot-crates |` prefix.
- **Words live in `module/lang/en.json`**, read with `i18n.js` `t("LOOTCRATES.<Area>.<Name>", data)`: never a literal sentence in a script. A sentence with a number or a name is one key with `{placeholders}`, not pieces joined in code; write keys out whole (no key built in a template literal), so `test/i18n.test.js` can match every key to the file. Nothing reads a word at import: use `words()` for a table of labels, an `export let` with `onStrings()` for a text constant, a getter for a window title. Console messages (`loot-crates |`), data keys, CSS classes, dnd5e's rarity keys and item names stay as they are.
- Add a new state to the harness (`harness/harness.js`) and to `STATES` in `scripts/smoke.mjs` when you add a screen.
