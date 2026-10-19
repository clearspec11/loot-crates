---
version: 1
slug: "module-styles-module-css"
primary_target: "module/styles/module.css"
related_targets: ["module/scripts/shop.js","module/scripts/reveal.js","module/scripts/manager.js","module/scripts/chat.js"]
---

# Loot Crates windows: shop, reveal, manager, chat card

Scope: every Loot Crates surface inside Foundry VTT (Crate Shop, reveal window, chat card, GM manager and its dialogs). Mode: Operate for the shop and manager; the reveal is the one Experience moment inside them.
Audience and job: players buying a crate with their character's coins and watching the pull together; the GM curating pools, pricing crates and reading the log.
Constraints: styles scoped under `.loot-crates`; follow Foundry's light or dark theme the way dnd5e does (`@scope (.theme-x) to (.themed)`); dnd5e is a required system, so its fonts and textures are referenced, never copied; CS:GO rarity ladder kept (user pin); spin behaviour unchanged.
Direction: pinned by the user on 2026-10-20: "dnd5e-like with a bespoke twist".

## Direction contract
THESIS: Loot Crates is a dnd5e sheet that sells treasure. Its windows speak dnd5e's own sheet language, so a player reads it as part of the system, and it owns one bespoke move: the vault, a dark banded strip where the spin runs and the bet is drawn as a ribbon. It refuses the neon gamer-UI card grid it ships today and refuses a parchment costume.
OWN-WORLD: Follows Foundry's theme. Light: dnd5e's grey paper texture over #f1ebe8, cards #f8f4f1 with a 1px gold #9f9275 rule and dnd5e's soft card shadow, maroon card header bands (#741b2b to #44191a) with white Modesto Condensed, ink #191813, labels in bold uppercase Roboto Condensed gold. Dark: dnd5e's denim texture on #0d0b0b, slate cards #252830 with blue-gray rules, ink #e7e3dc, gold #c9b48a. Actions are dnd5e's black button with an inset gold rule. Rarity colours stay the CS:GO ladder, used only as edges, dots and ribbon segments.
STORY: A player sees each crate as a dnd5e card: its name on a maroon band, what it can drop as a ribbon and named odds, its price on the button. They buy; the vault opens on every screen; the strip slows past the gold pin; the item's name lands in Modesto in its rarity colour; one quiet line says where it went.
FIRST VIEWPORT: Shop: a header row with a labelled character picker and the purse in coins; below, a grid of crate cards, each a maroon band with the name, a paper body with a peek of up to three real items it can drop (gold-rimmed portraits underlined in their rarity, best in the middle: the player sees what it can drop, per STORY), the odds ribbon over named odds pills, stock, and a full-width black-and-gold "Open for 150 gp" button with its reason line when disabled. Reveal: a slim line naming buyer, crate and price, then the vault band edge to edge with the odds ribbon along its top edge, the strip and pin, then the result, then Skip/Close.
FORM: dnd5e sheet language plus a bespoke vault band; signature move: the odds ribbon (one segmented, gold-rimmed bar of the crate's real drop chances) shown in the shop, the manager's box table and the reveal's vault. seed: none (no roll ran: the user pinned the world, "5e like with a bespoke twist", 2026-10-20)
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Unresolved
- Whether the chat card should also take the maroon band (chat cards are small; start with the gold rule and rarity edge only).
