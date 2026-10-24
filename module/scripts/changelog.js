/*
  What's new in this version, for the GM's note after an update
  (welcome.js). Plain lines a GM reads in ten seconds, three to five of
  them. Keep it in step with CHANGELOG.md: its newest entry's version and
  every line here as one of that entry's bullets (test/welcome.test.js
  checks both, and that the version is module.json's). No Foundry globals.
*/
export const LATEST = {
  version: "1.0.0",
  title: "The first public release",
  lines: [
    "Starter crates: in an empty world, Add starter crates on the manager's Pools or Boxes tab fills four pools from the dnd5e system's own compendiums and adds one game of every kind, all off the shelf until you put them out.",
    "A welcome window on a GM's first load says where Crates and Manage crates are and what to do first. After an update, a short \"What's new\" note says what changed. Show the welcome, in Game Settings under Loot Crates, brings it back.",
    "Deleting a wheel or an auction with a round open calls the round off first. The confirm says how many stakes it holds and how much gold, and every stake comes back at once instead of on a later reload.",
    "With dnd5e's calendar off (its default), a day now ends at each character's long rest, as it does for dnd5e's own daily uses: the well's daily cap and a limit per day open again after a long rest instead of staying shut until the GM moves the world's time. The editors say so beside the cap. Counts made before this update were keyed on the clock, so the first session after it starts every character's day fresh.",
  ],
};
