/*
  What's new in this version, for the GM's note after an update
  (welcome.js). Plain lines a GM reads in ten seconds, three to five of
  them. Keep it in step with CHANGELOG.md: its newest entry's version and
  every line here as one of that entry's bullets (test/welcome.test.js
  checks both, and that the version is module.json's). No Foundry globals.
*/
export const LATEST = {
  version: "1.0.1",
  title: "Steadier days and rests",
  lines: [
    "With dnd5e's calendar on, a player's own long rest now ends that character's day. dnd5e moves the clock for a rest only on a GM's client, so the well's cap and a limit per day used to stay shut after a player rested from their sheet. When the GM later moves the clock over the same night, it doesn't count as a second day.",
    "A long rest taken while no GM is online now still ends the day. The player's browser keeps the rest and sends it once a GM joins. Before, the rest was dropped.",
    "A deck's shop card drops back to its base price when the streak window runs out, without the shop being reopened.",
    "A table round left unspun past its grace is refunded while the GM stays online. Before, its stakes came back only when the GM reloaded.",
  ],
};
