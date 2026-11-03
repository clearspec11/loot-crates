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
  Once done the row's buttons give way to what happened, said in the row's
  status line, and focus goes to the next row's first button, else to the
  window's Close. Everyone else sees only those lines (spectatorLine).

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
    const price = item.sellCp > 0 ? esc(formatPrice(item.sellCp / 100)) : "";
    return `<li class="lc-after__item" data-after-item="${esc(item.id)}">
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
  const btn = which === "sell" ? li.querySelector(".lc-after__sell") : li.querySelector(".lc-after__confirm");
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
  const said = li.querySelector(".lc-after__said");
  if (said) said.textContent = text ?? "";
}

/*
  What happened to an item: the row's buttons go and its line says it.
  Returns the element focus should move to when it was on the row (the
  next row's first button still there), else null.
*/
export function showPart(root, itemId, text) {
  const li = rowOf(root, itemId);
  if (!li) return null;
  delete li.dataset.busy;
  li.dataset.parted = "1";
  li.querySelector(".lc-after__acts")?.remove();
  li.querySelector(".lc-after__pick")?.remove();
  const said = li.querySelector(".lc-after__said");
  if (said) said.textContent = text;
  const open = [...root.querySelectorAll(".lc-after__item")].filter(row => !row.dataset.parted);
  if (!open.length) for (const sel of [".lc-after__lead", ".lc-after__none"]) root.querySelector(sel)?.remove();
  return open.flatMap(row => [...row.querySelectorAll(".lc-after__acts button")]).find(b => !off(b)) ?? null;
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
  Wires a section: Give to… opens the row's picker, Cancel or Escape shuts
  it, Give calls onGive(itemId, targetId, li), Sell back onSell(itemId, cp,
  li). Nothing pressed while off or busy reaches them. onPick(open) is told
  when a picker opens or shuts (the window holds its countdown meanwhile).
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
    else if (what === "cancel") { openPick(li, false); onPick?.(false); }
    else if (what === "confirm") {
      const target = li.querySelector(".lc-after__target")?.value;
      if (target) onGive?.(itemId, target, li);
    } else if (what === "sell") onSell?.(itemId, Number(btn.dataset.cp) || 0, li);
  });
  root.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    const li = event.target.closest?.(".lc-after__item");
    const pick = li?.querySelector(".lc-after__pick");
    if (!pick || pick.hidden || li.dataset.busy) return;
    event.preventDefault();
    event.stopPropagation();
    openPick(li, false);
    onPick?.(false);
  });
}
