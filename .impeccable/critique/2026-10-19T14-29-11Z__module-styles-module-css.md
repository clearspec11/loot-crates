---
target: Loot Crates UI (shop, reveal, manager, chat)
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 3
target_identity: "file:/home/claude/homelab/loot-crates/module/styles/module.css"
target_fingerprint: "sha256:62aecb54c6f6dad5026efeb3ca42607345b6a20f49ed6fd32ce0ff6322c1380d"
target_path: /home/claude/homelab/loot-crates/module/styles/module.css
timestamp: 2026-10-19T14-29-11Z
slug: module-styles-module-css
---
Method: dual-agent (A: design review · B: detector and browser overlay)

# Critique: Loot Crates UI before the fantasy redesign (2026-10-20)

Design specificity: category-interchangeable on the outside, product-specific underneath. The chrome is a generic dark kit (flat #121417, 8px rounded cards, pills, amber buttons). It shares nothing with the dnd5e sheets beside it, and it ignores Foundry's theme (module.css:28 forces a dark ground). The product-specific craft is in behaviour: an honest bet, a pre-rolled spin and an honest near-miss.

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | One shared busy flag turns every Buy into "Opening…" (shop.js) |
| 2 | Match system / real world | 3 | "pity", "share" and "weight" are never explained |
| 3 | User control and freedom | 3 | No undo for deleting a pool or box; a spend has no confirm |
| 4 | Consistency and standards | 1 | The light theme breaks Foundry controls; gold means five things |
| 5 | Error prevention | 3 | A box price of 0 is accepted |
| 6 | Recognition rather than recall | 3 | The Boxes tab edit and delete are unlabelled icon buttons |
| 7 | Flexibility and efficiency | 2 | Weights are edited row by row; no "open another" |
| 8 | Aesthetic and minimalist design | 2 | The manager shows 243 controls; an empty crate says "can't buy" four ways |
| 9 | Error recovery | 3 | Plain recovery sentences |
| 10 | Help and documentation | 2 | Good hints, no definitions |
| Total | | 25/40 | Acceptable |

Priority issues:
- [P0] **The light theme breaks every module window.** It renders blank buttons, invisible tabs and an unreadable picker (before-light-*.png).
- [P1] **The UI is not native beside dnd5e.** It has no texture, no dnd5e type, no frames and no theme awareness.
- [P1] **The reveal peak is obscured and flat.** The marker runs through the winner's name, the name is set at 20px, and every rarity lands the same way.
- [P1] **Gold is overloaded.** It serves as price, button, marker, active tab and problem, and it collides with the artifact colour.
- [P2] **The crate colour shows the best rarity, not the likely one.** The box editor also has no live odds.

Detector evidence:
- **border-accent-on-rounded** on the crate cards.
- **bounce-easing** on the landing card.
- **dark-glow** on the marker and the landed card.
- **11px tiny-text.**
- **Low contrast** on the placeholder text and the browser-default active tab.
- **False positives:** nested-cards on the crate cards and pools is a harness artifact; ai-color-palette is the declared rare colour; overused-font is the harness body font.

Persona red flags:
- **Laptop or tablet player:** touch targets are under 44px, and only 3 cards are visible at 390.
- **Keyboard user:** the icon buttons are unlabelled, and the rare select text measures 3.6:1.
- **GM:** has no live odds preview.
