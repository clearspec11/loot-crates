/*
  Every game's editor, as markup, in the order a GM plans a game: what it
  is (the name), what is in it (pools, prizes, cards, pockets, the lot),
  the odds, what it costs, who can buy, how it looks, then On the shelf.
  The manager (manager.js) opens these in its dialog and wires them; the
  harness and Vitest draw the same markup.

  Each section's first element carries data-section (name, pools, odds,
  weights, readout, price, limits, extras, shelf and each kind's own), so
  the order is one list a test can read. Only what applies is open: a
  pool picker and rarity weights only while the game has an item prize
  turned on (data-when="items": the dice's perfect roll, the wheel's item
  pocket, the well's item weight, a deck's item card; manager.js liveOdds
  calls showWhen), the weights only for rarities the ticked pools hold
  (foldWeights, the others behind "Show the other rarities"), and Who can
  buy and Extras folded with a one-line summary while nothing is set
  (foldHTML, foldSaid). Everything folded or hidden is still in the form,
  so Save keeps it as it was.

  No Foundry globals: `esc` and the world's pools come from the caller.
*/
import { RARITIES, RARITY_LABEL, DEFAULT_WEIGHTS } from "../core/config.js";
import { formatPrice } from "../core/currency.js";
import { oddsModeOf, flattenPool } from "../core/odds.js";
import { t, listAnd } from "../core/i18n.js";
import { limitsFieldset, stockField, perCharacterOf, perCharacterFromForm, perCharacterText } from "../core/limits.js";
import { byRest } from "../core/clock.js";
import { shelfFieldHTML } from "../core/shelf.js";
import { poolsFieldset, pityRow, stakeRow, betRangeRow, dragonRow, CARD_FIELDS, oddsModeFieldset, tableNoteHTML, nothingRow } from "./editorfields.js";
import { WELL_DEFAULTS, stakeCoins, noClockNote } from "../games/well.js";
import { DICE_DEFAULTS, FORMULAS } from "../games/dicegame.js";
import { CARD_KINDS, CARD_KIND_HINT, cardsOf, deckRiseFieldsHTML } from "../games/deck.js";
import { BET_TYPES, BET_TYPE_LABEL, pocketsOf, coloursOf, payoutOf, maxStakeOf, maxBetsOf, windowMsOf, itemOnRarity } from "../games/roulette.js";
import { scratchFieldsHTML, cardSaid, cardValues, showsLeft } from "../games/scratch.js";
import { fillFieldsHTML } from "../games/scratchplan.js";
import { MAX_HOUSE, MIN_GAVEL_SEC, HOUSE_TICK_MS, lotOf, lotFromEntry, lotFromCrate, incrementOf, reserveOf, gavelMsOf, houseOf } from "../games/auction.js";

const plain = s => String(s ?? "");
// The section's name on its first element (the markup's first tag).
const section = (key, html) => html.replace(/^(\s*<[a-z]+)/i, `$1 data-section="${key}"`);

// A new game's dialog opens with its name focused (naming it is the first
// job), or the price when the name came from a pool; an edit's opens on
// Save as every DialogV2 does. `autofocus` is read by the <dialog>'s
// show(), the first in tree order winning over the default button's.
export const autofocus = (field, { isNew = false, focus = null } = {}) => (isNew && (focus ?? "name") === field ? " autofocus" : "");

const nameHTML = (box, ctx) => `<label data-section="name">${t("LOOTCRATES.Manager.Name")} <input name="name" value="${ctx.esc(box.name)}"${autofocus("name", ctx)}></label>`;

/*
  The crate's price and the deck's first draw, typed as the Boxes row and
  the shop say them ("12 gp 5 sp", "5 sp", or a bare number of gold), read
  with currency.js parsePrice. While the field can't be read, the line
  under it says so and the default button is off (manager.js wirePrice).
*/
export function priceFieldHTML(label, box, opts = {}) {
  const esc = opts.esc ?? plain;
  const why = `lc-price-why-${esc(box.id)}`;
  return `<label class="lc-form__price">${label} <input name="price" type="text" data-price-field value="${esc(formatPrice(box.price))}" placeholder="${t("LOOTCRATES.Manager.PricePlaceholder")}" autocomplete="off" spellcheck="false" aria-describedby="${why}"${autofocus("price", opts)}></label>
      <p class="lc-form__hint lc-form__hint--warn" id="${why}" data-price-why aria-live="polite"></p>`;
}

// The live readout (manager.js liveOdds fills it), pinned at the dialog's
// foot while the GM works above it (module.css .lc-form__odds).
const readoutHTML = (box, label, esc) => `<div class="lc-form__odds" data-section="readout" role="group" aria-labelledby="lc-odds-${esc(box.id)}">
        <div class="lc-form__label" id="lc-odds-${esc(box.id)}">${label}</div>
        <div class="lc-form__preview"></div>
        <p class="lc-sr-only" role="status" aria-live="polite"></p>
      </div>`;

