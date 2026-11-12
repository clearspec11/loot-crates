/*
  After the reveal (VIB-219, core/afterplay.js): the winner's choice for
  each item a play granted, on the reveal under the vault, beside nothing
  else of the window's. Markup and plain DOM only, so the reveal window
  (reveal.js) and the harness draw and wire the same thing.

  For the winner alone, once landed: a lead line saying what can be done
  and that closing the window leaves the item where it is (never "Keep":
  that word is Buy to keep's), then one row per item with Give to… and
  Sell back for N (none when the game buys nothing back or the item has
  no price). Give to… opens the row's picker in place: the characters
  other players own as a native select, focused, with Give and Cancel;
  Escape is Cancel and focus goes back to Give to…. While a request is out
  its button reads Giving… or Selling… and the row's other buttons are
  off; a refusal is said on the row's own line and the buttons come back.
  Sell back asks once more in place, as Give to… does with its picker: a
  sale can't be undone, so the first press only opens "Sell X back for N?
  This can't be undone." with Sell (focused) and Cancel; Escape is Cancel
  and focus goes back to Sell back.
  Once done the row's buttons give way to what happened, said in the row's
  status line, and focus goes to the next row's first button, else to the
  window's Close. Everyone else sees only those lines (spectatorLine).

  A play of one item says what became of it once, in the result's own
  line (whereAfter: "Sold back for 75 gp" where "Added to Tam's
  inventory" stood), not under it as well: the row goes (showPart with no
  text). With several items the rows say it, and the result's line stops
  saying "Added to" once none of them is left on the sheet.

  The section's buttons carry data-after, never data-action: ApplicationV2
  routes data-action itself, and the harness has no ApplicationV2.
*/
import { formatPrice } from "../core/currency.js";
import { t } from "../core/i18n.js";

const plain = s => String(s ?? "");

/*
  The winner's section. `offer`: { items: [{ id, name, sellCp }], targets:
  [{ id, name, players }], actorName }. `key` makes the ids unique to the
  window (the pull's request id).
*/
export function afterHTML(offer, { esc = plain, key = "x" } = {}) {
  const items = offer?.items ?? [];
  if (!items.length) return "";
  const several = items.length > 1;
  const none = !(offer.targets ?? []).length;
  const noneId = `lc-after-none-${esc(key)}`;
  const lead = t(several ? "LOOTCRATES.After.LeadSeveral" : "LOOTCRATES.After.Lead", { actor: esc(offer.actorName) });
  const options = (offer.targets ?? []).map(c => `<option value="${esc(c.id)}">${esc(t("LOOTCRATES.After.Target", { name: c.name, players: c.players }))}</option>`).join("");
  const row = (item, i) => {
    const name = esc(item.name);
    const pickId = `lc-after-pick-${esc(key)}-${i}`;
    const sureId = `lc-after-sure-${esc(key)}-${i}`;
    const price = item.sellCp > 0 ? esc(formatPrice(item.sellCp / 100)) : "";
    return `<li class="lc-after__item" data-after-item="${esc(item.id)}" data-after-name="${name}">
          ${several ? `<span class="lc-after__name">${name}</span>` : ""}
          <span class="lc-after__acts">
            <button type="button" class="lc-after__give" data-after="give" aria-label="${t("LOOTCRATES.After.GiveLabel", { item: name })}"${none ? ` aria-disabled="true" aria-describedby="${noneId}"` : ""}>${t("LOOTCRATES.After.Give")}</button>
            ${price ? `<button type="button" class="lc-after__sell" data-after="sell" data-cp="${item.sellCp}" aria-label="${t("LOOTCRATES.After.SellLabel", { item: name, price })}">${t("LOOTCRATES.After.Sell", { price })}</button>` : ""}
          </span>
          <span class="lc-after__pick" hidden>
            <label class="lc-after__pick-label" for="${pickId}">${t("LOOTCRATES.After.PickLabel", { item: name })}</label>
            <select class="lc-after__target" id="${pickId}">${options}</select>
            <button type="button" class="lc-after__confirm" data-after="confirm">${t("LOOTCRATES.After.Confirm")}</button>
            <button type="button" class="lc-after__cancel" data-after="cancel">${t("LOOTCRATES.Common.Cancel")}</button>
          </span>
          ${price ? `<span class="lc-after__sure" hidden>
            <span class="lc-after__sure-label" id="${sureId}"></span>
            <button type="button" class="lc-after__sellgo" data-after="sellgo" aria-describedby="${sureId}">${t("LOOTCRATES.After.SellConfirm")}</button>
            <button type="button" class="lc-after__cancel" data-after="cancel">${t("LOOTCRATES.Common.Cancel")}</button>
          </span>` : ""}
          <span class="lc-after__said" role="status"></span>
        </li>`;
  };
  return `<section class="lc-after" aria-label="${t("LOOTCRATES.After.Region")}">
        <p class="lc-after__lead">${lead}</p>
        ${none ? `<p class="lc-after__none" id="${noneId}">${t("LOOTCRATES.After.NoTargets")}</p>` : ""}
        <ul class="lc-after__items">${items.map(row).join("")}</ul>
      </section>`;
}

