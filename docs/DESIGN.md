---
name: Loot Crates
description: A dnd5e sheet that sells treasure. dnd5e's own sheet language in light or dark, plus one bespoke move, the vault.
colors:
  paper-ground: "#f1ebe8"
  paper-card: "#f8f4f1"
  paper-field: "#fffdfb"
  paper-row-alt: "#efe9e3"
  gold-rule: "#9f9275"
  paper-rule-soft: "#c9c7b8"
  sheet-ink: "#191813"
  sheet-ink-soft: "#3d3c36"
  sheet-ink-mute: "#5d5b52"
  gold-ink: "#6b5a35"
  band-maroon: "#741b2b"
  band-oxblood: "#44191a"
  band-ink: "#fbf6ef"
  button-black: "#191813"
  pin-gold: "#e3ce9e"
  warn-amber: "#8a4b00"
  warn-wash: "#f6e7cf"
  ok-green: "#2f6b2a"
  denim-ground: "#0d0b0b"
  slate-card: "#252830"
  slate-field: "#1b1d24"
  slate-row-alt: "#2c2f38"
  gold-rule-dark: "#8a7d5f"
  slate-rule-soft: "#434857"
  bone-ink: "#ece8e1"
  bone-ink-soft: "#cfcabe"
  bone-ink-mute: "#a7a397"
  gold-ink-dark: "#d9c495"
  band-maroon-dark: "#6a1826"
  band-oxblood-dark: "#2c1013"
  button-black-dark: "#0d0b0b"
  warn-amber-dark: "#e9b867"
  warn-wash-dark: "#3a2c17"
  ok-green-dark: "#8fd48a"
  vault: "#140d0f"
  vault-glow: "#1d1417"
  vault-card: "#231b1e"
  vault-line: "#3c2f33"
  vault-ink: "#efe9df"
  vault-soft: "#cfc6b8"
  gold-rim: "#a8955f"
  bane-slate: "#5b8a9a"
  rarity-common: "#9aa5b5"
  rarity-uncommon: "#4b8ff2"
  rarity-rare: "#9b59f0"
  rarity-very-rare: "#ef5aa7"
  rarity-legendary: "#ef4b4b"
  rarity-artifact: "#f2c14e"
typography:
  display:
    fontFamily: "Modesto Condensed, Palatino Linotype, serif"
    fontSize: "34px"
    fontWeight: 700
    lineHeight: 1
  headline:
    fontFamily: "Modesto Condensed, Palatino Linotype, serif"
    fontSize: "21px"
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: "0.01em"
  title:
    fontFamily: "Roboto Slab, Signika, serif"
    fontSize: "15px"
    fontWeight: 700
  body:
    fontFamily: "Roboto, Signika, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
  label:
    fontFamily: "Roboto Condensed, Roboto, Signika, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    letterSpacing: "0.03em"
  data:
    fontFamily: "Roboto Condensed, Roboto, Signika, sans-serif"
    fontSize: "12px"
    fontWeight: 700
rounded:
  hair: "1px"
  ribbon: "2px"
  pill: "3px"
  card: "4px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "14px"
  vault-pad: "1rem"
components:
  button-primary:
    backgroundColor: "{colors.button-black}"
    textColor: "{colors.pin-gold}"
    rounded: "{rounded.card}"
    padding: "0 16px"
    height: "36px"
  button-primary-disabled:
    backgroundColor: "{colors.paper-row-alt}"
    textColor: "{colors.sheet-ink-mute}"
  button-quiet:
    backgroundColor: "{colors.paper-field}"
    textColor: "{colors.sheet-ink}"
    rounded: "{rounded.card}"
    padding: "0 12px"
    height: "30px"
  input:
    backgroundColor: "{colors.paper-field}"
    textColor: "{colors.sheet-ink}"
    rounded: "{rounded.card}"
    padding: "0 8px"
    height: "30px"
  odds-pill:
    backgroundColor: "{colors.paper-field}"
    textColor: "{colors.sheet-ink}"
    typography: "{typography.data}"
    rounded: "{rounded.pill}"
    padding: "0 7px 0 6px"
    height: "18px"
  filter-chip:
    backgroundColor: "{colors.paper-field}"
    textColor: "{colors.sheet-ink}"
    typography: "{typography.data}"
    rounded: "{rounded.pill}"
    padding: "0 8px 0 7px"
    height: "26px"
  filter-chip-pressed:
    backgroundColor: "{colors.button-black}"
    textColor: "{colors.pin-gold}"
  crate-card:
    backgroundColor: "{colors.paper-card}"
    textColor: "{colors.sheet-ink}"
    rounded: "{rounded.card}"
    padding: "12px"
  crate-band:
    backgroundColor: "{colors.band-maroon}"
    textColor: "{colors.band-ink}"
    typography: "{typography.headline}"
    padding: "8px 10px 6px"
  strip-card:
    backgroundColor: "{colors.vault-card}"
    textColor: "{colors.vault-soft}"
    rounded: "{rounded.card}"
    width: "120px"
    height: "140px"
  tab:
    textColor: "{colors.sheet-ink-mute}"
    padding: "0 12px"
    height: "34px"
  tab-active:
    textColor: "{colors.sheet-ink}"
