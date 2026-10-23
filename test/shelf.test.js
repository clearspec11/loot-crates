/*
  On the shelf (shelf.js): a record is on the shelf unless its rules say
  `shelved: false`, so every record from before the flag sells as it did;
  a player's shop leaves the rest out, the GM's keeps them.
*/
import { describe, it, expect } from "vitest";
import { onShelf, shelfRules, shelfFor, shelfCountText, shelfRefusal, shelfFieldHTML, shelfToggleHTML, shelfNotice } from "../module/scripts/shelf.js";

const A = { id: "a", name: "Gilded Crate", rules: {} };
const B = { id: "b", name: "Midnight Wheel", kind: "roulette", rules: { shelved: false } };
const LEGACY = { id: "c", name: "Old Crate" };

describe("onShelf and shelfRules", () => {
  it("reads a record with no flag, or no rules at all, as on the shelf", () => {
    expect(onShelf(A)).toBe(true);
    expect(onShelf(LEGACY)).toBe(true);
    expect(onShelf({ rules: { shelved: true } })).toBe(true);
    expect(onShelf(B)).toBe(false);
  });

  it("writes only the flag, and drops it again when the game goes back out", () => {
    const rules = { pity: null, stock: 3 };
    expect(shelfRules(rules, false)).toEqual({ pity: null, stock: 3, shelved: false });
    expect(shelfRules({ ...rules, shelved: false }, true)).toEqual(rules);
    expect(shelfRules(undefined, true)).toEqual({});
    expect(rules).toEqual({ pity: null, stock: 3 });
  });
});

describe("shelfFor", () => {
  it("shows a player only what is on the shelf, legacy records included", () => {
    expect(shelfFor([A, B, LEGACY]).map(g => g.id)).toEqual(["a", "c"]);
    expect(shelfFor([B])).toEqual([]);
  });
  it("shows the GM everything", () => {
    expect(shelfFor([A, B, LEGACY], { isGM: true }).map(g => g.id)).toEqual(["a", "b", "c"]);
  });
});

describe("the words", () => {
  it("counts the games on the shelf", () => {
    expect(shelfCountText([A, B, LEGACY])).toBe("2 of 3 on the shelf");
    expect(shelfCountText([])).toBe("");
  });
  it("refuses with the game's name and says nothing was charged", () => {
    expect(shelfRefusal(B)).toBe("Midnight Wheel is no longer on the shelf. Nothing was charged.");
  });
  it("says what players can see after a toggle", () => {
    expect(shelfNotice(A)).toBe("Gilded Crate is on the shelf; players can see it.");
    expect(shelfNotice(B)).toBe("Midnight Wheel is off the shelf; players can't see it.");
  });
});

describe("the editor's box and the row's toggle", () => {
  it("ticks the box for a New, and follows the record for an edit or a copy", () => {
    expect(shelfFieldHTML(B, { isNew: true })).toContain('name="onShelf" checked');
    expect(shelfFieldHTML(B, { isNew: false })).not.toContain("checked");
    expect(shelfFieldHTML(A, { isNew: false })).toContain("checked");
    expect(shelfFieldHTML(B, { isNew: true, copy: true })).not.toContain("checked");
  });
  it("is a pressed toggle on the shelf and Put on shelf off it, named for its game", () => {
    expect(shelfToggleHTML(A)).toContain('data-action="toggleShelf" data-box="a" data-on="true" aria-pressed="true" aria-label="On the shelf: Gilded Crate"');
    expect(shelfToggleHTML(B)).toMatch(/aria-pressed="false" aria-label="Put on shelf: Midnight Wheel"[^>]*>Put on shelf<\/button>$/);
  });
});
