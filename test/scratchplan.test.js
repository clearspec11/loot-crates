/*
  Fill the prize list (scratchplan.js): the prize structure built from a
  few numbers, held to every rule it promises across seeded rolls of 20 to
  500 tickets at 1 to 25 gp, both layouts and several grids: about one
  ticket in winEvery wins, the coins paid come within a few percent of the
  payback, the lowest prize is the price and the most common, the prizes
  climb in steps with fewer of each, the top prize once (or as many as
  asked), combinations by the setting and adding up to their prize, every
  line one the card shows (the roll keeps them all), never more prizes
  than tickets, and the same rng gives the same list. Then the readout's
  payback, and the Fill fields on a minimal DOM: Fill, Shuffle, the
  confirm before replacing the GM's own rows, and the words.
*/
import { describe, it, expect } from "vitest";
import { createDocument } from "./minidom.js";

const { generatePrizeLines, solveCounts, fillFrom, fillFieldsHTML, wireFill, FILL_DEFAULTS } = await import("../module/scripts/games/scratchplan.js");
const { lineOf, lineMisfit, prizesOf, keyOf, bonusOf, rollOf, paybackOf, paybackText, scratchFieldsHTML, wireScratchEditor, scratchPreview, scratchPreviewHTML, scratchSummary, draftScratch, MAX_PRIZES, MAX_PARTS } = await import("../module/scripts/games/scratch.js");
const { ITEM_VALUE, RARITIES } = await import("../module/scripts/core/config.js");
const { seededRng } = await import("../module/scripts/core/odds.js");
const { NEW_DEFAULTS } = await import("../module/scripts/views/newgame.js");

const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// What a line is worth: coins at face, the gem at the bonus spot's, an item at its nominal value.
const worth = (line, gem) => line.parts.reduce((n, p) => n + (p.gp ?? 0) + (p.bonus ? gem : 0) + (p.item ? ITEM_VALUE[p.item.rarity] : 0), 0);
const coins = (line, gem) => line.parts.reduce((n, p) => n + (p.gp ?? 0) + (p.bonus ? gem : 0), 0);

const GRIDS = { lucky: [{ cols: 4, rows: 3 }, { cols: 3, rows: 1 }, { cols: 6, rows: 5 }], match3: [{ cols: 3, rows: 2 }, { cols: 2, rows: 2 }, { cols: 5, rows: 4 }] };

// Every rule, for one generated list.
function holdsEveryRule(lines, o) {
  const gem = o.bonus?.gp ?? 0;
  const game = { layout: o.layout, grid: o.grid, bonus: { on: gem > 0, gp: gem }, price: o.price, roll: { size: o.size, prizes: lines } };
  const wins = lines.reduce((n, l) => n + l.count, 0);
  // About one in winEvery wins; never more prizes than tickets.
  expect(wins).toBe(Math.round(o.size / (o.winEvery ?? FILL_DEFAULTS.winEvery)));
  expect(wins).toBeLessThanOrEqual(o.size);
  // The coins paid come within a few percent of the payback.
  const target = (o.payback ?? FILL_DEFAULTS.payback) * o.size * o.price;
  const paid = lines.reduce((n, l) => n + l.count * coins(l, gem), 0);
  expect(Math.abs(paid - target) / target).toBeLessThanOrEqual(0.05);
  // Worth climbs in steps of at least half again; counts fall as it climbs.
  const byWorth = [...lines].sort((a, b) => worth(a, gem) - worth(b, gem));
  for (let i = 1; i < byWorth.length; i++) {
    expect(worth(byWorth[i], gem)).toBeGreaterThanOrEqual(worth(byWorth[i - 1], gem) * 1.5 - 1e-9);
    expect(byWorth[i].count).toBeLessThanOrEqual(byWorth[i - 1].count);
  }
  // The lowest gives the price back and is the most common.
  expect(byWorth[0].parts).toEqual([{ gp: o.price }]);
  if (byWorth.length > 2) expect(byWorth[0].count).toBeGreaterThan(byWorth[1].count);
  // The top prize, once (or as many as asked), and it is what the GM asked for.
  const top = byWorth[byWorth.length - 1];
  expect(top.count).toBe(o.top?.count ?? 1);
  expect(lines[0]).toBe(top);
  if (o.top?.item) expect(top.parts).toEqual([{ item: { rarity: o.top.item.rarity } }]);
  if (o.top?.gp) expect(top.parts).toEqual([{ gp: o.top.gp }]);
  // Combinations: smaller parts adding up to a middle prize, from what the card can pay.
  for (const l of lines.filter(x => x.parts.length > 1)) {
    expect(l).not.toBe(top);
    expect(l.parts.length).toBeLessThanOrEqual(MAX_PARTS);
    for (const p of l.parts) {
      expect(worth({ parts: [p] }, gem)).toBeLessThan(worth(l, gem));
      if (p.item) expect(o.items ?? []).toContain(p.item.rarity);
      if (p.bonus) expect(o.layout).toBe("lucky");
    }
  }
  if (o.combos === "none") expect(lines.every(l => l.parts.length === 1)).toBe(true);
  // Every line is one the card can show, and the roll prints them all as written.
  for (const l of lines) {
    const line = lineOf(l, bonusOf(game));
    expect(line).not.toBeNull();
    expect(lineMisfit(line, game)).toBe("");
  }
  const kept = prizesOf(game);
  expect(kept).toHaveLength(lines.length);
  expect(kept.reduce((n, p) => n + p.count, 0)).toBe(wins);
  expect(lines.length).toBeLessThanOrEqual(MAX_PRIZES);
  if (o.layout === "match3") expect(keyOf(kept).length).toBe(new Set(kept.flatMap(p => p.parts.map(q => q.key))).size);
  return { wins, paid, target };
}

