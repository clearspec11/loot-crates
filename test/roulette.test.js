/*
  Roulette, pure (roulette.js): the odds per bet type from the pockets sum
  to 100 with no 0%; resolve() for every bet type on every pocket; the
  multipliers and the item on a rarity band; the stake's bounds and the
  bets a character gets; Foundry's Roll with allowInteractive false; the
  wheel's pose and landing; the words, the card, the chips and the shared
  table window's body (tableview.js).
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDocument } from "./minidom.js";

vi.mock("../module/scripts/sound.js", () => ({ playTick: vi.fn(), playSlow: vi.fn(), playReveal: vi.fn(), playPlop: vi.fn(), playPlink: vi.fn(), playCoinBack: vi.fn(), playBane: vi.fn(), playDrop: vi.fn() }));

const R = await import("../module/scripts/roulette.js");
const { ROULETTE, ROULETTE_DEFAULTS, BET_TYPES, pocketsOf, coloursOf, optionsOf, betOdds, resolve, betWins, normalizeBet, betName, stakeCheck, readBet, pickOptions, betFields, verdictText, netByActor, netText, netLines, wheelPose, pocketUnder, mountWheel, railHTML, roundState, clockText, drawOfRarity, draftRoulette, rouletteRulesText, roulettePreview, betLines, wheelSVG } = R;
const { tableBodyHTML, phaseOf, stateText, countText, stakeSentence } = await import("../module/scripts/tableview.js");
const { PullError } = await import("../module/scripts/kinds.js");
const { seededRng } = await import("../module/scripts/odds.js");

const GAME = { id: "wheel", kind: "roulette", name: "Live wheel", price: 5, pools: [{ id: "p", share: 1 }], weights: {}, roulette: { colours: ["Red", "Black"], pockets: ROULETTE_DEFAULTS.pockets, payouts: { colour: 2, parity: 2, number: 12, rarity: 3 }, itemOnRarity: true, maxStake: 50, maxBets: 3, windowSec: 45 } };
const POOLS = { p: { id: "p", name: "P", pools: [], entries: [{ uuid: "Item.rare1", name: "Rare Wand", img: "w.webp", rarity: "rare", weight: 1 }, { uuid: "Item.common1", name: "Dull Rope", img: "r.webp", rarity: "common", weight: 1 }] } };
const pct = label => Number(label.replace("%", ""));

describe("the odds per bet type", () => {
  it("come from the pockets, sum to 100 and never read 0%", () => {
    const odds = betOdds(GAME);
    expect(odds.pockets).toBe(12);
    for (const type of BET_TYPES) {
      const rows = odds[type];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.reduce((n, r) => n + pct(r.label), 0)).toBe(100);
      expect(rows.every(r => r.count > 0 && !/^0%/.test(r.label))).toBe(true);
      expect(Math.abs(rows.reduce((n, r) => n + r.chance, 0) - 1)).toBeLessThan(1e-9);
    }
    expect(odds.colour.map(r => `${r.name} ${r.label}`)).toEqual(["Red 50%", "Black 50%"]);
    expect(odds.rarity.map(r => `${r.name} ${r.label}`)).toEqual(["Common 42%", "Uncommon 33%", "Rare 17%", "Legendary 8%"]);
    expect(odds.number).toHaveLength(12);
    expect(odds.number[0].fraction).toBe("1 in 12");
    expect(odds.payouts).toEqual({ colour: 2, parity: 2, number: 12, rarity: 3 });
  });

  it("leaves out an option no pocket holds", () => {
    const one = { ...GAME, roulette: { ...GAME.roulette, pockets: [{ colour: 0, rarity: "rare" }, { colour: 0, rarity: "rare" }, { colour: 0, rarity: "legendary" }] } };
    const odds = betOdds(one);
    expect(odds.colour).toHaveLength(1);
    expect(odds.colour[0].label).toBe("100%");
    expect(odds.rarity.map(r => r.pick)).toEqual(["rare", "legendary"]);
    expect(odds.parity.map(r => `${r.name} ${r.label}`)).toEqual(["Odd 67%", "Even 33%"]);
    expect(optionsOf(one, "colour").some(o => o.pick === 1)).toBe(false);
    expect(normalizeBet(one, { type: "colour", pick: 1 })).toEqual({ type: "colour", pick: 1 });
    expect(normalizeBet(one, { type: "rarity", pick: "common" })).toBeNull();
  });

  it("names the bets in words for the card", () => {
    const lines = betLines(betOdds(GAME));
    expect(lines).toEqual(["Red or Black 1 in 2, pays 2×", "Odd or even 1 in 2, pays 2×", "One number 1 in 12, pays 12×", "A rarity pays 3×"]);
    expect(rouletteRulesText(GAME)).toBe("12 pockets, bets 5 gp to 50 gp, 3 a round, 45 s, item on a rarity");
  });
});

describe("resolve(pocket, bets)", () => {
  it("pays every winning bet type its multiplier on every pocket, and nothing else", () => {
    const pockets = pocketsOf(GAME);
    for (const type of BET_TYPES) {
      let wins = 0;
      for (const o of optionsOf(GAME, type)) {
        for (const pocket of pockets) {
          const [line] = resolve(pocket, [{ type, pick: o.pick, stakeCp: 1000 }], GAME);
          expect(line.win).toBe(betWins({ type, pick: o.pick }, pocket));
          expect(line.payoutCp).toBe(line.win ? 1000 * GAME.roulette.payouts[type] : 0);
          if (line.win) wins++;
        }
        // An option wins on exactly the pockets it covers.
        expect(pockets.filter(p => betWins({ type, pick: o.pick }, p))).toHaveLength(o.count);
      }
      // Across every option, each pocket wins exactly one bet of the type.
      expect(wins).toBe(pockets.length);
    }
  });

  it("knows what a pocket is: 7 is red, odd and uncommon", () => {
    const seven = pocketsOf(GAME)[6];
    expect(seven).toMatchObject({ n: 7, colour: 0, colourName: "Red", rarity: "uncommon" });
    expect(resolve(seven, [{ type: "colour", pick: 0, stakeCp: 500 }, { type: "parity", pick: "even", stakeCp: 500 }, { type: "number", pick: 7, stakeCp: 500 }, { type: "rarity", pick: "uncommon", stakeCp: 500 }], GAME).map(l => l.payoutCp)).toEqual([1000, 0, 6000, 1500]);
    expect(betName(GAME, { type: "parity", pick: "even" })).toBe("Even");
    expect(verdictText({ number: 7, colour: 0, rarity: "uncommon" }, coloursOf(GAME))).toBe("The ball lands on 7, red, Uncommon.");
  });
});

describe("the stake's bounds", () => {
  const actor = { id: "a1", name: "Ana" };
  const open = (n, actorId = "a1") => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, actorId, status: "open" }));
  it("refuses a bad pick, a stake under the floor or over the cap, and a fourth bet", () => {
    expect(() => stakeCheck(GAME, { actor, bet: { type: "colour", pick: 2 }, stakes: [], price: 5 })).toThrow("Pick a colour");
    expect(() => stakeCheck(GAME, { actor, bet: { type: "colour", pick: 0 }, stakes: [], price: 1 })).toThrow("least stake at Live wheel is 5 gp");
    expect(() => stakeCheck(GAME, { actor, bet: { type: "colour", pick: 0 }, stakes: [], price: 60 })).toThrow("most you can stake at Live wheel is 50 gp");
    expect(() => stakeCheck(GAME, { actor, bet: { type: "colour", pick: 0 }, stakes: open(3), price: 5 })).toThrow("Ana has placed 3 of 3 bets this round.");
    // Another character's bets, and refunded ones, don't count against Ana.
    expect(stakeCheck(GAME, { actor, bet: { type: "colour", pick: 0 }, stakes: [...open(3, "a2"), { id: "x", actorId: "a1", status: "open", refunded: 1 }], price: 5 })).toEqual({ type: "colour", pick: 0 });
    expect(ROULETTE.stake({ game: GAME, actor, bet: { type: "rarity", pick: "rare" }, stakes: [], price: 5 })).toEqual({ label: "Rare", type: "rarity", pick: "rare", swatch: "rare" });
    expect(ROULETTE.priceOf({ game: GAME, bet: { stake: 12 } })).toBe(12);
    expect(ROULETTE.priceOf({ game: GAME, bet: {} })).toBe(5);
  });

  it("reads the form's bet and says what is wrong before anything is sent", () => {
    expect(readBet(GAME, { type: "number", pick: "7", stake: "10" })).toEqual({ bet: { type: "number", pick: 7, stake: 10 }, price: 10 });
    expect(() => readBet(GAME, { type: "number", pick: "7", stake: "1" })).toThrow(PullError);
    expect(() => readBet(GAME, { type: "number", pick: "7", stake: "1" })).toThrow("Stake at least 5 gp.");
    expect(() => readBet(GAME, { type: "number", pick: "7", stake: "99" })).toThrow("Stake no more than 50 gp.");
    expect(() => readBet(GAME, { type: "number", pick: "13", stake: "5" })).toThrow("Pick a colour");
    expect(pickOptions(GAME, "number").match(/<option/g)).toHaveLength(12);
    expect(pickOptions(GAME, "number")).toContain(">1, 1 in 12<");
    expect(pickOptions(GAME, "rarity", "rare")).toContain('value="rare" selected>Rare, 17%');
    const fields = betFields(GAME, { values: { type: "parity", stake: 20 } });
    expect(fields).toContain('name="type"');
    expect(fields).toContain('value="parity" selected');
    expect(fields).toContain('min="5" max="50" step="1" value="20"');
  });
});

describe("the roll and the settle on the core's contract", () => {
  const evaluated = [];
  let face = 5;
  beforeEach(() => {
    evaluated.length = 0;
    globalThis.Roll = class {
      constructor(formula) { this.formula = formula; }
      async evaluate(opts) { evaluated.push(opts); return this; }
      toJSON() { return { class: "Roll", formula: this.formula, evaluated: true, total: face, terms: [{ class: "Die", number: 1, faces: 12, results: [{ result: face, active: true }] }] }; }
    };
  });
  afterEach(() => { delete globalThis.Roll; });
  const source = { uuid: "Item.rare1", name: "Rare Wand", img: "w.webp", toObject: () => ({ name: "Rare Wand", type: "weapon", img: "w.webp", system: { rarity: "rare" } }) };
  const resolveSource = async uuid => (uuid === "Item.rare1" ? source : null);
  const row = (id, actorId, stake, price = 10) => ({ id, actorId, actorName: actorId, price, status: "open", stake });

  it("rolls 1dN with Foundry's Roll, allowInteractive false, and lands where it says", async () => {
    face = 5;
    const out = await ROULETTE.roll({ game: GAME, stakes: [], rng: seededRng(1), pools: POOLS, resolveSource });
    expect(evaluated).toEqual([{ allowInteractive: false }]);
    expect(out.outcome).toEqual({ index: 4, number: 5, colour: 1, colourName: "Black", rarity: "rare" });
    expect(out.roll.terms[0].results[0].result).toBe(5);
    expect(out.pockets).toHaveLength(12);
    expect(out.colours).toEqual(["Red", "Black"]);
  });

  it("draws an item of the band for a winning rarity bet, and only for it", async () => {
    face = 5;
    const stakes = [row("s1", "a1", { type: "rarity", pick: "rare" }), row("s2", "a2", { type: "colour", pick: 1 }), row("s3", "a3", { type: "rarity", pick: "common" })];
    const out = await ROULETTE.roll({ game: GAME, stakes, rng: seededRng(1), pools: POOLS, resolveSource });
    expect(Object.keys(out.grants)).toEqual(["s1"]);
    expect(out.grants.s1.result).toMatchObject({ uuid: "Item.rare1", name: "Rare Wand", rarity: "rare" });
    expect(out.grants.s1.grant.flags["loot-crates"]).toMatchObject({ boxId: "wheel", sourceUuid: "Item.rare1" });
    const settle = r => ROULETTE.settle({ game: GAME, outcome: out.outcome, row: r, stake: r.stake, grants: out.grants });
    expect(settle(stakes[0])).toMatchObject({ payoutCp: 3000, name: "Rare: Rare Wand", result: { name: "Rare Wand" } });
    expect(settle(stakes[0]).grant).toBeTruthy();
    expect(settle(stakes[1])).toEqual({ payoutCp: 2000 });
    expect(settle(stakes[2])).toEqual({ payoutCp: 0 });
  });

  it("pays coins only when the pools hold nothing of the band, or the rule is off", async () => {
    face = 9;
    const legendary = row("s1", "a1", { type: "rarity", pick: "legendary" });
    const out = await ROULETTE.roll({ game: GAME, stakes: [legendary], rng: seededRng(1), pools: POOLS, resolveSource });
    expect(out.outcome.rarity).toBe("legendary");
    expect(out.grants).toEqual({});
    expect(ROULETTE.settle({ game: GAME, outcome: out.outcome, row: legendary, stake: legendary.stake, grants: out.grants })).toEqual({ payoutCp: 3000 });
    face = 5;
    const off = { ...GAME, roulette: { ...GAME.roulette, itemOnRarity: false } };
    const out2 = await ROULETTE.roll({ game: off, stakes: [row("s1", "a1", { type: "rarity", pick: "rare" })], rng: seededRng(1), pools: POOLS, resolveSource });
    expect(out2.grants).toEqual({});
    expect(drawOfRarity(GAME, POOLS, "rare", () => 0).entry.name).toBe("Rare Wand");
    expect(drawOfRarity(GAME, POOLS, "legendary")).toBeNull();
  });

  it("refuses to spin a wheel with no pockets, before anything is written", async () => {
    await expect(ROULETTE.roll({ game: { ...GAME, roulette: { pockets: [] } }, stakes: [], rng: Math.random })).rejects.toThrow("has no wheel to spin");
    expect(evaluated).toEqual([]);
  });
});

describe("the words", () => {
  const stakes = [
    { logId: "b", actorId: "bo", actorName: "Bo", price: 10, stake: { label: "Black" }, action: "settle", payoutCp: 0 },
    { logId: "o1", actorId: "orla", actorName: "Orla", price: 5, stake: { label: "Even" }, action: "settle", payoutCp: 1000 },
    { logId: "o2", actorId: "orla", actorName: "Orla", price: 5, stake: { label: "Rare" }, action: "settle", payoutCp: 0 },
    { logId: "t1", actorId: "tam", actorName: "Tam", price: 5, stake: { label: "7" }, action: "settle", payoutCp: 6000, result: { name: "Rare Wand", rarity: "rare" } },
    { logId: "t2", actorId: "tam", actorName: "Tam", price: 20, stake: { label: "Red" }, action: "settle", payoutCp: 4000 },
    { logId: "c", actorId: "cy", actorName: "Cy", price: 5, stake: { label: "Odd" }, action: "refund", payoutCp: 0 },
  ];
  it("gives each character one net line", () => {
    const by = netByActor(stakes);
    expect(by.map(a => a.net)).toEqual([-1000, 0, 7500, 0]);
    expect(netLines(stakes)).toEqual(["Bo loses 10 gp", "Orla breaks even on Even", "Tam wins 75 gp on 7, Red, and finds Rare Wand", "Cy's stake came back"]);
    expect(netText({ actorName: "X", net: 250, won: ["Red"], lost: [], items: [] })).toBe("X wins 2 gp 5 sp on Red");
  });

  it("posts one card per round, the verdict and the nets in the block the core seals", () => {
    const esc = s => String(s);
    const reveal = { box: { name: "Live wheel" }, outcome: { index: 6, number: 7, colour: 0, rarity: "uncommon" }, colours: ["Red", "Black"], stakes };
    const html = ROULETTE.chat.card(reveal, { esc, itemLink: (u, n) => n });
    expect(html).toContain("lc-chat lc-rarity-uncommon");
    expect(html).toContain("The wheel turned at <strong>Live wheel</strong>");
    expect(html).toContain("5 bets");
    const item = html.slice(html.indexOf('class="lc-chat__item"'));
    expect(item).toContain("The ball lands on 7, red, Uncommon.");
    expect(item).toContain("Tam wins 75 gp on 7, Red, and finds Rare Wand");
    expect(html.slice(0, html.indexOf('class="lc-chat__item"'))).not.toContain("lands on");
    expect(ROULETTE.chat.card({ box: {}, stakes: [] }, { esc, itemLink: (u, n) => n })).toBeNull();
    expect(ROULETTE.gotText({ stake: { label: "Red" } })).toBe("staked on Red");
  });

  it("says what the round is doing", () => {
    const now = 1000000;
    expect(roundState(null)).toEqual({ key: "none", text: "No round open yet" });
    expect(roundState({ status: "resolved" }).key).toBe("none");
    expect(roundState({ status: "open", closesAt: now + 42000 }, { now })).toEqual({ key: "clock", text: "Bets close in 0:42", closesAt: now + 42000 });
    expect(roundState({ status: "open", closesAt: now - 1 }, { now }).key).toBe("closed");
    expect(roundState({ status: "closed" }, { now }).text).toBe("Bets are closed");
    expect(roundState({ status: "open", closesAt: null }, { now }).text).toBe("Bets are open until the GM spins");
    expect(roundState({ status: "open" }, { now, held: true }).text).toBe("The wheel is turning");
    expect(clockText(125000)).toBe("2:05");
    expect(clockText(-5)).toBe("0:00");
  });
});

describe("the shop card", () => {
  const esc = s => String(s ?? "");
  const base = { esc, purse: { gp: 100 }, hasActor: true, actorId: "tam", actorName: "Tam", open: true, gmOnline: true, log: [], now: 1000, stateOf: () => ({}), held: () => false };
  const round = { id: "R", boxId: "wheel", status: "open", opensAt: 0, closesAt: 43000 };
  it("offers Place a bet while a round is open, and says why not otherwise", () => {
    const on = ROULETTE.shop.card(GAME, POOLS, { ...base, rounds: { R: round } });
    expect(on).toContain("Place a bet");
    expect(on).toContain('data-lc-countdown="43000"');
    expect(on).toContain("Bets close in 0:42");
    expect(on).not.toContain('aria-disabled="true"');
    expect(on).toContain("Common 42%");
    expect(on).toContain("Stake 5 gp to 50 gp, 3 bets a round");
    const none = ROULETTE.shop.card(GAME, POOLS, { ...base, rounds: {} });
    expect(none).toContain('aria-disabled="true"');
    expect(none).toContain("No round open yet");
    expect(ROULETTE.shop.reason(GAME, POOLS, { ...base, rounds: {} })).toBe("No round open yet");
    expect(ROULETTE.shop.reason(GAME, POOLS, { ...base, rounds: { R: { ...round, status: "closed" } } })).toBe("Bets are closed");
    expect(ROULETTE.shop.reason(GAME, POOLS, { ...base, rounds: { R: round }, held: () => true })).toBe("Still spinning");
    const three = [1, 2, 3].map(i => ({ id: `s${i}`, roundId: "R", actorId: "tam", status: "open" }));
    expect(ROULETTE.shop.reason(GAME, POOLS, { ...base, rounds: { R: round }, log: three })).toBe("3 of 3 bets placed");
    expect(ROULETTE.shop.reason(GAME, POOLS, { ...base, rounds: { R: round }, purse: { gp: 2 } })).toBe("Needs 3 gp more");
  });

  it("gives the GM Open a round, then Go to the table", () => {
    expect(ROULETTE.shop.card(GAME, POOLS, { ...base, isGM: true, rounds: {} })).toContain("Open a round");
    expect(ROULETTE.shop.card(GAME, POOLS, { ...base, isGM: true, rounds: {} })).not.toContain('aria-disabled="true"');
    expect(ROULETTE.shop.card(GAME, POOLS, { ...base, isGM: true, rounds: { R: round } })).toContain("Go to the table");
    expect(ROULETTE.shop.reason(GAME, POOLS, { ...base, isGM: true, rounds: {} })).toBe("");
  });
});

describe("the wheel", () => {
  it("rests with the pocket under the pin and the ball at the pin", () => {
    for (const index of [0, 4, 6, 11]) {
      const at = wheelPose(1, index, 12);
      expect(((at.ball % 360) + 360) % 360).toBeCloseTo(0, 6);
      expect(((((index + 0.5) * 30 + at.wheel) % 360) + 360) % 360).toBeCloseTo(0, 6);
      expect(pocketUnder(at, 12)).toBe(index);
    }
    const start = wheelPose(0, 6, 12);
    expect(start).toMatchObject({ wheel: 0, ball: -0 });
    expect(start.radius).toBeGreaterThan(wheelPose(1, 6, 12).radius);
    // The ball dips only in the last part.
    expect(wheelPose(0.5, 6, 12).radius).toBe(start.radius);
    // It slows: more of the turn is done in the first half than the second.
    const mid = wheelPose(0.5, 6, 12);
    expect(Math.abs(mid.ball)).toBeGreaterThan(Math.abs(wheelPose(1, 6, 12).ball) / 2);
  });

  it("draws every pocket's wedge, rarity rim and number, and the pin's diamond", () => {
    const svg = wheelSVG(pocketsOf(GAME));
    expect(svg.match(/lc-wheel__pocket lc-wheel__pocket--[01]/g)).toHaveLength(12);
    expect(svg.match(/lc-wheel__rim lc-rarity-/g)).toHaveLength(12);
    expect(svg.match(/<text/g)).toHaveLength(12);
    expect(svg).toContain("lc-wheel__pip");
    expect(svg).toContain('lc-rarity-legendary"');
  });

  describe("mounted", () => {
    let doc, frames;
    beforeEach(() => {
      doc = createDocument();
      frames = [];
      vi.stubGlobal("requestAnimationFrame", fn => { frames.push(fn); return frames.length; });
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      vi.stubGlobal("matchMedia", () => ({ matches: false }));
    });
    afterEach(() => vi.unstubAllGlobals());
    const step = t => { const fn = frames.shift(); fn?.(t); };

    it("runs one loop writing the disc's and the orbit's rotation, ticks as the ball crosses pockets, drops once, lands on the pocket", async () => {
      const host = doc.createElement("div");
      const table = mountWheel(host, { pockets: pocketsOf(GAME) });
      table.rail("<b>chips</b>");
      expect(host.querySelector(".lc-rail").textContent).toBe("chips");
      expect(host.querySelector(".lc-wheel__ball").style.opacity).toBe("0");
      const ticks = [], drop = vi.fn(), land = vi.fn();
      const ctrl = table.spin({ index: 6, duration: 1000, onTick: p => ticks.push(p), onDrop: drop, onLand: land });
      const done = ctrl.play();
      expect(host.classList.contains("lc-table__stage--spinning")).toBe(true);
      for (let t = 0; t <= 1000; t += 20) step(t);
      await done;
      expect(land).toHaveBeenCalledOnce();
      expect(drop).toHaveBeenCalledOnce();
      expect(ticks.length).toBeGreaterThan(20);
      expect(ticks.every((p, i) => i === 0 || p >= ticks[i - 1])).toBe(true);
      expect(host.classList.contains("lc-table__stage--landed")).toBe(true);
      expect(host.dataset.pocket).toBe("7");
      expect(host.querySelector(".lc-wheel__turn").style.transform).toBe("rotate(525.00deg)");
      expect(host.querySelector(".lc-wheel__orbit").style.transform).toBe("rotate(-2160.00deg)");
      expect(host.querySelector(".lc-wheel__ball").style.transform).toBe("translateY(-70.00px)");
      expect(frames).toHaveLength(0);
    });

    it("skips to the landing, and lands at once under reduced motion", async () => {
      const host = doc.createElement("div");
      const land = vi.fn();
      const ctrl = mountWheel(host, { pockets: pocketsOf(GAME) }).spin({ index: 2, onLand: land });
      ctrl.play();
      step(0);
      ctrl.skip();
      expect(ctrl.skipped).toBe(true);
      expect(land).toHaveBeenCalledOnce();
      expect(host.dataset.pocket).toBe("3");
      ctrl.skip();
      expect(land).toHaveBeenCalledOnce();
      // The skip cancelled the frame the loop had asked for.
      expect(cancelAnimationFrame).toHaveBeenCalledOnce();
      frames.length = 0;
      const quiet = doc.createElement("div");
      const ctrl2 = mountWheel(quiet, { pockets: pocketsOf(GAME) }).spin({ index: 0, reducedMotion: true });
      await ctrl2.play();
      expect(ctrl2.reducedMotion).toBe(true);
      expect(quiet.dataset.pocket).toBe("1");
      expect(frames).toHaveLength(0);
    });
  });
});

describe("the rail and the table's body", () => {
  const rows = [
    { id: "b", actorId: "bo", actorName: "Bo Marrow", price: 10, status: "open", stake: { type: "colour", pick: 1, label: "Black" }, name: "Black" },
    { id: "o", actorId: "orla", actorName: "Orla Vane", price: 5, status: "open", stake: { type: "rarity", pick: "rare", label: "Rare" }, name: "Rare" },
    { id: "t", actorId: "tam", actorName: "Tam Thornwick", price: 5, status: "open", stake: { type: "number", pick: 7, label: "7" }, name: "7" },
    { id: "x", actorId: "tam", actorName: "Tam Thornwick", price: 5, status: "open", refunded: 1, stake: { type: "number", pick: 8, label: "8" }, name: "8" },
  ];
  it("places a chip per live stake on its spot, marks the viewer's and the fresh, and lights the winners", () => {
    const html = railHTML(GAME, rows, { fresh: ["t"], actorIds: ["tam"] });
    expect(html.match(/class="lc-token /g)).toHaveLength(3);
    expect(html).toContain("lc-token--new");
    expect(html.match(/lc-token--mine/g)).toHaveLength(1);
    expect(html).toContain('title="Bo Marrow: 10 gp on Black">B<');
    expect(html.match(/data-spot="/g)).toHaveLength(2 + 2 + 12 + 4);
    expect(html).not.toContain("lc-spot--won");
    const landed = railHTML(GAME, rows, { outcome: { index: 6 } });
    const won = [...landed.matchAll(/class="lc-spot ([^"]*lc-spot--won)[^"]*" data-spot="([^"]+)"/g)].map(m => m[2]).sort();
    expect(won).toEqual(["colour:0", "number:7", "parity:odd", "rarity:uncommon"]);
    expect(landed.match(/lc-spot--out/g)).toHaveLength(20 - 4);
  });

  it("draws the body for each phase", () => {
    const esc = s => String(s ?? "");
    const now = 1000000;
    const round = { id: "R", boxId: "wheel", status: "open", opensAt: now - 3000, closesAt: now + 42000 };
    const player = { isGM: false, actors: [{ id: "tam", name: "Tam Thornwick" }] };
    const betting = tableBodyHTML({ kind: ROULETTE, game: GAME, round, stakes: rows, viewer: player, phase: "betting", now, esc });
    expect(betting).toContain('class="lc-table__form"');
    expect(betting).toContain('<input type="hidden" name="actorId" value="tam">');
    expect(betting).toContain("Place a bet");
    expect(betting).toContain('data-lc-countdown="1042000"');
    expect(betting).toContain("Bets close in 0:42");
    expect(betting).toContain("3 bets from 3 characters");
    expect(betting.match(/<li>/g)).toHaveLength(3);
    expect(betting).toContain("Tam Thornwick bets 5 gp on 7");
    expect(betting).not.toContain("lc-table__spin");
    expect(betting).toContain('data-action="dismiss">Close<');
    const two = tableBodyHTML({ kind: ROULETTE, game: GAME, round, stakes: [], viewer: { isGM: false, actors: [{ id: "a", name: "A" }, { id: "b", name: "B" }] }, phase: "betting", now, esc, values: { actorId: "b" } });
    expect(two).toContain('<select name="actorId"');
    expect(two).toContain('value="b" selected');
    expect(two).toContain("No bets yet");
    const gm = tableBodyHTML({ kind: ROULETTE, game: GAME, round: { ...round, status: "closed" }, stakes: rows, viewer: { isGM: true, actors: [] }, phase: "waiting", now, esc });
    expect(gm).toContain('data-action="spin">Spin<');
    expect(gm).not.toContain("lc-table__form");
    expect(gm).toContain("Bets are closed: waiting for the GM to spin");
    const spinning = tableBodyHTML({ kind: ROULETTE, game: GAME, round, stakes: rows, viewer: player, phase: "spinning", now, esc });
    expect(spinning).toContain('data-action="skip">Skip<');
    expect(spinning).toContain("The wheel is turning");
    expect(spinning).not.toContain("lc-table__form");
    expect(spinning).toContain('aria-live="polite"');
  });

  it("knows the phase from the round and the reveal", () => {
    const now = 5000;
    expect(phaseOf({ status: "open", closesAt: now + 1 }, { now })).toBe("betting");
    expect(phaseOf({ status: "open", closesAt: now - 1 }, { now })).toBe("waiting");
    expect(phaseOf({ status: "closed" }, { now })).toBe("waiting");
    expect(phaseOf({ status: "resolved" }, { now })).toBe("spinning");
    expect(phaseOf({ status: "open" }, { reveal: {}, now })).toBe("spinning");
    expect(phaseOf({ status: "open" }, { reveal: {}, landed: true, now })).toBe("landed");
    expect(phaseOf(null, { now })).toBe("void");
    expect(phaseOf({ status: "resolved", voided: 1 }, { now })).toBe("void");
    expect(stateText(null, "void").text).toBe("The round was called off; every stake came back");
    expect(stateText(null, "landed")).toEqual({ key: "landed", text: "Settled" });
    expect(countText([])).toBe("No bets yet");
    expect(countText([rows[2]])).toBe("1 bet");
    expect(stakeSentence(rows[0])).toBe("Bo Marrow bets 10 gp on Black");
  });
});

describe("the editor", () => {
  it("drafts the wheel from the form and warns when a band has nowhere to draw from", () => {
    const values = { price: "2", maxStake: "", maxBets: "2", windowSec: "30", colourA: "Fire", colourB: "", pockets: ["a", "b", "c"], "p.a.colour": "0", "p.a.rarity": "rare", "p.b.colour": "1", "p.b.rarity": "legendary", "p.c.colour": "1", "p.c.rarity": "nonsense", "pay.colour": "1.5", "pay.parity": "", "pay.number": "3", "pay.rarity": "4", itemOnRarity: true, "pool.p": true };
    const draft = draftRoulette(GAME, values, ["p", "q"]);
    expect(draft.price).toBe(2);
    expect(draft.pools).toEqual([{ id: "p", share: 1 }]);
    expect(draft.roulette).toMatchObject({ colours: ["Fire", "Black"], pockets: [{ colour: 0, rarity: "rare" }, { colour: 1, rarity: "legendary" }, { colour: 1, rarity: "common" }], payouts: { colour: 1.5, parity: 2, number: 3, rarity: 4 }, maxStake: null, maxBets: 2, windowSec: 30, itemOnRarity: true });
    const preview = roulettePreview(draft, POOLS);
    expect(preview.note).toBe("The pools hold nothing Legendary: a winning bet on that band pays coins only.");
    expect(preview.warn).toBe(false);
    expect(roulettePreview({ ...GAME, roulette: { pockets: [] } }, POOLS)).toMatchObject({ warn: true });
    expect(roulettePreview({ ...GAME, pools: [] }, POOLS).note).toContain("no pool ticked");
    expect(roulettePreview({ ...GAME, roulette: { ...GAME.roulette, itemOnRarity: false } }, POOLS).note).toBe("");
  });
});
