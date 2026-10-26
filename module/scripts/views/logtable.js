/*
  The manager's Pull log as markup (manager.js _log), drawn by the manager
  and by the harness: the log newest first, every game's misses (a well's
  quiet throws, a crate's "Nothing") folded per character, game and day
  (well.js collapseMisses) into one line whose Refund gives the newest of
  them back, so the log stays readable at a table that plays a lot and
  every miss is still refundable; a table round's stakes
  folded under the round's own line (round.js groupRounds). "Hide misses"
  (a toggle with one label, pressed while they are hidden) leaves only the
  pulls that gave something (the misses stay in the setting). Under a row, in small print: where a GM-set rarity came from,
  what a game paid or took, a stake's state, and a sale its buyer called
  off too late. An auction's house bid (auction.js) is a row with no
  character and no coins: it names its bidder and its bid, and has no
  Refund, there being nothing to give back.

  Every cell names its column (data-label), so a narrow panel can stack
  the row as a card and caption each value (module.css, the lc-tab
  container); the roles keep it a table for a screen reader once the cells
  are no longer displayed as table cells (boxestable.js tableHTML).

  No Foundry globals: the caller passes the log, the rounds, the toggle
  and the escape.
*/
import { RARITY_LABEL } from "../core/config.js";
import { normalizeRarity } from "../core/odds.js";
import { CARD_KIND_LABEL } from "../games/deck.js";
import { collapseMisses, throwsText, missCountText } from "../games/well.js";
import { groupRounds, roundLine, stakeNote } from "../core/round.js";
import { formatPrice } from "../core/currency.js";
import { refundTime } from "./chatcard.js";
import { tableHTML, cell } from "./boxestable.js";
import { t, words } from "../core/i18n.js";

const plain = s => String(s ?? "");
const rarityName = r => RARITY_LABEL[normalizeRarity(r)] ?? String(r);

// The log's columns, as its header reads them and as a stacked row
// captions them (the last, the Refund, needs no caption).
export const LOG_COLUMNS = words(["LOOTCRATES.Log.ColWhen", "LOOTCRATES.Log.ColWho", "LOOTCRATES.Log.ColBox", "LOOTCRATES.Log.ColGot", ""]);

// "Legendary, set by GM (source Uncommon)" under a row whose rarity the GM
// set, so a Legendary rope can be traced to the Uncommon one in the compendium.
export function logRarityNote(row, esc = plain) {
  if (!Array.isArray(row?.sourceRarity)) return "";
  const from = row.sourceRarity.length ? t("LOOTCRATES.Log.Source", { rarities: row.sourceRarity.map(rarityName).join(t("LOOTCRATES.Common.Or")) }) : t("LOOTCRATES.Log.SourceNone");
  return `<small class="lc-log__rarity">${esc(t("LOOTCRATES.Log.SetByGM", { rarity: rarityName(row.rarity), from }))}</small>`;
}

// "Rolled 4, 6, 5 · won 30 gp" under a row of a game that paid coins out
// (the dice), or "took 20 gp" under one that took coins beyond the stake
// (the deck's bane): what a refund gives or takes back is on the row, not
// only in the confirm. A row from before payouts (payoutCp 0 or absent)
// says nothing; a deck's row names its card's kind.
export function logPayoutNote(row, esc = plain) {
  const cp = Math.round(Number(row?.payoutCp) || 0);
  const faces = Array.isArray(row?.faces) && row.faces.length ? t("LOOTCRATES.Log.Rolled", { faces: row.faces.join(t("LOOTCRATES.Common.ListComma")) }) : "";
  const card = row?.cardKind && row.cardKind !== "item" ? t("LOOTCRATES.Log.CardKind", { kind: CARD_KIND_LABEL[row.cardKind] ?? row.cardKind }) : "";
  const won = cp > 0 ? t("LOOTCRATES.Log.Won", { price: formatPrice(cp / 100) }) : cp < 0 ? t("LOOTCRATES.Log.Took", { price: formatPrice(-cp / 100) }) : "";
  const text = [faces, card, won].filter(Boolean).join(" · ");
  return text ? `<small class="lc-log__rarity">${esc(text)}</small>` : "";
}

// A table stake still waiting on its spin, or one turned back (round.js stakeNote).
export function logStakeNote(row, esc = plain) {
  const text = stakeNote(row);
  return text ? `<small class="lc-log__rarity">${esc(text)}</small>` : "";
}

// A pull its buyer called off after the charge (socket.js lateCancel): the
// sale stood, and the GM's notice sent them here to refund it if wanted.
export function logLateNote(row) {
  if (!row?.lateCancel || row.refunded) return "";
  return `<small class="lc-log__late">${t("LOOTCRATES.Log.LateCancel")}</small>`;
}

// A folded line's Refund, named for what it gives back: "Refund the
// throw", "Refund one of 3 pulls".
const REFUND_LABEL = {
  throw: ["LOOTCRATES.Log.RefundTheThrow", "LOOTCRATES.Log.RefundOneOfThrows"],
  pull: ["LOOTCRATES.Log.RefundThePull", "LOOTCRATES.Log.RefundOneOfPulls"],
};
const refundLabel = (n, noun) => t((REFUND_LABEL[noun] ?? REFUND_LABEL.throw)[n === 1 ? 0 : 1], { count: n });