/*
  The rarity weights, one row each with its note; foldWeights hides the
  rows for rarities the ticked pools don't hold behind one button. `when`
  marks a group shown only while the game has an item prize turned on.
*/
export function weightsFieldset(legend, box, { esc = plain, when = "", hidden = false } = {}) {
  return `<fieldset class="lc-form__weights" data-section="weights"${when ? ` data-when="${when}"` : ""}${hidden ? " hidden" : ""}><legend>${legend}</legend>
        ${RARITIES.map(r => `<label class="lc-row" data-weight="${r}">${RARITY_LABEL[r]} <input name="w.${r}" type="number" min="0" step="1" value="${esc(box.weights?.[r] ?? DEFAULT_WEIGHTS[r])}"><span class="lc-form__hint" data-held="${r}"></span></label>`).join("")}
        <button type="button" class="lc-weights__more" aria-expanded="false" hidden></button>
      </fieldset>`;
}

/* ---------- Folds: Who can buy, Extras ---------- */

/*
  A group folded under one line that says what is set in it ("Anyone, as
  often as they like"; "10 in stock, 1 per character a day"), open from
  the start once anything is. `key` names what the line says (foldSaid).
*/
export function foldHTML(key, title, said, body, { open = false } = {}) {
  return `<details class="lc-fold" data-section="${key}" data-fold="${key}"${open ? " open" : ""}>
        <summary class="lc-fold__head"><span class="lc-fold__title">${title}</span> <span class="lc-fold__said" data-fold-said>${said}</span></summary>
        <div class="lc-fold__body">${body}</div>
      </details>`;
}

const whole = v => (v === "" || v == null || v === false || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.floor(Number(v))));

/*
  What a fold's line says, from the form's values (manager.js readForm):
  "limits" the stock and the limit per character, "cap" the well's throws
  a day, "extras" pity and no duplicates (`noun` pulls or throws). Empty
  when nothing is set.
*/
export function foldSaid(key, values = {}, { noun = "pulls" } = {}) {
  if (key === "limits") {
    const stock = "stock" in values ? whole(values.stock) : null;
    const per = perCharacterText({ rules: { perCharacter: perCharacterFromForm(values) } });
    return [stock != null ? t("LOOTCRATES.Fold.InStock", { count: stock }) : "", per].filter(Boolean).join(t("LOOTCRATES.Common.ListComma"));
  }
  if (key === "card") return cardSaid(values);
  if (key === "sees") {
    const left = values.showLeft === false ? t("LOOTCRATES.Fold.LeftHidden") : t("LOOTCRATES.Fold.LeftShown");
    const limits = foldSaid("limits", values);
    return limits ? t("LOOTCRATES.Fold.SeesAnd", { left, limits }) : left;
  }
  if (key === "cap") {
    const cap = whole(values.cap);
    return cap ? t("LOOTCRATES.Fold.WellCap", { count: cap }) : "";
  }
  if (key === "extras") {
    const on = v => v === true || v === "on";
    const pity = values.pityRarity ? { rarity: RARITY_LABEL[values.pityRarity] ?? values.pityRarity, after: Math.max(1, Number(values.pityAfter) || 1), noun: noun === "throws" ? t("LOOTCRATES.Editor.PityNounThrows") : t("LOOTCRATES.Editor.PityNounPulls") } : null;
    const dupes = on(values.noDuplicates);
    if (pity && dupes) return t("LOOTCRATES.Fold.PityNoDupes", pity);
    if (pity) return t("LOOTCRATES.Fold.Pity", pity);
    return dupes ? t("LOOTCRATES.Fold.NoDupes") : "";
  }
  return "";
}

// What a fold's line says while nothing in it is set.
const NOTHING_SET = { limits: "LOOTCRATES.Fold.Anyone", cap: "LOOTCRATES.Fold.Anyone", extras: "LOOTCRATES.Fold.Off" };
export const foldLine = (key, values, opts) => foldSaid(key, values, opts) || t(NOTHING_SET[key] ?? "LOOTCRATES.Fold.Off");

// The game's own values for the folds, as its form starts them.
function startValues(box) {
  const pc = perCharacterOf(box);
  return {
    stock: stockField(box) ?? "",
    limitMax: pc?.max ?? "",
    limitPer: pc?.per ?? "ever",
    cap: box.rules?.cap ?? "",
    pityRarity: box.rules?.pity?.minRarity ?? "",
    pityAfter: box.rules?.pity?.after ?? "",
    noDuplicates: !!box.rules?.noDuplicates,
  };
}

function limitsFold(box, ctx, { stock = true, title = t("LOOTCRATES.Fold.WhoCanBuy") } = {}) {
  const values = startValues(box);
  if (!stock) delete values.stock;
  const said = foldSaid("limits", values);
  return foldHTML("limits", title, ctx.esc(said || t("LOOTCRATES.Fold.Anyone")), limitsFieldset(box, { stock, draft: ctx.isNew, day: ctx.day, hasClock: ctx.hasClock, esc: ctx.esc }), { open: !!said });
}

