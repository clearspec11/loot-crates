# Loot Crates

A Foundry VTT module for dnd5e. The GM builds **pools** of items (dragged in from any compendium, the Items sidebar or another module's imports, or bulk-added by filter), prices **boxes** that draw from those pools at chosen rarity odds, and players buy a box with their character's coins. The pull plays as a crate-opening spin that everyone at the table watches, and the item lands in the character's inventory.

- Players: the **Crates** button at the top of the Items sidebar opens the shop.
- GM: **Game Settings, Loot Crates** opens the manager: pools, boxes, and the pull log with refunds.
- Purchases go over the module socket to the active GM's client, which rolls, deducts, grants and broadcasts the reveal. No GM online means the shop is closed.

## Rarity overrides

A GM can change an item's rarity on its row in the pool editor. That rarity decides the drop odds, and it is the rarity the reveal, the chat card, the pull log and the character sheet all show: the granted copy carries it (one value, written to dnd5e 6's `system.rarities`). The source item in its compendium is never changed. The copy keeps where it came from: `flags["loot-crates"].sourceRarity` (the source's own rarities, empty when it had none) with `rarityOverride: true`, and `_stats.compendiumSource` for a compendium item; the log row reads "Legendary, set by GM (source Uncommon)". An entry left at its source's rarity is granted exactly as the source is, a multi-rarity ("Varies") item included. Price and attunement are not touched.

## Development

```
npm install
npm run lint          # eslint, 0 errors
npm run test:run      # vitest: the odds, the currency maths, the strip
npm run build         # checks module.json, parses every script, packs dist/module.zip
NODE_PATH=$(npm root -g) npm run smoke   # harness screenshots at 1440 and 390 wide
npm run harness       # serve the harness at http://localhost:5281/harness/
```

The harness runs the module's pure scripts with sample data outside Foundry so the shop and the spin can be looked at without a world. `foundry-dev/` has the headless runner for a real check against a dev world.

## Layout

- `module/` is what ships: `module.json`, `scripts/`, `styles/`.
  - Pure, tested, no Foundry globals: `odds.js` (the pull and the shop's odds), `currency.js` (coins), `boxcard.js` (the shop's box card and odds pills, shared with the manager and the harness), `revealcard.js` (the reveal's result block and where its window opens, shared with the harness), `chatcard.js` (what a pull's chat card becomes after a refund, and finding that card), `poolview.js` (the pool editor's rows, search, filter chips and 50-row pages, shared with the harness), `strip.js` (the reveal row), `spin.js` (the animation, DOM only).
  - Foundry-side: `store.js` (settings-backed pools/boxes/log), `pull.js` (one purchase), `socket.js` (player to GM), `shop.js`, `reveal.js`, `manager.js`, `chat.js`, `sound.js`, `main.js`.
- `harness/` is the no-Foundry page used by `npm run smoke`.
- `test/` is Vitest. `scripts/` are the checks. `docs/DESIGN.md` holds the design tokens and rules.
