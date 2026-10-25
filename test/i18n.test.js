/*
  The module's words: every sentence lives in module/lang/en.json and is read
  through i18n.js t(). These check the file against the scripts (every key a
  script names is in it, every key in it is named, a call's data fills the
  placeholders its sentence has), the file itself (no empty value, no emoji,
  one namespace), and t()'s own rules: Foundry's localizer first, then the
  English table, then the key itself.
*/
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { parse } from "acorn";
import en from "../module/lang/en.json";
import { t, fill, setStrings, setLocalizer, loadStrings, onStrings, words, listAnd, stringKeys } from "../module/scripts/i18n.js";

const root = path.resolve(import.meta.dirname, "..");
const dir = path.join(root, "module/scripts");
const scripts = readdirSync(dir).filter(f => f.endsWith(".js")).map(f => ({ file: f, src: readFileSync(path.join(dir, f), "utf8") }));

// en.json flattened to its full keys.
const flat = (obj, prefix = "", out = {}) => {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flat(v, key, out);
    else out[key] = v;
  }
  return out;
};
const table = flat(en);
const KEY = /^LOOTCRATES\.[A-Z][A-Za-z]*\.[A-Z][A-Za-z0-9]*$/;
const placeholders = text => new Set([...String(text).matchAll(/{([^{}]+)}/g)].map(m => m[1]));

