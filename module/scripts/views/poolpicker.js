/*
  The pool picker every editor shares (editorfields.js poolsFieldset):
  the game's own pools first, each with its share and what it holds ("2
  uncommon, 1 rare"), then the world's other pools folded under "Add a
  pool (N more)" with a search box, so the pool a GM just made or the
  one a table crate draws from is at the top, not 20 rows down.

  A pool's checkbox is named for the pool alone and its share "Share of
  pulls from <pool>" (docs/ARCHITECTURE.md, every editor field has a
  name); the mix is said after the name (aria-describedby). An unticked
  pool's share is off and out of sight (syncShares): draftBox reads no
  share for it, and FormData leaves a disabled field out. A pool ticked
  in the fold stays where it is while the dialog is open, so nothing
  moves under the pointer; it is first the next time the editor opens.

  With three or fewer other pools there is nothing to fold: they are
  listed under the ticked ones, with no search. The search box has no
  name, so it is no part of what the form saves (or of whether it
  changed); Enter in it moves to the first match instead of pressing the
  dialog's default button, and Escape clears it before it closes anything.

  The crate's picker (`makePool`) offers "Make a pool from a compendium"
  while no pool is ticked, or the world has none: the manager runs Add
  from compendium into a new pool named for the crate and ticks it there
  (manager.js #makePoolHere), so a first crate never leaves its editor.
  The offer goes once a pool is ticked and comes back if every one is
  unticked (wirePoolPicker).

  No Foundry globals: the callers pass `esc`; Vitest and the harness
  render and wire it as the manager does.
*/
import { RARITIES, RARITY_LABEL } from "../core/config.js";
import { flattenPool } from "../core/odds.js";
import { t } from "../core/i18n.js";

const plain = s => String(s ?? "");
// More than this many other pools are folded under "Add a pool" with a search.
export const FOLD_AFTER = 3;

const asMap = pools => (Array.isArray(pools) ? Object.fromEntries(pools.map(p => [p.id, p])) : (pools ?? {}));

// What a pool holds, by rarity ("2 uncommon, 1 rare"), nested pools
// included and an entry that can't drop (missing, weight 0) left out.
export function rarityMix(poolId, pools) {
  const counts = {};
  for (const e of flattenPool(poolId, asMap(pools))) counts[e.rarity] = (counts[e.rarity] ?? 0) + 1;
  const parts = RARITIES.filter(r => counts[r]).map(r => t("LOOTCRATES.Pools.CountRarity", { count: counts[r], rarity: RARITY_LABEL[r].toLowerCase() }));
  return parts.length ? parts.join(t("LOOTCRATES.Common.ListComma")) : t("LOOTCRATES.Picker.Empty");
}

/*
  The pools in the order the picker lists them: the game's own (`refs`,
  in their order) first, then the rest by name. `{ on, rest }`.
*/
export function pickerOrder(pools, refs = []) {
  const list = Array.isArray(pools) ? pools : Object.values(pools ?? {});
  const byId = new Map(list.map(p => [p.id, p]));
  const on = (refs ?? []).map(r => byId.get(r.id)).filter(Boolean);
  const ticked = new Set(on.map(p => p.id));
  const rest = list.filter(p => !ticked.has(p.id)).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { on, rest };
}

function pickRow(p, { on, share, shares, esc, id, all }) {
  const pid = esc(p.id);
  const mixId = `${id}-mix-${pid}`;
  const shareInput = share ? ` <input name="share.${pid}" type="number" min="0" step="1" value="${esc(shares[p.id] ?? 1)}" title="${t("LOOTCRATES.Editor.Share")}" aria-label="${t("LOOTCRATES.Editor.ShareOf", { name: esc(p.name) })}" data-share="${pid}"${on ? "" : " disabled hidden"}>` : "";
  return `<div class="lc-row lc-pool-pick" data-pool-name="${esc(String(p.name ?? "").toLowerCase())}"><label class="lc-field"><input type="checkbox" name="pool.${pid}"${on ? " checked" : ""} aria-describedby="${mixId}"> ${esc(p.name)}</label> <span class="lc-pool-pick__mix" id="${mixId}">${esc(rarityMix(p.id, all))}</span>${shareInput}</div>`;
}

