/*
  The editors' shared fields (manager.js): one copy for every kind, so
  each control has a name of its own and a new field inherits one.

  A <label> names only the first control inside it, so a row holding two
  controls in one label left the second unnamed or misnamed (the pity
  count had no name, every share was "Share", the wheel's largest bet was
  its placeholder "any"). Here a control is either alone in its label
  (`field`) or carries an aria-label saying what it sets.

  No Foundry globals: the callers pass `esc`, and the harness and Vitest
  render these as the manager does.
*/
import { RARITIES, RARITY_LABEL } from "../core/config.js";
import { oddsModeOf, missChanceOf, chanceLabel } from "../core/odds.js";
import { t, words } from "../core/i18n.js";
import { poolPickerHTML } from "./poolpicker.js";

const plain = s => String(s ?? "");

// One control in a label of its own: the words before it are its name.
// The rows that hold one (lc-row--wrap) wrap onto a second line rather
// than run past a narrow dialog's edge.
export const field = (labelText, control) => `<label class="lc-field">${labelText} ${control}</label>`;

/*
  The pools a game draws from (poolpicker.js): the game's own pools first,
  each with its share and what it holds, the rest folded under "Add a
  pool" with a search. With `share`, a pool's share of pulls is named for
  its pool and off while the pool is unticked (draftBox reads no share
  for an unticked pool, so there is nothing to type). `refs` is the
  game's pools ([{ id, share }]); `pools` the world's (a list or the map).
*/
export const poolPicks = (pools, refs = [], opts = {}) => poolPickerHTML(pools, refs, opts);

export const poolsFieldset = (legend, pools, refs, opts = {}) => `<fieldset class="lc-pool-picks" data-section="pools"${opts.when ? ` data-when="${opts.when}"` : ""}><legend>${legend}</legend>
        ${poolPickerHTML(pools, refs, opts)}
      </fieldset>`;

// Each share follows its pool's checkbox (on and shown while ticked); the
// editors call it on every input and change (manager.js liveOdds).
export function syncShares(root) {
  for (const share of root.querySelectorAll("input[data-share]")) {
    const box = share.closest(".lc-pool-pick")?.querySelector('input[type="checkbox"]');
    if (!box) continue;
    share.disabled = !box.checked;
    share.hidden = !box.checked;
  }
}

// What the pity count is called, by what a play is called.
const PITY_COUNT = words({ pulls: "LOOTCRATES.Editor.PityCountPulls", throws: "LOOTCRATES.Editor.PityCountThrows" });
const PITY_NOUN = words({ pulls: "LOOTCRATES.Editor.PityNounPulls", throws: "LOOTCRATES.Editor.PityNounThrows" });

// "Pity: guarantee [rarity] after [n] pulls": the rarity named by its
// label, the count by what it counts.
export function pityRow(pity, { noun = "pulls", esc = plain } = {}) {
  const select = `<select name="pityRarity"><option value="">${t("LOOTCRATES.Editor.PityOff")}</option>${RARITIES.map(r => `<option value="${r}"${pity?.minRarity === r ? " selected" : ""}>${t("LOOTCRATES.Editor.OrBetter", { rarity: RARITY_LABEL[r] })}</option>`).join("")}</select>`;
  const count = `<input name="pityAfter" type="number" min="1" step="1" value="${esc(pity?.after ?? 10)}" aria-label="${PITY_COUNT[noun] ?? PITY_COUNT.pulls}">`;
  return `<div class="lc-row lc-row--wrap">${t("LOOTCRATES.Editor.PityRow", { guarantee: field(t("LOOTCRATES.Editor.PityGuarantee"), select), count, noun: PITY_NOUN[noun] ?? noun })}</div>`;
}

// The well's and the dice game's stake: an amount, then its coin.
export function stakeRow(stake, esc = plain) {
  return `<div class="lc-row lc-row--wrap lc-form__stake">${field(t("LOOTCRATES.Editor.Stake"), `<input name="stake" type="number" min="0" step="1" value="${esc(stake.amount)}">`)} <select name="coin" aria-label="${t("LOOTCRATES.Editor.Coin")}">${["cp", "sp", "gp"].map(c => `<option value="${c}"${c === stake.coin ? " selected" : ""}>${c}</option>`).join("")}</select></div>`;
}

// The wheel's "From [least] to [most] gp a bet", each bound named for itself.
export function betRangeRow(least, most, esc = plain) {
  const from = `<input name="price" type="number" min="0" step="1" value="${esc(least)}" aria-label="${t("LOOTCRATES.Editor.BetLeast")}">`;
  const to = `<input name="maxStake" type="number" min="0" step="1" value="${esc(most ?? "")}" placeholder="${t("LOOTCRATES.Editor.BetAny")}" aria-label="${t("LOOTCRATES.Editor.BetMost")}">`;
  return `<div class="lc-row lc-row--wrap">${t("LOOTCRATES.Editor.BetRange", { from, to })}</div>`;
}

