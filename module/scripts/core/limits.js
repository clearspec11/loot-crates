/*
  A game's limits, for every kind that is pulled (not a table game): the
  global stock and the limit per character.

  - Stock is how many the shop has left (`rules.stock`, null for unlimited)
    out of how many the GM set (`rules.stockMax`). A pull takes one, a
    refund puts one back (never past the GM's number) and Restock fills it
    to that number again. A record from before stockMax has the count
    alone, and says "3 left" as it always has.
  - The limit per character (`rules.perCharacter`: { max, per }) is how
    many times one character may buy, in all ("ever") or per in-game day
    ("day", keyed on clock.js like the well's cap). It is counted from that
    character's unrefunded log rows for this game, never stored as a
    counter: a refund gives the purchase back by itself, and the GM resets
    nothing. It counts per character (the buyer), not per Foundry user.

  The GM checks both in pull.js, inside the write queue, so two quick buys
  can't both pass; the shop card says the same thing before anyone presses.

  No Foundry globals: the callers pass the log and the day's key.
*/
import { getKind, kindOf } from "../games/kinds.js";
import { field } from "../views/editorfields.js";
import { byRest, restDayNote } from "./clock.js";
import { t, words } from "./i18n.js";

export const PER = ["ever", "day"];
const PER_LABEL = words({ ever: "LOOTCRATES.Limits.PerEver", day: "LOOTCRATES.Limits.PerDay" });

const whole = v => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.floor(Number(v))));

// { left, max } (max null on a record from before stockMax), or null when
// the stock is unlimited.
export function stockOf(game) {
  const left = whole(game?.rules?.stock);
  if (left == null) return null;
  return { left, max: whole(game.rules.stockMax) };
}

// "3 of 10 left", "3 left" for a record without the GM's number, "" when unlimited.
export function stockText(game) {
  const s = stockOf(game);
  if (!s) return "";
  return s.max != null ? t("LOOTCRATES.Limits.LeftOf", { left: s.left, max: s.max }) : t("LOOTCRATES.Limits.Left", { left: s.left });
}

// The rules with the stock filled to the GM's number (unchanged without one).
export function restocked(rules = {}) {
  const max = whole(rules.stockMax);
  return max == null ? { ...rules } : { ...rules, stock: max };
}

// The stock a refund leaves: one back, never past the GM's number (a
// Restock between the pull and its refund already put it back). Null when
// the stock is unlimited.
export function stockAfterRefund(game) {
  const s = stockOf(game);
  if (!s) return null;
  return s.max != null ? Math.min(s.left + 1, s.max) : s.left + 1;
}

/*
  The stock the editor's Save writes, from the record as it is now
  (`fresh`), the number the form opened with (`shown`) and the number in
  it at Save (`value`, the GM's "Stock", blank for unlimited). Unchanged:
  the stock is the record's, since pulls and refunds move it while the
  dialog is open (the editor's Restock is applied after this, at Save). Changed: the new number is the GM's, and what
  is left moves by the same amount (raising 10 to 12 puts two more on the
  shelf), never below 0 or past the new number; from unlimited, the shelf
  starts full. Returns { stock, stockMax }.
*/
export function stockFromForm(fresh = {}, { shown, value }) {
  const next = whole(value);
  const was = whole(shown);
  const left = whole(fresh.stock);
  if (next === was) return { stock: left, stockMax: whole(fresh.stockMax) };
  if (next == null) return { stock: null, stockMax: null };
  const before = whole(fresh.stockMax) ?? left;
  const now = before == null || left == null ? next : Math.min(next, Math.max(0, left + (next - before)));
  return { stock: now, stockMax: next };
}

// The editor's line once Restock is pressed: nothing is written until Save,
// so it says what Save will leave ("10 of 10 left once you save").
export const restockPreview = max => t("LOOTCRATES.Limits.RestockPreview", { max });

