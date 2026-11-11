/*
  The second press for a large spend: a Buy, a Buy to keep or a reveal's
  play-again (Draw again, Another ticket) whose price is more than half of
  what the character's purse holds (currency.js largeSpend) sends nothing
  on its first press. That press arms the same button, which then says
  what it will spend ("Spend 150 gp?"); a second press on it sends, as one
  press always did. A buy at or under half the purse is one press.

  Armed is an attribute on the button (data-armed) and its visible words,
  nothing else: the button stays the same node (focus stays on it), keeps
  its screen-reader name prefix (a leading .lc-sr-only, "Royal Vault: ")
  and its aria-disabled, and says one short line at no less than the width
  it had, so the card or the row around it doesn't move. It disarms, back
  to the words it had, when focus leaves it, on Escape (kept from Foundry,
  which would close the window), on a press anywhere else, and when its
  window draws it again: the shop's morph (boxcard.js patchShop) drops the
  attribute and puts the fresh label in, so any re-render (the purse or
  the character changed) asks again. A press in the same gesture as the
  one that armed it is ignored, so one gesture never both asks and spends:
  a double-click's second click, any press within ARM_GRACE_MS, and the
  clicks a held Enter repeats (a keydown with `repeat`) until its keyup.

  A courtesy on this client only: the request, the GM's checks and the
  money path are as they were. Plain DOM, no Foundry.
*/
import { formatPrice, largeSpend } from "../core/currency.js";
import { t } from "../core/i18n.js";

// How long after arming a press still counts as the arming gesture's own.
export const ARM_GRACE_MS = 400;

// Per armed button: the nodes it said before, the price it asks about,
// when it armed, whether a key is held down on it (repeating), and how to
// take its listeners off.
const held = new WeakMap();

export const isArmed = btn => btn?.getAttribute?.("data-armed") != null;

// What an armed button says: "Spend 150 gp?".
export const spendAsk = price => t("LOOTCRATES.Card.SpendAsk", { price: formatPrice(price) });

/*
  Arms `btn` to ask about `price` (gp): its words become the ask, after its
  screen-reader prefix when it has one, and the ways it disarms are wired.
*/
export function armSpend(btn, price, { now = Date.now() } = {}) {
  if (typeof btn?.replaceChildren !== "function") return;
  disarmSpend(btn);
  const doc = btn.ownerDocument ?? globalThis.document;
  const nodes = [...(btn.childNodes ?? [])];
  const lead = nodes.find(n => n.nodeType === 1 && n.classList?.contains("lc-sr-only")) ?? null;
  // Its width is held while it asks, so a shorter ask doesn't pull the
  // buttons beside it (a reveal's Close) onto its line.
  const width = btn.getBoundingClientRect?.().width ?? 0;
  const minWidth = btn.style?.minWidth ?? "";
  if (width > 0 && btn.style) btn.style.minWidth = `${width}px`;
  const ask = doc.createElement("span");
  ask.className = "lc-spend-ask";
  ask.textContent = spendAsk(price);
  btn.replaceChildren(...(lead ? [lead, ask] : [ask]));
  btn.setAttribute("data-armed", "");
  const record = { nodes, price, at: now, minWidth, keyHeld: false };
  const onOut = event => { if (!btn.contains(event.relatedTarget ?? null)) disarmSpend(btn); };
  const onKey = event => {
    // A held Enter repeats its keydown, and each one presses the button.
    if (event.repeat) record.keyHeld = true;
    if (event.key !== "Escape" || !isArmed(btn)) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    disarmSpend(btn);
  };
  const onUp = () => { record.keyHeld = false; };
  const onDown = event => { if (!btn.contains(event.target ?? null)) disarmSpend(btn); };
  btn.addEventListener?.("focusout", onOut);
  btn.addEventListener?.("keydown", onKey);
  btn.addEventListener?.("keyup", onUp);
  doc?.addEventListener?.("pointerdown", onDown, true);
  record.off = () => {
    btn.removeEventListener?.("focusout", onOut);
    btn.removeEventListener?.("keydown", onKey);
    btn.removeEventListener?.("keyup", onUp);
    doc?.removeEventListener?.("pointerdown", onDown, true);
  };
  held.set(btn, record);
}

/*
  Puts an armed button back as it was. Returns whether it was armed. A
  button its window drew again since has its fresh words already: only
  its listeners come off.
*/
export function disarmSpend(btn) {
  const was = btn ? held.get(btn) : null;
  if (!was) return false;
  held.delete(btn);
  was.off();
  if (!isArmed(btn)) return false;
  btn.removeAttribute("data-armed");
  if (btn.style) btn.style.minWidth = was.minWidth;
  btn.replaceChildren(...was.nodes);
  return true;
}

/*
  One press of a button that spends `price` (gp) from `purse`: true when it
  should send now (a small spend, or the second press on an armed button),
  false when this press only armed it (or was the arming gesture's own
  second click). An armed button asking about another price than this
  press's (the price moved between the presses) asks again at the new one.
*/
export function spendPress(btn, { purse = {}, price, event = null, now = Date.now() } = {}) {
  if (!largeSpend(purse, price)) {
    disarmSpend(btn);
    return true;
  }
  const was = btn ? held.get(btn) : null;
  if (was && isArmed(btn) && was.price === Number(price)) {
    if (event?.detail > 1 || now - was.at < ARM_GRACE_MS || was.keyHeld) return false;
    disarmSpend(btn);
    return true;
  }
  armSpend(btn, Number(price), { now });
  return false;
}