---

# Design System: Loot Crates

## Overview

**Creative North Star: "The Sheet That Sells Treasure"**

Loot Crates speaks dnd5e's own sheet language so a player reads every window as part of the system: dnd5e's grey paper or denim ground, cards inside a 1px gold rule with a soft shadow, maroon header bands lettered in Modesto Condensed, bold upper-case condensed field labels in gold ink, and dnd5e's black button with an inset gold rule. The windows follow Foundry's light or dark theme exactly as dnd5e's sheets do, per window, by scoping theme tokens with `@scope (.theme-light) to (.themed)` and `@scope (.theme-dark) to (.themed)`; light is the base, dark overrides.

It owns one bespoke move: **the vault**, a dark, gold-ruled band that runs edge to edge across the reveal window and holds the odds ribbon, the strip, the pin and the result. The vault stays dark in both themes; it is the stage, not a panel, so the CS:GO rarity colours read the same for everyone at the table. Its signature companion is **the odds ribbon**: one segmented, gold-rimmed bar of a crate's real drop chances, shown on the shop's crate cards, in the manager's box table and along the vault's top edge.

dnd5e is a required system, so its textures and fonts are referenced by relative path from the module's stylesheet (`../../../systems/dnd5e/ui/texture-gray1.webp`, `texture-gray2.webp`, Foundry's `../../../ui/denim075.png`), never copied into the module. Every rule is scoped under `.loot-crates`; Foundry's chrome and other modules are never styled. The world refuses the neon gamer-UI card grid and refuses a parchment costume: it is dnd5e's actual sheet, not an imitation of old paper.

**Key Characteristics:**
- dnd5e sheet language in both Foundry themes, switched per window with `@scope ... to (.themed)`.
- dnd5e textures and fonts referenced by path, never copied.
- One bespoke surface, the always-dark vault, where the spin runs and the result lands.
- The odds ribbon as the signature device across shop, manager and reveal.
- The CS:GO rarity ladder as a user pin, used on paper only as edges, diamonds and ribbon segments.
- Quiet operating windows (shop, manager, chat card); the reveal is the one moment.

## Colors

dnd5e's two sheet palettes (grey paper with maroon and gold; denim and slate with gold) plus a fixed dark vault and the six-step CS:GO rarity ladder.

### Primary
- **Sheet Maroon to Oxblood** (`band-maroon` to `band-oxblood`, light; `band-maroon-dark` to `band-oxblood-dark`, dark): a left-to-right gradient on crate-card header bands and the manager's table header row; at 10% it tints a pool card's summary row. Maroon is also the light theme's focus ring.
- **Pin Gold** (`pin-gold`): the lettering on every primary button, the pin and its diamond heads in the vault, the vault's top and bottom inset hairlines, the gold-left figure in the result line, and the dark theme's focus ring.

### Secondary
- **Gold Rule** (`gold-rule`, light; `gold-rule-dark`, dark): the 1px rule around windows, cards, tables and fieldsets, the inset rule inside the black button, the active tab's underline and the faded shop divider.
- **Gold Ink** (`gold-ink`, light; `gold-ink-dark`, dark): field labels, legends, the price beside a crate or chat-card name, and the pool disclosure chevron.
- **Gold Rim** (`gold-rim`): the ribbon's frame and the peek portraits' frame, gold in both themes.