const rowOf = (root, itemId) => [...(root?.querySelectorAll?.(".lc-after__item") ?? [])].find(li => li.dataset.afterItem === itemId) ?? null;
const off = el => el?.getAttribute("aria-disabled") === "true";

// The row's picker open (its select focused) or shut (focus back on Give to…).
export function openPick(li, open) {
  const pick = li?.querySelector(".lc-after__pick");
  const acts = li?.querySelector(".lc-after__acts");
  if (!pick || !acts) return;
  pick.hidden = !open;
  acts.hidden = open;
  (open ? pick.querySelector(".lc-after__target") : acts.querySelector(".lc-after__give"))?.focus({ preventScroll: true });
}

// The row's "sell it?" open (its Sell focused, asking at the price on the
// Sell back button now) or shut (focus back on Sell back).
export function openSure(li, open) {
  const sure = li?.querySelector(".lc-after__sure");
  const acts = li?.querySelector(".lc-after__acts");
  const sell = acts?.querySelector(".lc-after__sell");
  if (!sure || !acts || !sell) return;
  if (open) sure.querySelector(".lc-after__sure-label").textContent = t("LOOTCRATES.After.SellSure", { item: li.dataset.afterName ?? "", price: formatPrice((Number(sell.dataset.cp) || 0) / 100) });
  sure.hidden = !open;
  acts.hidden = open;
  (open ? sure.querySelector(".lc-after__sellgo") : sell).focus({ preventScroll: true });
}

// Whichever of the row's two asks is open, shut. Returns whether one was.
function shut(li) {
  const pick = li?.querySelector(".lc-after__pick");
  const sure = li?.querySelector(".lc-after__sure");
  if (sure && !sure.hidden) { openSure(li, false); return true; }
  if (pick && !pick.hidden) { openPick(li, false); return true; }
  return false;
}

// A request out for this row: the pressed button says so, every button off.
export function setBusy(li, which) {
  if (!li) return;
  li.dataset.busy = which;
  for (const b of li.querySelectorAll("button")) {
    if (!b.dataset.label) b.dataset.label = b.textContent;
    b.setAttribute("aria-disabled", "true");
  }
  const said = li.querySelector(".lc-after__said");
  if (said) said.textContent = "";
  const btn = which === "sell" ? li.querySelector(".lc-after__sellgo") ?? li.querySelector(".lc-after__sell") : li.querySelector(".lc-after__confirm");
  if (btn) btn.textContent = t(which === "sell" ? "LOOTCRATES.After.Selling" : "LOOTCRATES.After.Giving");
}

// The request refused: the buttons come back with `text` on the row's line.
// `cp` is the house's price now when it changed (the sell button follows it).
export function refused(li, text, { cp = null, none = false } = {}) {
  if (!li) return;
  delete li.dataset.busy;
  for (const b of li.querySelectorAll("button")) {
    if (b.dataset.label) b.textContent = b.dataset.label;
    if (!(none && b.classList.contains("lc-after__give"))) b.removeAttribute("aria-disabled");
  }
  const sell = li.querySelector(".lc-after__sell");
  if (sell && cp != null) {
    if (cp > 0) {
      const price = formatPrice(cp / 100);
      sell.dataset.cp = String(cp);
      sell.textContent = sell.dataset.label = t("LOOTCRATES.After.Sell", { price });
    } else sell.remove();
  }
  // A sale refused goes back to Sell back, at the house's price now: the
  // next press asks again at that price.
  const sure = li.querySelector(".lc-after__sure");
  if (sure && !sure.hidden) {
    const had = sure.contains(globalThis.document?.activeElement ?? null);
    sure.hidden = true;
    const acts = li.querySelector(".lc-after__acts");
    if (acts) acts.hidden = false;
    if (had) (acts?.querySelector(".lc-after__sell") ?? acts?.querySelector(".lc-after__give"))?.focus({ preventScroll: true });
    if (!li.querySelector(".lc-after__sell")) sure.remove();
  }
  const said = li.querySelector(".lc-after__said");
  if (said) said.textContent = text ?? "";
}

