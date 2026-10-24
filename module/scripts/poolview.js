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

  What the GM just dropped on a pool is pinned above everything else, marked
  "Just added", until the next drop or until the manager closes (view.recent,
  view state only; the stored order doesn't change), so a drop on a big,
  collapsed or filtered pool lands where the eye is.

  Each pool's header names the boxes that draw from it, directly or through
  a pool nested in theirs, and deleting a pool, or removing the last item a
  box could drop, names the boxes it would leave with nothing inside before
  it happens (poolUsers, emptiedBy and the text below).
*/
import { RARITIES, RARITY_LABEL } from "./config.js";
import { normalizeRarity, sourceStatus, effectiveRarity, sourceRarityOf, entryWeight, shopOdds } from "./odds.js";

export const PAGE_ROWS = 50;
export const OPEN_UP_TO = 60;
export const FALLBACK_IMG = "icons/svg/item-bag.svg";

// What the GM last did to a pool's view; kept by the manager per pool.
// `recent` lists the uuids just dropped on the pool, newest first.
export const defaultView = pool => ({ open: (pool?.entries?.length ?? 0) <= OPEN_UP_TO, q: "", chip: null, shown: PAGE_ROWS, recent: [] });

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

// What was just dropped (`recent`, newest first) above everything, marked
// `recent`; then problems: missing, renamed, no rarity set; otherwise the
// pool's own order. Stable.
const rank = r => r.status === "missing" ? 0 : r.status === "renamed" ? 1 : r.unset ? 2 : 3;
export function sortRows(rows, recent = []) {
  const pin = new Map((recent ?? []).map((u, i) => [u, i]));
  const key = r => pin.has(r.e.uuid) ? pin.get(r.e.uuid) - pin.size : rank(r);
  return rows.map((r, i) => [r, i]).sort((a, b) => key(a[0]) - key(b[0]) || a[1] - b[1])
    .map(([r]) => pin.has(r.e.uuid) ? { ...r, recent: true } : r);
}

const CHIP_NAME = { unset: "No rarity set", never: "Never drops", missing: "Missing", renamed: "Renamed" };

/*
  Pin the uuids just added to (or already in) a pool: the view that shows
  them at the top of its first page, opened, with the chip and the search
  cleared only if they would hide one of them; `cleared` names what went.
  At most a page is pinned.
*/
export function pinRecent(view, rows, uuids) {
  const recent = [...new Set(uuids)].slice(0, PAGE_ROWS);
  const pinned = rows.filter(r => recent.includes(r.e.uuid));
  const next = { ...view, recent, open: true, shown: PAGE_ROWS };
  const cleared = [];
  if (next.chip && pinned.some(r => !matchesChip(r, next.chip))) {
    cleared.push(`the ${RARITY_LABEL[next.chip] ?? CHIP_NAME[next.chip] ?? next.chip} filter`);
    next.chip = null;
  }
  if (String(next.q ?? "").trim() && pinned.some(r => !filterRows([r], { q: next.q }).length)) {
    cleared.push("the search");
    next.q = "";
  }
  return { view: next, cleared };
}

/*
  What the status line says after a drop: where it went, at
  what rarity, and what was cleared to show it.
    "Flame Tongue added to Core magic items, Rare, at the top."
    "Added 40 items from SRD Items to Core magic items; they are at the top."
*/
export function dropNotice({ pool, rows = [], label = "", added = rows.length, duplicate = false, cleared = [] }) {
  const where = pool?.name ?? "the pool";
  let text;
  if (duplicate && rows[0]) text = `${rows[0].name} is already in ${where}; it is at the top.`;
  else if (added === 1 && rows[0]) {
    const r = rows[0];
    text = `${r.name} added to ${where}, ${r.unset ? "no rarity set (draws as Common)" : RARITY_LABEL[r.rarity]}, at the top.`;
  } else {
    const top = added > rows.length ? `the first ${rows.length} are at the top` : "they are at the top";
    text = `Added ${plural(added, "item", "items")}${label ? ` from ${label}` : ""} to ${where}; ${top}.`;
  }
  if (cleared.length) text += ` Cleared ${cleared.join(" and ")} so ${rows.length === 1 ? "it shows" : "they show"}.`;
  return text;
}

/*
  What the tab's status line says once a field saved in place: a Boxes
  row's price ("Saved: Goblin Crate, 12 gp 5 sp.") or a pool row's weight
  or rarity ("Saved: Flame Tongue, weight 3."). One sentence shape for every
  in-place save, so a screen reader hears that it happened and what stands.
*/
export const savedNotice = (name, value) => `Saved: ${name || "the row"}, ${value}.`;

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

// The always-visible part of a pool: its name and census, and when `users`
// (box names) is given, the boxes that draw from it.
export function poolSummary(pool, rows, esc, users = null) {
  return `<summary class="lc-pool__summary"><span class="lc-pool__name">${esc(pool.name)}</span><span class="lc-pool__count">${poolCount(pool, rows)}</span>${users ? usersLine(users, esc) : ""}</summary>`;
}

const listOf = boxes => Array.isArray(boxes) ? boxes : Object.values(boxes ?? {});

// Whether pool `from` is `target` or nests it at any depth. `seen` is
// flattenPool's cycle guard: a pool already walked is not walked again.
function reaches(from, target, pools, seen) {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return (pools[from]?.pools ?? []).some(child => reaches(child, target, pools, seen));
}

// The boxes (in their stored order) that draw from `poolId`, directly or
// through nested pools.
export function poolUsers(poolId, pools, boxes) {
  return listOf(boxes).filter(b => {
    const seen = new Set();
    return (b.pools ?? []).some(ref => reaches(ref.id, poolId, pools, seen));
  });
}

// The boxes that can drop something with `before` and nothing with `after`
// (a missing entry or one at weight 0 drops nothing, as in the shop).
export function emptiedBy(boxes, before, after) {
  return listOf(boxes).filter(b => shopOdds(b, before).rows.length > 0 && shopOdds(b, after).rows.length === 0);
}

// The pools as store.js deletePool leaves them: without `id`, and without
// it in any other pool's nested list.
export function withoutPool(pools, id) {
  const out = {};
  for (const [k, p] of Object.entries(pools)) if (k !== id) out[k] = { ...p, pools: (p.pools ?? []).filter(c => c !== id) };
  return out;
}

// The pools as store.js removeEntry leaves them.
export function withoutEntry(pools, poolId, uuid) {
  const pool = pools[poolId];
  if (!pool) return pools;
  return { ...pools, [poolId]: { ...pool, entries: (pool.entries ?? []).filter(e => e.uuid !== uuid) } };
}

/*
  What deleting a pool does to the boxes: `users` draw from it, `emptied`
  would drop nothing after, `kept` still drop something from their other
  pools. A box that was already empty is only a user.
*/
export function deleteImpact(poolId, pools, boxes) {
  const users = poolUsers(poolId, pools, boxes);
  const after = withoutPool(pools, poolId);
  const emptied = emptiedBy(users, pools, after);
  const kept = users.filter(b => !emptied.includes(b) && shopOdds(b, after).rows.length > 0);
  return { users, emptied, kept };
}

// The boxes removing one entry from a pool would leave with nothing inside.
export function removeImpact(poolId, uuid, pools, boxes) {
  return emptiedBy(poolUsers(poolId, pools, boxes), pools, withoutEntry(pools, poolId, uuid));
}

// "A", "A and B", "A, B and C".
export function nameList(names) {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
const strongList = (boxes, esc) => nameList(boxes.map(b => `<strong>${esc(b.name)}</strong>`));
export const USERS_SHOWN = 3;

// The header's quiet line: "In Adventurer's Crate, Royal Crate", "In A, B, C
// and 2 more", or "Not in any box".
export function usersText(names) {
  return !names.length ? "Not in any box"
    : `In ${names.slice(0, USERS_SHOWN).join(", ")}${names.length > USERS_SHOWN ? ` and ${names.length - USERS_SHOWN} more` : ""}`;
}
export function usersLine(names, esc) {
  return `<span class="lc-pool__users">${esc(usersText(names))}</span>`;
}

const emptiedText = (emptied, esc) => `${strongList(emptied, esc)} will have nothing inside and can't be bought until ${emptied.length === 1 ? "it has" : "they have"} an item that can drop.`;

// The Delete pool confirm: the boxes that use it by name, and in a sentence
// of its own the ones it would leave with nothing inside.
export function deletePoolText(pool, { users = [], emptied = [], kept = [] }, esc) {
  const out = [`<p>Delete <strong>${esc(pool.name)}</strong>? ${users.length ? `It is in ${strongList(users, esc)}.` : "No box draws from it."}</p>`];
  if (kept.length) out.push(`<p>${strongList(kept, esc)} can still drop items from ${kept.length === 1 ? "its" : "their"} other pools.</p>`);
  if (emptied.length) out.push(`<p>${emptiedText(emptied, esc)}</p>`);
  return out.join("");
}

// The Remove confirm, asked only when the removal empties a box.
export function removeEntryText(name, pool, emptied, esc) {
  return `<p>Remove <strong>${esc(name)}</strong> from <strong>${esc(pool.name)}</strong>? It is the last item ${nameList(emptied.map(b => esc(b.name)))} can drop.</p><p>${emptiedText(emptied, esc)}</p>`;
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
      <button type="button" data-action="crateFromPool" data-pool="${id}" aria-label="New crate from ${esc(pool.name)}" title="A crate that draws from this pool alone; price it and add it to the shelf"><i class="fas fa-box-open"></i> New crate from this pool</button>
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
  const just = row.recent ? `<span class="lc-entry__new">Just added</span>${notes.length ? " · " : ""}` : "";
  return {
    name,
    className: ["lc-entry", `lc-rarity-${rarity}`, row.recent && "lc-entry--recent", status === "renamed" && "lc-entry--renamed", never && "lc-entry--never", unset && "lc-entry--unset"].filter(Boolean).join(" "),
    text: `<span class="lc-entry__text"><span class="lc-entry__name" title="${esc(name)}">${esc(name)}</span>${just || notes.length ? `<small class="lc-entry__status">${just}${esc(notes.join(" · "))}</small>` : ""}</span>`,
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

/* ---------- The preview before a drop goes in ---------- */

export const SKIPPED_NAMES = { spell: ["spell", "spells"], feat: ["feature", "features"], class: ["class", "classes"], subclass: ["subclass", "subclasses"], background: ["background", "backgrounds"], race: ["species", "species"], facility: ["facility", "facilities"] };

/*
  What a drop left out, and what it did on the way, one line each: "14
  already in this pool, skipped", "3 spells, 2 features skipped, not loot",
  and for a roll table (store.js entriesFromDrop) "2 nested tables
  flattened into their items", "1 text result skipped" (or counted as
  nothing, `textAsNothing`), "1 table result that isn't an item, skipped",
  "1 nested table skipped: more than 5 deep, or rolling a table above it",
  "1 empty nested table skipped: no results to bring in".
*/
export function describeSkipped({ duplicates = 0, notLoot = {}, notItems = 0, text = 0, tooDeep = 0, emptyTables = 0 } = {}, { flattened = 0, textAsNothing = false, depth = 5 } = {}) {
  const lines = [];
  if (flattened) lines.push(`${plural(flattened, "nested table", "nested tables")} flattened into ${flattened === 1 ? "its" : "their"} items`);
  if (duplicates) lines.push(`${duplicates} already in this pool, skipped`);
  const kinds = Object.entries(notLoot).map(([type, n]) => `${n} ${(SKIPPED_NAMES[type] ?? [type, `${type}s`])[n === 1 ? 0 : 1]}`);
  if (kinds.length) lines.push(`${kinds.join(", ")} skipped, not loot`);
  if (text) lines.push(`${plural(text, "text result", "text results")} ${textAsNothing ? "counted as nothing" : "skipped"}`);
  if (notItems) lines.push(`${notItems} table result${notItems === 1 ? "" : "s"} that ${notItems === 1 ? "isn't an item" : "aren't items"}, skipped`);
  if (tooDeep) lines.push(`${plural(tooDeep, "nested table", "nested tables")} skipped: more than ${depth} deep, or rolling a table above ${tooDeep === 1 ? "it" : "them"}`);
  if (emptyTables) lines.push(`${plural(emptyTables, "empty nested table", "empty nested tables")} skipped: no results to bring in`);
  return lines;
}

export const PREVIEW_ROWS = 50;

/*
  The preview before a folder, compendium, roll table or filter goes into a
  pool (`plan` from store.js entriesFromDrop): how many items from where,
  by rarity, what was flattened or left out, and the first PREVIEW_ROWS
  names with their weights. Shared by the manager's dialog and the harness.
*/
export function dropPreviewHTML(plan, poolName, esc = s => String(s ?? "")) {
  const n = plan.entries.length;
  const counts = {};
  for (const e of plan.entries) counts[normalizeRarity(e.rarity)] = (counts[normalizeRarity(e.rarity)] ?? 0) + 1;
  const skipped = describeSkipped(plan.skipped, { flattened: plan.flattened ?? 0 });
  const shown = plan.entries.slice(0, PREVIEW_ROWS);
  const items = plural(n, "item", "items");
  return `<div class="lc-preview">
        <p class="lc-preview__lead">Add <strong>${items}</strong> from <strong>${esc(plan.label)}</strong> to <strong>${esc(poolName)}</strong>.</p>
        <p class="lc-preview__rarities" aria-label="By rarity">${RARITIES.filter(r => counts[r]).map(r => `<span class="lc-odd lc-rarity-${r}">${counts[r]} ${RARITY_LABEL[r].toLowerCase()}</span>`).join("")}</p>
        ${skipped.length ? `<ul class="lc-preview__skipped">${skipped.map(line => `<li>${esc(line)}</li>`).join("")}</ul>` : ""}
        <ul class="lc-preview__list">${shown.map(e => `<li class="lc-entry lc-rarity-${normalizeRarity(e.rarity)}"><img src="${esc(e.img || FALLBACK_IMG)}" alt=""><span class="lc-entry__name">${esc(e.name)}</span>${e.weight > 1 ? `<small class="lc-preview__weight">weight ${esc(e.weight)}</small>` : ""}<em>${RARITY_LABEL[normalizeRarity(e.rarity)]}</em></li>`).join("")}</ul>
        ${n > shown.length ? `<p class="lc-preview__more">and ${n - shown.length} more</p>` : ""}
      </div>`;
}
