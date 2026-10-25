/*
  The module's words for every test: lang/en.json in the English table, as
  main.js fills it in a world (i18n.js), so a test reads the sentences a
  player does and its expected strings are the English ones.
*/
import en from "../module/lang/en.json";
import { setStrings } from "../module/scripts/i18n.js";

setStrings(en);
