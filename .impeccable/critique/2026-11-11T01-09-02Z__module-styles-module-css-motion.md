---
target: animation (all reveals and UI motion)
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 4
timestamp: 2026-11-11T01-09-02Z
slug: module-styles-module-css-motion
---
Method: dual-agent (A: motion design review from recorded frames · B: measured evidence and detector)

## Motion score: 27/40 (motion criteria, not the Nielsen set)

| # | Criterion | Score | Key issue |
|---|---|---|---|
| 1 | Purpose | 3 | Almost nothing decorative |
| 2 | Timing and easing | 2 | Dead ease-out tails on strip and wheel; no anticipation on flip or gavel |
| 3 | Staging and readability | 2 | Small actors on empty stages; coin flight clipped; sweep leaves view |
| 4 | Feedback on actions | 2 | No press state; waiting on the GM is static |
| 5 | Consistency of motion language | 3 | One landing grammar; run-ups differ |
| 6 | Emotional payoff | 2 | Result known 1.3 to 1.9 s early; name has no entrance; legendary is common plus colour |
| 7 | Restraint outside the reveal | 4 | Shop, manager and linger are quiet |
| 8 | Reduced-motion experience | 3 | Complete, but no ceremony at all |
| 9 | Sound-motion sync (as designed, not heard) | 3 | Deck's hold relies on sound alone |
| 10 | Interruptibility | 3 | Skip lands in one frame; no fast mode |

## Measured
Every reveal except scratch: one loop, lands within one frame of its stated time, zero dropped frames, stops at landing. Spin: peak 1434 px/s, speed continuous (largest jump 4.5% of peak), Skip lands in 13 ms. Reduced motion lands every game in 58-79 ms with no frames.
Scratch: foil.js loop() clears `frame`, stepSweep/give call wake() which registers a loop, then line 376 registers another: one extra loop per frame, up to 282 callbacks a frame, 17-24% of frames dropped, 2.2 million canvas strokes in one sweep. Panels open every 317 ms, not the documented 380.
Detector: no motion findings.

## Priority issues
1. [P1] Scratch foil loop multiplies (foil.js:362-377): guard the re-arm. Command: optimize.
2. [P1] Dead tails: the strip's marker is inside the winner from 4317 ms, reveal at 6216 ms; the wheel's last pocket change is 4283 ms, landing 5566 ms. Fix: SPIN_SPLIT 0.86 to about 0.92 with a harder ease-out and a 250 ms settle; give the ball its last pockets during the drop. Command: animate.
3. [P1] Near-miss parks 1083 ms on the better card on 60% of eligible spins (TEASE_RATE 0.6). Fix: cross and return without stopping in 250-350 ms; rate about 0.25-0.3. Command: animate.
4. [P1] Scratch sweep leaves a short window's view for about 1.4 s (showPanel is not called from stepSweep). Command: adapt.
5. [P2] Under-authored peaks: item name and dice total appear with no entrance; legendary shares common's choreography. Command: animate.
6. [P2] Staging: well coin starts outside the clipped vault (visible 220 of 700 ms) and a ring shows before the splash; deck hold is a 900 ms freeze and the flip has no anticipation; gavel snaps to -40 degrees; wheel has no run-up and a small ball. Command: animate.
7. [P3] No :active rule; two 120 ms colour transitions ignore reduced motion (module.css:211, 1026); auction crate lot shifts layout when the strip mounts; DESIGN.md says 380 ms a panel.
