---
name: Loot Crates
description: A dark, restrained crate-opening UI inside Foundry VTT. One memorable moment (the spin), everything else quiet.
colors:
  bg: "#121417"
  bg-2: "#1a1d22"
  bg-3: "#23272e"
  line: "#30353d"
  ink: "#eef0f3"
  ink-soft: "#b7bdc7"
  ink-mute: "#8b929d"
  accent: "#e8b65a"
  common: "#9aa5b5"
  uncommon: "#4b8ff2"
  rare: "#9b59f0"
  veryRare: "#ef5aa7"
  legendary: "#ef4b4b"
  artifact: "#f2c14e"
typography:
  family: "Signika (Foundry's UI font), falling back to Plus Jakarta Sans, system-ui"
  floor: "11px; card names 12px; the reveal name 20px bold"
radius: "8px windows and cards, 6px controls, 999px odds pills"
motion:
  spin: "5 to 7 s, constant then cubic ease-out, overshoot half a card on a near-miss, settle with ease-in-out"
  landed: "card lifts 6px and scales 1.06 with a rarity glow, 420 ms"
  reduced-motion: "skip straight to the landed state"
---

# Design rules

1. **Rarity is a colour bar, not a word.** Each card's bottom bar and glow read `--lc-rarity`; the label appears only on the landed card and in chat. The ladder is CS:GO-familiar: grey-blue, blue, purple, pink, red, with gold held back for artifacts and GM-flagged jackpots.
2. **One moment per screen.** The spin is the moment. The shop and the manager are plain, legible lists and grids with no decoration competing with it.
3. **The marker is the only accent on the strip.** Gold line with chevrons top and bottom; fillers dim to 55% once the result lands so the eye goes to one card.
4. **Odds are always visible** on a box (pills per rarity) so a purchase is a known bet, not a surprise.
5. **Buttons say what they do and what it costs**: "Open for 150 gp", disabled with a reason in the title when it can't be done.
6. **Foundry's chrome stays Foundry's.** Tokens are scoped under `.loot-crates`; nothing styles global elements.
7. **No emoji, no caps kickers, no sparkle.** Font Awesome icons that Foundry already ships are fine.