describe("generatePrizeLines: every rule, seeded", () => {
  it("rolls of 20 to 500 tickets at 1 to 25 gp, both layouts, several grids, each combinations setting, top prizes of an item, coins or worked out", () => {
    let runs = 0;
    const combosSeen = { some: 0, lots: 0 };
    for (const size of [20, 37, 100, 250, 500]) for (const price of [1, 2, 5, 10, 25]) for (const layout of ["lucky", "match3"]) for (const [g, grid] of GRIDS[layout].entries()) {
      const combos = ["none", "some", "lots"][(size + price + g) % 3];
      const tops = [null, { item: { rarity: "rare" } }, ...(size >= 100 ? [{ gp: 25 * price }] : [])];
      for (const top of tops) for (const seed of [1, 2]) {
        const o = { size, price, layout, grid, combos, top, bonus: layout === "lucky" && g !== 1 ? { gp: 5 * price } : null, items: ["common", "uncommon"], rng: seededRng(seed * 1000 + size + price) };
        const lines = generatePrizeLines(o);
        holdsEveryRule(lines, o);
        if (combos !== "none" && lines.some(l => l.parts.length > 1)) combosSeen[combos]++;
        runs++;
      }
    }
    expect(runs).toBeGreaterThan(300);
    // "Some" and "lots" do make combinations where the card has room.
    expect(combosSeen.some).toBeGreaterThan(20);
    expect(combosSeen.lots).toBeGreaterThan(20);
  });

  it("the payback and the win rate the GM asks for, and a top prize printed more than once", () => {
    for (const [payback, winEvery] of [[0.5, 3], [0.7, 4], [0.6, 5], [0.9, 2.5]]) for (const seed of [3, 4, 5]) {
      const o = { size: 200, price: 5, payback, winEvery, layout: "lucky", grid: { cols: 4, rows: 3 }, combos: "some", top: null, bonus: { gp: 25 }, rng: seededRng(seed) };
      holdsEveryRule(generatePrizeLines(o), o);
    }
    const o = { size: 300, price: 2, layout: "lucky", grid: { cols: 4, rows: 3 }, combos: "lots", top: { gp: 40, count: 3 }, rng: seededRng(9) };
    const lines = generatePrizeLines(o);
    holdsEveryRule(lines, o);
    expect(lines.filter(l => l.count < 3)).toEqual([]);
  });

  it("the live check's ticket: 100 tickets at 5 gp with a rare item on top wins about 1 in 3.5 and pays back about 65% in coins", () => {
    const o = { size: 100, price: 5, layout: "lucky", grid: { cols: 4, rows: 3 }, combos: "some", top: { item: { rarity: "rare" } }, bonus: { gp: 25 }, items: ["uncommon", "rare"], rng: seededRng(11) };
    const lines = generatePrizeLines(o);
    holdsEveryRule(lines, o);
    const game = { ...NEW_DEFAULTS.scratch(), roll: { id: 1, size: 100, prizes: lines } };
    const pb = paybackOf(game);
    expect(Math.abs(pb.pct - 65)).toBeLessThanOrEqual(3);
    expect(pb.items).toBeGreaterThanOrEqual(1);
    expect(scratchPreview(game, {}).odds.oneIn).toMatch(/^3\.[3-7]$/);
  });

  it("is the same list for the same rng, and Shuffle's fresh draws give others", () => {
    const o = { size: 100, price: 5, layout: "lucky", grid: { cols: 4, rows: 3 }, combos: "some", bonus: { gp: 25 } };
    expect(generatePrizeLines({ ...o, rng: seededRng(5) })).toEqual(generatePrizeLines({ ...o, rng: seededRng(5) }));
    const lists = new Set([1, 2, 3, 4, 5, 6].map(seed => JSON.stringify(generatePrizeLines({ ...o, rng: seededRng(seed) }))));
    expect(lists.size).toBeGreaterThanOrEqual(4);
  });

  it("builds nothing with no price or no tickets, and never more prizes than tickets on a tiny roll", () => {
    expect(generatePrizeLines({ size: 100, price: 0, rng: seededRng(1) })).toEqual([]);
    expect(generatePrizeLines({ size: 0, price: 5, rng: seededRng(1) })).toEqual([]);
    for (const size of [1, 2, 3, 5]) {
      const lines = generatePrizeLines({ size, price: 5, winEvery: 1, rng: seededRng(size) });
      expect(lines.reduce((n, l) => n + l.count, 0)).toBeLessThanOrEqual(size);
      expect(lines.length).toBeGreaterThan(0);
    }
  });

  it("solveCounts: falling counts adding up to the wins, the coins as near the budget as the sizes allow", () => {
    expect(solveCounts([25, 50, 75, 150], 5, 325, 1)).toEqual([2, 1, 1, 1]);
    const c = solveCounts([5, 10, 25, 50, 100], 28, 325, 1);
    expect(c.reduce((a, b) => a + b, 0)).toBe(28);
    expect(c.every((n, i) => i === 0 || n <= c[i - 1])).toBe(true);
    expect(c[0]).toBeGreaterThan(c[1]);
    expect(Math.abs(c.reduce((n, x, i) => n + x * [5, 10, 25, 50, 100][i], 0) - 325)).toBeLessThanOrEqual(5);
    expect(solveCounts([5, 10], 1, 10, 1)).toBeNull();
  });

  it("items are valued at the low end of the DMG's price bands, and every rarity has one", () => {
    expect(ITEM_VALUE).toEqual({ common: 50, uncommon: 100, rare: 500, veryRare: 5000, legendary: 50000, artifact: 50000 });
    expect(Object.keys(ITEM_VALUE)).toEqual(RARITIES);
  });
});

