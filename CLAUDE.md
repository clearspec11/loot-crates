# CLAUDE.md

Guidance for Claude Code in this repository.

## What this is

Loot Crates is a Foundry VTT module (v13/v14, dnd5e 5/6) for GM-curated item pools, gold-priced boxes and a crate-opening spin. Plain ES modules loaded by Foundry, no bundler, no framework. See README.md for the layout.

## Rules that keep it working

- **Pure first.** `kinds.js`, `crate.js`, `well.js`, `dicegame.js`, `clock.js`, `odds.js`, `currency.js`, `boxcard.js`, `revealcard.js`, `chatcard.js`, `poolview.js`, `strip.js` and `spin.js` must not touch Foundry globals (`game`, `Hooks`, `ui`, `foundry`, `fromUuid`), so Vitest and the harness can run them. Put anything Foundry-aware in the other scripts (`dicegame.js` reaches Foundry's `Roll` through `globalThis` with a pure fallback, as `pull.js` reaches `CONFIG`; its Dice So Nice bridge is `dicereveal.js`).
- **Dice are Foundry's, rolled on the GM with `allowInteractive: false`,** inside the write queue, decided and logged before any client shows a die; the faces travel as the serialised Roll and every client rebuilds them from it. Never create a ChatMessage carrying a Roll: it renders the total everywhere at once, past the seal.
- **The result is rolled before the strip is built** (the kind's roll, then `strip.js`). The animation never decides the outcome.
- **Every game runs on the core.** A game is a kind (`kinds.js`): it supplies the roll, the reveal's animation and result, the chat card and the shop card, nothing else. The money path (`pull.js`), the request and broadcast (`socket.js`), the log row, the refund (`refund.js`) and the hold (`reveal.js`) are one copy; never duplicate them in a kind. A roll may give no item or pay coins out (`payoutCp`); coins move only through `currency.js` `settle()`. Anything counted "per day" is keyed on the in-game day (`clock.js`, from `game.time`) and counted from unrefunded log rows, never reset by hand (the well's cap).
- **Only a GM client writes.** Players send a `pull` over the socket; `socket.js` on the active GM does the purse check, the roll, the grant and the log, then broadcasts the reveal. Don't add client-side writes to actors, settings or compendia.
- **Pools hold UUID references, not copies.** A missing source resolves to null and must be reported, not silently skipped.
- **Rarity keys are dnd5e's** (`common, uncommon, rare, veryRare, legendary, artifact`), normalised through `normalizeRarity`.
- **Styling:** tokens in `module/styles/module.css`, scoped under `.loot-crates`; one `--lc-rarity` per rarity class and everything reads it. `docs/DESIGN.md` is the source of truth. No emoji in UI text, no caps kickers, body text no smaller than 11px.
- **Motion:** one `requestAnimationFrame` loop and one `translateX`; respect `prefers-reduced-motion` (skip to the reveal).
- **Sounds are synthesised** (`sound.js`); don't add audio files unless they're CC0 and credited.

## Checks

- `npm run lint` (0 errors)
- `npm run test:run`
- `npm run build`
- `NODE_PATH=$(npm root -g) npm run smoke` for any UI change; look at the PNGs.
- For anything touching the purchase path or the data model: the live check in `foundry-dev/README.md`.

## Conventions

- Foundry windows are `ApplicationV2` subclasses with `_renderHTML` returning an element and `_replaceHTML` replacing the content; actions go in `DEFAULT_OPTIONS.actions`. Escape every string that reaches `innerHTML` with `foundry.utils.escapeHTML`.
- Errors a player should see are `PullError`s with a plain sentence; anything else is logged with the `loot-crates |` prefix.
- Add a new state to the harness (`harness/harness.js`) and to `STATES` in `scripts/smoke.mjs` when you add a screen.