### Tertiary: the rarity ladder (user pin)
- **Common** (`rarity-common`), **Uncommon** (`rarity-uncommon`), **Rare** (`rarity-rare`), **Very Rare** (`rarity-very-rare`), **Legendary** (`rarity-legendary`), **Artifact** (`rarity-artifact`). One rule per rarity class sets `--lc-rarity` and `--lc-rank` (0 to 5); everything reads them.
- Two swatches that aren't a rarity, for the Wishing Well's outcomes, read through the same variable: **None** (`lc-rarity-none`, mute ink: a throw that gave nothing) and **Coin** (`lc-rarity-coin`, the gold rim: the coin back). They colour pills, ribbon segments and log dots only. **None** also marks a crate's pull that found nothing (a roll table's text results counted as nothing): its strip card is an empty slot with a dashed frame, its odds pill and chance line read "Nothing".
- A crate on a roll table's odds (`rules.oddsMode: "weight"`) names its items in place of the rarity pills: one line each (`lc-chance`), the rarity as the pills' diamond, the name at left, the chance in tabular label figures at right, best find first, then "and N more" and "Nothing" in mute ink. The ribbon above stays the rarities.
- **Bane** (`bane-slate`, `lc-rarity-bane`): the one colour that means "you lost something", the deck's loss card. Cold slate, the same in both themes; not gold (treasure), not amber (a problem), not a rarity. On paper it is an edge, a diamond or a segment like the rest; in the vault it names the card.

### Neutral
- **Paper Ground** (`paper-ground`) under dnd5e's two grey textures; **Denim Ground** (`denim-ground`) under Foundry's denim.
- **Paper Card / Slate Card** (`paper-card` / `slate-card`): cards, pools, tables, chat cards, fieldsets.
- **Paper Field / Slate Field** (`paper-field` / `slate-field`): inputs, selects, quiet buttons, pills, chips.
- **Row Alt** (`paper-row-alt` / `slate-row-alt`): zebra table rows and the disabled buy button.
- **Soft Rule** (`paper-rule-soft` / `slate-rule-soft`): control borders, row dividers, the blue-gray rule of the dark theme.
- **Sheet Ink / Bone Ink** with soft and mute steps: text in each theme.
- **Vault** (`vault`, `vault-glow`, `vault-card`, `vault-line`, `vault-ink`, `vault-soft`): the stage, identical in both themes.
- **Warn and OK** (`warn-amber`, `warn-wash`, `ok-green` and their `-dark` pairs): problem chips and rows, the shop header's notice when nothing can be bought (closed, no GM, no character: said once there, never under each crate), the shop-open dot.

### Named Rules
**The Edges-On-Paper Rule.** On paper and slate, rarity colour appears only as an edge, a diamond or a ribbon segment: the peek and chat portraits' 3px underline, the 6 to 7px rotated-square diamond on pills, chips, rows and the log, and the ribbon's segments. Rarity text on paper is ink, never the rarity colour.

**The Vault Speaks In Colour Rule.** Rarity-coloured text lives only inside the always-dark vault: the result name in its rarity, the strip card's foot bar, the landed card's ring and tint, the well's glow and the vault's wash.

**The Quiet Result Rule.** A game's result that isn't a prize (the well's "The coin sinks. Nothing." and "The coin comes back.", the dice's "15 beats the dragon's 12", the deck's card name) is a sentence, so it is set in the slab face (Roboto Slab 700, 18px, 1.25) in vault-soft, never a rarity colour (a bane's is the one exception, in the bane token), and goes to the window's live region like every result. Modesto Condensed is an upper-case face: it names the find, and never sets a sentence (the Labels Not Kickers rule).

**The Warn Is Not Gold Rule.** Problems (missing, renamed, no rarity) are amber on a warm wash with a dashed border, never gold, so they never read as treasure.

**The Bane Is Cold Rule.** A loss has one voice: the bane token, a dimmed vault and the one falling sound (`playBane`, two notes, the second lower and longer). Nothing else may use them, so a table that hears the notes or sees the slate knows coins left the purse. A loss is never amber (it is not a problem) and never gold.

## Typography

**Display Font:** Modesto Condensed (with Palatino Linotype, serif), shipped by Foundry
**Title Font:** Roboto Slab (with Signika, serif), registered by dnd5e
**Body Font:** Roboto (with Signika, system-ui)
**Label Font:** Roboto Condensed (with Roboto, Signika)

**Character:** dnd5e's own faces in dnd5e's own roles: Modesto for names that matter, slab for names of people, crates and pools, condensed bold for labels and figures, Roboto for running text.

