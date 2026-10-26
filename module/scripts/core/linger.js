/*
  Finished game windows close by themselves (VIB-206). After a pull's
  result has landed, or a table round has been settled or called off, the
  window counts down the delay each player picks in Game Settings ("Close
  finished game windows": never, 10 s, 30 s or 1 minute; 30 s unless they
  change it) and then closes the way its Close button does. Nothing is
  lost: the chat card's Watch again plays the result again.

  Never while someone is using the window: the countdown pauses while the
  pointer is over it, while the keyboard is at work in it (a key pressed
  there, or focus moved into it by the user), while it replays, and while
  the page is hidden (a player in another tab comes back to the result,
  not to a window that went while nobody looked), and resumes with the
  time it had left once all of those have stopped. Focus
  the window itself puts on its Close at the landing (reveal.js, as it
  always has) doesn't count: that is the window offering its button, not
  someone using it, and counting it would keep every buyer's window open.
  A mouse click leaves focus on the button it pressed without the browser
  showing a focus ring (:focus-visible), and that doesn't count either:
  the pointer leaving is the end of that use.

  A quiet line in the window's actions row says when it will close ("Closes
  in 30 s", once a second; "Paused, 12 s left" while in use) with Keep open
  beside it, which stops the countdown for good and takes the line away.
  The line sits in the row of buttons under the vault, so nothing above it
  moves. The number isn't a live region: read every second it would drown
  the table, and the countdown isn't news. Off draws nothing at all.

  Pure: no Foundry globals. The countdown takes its clock and timers
  (tests pass fake ones); the line is built with the window's own document.
  WCAG 2.2.1 (Timing Adjustable): the delay can be turned off, it waits
  while the window is in use, and Keep open extends it without limit.
*/
import { t } from "./i18n.js";

// The choices in Game Settings, in seconds; 0 is "never".
export const LINGER_SECONDS = [0, 10, 30, 60];
export const LINGER_DEFAULT = 30;

// A stored value as one of the choices, in milliseconds: anything that
// isn't one (a setting not registered yet, a value from an older build)
// reads as the default.
export function lingerMs(value) {
  const n = value == null || value === "" || typeof value === "boolean" ? NaN : Number(value);
  return (LINGER_SECONDS.includes(n) ? n : LINGER_DEFAULT) * 1000;
}

// The line's words for a countdown's view.
export function lingerText({ seconds, paused }) {
  return paused ? t("LOOTCRATES.Linger.Paused", { seconds }) : t("LOOTCRATES.Linger.ClosesIn", { seconds });
}

// The line as markup (the harness draws it the way the window does).
export function lingerHTML(view, esc = s => String(s ?? "")) {
  return `<div class="lc-linger"><span class="lc-linger__text">${esc(lingerText(view))}</span>`
    + `<button type="button" class="lc-linger__keep">${esc(t("LOOTCRATES.Linger.Keep"))}</button></div>`;
}

/*
  The countdown. start(ms) begins it (again, from the full time, when it
  is already running: a replay that ended); pause(reason) and
  resume(reason) hold it while any reason holds and let it run on with the
  time left; keep() stops it for good; stop() ends it with the window.
  onChange is called whenever what the line says changes (each second, a
  pause, a resume, the end), onExpire once when the time runs out.
*/
export function createCountdown({ onExpire = () => {}, onChange = () => {}, now = () => Date.now(), setTimer = (fn, ms) => globalThis.setTimeout(fn, ms), clearTimer = id => globalThis.clearTimeout(id) } = {}) {
  const reasons = new Set();
  let running = false, kept = false, ended = false;
  let left = 0, deadline = null, timer = null;

  const clear = () => { if (timer != null) clearTimer(timer); timer = null; };
  const remaining = () => Math.max(0, deadline != null ? deadline - now() : left);
  const expire = () => {
    clear();
    running = false;
    ended = true;
    deadline = null;
    onChange();
    onExpire();
  };
  // One timer at a time: to the next whole second the line shows, or the end.
  const schedule = () => {
    clear();
    const rem = remaining();
    if (rem <= 0) { expire(); return; }
    timer = setTimer(() => {
      timer = null;
      if (remaining() <= 0) expire();
      else { onChange(); schedule(); }
    }, rem % 1000 || 1000);
  };

  return {
    start(ms) {
      if (kept || ended) return;
      clear();
      deadline = null;
      if (!(ms > 0)) { running = false; onChange(); return; }
      running = true;
      left = ms;
      if (!reasons.size) { deadline = now() + ms; schedule(); }
      onChange();
    },
    pause(reason) {
      if (reasons.has(reason)) return;
      reasons.add(reason);
      if (reasons.size > 1 || !running || deadline == null) return;
      left = remaining();
      deadline = null;
      clear();
      onChange();
    },
    resume(reason) {
      if (!reasons.delete(reason) || reasons.size || !running) return;
      deadline = now() + left;
      schedule();
      onChange();
    },
    keep() {
      if (kept) return;
      kept = true;
      running = false;
      deadline = null;
      clear();
      onChange();
    },
    stop() {
      ended = true;
      running = false;
      deadline = null;
      clear();
    },
    view() {
      return { running, kept, ended, paused: reasons.size > 0, reasons: [...reasons], seconds: Math.ceil(remaining() / 1000) };
    },
  };
}

