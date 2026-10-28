/*
  The scratch: gold foil over a ticket's panels, taken off by a coin, as the
  approved mockup (.council/fortune-ticket-mockup.html, research section
  5a) has it. scratch.js draws the ticket and lights the winners; this is
  the foil, the coin, the shavings and the timing, plain DOM and canvas
  with no Foundry in it, so the harness and Vitest run it as it is.

  - The buyer scratches by hand. Over the foil the pointer is hidden and a
    gold coin follows it, tilted into the stroke and pressed down while the
    button is held (on a phone it sits a little above the fingertip). The
    scrape is the coin's edge: a band 32 css px wide along the stroke with
    round caps, up to 1.35x as wide at speed, its rim ragged with small
    bites along both edges. Never a round rubber.
  - The foil is a pointer-driven mask, not an animation: each panel's canvas
    is erased (destination-out) inside the pointer's own events. What
    moves by itself runs on one requestAnimationFrame loop for the whole
    ticket, and only while something is moving: the shavings (curls off the
    coin's edge, falling and fading over about half a second, at most 160
    live, on one canvas over the ticket), the 60% check of a panel that was
    scratched since the last frame, a panel's crumble, and the spectators'
    sweep.
  - A panel gives at 60% scratched, read from a coarse grid of samples
    across it (12 a side) that each stroke marks where the band passed: the
    rest of its foil crumbles over 160 ms with a burst of shavings, then it
    opens (its canvas goes, and the number pops in by CSS). The ticket lands
    once every panel is open.
  - Everyone else at the table watches: the same coin scrapes the card by
    itself, panel by panel (380 ms each, the whole card in about five
    seconds at most), with the same shavings and rasp, and lands when every
    panel is open.
  - Keyboard: the panels are a roving group (one tab stop); the arrow keys,
    Home and End move between them, Space or Enter scratches the focused
    one, R reveals the whole card. A screen reader hears "Panel 3, covered"
    and then what the panel shows once it opens.
  - Reduced motion: no shavings, no crumble, no pop. A spectator's card
    opens at once; the buyer still scratches, and a panel just opens at 60%.
  - The result never depends on any of this: the card arrived decided.
  - The foil itself is the mockup's: silver with faint rainbow bands, a
    diamond lattice and a gold-ringed stamp with SCRATCH on it (the one
    word on the ticket set in capitals by hand: it is a stamp), painted
    on each panel's canvas from the tokens in module.css.

    const foil = mountFoil(ticketEl, { cols, buyer, reducedMotion, duration, sounds, onOpen, onLand });
    await foil.play();           // the buyer's input goes live, or the sweep starts
    foil.open(i); foil.revealAll(); foil.skip();
    foil.skipped, foil.reducedMotion, foil.opened(), foil.count

  `sounds` is { scratch(speed) -> { rasp(speed), stop() } | null, tick() };
  `onOpen(index, { all })` fires as each panel opens, in DOM order of the
  ticket's [data-panel] elements; `onLand()` once, after the last.
*/
import { t } from "../core/i18n.js";

export const FOIL = Object.freeze({
  band: 32,            // the coin's edge, css px
  threshold: 0.6,      // the share of a panel scratched before it gives
  grid: 12,            // coverage samples along each side of a panel
  crumbleMs: 160,
  perPanelMs: 380,     // the spectators' sweep, per panel
  spectatorMs: 5000,   // and the whole card at most
  shavingsCap: 160,
  touchLift: 26,
  lattice: 8,          // the foil's diamond lattice, css px between threads
  stamp: 0.34,         // the stamp's radius as a share of the panel's short side
});

// The band's width for a stroke `len` css px long: 0.85x crawling, 1.35x fast.
export const bandWidth = len => FOIL.band * (0.85 + Math.min(0.5, Math.max(0, len) / 40));

