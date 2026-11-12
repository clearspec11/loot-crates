---
target: the module (all Loot Crates windows)
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
timestamp: 2026-11-11T00-04-00Z
slug: module-styles-module-css
---
Method: dual-agent (A: design review · B: detector + browser)

## Design Health Score: 27/40 (Acceptable, top of band)

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | "Added to inventory" stays up after a sell-back |
| 2 | Match System / Real World | 3 | box / crate / game; two meanings of "ticket" |
| 3 | User Control and Freedom | 3 | A player has no undo of their own |
| 4 | Consistency and Standards | 2 | Two primary buttons per table window; 8 vs 9 pulls; two date formats |
| 5 | Error Prevention | 2 | One-click sell-back and large buys; roulette rail looks clickable |
| 6 | Recognition Rather Than Recall | 3 | Icon-only row actions; "Buy to keep" unexplained on screen |
| 7 | Flexibility and Efficiency | 2 | No bulk shelf or price actions, no click-to-bet |
| 8 | Aesthetic and Minimalist Design | 3 | Shop card and Boxes tab carry too much at equal weight |
| 9 | Error Recovery | 3 | "Nothing inside" hides the cause |
| 10 | Help and Documentation | 3 | Hints long and always on |

## Design specificity
Grounded in the product: the vault, the odds ribbon in three places, rarity as edges, the bane's slate, coin prices on buttons. Slips: the manager reads as a generic admin table; non-crate shop cards lose the peek; the dice reveal is the least owned stage.
Detector: 21 CLI findings, 19 in harness/foundry-shim.css (not shipped) and 2 img placeholders whose src is set in the next line: all false positives. Browser: real findings are the statusbar's 3px left stripe (module.css:936), 115-character lines on .lc-econ__note, 6px cell padding in the Boxes rules column, and a two-line "Buy to keep" label at 1.1 leading.

## Priority issues
1. [P1] The reveal contradicts itself after a sell-back: "Added to Tam Thornwick's inventory" above "sold ... back for 75 gp" (landed-after-sold). Fix: rewrite the result line when the after-action completes. Command: clarify.
2. [P1] Irreversible money actions fire on one click, unevenly guarded: Sell back has no confirm, Give has two steps; "Draw again" sits beside Close on a bane. Fix: second press for sell-back and for large buys; separate Draw again from Close. Command: harden.
3. [P1] The shop card has two full-width buttons and "Buy to keep" is explained only to screen readers; price lives only in the button; ragged card heights. Fix: demote Keep with a visible hint, align buttons to the card foot, show price as a figure. Command: distill, then layout.
4. [P2] Boxes tab overload: 8 create buttons, 6 controls a row, three icon-only. Fix: one New game menu, row overflow. Command: distill.
5. [P2] Roulette rail looks interactive but is not, and truncates bet names. Fix: a spot click fills the form; wrap labels. Command: harden.

## Persona red flags
GM power user: no bulk actions, delete beside duplicate 8px apart. Keyboard/low vision: dimmed strip names, dull dice gold, scratch ticket clipped with no scroll cue. First-time player: "Buy to keep", "V. rare", "Nothing inside" unexplained; does not know a GM can refund. Half-width laptop: about 300px per card with two buttons, long scroll.

## Minor
8 vs 9 pulls for the same pity; two date formats in one log row; dice result says the number three times; pills wrap 1/1/2/1; dead vault space under the gavel bar and the rail; econ notes need a max-width.

## Questions
Why is the price never a figure on the card? Does Buy to keep belong on the card at all? Should the GM's view be the shelf itself?