// That line from the Stock field as it reads now (`typed`), so it follows
// a number changed after Restock was pressed: a number fills to it, blank
// is unlimited (stockFromForm), anything else is the number the form
// opened with (`shown`).
export function restockLine(typed, shown) {
  if (String(typed ?? "").trim() === "") return t("LOOTCRATES.Limits.UnlimitedOnSave");
  const n = whole(typed);
  return restockPreview(n ?? whole(shown) ?? 0);
}

// The number the editor's "Stock" opens with: the GM's, or the count
// alone on a record from before it.
export const stockField = game => {
  const s = stockOf(game);
  return s ? (s.max ?? s.left) : null;
};

// The limit per character, { max, per }, or null for none (a table game
// has none: its stakes aren't pulls).
export function perCharacterOf(game) {
  const pc = game?.rules?.perCharacter;
  const max = whole(pc?.max);
  if (!max) return null;
  if (getKind(kindOf(game))?.table) return null;
  return { max, per: pc.per === "day" ? "day" : "ever" };
}

// The editor's per-character fields as the record keeps them, or null.
export function perCharacterFromForm({ limitMax, limitPer } = {}) {
  const max = whole(limitMax);
  return max ? { max, per: limitPer === "day" ? "day" : "ever" } : null;
}

// How many times this character has bought this game: its unrefunded rows
// (today's, for a limit per day). Every pulled play writes one row, a miss
// included. A Buy to keep (row.keep) is a purchase, so it counts on the day
// it was bought; the play its ticket is used for later (a redeem of a kept
// ticket) was that purchase, so it doesn't count again.
export function boughtBy(log, { boxId, actorId, per = "ever", today = null }) {
  if (per === "day" && !today) return 0;
  return (log ?? []).filter(r => r.boxId === boxId && r.actorId === actorId && !r.refunded && !r.roundId && !r.redeem?.kept && (per !== "day" || r.day === today)).length;
}

/*
  Where this character stands with the limit: { max, per, bought, left,
  reached }, or null when the game has none, there is no character, or the
  limit is per day in a world with no clock (like the well's cap, it can't
  apply). `ctx` is { log, actorId, today }; the log is read only when the
  game has a limit.
*/
export function limitState(game, ctx = {}) {
  const pc = perCharacterOf(game);
  if (!pc || !ctx.actorId) return null;
  if (pc.per === "day" && !ctx.today) return null;
  const bought = boughtBy(ctx.log, { boxId: game.id, actorId: ctx.actorId, per: pc.per, today: ctx.today });
  return { ...pc, bought, left: Math.max(0, pc.max - bought), reached: bought >= pc.max };
}


// The card's line while there is some left: "You can buy 1 more" ("... today").
export function limitLine(st) {
  if (!st || st.reached) return "";
  return t(st.per === "day" ? "LOOTCRATES.Limits.MoreToday" : "LOOTCRATES.Limits.More", { left: st.left });
}

// The card's reason once it is reached: "Limit reached: 2 of 2 for Crate Tester".
export function limitReason(st, actorName = "") {
  return t(st.per === "day" ? "LOOTCRATES.Limits.ReachedDay" : "LOOTCRATES.Limits.Reached", { bought: Math.min(st.bought, st.max), max: st.max, name: actorName || t("LOOTCRATES.Common.ThisCharacter") });
}

// The GM's refusal, and the shop's when a stale card's Buy slips through.
export function limitRefusal(game, st, actorName = "") {
  return t(st.per === "day" ? "LOOTCRATES.Limits.RefusalDay" : "LOOTCRATES.Limits.Refusal", { game: game.name, bought: Math.min(st.bought, st.max), max: st.max, name: actorName || t("LOOTCRATES.Common.ThisCharacter") });
}

/*
  The card's reason with the limit in it: once this character has reached
  it, that is what the card says, over the game's own reason (a shortfall
  or a sold-out shelf: either way this character can't buy again until a
  refund or tomorrow), except while their last play is still spinning,
  which says so first (boxcard.js crateState).
*/
export function withLimit(game, reason, ctx = {}) {
  if (ctx.held?.(game.id)) return reason;
  const st = limitState(game, ctx);
  return st?.reached ? limitReason(st, ctx.actorName) : reason;
}