### Hierarchy
- **Display** (Modesto 700, 34px, 1; 28px under 520px): the landed item's name in the vault, in its rarity colour.
- **Headline** (Modesto 700, 21px, 1.05, balanced): a crate's name on its maroon band, in band ink.
- **Title** (Roboto Slab 700, 14 to 17px): the shop's character and purse (15px, tabular figures), pool names (17px), the reveal and chat-card crate and item names (14px).
- **Body** (Roboto 400, 13px window text; 12px secondary lines such as hints, reasons, stock and status).
- **Label** (Roboto Condensed 700, 11px, 0.03em, upper case, gold ink): dnd5e field labels (Character, Purse), form legends at 12px. Tabs (13px, 0.04em), table headers (12px) and the rarity name under a result or in a chat card (12px, 0.04 to 0.08em) use the same upper-case condensed voice.
- **Data** (Roboto Condensed 700, 12px): odds pills, filter chips, stock, prices.

### Named Rules
**The Labels Not Kickers Rule.** Upper case belongs to dnd5e's own conventions: field labels above a control, tab labels, table headers, and the rarity name beneath the item it names. Never a caps line above a heading.

**The 11px Floor Rule.** No text below 11px; the field label is the floor, everything secondary is 12px.

## Layout

Windows are Foundry ApplicationV2 windows; content sits on the theme ground at 13px. The shop is a header row (labelled character picker left, purse right, a gold divider that fades at both ends) over an auto-fill grid of crate cards (`minmax(min(100%, 190px), 1fr)`, 14px gaps). The reveal is a slim buyer/crate/price line, then the vault breaking out of the window padding edge to edge (negative inline margin by the window pad, 1rem fallback), then right-aligned actions. The manager is underlined tabs over a scrolling pane of pool cards whose entries flow into an auto-fill grid of 460px minimum columns, and a box table.

Spacing runs on small steps: 4px pills and chips, 8px control gaps, 12px card padding, 14px grid gaps. Controls are 30px tall, primary actions 36px. Under 520px the purse moves under the picker left-aligned, the strip's edge fade widens (22% to 78%), the result name drops to 28px and entry rows wrap with the rarity select indented under the name.

## Elevation & Depth

Depth is dnd5e's: one soft, unoffset card shadow on paper, and inset light and shade inside the vault. Nothing glows.

### Shadow Vocabulary
- **Card** (`box-shadow: 0 0 6px rgba(0,0,0,.45)`): crate cards, pools, tables, chat cards, primary buttons.
- **Peek portrait** (`box-shadow: 0 2px 4px rgba(0,0,0,.35)`): the fanned item portraits on a crate card.
- **Vault frame** (`box-shadow: inset 0 3px 0 -2px pin-gold, inset 0 -3px 0 -2px pin-gold, inset 0 10px 18px -12px #000, inset 0 -10px 18px -12px #000`): gold hairlines inside the vault's gold border, with shade falling in from both edges.
- **Landed lift** (`box-shadow: inset 0 0 0 1px var(--lc-rarity), 0 8px 16px rgba(0,0,0,.6)`): the winning strip card only.

### Named Rules
**The Neutral Lift Rule.** The landing is a neutral lift (translateY -5px, scale 1.06, 460ms `cubic-bezier(.16,1,.3,1)`) with an inset rarity ring, a 10% rarity tint and a gold-framed portrait; the rest of the strip steps back to 45% opacity. No coloured glow.

**The Wash Carries The Escalation Rule.** Once landed, the vault takes a radial wash of the rarity colour (55% mix fading out by 70%) at opacity 0.12 + rank x 0.12, from barely tinted for a common to flooded for an artifact, fading in over 600ms after a 120ms delay.

## Shapes

Small, square-ish corners: 4px cards, buttons, fields and strip cards; 3px pills, chips, portraits and the button's inset rule; 2px on the ribbon frame. Rarity is drawn as a rotated square (diamond), never a circle; the only circle is the shop switch's 8px state dot. The pin's heads are 9px gold diamonds above and below the cards. Peek portraits fan like held cards (-7deg, centre raised and scaled 1.08, +7deg, overlapping by 10px).

## Components

