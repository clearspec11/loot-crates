# Changelog

What changed in each release of Loot Crates, newest first. **Unreleased** is what is on `main` since the last release; at release time it takes the new version number.

The newest numbered entry's version is the one in `module/module.json`, and its bullets include every line of `module/scripts/changelog.js`, which is what a GM sees in the "What's new" note after updating (`test/welcome.test.js` checks both). Every release tag on GitHub has an entry here (`test/release.test.js` checks the list).

## Unreleased

- Nothing yet.

## 1.2.0

Game windows that tidy themselves.

- Finished game windows now close by themselves, so they no longer pile up on every screen. Once a crate, the Wishing Well, Dragon's Teeth or the Deck has shown its result, or a Roulette or Auction round has been settled or called off, the window closes after 30 seconds. A small line says "Closes in 30 s" with Keep open beside it. The countdown waits while the pointer is over the window or someone is using it from the keyboard. Each player picks the delay under Close finished game windows in Game Settings: never, 10 seconds, 30 seconds or a minute. Watch again on the chat card still plays any result again. The shop, the manager and dialogs never close by themselves.
- With two GMs online, an auction's gavel now settles once. A second GM who joined while the first GM's Foundry was bringing the gavel down could settle it a second time and hand the lot out twice. Now the GM who is no longer running the game stops before it writes anything, and a GM whose sale lands on a round already settled leaves it alone.
- A missing name, such as a deleted character's, now reads as "Someone" in the refund's chat card, the Roulette's results, the Auction's bids, board and shop card, and a table stake's line. Before 1.1.1 it read "undefined", and in 1.1.1 it left a gap ("'s Goblin Crate was refunded").

## 1.1.1

Steadier auctions and dice.

- With Dice So Nice on, Dragon's Teeth now shows the faces and the total the moment the 3D roll ends and lands a frame later, as it does without Dice So Nice. Before, the window coloured the dice and landed in the same instant.
- When the GM running the game leaves and another GM takes over during an auction, the new GM's Foundry now brings the gavel down and runs the house bidders. Before, the auction waited for the next bid or a reload, and the gavel never fell.
- A name that is missing, such as a deleted character's, now reads as nothing instead of the word "undefined" in the module's messages, in English and in a translation.
- The README's FAQ says how an in-game day ends for the Wishing Well's throws and a limit per day, with dnd5e's calendar on and off.

## 1.1.0

Ready for translation, and steadier days.

- With dnd5e's calendar on, two long rests on the same calendar day (the GM's, then a player's from their sheet) now end one day, not two. Before, the well's cap and a limit per day stayed shut for the next two midnights.
- When the GM running the game leaves and another GM takes over, a table round left unspun is still refunded once it goes stale. Before, the new GM's client waited for a reload or the next round.
- Every word the module shows now lives in one English language file, so the module can be translated by adding a file for another language. Nothing reads differently in English.

## 1.0.1

Steadier days and rests, and honest compatibility.

