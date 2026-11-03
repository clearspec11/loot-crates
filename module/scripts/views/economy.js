/*
  The economy readout at the top of the manager's Pull log tab, for the GM
  alone (VIB-218): one glance answers "is this game fair, and who is
  spending". Two tables, each in a box of its own that scrolls sideways in
  a narrow window (the log's own table stacks its rows instead):

  - By character: Spent, Won in coins, Won in items and Net, sorted by
    Spent. An item counts at its dnd5e price when it was won (the row's
    `worth`, core/afterplay.js worthCp); one sold back counts as the coins
    it fetched, and one given away counts for the character who has it now.
  - By game: Plays, Taken, Paid in coins, Paid in items, Payback (what it
    paid out in coins and items for what it took in) and Set payback (the
    one its settings give, where the kind can say: kinds.js payback),
    sorted by Taken.

  All time reads the tallies (core/tally.js chars, games), written with
  each row and undone by its refund, so it doesn't depend on the log's
  500-row trim. This session counts the log's rows since the GM's client
  loaded (tally.js econOf), and says so. Money is in the module's own
  coins (currency.js formatPrice), as every price in the manager.

  No Foundry globals: the caller passes the tallies, the log, the games,
  the period, the load time and the escape.
*/
import { econOf, econTally } from "../core/tally.js";
import { formatPrice } from "../core/currency.js";
import { getKind, kindOf } from "../games/kinds.js";
import { t, words } from "../core/i18n.js";

const plain = s => String(s ?? "");

export const PERIODS = ["all", "session"];
export const CHAR_COLUMNS = words(["LOOTCRATES.Economy.ColCharacter", "LOOTCRATES.Economy.ColSpent", "LOOTCRATES.Economy.ColWonCoins", "LOOTCRATES.Economy.ColWonItems", "LOOTCRATES.Economy.ColNet"]);
export const GAME_COLUMNS = words(["LOOTCRATES.Economy.ColGame", "LOOTCRATES.Economy.ColPlays", "LOOTCRATES.Economy.ColTaken", "LOOTCRATES.Economy.ColPaidCoins", "LOOTCRATES.Economy.ColPaidItems", "LOOTCRATES.Economy.ColPayback", "LOOTCRATES.Economy.ColSet"]);

const n = v => Math.round(Number(v) || 0);
const money = cp => formatPrice(n(cp) / 100);
// A net that can fall below nothing: "−12 gp 5 sp".
export const signedMoney = cp => (n(cp) < 0 ? t("LOOTCRATES.Economy.Minus", { price: money(-n(cp)) }) : money(cp));

/*
  Each character's line: { id, name, spent, coins (paid out plus sold
  back), items (won, less sold back and given away, plus given to them),
  net }, in copper, sorted by spent (most first), then name.
*/
export function charLines(chars = {}) {
  return Object.entries(chars ?? {}).map(([id, c]) => {
    const coins = n(c.paid) + n(c.sold);
    const items = Math.max(0, n(c.items) - n(c.soldWorth) - n(c.gave) + n(c.got));
    return { id, name: plain(c.name), spent: n(c.spent), coins, items, net: coins + items - n(c.spent) };
  }).sort((a, b) => b.spent - a.spent || a.name.localeCompare(b.name));
}

/*
  Each game's line: { id, name (the game's name now, else as its rows
  had it), plays, taken, paid, items, actual (whole percent, null when it
  took nothing in), set (kinds.js payback, or null) }, sorted by taken.
*/
export function gameLines(games = {}, boxes = {}) {
  return Object.entries(games ?? {}).map(([id, g]) => {
    const game = boxes?.[id] ?? null;
    const taken = n(g.taken);
    const out = n(g.paid) + n(g.items);
    return { id, name: plain(game?.name ?? g.name), plays: n(g.plays), taken, paid: n(g.paid), items: n(g.items), actual: taken > 0 ? Math.round((out / taken) * 100) : null, set: game ? setPayback(game) : null };
  }).sort((a, b) => b.taken - a.taken || a.name.localeCompare(b.name));
}

// The game's set payback from its kind (kinds.js payback), or null.
export function setPayback(game) {
  try { return getKind(kindOf(game))?.payback?.(game) ?? null; } catch { return null; }
}

