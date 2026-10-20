/*
  The shop re-renders on every change (Buy pressed, the GM slow, the pull
  done, the purse charged, a player joining, a character picked). patchShop
  must keep every node that is still wanted, so the Buy a keyboard user
  pressed keeps focus through all of it. On a minimal DOM where, as in a
  browser, removing or moving a focused node drops focus to the body.
*/
import { describe, it, expect, beforeEach } from "vitest";
import { boxCard, shopHTML, shopNotice, patchShop, morph } from "../module/scripts/boxcard.js";
import { POOLS, BOXES } from "../harness/sample.js";
import { createDocument } from "./minidom.js";

const ctx = { purse: { gp: 420, sp: 7, cp: 3 }, hasActor: true, open: true, gmOnline: true };
let doc, content;

const ACTORS = [{ id: "a1", name: "Tam" }, { id: "a2", name: "Orla" }];
function fields({ actorId = "a1", actors = ACTORS, purse = "420 gp" } = {}) {
  const picker = actors.length > 1
    ? `<label class="lc-shop__field"><span class="lc-label">Character</span><select class="lc-shop__actor">${actors.map(a => `<option value="${a.id}"${a.id === actorId ? " selected" : ""}>${a.name}</option>`).join("")}</select></label>`
    : `<div class="lc-shop__field"><span class="lc-label">Character</span><span class="lc-shop__who">${actors[0]?.name}</span></div>`;
  return `${picker}<div class="lc-shop__field lc-shop__field--purse"><span class="lc-label">Purse</span><span class="lc-shop__purse">${purse}</span></div>`;
}

// What shop.js's _renderHTML then _replaceHTML do, on the minimal DOM.
function render(extra = {}, { boxes = BOXES, ...f } = {}) {
  const c = { ...ctx, ...extra };
  const notice = shopNotice(c);
  const fresh = doc.createElement("div");
  fresh.className = "lc-shop__body";
  fresh.innerHTML = shopHTML({
    fields: fields(f),
    cards: boxes.length ? boxes.map(b => boxCard(b, POOLS, c)).join("") : `<p class="lc-shop__empty">No crates on the shelf yet.</p>`,
    notice,
  });
  return patchShop(content, fresh, notice);
}
const buy = id => content.querySelector(`.lc-box__buy[data-box="${id}"]`);
const cards = () => content.querySelectorAll(".lc-box");

beforeEach(() => {
  doc = createDocument();
  content = doc.createElement("section");
  doc.body.appendChild(content);
});

