/*
  What's new in this version, for the GM's note after an update
  (welcome.js). Plain lines a GM reads in ten seconds, three to five of
  them. Keep it in step with CHANGELOG.md: its newest entry's version and
  every line here as one of that entry's bullets (test/welcome.test.js
  checks both, and that the version is module.json's). The title and the
  lines are words in lang/en.json (LOOTCRATES.News), so a translation
  carries the note too. No Foundry globals.
*/
import { t, words } from "./i18n.js";

export const LATEST = {
  version: "1.4.0",
  get title() { return t("LOOTCRATES.News.Title"); },
  lines: words(["LOOTCRATES.News.Line1", "LOOTCRATES.News.Line2", "LOOTCRATES.News.Line3"]),
};
