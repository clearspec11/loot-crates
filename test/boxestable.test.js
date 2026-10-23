/*
  The Boxes table (boxestable.js) tags every kind, the crate included, so
  the six games read alike in one table, and captions every cell with its
  column (data-label) under the table's roles, so a narrow pane can stack a
  row as a card (module.css, the lc-tab container) and a screen reader
  still reads a table.
*/
import { describe, it, expect } from "vitest";
import { boxesTableHTML, boxesTabHTML, kindTag, cell, tableHTML, BOXES_COLUMNS, NEW_BUTTONS } from "../module/scripts/boxestable.js";
import { BOXES, POOLS, deckDraws, rouletteRound } from "../harness/sample.js";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const rows = html => [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => m[0]).filter(tr => !tr.includes("<th"));
const tagsOf = html => [...html.matchAll(/<span class="lc-kind">([^<]*)<\/span>/g)].map(m => m[1]);

describe("kindTag", () => {
  it("names every kind, the crate included, so no row goes untagged", () => {
    expect(kindTag({})).toBe("Crate");
    expect(kindTag({ kind: "crate" })).toBe("Crate");
    expect(kindTag({ kind: "well" })).toBe("Well");
    expect(kindTag({ kind: "dice" })).toBe("Dice");
    expect(kindTag({ kind: "deck" })).toBe("Deck");
    expect(kindTag({ kind: "roulette" })).toBe("Wheel");
  });

  it("falls back to the kind's id for one it has no word for", () => {
    expect(kindTag({ kind: "lottery" })).toBe("lottery");
  });
});

describe("the Boxes table", () => {
  const html = boxesTableHTML({ boxes: BOXES, pools: POOLS, log: deckDraws(1), rounds: { R1: rouletteRound() }, esc });

  it("tags every row with its kind, in the sample's order", () => {
    expect(tagsOf(html)).toEqual(["Crate", "Crate", "Crate", "Crate", "Well", "Dice", "Deck", "Wheel"]);
    expect(rows(html)).toHaveLength(BOXES.length);
    for (const tr of rows(html)) expect(tr).toContain('class="lc-kind"');
  });

  it("captions every cell with its column, in the header's order, under the table's roles", () => {
    expect(html).toMatch(/^<table class="lc-table lc-table--stack lc-table--boxes" role="table"><thead role="rowgroup"><tr role="row">/);
    expect([...html.matchAll(/<th role="columnheader">([^<]*)<\/th>/g)].map(m => m[1])).toEqual(BOXES_COLUMNS);
    for (const tr of rows(html)) {
      expect(tr).toMatch(/^<tr( class="[^"]*")? role="row">/);
      expect([...tr.matchAll(/<td role="cell" data-label="([^"]*)"/g)].map(m => m[1])).toEqual(BOXES_COLUMNS);
    }
  });

  it("keeps the buttons in the last, uncaptioned cell: Edit, Copy, Delete after any extra", () => {
    for (const tr of rows(html)) {
      const last = tr.slice(tr.lastIndexOf('<td role="cell" data-label=""'));
      const actions = [...last.matchAll(/data-action="([^"]+)"/g)].map(m => m[1]);
      expect(actions.slice(-3)).toEqual(["editBox", "copyBox", "deleteBox"]);
    }
    expect(html).toContain('data-action="reshuffle"');
    expect(html).toContain('data-action="openTable"');
  });

  it("escapes a name through the caller's escape, in the tag too", () => {
    const out = boxesTableHTML({ boxes: [{ id: "x", name: "<b>Sly</b>", price: 1, pools: [], weights: {}, rules: {} }], pools: {}, esc });
    expect(out).toContain("&lt;b&gt;Sly&lt;/b&gt;");
    expect(out).not.toContain("<b>Sly</b>");
    expect(out).toContain('aria-label="Edit &lt;b&gt;Sly&lt;/b&gt;"');
  });

  it("marks the row a New just added", () => {
    const out = boxesTableHTML({ boxes: BOXES, pools: POOLS, recent: "royal", esc });
    expect((out.match(/class="lc-row--new"/g) ?? []).length).toBe(1);
    expect(out).toMatch(/<tr class="lc-row--new" role="row">\s*<td role="cell" data-label="Box">Royal Vault/);
  });

  it("says so when there are no boxes", () => {
    expect(boxesTableHTML({ boxes: [], pools: {}, esc })).toContain("No boxes.");
  });
});

describe("the tab", () => {
  it("is the toolbar with every New and the status line, then the table", () => {
    const html = boxesTabHTML({ boxes: BOXES, pools: POOLS, status: "Royal Vault is on the shelf at 1,200 gp.", esc });
    expect(html).toMatch(/^<div class="lc-toolbar lc-toolbar--boxes">/);
    for (const [action, label] of NEW_BUTTONS) expect(html).toContain(`data-action="${action}"><i class="fas fa-plus"></i> ${label}</button>`);
    expect(html).toContain('<span class="lc-pool__hint lc-manager__status" role="status">Royal Vault is on the shelf at 1,200 gp.</span>');
    expect(html).toContain('<table class="lc-table lc-table--stack lc-table--boxes"');
  });
});

describe("the shared table pieces", () => {
  it("caption a cell with its column and carry extra attributes", () => {
    expect(cell("Got", "Rope")).toBe('<td role="cell" data-label="Got">Rope</td>');
    expect(cell("Got", "Rope", 'class="lc-rarity-rare"')).toBe('<td role="cell" data-label="Got" class="lc-rarity-rare">Rope</td>');
    expect(cell("", "<button></button>")).toBe('<td role="cell" data-label=""><button></button></td>');
  });

  it("build a table that stacks, from its columns and rows", () => {
    const html = tableHTML("lc-table--log", ["When", ""], '<tr role="row"><td role="cell" data-label="When">now</td><td role="cell" data-label=""></td></tr>');
    expect(html).toMatch(/^<table class="lc-table lc-table--stack lc-table--log" role="table"><thead role="rowgroup"><tr role="row"><th role="columnheader">When<\/th><th role="columnheader"><\/th><\/tr><\/thead><tbody role="rowgroup">/);
    expect(html).toMatch(/<\/tbody><\/table>$/);
  });
});