describe("patchShop keeps the pressed Buy", () => {
  it("is the same focused node through busy, waiting, idle and purse-change renders", () => {
    render();
    const btn = buy("common");
    const before = cards();
    btn.focus();
    const steps = [
      [{ busy: true, busyBox: "common" }, {}, "Opening…"],
      [{ busy: true, busyBox: "common", waiting: "gm" }, {}, "Waiting for the GM…"],
      // The GM charges mid-pull: updateActor re-renders with the new purse.
      [{ busy: true, busyBox: "common", purse: { gp: 395, sp: 7, cp: 3 } }, { purse: "395 gp" }, "Opening…"],
      [{ purse: { gp: 395, sp: 7, cp: 3 } }, { purse: "395 gp" }, "Open for 25 gp"],
    ];
    for (const [extra, f, label] of steps) {
      render(extra, f);
      expect(buy("common")).toBe(btn);
      expect(doc.activeElement).toBe(btn);
      expect(btn.textContent.trim()).toBe(label);
      expect(cards().every((c, i) => c === before[i])).toBe(true);
    }
    expect(content.querySelector(".lc-shop__purse").textContent).toBe("395 gp");
  });

  it("marks a Buy off with aria-disabled, never disabled, and back on in place", () => {
    render();
    const btn = buy("common");
    render({ busy: true, busyBox: "common" });
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(content.querySelectorAll(".lc-box__buy[disabled]").length).toBe(0);
    render();
    expect(btn.hasAttribute("aria-disabled")).toBe(false);
    expect(btn.hasAttribute("aria-describedby")).toBe(false);
  });

  it("updates a card's stock, why-line and button in place when its stock changes", () => {
    const royal = BOXES.find(b => b.id === "royal");
    const rich = { purse: { gp: 5000 } };
    render(rich);
    const card = content.querySelector('.lc-box[data-box="royal"]');
    const btn = buy("royal");
    btn.focus();
    expect(card.querySelector(".lc-box__stock").textContent).toBe("3 left");
    render(rich, { boxes: BOXES.map(b => b === royal ? { ...b, rules: { stock: 2 } } : b) });
    expect(content.querySelector('.lc-box[data-box="royal"]')).toBe(card);
    expect(card.querySelector(".lc-box__stock").textContent).toBe("2 left");
    render(rich, { boxes: BOXES.map(b => b === royal ? { ...b, rules: { stock: 0 } } : b) });
    expect(buy("royal")).toBe(btn);
    expect(doc.activeElement).toBe(btn);
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(card.querySelector(".lc-box__why").textContent).toBe("Sold out");
    expect(btn.getAttribute("aria-describedby")).toBe("lc-why-royal");
  });

  it("keeps the focused Buy when its crate empties and its card's lines change kind", () => {
    // The GM empties the crate's pools (or its last source goes missing)
    // while a player's focus is on its Buy: the ribbon, odds and stock go,
    // "Nothing inside" comes. The why-line must not be paired with an old
    // line ahead of the Buy, which would move the Buy and drop its focus.
    const royal = BOXES.find(b => b.id === "royal");
    const rich = { purse: { gp: 5000 } };
    render(rich);
    const btn = buy("royal");
    btn.focus();
    render(rich, { boxes: BOXES.map(b => b === royal ? { ...b, pools: [{ id: "gone", share: 1 }] } : b) });
    expect(buy("royal")).toBe(btn);
    expect(doc.activeElement).toBe(btn);
    const card = content.querySelector('.lc-box[data-box="royal"]');
    expect(card.querySelector(".lc-box__why").textContent).toBe("Nothing inside");
    expect(card.querySelector(".lc-box__stock")).toBeNull();
    expect(card.querySelector(".lc-ribbon")).toBeNull();
    // And back: the lines return ahead of the Buy, which stays put.
    render(rich);
    expect(buy("royal")).toBe(btn);
    expect(doc.activeElement).toBe(btn);
    expect(card.querySelector(".lc-box__why")).toBeNull();
    expect(card.querySelector(".lc-box__stock").textContent).toBe("3 left");
  });

  it("adds and removes cards only when crates are added or removed", () => {
    render({}, { boxes: BOXES.slice(0, 2) });
    const [a, b] = cards();
    buy(b.getAttribute("data-box")).focus();
    const focused = doc.activeElement;
    render({}, { boxes: BOXES });
    expect(cards().length).toBe(BOXES.length);
    expect(cards()[0]).toBe(a);
    expect(cards()[1]).toBe(b);
    expect(doc.activeElement).toBe(focused);
    const third = cards()[2];
    render({}, { boxes: [BOXES[1], BOXES[2]] });
    expect(cards().length).toBe(2);
    expect(cards()[0]).toBe(b);
    expect(cards()[1]).toBe(third);
    expect(a.isConnected).toBe(false);
    expect(doc.activeElement).toBe(focused);
  });

  it("follows a reorder with the same nodes", () => {
    render();
    const before = cards();
    render({}, { boxes: [...BOXES].reverse() });
    const after = cards();
    expect(after.length).toBe(before.length);
    expect(after.every((c, i) => c === before[before.length - 1 - i])).toBe(true);
  });

  it("keeps the character <select> node and sets its value", () => {
    render();
    const select = content.querySelector("select.lc-shop__actor");
    select.focus();
    render({}, { actorId: "a2" });
    expect(content.querySelector("select.lc-shop__actor")).toBe(select);
    expect(select.value).toBe("a2");
    expect(doc.activeElement).toBe(select);
  });

  it("swaps what changed kind: an empty shelf for cards, a name for a picker", () => {
    render({}, { boxes: [], actors: ACTORS.slice(0, 1) });
    expect(content.querySelector(".lc-shop__empty")).not.toBeNull();
    const notice = content.querySelector(".lc-shop__notice");
    render();
    expect(content.querySelector(".lc-shop__empty")).toBeNull();
    expect(cards().length).toBe(BOXES.length);
    expect(content.querySelector("select.lc-shop__actor")).not.toBeNull();
    expect(content.querySelector(".lc-shop__who")).toBeNull();
    expect(content.querySelector(".lc-shop__notice")).toBe(notice);
  });

  it("keeps one notice node and rewrites only its text", () => {
    const notice = render();
    expect(notice.textContent).toBe("");
    expect(render({ busy: true, busyBox: "common", waiting: "gm" })).toBe(notice);
    expect(notice.textContent).toMatch(/^Waiting for the GM/);
    expect(notice.getAttribute("data-tone")).toBe("wait");
    render();
    expect(notice.textContent).toBe("");
  });
});

describe("morph", () => {
  it("brings attributes and text up to date and returns the kept node", () => {
    const old = doc.createElement("div");
    old.innerHTML = `<p class="a" title="x">one</p>`;
    doc.body.appendChild(old);
    const p = old.querySelector("p");
    const fresh = doc.createElement("div");
    fresh.innerHTML = `<p class="b">two</p>`;
    expect(morph(old, fresh)).toBe(old);
    expect(old.querySelector("p")).toBe(p);
    expect(p.className).toBe("b");
    expect(p.hasAttribute("title")).toBe(false);
    expect(p.textContent).toBe("two");
  });
  it("replaces a node of another tag or key", () => {
    const host = doc.createElement("div");
    host.innerHTML = `<div data-box="a"></div>`;
    const fresh = doc.createElement("div");
    fresh.innerHTML = `<div data-box="b"></div>`;
    morph(host, fresh);
    expect(host.children.map(c => c.getAttribute("data-box"))).toEqual(["b"]);
  });
});
