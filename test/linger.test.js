/*
  Finished game windows close by themselves (linger.js, VIB-206): the
  setting's value as a delay, the countdown (start, the seconds the line
  shows, pause and resume with the time left, reasons that nest, Keep
  open, a restart, Off), and the line wired to a window in a minimal DOM:
  the pointer and the keyboard hold it, focus the window moves itself
  doesn't, a hidden page holds it, Keep open takes the line away.
*/
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDocument } from "./minidom.js";
import { LINGER_SECONDS, LINGER_DEFAULT, lingerMs, lingerText, lingerHTML, createCountdown, Linger } from "../module/scripts/core/linger.js";

// A clock and timers the test moves by hand.
function fakeTime() {
  let t = 0, next = 1;
  const timers = new Map();
  const api = {
    now: () => t,
    setTimer: (fn, ms) => { const id = next++; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: id => { timers.delete(id); },
    pending: () => timers.size,
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
    },
  };
  return api;
}

describe("the setting", () => {
  it("offers never, 10 s, 30 s and a minute, 30 s by default", () => {
    expect(LINGER_SECONDS).toEqual([0, 10, 30, 60]);
    expect(LINGER_DEFAULT).toBe(30);
  });

  it("reads a stored choice as milliseconds, and anything else as the default", () => {
    expect(lingerMs(0)).toBe(0);
    expect(lingerMs(10)).toBe(10000);
    expect(lingerMs("60")).toBe(60000);
    for (const odd of [undefined, null, "", true, 1, 45, "soon", NaN]) expect(lingerMs(odd)).toBe(30000);
  });

  it("says when the window closes, or that it is paused, in the module's words", () => {
    expect(lingerText({ seconds: 12, paused: false })).toBe("Closes in 12 s");
    expect(lingerText({ seconds: 12, paused: true })).toBe("Paused, 12 s left");
    const html = lingerHTML({ seconds: 30, paused: false });
    expect(html).toContain("Closes in 30 s");
    expect(html).toContain(">Keep open</button>");
    expect(html).not.toMatch(/aria-live|role=/);
  });
});