function extrasFold(box, ctx, { noun = "pulls" } = {}) {
  const said = foldSaid("extras", startValues(box), { noun });
  return foldHTML("extras", t("LOOTCRATES.Fold.Extras"), ctx.esc(said || t("LOOTCRATES.Fold.Off")), `<fieldset class="lc-extras"><legend>${t("LOOTCRATES.Fold.Extras")}</legend>
        ${pityRow(box.rules?.pity, { noun, esc: ctx.esc })}
        <label class="lc-row"><input type="checkbox" name="noDuplicates" ${box.rules?.noDuplicates ? "checked" : ""}> ${t("LOOTCRATES.Manager.NoDuplicates")}</label>
      </fieldset>`, { open: !!said });
}

/* ---------- Each kind ---------- */

/*
  `ctx`: { esc, pools (the world's, a list), isNew, focus, copy, day,
  hasClock } and per kind: `sold` (scratch: the live roll's tickets
  sold), `newId` (wheel: a pocket row's id), `lots` (auction: lotChoices).
*/
const picker = (legend, box, ctx, opts = {}) => poolsFieldset(legend, ctx.pools, box.pools, { esc: ctx.esc, id: `lc-picks-${box.id}`, ...opts });

function crateHTML(box, ctx) {
  const { esc } = ctx;
  return [
    nameHTML(box, ctx),
    section("from", tableNoteHTML(box, { esc })),
    picker(t("LOOTCRATES.Manager.PoolsShare"), box, ctx, { makePool: true }),
    section("odds", oddsModeFieldset(box, { esc })),
    weightsFieldset(t("LOOTCRATES.Manager.RarityWeights"), box, { esc, hidden: oddsModeOf(box) === "weight" }),
    section("nothing", nothingRow(box, { esc })),
    readoutHTML(box, t("LOOTCRATES.Manager.ChancesSeen"), esc),
    section("price", priceFieldHTML(t("LOOTCRATES.Boxes.ColPrice"), box, ctx)),
    limitsFold(box, ctx),
    extrasFold(box, ctx),
    section("shelf", shelfFieldHTML(box, ctx)),
  ];
}

function wellHTML(box, ctx) {
  const { esc } = ctx;
  const odds = { ...WELL_DEFAULTS.odds, ...(box.odds ?? {}) };
  const cap = foldSaid("cap", startValues(box));
  return [
    nameHTML(box, ctx),
    `<fieldset data-section="outcomes"><legend>${t("LOOTCRATES.Manager.Outcomes")}</legend>
        ${[["nothing", t("LOOTCRATES.Odds.Nothing")], ["coin", t("LOOTCRATES.Well.CoinBack")], ["item", t("LOOTCRATES.Deck.HintItem")]].map(([k, l]) => `<label class="lc-row">${l} <input name="o.${k}" type="number" min="0" step="1" value="${esc(odds[k])}"></label>`).join("")}
      </fieldset>`,
    picker(t("LOOTCRATES.Manager.PoolsItem"), box, ctx, { when: "items" }),
    weightsFieldset(t("LOOTCRATES.Manager.ItemRarityWeights"), box, { esc, when: "items" }),
    readoutHTML(box, t("LOOTCRATES.Manager.ChancesSeen"), esc),
    section("price", stakeRow(stakeCoins(box.price), esc)),
    foldHTML("cap", t("LOOTCRATES.Fold.WhoCanPlay"), esc(cap || t("LOOTCRATES.Fold.Anyone")), `<fieldset class="lc-limits"><legend>${t("LOOTCRATES.Fold.WhoCanPlay")}</legend>
        <label class="lc-row">${t(byRest(ctx.day) ? "LOOTCRATES.Manager.WellCap" : "LOOTCRATES.Manager.WellCapDay", { input: `<input name="cap" type="number" min="0" step="1" value="${esc(box.rules?.cap ?? "")}">` })}</label>
        ${noClockNote({ day: ctx.day, hasClock: ctx.hasClock, cap: box.rules?.cap })}
      </fieldset>`, { open: !!cap }),
    extrasFold(box, ctx, { noun: "throws" }),
    section("shelf", shelfFieldHTML(box, ctx)),
  ];
}

function diceHTML(box, ctx) {
  const { esc } = ctx;
  const dice = { ...DICE_DEFAULTS, ...(box.dice ?? {}) };
  return [
    nameHTML(box, ctx),
    `<fieldset data-section="dragon"><legend>${t("LOOTCRATES.Manager.BeatDragon")}</legend>
        ${dragonRow(FORMULAS, dice, esc)}
        <label class="lc-row">${t("LOOTCRATES.Manager.WinPays", { input: `<input name="multiplier" type="number" min="0" step="0.5" value="${esc(dice.multiplier)}">` })}</label>
        <p class="lc-form__hint">${t("LOOTCRATES.Manager.TieLoses")}</p>
      </fieldset>`,
    `<fieldset data-section="prize"><legend>${t("LOOTCRATES.Manager.Prize")}</legend>
        <label class="lc-row"><input type="checkbox" name="prize" ${box.rules?.prize ? "checked" : ""}> ${t("LOOTCRATES.Manager.PrizeField")}</label>
      </fieldset>`,
    picker(t("LOOTCRATES.Manager.PoolsPrize"), box, ctx, { when: "items" }),
    weightsFieldset(t("LOOTCRATES.Manager.PrizeRarityWeights"), box, { esc, when: "items" }),
    readoutHTML(box, t("LOOTCRATES.Manager.ChancesSeen"), esc),
    section("price", stakeRow(stakeCoins(box.price), esc)),
    limitsFold(box, ctx, { stock: false }),
    section("shelf", shelfFieldHTML(box, ctx)),
  ];
}

