/*
  The Pull log's table (logtable.js) is pure: the harness draws it on the
  sample log and the manager on the world's. Every cell is captioned with
  its column under the table's roles, so a narrow pane can stack a row as
  a card (module.css) and a screen reader still reads a table; a round's
  stakes fold under its line, a well's misses into one, and the notes
  under a row read through the caller's escape.
*/
import { describe, it, expect } from "vitest";
import { logTableHTML, logRarityNote, logPayoutNote, logStakeNote, logLateNote, LOG_COLUMNS, logFilterOptions, activeLogFilter, filterLog } from "../module/scripts/views/logtable.js";
import { sampleLog, rouletteRound } from "../harness/sample.js";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const rows = html => [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => m[0]).filter(tr => !tr.includes("<th"));
const NOW = Date.UTC(2026, 9, 23, 12, 0);
const rounds = { R1: rouletteRound(NOW - 400000, { status: "resolved", closesAt: NOW - 380000 }) };

describe("the Pull log table", () => {
  const html = logTableHTML({ log: sampleLog(NOW), rounds, esc });

  it("captions every cell with its column, in the header's order, under the table's roles", () => {
    expect(html).toContain('<table class="lc-table lc-table--stack lc-table--log" role="table"><thead role="rowgroup"><tr role="row">');
    expect([...html.matchAll(/<th role="columnheader">(.*?)<\/th>/g)].map(m => m[1])).toEqual([...LOG_COLUMNS.slice(0, -1), '<span class="lc-sr-only">Actions</span>']);
    expect(rows(html)).toHaveLength(13);
    for (const tr of rows(html)) {
      expect(tr).toMatch(/^<tr class="[^"]*" role="row">/);
      expect([...tr.matchAll(/<td role="cell" data-label="([^"]*)"/g)].map(m => m[1])).toEqual(LOG_COLUMNS);
    }
  });

  it("folds the round's stakes under its line and the well's misses into one, newest first", () => {
    const got = rows(html).map(tr => tr.match(/data-label="Got"[^>]*><span class="lc-dot"><\/span>(?:<s>)?([^<]*)/)[1]);
    expect(got).toEqual(["Staff of Power", "Cloak of Elvenkind · pity", "Club", "Beat the dragon", "The Flames", "5 stakes, settled", "Abjuration black", "Even", "Rare", "7", "Evocation red", "5 throws, nothing", "Rope"]);
    expect(html).toContain('<td role="cell" data-label="Who">Round</td><td role="cell" data-label="Game">Wheel of Fate (45 gp staked)</td>');
    expect(html).toContain("Hide misses");
    expect(html).toContain("5 throws that gave nothing, folded by day");
    expect(html).toContain('aria-label="Refund one of 5 throws">Refund one</button>');
  });

  it("reads each row's story: refunded, pity with its source, an item given away, the late sale, the faces and payout, the bane, a lost stake", () => {
    expect(html).toContain('<tr class="lc-row--refunded" role="row">');
    expect(html).toContain("<s>Staff of Power</s>");
    expect(html).toContain("Cloak of Elvenkind · pity<small class=\"lc-log__rarity\">Rare, set by GM (source Uncommon)</small>");
    expect(html).toContain('<tr class="lc-row--late" role="row">');
    expect(html).toContain("Called off by the buyer after the charge.");
    expect(html).toContain("Rolled 4, 6, 5 · won 30 gp");
    expect(html).toContain('class="lc-rarity-bane"');
    expect(html).toContain("Loss card · took 20 gp");
    expect(html).toContain("Lost at the spin.");
    // Given to Orla after the reveal (core/afterplay.js).
    expect(html).toContain('Rare, set by GM (source Uncommon)</small><small class="lc-log__parted">Tam Thornwick gave it to Orla Vane.</small>');
    expect((html.match(/data-action="refund"/g) ?? []).length).toBe(11);
  });

  it("hides the misses on request and says how many", () => {
    const hidden = logTableHTML({ log: sampleLog(NOW), rounds, hideMisses: true, esc });
    expect(rows(hidden)).toHaveLength(12);
    expect(hidden).toContain('aria-pressed="true">Hide misses</button>');
    expect(hidden).toContain("5 throws that gave nothing hidden");
  });

  it("escapes names and notes through the caller's escape", () => {
    const row = { id: "r", at: NOW, actorName: "<b>Sly</b>", boxName: "A&B", price: 1, name: "<i>Rope</i>", rarity: "rare", sourceRarity: ["uncommon"], faces: ["<"], payoutCp: 100 };
    const out = logTableHTML({ log: [row], esc });
    expect(out).toContain("&lt;b&gt;Sly&lt;/b&gt;");
    expect(out).toContain("A&amp;B");
    expect(out).toContain("&lt;i&gt;Rope&lt;/i&gt;");
    expect(out).toContain("Rolled &lt; · won 1 gp");
    expect(out).not.toContain("<b>");
    expect(logRarityNote({ rarity: "rare", sourceRarity: ["uncommon"] }, esc)).toContain("Rare, set by GM (source Uncommon)");
    expect(logPayoutNote({ faces: [1, 2], payoutCp: 0 })).toContain("Rolled 1, 2");
    expect(logStakeNote({ roundId: "R1", status: "open" })).toContain("Open: waiting on the spin.");
    expect(logLateNote({ lateCancel: 1 })).toContain("Called off by the buyer");
    expect(logLateNote({ lateCancel: 1, refunded: 1 })).toBe("");
  });

  it("folds a scratch ticket's duds as tickets, not pulls, and its Refund says ticket", () => {
    const dud = (id, at) => ({ id, at, kind: "scratch", outcome: "nothing", boxId: "s", boxName: "Fortune Ticket", actorId: "a", actorName: "Brinn", day: "d", price: 5, name: "Dud" });
    const out = logTableHTML({ log: [dud("t1", NOW), dud("t2", NOW - 1000)], esc });
    expect(out).toContain("2 tickets, nothing");
    expect(out).not.toContain("pulls, nothing");
    expect(out).toContain('aria-label="Refund one of 2 tickets"');
    const one = logTableHTML({ log: [dud("t1", NOW)], esc });
    expect(one).toContain("1 ticket, nothing");
    expect(one).toContain('aria-label="Refund the ticket"');
  });

  it("says so when there are no pulls, or only misses hidden", () => {
    expect(logTableHTML({ log: [], esc })).toBe('<p class="lc-empty">No pulls yet.</p>');
    const miss = { id: "n", at: NOW, kind: "well", outcome: "nothing", boxId: "w", boxName: "Well", actorId: "a", actorName: "A", day: "d", price: 0.1, name: "Nothing" };
    expect(logTableHTML({ log: [miss], hideMisses: true, esc })).toContain("Only misses so far; show them with the button above.");
  });
});

describe("the Pull log's Character and Game pickers", () => {
  const log = sampleLog(NOW);
  const who = html => rows(html).map(tr => tr.match(/data-label="Who">([^<]*)</)[1]);

  it("lists each character and game the log holds once, by name, and no character for a house bid", () => {
    const house = { id: "h1", kind: "auction", house: true, actorId: "house1", actorName: "House bidder 1", boxId: "lot", boxName: "The Lot", at: NOW };
    const { actors, boxes } = logFilterOptions([house, ...log]);
    expect(actors.map(a => a.name)).toEqual(["Bo Marrow", "Orla Vane", "Tam Thornwick"]);
    expect(boxes.map(b => b.name)).toEqual([...new Set([...log.map(r => r.boxName), "The Lot"])].sort((a, b) => a.localeCompare(b)));
  });

  it("names a character by its newest row, so a rename reads as it is now", () => {
    const { actors } = logFilterOptions([{ id: "a", actorId: "tam", actorName: "Tam the Bold", boxId: "x", boxName: "X" }, { id: "b", actorId: "tam", actorName: "Tam Thornwick", boxId: "x", boxName: "X" }]);
    expect(actors).toEqual([{ id: "tam", name: "Tam the Bold" }]);
  });

  it("shows nothing but the picks' rows, with every row while neither is set", () => {
    expect(filterLog(log, {})).toBe(log);
    expect(filterLog(log, { actor: "tam" }).every(r => r.actorId === "tam")).toBe(true);
    expect(filterLog(log, { box: "royal" }).map(r => r.id)).toEqual(["p1"]);
    expect(filterLog(log, { actor: "tam", box: "royal" })).toEqual([]);
  });

  it("drops a pick the log no longer holds rather than showing an empty log", () => {
    expect(activeLogFilter(log, { actor: "gone", box: "royal" })).toEqual({ actor: "", box: "royal" });
    const html = logTableHTML({ log, rounds, filter: { actor: "gone" }, esc });
    expect(rows(html)).toHaveLength(13);
    expect(html).not.toContain("clearLogFilter");
  });

  it("draws one character's log: her rows, the round counting only her stakes, the count and Show all", () => {
    const html = logTableHTML({ log, rounds, filter: { actor: "tam" }, esc });
    expect(who(html)).toEqual(["Tam Thornwick", "Tam Thornwick", "Round", "Tam Thornwick", "Tam Thornwick", "Tam Thornwick", "Tam Thornwick"]);
    expect(html).toContain("2 stakes, settled");
    expect(html).toContain('<option value="tam" selected>Tam Thornwick</option>');
    expect(html).toContain(`<span class="lc-log__count" role="status">Showing ${filterLog(log, { actor: "tam" }).length} of ${log.length} rows</span><button type="button" data-action="clearLogFilter">Show all</button>`);
  });

  it("says when a character never played that game, keeping the pickers to change it", () => {
    const html = logTableHTML({ log, rounds, filter: { actor: "tam", box: "royal" }, esc });
    expect(rows(html)).toHaveLength(0);
    expect(html).toContain("Nothing in the log for that character at that game.");
    expect(html).toContain('data-log-filter="actor"');
    expect(html).toContain("Show all");
  });

  it("has no pickers for a log of one character at one game", () => {
    const one = { id: "x", kind: "crate", boxId: "b", boxName: "Box", actorId: "a", actorName: "A", at: NOW, price: 1, name: "Rope" };
    expect(logTableHTML({ log: [one, { ...one, id: "y" }], esc })).not.toContain("data-log-filter");
    expect(logTableHTML({ log: [one, { ...one, id: "y", boxId: "c", boxName: "Other" }], esc })).toContain('data-log-filter="box"');
  });

  it("escapes the names it lists", () => {
    const row = { id: "x", kind: "crate", boxId: "b", boxName: "<b>Box</b>", actorId: "a", actorName: "A & B", at: NOW, price: 1, name: "Rope" };
    const html = logTableHTML({ log: [row, { ...row, id: "y", actorId: "c", actorName: "C" }], esc });
    expect(html).toContain("<option value=\"a\">A &amp; B</option>");
    expect(html).toContain("&lt;b&gt;Box&lt;/b&gt;");
  });
});
