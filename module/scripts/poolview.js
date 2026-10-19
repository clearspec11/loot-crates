/*
  The pool editor's rows, as data and as HTML, with no Foundry in them, so
  the manager and the harness draw one format and Vitest can test the search,
  the filter chips and the paging. The caller passes its own escape function
  (foundry.utils.escapeHTML in a world), as boxcard.js does.

  A big pool is a craft table, not a wall of controls: each pool is a
  <details> whose summary keeps the census (count, rarities, problems) in
  view while it is collapsed, and a pool of more than OPEN_UP_TO entries
  starts collapsed. An open pool draws PAGE_ROWS rows at a time of the rows
  that match its name search and filter chip, problems first, with "Show 50
  more". The chips are the census made clickable: each one's count is the
  number of rows it shows.
*/
import { RARITIES, RARITY_LABEL } from "./config.js";
import { normalizeRarity, sourceStatus, effectiveRarity, sourceRarityOf, entryWeight } from "./odds.js";

export const PAGE_ROWS = 50;
export const OPEN_UP_TO = 60;
export const FALLBACK_IMG = "icons/svg/item-bag.svg";

// What the GM last did to a pool's view; kept by the manager per pool.
export const defaultView = pool => ({ open: (pool?.entries?.length ?? 0) <= OPEN_UP_TO, q: "", chip: null, shown: PAGE_ROWS });

/*
  Whether an entry's source has no rarity at all. An entry added before
  sourceRarity was stored learns it from the source check, when that check
  read the rarity and found nothing else changed.
*/
export function sourceBlank(e, src) {
  if (e.sourceRarity != null) return e.sourceRarity === "";
  return !!src && src.rawRarity === "" && sourceStatus(e, src) === "ok";
}
export const hasOverride = e => RARITIES.includes(e?.rarityOverride);
export const isUnset = (e, src) => !e.missing && !hasOverride(e) && sourceBlank(e, src);
export const rarityHintId = poolId => `lc-rarity-hint-${poolId}`;

/*
  Each entry of a pool with what the editor knows of its source (`srcOf(e)`)
  and how the two compare: status "ok", "renamed" (the source's name or
  rarity changed since it was added) or "missing" (the source is gone); the
  name shown, the rarity it is drawn at, and whether it has no rarity set or
  never drops (a missing entry is neither: it can't be drawn at all).
*/
export function poolRows(pool, srcOf) {
  return (pool?.entries ?? []).map(e => {
    const src = srcOf(e);
    const status = sourceStatus(e, src);
    const live = status !== "missing";
    return {
      e, src, status,
      name: status === "renamed" ? src.name : e.name,
      rarity: effectiveRarity(e),
      unset: live && isUnset(e, src),
      never: live && entryWeight(e) === 0,
    };
  });
}