/*
  One card of the deck editor (deck.js draftDeck reads these names): the
  row's data-kind decides which of the gold and text fields show. Its
  fields are named for the card's place in the deck, `n`
  (editorfields.js). Gold, weight and once carry a caption of their own
  for the narrow layout, where the column heads are gone.
*/
export function cardRow(c, n, esc = plain) {
  const id = esc(c.id);
  const name = key => CARD_FIELDS[key](n);
  const cap = key => `<span class="lc-card-row__cap" aria-hidden="true">${t(key)}</span>`;
  return `<div class="lc-card-row" data-card="${id}" data-kind="${esc(c.kind)}">
      <input type="hidden" name="cards" value="${id}">
      <input class="lc-card-row__label" name="c.${id}.label" value="${esc(c.label)}" placeholder="${t("LOOTCRATES.Manager.CardNamePlaceholder")}" aria-label="${name("label")}">
      <select class="lc-card-row__kind" name="c.${id}.kind" aria-label="${name("kind")}">${CARD_KINDS.map(k => `<option value="${k}"${k === c.kind ? " selected" : ""}>${esc(CARD_KIND_HINT[k])}</option>`).join("")}</select>
      <span class="lc-card-row__cell lc-card-row__cell--gp">${cap("LOOTCRATES.Manager.GoldHead")}<input class="lc-card-row__gp" name="c.${id}.gp" type="number" min="0" step="1" value="${esc(c.gp ?? 0)}" aria-label="${name("gp")}" placeholder="${t("LOOTCRATES.Manager.GpPlaceholder")}"></span>
      <span class="lc-card-row__cell">${cap("LOOTCRATES.Manager.WeightHead")}<input class="lc-card-row__weight" name="c.${id}.weight" type="number" min="0" step="1" value="${esc(c.weight ?? 1)}" aria-label="${name("weight")}"></span>
      <label class="lc-card-row__once"><input type="checkbox" name="c.${id}.once"${c.once ? " checked" : ""} aria-label="${name("once")}">${cap("LOOTCRATES.Manager.OnceHead")}</label>
      <button type="button" class="lc-card-row__remove" aria-label="${t("LOOTCRATES.Pools.RemoveLabel", { name: esc(c.label || t("LOOTCRATES.Manager.ThisCard")) })}" data-tooltip="${t("LOOTCRATES.Pools.Remove")}"><i class="fas fa-xmark" inert></i></button>
      <input class="lc-card-row__text" name="c.${id}.text" value="${esc(c.text ?? "")}" placeholder="${t("LOOTCRATES.Manager.EffectPlaceholder")}" aria-label="${name("text")}">
    </div>`;
}

function deckHTML(box, ctx) {
  const { esc } = ctx;
  return [
    nameHTML(box, ctx),
    `<fieldset class="lc-cards" data-section="cards"><legend>${t("LOOTCRATES.Manager.Cards")}</legend>
        <div class="lc-cards__head" aria-hidden="true"><span>${t("LOOTCRATES.Manager.CardHead")}</span><span>${t("LOOTCRATES.Manager.DoesHead")}</span><span>${t("LOOTCRATES.Manager.GoldHead")}</span><span>${t("LOOTCRATES.Manager.WeightHead")}</span><span>${t("LOOTCRATES.Manager.OnceHead")}</span><span></span></div>
        <div class="lc-cards__rows">${cardsOf(box).map((c, i) => cardRow(c, i + 1, esc)).join("")}</div>
        <div class="lc-cards__foot"><button type="button" class="lc-cards__add"><i class="fas fa-plus"></i> ${t("LOOTCRATES.Manager.AddCard")}</button></div>
        <p class="lc-form__hint">${t("LOOTCRATES.Manager.CardsHint")}</p>
      </fieldset>`,
    picker(t("LOOTCRATES.Manager.PoolsCards"), box, ctx, { when: "items" }),
    weightsFieldset(t("LOOTCRATES.Manager.ItemRarityWeights"), box, { esc, when: "items" }),
    readoutHTML(box, t("LOOTCRATES.Manager.ChancesSeen"), esc),
    `<fieldset data-section="price"><legend>${t("LOOTCRATES.Manager.PriceLegend")}</legend>
        ${priceFieldHTML(t("LOOTCRATES.Manager.FirstDraw"), box, ctx)}
        ${deckRiseFieldsHTML(box, esc)}
      </fieldset>`,
    limitsFold(box, ctx, { stock: false }),
    section("shelf", shelfFieldHTML(box, ctx)),
  ];
}

