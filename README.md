# Loot Crates

A Foundry VTT module for dnd5e. The GM builds **pools** of items (dragged in from any compendium, the Items sidebar or another module's imports, or bulk-added by filter), prices **boxes** that draw from those pools at chosen rarity odds, and players buy a box with their character's coins. The pull plays as a crate-opening spin that everyone at the table watches, and the item lands in the character's inventory.

- Players: the **Crates** button at the top of the Items sidebar opens the shop.
- GM: **Game Settings, Loot Crates** opens the manager: pools, boxes, and the pull log with refunds.
- Purchases go over the module socket to the active GM's client, which rolls, deducts, grants and broadcasts the reveal. No GM online means the shop is closed.

## Rarity overrides

A GM can change an item's rarity on its row in the pool editor. That rarity decides the drop odds, and it is the rarity the reveal, the chat card, the pull log and the character sheet all show: the granted copy carries it (one value, written to dnd5e 6's `system.rarities`). The source item in its compendium is never changed. The copy keeps where it came from: `flags["loot-crates"].sourceRarity` (the source's own rarities, empty when it had none) with `rarityOverride: true`, and `_stats.compendiumSource` for a compendium item; the log row reads "Legendary, set by GM (source Uncommon)". An entry left at its source's rarity is granted exactly as the source is, a multi-rarity ("Varies") item included. Price and attunement are not touched.

The shop shows each character their own odds. A box's pity rule and its no-duplicates rule apply to the character picked in the shop, the same way the roll applies them: items they already own are left out, and once pity is due only the guaranteed rarities show. The card says where they stand ("Rare or better within 4 pulls", or "guaranteed this pull"), and a box with nothing new for that character can't be bought ("Nothing new for <name>"). The reveal's odds bar shows the odds the shop showed.

A refund from the Pull log undoes the whole pull: the coins come back, the granted item leaves the sheet, the box's stock goes up by one, and the character's pity count and no-duplicates record for that box go back to what they would be without that pull (the confirm dialog says where the count goes and that the item can drop again). Each log row keeps the pity count it was pulled at and whether it reset it (`before.sinceRare`, `resetPity`); a row written by 0.6.0 or earlier has neither, so its refund corrects the no-duplicates record and the pull count and leaves the pity count as it is.

## Watch again

A pull's chat card carries a small display-only snapshot of its spin (`flags["loot-crates"].replay`: each card's name, art and rarity, where it lands, the odds and the result; no uuids, no purse, no granted item, about 6 KB). Anyone at the table can press **Watch again** on the card to replay that spin on their own screen, in a window titled "Replay: ...". A replay writes nothing, posts nothing, needs no GM and shows nobody's gold. Refunded cards and cards posted before this feature have no button.

A reveal that this client didn't see spin (it landed while the tab was hidden, the tab was hidden mid-spin, or Skip was pressed) also offers **Watch again** beside Close. It replays the same strip in the same window, display only, reading Skip while it plays; once a replay has run to its end the button goes. It never appears after a spin that played out, or with reduced motion on.

## Development

```
npm install
npm run lint          # eslint, 0 errors
npm run test:run      # vitest: the odds, the currency maths, the strip
npm run build         # checks module.json, parses every script, packs dist/module.zip
NODE_PATH=$(npm root -g) npm run smoke   # harness screenshots at 1440 and 390 wide, dark and light
npm run harness       # serve the harness at http://localhost:5281/harness/ (?theme=light for the light theme)
```

The harness runs the module's pure scripts and its stylesheet with sample data outside Foundry so the shop, the spin and the pool editor can be looked at without a world. The stylesheet borrows dnd5e's fonts and textures and Foundry's item icons; set `FOUNDRY_URL=http://<foundry>:30000` for `npm run harness` or `npm run smoke` and the harness passes those requests through to that world, so it renders with the real assets (without it, system fonts and plain grounds stand in). `foundry-dev/` has the headless runner for a real check against a dev world.

## Layout

- `module/` is what ships: `module.json`, `scripts/`, `styles/`.
  - Pure, tested, no Foundry globals: `odds.js` (the pull and the shop's odds), `currency.js` (coins), `boxcard.js` (the shop's box card and odds pills, shared with the manager and the harness), `revealcard.js` (the reveal's result block, where its window opens, and the replay snapshot a chat card keeps, shared with the harness), `chatcard.js` (what a pull's chat card becomes after a refund, and finding that card), `poolview.js` (the pool editor's rows, search, filter chips and 50-row pages, shared with the harness), `strip.js` (the reveal row), `spin.js` (the animation, DOM only), `redraw.js` (which open windows redraw when a world setting changes, once per burst of writes).
  - Foundry-side: `store.js` (settings-backed pools/boxes/log), `pull.js` (one purchase), `socket.js` (player to GM), `shop.js`, `reveal.js`, `manager.js`, `chat.js`, `sound.js`, `main.js`.
- `harness/` is the no-Foundry page used by `npm run smoke`.
- `test/` is Vitest. `scripts/` are the checks. `docs/DESIGN.md` holds the design tokens and rules.
