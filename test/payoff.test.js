/*
  The payoff after the spin: Skip ends the spin through the same landing,
  the strip is hidden from screen readers, reveal windows cascade instead of
  stacking, the result says where the item went (and the gold left, to the
  buyer), and the chat card links the granted item the Foundry way.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mountSpin, CARD_WIDTH, CARD_GAP, DEFAULT_DURATION } from "../module/scripts/views/spin.js";
import { cascadeOffset, canSeePurse, resultHTML, CASCADE_STEP, freeSlot } from "../module/scripts/views/revealcard.js";
import { formatGold } from "../module/scripts/core/currency.js";
import { buildStrip } from "../module/scripts/core/strip.js";
import { draw, seededRng } from "../module/scripts/core/odds.js";
import { POOLS, BOX } from "../harness/sample.js";

// Just enough DOM for mountSpin: elements that record classes, attributes,
// children and style, and a requestAnimationFrame the test steps by hand.
function fakeElement() {
  const classes = new Set();
  return {
    children: [], dataset: {}, attrs: {}, clientWidth: 0, className: "",
    style: { setProperty(k, v) { this[k] = v; } },
    classList: { add: (...c) => c.forEach(x => classes.add(x)), remove: (...c) => c.forEach(x => classes.delete(x)), contains: c => classes.has(c) },
    append(...k) { this.children.push(...k); },
    appendChild(k) { this.children.push(k); return k; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    set innerHTML(_v) { this.children = []; },
  };
}

describe("the spin", () => {
  let frames, now;
  const step = (ms = 16) => { now += ms; const due = frames; frames = []; due.forEach(f => f(now)); };

  beforeEach(() => {
    frames = [];
    now = 0;
    globalThis.document = { createElement: () => fakeElement() };
    globalThis.requestAnimationFrame = cb => frames.push(cb);
  });
  afterEach(() => { delete globalThis.document; delete globalThis.requestAnimationFrame; });

  const strip = () => {
    const rng = seededRng(7);
    return buildStrip({ result: draw({ box: BOX, pools: POOLS, rng, state: {} }), box: BOX, pools: POOLS, rng });
  };

  it("hides the strip of filler cards from screen readers, marker included", () => {
    const spin = mountSpin(fakeElement(), strip(), { reducedMotion: false });
    expect(spin.track.getAttribute("aria-hidden")).toBe("true");
    expect(spin.viewport.children[1].getAttribute("aria-hidden")).toBe("true");
  });

  it("skip() on a 6200 ms spin lands within 2 frames, with the result under the marker", async () => {
    const s = strip();
    const onLand = vi.fn();
    const spin = mountSpin(fakeElement(), s, { duration: DEFAULT_DURATION, reducedMotion: false, onLand });
    spin.viewport.clientWidth = 600;
    let done = false;
    const played = spin.play().then(() => { done = true; });
    step(); step(); step();
    await Promise.resolve();
    expect(done).toBe(false);
    expect(spin.landed).toBe(false);

    spin.skip();
    for (let i = 0; i < 2 && !spin.landed; i++) step();
    expect(spin.landed).toBe(true);
    await played;
    expect(done).toBe(true);
    expect(onLand).toHaveBeenCalledTimes(1);
    expect(onLand.mock.calls[0][0]).toBe(s.cards[s.landIndex]);
    expect(spin.cards[s.landIndex].classList.contains("lc-card--landed")).toBe(true);
    // The landed card's centre sits on the viewport's centre, where the marker is.
    const x = -Number(/translate3d\((-?[\d.]+)px/.exec(spin.track.style.transform)[1]);
    expect(s.landIndex * (CARD_WIDTH + CARD_GAP) + CARD_WIDTH / 2 - x).toBeCloseTo(300, 5);
    // Nothing left scheduled, and a second skip does nothing.
    spin.skip();
    step();
    expect(onLand).toHaveBeenCalledTimes(1);
  });

  it("skip() before play() lands at once", async () => {
    const onLand = vi.fn();
    const spin = mountSpin(fakeElement(), strip(), { duration: DEFAULT_DURATION, reducedMotion: false, onLand });
    spin.skip();
    await spin.play();
    expect(onLand).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(0);
  });
});

describe("cascadeOffset", () => {
  const desk = { width: 1440, height: 900 };

  it("centres the first window, as Foundry would", () => {
    expect(cascadeOffset(0, desk)).toEqual({ width: 720, left: 360, top: 258 });
  });

  it("puts each later window 32px down and right, and wraps at 4", () => {
    const at = n => cascadeOffset(n, desk);
    expect(at(1)).toEqual({ width: 720, left: 360 + CASCADE_STEP, top: 258 + CASCADE_STEP });
    expect(at(3)).toEqual({ width: 720, left: 360 + 3 * CASCADE_STEP, top: 258 + 3 * CASCADE_STEP });
    expect(at(4)).toEqual(at(0));
    expect(at(5)).toEqual(at(1));
  });

  it("never comes out wider than the viewport less 32, or past its edges", () => {
    for (const vp of [{ width: 390, height: 844 }, { width: 700, height: 400 }, { width: 760, height: 300 }, { width: 200, height: 200 }]) {
      for (let n = 0; n < 8; n++) {
        const o = cascadeOffset(n, vp);
        expect(o.width).toBeLessThanOrEqual(vp.width - 32);
        expect(o.left).toBeGreaterThanOrEqual(0);
        expect(o.left + o.width).toBeLessThanOrEqual(vp.width);
        expect(o.top).toBeGreaterThanOrEqual(0);
      }
    }
    // A half-width Foundry tab gets a window that fits, not a fixed 720.
    expect(cascadeOffset(0, { width: 700, height: 900 }).width).toBe(668);
  });
});

describe("the reveal's result block", () => {
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const reveal = {
    userId: "p1", actorName: "Crate <Tester>", itemUuid: "Actor.a1.Item.i1",
    purse: { pp: 0, gp: 450, ep: 0, sp: 5, cp: 0 },
    result: { name: "Flame Tongue", rarity: "rare", pity: false },
  };

  it("tells the buyer where the item went and the gold left", () => {
    const html = resultHTML(reveal, { esc, canSee: true });
    expect(html).toContain('<div class="lc-reveal__name">Flame Tongue</div>');
    expect(html).toContain("Rare");
    expect(html).toContain("Added to Crate &lt;Tester&gt;'s inventory · <span class=\"lc-reveal__gold\">450 gp 5 sp left</span>");
  });

  it("tells the rest of the table where it went, not the buyer's gold", () => {
    const html = resultHTML(reveal, { esc, canSee: false });
    expect(html).toContain("Added to Crate &lt;Tester&gt;'s inventory");
    expect(html).not.toContain("gp left");
  });

  it("shows the purse to the buyer and GMs only", () => {
    expect(canSeePurse(reveal, { userId: "p1" })).toBe(true);
    expect(canSeePurse(reveal, { userId: "gm", isGM: true })).toBe(true);
    expect(canSeePurse(reveal, { userId: "p2" })).toBe(false);
    expect(canSeePurse({ ...reveal, userId: undefined }, { userId: undefined })).toBe(false);
  });

  it("formats gold the way the shop's header does", () => {
    expect(formatGold({ gp: 420, sp: 7, cp: 3 })).toBe("420 gp 7 sp 3 cp");
    expect(formatGold({ pp: 1, gp: 2 })).toBe("12 gp");
    expect(formatGold({})).toBe("0 gp");
  });
});

describe("the chat card", () => {
  let created;
  beforeEach(() => {
    created = null;
    globalThis.foundry = { utils: { escapeHTML: s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;") } };
    globalThis.game = { actors: { get: () => ({ id: "a1" }) } };
    globalThis.ChatMessage = { create: async data => { created = data; return data; }, getSpeaker: () => ({}) };
  });
  afterEach(() => { delete globalThis.foundry; delete globalThis.game; delete globalThis.ChatMessage; });

  const reveal = itemId => ({
    actorId: "a1", actorName: "Crate Tester", box: { id: "b", name: "Box", price: 50 },
    itemId, itemUuid: itemId ? `Actor.a1.Item.${itemId}` : null,
    result: { uuid: "Compendium.dnd5e.items.Item.src", name: "Flame Tongue", img: "", rarity: "rare" },
  });

  it("links the granted item as a Foundry content link", async () => {
    const { postPullCard } = await import("../module/scripts/foundry/chat.js");
    await postPullCard(reveal("i1"));
    expect(created.content).toMatch(/<a class="content-link"[^>]* data-uuid="Actor\.a1\.Item\.i1"[^>]*>.*Flame Tongue<\/a>/);
  });

  it("writes the log row's id into the card's flags, so a refund can find it", async () => {
    const { postPullCard } = await import("../module/scripts/foundry/chat.js");
    globalThis.foundry.utils.deepClone = v => structuredClone(v);
    globalThis.game.settings = { get: () => [{ id: "row1", at: 1 }] };
    await postPullCard({ ...reveal("i1"), logId: "row1" });
    expect(created.flags["loot-crates"]).toEqual({ uuid: "Compendium.dnd5e.items.Item.src", boxId: "b", logId: "row1" });
    expect(created.content).not.toContain("lc-chat--refunded");
  });

  it("posts the card already refunded when the refund beat the spin", async () => {
    const { postPullCard } = await import("../module/scripts/foundry/chat.js");
    globalThis.foundry.utils.deepClone = v => structuredClone(v);
    globalThis.game.settings = { get: () => [{ id: "row1", at: 1, refunded: 2, name: "Flame Tongue", uuid: "Compendium.dnd5e.items.Item.src" }] };
    await postPullCard({ ...reveal("i1"), logId: "row1" });
    expect(created.content).toContain("lc-chat--refunded");
    expect(created.content).not.toContain('data-uuid="Actor.');
  });

  it("stores a display-only replay snapshot, with no purse or granted item", async () => {
    const { postPullCard } = await import("../module/scripts/foundry/chat.js");
    const strip = { landIndex: 1, nearMiss: false, cards: [{ uuid: "c0", name: "Rope", img: "r.webp", rarity: "common" }, { uuid: "Compendium.dnd5e.items.Item.src", name: "Flame Tongue", img: "f.webp", rarity: "rare", result: true }] };
    await postPullCard({ ...reveal("i1"), strip, purse: { gp: 420 }, odds: [{ rarity: "rare", chance: 1, label: "100%" }] });
    const { replay } = created.flags["loot-crates"];
    expect(replay.strip).toEqual({ landIndex: 1, nearMiss: false, cards: [{ name: "Rope", img: "r.webp", rarity: "common" }, { name: "Flame Tongue", img: "f.webp", rarity: "rare", result: true }] });
    expect(replay.result).toEqual({ name: "Flame Tongue", rarity: "rare", pity: false });
    const json = JSON.stringify(replay);
    expect(json).not.toMatch(/purse|itemUuid|Actor\.|uuid|420/);
  });

  it("falls back to the pool's source when nothing was granted", async () => {
    const { postPullCard } = await import("../module/scripts/foundry/chat.js");
    await postPullCard(reveal(null));
    expect(created.content).toContain('class="content-link"');
    expect(created.content).toContain('data-uuid="Compendium.dnd5e.items.Item.src"');
  });
});

describe("freeSlot", () => {
  it("takes the lowest slot no open reveal holds", () => {
    expect(freeSlot([])).toBe(0);
    expect(freeSlot([0])).toBe(1);
    // The first window closed while the second is still spinning: the third
    // goes back to slot 0, not on top of the second.
    expect(freeSlot([1])).toBe(0);
    expect(freeSlot([0, 1, 2, 3])).toBe(4);
    expect(freeSlot([undefined])).toBe(0);
  });
});