describe("what the roll pays back", () => {
  it("the readout says the coins paid back of the coins taken in, and the items apart", () => {
    const game = NEW_DEFAULTS.scratch();
    // The mockup's ticket: 620 gp of prizes (the gem's 75 among them) on 100 tickets at 5 gp.
    expect(paybackOf(game)).toEqual({ pct: 124, paid: 620, taken: 500, items: 1 });
    expect(paybackText(paybackOf(game))).toBe("Pays back 124% in coins: 620 gp of the 500 gp the roll takes in, plus 1 item");
    const html = scratchPreviewHTML(scratchPreview(game, {}), esc);
    expect(html).toContain(`<p class="lc-scratch-form__payback">Pays back 124% in coins: 620 gp of the 500 gp the roll takes in, plus 1 item</p>`);
    expect(scratchSummary(scratchPreview(game, {}))).toContain("Pays back 124% in coins");
    const coinsOnly = { ...game, roll: { id: 1, size: 10, prizes: [{ count: 2, parts: [{ gp: 5 }] }, { count: 1, parts: [{ gp: 10 }] }] } };
    expect(paybackText(paybackOf(coinsOnly))).toBe("Pays back 40% in coins: 20 gp of the 50 gp the roll takes in");
    const twoItems = { ...game, roll: { id: 1, size: 10, prizes: [{ count: 2, parts: [{ item: { rarity: "rare" } }] }] } };
    expect(paybackText(paybackOf(twoItems))).toBe("Pays back 0% in coins: 0 gp of the 50 gp the roll takes in, plus 2 items");
    // Free tickets take nothing in: no payback line.
    expect(paybackOf({ ...game, price: 0 })).toBeNull();
    expect(scratchPreviewHTML(scratchPreview({ ...game, price: 0 }, {}), esc)).not.toContain("Pays back");
  });
});

/* ---------- The Fill fields on a minimal DOM ---------- */

const POOLS = { p: { id: "p", name: "Hoard", pools: [], entries: [{ uuid: "Item.a", name: "Lucky Coin", img: "", rarity: "uncommon", weight: 1 }, { uuid: "Item.b", name: "Flame Tongue", img: "", rarity: "rare", weight: 1 }] } };