// The whole tab: the misses toolbar when there are any, then the table.
export function logTableHTML({ log = [], rounds = {}, hideMisses = false, esc = plain }) {
  if (!log.length) return `<p class="lc-empty">${t("LOOTCRATES.Log.Empty")}</p>`;
  const items = groupRounds(collapseMisses(log), rounds);
  const folded = items.filter(x => x.group);
  const misses = folded.reduce((n, g) => n + g.rows.length, 0);
  const shown = hideMisses ? items.filter(x => !x.group) : items;
  const [WHEN, WHO, BOX, GOT, ACT] = LOG_COLUMNS;
  const status = (id, at) => `<span class="lc-log__status" tabindex="-1" data-row="${esc(id)}">${t("LOOTCRATES.Log.RefundedAt", { time: esc(refundTime(at)) })}</span>`;
  const got = (swatch, html) => cell(GOT, `<span class="lc-dot"></span>${html}`, `class="lc-rarity-${esc(swatch)}"`);
  const house = r => `<tr class="lc-row--house${r.refunded ? " lc-row--refunded" : ""}" role="row">
        ${cell(WHEN, new Date(r.at).toLocaleString())}${cell(WHO, esc(r.actorName))}${cell(BOX, t("LOOTCRATES.Log.HouseBidBox", { name: esc(r.boxName) }))}
        ${got("none", `${r.refunded ? `<s>${esc(r.name)}</s>` : esc(r.name)}<small class="lc-log__rarity">${esc(r.refunded ? t(r.refundReason === "outbid" ? "LOOTCRATES.Log.HouseOutbid" : "LOOTCRATES.Log.HouseClosed") : stakeNote(r) || t("LOOTCRATES.Log.HouseBid"))}</small>`)}
        ${cell(ACT, "")}
      </tr>`;
  const row = r => (r.house ? house(r) : `<tr class="${r.refunded ? "lc-row--refunded" : r.lateCancel ? "lc-row--late" : ""}" role="row">
        ${cell(WHEN, new Date(r.at).toLocaleString())}${cell(WHO, esc(r.actorName))}${cell(BOX, `${esc(r.boxName)} (${esc(formatPrice(r.price))})`)}
        ${got(r.rarity ?? r.swatch ?? r.stake?.swatch ?? (r.win ? "coin" : "none"), `${r.refunded ? `<s>${esc(r.name)}</s>` : esc(r.name)}${r.pity ? ` · ${t("LOOTCRATES.Common.Pity")}` : ""}${logRarityNote(r, esc)}${logPayoutNote(r, esc)}${logStakeNote(r, esc)}${logLateNote(r)}`)}
        ${cell(ACT, r.refunded ? status(r.id, r.refunded) : `<button type="button" data-action="refund" data-row="${esc(r.id)}">${t("LOOTCRATES.Log.Refund")}</button>`)}
      </tr>`);
  const group = g => {
    const n = g.rows.length;
    const newest = g.rows[0];
    return `<tr class="lc-row--group${g.refunded ? " lc-row--refunded" : ""}" role="row">
        ${cell(WHEN, new Date(newest.at).toLocaleString())}${cell(WHO, esc(g.actorName))}${cell(BOX, `${esc(g.boxName)} (${esc(formatPrice(g.price))})`)}
        ${got("none", g.refunded ? `<s>${esc(throwsText(n, g.noun))}</s>` : esc(throwsText(n, g.noun)))}
        ${cell(ACT, g.refunded ? status(newest.id, newest.refunded) : `<button type="button" data-action="refund" data-row="${esc(newest.id)}" aria-label="${refundLabel(n, g.noun)}">${n === 1 ? t("LOOTCRATES.Log.Refund") : t("LOOTCRATES.Log.RefundOne")}</button>`)}
      </tr>`;
  };
  // A table round: its header where its newest stake was, its stakes under it.
  const round = g => `<tr class="lc-row--group" role="row">
        ${cell(WHEN, new Date(g.at).toLocaleString())}${cell(WHO, t("LOOTCRATES.Log.Round"))}${cell(BOX, t("LOOTCRATES.Log.Staked", { name: esc(g.boxName), price: esc(formatPrice(g.staked)) }))}
        ${got("none", esc(roundLine(g)))}${cell(ACT, "")}
      </tr>${g.rows.map(row).join("")}`;
  const toolbar = misses ? `<div class="lc-toolbar"><button type="button" class="lc-switch" data-action="toggleMisses" aria-pressed="${hideMisses}">${t("LOOTCRATES.Log.HideMisses")}</button><span class="lc-pool__hint">${t(hideMisses ? "LOOTCRATES.Log.MissesHidden" : "LOOTCRATES.Log.MissesFolded", { count: esc(missCountText(folded)) })}</span></div>` : "";
  return `${toolbar}${shown.length ? tableHTML("lc-table--log", LOG_COLUMNS, shown.map(x => (x.round ? round(x) : x.group ? group(x) : row(x.row))).join("")) : `<p class="lc-empty">${t("LOOTCRATES.Log.OnlyMisses")}</p>`}`;
}