/*
  One pocket of the wheel editor (roulette.js draftRoulette reads these
  names): its place on the wheel, its colour (named as the GM names them)
  and its rarity. `id` is the row's own (the caller's newId).
*/
export function pocketRow(p, colours, id, esc = plain) {
  const pid = esc(id);
  return `<div class="lc-pocket-row lc-rarity-${esc(p.rarity)}" data-pocket="${pid}">
      <input type="hidden" name="pockets" value="${pid}">
      <span class="lc-pocket-row__n">${esc(p.n)}</span>
      <select class="lc-pocket-row__colour" name="p.${pid}.colour" aria-label="${t("LOOTCRATES.Manager.PocketColour", { n: esc(p.n) })}">${[0, 1].map(c => `<option value="${c}"${c === p.colour ? " selected" : ""}>${esc(colours[c])}</option>`).join("")}</select>
      <select class="lc-pocket-row__rarity" name="p.${pid}.rarity" aria-label="${t("LOOTCRATES.Manager.PocketRarity", { n: esc(p.n) })}">${RARITIES.map(r => `<option value="${r}"${r === p.rarity ? " selected" : ""}>${RARITY_LABEL[r]}</option>`).join("")}</select>
      <button type="button" class="lc-pocket-row__remove" aria-label="${t("LOOTCRATES.Manager.RemovePocket", { n: esc(p.n) })}" data-tooltip="${t("LOOTCRATES.Pools.Remove")}"><i class="fas fa-xmark" inert></i></button>
    </div>`;
}

function wheelHTML(box, ctx) {
  const { esc } = ctx;
  const colours = coloursOf(box);
  const newId = ctx.newId ?? (() => Math.random().toString(36).slice(2, 10));
  return [
    nameHTML(box, ctx),
    `<fieldset class="lc-pockets" data-section="pockets"><legend>${t("LOOTCRATES.Manager.Pockets")}</legend>
        <div class="lc-row lc-pockets__colours"><label>${t("LOOTCRATES.Manager.FirstColour")} <input name="colourA" class="lc-pockets__colour" data-colour="0" value="${esc(colours[0])}"></label><label>${t("LOOTCRATES.Manager.SecondColour")} <input name="colourB" class="lc-pockets__colour" data-colour="1" value="${esc(colours[1])}"></label></div>
        <div class="lc-pockets__rows">${pocketsOf(box).map(p => pocketRow(p, colours, newId(), esc)).join("")}</div>
        <div class="lc-cards__foot"><button type="button" class="lc-pockets__add"><i class="fas fa-plus"></i> ${t("LOOTCRATES.Manager.AddPocket")}</button></div>
        <p class="lc-form__hint">${t("LOOTCRATES.Manager.PocketsHint")}</p>
      </fieldset>`,
    `<fieldset data-section="payouts"><legend>${t("LOOTCRATES.Manager.Payouts")}</legend>
        ${BET_TYPES.map(target => `<label class="lc-row">${esc(BET_TYPE_LABEL[target])} <input name="pay.${target}" type="number" min="0" step="0.5" value="${esc(payoutOf(box, target))}">×</label>`).join("")}
      </fieldset>`,
    `<fieldset data-section="prize"><legend>${t("LOOTCRATES.Manager.ItemOnRarity")}</legend>
        <label class="lc-row"><input type="checkbox" name="itemOnRarity" ${itemOnRarity(box) ? "checked" : ""}> ${t("LOOTCRATES.Manager.ItemOnRarityField")}</label>
      </fieldset>`,
    picker(t("LOOTCRATES.Manager.PoolsWheel"), box, ctx, { share: false, when: "items" }),
    readoutHTML(box, t("LOOTCRATES.Manager.ChancesSeen"), esc),
    `<fieldset data-section="price"><legend>${t("LOOTCRATES.Manager.Bets")}</legend>
        ${betRangeRow(box.price, maxStakeOf(box), esc)}
        <label class="lc-row">${t("LOOTCRATES.Manager.MaxBets", { input: `<input name="maxBets" type="number" min="0" step="1" value="${esc(maxBetsOf(box))}">` })}</label>
        <label class="lc-row">${t("LOOTCRATES.Manager.Window", { input: `<input name="windowSec" type="number" min="0" step="5" value="${esc(windowMsOf(box) / 1000)}">` })}</label>
      </fieldset>`,
    section("shelf", shelfFieldHTML(box, ctx)),
  ];
}

/* ---------- The auction's lot ---------- */

// A lot's choice value: a crate by its id, an item by its uuid.
export const lotKey = lot => (!lot ? "" : lot.type === "crate" ? `crate:${lot.boxId}` : `item:${lot.uuid}`);