function editor(game = { ...NEW_DEFAULTS.scratch(), id: "t", pools: [{ id: "p", share: 1 }] }, { answer = true, seed = 3 } = {}) {
  const doc = createDocument();
  const form = doc.createElement("form");
  doc.body.appendChild(form);
  form.innerHTML = `<input name="name" value="Fortune"><input name="price" value="5 gp">${scratchFieldsHTML(game, { esc, fill: fillFieldsHTML(game, { esc }) })}<div class="lc-form__preview"></div>`;
  // The form's values as readForm reads them (a radio when checked, repeats as a list).
  const read = () => {
    const out = {};
    for (const el of [...form.querySelectorAll("input"), ...form.querySelectorAll("select")]) {
      if (!el.name || (el.getAttribute("type") === "radio" && !el.checked)) continue;
      const v = el.getAttribute("type") === "checkbox" ? el.checked : el.value;
      out[el.name] = el.name in out ? [].concat(out[el.name], v) : v;
    }
    return out;
  };
  const paint = () => { form.querySelector(".lc-form__preview").innerHTML = scratchPreviewHTML(scratchPreview(draftScratch(game, read(), ["p"]), POOLS), esc); };
  let n = 0;
  const asked = [];
  wireScratchEditor(form, { newId: () => `n${++n}`, paint });
  wireFill(form, { read, items: () => ["uncommon", "rare"], newId: () => `n${++n}`, confirm: async text => { asked.push(text); return answer; }, rng: seededRng(seed) });
  paint();
  const q = s => form.querySelector(s);
  const click = async s => { q(s).dispatchEvent({ type: "click" }); for (let i = 0; i < 3; i++) await Promise.resolve(); };
  const rows = () => form.querySelectorAll(".lc-prize-row");
  const values = () => rows().map(r => [r.querySelector(".lc-prize-row__count").value, ...r.querySelectorAll(".lc-prize-part").map(p => `${p.querySelector(".lc-prize-row__what").value}:${p.querySelector(".lc-prize-row__gp").value}`)].join(" "));
  return { doc, form, q, click, rows, values, asked, read, game };
}