// "65%", "65% + items", "92–97%": a set payback as its cell reads it ("" for none).
export function setText(pb) {
  if (!pb) return "";
  if (pb.min != null && pb.max != null) return t(pb.items ? "LOOTCRATES.Economy.RangeItems" : "LOOTCRATES.Economy.Range", { min: pb.min, max: pb.max });
  if (pb.pct == null) return "";
  return t(pb.items ? "LOOTCRATES.Economy.PctItems" : "LOOTCRATES.Economy.Pct", { pct: pb.pct });
}
export const actualText = pct => (pct == null ? "" : t("LOOTCRATES.Economy.Pct", { pct }));

// The rows a period counts: the tallies (all time), or the log's rows since `since`.
export function economyOf({ period = "all", tally = null, log = [], since = 0 } = {}) {
  if (period === "session") return econOf((Array.isArray(log) ? log : []).filter(r => Number(r?.at) >= since));
  return econTally(tally);
}

const num = text => `<td class="lc-econ__num">${text}</td>`;
const name = text => `<th scope="row">${text}</th>`;
const head = cols => `<thead><tr>${cols.map((c, i) => `<th scope="col"${i ? ` class="lc-econ__num"` : ""}>${c}</th>`).join("")}</tr></thead>`;

// One table in its own scroll box, named for a screen reader (the region
// is a tab stop, so a keyboard can scroll it sideways).
function boxed(id, caption, cols, rows) {
  return `<div class="lc-econ__scroll" role="region" tabindex="0" aria-labelledby="${id}">
      <table class="lc-table lc-econ__table"><caption id="${id}">${caption}</caption>${head(cols)}<tbody>${rows}</tbody></table>
    </div>`;
}

/*
  The readout's markup. `period` "all" or "session", `since` the GM's load
  time (ms), `boxes` the games by id (the names now and the set payback).
*/
export function economyHTML({ tally = null, log = [], boxes = {}, period = "all", since = 0, esc = plain } = {}) {
  const which = PERIODS.includes(period) ? period : "all";
  const econ = economyOf({ period: which, tally, log, since });
  const chars = charLines(econ.chars);
  const games = gameLines(econ.games, boxes);
  const session = which === "session";
  const toggle = PERIODS.map(p => `<button type="button" data-action="econPeriod" data-period="${p}" aria-pressed="${p === which}">${t(p === "session" ? "LOOTCRATES.Economy.Session" : "LOOTCRATES.Economy.AllTime")}</button>`).join("");
  const charRows = chars.map(c => `<tr>${name(esc(c.name))}${num(esc(money(c.spent)))}${num(esc(money(c.coins)))}${num(esc(money(c.items)))}${num(esc(signedMoney(c.net)))}</tr>`).join("");
  const gameRows = games.map(g => `<tr>${name(esc(g.name))}${num(esc(String(g.plays)))}${num(esc(money(g.taken)))}${num(esc(money(g.paid)))}${num(esc(money(g.items)))}${num(esc(actualText(g.actual)))}${num(esc(setText(g.set)))}</tr>`).join("");
  const body = chars.length || games.length
    ? `${boxed("lc-econ-chars", t(session ? "LOOTCRATES.Economy.ByCharacterSession" : "LOOTCRATES.Economy.ByCharacter"), CHAR_COLUMNS, charRows)}
    <p class="lc-econ__note">${t("LOOTCRATES.Economy.CharNote")}</p>
    ${boxed("lc-econ-games", t(session ? "LOOTCRATES.Economy.ByGameSession" : "LOOTCRATES.Economy.ByGame"), GAME_COLUMNS, gameRows)}
    <p class="lc-econ__note">${t("LOOTCRATES.Economy.GameNote")}</p>`
    : `<p class="lc-econ__note">${t(session ? "LOOTCRATES.Economy.EmptySession" : "LOOTCRATES.Economy.Empty")}</p>`;
  return `<section class="lc-econ" aria-labelledby="lc-econ-title">
    <div class="lc-econ__head"><h3 id="lc-econ-title" class="lc-econ__title">${t("LOOTCRATES.Economy.Title")}</h3><div class="lc-econ__period" role="group" aria-label="${t("LOOTCRATES.Economy.Period")}">${toggle}</div></div>
    ${session ? `<p class="lc-econ__note">${t("LOOTCRATES.Economy.SessionNote")}</p>` : ""}
    ${body}
  </section>`;
}
