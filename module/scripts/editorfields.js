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
import { RARITIES, RARITY_LABEL } from "./config.js";
import { oddsModeOf, missChanceOf, chanceLabel } from "./odds.js";

const plain = s => String(s ?? "");

// One control in a label of its own: the words before it are its name.
// The rows that hold one (lc-row--wrap) wrap onto a second line rather
// than run past a narrow dialog's edge.
export const field = (labelText, control) => `<label class="lc-field">${labelText} ${control}</label>`;

/*
  The pools a game draws from, one row each: the checkbox and the pool's
  name in a label of their own, then (with `share`) the pool's share of
  pulls, named for its pool and off while the pool is unticked (draftBox
  reads no share for an unticked pool, so there is nothing to type).
  `refs` is the game's pools ([{ id, share }]).
*/
export function poolPicks(pools, refs = [], { share = true, esc = plain } = {}) {
  const shares = Object.fromEntries((refs ?? []).map(p => [p.id, p.share ?? 1]));
  if (!pools.length) return "<p>No pools yet.</p>";
  return pools.map(p => {
    const on = p.id in shares;
    const id = esc(p.id);
    const shareInput = share ? ` <input name="share.${id}" type="number" min="0" step="1" value="${esc(shares[p.id] ?? 1)}" title="Share" aria-label="Share of pulls from ${esc(p.name)}" data-share="${id}"${on ? "" : " disabled"}>` : "";
    return `<div class="lc-row lc-pool-pick">${field(`<input type="checkbox" name="pool.${id}"${on ? " checked" : ""}>`, esc(p.name))}${shareInput}</div>`;
  }).join("");
}

export const poolsFieldset = (legend, pools, refs, opts = {}) => `<fieldset class="lc-pool-picks"><legend>${legend}</legend>
        ${poolPicks(pools, refs, opts)}
      </fieldset>`;

// Each share follows its pool's checkbox (on while ticked); the editors
// call it on every input and change (manager.js liveOdds).
export function syncShares(root) {
  for (const share of root.querySelectorAll("input[data-share]")) {
    const box = share.closest(".lc-pool-pick")?.querySelector('input[type="checkbox"]');
    if (box) share.disabled = !box.checked;
  }
}

// What the pity count is called, by what a play is called.
const PITY_COUNT = { pulls: "Pulls before the guarantee", throws: "Throws before the guarantee" };

// "Pity: guarantee [rarity] after [n] pulls": the rarity named by its
// label, the count by what it counts.
export function pityRow(pity, { noun = "pulls", esc = plain } = {}) {
  const select = `<select name="pityRarity"><option value="">off</option>${RARITIES.map(r => `<option value="${r}"${pity?.minRarity === r ? " selected" : ""}>${RARITY_LABEL[r]} or better</option>`).join("")}</select>`;
  return `<div class="lc-row lc-row--wrap">${field("Pity: guarantee", select)} after <input name="pityAfter" type="number" min="1" step="1" value="${esc(pity?.after ?? 10)}" aria-label="${PITY_COUNT[noun] ?? PITY_COUNT.pulls}"> ${noun}</div>`;
}

// The well's and the dice game's stake: an amount, then its coin.
export function stakeRow(stake, esc = plain) {
  return `<div class="lc-row lc-row--wrap lc-form__stake">${field("Stake", `<input name="stake" type="number" min="0" step="1" value="${esc(stake.amount)}">`)} <select name="coin" aria-label="Coin">${["cp", "sp", "gp"].map(c => `<option value="${c}"${c === stake.coin ? " selected" : ""}>${c}</option>`).join("")}</select></div>`;
}

// The wheel's "From [least] to [most] gp a bet", each bound named for itself.
export function betRangeRow(least, most, esc = plain) {
  return `<div class="lc-row lc-row--wrap">From <input name="price" type="number" min="0" step="1" value="${esc(least)}" aria-label="Smallest bet in gp"> to <input name="maxStake" type="number" min="0" step="1" value="${esc(most ?? "")}" placeholder="any" aria-label="Largest bet in gp, blank for any"> gp a bet</div>`;
}

// The dice game's "Roll [2d6] over the dragon's [n]".
export function dragonRow(formulas, dice, esc = plain) {
  const select = `<select name="formula">${formulas.map(f => `<option value="${esc(f)}"${f === dice.formula ? " selected" : ""}>${esc(f)}</option>`).join("")}</select>`;
  return `<div class="lc-row lc-row--wrap">${field("Roll", select)} over the dragon's <input name="target" type="number" min="0" step="1" value="${esc(dice.target)}" aria-label="The dragon's number"></div>`;
}

/*
  The deck editor's card rows name each field by the card's place in the
  deck ("Weight of card 2"), so a deck of many cards doesn't read "Weight"
  a dozen times; `renumberCards` keeps the numbers right after a remove.
*/
export const CARD_FIELDS = {
  label: n => `Name of card ${n}`,
  kind: n => `What card ${n} does`,
  gp: n => `Gold pieces for card ${n}`,
  weight: n => `Weight of card ${n}`,
  once: n => `Card ${n} once per deck`,
  text: n => `Effect text of card ${n}`,
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
    ["rarity", "By rarity", "A pull picks a rarity by the weights below, then an item of that rarity."],
    ["weight", table ? "Use the table's odds" : "By item weight", table
      ? "Each item's chance is its weight against the rest of the table, so 1 in 100 stays 1 in 100. Rarity weights are not used."
      : "Each item's chance is its weight against the rest of its pool, as on a roll table. Rarity weights are not used."],
  ];
  return `<fieldset class="lc-form__mode"><legend>Odds</legend>
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
  const t = box.fromTable;
  if (!t) return "";
  const what = [`${t.items} item${t.items === 1 ? "" : "s"}`, t.flattened ? `${t.flattened} nested table${t.flattened === 1 ? "" : "s"} flattened` : ""].filter(Boolean).join(", ");
  return `<p class="lc-form__hint lc-form__from">Copied from <strong>${esc(t.name)}</strong> (${esc(what)}); edit the table and make the crate again to pick up changes.</p>`;
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
  return `<div class="lc-row lc-row--wrap lc-form__nothing">${field(`<input type="checkbox" name="countNothing"${on ? " checked" : ""} aria-describedby="${id}">`, "Count text results as nothing")}
        <p class="lc-form__hint" id="${id}">The table's text results are ${esc(chanceLabel(chance))} of it. Ticked, that share of pulls gives no item; unticked, they are left out.</p></div>`;
}