// Problems first: missing, then renamed, then no rarity set; otherwise the
// pool's own order. Stable.
const rank = r => r.status === "missing" ? 0 : r.status === "renamed" ? 1 : r.unset ? 2 : 3;
export function sortRows(rows) {
  return rows.map((r, i) => [r, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([r]) => r);
}

// The chips, in census order. A rarity chip is what the box can draw at that
// rarity (live, weight above 0), as the census counts it.
export const PROBLEM_CHIPS = ["unset", "never", "missing", "renamed"];
export function matchesChip(row, chip) {
  if (!chip) return true;
  if (chip === "missing") return row.status === "missing";
  if (chip === "renamed") return row.status === "renamed";
  if (chip === "unset") return row.unset;
  if (chip === "never") return row.never;
  if (RARITIES.includes(chip)) return row.status !== "missing" && !row.never && row.rarity === chip;
  return false;
}

// Rows whose name (shown or stored) contains `q`, ignoring case, and that
// the chip lets through.
export function filterRows(rows, { q = "", chip = null } = {}) {
  const needle = String(q ?? "").trim().toLocaleLowerCase();
  return rows.filter(r => matchesChip(r, chip)
    && (!needle || String(r.name ?? "").toLocaleLowerCase().includes(needle) || String(r.e?.name ?? "").toLocaleLowerCase().includes(needle)));
}

// The first `shown` rows (at least one page), how many are left and how many
// the next "Show more" adds.
export function pageRows(rows, shown = PAGE_ROWS) {
  const n = Math.max(PAGE_ROWS, Math.floor(Number(shown)) || 0);
  const page = rows.slice(0, n);
  const left = rows.length - page.length;
  return { rows: page, left, next: Math.min(PAGE_ROWS, left) };
}

// The next page after the rows already drawn, by uuid, so an edit that
// re-sorted the pool since never skips or repeats a row.
export function nextRows(rows, drawn, n = PAGE_ROWS) {
  const have = new Set(drawn);
  const rest = rows.filter(r => !have.has(r.e.uuid));
  const page = rest.slice(0, n);
  const left = rest.length - page.length;
  return { rows: page, left, next: Math.min(PAGE_ROWS, left) };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const CHIP_TEXT = {
  unset: n => `${n} no rarity set`,
  never: n => plural(n, "never drops", "never drop"),
  missing: n => `${n} missing`,
  renamed: n => `${n} renamed`,
};

// Every chip with a count, plus the active one even at 0 so it can be
// turned off. Counts come from matchesChip, so a chip shows what it says.
export function chipList(rows, active = null) {
  const out = [];
  for (const chip of [...RARITIES, ...PROBLEM_CHIPS]) {
    const n = rows.filter(r => matchesChip(r, chip)).length;
    if (!n && chip !== active) continue;
    const rarity = RARITIES.includes(chip);
    out.push({ chip, n, rarity, label: rarity ? `${n} ${RARITY_LABEL[chip].toLowerCase()}` : CHIP_TEXT[chip](n) });
  }
  return out;
}

// "12 items · 8 common, 3 rare · 1 never drops · 2 missing, 1 renamed, 4 no rarity set".
// The rarity counts are what the box can draw, at each entry's own rarity.
export function poolCount(pool, rows) {
  const n = (pool?.entries ?? []).length;
  const counts = RARITIES.map(r => [r, rows.filter(x => matchesChip(x, r)).length]).filter(([, c]) => c);
  const never = rows.filter(r => r.never).length;
  const missing = rows.filter(r => r.status === "missing").length;
  const renamed = rows.filter(r => r.status === "renamed").length;
  const unset = rows.filter(r => r.unset).length;
  const problems = [missing && `${missing} missing`, renamed && `${renamed} renamed`, unset && `${unset} no rarity set`].filter(Boolean).join(", ");
  return `${plural(n, "item", "items")}${counts.length ? " · " + counts.map(([r, c]) => `${c} ${RARITY_LABEL[r].toLowerCase()}`).join(", ") : ""}${never ? ` · ${CHIP_TEXT.never(never)}` : ""}${problems ? ` · <span class="lc-pool__problems">${problems}</span>` : ""}`;
}

// The always-visible part of a pool: its name and census.
export function poolSummary(pool, rows, esc) {
  return `<summary class="lc-pool__summary"><span class="lc-pool__name">${esc(pool.name)}</span><span class="lc-pool__count">${poolCount(pool, rows)}</span></summary>`;
}

export function chipsHTML(pool, rows, view, esc) {
  return chipList(rows, view.chip).map(c => `<button type="button" class="lc-odd lc-chip ${c.rarity ? `lc-rarity-${c.chip}` : "lc-chip--problem"}" data-action="filterChip" data-pool="${esc(pool.id)}" data-chip="${c.chip}" aria-pressed="${c.chip === view.chip}">${esc(c.label)}</button>`).join("");
}

// "Set rarity for N unset", over the rows the search and chip let through.
export function unsetButton(pool, matched, view, esc) {
  const n = matched.filter(r => r.unset).length;
  if (!n) return "";
  const narrowed = !!(view.q?.trim() || view.chip);
  const title = narrowed ? "Pick one rarity for every item matching the search and filter whose source has none" : "Pick one rarity for every item here whose source has none";
  return `<button type="button" data-action="setUnsetRarity" data-pool="${esc(pool.id)}" title="${title}">Set rarity for ${n} unset${narrowed ? " matching" : ""}</button>`;
}

// "Showing 50 of 273" and "Show 50 more (223 left)", or why nothing shows.
export function footHTML(pool, all, matched, page, esc) {
  if (!all.length) return "";
  if (!matched.length) return `<span class="lc-pool__shown">Nothing in this pool matches the search and filter.</span>`;
  const text = page.left > 0 ? `Showing ${matched.length - page.left} of ${matched.length}` : matched.length < all.length ? `${matched.length} of ${all.length} match` : "";
  const more = page.left > 0 ? `<button type="button" class="lc-pool__more" data-action="showMore" data-pool="${esc(pool.id)}">Show ${page.next} more (${page.left} left)</button>` : "";
  return `${text ? `<span class="lc-pool__shown">${text}</span>` : ""}${more}`;
}

// An open pool's working area: search, actions, chips, rows, paging.
export function poolBody(pool, rows, view, esc) {
  const matched = filterRows(rows, view);
  const page = pageRows(matched, view.shown);
  const id = esc(pool.id);
  const missing = rows.some(r => r.status === "missing");
  const has = rows.length > 0;
  return `
    <div class="lc-pool__bar">
      ${has ? `<input type="search" class="lc-pool__search" data-pool="${id}" value="${esc(view.q ?? "")}" placeholder="Search by name" aria-label="Search ${esc(pool.name)} by name" autocomplete="off" spellcheck="false">` : ""}
      <span class="lc-pool__unset">${unsetButton(pool, matched, view, esc)}</span>
      <span class="lc-tabs__spacer"></span>
      <button type="button" data-action="bulkAdd" data-pool="${id}" title="Add every item in a compendium that matches a filter"><i class="fas fa-book"></i> Add from compendium</button>
      <button type="button" data-action="editPool" data-pool="${id}" aria-label="Rename ${esc(pool.name)}"><i class="fas fa-pen"></i></button>
      <button type="button" data-action="deletePool" data-pool="${id}" aria-label="Delete ${esc(pool.name)}"><i class="fas fa-trash"></i></button>
    </div>
    ${has ? `<div class="lc-pool__chips" role="group" aria-label="Filter ${esc(pool.name)}">${chipsHTML(pool, rows, view, esc)}</div>` : ""}
    <p class="lc-pool__hint">Drop items, an Items folder, a compendium or a roll table here.${missing ? " Drop an item on a missing row to relink it." : ""}</p>
    ${has ? `<p class="lc-pool__hint" id="${esc(rarityHintId(pool.id))}">The granted item carries the rarity picked on its row.</p>` : ""}
    <ul class="lc-entries">${page.rows.map(r => entryRow(pool.id, r, esc)).join("")}</ul>
    <div class="lc-pool__foot">${footHTML(pool, rows, matched, page, esc)}</div>`;
}

// The rarity select and weight input on a live row.
export function curateControls(poolId, e, src, status, name, esc) {
  const ids = `data-pool="${esc(poolId)}" data-uuid="${esc(e.uuid)}"`;
  const blank = sourceBlank(e, src);
  const fromSource = sourceRarityOf(e);
  const current = hasOverride(e) ? e.rarityOverride : "";
  // Teach an older entry its source's raw rarity as it is edited.
  const learn = e.sourceRarity == null && status === "ok" && src?.rawRarity != null ? ` data-source-rarity="${esc(src.rawRarity)}"` : "";
  const options = [
    `<option value="" ${current === "" ? "selected" : ""}>${blank ? "Not set (Common)" : `${RARITY_LABEL[fromSource]} (source)`}</option>`,
    ...RARITIES.filter(r => blank || r !== fromSource).map(r => `<option value="${r}" ${current === r ? "selected" : ""}>${RARITY_LABEL[r]}</option>`),
  ].join("");
  return `<select class="lc-entry__rarity" data-curate="rarity" ${ids}${learn} aria-label="Rarity of ${esc(name)}" aria-describedby="${esc(rarityHintId(poolId))}" title="The granted item carries this rarity.">${options}</select>
    <input class="lc-entry__weight" type="number" min="0" step="1" inputmode="numeric" value="${entryWeight(e)}" data-curate="weight" ${ids}${learn} aria-label="Weight of ${esc(name)}, 0 never drops" title="Weight against items of the same rarity; 0 never drops">`;
}

// A live row's class and its name-and-status block, rebuilt after an edit.
export function entryParts(row, esc) {
  const { e, src, status } = row;
  const rarity = effectiveRarity(e);
  const name = status === "renamed" ? src.name : e.name;
  const never = entryWeight(e) === 0;
  const unset = isUnset(e, src);
  const notes = [];
  if (status === "renamed") {
    if (src.name !== e.name) notes.push(`was ${e.name}`);
    if (src.rarity != null && normalizeRarity(src.rarity) !== sourceRarityOf(e)) notes.push(`now ${RARITY_LABEL[normalizeRarity(src.rarity)]} at the source`);
  }
  if (unset) notes.push("No rarity set");
  if (never) notes.push("Never drops");
  return {
    name,
    className: ["lc-entry", `lc-rarity-${rarity}`, status === "renamed" && "lc-entry--renamed", never && "lc-entry--never", unset && "lc-entry--unset"].filter(Boolean).join(" "),
    text: `<span class="lc-entry__text"><span class="lc-entry__name" title="${esc(name)}">${esc(name)}</span>${notes.length ? `<small class="lc-entry__status">${esc(notes.join(" · "))}</small>` : ""}</span>`,
  };
}

// One pool entry. A missing one can only be relinked or removed; a live one
// shows the rarity it is drawn at and its weight, both editable.
export function entryRow(poolId, row, esc) {
  const { e, src, status } = row;
  const ids = `data-pool="${esc(poolId)}" data-uuid="${esc(e.uuid)}"`;
  if (status === "missing") {
    const remove = `<button type="button" class="lc-entry__remove" data-action="removeEntry" ${ids} aria-label="Remove ${esc(e.name)}" data-tooltip="Remove"><i class="fa-solid fa-xmark" inert></i></button>`;
    return `<li class="lc-entry lc-entry--missing lc-rarity-${effectiveRarity(e)}" data-entry="${esc(e.uuid)}" data-pool="${esc(poolId)}" data-relink="${esc(e.uuid)}" title="Drop an item here to relink it">
      <img src="${esc(e.img || FALLBACK_IMG)}" alt="">
      <span class="lc-entry__text"><span class="lc-entry__name">${esc(e.name)}</span><small class="lc-entry__status">Source missing, not drawn. Drop an item here to relink.</small></span>
      <button type="button" class="lc-entry__update" data-action="relinkEntry" ${ids} aria-label="Relink ${esc(e.name)}">Relink</button>
      ${remove}</li>`;
  }
  const parts = entryParts(row, esc);
  const remove = `<button type="button" class="lc-entry__remove" data-action="removeEntry" ${ids} aria-label="Remove ${esc(parts.name)}" data-tooltip="Remove"><i class="fa-solid fa-xmark" inert></i></button>`;
  const update = status === "renamed" ? `<button type="button" class="lc-entry__update" data-action="updateEntry" ${ids} aria-label="Update ${esc(e.name)} to ${esc(parts.name)}">Update</button>` : "";
  return `<li class="${parts.className}" data-entry="${esc(e.uuid)}">
    <img src="${esc((status === "renamed" && src.img) || e.img || FALLBACK_IMG)}" alt="">
    ${parts.text}
    ${curateControls(poolId, e, src, status, parts.name, esc)}
    ${update}${remove}</li>`;
}
