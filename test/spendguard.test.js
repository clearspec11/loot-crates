/*
  The second press for a large spend (currency.js largeSpend, views/
  spendguard.js): a price more than half the purse arms the pressed button
  first, which then says what it will spend, keeping its node, its
  screen-reader prefix and its aria-disabled; the second press sends. It
  disarms on Escape, on focus leaving, on a press anywhere else and on a
  re-render (patchShop's morph). In the shop it guards Buy and Buy to
  keep, at the button's data-price; a press it only armed sends nothing.
*/
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createDocument } from "./minidom.js";
import { largeSpend } from "../module/scripts/core/currency.js";
import { spendPress, armSpend, disarmSpend, isArmed, ARM_GRACE_MS } from "../module/scripts/views/spendguard.js";
import { cardShell, patchShop, shopHTML } from "../module/scripts/views/boxcard.js";
// The crate registers its kind, so its card has a Buy to keep (ticket.js ticketable).
import "../module/scripts/games/crate.js";

describe("largeSpend", () => {
  it("is a price over half the purse, counted in copper", () => {
    expect(largeSpend({ gp: 300 }, 150)).toBe(false);
    expect(largeSpend({ gp: 300 }, 150.01)).toBe(true);
    expect(largeSpend({ gp: 300, cp: 2 }, 150.01)).toBe(false);
    expect(largeSpend({ gp: 300 }, 149)).toBe(false);
    // Every coin counts: 1 pp 5 ep 3 sp is 12 gp 8 sp.
    expect(largeSpend({ pp: 1, ep: 5, sp: 3 }, 6.4)).toBe(false);
    expect(largeSpend({ pp: 1, ep: 5, sp: 3 }, 6.41)).toBe(true);
  });

  it("is never a price of nothing or one that isn't a number", () => {
    expect(largeSpend({ gp: 0 }, 0)).toBe(false);
    expect(largeSpend({}, Number.NaN)).toBe(false);
    expect(largeSpend({}, "x")).toBe(false);
    expect(largeSpend({}, -5)).toBe(false);
    // An empty purse: any price is over half of it.
    expect(largeSpend({}, 0.01)).toBe(true);
  });
});

let doc;
beforeEach(() => {
  doc = createDocument();
  vi.stubGlobal("document", doc);
});
afterEach(() => { vi.unstubAllGlobals(); });

// A Buy as cardShell draws it, in a card in the page.
function buyButton(html = `<button type="button" class="lc-box__buy" data-action="buy" data-box="big" data-price="300"><span class="lc-sr-only">Big Box: </span>Open for 300 gp</button>`) {
  const host = doc.createElement("div");
  host.innerHTML = html;
  doc.body.append(host);
  return host.querySelector("button");
}
const purse = { gp: 420, sp: 7, cp: 3 };
const visible = btn => btn.childNodes.filter(n => !(n.nodeType === 1 && n.classList.contains("lc-sr-only"))).map(n => n.textContent).join("").trim();