// Every "LOOTCRATES.…" string the scripts hold.
const named = new Set(scripts.flatMap(({ src }) => [...src.matchAll(/["'`](LOOTCRATES\.[A-Za-z0-9.]+)["'`]/g)].map(m => m[1])));

// Every call of t() in the scripts, with the keys its first argument can be
// (a literal, or either side of a ?: of literals) and its data's property
// names when the data is an object literal with no spread.
function walk(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(v => walk(v, visit));
    else if (value && typeof value.type === "string") walk(value, visit);
  }
}
const keysOf = node => {
  if (node?.type === "Literal" && typeof node.value === "string") return [node.value];
  if (node?.type === "ConditionalExpression") {
    const a = keysOf(node.consequent), b = keysOf(node.alternate);
    return a && b ? [...a, ...b] : null;
  }
  return null;
};
const calls = [];
const wordTables = [];
for (const { file, src } of scripts) {
  walk(parse(src, { ecmaVersion: "latest", sourceType: "module" }), node => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier") return;
    if (node.callee.name === "t") {
      const keys = keysOf(node.arguments[0]);
      const data = node.arguments[1];
      const props = !data ? [] : data.type === "ObjectExpression" && data.properties.every(p => p.type === "Property" && !p.computed) ? data.properties.map(p => p.key.name ?? p.key.value) : null;
      calls.push({ file, keys, props });
    }
    if (node.callee.name === "words") {
      const arg = node.arguments[0];
      const values = arg?.type === "ObjectExpression" ? arg.properties.map(p => p.value) : arg?.type === "ArrayExpression" ? arg.elements : [];
      wordTables.push({ file, keys: values.map(v => (v?.type === "Literal" ? v.value : null)) });
    }
  });
}

afterEach(() => {
  setLocalizer(null);
  setStrings(en);
});

describe("lang/en.json", () => {
  it("is declared in module.json and ships beside the scripts", () => {
    const manifest = JSON.parse(readFileSync(path.join(root, "module/module.json"), "utf8"));
    expect(manifest.languages).toEqual([{ lang: "en", name: "English", path: "lang/en.json" }]);
    expect(existsSync(path.join(root, "module", manifest.languages[0].path))).toBe(true);
  });

  it("keeps every word under one namespace, LOOTCRATES.<Area>.<Name>", () => {
    expect(Object.keys(en)).toEqual(["LOOTCRATES"]);
    expect(Object.keys(table).filter(k => !KEY.test(k))).toEqual([]);
  });

  it("has no empty value, no emoji and no key standing in for a word", () => {
    const values = Object.entries(table);
    expect(values.filter(([, v]) => typeof v !== "string" || !v.trim())).toEqual([]);
    expect(values.filter(([, v]) => /\p{Extended_Pictographic}/u.test(v))).toEqual([]);
    expect(values.filter(([, v]) => v.includes("LOOTCRATES."))).toEqual([]);
  });

  it("holds every key the scripts name, and every key it holds is named by a script", () => {
    expect([...named].filter(k => !(k in table))).toEqual([]);
    expect(Object.keys(table).filter(k => !named.has(k))).toEqual([]);
    // Keys are written out whole, so the check above sees every one: no
    // key is built from pieces in a template literal.
    expect(scripts.filter(({ src }) => /\bt\(`/.test(src)).map(s => s.file)).toEqual([]);
  });

  it("the scan sees the scripts' calls", () => {
    expect(calls.length).toBeGreaterThan(500);
    expect(calls.filter(c => c.keys).length).toBeGreaterThan(500);
    expect(calls.filter(c => c.keys && c.props?.length).length).toBeGreaterThan(250);
    expect(wordTables.length).toBeGreaterThan(20);
  });

  it("each call passes the data its sentence's placeholders name, and no more", () => {
    const wrong = [];
    for (const { file, keys, props } of calls) {
      if (!keys || !props) continue;
      for (const key of keys) {
        const want = [...placeholders(table[key])].sort();
        const got = [...new Set(props)].sort();
        if (JSON.stringify(want) !== JSON.stringify(got)) wrong.push(`${file} ${key}: sentence has {${want.join(", ")}}, call passes {${got.join(", ")}}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("a label table (words) names whole keys whose sentences take no data", () => {
    const wrong = wordTables.flatMap(({ file, keys }) => keys.filter(k => k !== "" && (typeof k !== "string" || !(k in table) || placeholders(table[k]).size)).map(k => `${file} ${k}`));
    expect(wrong).toEqual([]);
  });

  it("the tests' table is the file (test/setup-i18n.js)", () => {
    expect(stringKeys().sort()).toEqual(Object.keys(table).sort());
    expect(t("LOOTCRATES.Shop.Title")).toBe("Crate Shop");
  });
});

describe("i18n.js", () => {
  it("is pure: no Foundry globals", () => {
    const src = readFileSync(path.join(dir, "i18n.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/\b(game|Hooks|ui|foundry|fromUuid)\b/);
  });

  it("fills {name} placeholders from the data, once, and leaves one the data hasn't got", () => {
    expect(t("LOOTCRATES.Card.OpenFor", { price: "25 gp" })).toBe("Open for 25 gp");
    expect(t("LOOTCRATES.Shop.Raised", { name: "The {who} Crate", price: "5 gp", who: "Tam" })).toBe("The {who} Crate now costs 5 gp, more than Tam has.");
    expect(fill("{a} and {b}", { a: 1 })).toBe("1 and {b}");
    expect(fill("{n} items", { n: 0 })).toBe("0 items");
  });

  it("gives a key it doesn't know back as itself, so a missing word shows", () => {
    expect(t("LOOTCRATES.Nowhere.Nothing")).toBe("LOOTCRATES.Nowhere.Nothing");
  });

  it("asks the localizer first, and reads the English table when it has no such key", () => {
    setLocalizer(key => (key === "LOOTCRATES.Shop.Title" ? "Kistenladen" : key === "LOOTCRATES.Card.OpenFor" ? "Öffnen für {price}" : null));
    expect(t("LOOTCRATES.Shop.Title")).toBe("Kistenladen");
    expect(t("LOOTCRATES.Card.OpenFor", { price: "25 gp" })).toBe("Öffnen für 25 gp");
    expect(t("LOOTCRATES.Card.SoldOut")).toBe("Sold out");
  });

  /*
    A name that is gone at run time (a deleted character's or item's, a
    pool with no name) reaches t() as undefined or null. Foundry's format
    would write it as "undefined"; t() fills the placeholders itself under
    both localizers, so it reads as nothing. The localizer here behaves as
    main.js's: Foundry's sentence for a key it has, placeholders unfilled.
  */
  it("never says 'undefined', 'null' or '{name}' for a missing name, with Foundry's localizer or without", () => {
    const foundryLike = key => (table[key] ?? null);
    for (const localizer of [null, foundryLike]) {
      setLocalizer(localizer);
      for (const name of [undefined, null]) {
        const said = t("LOOTCRATES.Card.NothingNewFor", { name });
        expect(said).not.toMatch(/undefined|null|\{name\}/);
        expect(said).toBe(fill(table["LOOTCRATES.Card.NothingNewFor"], { name: "" }));
        const head = t("LOOTCRATES.Shelf.Refusal", { name });
        expect(head).not.toMatch(/undefined|null|\{name\}/);
      }
      expect(t("LOOTCRATES.Card.NothingNewFor", { name: "Tam" })).toBe(fill(table["LOOTCRATES.Card.NothingNewFor"], { name: "Tam" }));
      expect(t("LOOTCRATES.Card.OpenFor", { price: 0 })).toBe("Open for 0");
    }
    expect(fill("{a}, {b} and {c}", { a: undefined, b: null, c: 0 })).toBe(",  and 0");
  });

  it("main.js's localizer hands over Foundry's sentence unfilled, never through game.i18n.format", () => {
    const main = readFileSync(path.join(dir, "main.js"), "utf8");
    expect(main).toMatch(/setLocalizer\(key => \(game\.i18n\.has\(key\) \? game\.i18n\.localize\(key\) : null\)\)/);
    expect(main).not.toMatch(/i18n\.format\(/);
  });

  it("asks the localizer for the sentence alone and fills it here, so a translation reads a missing name as nothing too", () => {
    const asked = vi.fn(key => (key === "LOOTCRATES.Card.OpenFor" ? "Öffnen für {price}" : null));
    setLocalizer(asked);
    expect(t("LOOTCRATES.Card.OpenFor", { price: undefined })).toBe("Öffnen für ");
    expect(asked).toHaveBeenCalledWith("LOOTCRATES.Card.OpenFor");
    expect(asked.mock.calls.every(c => c.length === 1)).toBe(true);
  });

  it("words(): labels read when read, so a table made before the words arrive is right after", () => {
    setStrings({});
    const labels = words({ a: "LOOTCRATES.Card.SoldOut" });
    const list = words(["LOOTCRATES.Card.SoldOut", ""]);
    setStrings(en);
    expect(labels.a).toBe("Sold out");
    expect({ ...labels }).toEqual({ a: "Sold out" });
    expect([...list]).toEqual(["Sold out", ""]);
  });

  it("onStrings(): a text constant is set now and again whenever the words change", () => {
    let said = "";
    onStrings(() => { said = t("LOOTCRATES.Card.SoldOut"); });
    expect(said).toBe("Sold out");
    setStrings({ LOOTCRATES: { Card: { SoldOut: "Ausverkauft" } } });
    expect(said).toBe("Ausverkauft");
    setLocalizer(key => (key === "LOOTCRATES.Card.SoldOut" ? "Épuisé" : null));
    expect(said).toBe("Épuisé");
  });

  it("listAnd(): a list in words", () => {
    expect(listAnd([])).toBe("");
    expect(listAnd(["A"])).toBe("A");
    expect(listAnd(["A", "B", "C"])).toBe("A, B and C");
  });

  it("loadStrings() fetches lang/en.json from beside the scripts into the table", async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ LOOTCRATES: { Card: { SoldOut: "Gone" } } }) }));
    vi.stubGlobal("fetch", fetch);
    try {
      await loadStrings();
      expect(String(fetch.mock.calls[0][0])).toMatch(/\/module\/lang\/en\.json$/);
      expect(t("LOOTCRATES.Card.SoldOut")).toBe("Gone");
      fetch.mockImplementationOnce(async () => ({ ok: false, status: 404 }));
      await expect(loadStrings()).rejects.toThrow(/404/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