- The manifest now asks for Foundry v13.341 (v13's first stable build) or later, not any v13 build. Earlier v13 test builds lack the Roll Tables menu hook and the dialog callbacks the module uses. dnd5e 5.0.0 or later is still required.
- With dnd5e 5.2 or 5.3 and its calendar shown, a day now ends at each character's long rest, as dnd5e 5 recovers its own daily uses. Before, the well's daily cap and a limit per day stayed shut until the GM moved the world's clock.
- docs/COMPATIBILITY.md lists every hook, Foundry API and dnd5e field the module uses. Each entry says what's tested on Foundry v14 with dnd5e 6, and what was read from Foundry v13's docs and dnd5e 5's source, with links.
- With dnd5e's calendar on, a player's own long rest now ends that character's day. dnd5e moves the clock for a rest only on a GM's client, so the well's cap and a limit per day used to stay shut after a player rested from their sheet. When the GM later moves the clock over the same night, it doesn't count as a second day.
- A long rest taken while no GM is online now still ends the day. The player's browser keeps the rest and sends it once a GM joins. Before, the rest was dropped.
- A deck's shop card drops back to its base price when the streak window runs out, without the shop being reopened.
- A table round left unspun past its grace is refunded while the GM stays online. Before, its stakes came back only when the GM reloaded.

## 1.0.0

The first public release: starter crates, a welcome for the GM, and a polish pass.

- Starter crates: in an empty world, Add starter crates on the manager's Pools or Boxes tab fills four pools from the dnd5e system's own compendiums and adds one game of every kind, all off the shelf until you put them out.
- A welcome window on a GM's first load says where Crates and Manage crates are and what to do first. After an update, a short "What's new" note says what changed. Show the welcome, in Game Settings under Loot Crates, brings it back.
- A price, weight or rarity saved in place says so in the tab's status line ("Saved: Goblin Crate, 12 gp 5 sp.").
- The deck's "draws in a row" window is a field in the deck editor instead of a fixed two minutes.
- Deleting a wheel or an auction with a round open calls the round off first. The confirm says how many stakes it holds and how much gold, and every stake comes back at once instead of on a later reload.
- Smaller fixes: a table window no longer offers a bet on a wheel or lot taken off the shelf mid-round; the Restock line follows a later change to Stock; Hide misses folds a crate's "Nothing" pulls the way it folds the well's throws.
- A README for GMs and players, with install steps, a quick start and screenshots.
- Released under the MIT license.
- With dnd5e's calendar off (its default), a day now ends at each character's long rest, as it does for dnd5e's own daily uses: the well's daily cap and a limit per day open again after a long rest instead of staying shut until the GM moves the world's time. The editors say so beside the cap. Counts made before this update were keyed on the clock, so the first session after it starts every character's day fresh.

## 0.14.0

Crates from roll tables, and the Auction.

- Make a crate from a roll table: right-click the table in the Roll Tables sidebar and choose Make a crate, or drop it on the Boxes tab. The table's own odds come with it.
- A crate made from a table can count its text results as nothing: that share of pulls gives no item, and the card says so.
- The Auction: put an item or a sealed crate up for bids at the table. Bids are held until the gavel comes down, and only the winner pays.
- Players see whether the reserve is met, never the amount.
- A crate made from a table draws by the table's weights, so a 1 in 100 result stays 1 in 100, and the shop names the real chances. Nested tables are flattened.
- An auction has an opening bid, a least raise, a reserve, a gavel time and optional house bidders.

## 0.13.0

The shelf, prices in the row, and steadier roulette.

- On the shelf: untick a game to hide it from players, then put it out with one click from its Boxes row. A shop drawn before the change can't buy a hidden game.
- Type a price like "12 gp 5 sp" straight into a game's row; every editor reads money the same way.
- Manage crates in the Items sidebar and in the shop, and View shop in the manager.
- Every editor field is named for screen readers; copies are numbered "(copy 2)"; Restock waits for Save.
- Roulette says "Still spinning" while the wheel turns, a failed spin can be tried again, and a timed round keeps ten minutes' grace after it closes.

## 0.12.0

Stock limits and an easier GM manager.

- Stock reads "3 of 10 left" with Restock, and the GM can limit buys per character, ever or per in-game day. A refund gives the purchase back by itself.
- Every New opens an editor on an unsaved draft: nothing reaches the shop until Add to shelf.
- Copy any game from its Boxes row: every pool, weight, card and pocket comes along; stock and history start fresh.
- The Boxes and Pull log tabs fit any manager width; narrow windows stack the rows as cards. Crates get a kind tag.

## 0.11.0

Roulette and the table round.

- The table round: the bets the whole table places are held until one spin settles or refunds them all. Ownership is checked again at the spin, and open bets left behind by a GM reload are refunded with a notice.
- Roulette, the Wheel of Fate: bet on a colour, odd or even, a number or a rarity band in a shared table window. One wheel, one ball, one spin for everyone.
- Draw again keeps focus on the next card; the deck's Boxes row and its stale-price notice follow its current price.
- Fixes: the pool filter chips keep their shape, the Boxes tab follows a round, and the countdown no longer floods screen readers.

## 0.10.0

The Deck of Many Things.

- The Deck of Many Things: a deck the GM writes in the manager, one card that turns over, a draw price that rises for draws in a row with Draw again in the reveal, and a bane with its own cold colour and falling sound. A refund puts the card back and steps the price back.
- Dice stay neutral until the total shows; late-cancel messages name what each game gave; the well's editor says when the world has no calendar; refund cards read right for payouts.

## 0.9.0

One game core, the Wishing Well and Dragon's Teeth.

- Every game runs on one shared core: the money path, the log, the refund and the sealed reveal are one copy. A result can be no item or coins paid out; a refund of winnings already spent is refused, naming the shortfall.
- The Wishing Well: copper or silver throws, quiet misses, every throw logged and refundable, a cap per in-game day from the Foundry calendar.
- Dragon's Teeth: bet on Foundry's dice against the dragon's number, rolled on the GM, the same faces on every screen.
- The refund card says what was taken back after a payout; a card posted only for some outcomes stays hidden until the reveal lands.

## 0.8.2

- The Crate Shop scrolls its crates under a pinned header, and the module's dialogs (Edit box, Edit pool, Add from compendium) scroll their fields with Save and Cancel pinned when they're taller than the window.

## 0.8.1

- The shop holds the character while a crate opens and says why a Buy did nothing.
- A pool's "In X, Y" line follows box edits made elsewhere.

## 0.8.0

Sound in time with the spin, and a price guard.

- The slow-down sound starts when the strip brakes, as a falling sweep, and a near-miss has its own tease and drop-back sounds.
- A crate is only charged the price its Buy showed.
- Each pool names the crates that use it and warns before a delete empties one.
- The shop follows character ownership.

## 0.7.0

Refunds undo pity, and the spin keeps its secret.

- A refund also undoes the pull's pity count and no-duplicates record.
- The granted item stays hidden on character sheets, and the shop's pity line holds, until the spin lands; a crate still spinning can't be bought again.
- Crate sounds go through Foundry's interface channel, so the Mute button and the volume slider apply.

## 0.6.0

Watch again.

- Replay any pull's spin from its chat card, or from a reveal you didn't see spin (a hidden window or Skip). Display only, titled Replay, no gold shown.
- The reveal's odds come from the pools the pull actually drew from; a drop on a pool is announced once.

## 0.5.0

Manager tabs, per-character odds, dropped items pinned.

- The manager's Boxes and Pull log tabs open when clicked, with arrow-key tabs.
- The shop shows each character their own odds: owned items left out under no duplicates, a pity countdown, and "Nothing new" crates turned off before the click.
- Dropped items land at the top of their pool, marked "Just added".

## 0.4.0

Steady keyboard focus and live-updating windows.

- Keyboard focus stays on the Buy you pressed, then the reveal's Close, then back.
- Open shops and the Pull log update live when the GM changes settings or a crate sells.
- A buyer waiting on a GM whose tab is hidden is told after about 2 seconds.

## 0.3.0

The first release: pools, gold-priced boxes and the crate spin, in the dnd5e look.

- Hidden windows never hold the reveal or the chat card back, and chat cards stay sealed until each player's spin lands.
- The GM is warned only about genuinely slow pulls, and a closed shop says so once.
