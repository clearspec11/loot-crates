# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
- **Players** at a dnd5e table in Foundry VTT, often on a laptop with Discord over part of the screen, sometimes a tablet. They have in-game gold, open the Crate Shop during a session, buy a crate, and watch the spin with the whole table.
- **The GM**, between sessions and at the table: builds item pools, prices crates, sets odds and rules, opens or closes the shop, and reads the pull log with refunds.

## Product Purpose
A Foundry VTT module for dnd5e. The GM curates pools of items from any compendium, world folder, roll table or other module's imports, and prices crates that draw from them at chosen rarity odds. A player buys a crate with their character's coins, everyone watches a CS:GO-style spin, and the item lands in the character's inventory. Success is a table that cheers at the reveal and a GM who trusts the odds, the coins and the log.

## Positioning
Gambling the party's gold as a shared table moment: the GM controls exactly what can drop and at what odds; the reveal is played for everyone at once; and the shop, the spin, the sheet, the chat card and the log always agree on what was won.

## Operating Context
- Runs inside Foundry VTT v13/v14 with the dnd5e system (5.x/6.x), next to the dnd5e character and item sheets players see every session, and alongside a GM's other modules.
- Surfaces: the player's Crate Shop window, the reveal window (opened on every client), the chat card, and the GM's manager (Pools, Boxes, Pull log) with its dialogs.
- Purchases go over the module socket to the active GM's client; no GM online means the shop is closed.

## Capabilities and Constraints
- Plain ES modules and one stylesheet loaded by Foundry; no bundler or framework.
- Styles are scoped under `.loot-crates`; Foundry's chrome and other modules are never styled.
- Pure modules (odds, currency, strip, spin, box card, reveal card) stay free of Foundry globals so the harness and tests run them.
- The roll is made before the strip is built; the animation never decides the outcome. One requestAnimationFrame loop and one translateX drive the spin; reduced motion skips to the result.
- Sounds are synthesised; no audio files unless CC0 and credited.

## Brand Commitments
- Should feel native beside dnd5e's own sheets, with a bespoke twist of its own (confirmed by the user, 2026-10-20).
- Keep the CS:GO rarity colour ladder (grey-blue, blue, purple, pink, red, gold for artifacts) on cards and odds (confirmed by the user, 2026-10-20).
- No emoji in UI text, no caps kickers.

## Evidence on Hand
- Harness pages with sample data: harness/ (shop, spin, landed, buyer view, manager); smoke screenshots in screenshots/smoke/.
- A live dev world (cc-dev, Foundry v14, dnd5e 6.0.6) with dnd5e.items compendium icons.
- No real player testimonials, usage numbers or store listing exist; do not invent them.

## Product Principles
1. The reveal is the table's moment; everything else serves it quietly.
2. Never misrepresent the bet: odds, colours and teases only show what a crate can actually drop.
3. One truth across shop, spin, sheet, chat and log.
4. The GM is in control and can always undo.

## Accessibility & Inclusion
Keyboard and screen-reader paths for buying, skipping and closing; visible reasons for disabled actions; reduced motion honoured; text no smaller than 11px with 4.5:1 contrast.