describe("the Fill fields", () => {
  it("are closed until the toggle opens them, with the defaults, the top prize the roll's own, and Shuffle off until a Fill", async () => {
    const ed = editor();
    const toggle = ed.q(".lc-fill__toggle");
    expect(toggle.textContent.trim()).toBe("Fill the prize list");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("lc-fill-t");
    expect(ed.q(".lc-fill__body").hasAttribute("hidden")).toBe(true);
    await ed.click(".lc-fill__toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(ed.q(".lc-fill__body").hidden).toBe(false);
    expect(ed.doc.activeElement).toBe(ed.q('input[name="fillPayback"]'));
    expect(ed.q('input[name="fillPayback"]').value).toBe("65");
    expect(ed.q('input[name="fillWinEvery"]').value).toBe("3.5");
    expect(ed.q('select[name="fillTop"]').value).toBe("item.rare");
    expect(ed.q('input[name="fillCombos"][value="some"]').checked).toBe(true);
    expect(ed.q(".lc-fill__body").textContent).toContain("Pays back");
    expect(ed.q(".lc-fill__body").textContent).toContain("Wins about 1 in");
    expect(ed.q(".lc-fill__combos").getAttribute("role")).toBe("radiogroup");
    expect(ed.q(".lc-fill__shuffle").getAttribute("aria-disabled")).toBe("true");
    expect(ed.q(".lc-fill__shuffle").getAttribute("title")).toBe("Fill the list first");
    // Coins as the top prize shows its gold field.
    const top = ed.q('select[name="fillTop"]');
    top.value = "gp";
    ed.q(".lc-fill").dispatchEvent({ type: "change", target: top });
    expect(ed.q(".lc-fill__gp").hidden).toBe(false);
    expect(ed.doc.activeElement).toBe(ed.q('input[name="fillTopGp"]'));
  });

  it("Fill asks before replacing the GM's rows, writes the list into them, and the readout and the status say what it pays back; nothing else changes", async () => {
    const ed = editor();
    const before = ed.values();
    await ed.click(".lc-fill__fill");
    expect(ed.asked).toEqual(["Replace the 6 prizes in the list with a new list?"]);
    const filled = ed.values();
    expect(filled).not.toEqual(before);
    // The rows hold what the generator gives for these fields, numbered and named.
    const draft = draftScratch(ed.game, ed.read(), ["p"]);
    holdsEveryRule(draft.roll.prizes, { ...fillFrom(ed.read()), items: ["uncommon", "rare"], payback: 0.65, winEvery: 3.5, combos: "some" });
    expect(ed.rows().map(r => r.querySelector(".lc-prize-row__count").getAttribute("aria-label"))).toEqual(ed.rows().map((_, i) => `Tickets that win prize ${i + 1}`));
    expect(draft.roll.prizes[0].parts).toEqual([{ item: { rarity: "rare" } }]);
    const pb = paybackOf(draft);
    expect(Math.abs(pb.pct - 65)).toBeLessThanOrEqual(3);
    expect(ed.q(".lc-scratch-form__payback").textContent).toBe(paybackText(pb));
    expect(ed.q(".lc-scratch-form__readout").textContent).toMatch(/^1 in 3\.\d tickets wins, the top prize \(Rare item\) 1 in 100/);
    expect(ed.q(".lc-fill__said").getAttribute("role")).toBe("status");
    expect(ed.q(".lc-fill__said").textContent).toBe(`${ed.rows().length} prizes filled in. ${paybackText(pb)}. Nothing is saved until you press Save.`);
    // The card's own fields are as they were.
    expect([ed.q('input[name="size"]').value, ed.q('input[name="cols"]').value, ed.q('input[name="price"]').value].map(String)).toEqual(["100", "4", "5 gp"]);
    expect(ed.q(".lc-fill__shuffle").hasAttribute("aria-disabled")).toBe(false);
  });

  it("Shuffle draws a different list with the same fields and doesn't ask again for rows Fill wrote; an edited row is the GM's, so it asks", async () => {
    const ed = editor();
    await ed.click(".lc-fill__fill");
    const first = ed.values();
    await ed.click(".lc-fill__shuffle");
    expect(ed.asked).toHaveLength(1);
    const second = ed.values();
    expect(second).not.toEqual(first);
    expect(ed.q(".lc-fill__said").textContent).toMatch(/^Shuffled: \d prizes? new|^Shuffled: \d+ new prizes\./);
    const draft = draftScratch(ed.game, ed.read(), ["p"]);
    holdsEveryRule(draft.roll.prizes, { ...fillFrom(ed.read()), items: ["uncommon", "rare"], payback: 0.65, winEvery: 3.5, combos: "some" });
    // The GM edits a row: the next Fill asks first.
    ed.rows()[0].querySelector(".lc-prize-row__count").value = "2";
    await ed.click(".lc-fill__shuffle");
    expect(ed.asked).toHaveLength(2);
  });

  it("a No keeps the GM's rows as they were and says so; no price fills nothing", async () => {
    const ed = editor(undefined, { answer: false });
    const before = ed.values();
    await ed.click(".lc-fill__fill");
    expect(ed.values()).toEqual(before);
    expect(ed.q(".lc-fill__said").textContent).toBe("The prize list is as it was.");
    expect(ed.q(".lc-fill__shuffle").getAttribute("aria-disabled")).toBe("true");
    ed.q('input[name="price"]').value = "";
    await ed.click(".lc-fill__fill");
    expect(ed.q(".lc-fill__said").textContent).toBe("Set the price of a ticket first.");
    expect(ed.values()).toEqual(before);
  });

  it("an empty list fills without asking, and the fields' settings follow the form: match 3, no combinations, coins on top", async () => {
    const game = { ...NEW_DEFAULTS.scratch(), id: "e", roll: { id: 1, size: 60, prizes: [] }, layout: "match3", grid: { cols: 3, rows: 2 }, bonus: { on: false, gp: 0 } };
    const ed = editor(game);
    ed.q('select[name="fillTop"]').value = "gp";
    ed.q('input[name="fillTopGp"]').value = "50";
    ed.q('input[name="fillCombos"][value="some"]').checked = false;
    ed.q('input[name="fillCombos"][value="none"]').checked = true;
    ed.q('input[name="fillPayback"]').value = "70";
    ed.q('input[name="fillWinEvery"]').value = "4";
    expect(fillFrom(ed.read())).toMatchObject({ price: 5, size: 60, payback: 0.7, winEvery: 4, top: { gp: 50 }, combos: "none", layout: "match3", bonus: null });
    await ed.click(".lc-fill__fill");
    expect(ed.asked).toEqual([]);
    const draft = draftScratch(game, ed.read(), ["p"]);
    holdsEveryRule(draft.roll.prizes, { ...fillFrom(ed.read()) });
    expect(scratchPreview(draft, POOLS).refused).toBe(false);
    expect(rollOf(draft).prizes).toHaveLength(draft.roll.prizes.length);
  });
});