/*
  What an auction can sell: every crate (sold sealed), every item in each
  pool, listed under each pool that holds it (a pool's nested pools
  included; a missing or never-dropping entry left out), and the game's
  own lot when it is neither (an item dropped earlier). `choices` maps a
  value to its lot (one per item, however many pools hold it), `groups`
  the list as the picker shows it: [{ label, keys, dropped }].
*/
export function lotChoices(boxes, pools, own = null) {
  const choices = new Map();
  const groups = [];
  const crates = Object.values(boxes ?? {}).filter(b => (b.kind ?? "crate") === "crate").map(b => lotFromCrate(b));
  for (const lot of crates) choices.set(lotKey(lot), lot);
  if (crates.length) groups.push({ label: t("LOOTCRATES.Auction.SealedCrates"), keys: crates.map(lotKey) });
  const list = Object.values(pools ?? {}).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  for (const p of list) {
    const keys = [];
    for (const e of flattenPool(p.id, pools)) {
      const lot = lotFromEntry(e);
      const key = lotKey(lot);
      if (keys.includes(key)) continue;
      if (!choices.has(key)) choices.set(key, lot);
      keys.push(key);
    }
    if (keys.length) groups.push({ label: p.name, keys });
  }
  if (own && !choices.has(lotKey(own))) {
    choices.set(lotKey(own), { ...own, dropped: true });
    groups.push({ label: t("LOOTCRATES.Auction.DroppedHere"), keys: [lotKey(own)], dropped: true });
  }
  return { choices, groups };
}

const lotLabel = (l, esc) => esc(l.type === "crate" ? l.name : `${l.name}${l.rarity && l.rarity !== "none" ? `, ${RARITY_LABEL[l.rarity] ?? l.rarity}` : ""}`);
export const lotOptionHTML = (key, lot, esc = plain, selected = false) => `<option value="${esc(key)}" data-name="${esc(String(lot.name ?? "").toLowerCase())}"${selected ? " selected" : ""}>${lotLabel(lot, esc)}</option>`;

/*
  The lot picker: a search box over a list of the lots, grouped (the
  crates, then each pool by name, then any dropped here), the game's lot
  chosen in its first place; then the drop zone. An item in two pools is
  listed in both.
*/
export function lotPickerHTML({ choices, groups }, picked = "", esc = plain) {
  let marked = false;
  const options = groups.map(g => `<optgroup label="${esc(g.label)}"${g.dropped ? " data-dropped" : ""}>${g.keys.map(k => {
    const first = !marked && k === picked;
    if (first) marked = true;
    return lotOptionHTML(k, choices.get(k), esc, first);
  }).join("")}</optgroup>`).join("");
  return `<fieldset class="lc-auction-lot" data-section="lot"><legend>${t("LOOTCRATES.Auction.TheLotLegend")}</legend>
        <input type="search" class="lc-auction-lot__search" placeholder="${t("LOOTCRATES.Auction.FindLot")}" aria-label="${t("LOOTCRATES.Auction.FindLotLabel")}" autocomplete="off" spellcheck="false">
        <p class="lc-form__hint lc-auction-lot__count" role="status" aria-live="polite"></p>
        <label class="lc-field lc-auction-lot__field">${t("LOOTCRATES.Auction.WhatIsSold")} <select name="lot" class="lc-auction-lot__pick" size="8"><option value=""${marked ? "" : " selected"}>${t("LOOTCRATES.Auction.PickLot")}</option>${options}</select></label>
        <div class="lc-auction-lot__drop" data-lot-drop>${t("LOOTCRATES.Auction.DropLot")}</div>
        <p class="lc-form__hint" data-lot-said role="status"></p>
      </fieldset>`;
}

// The lot search's line: how many lots match, or that none does.
export function lotMatchText(count, query) {
  if (!query) return "";
  if (!count) return t("LOOTCRATES.Auction.LotNoMatch", { query });
  return t(count === 1 ? "LOOTCRATES.Auction.LotMatchOne" : "LOOTCRATES.Auction.LotMatchMany", { count });
}

/*
  The lot search: typing filters the list by the lot's name (a group with
  nothing left goes too); Enter picks the first match and says so, as a
  drop does, instead of pressing the dialog's default button; Escape
  clears a search before it closes anything. `said(text)` is the line
  under the drop zone.
*/
export function wireLotSearch(form) {
  const search = form.querySelector(".lc-auction-lot__search");
  const pick = form.querySelector(".lc-auction-lot__pick");
  if (!search || !pick) return;
  const count = form.querySelector(".lc-auction-lot__count");
  const said = form.querySelector("[data-lot-said]");
  const filter = () => {
    const query = String(search.value ?? "").trim();
    const q = query.toLowerCase();
    let shown = 0;
    for (const group of pick.querySelectorAll("optgroup")) {
      let any = false;
      for (const opt of group.querySelectorAll("option")) {
        const hit = !q || String(opt.dataset.name ?? "").includes(q);
        opt.hidden = !hit;
        if (hit) { any = true; shown++; }
      }
      group.hidden = !any;
    }
    if (count) count.textContent = lotMatchText(shown, query);
  };
  // The line under the list names the lot, so it shows while a search hides it.
  const sayLot = () => {
    const opt = [...pick.querySelectorAll("option")].find(o => o.selected && o.getAttribute("value")) ?? null;
    const text = opt ? t("LOOTCRATES.Auction.IsTheLot", { name: opt.textContent }) : "";
    if (said && said.textContent !== text) said.textContent = text;
  };
  pick.addEventListener("change", sayLot);
  sayLot();
  search.addEventListener("input", filter);
  search.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      const first = [...pick.querySelectorAll("optgroup option")].find(o => !o.hidden && !o.parentNode?.hidden);
      if (!first) return;
      first.selected = true;
      pick.dispatchEvent(new Event("change", { bubbles: true }));
      sayLot();
    } else if (e.key === "Escape" && search.value) {
      e.preventDefault();
      e.stopPropagation();
      search.value = "";
      filter();
    }
  });
  return filter;
}