/*
  What happened to an item: the row's buttons go and its line says it.
  With no `text` the row goes too (a play of one item says it in the
  result's line, whereAfter), and the section with its last row. Returns
  the element focus should move to when it was on the row (the next row's
  first button still there), else null.
*/
export function showPart(root, itemId, text = "") {
  const li = rowOf(root, itemId);
  if (!li) return null;
  delete li.dataset.busy;
  li.dataset.parted = "1";
  for (const sel of [".lc-after__acts", ".lc-after__pick", ".lc-after__sure"]) li.querySelector(sel)?.remove();
  const said = li.querySelector(".lc-after__said");
  if (said) said.textContent = text;
  if (!text) li.remove();
  const open = [...root.querySelectorAll(".lc-after__item")].filter(row => !row.dataset.parted);
  if (!open.length) for (const sel of [".lc-after__lead", ".lc-after__none"]) root.querySelector(sel)?.remove();
  if (!root.querySelector(".lc-after__item")) root.querySelector(".lc-after")?.remove();
  return open.flatMap(row => [...row.querySelectorAll(".lc-after__acts button")]).find(b => !off(b)) ?? null;
}

/*
  The result's own line, where it said the item was added to the sheet
  (revealcard.js resultHTML, .lc-reveal__added): `text` in its place ("Sold
  back for 75 gp"), or with "" the phrase gone, with the dot that joined it
  to the gold. `root` is the reveal's result block or anything around it.
*/
export function whereAfter(root, text) {
  const added = root?.querySelector?.(".lc-reveal__added");
  if (!added) return;
  if (text) { added.textContent = text; return; }
  const dot = n => n?.nodeType === 3 && /^\s*·\s*$/.test(n.textContent);
  const where = added.parentNode;
  if (dot(added.nextSibling)) added.nextSibling.remove();
  else if (dot(added.previousSibling)) added.previousSibling.remove();
  added.remove();
  if (where && !where.textContent.trim()) where.remove();
}

// Everyone else's line, once per item (a second word on it replaces the first).
export function spectatorLine(root, itemId, text, { esc = plain } = {}) {
  if (!root) return;
  let list = root.querySelector(".lc-after__items");
  if (!list) {
    root.insertAdjacentHTML("beforeend", `<section class="lc-after lc-after--watch" aria-label="${t("LOOTCRATES.After.Region")}"><ul class="lc-after__items"></ul></section>`);
    list = root.querySelector(".lc-after__items");
  }
  let li = rowOf(root, itemId);
  if (!li) {
    list.insertAdjacentHTML("beforeend", `<li class="lc-after__item" data-after-item="${esc(itemId)}" data-parted="1"><span class="lc-after__said" role="status"></span></li>`);
    li = rowOf(root, itemId);
  }
  li.querySelector(".lc-after__said").textContent = text;
}

/*
  Wires a section: Give to… opens the row's picker and Sell back its "sell
  it?", Cancel or Escape shuts either, Give calls onGive(itemId, targetId,
  li), and Sell (the second press) onSell(itemId, cp, li) at the price on
  the Sell back button. Nothing pressed while off or busy reaches them.
  onPick(open) is told when either opens or shuts (the window holds its
  countdown meanwhile).
*/
export function wireAfter(root, { onGive, onSell, onPick = null } = {}) {
  if (typeof root?.addEventListener !== "function") return;
  root.addEventListener("click", event => {
    const btn = event.target.closest?.("[data-after]");
    const li = btn?.closest(".lc-after__item");
    if (!btn || !li || li.dataset.busy || off(btn)) return;
    event.preventDefault();
    const itemId = li.dataset.afterItem;
    const what = btn.dataset.after;
    if (what === "give") { openPick(li, true); onPick?.(true); }
    else if (what === "cancel") { shut(li); onPick?.(false); }
    else if (what === "confirm") {
      const target = li.querySelector(".lc-after__target")?.value;
      if (target) onGive?.(itemId, target, li);
    } else if (what === "sell") { openSure(li, true); onPick?.(true); }
    else if (what === "sellgo") onSell?.(itemId, Number(li.querySelector(".lc-after__sell")?.dataset.cp) || 0, li);
  });
  root.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    const li = event.target.closest?.(".lc-after__item");
    const open = [".lc-after__pick", ".lc-after__sure"].some(sel => { const el = li?.querySelector(sel); return !!el && !el.hidden; });
    if (!open || li.dataset.busy) return;
    event.preventDefault();
    event.stopPropagation();
    shut(li);
    onPick?.(false);
  });
}
