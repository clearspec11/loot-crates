/*
  What's new in this version, for the GM's note after an update
  (welcome.js). Plain lines a GM reads in ten seconds, three to five of
  them. Keep it in step with CHANGELOG.md: its newest entry's version and
  every line here as one of that entry's bullets (test/welcome.test.js
  checks both, and that the version is module.json's). No Foundry globals.
*/
export const LATEST = {
  version: "0.14.0",
  title: "Crates from roll tables, and the Auction",
  lines: [
    "Make a crate from a roll table: right-click the table in the Roll Tables sidebar and choose Make a crate, or drop it on the Boxes tab. The table's own odds come with it.",
    "A crate made from a table can count its text results as nothing: that share of pulls gives no item, and the card says so.",
    "The Auction: put an item or a sealed crate up for bids at the table. Bids are held until the gavel comes down, and only the winner pays.",
    "Players see whether the reserve is met, never the amount.",
  ],
};
