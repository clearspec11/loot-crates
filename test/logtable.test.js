/*
  The Pull log's table (logtable.js) is pure: the harness draws it on the
  sample log and the manager on the world's. Every cell is captioned with
  its column under the table's roles, so a narrow pane can stack a row as
  a card (module.css) and a screen reader still reads a table; a round's
  stakes fold under its line, a well's misses into one, and the notes
  under a row read through the caller's escape.
*/
import { describe, it, expect } from "vitest";
import { logTableHTML, logRarityNote, logPayoutNote, logStakeNote, logLateNote, LOG_COLUMNS } from "../module/scripts/views/logtable.js";
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

  it("reads each row's story: refunded, pity with its source, the late sale, the faces and payout, the bane, a lost stake", () => {
    expect(html).toContain('<tr class="lc-row--refunded" role="row">');
    expect(html).toContain("<s>Staff of Power</s>");
    expect(html).toContain("Cloak of Elvenkind · pity<small class=\"lc-log__rarity\">Rare, set by GM (source Uncommon)</small>");
    expect(html).toContain('<tr class="lc-row--late" role="row">');
    expect(html).toContain("Called off by the buyer after the charge.");
    expect(html).toContain("Rolled 4, 6, 5 · won 30 gp");
    expect(html).toContain('class="lc-rarity-bane"');
    expect(html).toContain("Loss card · took 20 gp");
    expect(html).toContain("Lost at the spin.");
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

  it("says so when there are no pulls, or only misses hidden", () => {
    expect(logTableHTML({ log: [], esc })).toBe('<p class="lc-empty">No pulls yet.</p>');
    const miss = { id: "n", at: NOW, kind: "well", outcome: "nothing", boxId: "w", boxName: "Well", actorId: "a", actorName: "A", day: "d", price: 0.1, name: "Nothing" };
    expect(logTableHTML({ log: [miss], hideMisses: true, esc })).toContain("Only misses so far; show them with the button above.");
  });
});
