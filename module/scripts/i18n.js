/*
  The module's words. Every sentence a player or GM reads is a key in
  lang/en.json (LOOTCRATES.<Area>.<Name>), read here with t(key, data);
  text with a number or a name in it is one key with {name} placeholders,
  filled from data as Foundry's game.i18n.format fills them. Pure: no
  Foundry globals, so Vitest and the harness read the same words a world
  does.

  t() asks the localizer first: main.js installs one at i18nInit that
  returns game.i18n.format(key, data) when Foundry has the key and null
  when it hasn't, so a translation in lang/<code>.json wins at the table.
  Then the English table (setStrings), which main.js fills from this
  module's own lang/en.json (loadStrings), for a copy whose keys Foundry
  doesn't know, such as the working copy a live check imports beside an
  installed release; the harness and the tests fill it the same way. A key
  in neither comes back as itself, so a missing word shows rather than
  vanishing.

  Nothing reads a word when a script loads: the strings arrive after the
  scripts have, so a text constant is a getter (words()) or a live binding
  kept current by onStrings().
*/

let localize = null;
let strings = {};
const listeners = new Set();

// en.json is nested, as translators write it; the table is flat, by full key.
function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flatten(v, key, out);
    else if (typeof v === "string") out[key] = v;
  }
  return out;
}

// "{name}" in `text` becomes data.name; a placeholder data hasn't got stays.
export function fill(text, data) {
  if (!data) return text;
  return text.replace(/{([^{}]+)}/g, (m, k) => (data[k] === undefined || data[k] === null ? m : String(data[k])));
}

export function t(key, data) {
  const local = localize?.(key, data);
  if (typeof local === "string") return local;
  const text = strings[key];
  return typeof text === "string" ? fill(text, data) : key;
}

// Run each listener again: the words they read have changed.
function changed() {
  for (const fn of listeners) fn();
}

// fn(key, data) returns the text, or null when it has no such key.
export function setLocalizer(fn) {
  localize = typeof fn === "function" ? fn : null;
  changed();
}

// The English table: en.json as loaded (nested or flat).
export function setStrings(table) {
  strings = flatten(table);
  changed();
}

// The keys the table holds, for the tests.
export const stringKeys = () => Object.keys(strings);

/*
  Fetches this module's own lang/en.json (beside scripts/, so the same
  call works from an installed module, from the working copy served for a
  live check and from the harness) into the table. Resolves once it is in.
*/
export async function loadStrings(url = new URL("../lang/en.json", import.meta.url)) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  setStrings(await res.json());
}

// "a, b and c": a list in the module's words (the list keys in en.json).
export function listAnd(names = []) {
  if (names.length < 2) return names.join("");
  return t("LOOTCRATES.Common.ListAnd", { rest: names.slice(0, -1).join(t("LOOTCRATES.Common.ListComma")), last: names.at(-1) });
}

// Calls fn now and again whenever the words change: for a module-level
// text constant (an `export let`), which fn sets.
export function onStrings(fn) {
  listeners.add(fn);
  fn();
}

/*
  An object (or an array) whose values are keys, read as their words each
  time a value is read: for a module-level table of labels, which must not
  read a word when the script loads. Enumerable getters, so spreading,
  Object.entries and the tests' toEqual see the words.
*/
export function words(keys) {
  const out = Array.isArray(keys) ? [] : {};
  for (const [k, key] of Object.entries(keys)) {
    Object.defineProperty(out, k, { enumerable: true, get: () => (key === "" ? "" : t(key)) });
  }
  return out;
}