describe("spendPress", () => {
  it("sends a spend of half the purse or less at once, arming nothing", () => {
    const btn = buyButton();
    expect(spendPress(btn, { purse: { gp: 600 }, price: 300, now: 0 })).toBe(true);
    expect(isArmed(btn)).toBe(false);
    expect(btn.textContent).toBe("Big Box: Open for 300 gp");
  });

  it("arms a larger one on the first press: the same node asks what it will spend, after its name for screen readers", () => {
    const btn = buyButton();
    btn.setAttribute("aria-describedby", "lc-why-big");
    btn.focus();
    expect(spendPress(btn, { purse, price: 300, now: 1000 })).toBe(false);
    expect(isArmed(btn)).toBe(true);
    expect(btn.textContent).toBe("Big Box: Spend 300 gp?");
    expect(visible(btn)).toBe("Spend 300 gp?");
    expect(doc.activeElement).toBe(btn);
    expect(btn.hasAttribute("disabled")).toBe(false);
    expect(btn.getAttribute("aria-disabled")).toBeNull();
    expect(btn.dataset.price).toBe("300");
    expect(btn.getAttribute("aria-describedby")).toBe("lc-why-big");
  });

  it("sends on the second press and puts the button's own words back", () => {
    const btn = buyButton();
    spendPress(btn, { purse, price: 300, now: 1000 });
    expect(spendPress(btn, { purse, price: 300, now: 1000 + ARM_GRACE_MS + 1, event: { detail: 1 } })).toBe(true);
    expect(isArmed(btn)).toBe(false);
    expect(btn.textContent).toBe("Big Box: Open for 300 gp");
    // And the next press asks again.
    expect(spendPress(btn, { purse, price: 300, now: 5000 })).toBe(false);
  });

  it("never asks and spends in one gesture: a double-click's second click or a press within the grace does nothing", () => {
    const btn = buyButton();
    spendPress(btn, { purse, price: 300, now: 1000 });
    expect(spendPress(btn, { purse, price: 300, now: 1000 + ARM_GRACE_MS + 50, event: { detail: 2 } })).toBe(false);
    expect(spendPress(btn, { purse, price: 300, now: 1100 })).toBe(false);
    expect(isArmed(btn)).toBe(true);
  });

  it("ignores the presses a held Enter repeats past the grace, until the key comes up", () => {
    const btn = buyButton();
    spendPress(btn, { purse, price: 300, now: 1000 });
    // The key is still down: the browser repeats its keydown, and each one presses.
    btn.dispatchEvent({ type: "keydown", key: "Enter", repeat: true });
    expect(spendPress(btn, { purse, price: 300, now: 1600 })).toBe(false);
    expect(isArmed(btn)).toBe(true);
    btn.dispatchEvent({ type: "keyup", key: "Enter" });
    btn.dispatchEvent({ type: "keydown", key: "Enter", repeat: false });
    expect(spendPress(btn, { purse, price: 300, now: 2000 })).toBe(true);
  });

  it("asks again at the new price when the price moved between the presses", () => {
    const btn = buyButton();
    spendPress(btn, { purse, price: 300, now: 1000 });
    expect(spendPress(btn, { purse, price: 330, now: 9000 })).toBe(false);
    expect(visible(btn)).toBe("Spend 330 gp?");
    expect(spendPress(btn, { purse, price: 330, now: 9000 + ARM_GRACE_MS + 1 })).toBe(true);
  });

  it("disarms on Escape, kept from the window, and on focus leaving it", () => {
    const btn = buyButton();
    spendPress(btn, { purse, price: 300, now: 0 });
    const esc = { type: "keydown", key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() };
    btn.dispatchEvent({ type: "keydown", key: "Enter", preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(isArmed(btn)).toBe(true);
    btn.dispatchEvent(esc);
    expect(isArmed(btn)).toBe(false);
    expect(esc.preventDefault).toHaveBeenCalled();
    expect(esc.stopPropagation).toHaveBeenCalled();
    expect(btn.textContent).toBe("Big Box: Open for 300 gp");
    // Escape on a button that isn't asking is left to the window.
    const later = { type: "keydown", key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() };
    btn.dispatchEvent(later);
    expect(later.stopPropagation).not.toHaveBeenCalled();

    spendPress(btn, { purse, price: 300, now: 0 });
    btn.dispatchEvent({ type: "focusout", relatedTarget: btn.querySelector(".lc-sr-only") });
    expect(isArmed(btn)).toBe(true);
    btn.dispatchEvent({ type: "focusout", relatedTarget: doc.body });
    expect(isArmed(btn)).toBe(false);
  });

  it("disarms on a press anywhere else, not on itself, and takes its listener off the page", () => {
    const btn = buyButton();
    const other = buyButton(`<button type="button" class="lc-box__keep">Buy to keep</button>`);
    spendPress(btn, { purse, price: 300, now: 0 });
    expect(doc.listenerCount("pointerdown")).toBe(1);
    doc.dispatchEvent({ type: "pointerdown", target: btn.querySelector(".lc-sr-only") });
    expect(isArmed(btn)).toBe(true);
    doc.dispatchEvent({ type: "pointerdown", target: other });
    expect(isArmed(btn)).toBe(false);
    expect(doc.listenerCount("pointerdown")).toBe(0);
    // Arming twice keeps one listener.
    armSpend(btn, 300);
    armSpend(btn, 300);
    expect(doc.listenerCount("pointerdown")).toBe(1);
    expect(disarmSpend(btn)).toBe(true);
    expect(disarmSpend(btn)).toBe(false);
  });
});

describe("the shop's cards, armed", () => {
  const BIG = { id: "big", name: "Big Box", price: 300, pools: [], weights: {} };
  const ctx = (extra = {}) => ({ purse, hasActor: true, open: true, gmOnline: true, actorId: "a1", actorName: "Tam", esc: s => String(s ?? ""), ...extra });
  const body = c => {
    const fresh = doc.createElement("div");
    fresh.className = "lc-shop__body";
    fresh.innerHTML = shopHTML({ fields: "", cards: cardShell(BIG, c, { rarityClass: "lc-rarity-rare", label: "Open for 300 gp" }), notice: { text: "", tone: "" } });
    return fresh;
  };

  it("Buy to keep asks in one line where its two spans were, and both come back on a re-render, on the same nodes", () => {
    const content = doc.createElement("div");
    doc.body.append(content);
    patchShop(content, body(ctx()), { text: "", tone: "" });
    const buy = content.querySelector(".lc-box__buy");
    const keep = content.querySelector(".lc-box__keep");
    keep.focus();
    expect(spendPress(keep, { purse, price: Number(keep.dataset.price), now: 0 })).toBe(false);
    expect(keep.textContent).toBe("Big Box: Spend 300 gp?");
    expect(keep.querySelector(".lc-box__keep-do")).toBeNull();
    expect(keep.querySelectorAll(".lc-spend-ask").length).toBe(1);
    expect(keep.dataset.keep).toBe("big");
    expect(keep.dataset.action).toBe("keep");
    expect(keep.dataset.price).toBe("300");
    expect(spendPress(buy, { purse, price: 300, now: 0 })).toBe(false);
    // The purse changed: the shop draws again, and nothing is asking any more.
    patchShop(content, body(ctx({ purse: { gp: 500 } })), { text: "", tone: "" });
    expect(content.querySelector(".lc-box__keep")).toBe(keep);
    expect(content.querySelector(".lc-box__buy")).toBe(buy);
    expect(doc.activeElement).toBe(keep);
    expect(isArmed(keep) || isArmed(buy)).toBe(false);
    expect(keep.querySelector(".lc-box__keep-do")?.textContent).toBe("Buy to keep");
    expect(buy.textContent.trim()).toBe("Big Box: Open for 300 gp");
    // Its next press asks again rather than sending.
    expect(spendPress(keep, { purse, price: 300, now: 10_000 })).toBe(false);
    expect(isArmed(keep)).toBe(true);
  });
});