// The dice game's "Roll [2d6] over the dragon's [n]".
export function dragonRow(formulas, dice, esc = plain) {
  const select = `<select name="formula">${formulas.map(f => `<option value="${esc(f)}"${f === dice.formula ? " selected" : ""}>${esc(f)}</option>`).join("")}</select>`;
  const target = `<input name="target" type="number" min="0" step="1" value="${esc(dice.target)}" aria-label="${t("LOOTCRATES.Editor.DragonNumber")}">`;
  return `<div class="lc-row lc-row--wrap">${t("LOOTCRATES.Editor.DragonRow", { roll: field(t("LOOTCRATES.Editor.Roll"), select), target })}</div>`;
}

/*
  The deck editor's card rows name each field by the card's place in the
  deck ("Weight of card 2"), so a deck of many cards doesn't read "Weight"
  a dozen times; `renumberCards` keeps the numbers right after a remove.
*/
export const CARD_FIELDS = {
  label: n => t("LOOTCRATES.Deck.CardName", { n }),
  kind: n => t("LOOTCRATES.Deck.CardKind", { n }),
  gp: n => t("LOOTCRATES.Deck.CardGp", { n }),
  weight: n => t("LOOTCRATES.Deck.CardWeight", { n }),
  once: n => t("LOOTCRATES.Deck.CardOnce", { n }),
  text: n => t("LOOTCRATES.Deck.CardText", { n }),
};
export function renumberCards(rows) {
  [...rows.children].forEach((row, i) => {
    for (const [key, name] of Object.entries(CARD_FIELDS)) row.querySelector(`.lc-card-row__${key}${key === "once" ? " input" : ""}`)?.setAttribute("aria-label", name(i + 1));
  });
}

/*
  The crate's odds as one choice (rules.oddsMode, odds.js), each option a
  radio in a label of its own with one plain sentence under it, named to
  it with aria-describedby. A crate made from a roll table calls the
  second "Use the table's odds"; any other crate, "By item weight".
*/
export function oddsModeFieldset(box, { esc = plain } = {}) {
  const mode = oddsModeOf(box);
  const id = esc(box.id);
  const table = !!box.fromTable;
  const options = [
    ["rarity", t("LOOTCRATES.Editor.ByRarity"), t("LOOTCRATES.Editor.ByRarityHint")],
    ["weight", table ? t("LOOTCRATES.Editor.TableOdds") : t("LOOTCRATES.Editor.ByWeight"), table
      ? t("LOOTCRATES.Editor.TableOddsHint")
      : t("LOOTCRATES.Editor.ByWeightHint")],
  ];
  return `<fieldset class="lc-form__mode"><legend>${t("LOOTCRATES.Editor.Odds")}</legend>
        ${options.map(([value, label, hint]) => `<div class="lc-mode">
          <label class="lc-row lc-mode__pick"><input type="radio" name="oddsMode" value="${value}"${mode === value ? " checked" : ""} aria-describedby="lc-mode-${id}-${value}"> ${label}</label>
          <p class="lc-form__hint lc-mode__hint" id="lc-mode-${id}-${value}">${hint}</p>
        </div>`).join("")}
      </fieldset>`;
}

/*
  A crate made from a roll table says it is a copy, and what came in: the
  table is read once, when the crate is made, never again.
*/
export function tableNoteHTML(box, { esc = plain } = {}) {
  const from = box.fromTable;
  if (!from) return "";
  const items = t(from.items === 1 ? "LOOTCRATES.Editor.ItemsOne" : "LOOTCRATES.Editor.ItemsMany", { count: from.items });
  const nested = from.flattened ? t(from.flattened === 1 ? "LOOTCRATES.Editor.FlattenedOne" : "LOOTCRATES.Editor.FlattenedMany", { count: from.flattened }) : "";
  const what = nested ? t("LOOTCRATES.Editor.ItemsAndFlattened", { items, nested }) : items;
  return `<p class="lc-form__hint lc-form__from">${t("LOOTCRATES.Editor.CopiedFrom", { name: `<strong>${esc(from.name)}</strong>`, what: esc(what) })}</p>`;
}

/*
  "Count text results as nothing", for a crate made from a table with text
  results ("You find nothing"): ticked, their share of the table is the
  share of pulls that give no item (rules.missChance); unticked, they are
  left out, as if the table had only its items. Off for a new crate.
*/
export function nothingRow(box, { esc = plain } = {}) {
  const chance = missChanceOf({ rules: { missChance: box.fromTable?.textChance } });
  if (!chance) return "";
  const on = missChanceOf(box) > 0;
  const id = `lc-nothing-${esc(box.id)}`;
  return `<div class="lc-row lc-row--wrap lc-form__nothing">${field(`<input type="checkbox" name="countNothing"${on ? " checked" : ""} aria-describedby="${id}">`, t("LOOTCRATES.Editor.CountNothing"))}
        <p class="lc-form__hint" id="${id}">${t("LOOTCRATES.Editor.CountNothingHint", { chance: esc(chanceLabel(chance)) })}</p></div>`;
}