### Buttons
- **Primary** (dnd5e's black button): black with gold lettering, bold, 36px, the card shadow, and a 1px gold rule inset 3px on all sides. Hover brightens the lettering and turns the inset rule pin gold. Used for "Open for 150 gp", the reveal's Close, and dialog defaults.
- **Disabled buy:** the row-alt ground, mute ink, no shadow, a dashed soft inset rule, and its reason as a visible 12px line beneath. It is `aria-disabled="true"`, never `disabled`, so the Buy a keyboard user pressed keeps focus while it reads "Opening…"; style it by `[aria-disabled="true"]`.
- **Quiet:** field ground, soft rule, 30px; hover darkens the border to the gold rule; disabled turns dashed and mute. Font Awesome icons Foundry ships sit inside at a 6px gap.

### Chips
- **Odds pill:** field ground, soft rule, 3px corners, condensed bold 12px ink naming rarity and chance, led by a 6px rarity diamond.
- **Filter chip:** the pill's shape at 26px; pressed chips fill black with gold lettering; problem chips go amber on the warn wash.

### Cards / Containers
- **Crate card:** paper card in a 1px gold rule, 4px corners, card shadow; a maroon band with the Modesto name; a centred body with the peek (up to three real items), the ribbon, the odds pills, stock and a full-width primary button.
- **Pool card:** the same card; its summary row carries a gold chevron, the slab name and the census, tinted 10% maroon.
- **Chat card:** a small card with a gold rule; the buyer line, then the item in a 42px portrait underlined 3px in its rarity, its slab name and the rarity named beside a diamond. A refunded card drops the shadow, greys the portrait and mutes the rarity.
- **Welcome window:** a 540px window on the theme ground: the slab heading (17px, an h2 that labels the section), a 13px lede in soft ink, then the lists on a paper card in a gold rule (slab subheads at 14px in sentence case, never capitals; list markers in gold ink), then the actions with one primary (dnd5e's black button, focused when the window opens), quiet buttons and the guide as a link drawn like a quiet button; under a soft rule, the 12px foot in mute ink saying how it comes back, with Don't show again beside it. The note after an update is the same window with its lines on the card and Close as the primary.

### Inputs / Fields
- **Style:** field ground, 1px soft rule, 4px corners, 30px, 13px Roboto; placeholder in mute ink. Hover darkens the border to the gold rule.
- **Focus:** a 2px outline in the focus colour (maroon on paper, pin gold on slate), 1px offset.

### Navigation
- **Tabs:** dnd5e sheet tabs: condensed bold upper case 13px in mute ink, 34px, no box; hover shows a soft underline, active takes ink and a 2px gold-rule underline over the tab bar's 1px gold rule. The shop switch sits at the end and states its condition in words with a dot (mute when closed, green when open).

### The Vault and Strip (signature)
The vault holds the ribbon (max 520px, along its top edge), the strip and the result. The strip is a 168px masked viewport (fading at 10%/90%) of 120 x 140px strip cards, 8px apart: vault-card ground, vault-line border, a 70px art frame rimmed in 55% pin gold over a 16% rarity tint, a two-line 12px name, and a 5px rarity bar across the foot. The pin is a 2px gold line drawn behind the cards so it shows only in the gaps, capped by gold diamonds. The result is the Modesto name in its rarity, the rarity in upper-case condensed vault-soft, then a 13px line saying where it went and the gold left, entering 460ms later so the name lands first.

**Spin motion.** One requestAnimationFrame loop drives one translateX over the default 6.2s. For the first 86% of the time the strip runs to the target plus an overshoot (spin.js `spinDistance`): a short linear run-up (7% of that run), a constant-speed cruise (45%, about 39% of the whole spin) where the cards blur past and the tick rattles at its fastest, then a cubic ease-out that starts at the cruise speed and stops dead at the overshoot point. The speed never jumps between phases. The last 14% is an ease-in-out settle back. probe-spin checks the cruise: the marker's speed holds within 10% for at least 30% of the frames before the peak. On a near-miss the overshoot crosses half the result card and the gap and goes a quarter card into the teased card, which is one droppable rank up, then clicks back. Otherwise the overshoot stays inside the result card (18% of a card). Reduced motion skips straight to the landed state and drops the card, wash and line transitions.

**Spin sound.** Every sound marks something the eye sees in the same frame. A tick per card that crosses the marker, falling from 900 Hz to 600 Hz with progress. The braking sweep is cued by the frame where the ease-out begins (spin.js `onPhase("brake")`, 2.77 s into the default spin), not by a timer: a sawtooth falling from 260 Hz to 90 Hz through a closing lowpass, fading out over exactly the time left until the settle. On a near-miss the teased card gets two quick rising notes above every tick, and the click back onto the result is one low, soft triangle note, so the pull forward and the drop back sound different. Then the rarity sting. A spin skipped, hidden or closed before the brake, or in reduced motion, plays no sweep; one that lands early mid-brake cuts the sweep in 40 ms, so it never winds on under the sting. A sound that fails never stops the strip.

### The Well (the second stage in the vault)
The Wishing Well's reveal uses the vault at the strip's height (168px) with its own pieces, placed once in CSS and moved only by transform and opacity from one animation frame loop: a dark water basin (280 x 96px ellipse, a 1px vault-line inset, a 3px rim at 40% gold rim), three ripple rings (1px at 70% pin gold), a 22px gold coin, a glow (the rarity colour at 85%, fading out by 70%) and the find in the strip card's 70px art frame with the landed card's pin-gold ring. The coin arcs in from the top left, tumbling, meets the water at 0.7s (the plop), sinks as the ripples run; by 1.8s nothing is left but the last ring, faint, or by 2.2s the coin hangs over the water again, or by 2.6s the glow has lifted the find and the vault takes the rarity wash as a landed strip does. Reduced motion and a hidden page land in the final pose at once. Sounds: a plop at the splash, a single soft plink for nothing, two rising notes for the coin back, the rarity sting for a find.

### The Deck (the third stage in the vault)
The Deck of Many Things' reveal uses the vault at the strip's height (168px) for one card, 104 x 148px on a 720px perspective, its two faces placed once in CSS (`backface-visibility: hidden`; the front pre-turned 180 degrees) and moved by one `transform` from one animation frame loop: it lifts 14px over 300ms, holds face-down for 900ms under three soft ticks (900, 750 and 600 Hz, the strip's falling ticks), then turns once over 420ms with a 6% breath of scale at the half turn. The back is the vault card with a faint 45-degree gold hatch, an inset gold rule and the pin's diamond at its heart. The front is the strip card turned portrait: a 64px art frame ringed in pin gold, the GM's name for the card in the slab face, and its kind as an upper-case 11px band in the result's swatch (a rarity, the coin's gold rim, the bane's slate, mute ink). The quiet result line is the card's name; a bane's is set in the bane token, the one loss the Vault Speaks In Colour rule admits. A boon washes the vault in its rarity, a coins card in the gold rim at 14%; a bane dims it (a cold radial of 22% bane over black at 62%) rather than lighting it. Reduced motion and a hidden page land turned. Draw again, the buyer's next draw at the risen price, is a primary button beside Close with its reason as a 12px line before it when off.

### The Wheel and the Table (the fourth stage in the vault)
Roulette's reveal is the odds ribbon bent into a circle: a 200px top-down disc of N pocket wedges in the two tones the GM names (`--lc-wheel-a`, the band's maroon, and `--lc-wheel-b`, a warm near-black, fixed like the vault), each pocket's outer arc in its rarity colour (`--lc-rarity` through the `lc-rarity-*` classes, the one place the ladder is a ring), the number in Modesto on the wedge, a dark hub with the pin's diamond at its heart, and the pin's 10px diamond at twelve o'clock as the marker. The ball is the well's gold coin on its own orbit. roulette.js writes the disc's rotation, the orbit's rotation and the ball's radius from one animation frame loop and nothing else: the disc turns two turns clockwise with a cubic ease-out and comes to rest with the pocket under the pin; the ball runs six turns the other way with a quartic ease-out, so it slows harder than the disc, dips from the rim to the pocket's floor over the last 22% (the drop) and stops at the pin, in the pocket. Ticks fire as the ball crosses pocket boundaries relative to the disc, so they slow as it does; one soft drop (`playDrop`, a low sine knock, lower and shorter than the well's plop) as it dips; a win's rising notes for a viewer whose character won. Reduced motion and a hidden page pose the landing at once.

Beside the wheel, the rail: the bet spots in the strip card's language (vault-card ground, vault-line rule, 4px corners), the colours and numbers in their pocket tone, a rarity band's 4px bar along its foot as a strip card's. A chip is an 18px gold coin with the character's initial, stacked where it falls (6px overlap), this viewer's ringed in the vault's ink; a chip that just landed drops onto its spot over 320ms (motion answering a bet). Landing: the winning spots lift ringed in the pin's gold with their chips lit, the rest step back to 45% as the strip's other cards do, and the vault takes the pocket's rarity wash. The verdict is a sentence in the slab face (The Quiet Result Rule), coloured in the vault by the pocket's rarity, then each character's net in the 13px line.

The Auction's board sits in the same vault in place of the wheel. The lot is a strip card turned sideways: a 64px art tile ringed in the pin's gold on the vault card, its rarity as the card's left edge (3px, the one place the ladder appears on the board), the name in the slab face and its rarity or "Opened for the winner at the hammer" under it. Beside it the top bid is the room's one number: Modesto at 40px in the pin's gold, the bidder's name under it in bold ink, and "Reserve met" (in gold) or "Reserve not met yet" (soft), never the reserve's amount. The last five bids run under them as small tags (vault card, vault line, 3px corners): the top one ringed in gold, the beaten ones soft with their amount struck through, a house bidder's name in italic, the viewer's own underlined in the vault ink, and a new one dropping in as a chip does. The gavel is a 6px bar in the pin's gold across the board with the gavel glyph at its end: auction.js drains it with one scaleX transform from one animation frame loop (stepped once a second under reduced motion), and a bid fills it again with a 420ms brighten, so the reset is seen. At the hammer the loop stops, the gavel's head swings once (one rotate), one soft knock (`playDrop`), and a stamp ("Sold" in gold, "No sale" in the soft ink) lands over the bid block, tilted 8 degrees; for a sealed crate the crate's own strip then runs under the board to the winner's draw. The vault takes the lot's rarity wash on a sale. The player's form is one field ("Your bid (gp)", filled with the next legal bid) and the primary button naming that bid ("Bid 55 gp", "Bidding…" while out); the GM's primary is "Bring the gavel down", with "Call it off" as a quiet button beside it, away from Close.

The shared table window is the reveal's layout with the table's controls: a head naming the game, the bets down and the round's state in the data voice (a clock in tabular figures, mute once closed), the vault with the stage, then a player's bet form (dnd5e field labels over a type select, a pick select whose options follow the type and name their odds, a stake field within the GM's bounds, and the primary "Place a bet" that reads "Placing…" while the bet is out) with a refused bet said in amber on the line under it, and the GM's primary Spin at the left of the actions. The chips are decorative to assistive tech; a visually hidden list names every bet, and a status line says each new one and the state as it changes.

### The Odds Ribbon (signature)
A 10px bar of the crate's real drop chances: a gold-rim frame with 2px padding, a 35% black inset hairline, and 1px gaps between segments, each grown by its share and filled with its rarity (minimum 4px). Hidden from assistive tech; the odds pills carry the words.

## Do's and Don'ts

### Do:
- **Do** scope every rule under `.loot-crates`, and set theme tokens with `@scope (.theme-light) to (.themed)` and `@scope (.theme-dark) to (.themed)` so each window follows its nearest Foundry theme.
- **Do** reference dnd5e's textures and fonts by relative path (`../../../systems/dnd5e/...`, `../../../ui/denim075.png`); never copy them into the module.
- **Do** read rarity from `--lc-rarity` and `--lc-rank`; set them only through the six `lc-rarity-*` classes.
- **Do** show a crate's bet as the odds ribbon plus named odds pills wherever a crate is shown.
- **Do** keep the vault dark (`vault`) in both themes and let the rarity wash, scaled by rank, carry the escalation.
- **Do** put the cost on the primary action ("Open for 150 gp") and the reason for a disabled action on screen, beneath it.
- **Do** keep the bane's token, dimmed vault and falling notes for a loss of coins and nothing else.

### Don't:
- **Don't** colour text in a rarity colour on paper or slate; use edges, diamonds and ribbon segments.
- **Don't** give the landed card a coloured glow; it lifts on a neutral shadow with an inset rarity ring.
- **Don't** set caps kickers above headings; upper case is for dnd5e field labels, tabs, table headers and the rarity name under its item.
- **Don't** set text smaller than 11px.
- **Don't** use emoji in UI text; Font Awesome icons that Foundry ships are fine.
- **Don't** change the spin's timing or near-miss behaviour as part of styling work.
- **Don't** style Foundry's chrome, title bars or other modules.