/*
  The picker's body (no fieldset): `pools` (an array or the world's map),
  `refs` the game's pools ([{ id, share }]), `share` whether each pool has
  a share field, `id` a prefix for the ids it makes (the game's id, so two
  open editors don't share one).
*/
export function poolPickerHTML(pools, refs = [], { share = true, esc = plain, id = "lc-picks", makePool = false } = {}) {
  const all = asMap(pools);
  const { on, rest } = pickerOrder(pools, refs);
  const make = makePool ? makePoolHTML(on.length > 0) : "";
  if (!on.length && !rest.length) return `<p>${t("LOOTCRATES.Editor.NoPools")}</p>${make}`;
  const shares = Object.fromEntries((refs ?? []).map(p => [p.id, p.share ?? 1]));
  const opts = { share, shares, esc, id: esc(id), all };
  const ticked = on.map(p => pickRow(p, { ...opts, on: true })).join("");
  const none = `<p class="lc-form__hint lc-pool-picker__none"${on.length ? " hidden" : ""}>${t("LOOTCRATES.Picker.NoneTicked")}</p>`;
  const rows = rest.map(p => pickRow(p, { ...opts, on: false })).join("");
  if (rest.length <= FOLD_AFTER) return `<div class="lc-pool-picker__on">${ticked}${on.length ? "" : none}</div>${rows ? `<div class="lc-pool-picker__rest">${rows}</div>` : ""}${make}`;
  return `<div class="lc-pool-picker__on">${ticked}${none}</div>${make}
        <details class="lc-pool-picker__more">
          <summary class="lc-pool-picker__add" data-picker-add>${t("LOOTCRATES.Picker.AddMore", { count: rest.length })}</summary>
          <div class="lc-pool-picker__body">
            <input type="search" class="lc-pool-picker__search" placeholder="${t("LOOTCRATES.Picker.Find")}" aria-label="${t("LOOTCRATES.Picker.FindLabel")}" autocomplete="off" spellcheck="false">
            <p class="lc-form__hint lc-pool-picker__count" role="status" aria-live="polite"></p>
            <div class="lc-pool-picker__rest">${rows}</div>
          </div>
        </details>`;
}

// The crate's offer while nothing is ticked: one button and what it does.
// The line under it is where the manager says what it made (role=status).
export function makePoolHTML(hidden = false) {
  return `<div class="lc-pool-picker__make"${hidden ? " hidden" : ""}><button type="button" data-make-pool aria-describedby="lc-make-pool-hint"><i class="fas fa-book" inert></i> ${t("LOOTCRATES.Picker.MakePool")}</button> <span class="lc-form__hint" id="lc-make-pool-hint">${t("LOOTCRATES.Picker.MakePoolHint")}</span></div>`;
}

// What the offer says once it made the pool.
export const madeText = (pool, count) => t(count === 1 ? "LOOTCRATES.Picker.MadeOne" : "LOOTCRATES.Picker.MadeMany", { pool, count });

// The search's line: how many pools match, or that none does.
export function matchText(count, query) {
  if (!query) return "";
  if (!count) return t("LOOTCRATES.Picker.NoMatch", { query });
  return t(count === 1 ? "LOOTCRATES.Picker.MatchOne" : "LOOTCRATES.Picker.MatchMany", { count });
}

/*
  The fold's moving parts, on any root holding pickers: the search filters
  the folded pools by name as it is typed; opening the fold puts the
  caret in the search; "Add a pool (N more)" and "No pool ticked yet"
  follow the checkboxes. Safe to call on a root with no picker.
*/
export function wirePoolPicker(root) {
  for (const more of root.querySelectorAll(".lc-pool-picker__more")) {
    const search = more.querySelector(".lc-pool-picker__search");
    const count = more.querySelector(".lc-pool-picker__count");
    const rows = () => [...more.querySelectorAll(".lc-pool-pick")];
    const filter = () => {
      const query = String(search?.value ?? "").trim();
      const q = query.toLowerCase();
      let shown = 0;
      for (const row of rows()) {
        const hit = !q || String(row.dataset.poolName ?? "").includes(q);
        row.hidden = !hit;
        if (hit) shown++;
      }
      if (count) count.textContent = matchText(shown, query);
    };
    search?.addEventListener("input", filter);
    search?.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault();
        rows().find(r => !r.hidden)?.querySelector('input[type="checkbox"]')?.focus();
      } else if (e.key === "Escape" && search.value) {
        e.preventDefault();
        e.stopPropagation();
        search.value = "";
        filter();
      }
    });
    // Opening "Add a pool" puts the caret in its search: on the toggle, and
    // a frame after the click on its line, as a window's own focus
    // handling can take the click's focus back first.
    const toSearch = () => { if (more.open && search && search.ownerDocument?.activeElement !== search) search.focus(); };
    more.addEventListener("toggle", toSearch);
    more.querySelector("summary")?.addEventListener("click", () => (globalThis.requestAnimationFrame ?? setTimeout)(() => toSearch()));
  }
  const follow = () => {
    for (const picker of root.querySelectorAll(".lc-pool-picks")) {
      const boxes = [...picker.querySelectorAll('.lc-pool-pick input[type="checkbox"]')];
      const none = picker.querySelector(".lc-pool-picker__none");
      if (none) none.hidden = boxes.some(b => b.checked);
      const make = picker.querySelector(".lc-pool-picker__make");
      if (make) make.hidden = boxes.some(b => b.checked);
      const add = picker.querySelector("[data-picker-add]");
      const more = picker.querySelector(".lc-pool-picker__more");
      if (add && more) {
        const left = [...more.querySelectorAll('.lc-pool-pick input[type="checkbox"]')].filter(b => !b.checked).length;
        const text = t("LOOTCRATES.Picker.AddMore", { count: left });
        if (add.textContent !== text) add.textContent = text;
      }
    }
  };
  root.addEventListener("change", follow);
  return follow;
}