function auctionHTML(box, ctx) {
  const { esc } = ctx;
  const house = houseOf(box);
  return [
    nameHTML(box, ctx),
    lotPickerHTML(ctx.lots ?? { choices: new Map(), groups: [] }, lotKey(lotOf(box)), esc),
    `<fieldset data-section="price"><legend>${t("LOOTCRATES.Auction.WordsList")}</legend>
        ${priceFieldHTML(t("LOOTCRATES.Auction.OpeningBidLine"), box, ctx)}
        <div class="lc-row lc-row--wrap">${t("LOOTCRATES.Auction.IncrementField", { input: `<input name="increment" type="number" min="0" step="any" value="${esc(incrementOf(box))}" aria-label="${t("LOOTCRATES.Auction.IncrementLabel")}">` })}</div>
        <div class="lc-row lc-row--wrap">${t("LOOTCRATES.Auction.ReserveField", { input: `<input name="reserve" type="number" min="0" step="any" value="${esc(reserveOf(box))}" aria-label="${t("LOOTCRATES.Auction.ReserveLabel")}">` })}</div>
        <div class="lc-row lc-row--wrap">${t("LOOTCRATES.Auction.GavelField", { input: `<input name="gavelSec" type="number" min="${MIN_GAVEL_SEC}" step="1" value="${esc(gavelMsOf(box) / 1000)}" aria-label="${t("LOOTCRATES.Auction.GavelLabel")}">` })}</div>
        <p class="lc-form__hint">${t("LOOTCRATES.Auction.BidsHint")}</p>
      </fieldset>`,
    `<fieldset data-section="house"><legend>${t("LOOTCRATES.Auction.HouseLegend")}</legend>
        <div class="lc-row lc-row--wrap">${t("LOOTCRATES.Auction.HouseField", {
          count: `<input name="houseCount" type="number" min="0" max="${MAX_HOUSE}" step="1" value="${esc(house.count)}" aria-label="${t("LOOTCRATES.Auction.HouseCountLabel")}">`,
          budget: `<input name="houseBudget" type="number" min="0" step="any" value="${esc(house.budget)}" aria-label="${t("LOOTCRATES.Auction.HouseBudgetLabel")}">`,
          chance: `<input name="houseChance" type="number" min="0" max="100" step="1" value="${esc(house.chance)}" aria-label="${t("LOOTCRATES.Auction.HouseChanceLabel")}">`,
          every: HOUSE_TICK_MS / 1000,
        })}</div>
        <p class="lc-form__hint">${t("LOOTCRATES.Auction.HouseHint")}</p>
      </fieldset>`,
    readoutHTML(box, t("LOOTCRATES.Auction.TableSees"), esc),
    section("shelf", shelfFieldHTML(box, ctx)),
  ];
}

function scratchHTML(box, ctx) {
  const { esc } = ctx;
  // The scratch sections (scratch.js) with the pools where Fill reads them:
  // right above the prizes. The readout follows the prizes it reads out.
  // The card is set once and said in a line (folded); Who sees what holds
  // "Players see what is left" and the limit per character, folded while
  // players see the counts and there is no limit.
  const start = { ...startValues(box), showLeft: showsLeft(box) };
  delete start.stock;
  const seesSaid = foldSaid("sees", start);
  const card = html => foldHTML("card", t("LOOTCRATES.Scratch.LayoutLegend"), esc(cardSaid(cardValues(box))), html);
  const sees = html => foldHTML("sees", t("LOOTCRATES.Scratch.SeesLegend"), esc(seesSaid), `<fieldset class="lc-scratch-form__sees"><legend>${t("LOOTCRATES.Scratch.SeesLegend")}</legend>${html}</fieldset>
        ${limitsFieldset(box, { stock: false, draft: ctx.isNew, day: ctx.day, hasClock: ctx.hasClock, esc })}`, { open: seesSaid !== t("LOOTCRATES.Fold.LeftShown") });
  const parts = scratchFieldsHTML(box, { esc, sold: ctx.sold ?? 0, fill: fillFieldsHTML(box, { esc }), pools: picker(t("LOOTCRATES.Scratch.PoolsField"), box, ctx), card, sees })
    .split(/(?=<details class="lc-fold" data-section="card")/);
  return [
    nameHTML(box, ctx),
    section("price", priceFieldHTML(t("LOOTCRATES.Scratch.PriceField"), box, ctx)),
    parts[0],
    readoutHTML(box, t("LOOTCRATES.Scratch.ReadoutLabel"), esc),
    parts[1],
    section("shelf", shelfFieldHTML(box, ctx)),
  ];
}