// The foil's colours, read from the ticket's tokens (module.css) when
// there is a style to read: the holographic bands (a comma list), the
// stamp's ring and ink, the curls' two tones (the foil's hi and ink).
const FOIL_FALLBACK = { bands: ["#dcdad2", "#e9d3e4", "#cfe3ee", "#dfe9d2", "#eadfbf", "#d0cfc8", "#e6e4dc"], ring: "#b8923a", stamp: "#6e5a2a", curlHi: "#c9c7bf", curlLo: "#8f8d85" };
function foilColours(el) {
  const css = typeof getComputedStyle === "function" ? (() => { try { return getComputedStyle(el); } catch { return null; } })() : null;
  const read = (name, fallback) => css?.getPropertyValue?.(name)?.trim() || fallback;
  const bands = read("--lc-foil-bands", "").split(",").map(c => c.trim()).filter(Boolean);
  return { bands: bands.length >= 2 ? bands : FOIL_FALLBACK.bands, ring: read("--lc-foil-ring", FOIL_FALLBACK.ring), stamp: read("--lc-foil-stamp", FOIL_FALLBACK.stamp), curlHi: read("--lc-foil-hi", FOIL_FALLBACK.curlHi), curlLo: read("--lc-foil-ink", FOIL_FALLBACK.curlLo) };
}

const rectOf = el => el?.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 0, height: 0 };
const raf = fn => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : null);
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

// Distance from point (px, py) to the segment a-b.
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const k = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + k * dx), py - (ay + k * dy));
}