// The Boxes table's words: "1 per character", "2 per character a day".
export function perCharacterText(game) {
  const pc = perCharacterOf(game);
  return pc ? t(pc.per === "day" ? "LOOTCRATES.Limits.PerCharacterDay" : "LOOTCRATES.Limits.PerCharacter", { max: pc.max }) : "";
}

// The Boxes table's stock and limit, joined: "3 of 10 left, 1 per character".
export const limitsText = game => [stockText(game), perCharacterText(game)].filter(Boolean).join(", ");

/*
  The editor's Limits group: the stock with what is left of it and
  Restock (`stock: true`, the crate), then the limit per character, each
  with its help in plain words. Restock is shown when the GM has a number
  to fill to, aria-disabled (never disabled, so it keeps focus) while the
  shelf is full; the manager wires it (data-restock): pressing it sets the
  hidden `restock` field and the line beside it, and only Save writes it,
  so Cancel leaves the stock as it was. A `draft` (a New,
  or a copy of a game) has no record to fill, so it gets no Restock.
  `hasClock` false warns that a limit per day won't apply; `day` "rest"
  or "manual" (store.js dayMode) says a day ends at each character's long
  rest instead of naming the calendar. `esc` escapes text and values.
*/
export function limitsFieldset(game, { stock = true, draft = false, hasClock = true, day = null, esc = s => String(s ?? "") } = {}) {
  const pc = game?.rules?.perCharacter ?? {};
  const max = whole(pc.max);
  const per = pc.per === "day" ? "day" : "ever";
  const s = stockOf(game);
  const full = !s || s.max == null || s.left >= s.max;
  const id = `lc-limits-${esc(game?.id ?? "new")}`;
  const stockPart = stock ? `
        <label class="lc-row">${t("LOOTCRATES.Limits.Stock")} <input name="stock" type="number" min="0" step="1" value="${esc(stockField(game) ?? "")}" aria-describedby="${id}-stock"></label>
        <div class="lc-row lc-limits__stock">
          <span class="lc-limits__left" role="status">${esc(s ? stockText(game) : t("LOOTCRATES.Limits.Unlimited"))}</span>
          ${s?.max != null && !draft ? `<button type="button" class="lc-limits__restock" data-restock${full ? ` aria-disabled="true"` : ""}><i class="fas fa-rotate-left" inert></i> ${t("LOOTCRATES.Limits.Restock")}</button><input type="hidden" name="restock" value="">` : ""}
        </div>
        <p class="lc-form__hint" id="${id}-stock">${t("LOOTCRATES.Limits.StockHint")}</p>` : "";
  const rest = byRest(day);
  const warn = rest ? `<p class="lc-form__hint">${restDayNote(day)}</p>`
    : !hasClock ? `<p class="lc-form__hint${per === "day" && max ? " lc-form__hint--warn" : ""}">${t("LOOTCRATES.Limits.NoCalendar")}</p>` : "";
  return `
      <fieldset class="lc-limits"><legend>${t("LOOTCRATES.Limits.Legend")}</legend>${stockPart}
        <div class="lc-row lc-row--wrap">${field(t("LOOTCRATES.Limits.EachMayBuy"), `<input name="limitMax" type="number" min="0" step="1" value="${esc(max ?? "")}" aria-describedby="${id}-each">`)} <select name="limitPer" aria-label="${t("LOOTCRATES.Limits.HowOften")}">${PER.map(p => `<option value="${p}"${p === per ? " selected" : ""}>${PER_LABEL[p]}</option>`).join("")}</select></div>
        <p class="lc-form__hint" id="${id}-each">${t(rest ? "LOOTCRATES.Limits.EachHint" : "LOOTCRATES.Limits.EachHintDay")}</p>
        ${warn}
      </fieldset>`;
}