describe("the countdown", () => {
  let time, expired, changes, cd;
  beforeEach(() => {
    time = fakeTime();
    expired = vi.fn();
    changes = 0;
    cd = createCountdown({ onExpire: expired, onChange: () => { changes++; }, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer });
  });

  it("runs from the full time to the end, a second at a time, and expires once", () => {
    cd.start(10000);
    expect(cd.view()).toMatchObject({ running: true, paused: false, seconds: 10 });
    time.advance(999);
    expect(cd.view().seconds).toBe(10);
    time.advance(1);
    expect(cd.view().seconds).toBe(9);
    const seen = changes;
    time.advance(1000);
    expect(changes).toBe(seen + 1);
    time.advance(7999);
    expect(expired).not.toHaveBeenCalled();
    time.advance(1);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(cd.view()).toMatchObject({ running: false, ended: true });
    time.advance(60000);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(time.pending()).toBe(0);
  });

  it("pauses and resumes with the time it had left", () => {
    cd.start(10000);
    time.advance(3500);
    cd.pause("pointer");
    expect(cd.view()).toMatchObject({ paused: true, seconds: 7 });
    time.advance(60000);
    expect(expired).not.toHaveBeenCalled();
    expect(cd.view().seconds).toBe(7);
    cd.resume("pointer");
    expect(cd.view()).toMatchObject({ paused: false, seconds: 7 });
    time.advance(6499);
    expect(expired).not.toHaveBeenCalled();
    time.advance(1);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("holds while any reason holds: they nest, and one held twice is let go once", () => {
    cd.start(10000);
    time.advance(2000);
    cd.pause("pointer");
    cd.pause("keyboard");
    cd.pause("pointer");
    cd.resume("pointer");
    time.advance(30000);
    expect(cd.view()).toMatchObject({ paused: true, reasons: ["keyboard"], seconds: 8 });
    cd.resume("nothing held");
    expect(cd.view().paused).toBe(true);
    cd.resume("keyboard");
    expect(cd.view().paused).toBe(false);
    time.advance(8000);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("starts held when a reason already holds (the pointer was over the window as it landed)", () => {
    cd.pause("pointer");
    cd.start(10000);
    expect(cd.view()).toMatchObject({ running: true, paused: true, seconds: 10 });
    time.advance(20000);
    expect(expired).not.toHaveBeenCalled();
    cd.resume("pointer");
    time.advance(10000);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("starts over from the full time when started again (a replay ended)", () => {
    cd.start(10000);
    time.advance(9000);
    cd.start(10000);
    expect(cd.view().seconds).toBe(10);
    time.advance(9999);
    expect(expired).not.toHaveBeenCalled();
    time.advance(1);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("Keep open stops it for good: no expiry, and a later start does nothing", () => {
    cd.start(10000);
    time.advance(4000);
    cd.keep();
    expect(cd.view()).toMatchObject({ running: false, kept: true });
    cd.start(10000);
    cd.resume("pointer");
    time.advance(60000);
    expect(expired).not.toHaveBeenCalled();
    expect(cd.view().running).toBe(false);
    expect(time.pending()).toBe(0);
  });

  it("Off (0) never runs, and stop() ends it with the window", () => {
    cd.start(0);
    expect(cd.view().running).toBe(false);
    time.advance(60000);
    expect(expired).not.toHaveBeenCalled();
    cd.start(10000);
    cd.stop();
    time.advance(60000);
    expect(expired).not.toHaveBeenCalled();
    cd.start(10000);
    expect(cd.view().running).toBe(false);
  });
});

describe("the line on a window", () => {
  let doc, time, win, row, close, expired, kept, linger;
  // Focus as a browser moves it: focusin on the node and up to the window.
  const focusIn = (node, from = null) => {
    from?.dispatchEvent?.({ type: "focusout", target: from, relatedTarget: node });
    for (let n = from; n; n = n.parentNode) if (n !== from) n.dispatchEvent?.({ type: "focusout", target: from, relatedTarget: node });
    doc.activeElement = node;
    for (let n = node; n; n = n.parentNode) n.dispatchEvent?.({ type: "focusin", target: node });
  };
  const focusOut = (node, to) => {
    for (let n = node; n; n = n.parentNode) n.dispatchEvent?.({ type: "focusout", target: node, relatedTarget: to });
    doc.activeElement = to;
  };
  const text = () => win.querySelector(".lc-linger__text")?.textContent ?? null;

  beforeEach(() => {
    doc = createDocument();
    const listeners = new Map();
    doc.visibilityState = "visible";
    doc.addEventListener = (type, fn) => listeners.set(type, fn);
    doc.removeEventListener = type => listeners.delete(type);
    doc.fire = type => listeners.get(type)?.();
    doc.listeners = listeners;
    win = doc.createElement("section");
    win.innerHTML = `<div class="lc-reveal__actions"><button type="button" class="lc-reveal__open">Open item</button><button type="button" class="lc-reveal__close">Close</button></div>`;
    doc.body.append(win);
    row = win.querySelector(".lc-reveal__actions");
    close = win.querySelector(".lc-reveal__close");
    time = fakeTime();
    expired = vi.fn();
    kept = vi.fn();
    linger = new Linger({ onExpire: expired, onKeep: kept, timers: { now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer } });
    linger.watch(win);
    linger.mount(row);
  });

  it("draws nothing until it starts, then the line first in the actions row, and nothing once it ends", () => {
    expect(win.querySelector(".lc-linger")).toBeNull();
    linger.start(10000);
    const line = win.querySelector(".lc-linger");
    expect(row.firstElementChild).toBe(line);
    expect(text()).toBe("Closes in 10 s");
    expect(line.querySelector("button.lc-linger__keep").textContent).toBe("Keep open");
    expect(line.getAttribute("aria-live")).toBeNull();
    time.advance(1000);
    expect(text()).toBe("Closes in 9 s");
    time.advance(9000);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(win.querySelector(".lc-linger")).toBeNull();
  });

  it("Off draws nothing at all", () => {
    linger.start(0);
    expect(win.querySelector(".lc-linger")).toBeNull();
  });

  it("holds while the pointer is over the window and says so", () => {
    linger.start(10000);
    time.advance(2000);
    win.dispatchEvent({ type: "pointerenter" });
    expect(text()).toBe("Paused, 8 s left");
    expect(win.querySelector(".lc-linger").classList.contains("lc-linger--paused")).toBe(true);
    time.advance(30000);
    expect(expired).not.toHaveBeenCalled();
    win.dispatchEvent({ type: "pointerleave" });
    expect(text()).toBe("Closes in 8 s");
    time.advance(8000);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("holds while focus the user brought is inside, across moves within, until it leaves", () => {
    linger.start(10000);
    const outside = doc.createElement("input");
    doc.body.append(outside);
    focusIn(close, outside);
    expect(linger.view.paused).toBe(true);
    focusIn(win.querySelector(".lc-reveal__open"), close);
    expect(linger.view.paused).toBe(true);
    time.advance(30000);
    expect(expired).not.toHaveBeenCalled();
    focusOut(win.querySelector(".lc-reveal__open"), outside);
    expect(linger.view.paused).toBe(false);
    time.advance(10000);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("doesn't count focus the window put on its own Close (the landing), until a key is pressed there", () => {
    const proto = Object.getPrototypeOf(close);
    const plain = proto.focus;
    proto.focus = function () { plain.call(this); for (let n = this; n; n = n.parentNode) n.dispatchEvent?.({ type: "focusin", target: this }); };
    try {
      linger.focus(close);
      expect(doc.activeElement).toBe(close);
      linger.start(10000);
      expect(linger.view.paused).toBe(false);
      close.focus();
      expect(linger.view.paused).toBe(true);
    } finally { proto.focus = plain; }
    linger.resume("keyboard");
    linger.focus(close);
    expect(linger.view.paused).toBe(false);
    win.dispatchEvent({ type: "keydown", key: "Tab" });
    expect(linger.view.paused).toBe(true);
  });

  it("doesn't count a button a mouse pressed (no focus ring): the pointer leaving ends that use", () => {
    linger.start(10000);
    const open = win.querySelector(".lc-reveal__open");
    open.matches = sel => (sel === ":focus-visible" ? false : Object.getPrototypeOf(open).matches.call(open, sel));
    win.dispatchEvent({ type: "pointerenter" });
    focusIn(open);
    win.dispatchEvent({ type: "pointerleave" });
    expect(linger.view.paused).toBe(false);
  });

  it("holds while the page is hidden, and stops listening once the window is gone", () => {
    linger.start(10000);
    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    time.advance(60000);
    expect(expired).not.toHaveBeenCalled();
    doc.visibilityState = "visible";
    doc.fire("visibilitychange");
    time.advance(10000);
    expect(expired).toHaveBeenCalledTimes(1);
    linger.stop();
    expect(doc.listeners.has("visibilitychange")).toBe(false);
  });

  it("a window that opens on a hidden page starts held", () => {
    const other = new Linger({ onExpire: expired, timers: { now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer } });
    const win2 = doc.createElement("section");
    doc.visibilityState = "hidden";
    other.watch(win2);
    other.start(10000);
    expect(other.view.paused).toBe(true);
  });

  it("Keep open takes the line away, stops the countdown for good and says whether it had focus", () => {
    linger.start(10000);
    const keep = win.querySelector(".lc-linger__keep");
    doc.activeElement = keep;
    keep.dispatchEvent({ type: "click", preventDefault() {} });
    expect(win.querySelector(".lc-linger")).toBeNull();
    expect(kept).toHaveBeenCalledWith({ hadFocus: true });
    expect(linger.view).toMatchObject({ running: false, kept: true });
    linger.start(10000);
    time.advance(60000);
    expect(expired).not.toHaveBeenCalled();
    expect(win.querySelector(".lc-linger")).toBeNull();
  });

  it("follows a redraw into the new actions row", () => {
    linger.start(10000);
    row.remove();
    win.innerHTML = `<div class="lc-reveal__actions"><button type="button" class="lc-reveal__close">Close</button></div>`;
    const fresh = win.querySelector(".lc-reveal__actions");
    linger.mount(fresh);
    expect(fresh.firstElementChild?.classList.contains("lc-linger")).toBe(true);
    expect(win.querySelectorAll(".lc-linger").length).toBe(1);
    time.advance(1000);
    expect(text()).toBe("Closes in 9 s");
  });

  it("a window whose close throws is logged, not thrown into the timer", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = new Linger({ onExpire: () => { throw new Error("gone"); }, timers: { now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer } });
    bad.start(1000);
    expect(() => time.advance(1000)).not.toThrow();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("focus removed with its node", () => {
  it("doesn't hold the countdown once focus is no longer in the window (no focusout came)", () => {
    const doc = createDocument();
    const win = doc.createElement("section");
    win.innerHTML = `<form><button type="submit" class="lc-table__bet">Place a bet</button></form><div class="lc-reveal__actions"><button type="button" class="lc-reveal__close">Close</button></div>`;
    doc.body.append(win);
    const time = fakeTime();
    const expired = vi.fn();
    const linger = new Linger({ onExpire: expired, timers: { now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer } });
    linger.watch(win);
    const bet = win.querySelector(".lc-table__bet");
    doc.activeElement = bet;
    win.dispatchEvent({ type: "focusin", target: bet });
    expect(linger.view.paused).toBe(true);
    // The redraw drops the form: the browser moves focus to the body.
    win.querySelector("form").remove();
    linger.mount(win.querySelector(".lc-reveal__actions"));
    linger.start(10000);
    expect(linger.view.paused).toBe(false);
    time.advance(10000);
    expect(expired).toHaveBeenCalledTimes(1);
  });
});
