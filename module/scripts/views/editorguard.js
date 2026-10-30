/*
  The guard rails every game editor shares (manager.js), so a GM loses no
  work and puts no broken game in front of players:

  - The form as it opened (snapshotOf): Cancel, the window's X and Escape
    ask "Discard your changes to <name>?" only once something differs
    (foundry/editordialog.js asks; Keep editing is the default).
  - The default button's gate (okGate): Save is off while any one field
    says it can't be saved (a price it can't read, a stock below 0, a
    scratch line the card can't show), each by its own key, so one field
    turning good never turns Save back on over another.
  - The shelf (wireShelf): while the game can't be played
    (views/playable.js), the On the shelf box is unticked and off with
    the reason under it and the button reads "Save off the shelf"; once
    it can, the box goes back to what the GM had and the button to Add to
    shelf, Add or Save.
  - The stock (wireStock): a number below 0 is refused under the field,
    and the line under it follows what is typed ("12 of 12 left once you
    save"), not only the saved state.

  No Foundry globals: the harness wires its editors with the same calls.
*/
import { stockProblem, stockLine, restockLine, stockField } from "../core/limits.js";
import { saveOffShelfLabel } from "../core/shelf.js";
import { addLabel } from "./newgame.js";
import { t } from "../core/i18n.js";

const plain = s => String(s ?? "");

// The editor's default button: in the form (DialogV2 puts its footer
// there) or beside it in the window.
export const okButton = form => form.querySelector('button[data-action="ok"]') ?? form.closest?.(".application, dialog")?.querySelector('button[data-action="ok"]') ?? null;

const gates = new WeakMap();
export function okGate(form) {
  let gate = gates.get(form);
  if (gate) return gate;
  const off = new Set();
  gate = {
    set(key, blocked) {
      if (blocked) off.add(key);
      else off.delete(key);
      const ok = okButton(form);
      if (ok) ok.disabled = off.size > 0;
    },
    get blocked() { return off.size > 0; },
  };
  gates.set(form, gate);
  return gate;
}

// The form's values as `read()` gives them when called, and whether they
// differ now.
export function snapshotOf(read) {
  const at = JSON.stringify(read());
  return { dirty: () => JSON.stringify(read()) !== at };
}

/*
  The On the shelf box and the default button's words. Returns
  `verdict(why)`: the editor calls it with views/playable.js
  unplayableReason on each change ("" once the game can be played).
*/
export function wireShelf(form, { isNew = false, shopOpen = true } = {}) {
  const box = form.querySelector('input[name="onShelf"]');
  const why = form.querySelector("[data-shelf-why]");
  let blocked = "";
  let wanted = box ? box.checked : true;
  const paint = () => {
    const ok = okButton(form);
    if (!ok) return;
    const words = blocked ? saveOffShelfLabel() : isNew ? addLabel(shopOpen, box ? box.checked : true) : t("LOOTCRATES.Common.Save");
    (ok.querySelector("span") ?? ok).textContent = words;
  };
  box?.addEventListener("change", () => { if (!blocked) wanted = box.checked; paint(); });
  paint();
  return reason => {
    const next = reason || "";
    if (next === blocked) return;
    if (box) {
      if (next && !blocked) wanted = box.checked;
      box.checked = next ? false : wanted;
      box.disabled = !!next;
    }
    blocked = next;
    if (why) why.textContent = next;
    paint();
  };
}

/*
  The Limits group's Stock (limits.js limitsFieldset) and its Restock.
  Typing: a number below 0 is said under the field and turns Save off
  (`gate`), and the line beside Restock says what Save will leave
  (limits.js stockLine). Restock marks the form (its hidden "restock"
  field) so Save fills the stock to the GM's number, and Cancel writes
  nothing, as for every other field; the line then says what that Save
  will leave and follows the field as it changes (limits.js restockLine).
  Restock stays focused, off once pressed.
*/
export function wireStock(form, game, { gate = okGate(form) } = {}) {
  const stock = form.querySelector('input[name="stock"]');
  if (!stock) return;
  const why = form.querySelector("[data-stock-why]");
  const left = form.querySelector(".lc-limits__left");
  const btn = form.querySelector("[data-restock]");
  const mark = form.querySelector('input[name="restock"]');
  const paint = () => {
    const problem = stockProblem(stock.value);
    stock.setCustomValidity?.(problem);
    stock.setAttribute("aria-invalid", problem ? "true" : "false");
    if (why && why.textContent !== problem) why.textContent = problem;
    gate.set("stock", !!problem);
    if (!left) return;
    const line = mark?.value === "1" ? restockLine(stock.value, stockField(game)) : stockLine(game, stock.value);
    if (left.textContent !== line) left.textContent = line;
  };
  btn?.addEventListener("click", () => {
    if (btn.getAttribute("aria-disabled") === "true") return;
    btn.setAttribute("aria-disabled", "true");
    if (mark) mark.value = "1";
    paint();
  });
  stock.addEventListener("input", paint);
  stock.addEventListener("change", paint);
}

// The discard prompt's words (foundry/editordialog.js shows them).
export const discardTitle = () => t("LOOTCRATES.Editor.DiscardTitle");
export const discardHTML = (name, esc = plain) => `<p>${t("LOOTCRATES.Editor.DiscardAsk", { name: `<strong>${esc(name)}</strong>` })}</p>`;
export const discardLabels = () => ({ yes: t("LOOTCRATES.Editor.Discard"), no: t("LOOTCRATES.Editor.KeepEditing") });

// A price of 0, asked once: a GM may give a free game, but not by a slip.
export const freeTitle = () => t("LOOTCRATES.Editor.FreeTitle");
export const freeHTML = (name, esc = plain) => `<p>${t("LOOTCRATES.Editor.FreeAsk", { name: `<strong>${esc(name)}</strong>` })}</p>`;
export const freeLabels = () => ({ yes: t("LOOTCRATES.Editor.KeepFree"), no: t("LOOTCRATES.Editor.SetPrice") });
