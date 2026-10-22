/*
  "Watch again": a pull's chat card keeps a display-only snapshot of its
  spin. It holds what the replay draws (names, art, rarities, where it lands,
  the odds, the result) and nothing that could open the item or tell anyone
  the buyer's gold, and it stays small enough to live in a message's flags.
*/
import { describe, it, expect } from "vitest";
import { replaySnapshot, replayReveal, replayTitle, replayWindowId, resultHTML, revealActionsHTML } from "../module/scripts/revealcard.js";
import { buildStrip, STRIP_LENGTH } from "../module/scripts/strip.js";
import { draw, seededRng, shopOdds } from "../module/scripts/odds.js";
import { POOLS, BOX } from "../harness/sample.js";

// A pull as socket.js broadcasts it, with a world's long names and art paths.
function pull(seed = 7) {
  const rng = seededRng(seed);
  const pools = Object.fromEntries(Object.entries(POOLS).map(([id, p]) => [id, {
    ...p,
    entries: p.entries.map((e, i) => ({ ...e, name: `${e.name} of the Forgotten Vault ${i}`, img: `icons/equipment/treasure/heavy-ornate-chest-gold-engraved-${i}.webp`, uuid: `Compendium.world.long-pack-name.Item.${"x".repeat(16)}${p.id}${i}` })),
  }]));
  const result = draw({ box: BOX, pools, rng, state: {} });
  return {
    type: "reveal", requestId: "r1", userId: "p1", actorId: "a1", actorName: "Crate Tester",
    box: { id: BOX.id, name: BOX.name, price: BOX.price },
    odds: shopOdds(BOX, pools).rows.map(({ rarity, chance, label }) => ({ rarity, chance, label })),
    result: { uuid: result.entry.uuid, name: result.entry.name, img: result.entry.img, rarity: result.rarity, pity: result.pity },
    strip: buildStrip({ result, box: BOX, pools, rng }),
    purse: { pp: 0, gp: 420, ep: 0, sp: 7, cp: 3 }, itemId: "i1", itemUuid: "Actor.a1.Item.i1", logId: "L1",
  };
}

describe("replaySnapshot", () => {
  it("keeps only name, art and rarity per card, and where the strip lands", () => {
    const r = pull();
    const snap = replaySnapshot(r);
    expect(snap.strip.cards).toHaveLength(STRIP_LENGTH);
    for (const c of snap.strip.cards) expect(Object.keys(c).sort()).toEqual(expect.arrayContaining(["img", "name", "rarity"]));
    for (const c of snap.strip.cards) expect(Object.keys(c).every(k => ["name", "img", "rarity", "result"].includes(k))).toBe(true);
    expect(snap.strip.landIndex).toBe(r.strip.landIndex);
    expect(snap.strip.nearMiss).toBe(r.strip.nearMiss);
    expect(snap.strip.cards[r.strip.landIndex]).toMatchObject({ name: r.result.name, rarity: r.result.rarity, result: true });
    expect(snap.result).toEqual({ name: r.result.name, rarity: r.result.rarity, pity: !!r.result.pity });
    expect(snap.box).toEqual({ name: BOX.name, price: BOX.price });
    expect(snap.actorName).toBe("Crate Tester");
    expect(snap.odds).toEqual(r.odds);
  });

  it("carries no purse, granted item, uuid or buyer", () => {
    const json = JSON.stringify(replaySnapshot(pull()));
    for (const leak of ["purse", "itemUuid", "itemId", "uuid", "userId", "actorId", "logId", "requestId", "Actor.a1", "Compendium.", "420"]) expect(json).not.toContain(leak);
  });

  it("is under 8 KB for a 48-card strip with long names and art paths", () => {
    const bytes = new TextEncoder().encode(JSON.stringify(replaySnapshot(pull()))).length;
    expect(bytes).toBeLessThan(8 * 1024);
  });

  it("is null for a pull with no strip", () => {
    expect(replaySnapshot({ ...pull(), strip: null })).toBeNull();
    expect(replaySnapshot(null)).toBeNull();
  });
});

describe("replayReveal", () => {
  it("plays the stored strip and lands on the same item and rarity, as a replay", () => {
    const r = pull(23);
    const back = replayReveal(JSON.parse(JSON.stringify(replaySnapshot(r))), "msg1");
    expect(back.replay).toBe(true);
    expect(back.replayKey).toBe("msg1");
    expect(back.strip.cards[back.strip.landIndex]).toMatchObject({ name: r.result.name, rarity: r.result.rarity });
    expect(back.result).toMatchObject({ name: r.result.name, rarity: r.result.rarity });
    expect(back).not.toHaveProperty("purse");
    expect(back).not.toHaveProperty("itemUuid");
    expect(back).not.toHaveProperty("userId");
    expect(back).not.toHaveProperty("logId");
    expect(replayTitle(back)).toBe(`Replay: Crate Tester opens ${BOX.name}`);
    expect(replayWindowId("msg1")).toBe("loot-crates-reveal-replay-msg1");
  });

  it("refuses a snapshot it can't play, and never trusts a stored rarity", () => {
    const snap = replaySnapshot(pull());
    expect(replayReveal(null, "m")).toBeNull();
    expect(replayReveal({ ...snap, strip: { ...snap.strip, cards: [] } }, "m")).toBeNull();
    expect(replayReveal({ ...snap, strip: { ...snap.strip, landIndex: 99 } }, "m")).toBeNull();
    expect(replayReveal({ ...snap, strip: { ...snap.strip, landIndex: "3" } }, "m")).toBeNull();
    expect(replayReveal({ ...snap, result: null }, "m")).toBeNull();
    const odd = replayReveal({ ...snap, result: { ...snap.result, rarity: "x onclick" }, strip: { ...snap.strip, cards: snap.strip.cards.map(c => ({ ...c, rarity: "bad class" })) }, odds: [{ rarity: "nope", chance: 1 }] }, "m");
    expect(odd.result.rarity).toBe("common");
    expect(odd.strip.cards.every(c => c.rarity === "common")).toBe(true);
    expect(odd.odds).toEqual([]);
  });
});

describe("a replay's result block", () => {
  it("shows no gold and no inventory line, even given a purse", () => {
    const back = replayReveal(replaySnapshot(pull()), "m");
    const html = resultHTML({ ...back, purse: { gp: 420 } }, { canSee: false });
    expect(html).toContain(back.result.name);
    expect(html).not.toMatch(/gp left/);
    expect(html).not.toContain("lc-reveal__gold");
    expect(html).not.toContain("inventory");
  });
});

describe("the reveal's buttons", () => {
  it("are Draw again, Open item, Watch again, then Skip (later Close); the first three start hidden, with the reason line before them", () => {
    const html = revealActionsHTML();
    const buttons = [...html.matchAll(/<button ([^>]*)>([^<]*)</g)].map(([, attrs, text]) => ({ attrs, text }));
    expect(buttons.map(b => b.text)).toEqual(["Draw again", "Open item", "Watch again", "Skip"]);
    expect(buttons.map(b => b.attrs.match(/data-action="(\w+)"/)[1])).toEqual(["drawAgain", "openItem", "watchAgain", "skip"]);
    expect(buttons.map(b => / hidden$/.test(b.attrs))).toEqual([true, true, true, false]);
    expect(html.indexOf('class="lc-reveal__why" hidden')).toBeLessThan(html.indexOf("lc-reveal__again"));
    expect(buttons.every(b => /type="button"/.test(b.attrs))).toBe(true);
  });
});