export function mountFoil(ticket, { cols = 4, buyer = false, reducedMotion, duration, sounds = {}, onOpen = null, onLand = null } = {}) {
  const doc = ticket.ownerDocument ?? globalThis.document;
  const reduced = reducedMotion ?? (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const colours = foilColours(ticket);
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const G = FOIL.grid;

  ticket.classList.add("lc-scratch__ticket--covered");
  if (buyer) ticket.dataset.buyer = "1";
  const make = (tag, cls) => { const el = doc.createElement(tag); el.className = cls; el.setAttribute("aria-hidden", "true"); return el; };
  const panels = [...ticket.querySelectorAll("[data-panel]")].map((el, index) => {
    const canvas = make("canvas", "lc-scratch__foil");
    el.appendChild(canvas);
    return { el, index, canvas, ctx: null, w: 0, h: 0, cover: new Uint8Array(G * G), dirty: false, giving: null, open: false };
  });
  const shaveCanvas = make("canvas", "lc-scratch__shavings");
  const coinEl = make("div", "lc-scratch__coin");
  ticket.append(shaveCanvas, coinEl);
  const shave = { ctx: null, w: 0, h: 0, list: [] };

  let landed = false, opened = 0, frame = null, sweep = null, voice = null, resolveDone = null;
  let scratching = false, prev = null, pointerType = "mouse", coinAngle = 0, coinLast = null, focusAt = 0;

  /* ---------- Drawing ---------- */

  // A panel's foil, as the mockup's size() paints it: silver with faint
  // rainbow bands, a diamond lattice (white one way and back, a darker
  // thread offset beside it), and the gold-ringed stamp with the word in
  // the middle; then every later stroke erases. Drawn once its size is
  // known; a panel that changes size later stretches its canvas (the
  // samples are shares, so the 60% stays true).
  function paint(p) {
    if (p.ctx || p.open) return !!p.ctx;
    const r = rectOf(p.el);
    if (!(r.width > 0 && r.height > 0)) return false;
    p.w = r.width; p.h = r.height;
    const ctx = p.canvas.getContext?.("2d") ?? null;
    p.canvas.width = Math.max(1, Math.round(p.w * dpr));
    p.canvas.height = Math.max(1, Math.round(p.h * dpr));
    if (!ctx) { p.ctx = { stub: true }; return true; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = ctx.createLinearGradient(0, 0, p.w, p.h);
    colours.bands.forEach((c, i) => g.addColorStop(i / (colours.bands.length - 1), c));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, p.w, p.h);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255, 255, 255, .45)";
    for (let x = -p.h; x < p.w; x += FOIL.lattice) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + p.h, p.h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x + p.h, 0); ctx.lineTo(x, p.h); ctx.stroke();
    }
    ctx.strokeStyle = "rgba(90, 80, 60, .18)";
    for (let x = -p.h; x < p.w; x += FOIL.lattice) { ctx.beginPath(); ctx.moveTo(x + 4, 0); ctx.lineTo(x + p.h + 4, p.h); ctx.stroke(); }
    const rr = Math.min(p.w, p.h) * FOIL.stamp;
    ctx.beginPath();
    ctx.arc(p.w / 2, p.h / 2, rr, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, .35)";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = colours.ring;
    ctx.stroke();
    ctx.fillStyle = colours.stamp;
    ctx.font = `700 ${Math.max(11, Math.round(rr * 0.42))}px "Roboto Condensed", Roboto, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(t("LOOTCRATES.Scratch.FoilWord").toLocaleUpperCase(), p.w / 2, p.h / 2);
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "#000";
    ctx.strokeStyle = "#000";
    // Until now the canvas's own flat foil (module.css) stood in, so the
    // panel never showed through before its size was known.
    p.canvas.classList.add("lc-scratch__foil--painted");
    p.ctx = ctx;
    return true;
  }

  // The shavings' canvas, over the ticket's padding box.
  function sizeShavings() {
    const w = ticket.clientWidth || rectOf(ticket).width, h = ticket.clientHeight || rectOf(ticket).height;
    if (!(w > 0 && h > 0)) return false;
    if (w === shave.w && h === shave.h && shave.ctx) return true;
    shave.w = w; shave.h = h;
    shaveCanvas.width = Math.round(w * dpr);
    shaveCanvas.height = Math.round(h * dpr);
    shave.ctx = shaveCanvas.getContext?.("2d") ?? null;
    shave.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  // Where a client point sits in a panel, in the panel's painted css px.
  function local(p, cx, cy) {
    const r = rectOf(p.el);
    const sx = r.width ? p.w / r.width : 1, sy = r.height ? p.h / r.height : 1;
    return [(cx - r.left) * sx, (cy - r.top) * sy];
  }
  // A client point in the ticket's padding box (the coin's and the shavings' space).
  function inTicket(cx, cy) {
    const r = rectOf(ticket);
    return [cx - r.left - (ticket.clientLeft || 0), cy - r.top - (ticket.clientTop || 0)];
  }

  // Marks the samples within half the band of the segment.
  function cover(p, ax, ay, bx, by, width) {
    const half = width / 2;
    for (let j = 0; j < G; j++) {
      for (let i = 0; i < G; i++) {
        const k = j * G + i;
        if (p.cover[k]) continue;
        if (segDist(((i + 0.5) / G) * p.w, ((j + 0.5) / G) * p.h, ax, ay, bx, by) <= half) p.cover[k] = 1;
      }
    }
  }
  const scratched = p => p.cover.reduce((n, v) => n + v, 0) / p.cover.length;

  // The coin's edge along a-b in one panel (b alone: the first touch).
  function scrape(p, a, b, width) {
    const [bx, by] = b;
    const [ax, ay] = a ?? b;
    if (Math.max(ax, bx) < -width || Math.min(ax, bx) > p.w + width || Math.max(ay, by) < -width || Math.min(ay, by) > p.h + width) return false;
    const ctx = p.ctx?.stub ? null : p.ctx;
    if (ctx) {
      ctx.lineCap = "round";
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx + (a ? 0 : 0.01), by);
      ctx.stroke();
      if (a) {
        // The ragged rim: small bites along both edges of the band.
        const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len;
        for (let i = 0; i < 4; i++) {
          const s = i % 2 ? 1 : -1, k = Math.random();
          ctx.beginPath();
          ctx.arc(ax + dx * k + nx * s * width * 0.5, ay + dy * k + ny * s * width * 0.5, 2 + Math.random() * 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    cover(p, ax, ay, bx, by, width);
    p.dirty = true;
    return true;
  }

  // One stroke of the coin across the ticket, from client point a to b.
  function stroke(a, b) {
    const len = a ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0;
    const width = bandWidth(len);
    let hit = false;
    for (const p of panels) {
      if (p.open || p.giving || !paint(p)) continue;
      if (scrape(p, a ? local(p, a[0], a[1]) : null, local(p, b[0], b[1]), width)) hit = true;
    }
    if (hit && a && len > 0) {
      const [x, y] = inTicket(b[0], b[1]);
      spawn(x, y, (b[0] - a[0]) / len, (b[1] - a[1]) / len, Math.min(4, 1 + len / 9));
    }
    if (hit) wake();
    return { hit, len };
  }

  /* ---------- Shavings ---------- */

  function spawn(x, y, dx, dy, n) {
    if (reduced || landed) return;
    for (let i = 0; i < n; i++) {
      shave.list.push({
        x, y, vx: dx * (1.5 + Math.random() * 2.5) + (Math.random() - 0.5) * 1.5, vy: dy * 1.5 - 1.2 - Math.random() * 1.6,
        r: 2 + Math.random() * 3, a: Math.random() * 6, spin: (Math.random() - 0.5) * 0.4,
        tone: Math.random() < 0.5 ? colours.curlHi : colours.curlLo, born: now(), life: 380 + Math.random() * 260,
      });
    }
    if (shave.list.length > FOIL.shavingsCap) shave.list.splice(0, shave.list.length - FOIL.shavingsCap);
    wake();
  }

  function drawShavings(at) {
    shave.list = shave.list.filter(s => at - s.born < s.life);
    if (!sizeShavings() || !shave.ctx) return;
    const ctx = shave.ctx;
    ctx.clearRect(0, 0, shave.w, shave.h);
    for (const s of shave.list) {
      const k = (at - s.born) / s.life;
      s.x += s.vx; s.y += s.vy; s.vy += 0.22; s.vx *= 0.96; s.a += s.spin;
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.a);
      ctx.globalAlpha = Math.max(0, 1 - k);
      ctx.strokeStyle = s.tone;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(0, 0, s.r, 0, Math.PI * (0.9 + s.r / 6));
      ctx.stroke();
      ctx.restore();
    }
  }

  /* ---------- The coin ---------- */

  function placeCoin(x, y, down) {
    coinEl.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${coinAngle.toFixed(1)}deg) scale(${down ? 0.94 : 1})`;
    coinEl.classList.add("lc-scratch__coin--on");
    if (down) coinEl.classList.add("lc-scratch__coin--down");
    else coinEl.classList.remove("lc-scratch__coin--down");
  }
  function coinTo(cx, cy, down) {
    const lift = pointerType === "touch" ? FOIL.touchLift : 0;
    const [x, y0] = inTicket(cx, cy);
    const y = y0 - lift;
    if (coinLast) {
      const dx = x - coinLast[0], dy = y - coinLast[1];
      if (Math.hypot(dx, dy) > 2) coinAngle = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
    }
    coinLast = [x, y];
    placeCoin(x, y, down);
  }
  function hideCoin() {
    coinEl.classList.remove("lc-scratch__coin--on", "lc-scratch__coin--down");
    coinLast = null;
  }

  /* ---------- Panels ---------- */

  // The panel under a client point that still has foil, or null.
  function foilAt(cx, cy) {
    return panels.find(p => {
      if (p.open || p.giving) return false;
      const r = rectOf(p.el);
      return cx >= r.left && cx <= r.left + r.width && cy >= r.top && cy <= r.top + r.height;
    }) ?? null;
  }

  // The rest of the foil gives way: a burst of shavings, the crumble on the
  // loop, then open. Under reduced motion it just opens.
  function give(p, at = now()) {
    if (p.open || p.giving || landed) return;
    if (reduced) { openPanel(p); return; }
    const pr = rectOf(p.el);
    const [ox, oy] = inTicket(pr.left, pr.top);
    for (let i = 0; i < 10; i++) spawn(ox + Math.random() * pr.width, oy + Math.random() * pr.height, (Math.random() - 0.5) * 2, -Math.random(), 1);
    p.giving = { t0: at };
    wake();
  }
  function crumble(p, at) {
    const k = (at - p.giving.t0) / FOIL.crumbleMs;
    const ctx = p.ctx && !p.ctx.stub ? p.ctx : null;
    if (ctx) for (let i = 0; i < 6; i++) { ctx.beginPath(); ctx.arc(Math.random() * p.w, Math.random() * p.h, 6 + Math.max(0, k) * p.w * 0.4, 0, Math.PI * 2); ctx.fill(); }
    if (k >= 1) openPanel(p);
  }

  function openPanel(p, { quiet = false, all = false } = {}) {
    if (p.open) return;
    p.open = true;
    p.giving = null;
    p.dirty = false;
    p.el.classList.add("lc-scratch__panel--open");
    if (!reduced && !quiet) p.el.classList.add("lc-scratch__panel--pop");
    opened++;
    if (!quiet && !all) { try { sounds.tick?.(); } catch (err) { console.error("loot-crates | the panel's tick failed", err); } }
    if (!quiet && pointerType === "touch") { try { globalThis.navigator?.vibrate?.(10); } catch { /* no haptics here */ } }
    try { onOpen?.(p.index, { all }); } catch (err) { console.error("loot-crates | a scratch panel's open failed", err); }
    if (opened >= panels.length) land();
  }

  /* ---------- The one loop ---------- */

  function wake() {
    if (frame == null && !landed) frame = raf(loop);
    else if (frame == null && shave.list.length) frame = raf(loop);
  }
  function loop(at) {
    frame = null;
    if (sweep && !landed) stepSweep(at);
    for (const p of panels) if (p.giving) crumble(p, at);
    // The hand's 60% check. The table's sweep gives each panel on its own
    // beat instead (stepSweep), so the card takes the mockup's 380 ms a
    // panel however much of it the coin's wave happens to cover.
    for (const p of panels) {
      if (!p.dirty || p.open) continue;
      p.dirty = false;
      if (!p.giving && !sweep && scratched(p) >= FOIL.threshold) give(p, at);
    }
    drawShavings(at);
    const busy = !landed && (sweep || panels.some(p => p.giving || p.dirty));
    if (busy || shave.list.length) frame = raf(loop);
    else if (shave.ctx) shave.ctx.clearRect(0, 0, shave.w, shave.h);
  }

  /* ---------- The spectators' sweep ---------- */

  // The coin crosses each panel left to right on a slight wave, then the
  // panel gives at 80% of its time and the coin moves to the next.
  function stepSweep(at) {
    if (!sweep.p || sweep.p.open || sweep.p.giving) {
      const next = panels.find(p => !p.open && !p.giving);
      if (!next) { sweep.p = null; hideCoin(); return; }
      paint(next);
      sweep.p = next; sweep.t0 = at; sweep.last = null;
    }
    const p = sweep.p;
    const k = Math.min(1, (at - sweep.t0) / sweep.per);
    const x = -p.w * 0.2 + k * p.w * 1.4, y = p.h * (0.35 + 0.3 * Math.sin(k * 7));
    if (p.w > 0) {
      const len = sweep.last ? Math.hypot(x - sweep.last[0], y - sweep.last[1]) : 0;
      scrape(p, sweep.last, [x, y], bandWidth(len));
      const pr = rectOf(p.el);
      const sx = p.w ? pr.width / p.w : 1, sy = p.h ? pr.height / p.h : 1;
      const [ox, oy] = inTicket(pr.left, pr.top);
      if (sweep.last && len > 0) spawn(ox + x * sx, oy + y * sy, (x - sweep.last[0]) / len, (y - sweep.last[1]) / len, Math.min(4, 1 + len / 9));
      coinAngle += 6;
      placeCoin(ox + x * sx, oy + y * sy, true);
      voice?.rasp(8);
    }
    sweep.last = [x, y];
    if (k > 0.8) give(p, at);
  }

  /* ---------- The buyer's hand ---------- */

  const point = e => [e.clientX ?? 0, e.clientY ?? 0];
  function onDown(e) {
    if (landed || scratching || (e.pointerType === "mouse" && e.button > 0)) return;
    const at = point(e);
    if (!foilAt(at[0], at[1])) return;
    pointerType = e.pointerType || "mouse";
    scratching = true;
    try { ticket.setPointerCapture?.(e.pointerId); } catch { /* a synthetic pointer */ }
    try { voice = sounds.scratch?.(0) ?? null; } catch (err) { console.error("loot-crates | the scratch rasp failed", err); voice = null; }
    coinTo(at[0], at[1], true);
    stroke(null, at);
    prev = at;
    e.preventDefault?.();
  }
  function onMove(e) {
    if (landed) return;
    const at = point(e);
    if (!scratching) {
      pointerType = e.pointerType || pointerType;
      if (foilAt(at[0], at[1])) coinTo(at[0], at[1], false);
      else hideCoin();
      return;
    }
    coinTo(at[0], at[1], true);
    const { len } = stroke(prev, at);
    if (len > 0) voice?.rasp(len);
    prev = at;
  }
  function onUp(e) {
    if (!scratching) return;
    scratching = false;
    prev = null;
    voice?.stop();
    voice = null;
    coinEl.classList.remove("lc-scratch__coin--down");
    const at = e ? point(e) : null;
    if (pointerType === "touch" || !at || !foilAt(at[0], at[1])) hideCoin();
  }
  function onLeave() { if (!scratching) hideCoin(); }

  // The roving focus over the panels: one tab stop, the arrow keys move it.
  function focusPanel(i) {
    focusAt = Math.max(0, Math.min(panels.length - 1, i));
    panels.forEach((p, k) => p.el.setAttribute("tabindex", k === focusAt ? "0" : "-1"));
    panels[focusAt]?.el.focus?.({ preventScroll: true });
  }
  function onKey(e) {
    if (landed || e.altKey || e.ctrlKey || e.metaKey) return;
    const i = focusAt;
    const moves = { ArrowRight: i + 1, ArrowLeft: i - 1, ArrowDown: i + cols, ArrowUp: i - cols, Home: 0, End: panels.length - 1 };
    if (e.key in moves) focusPanel(moves[e.key]);
    else if (e.key === " " || e.key === "Enter") { if (panels[i] && !panels[i].open) { pointerType = "keyboard"; openPanel(panels[i]); } }
    else if (e.key === "r" || e.key === "R") ctrl.revealAll();
    else return;
    // Handled here, and kept from Foundry's keybindings on the window
    // behind it (Space pauses the game for a GM, the arrows move tokens).
    e.preventDefault?.();
    e.stopPropagation?.();
  }
  const onFocusIn = e => { const k = panels.findIndex(p => p.el === e.target); if (k >= 0) focusAt = k; };

  if (buyer) {
    ticket.addEventListener("pointerdown", onDown);
    ticket.addEventListener("pointermove", onMove);
    ticket.addEventListener("pointerup", onUp);
    ticket.addEventListener("pointercancel", onUp);
    ticket.addEventListener("lostpointercapture", () => onUp(null));
    ticket.addEventListener("pointerleave", onLeave);
    ticket.addEventListener("keydown", onKey);
    ticket.addEventListener("focusin", onFocusIn);
    panels.forEach((p, k) => { p.el.setAttribute("tabindex", k === 0 ? "0" : "-1"); p.el.dataset.keyboardFocus = "true"; });
  }

  /* ---------- Landing ---------- */

  function land() {
    if (landed) return;
    landed = true;
    sweep = null;
    scratching = false;
    voice?.stop();
    voice = null;
    hideCoin();
    ticket.classList.remove("lc-scratch__ticket--covered");
    ticket.classList.add("lc-scratch__ticket--open");
    for (const p of panels) { p.el.removeAttribute("tabindex"); p.el.removeAttribute("data-keyboard-focus"); }
    try { onLand?.(); } catch (err) { console.error("loot-crates | the scratch's landing failed", err); }
    resolveDone?.();
  }

  function openAll({ quiet = false } = {}) {
    for (const p of panels) if (!p.open) openPanel(p, { quiet, all: true });
  }

  const ctrl = {
    count: panels.length,
    skipped: false,
    reducedMotion: !!reduced,
    opened: () => opened,
    play() {
      if (landed) return Promise.resolve();
      const done = new Promise(resolve => { resolveDone = resolve; });
      if (duration === 0 || (!buyer && reduced) || !panels.length) { openAll({ quiet: true }); land(); return done; }
      panels.forEach(paint);
      sizeShavings();
      if (buyer) {
        const a = doc.activeElement;
        if (!a || a === doc.body || a.closest?.(".loot-crates")) focusPanel(0);
      } else {
        const per = duration != null ? duration / panels.length : Math.min(FOIL.perPanelMs, FOIL.spectatorMs / panels.length);
        sweep = { per, p: null, t0: 0, last: null };
        try { voice = sounds.scratch?.(0) ?? null; } catch (err) { console.error("loot-crates | the scratch rasp failed", err); voice = null; }
        wake();
      }
      return done;
    },
    // Opens the panel at `i` (in the ticket's order), as Space does.
    open(i) { const p = panels[i]; if (p && !landed) openPanel(p); },
    // Every panel at once, as R and Reveal all do: one tick for the lot.
    revealAll() {
      if (landed) return;
      if (panels.some(p => !p.open)) { try { sounds.tick?.(); } catch (err) { console.error("loot-crates | the panel's tick failed", err); } }
      openAll();
    },
    // The core's Skip (and a closed window, a hidden page): everything open, landed now.
    skip() {
      if (landed) return;
      ctrl.skipped = true;
      shave.list = [];
      if (frame != null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
      frame = null;
      openAll({ quiet: true });
      land();
    },
  };
  return ctrl;
}