/*
  The countdown wired to a window: watch(el) listens on the window's
  element for the pointer and the keyboard, mount(row) puts the line in its
  actions row (again after a redraw), focus(node) moves focus without
  counting it as use. `onKeep` is told when Keep open is pressed, with
  whether it had focus, so the window can put focus on its Close.
*/
export class Linger {
  #countdown;
  #row = null;
  #line = null;
  #text = null;
  #quiet = false;
  #watched = null;
  #onVisibility = null;
  #onKeep;

  constructor({ onExpire, onKeep = () => {}, timers = {} } = {}) {
    this.#onKeep = onKeep;
    this.#countdown = createCountdown({
      ...timers,
      onChange: () => this.#paint(),
      onExpire: () => {
        try { onExpire?.(); } catch (err) { console.error("loot-crates | a finished window failed to close", err); }
      },
    });
  }

  get view() { return this.#countdown.view(); }
  start(ms) {
    this.#focusGone();
    this.#countdown.start(ms);
  }
  pause(reason) { this.#countdown.pause(reason); }
  resume(reason) { this.#countdown.resume(reason); }
  keep() { this.#countdown.keep(); }
  stop() {
    this.#countdown.stop();
    this.#paint();
    if (this.#onVisibility) this.#onVisibility.doc.removeEventListener?.("visibilitychange", this.#onVisibility.fn);
    this.#onVisibility = null;
  }

  // Focus moved by the window, not the user (its Close at the landing).
  focus(node) {
    this.#quiet = true;
    try { node?.focus?.({ preventScroll: true }); } finally { this.#quiet = false; }
  }

  watch(el) {
    if (!el?.addEventListener || this.#watched === el) return;
    this.#watched = el;
    el.addEventListener("pointerenter", () => this.pause("pointer"));
    el.addEventListener("pointerleave", () => this.resume("pointer"));
    el.addEventListener("keydown", () => this.pause("keyboard"));
    el.addEventListener("focusin", event => {
      if (this.#quiet || !keyboardFocus(event.target)) return;
      this.pause("keyboard");
    });
    // Out of the window altogether, not from one of its buttons to another.
    el.addEventListener("focusout", event => {
      if (event.relatedTarget && el.contains?.(event.relatedTarget)) return;
      this.resume("keyboard");
    });
    const doc = el.ownerDocument ?? globalThis.document;
    if (!doc?.addEventListener || this.#onVisibility || this.view.ended) return;
    const fn = () => (doc.visibilityState === "hidden" ? this.pause("hidden") : this.resume("hidden"));
    this.#onVisibility = { doc, fn };
    doc.addEventListener("visibilitychange", fn);
    fn();
  }

  // A browser may send no focusout when the focused node is removed (a bet
  // button gone in a redraw): focus no longer in the window ends that use.
  #focusGone() {
    const el = this.#watched;
    const active = (el?.ownerDocument ?? globalThis.document)?.activeElement;
    if (el?.contains && !el.contains(active)) this.resume("keyboard");
  }

  // The actions row the line lives in; the line follows a redraw into the new one.
  mount(row) {
    this.#focusGone();
    if (this.#row === row && this.#line?.parentNode === row) return;
    this.#line?.remove?.();
    this.#line = null;
    this.#row = row ?? null;
    this.#paint();
  }

  #paint() {
    const view = this.#countdown.view();
    if (!view.running) {
      this.#line?.remove?.();
      this.#line = null;
      return;
    }
    if (!this.#line && this.#row) this.#build(this.#row);
    if (this.#text) {
      const text = lingerText(view);
      if (this.#text.textContent !== text) this.#text.textContent = text;
    }
    this.#line?.classList?.[view.paused ? "add" : "remove"]?.("lc-linger--paused");
  }

  #build(row) {
    const doc = row.ownerDocument ?? globalThis.document;
    if (!doc?.createElement) return;
    const line = doc.createElement("div");
    line.className = "lc-linger";
    const text = doc.createElement("span");
    text.className = "lc-linger__text";
    const keep = doc.createElement("button");
    keep.type = "button";
    keep.className = "lc-linger__keep";
    keep.textContent = t("LOOTCRATES.Linger.Keep");
    keep.addEventListener?.("click", event => {
      event?.preventDefault?.();
      const had = doc.activeElement === keep;
      this.keep();
      this.#onKeep({ hadFocus: had });
    });
    line.append(text, keep);
    // First in the row, before the buttons it sits beside.
    if (typeof row.insertBefore === "function") row.insertBefore(line, row.firstChild ?? row.childNodes?.[0] ?? null);
    else row.append?.(line);
    this.#line = line;
    this.#text = text;
  }
}

// Whether focus arrived the way a keyboard (or a screen reader) brings it:
// the browser shows its ring. A button a mouse pressed doesn't.
function keyboardFocus(node) {
  try { return node?.matches?.(":focus-visible") ?? true; } catch { return true; }
}