const KINDS = { crate: crateHTML, well: wellHTML, dice: diceHTML, deck: deckHTML, roulette: wheelHTML, auction: auctionHTML, scratch: scratchHTML };

// The editor's markup for a game of `kind`, its sections in order.
export function editorHTML(kind, box, ctx = {}) {
  const full = { esc: plain, pools: [], isNew: false, focus: null, copy: false, day: null, hasClock: true, ...ctx };
  return (KINDS[kind] ?? crateHTML)(box, full).filter(Boolean).join("\n      ");
}

// Every section's key in the order the editor shows them.
export const sectionsOf = root => [...root.querySelectorAll("[data-section]")].map(el => el.dataset.section);

/* ---------- What applies, live ---------- */

// Whether a draft has an item prize turned on, by kind: the parts marked
// data-when="items" show only then.
export function itemsOn(draft) {
  switch (draft?.kind ?? "crate") {
    case "well": return Number(draft.odds?.item) > 0;
    case "dice": return !!draft.rules?.prize;
    case "deck": return (draft.deck?.cards ?? []).some(c => c.kind === "item");
    case "roulette": return itemOnRarity(draft);
    default: return true;
  }
}

export function showWhen(form, draft) {
  const on = itemsOn(draft);
  for (const el of form.querySelectorAll('[data-when="items"]')) if (!!el.hidden === on) el.hidden = !on;
}

/*
  The weights the ticked pools can't use step aside: with a pool ticked,
  only the rarities it holds keep their rows, and one button shows the
  others (each saying "none in these pools") or puts them away again. With
  no pool ticked every row shows.
*/
export function foldWeights(form, held, hasPools) {
  for (const set of form.querySelectorAll(".lc-form__weights")) {
    const more = set.querySelector(".lc-weights__more");
    const out = hasPools ? RARITIES.filter(r => !held.has(r)) : [];
    const open = more?.getAttribute("aria-expanded") === "true";
    for (const row of set.querySelectorAll("[data-weight]")) {
      const hide = out.includes(row.dataset.weight) && !open;
      if (row.hidden !== hide) row.hidden = hide;
    }
    if (!more) continue;
    more.hidden = !out.length;
    const text = open ? t("LOOTCRATES.Editor.WeightsFewer") : t("LOOTCRATES.Editor.WeightsMore", { names: listAnd(out.map(r => RARITY_LABEL[r])) });
    if (more.textContent !== text) more.textContent = text;
  }
}

/*
  The parts of an editor that follow the form (pure DOM): "Show the other
  rarities" opens and closes; each fold's line follows what is typed in
  it. `read()` is the form's values (manager.js readForm), `repaint()`
  the editor's own paint (it calls foldWeights).
*/
export function wireEditor(form, { read, repaint = () => {}, noun = "pulls" } = {}) {
  for (const more of form.querySelectorAll(".lc-weights__more")) {
    more.addEventListener("click", () => {
      more.setAttribute("aria-expanded", String(more.getAttribute("aria-expanded") !== "true"));
      repaint();
    });
  }
  // A field in a fold that can't be saved (a stock below 0: Save is off,
  // editorguard.js) puts its reason on the fold's line, so a folded group
  // never hides why Save is off behind "0 in stock".
  const folds = [...form.querySelectorAll("[data-fold]")];
  const say = () => {
    const values = read();
    for (const fold of folds) {
      const line = fold.querySelector("[data-fold-said]");
      const bad = fold.querySelector('[aria-invalid="true"]')?.validationMessage || "";
      const text = bad || foldLine(fold.dataset.fold, values, { noun });
      if (line && line.textContent !== text) line.textContent = text;
      if (line) line.classList[bad ? "add" : "remove"]("lc-form__hint--warn");
    }
  };
  if (folds.length) {
    form.addEventListener("input", say);
    form.addEventListener("change", say);
  }
  return say;
}

/*
  The pinned readout never covers what the GM is working on: the dialog's
  scroll box keeps the readout's height as scroll padding, so a control
  focused or scrolled to (Fill's buttons, the first new prize) stops
  above it rather than under it.
*/
export function wireReadout(form) {
  const readout = form.querySelector(".lc-form__odds");
  const scroller = form.querySelector(".dialog-content") ?? form.closest?.(".dialog-content");
  if (!readout || !scroller || typeof ResizeObserver !== "function") return;
  const fit = () => scroller.style.setProperty("--lc-readout-h", `${Math.ceil(readout.getBoundingClientRect().height)}px`);
  new ResizeObserver(fit).observe(readout);
  fit();
}
