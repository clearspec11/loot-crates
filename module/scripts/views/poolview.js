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
import { RARITIES, RARITY_LABEL } from "../core/config.js";
import { normalizeRarity, sourceStatus, effectiveRarity, sourceRarityOf, entryWeight, shopOdds } from "../core/odds.js";
import { t, words, listAnd } from "../core/i18n.js";

export const PAGE_ROWS = 50;
export const OPEN_UP_TO = 60;
export const FALLBACK_IMG = "icons/svg/item-bag.svg";

// What the GM last did to a pool's view; kept by the manager per pool.
// `recent` lists the uuids just dropped on the pool, newest first. `open`
// says whether it starts open (the manager's Pools tab: poolToOpen); left
// out, a pool of up to OPEN_UP_TO entries does.
export const defaultView = (pool, open) => ({ open: open ?? (pool?.entries?.length ?? 0) <= OPEN_UP_TO, q: "", chip: null, shown: PAGE_ROWS, recent: [] });

/*
  The one pool the Pools tab opens with: the one the GM last worked on in
  this session (`last`, while it exists), else the newest (pools are kept
  in the order they were made), which is also the only one in a world with
  one. Every other pool starts collapsed to its summary line, so a 6-item
  pool isn't under three 800-item ones (the tab was 8,472 px tall with
  every pool open).
*/
export function poolToOpen(pools, last = null) {
  const list = Array.isArray(pools) ? pools : Object.values(pools ?? {});
  if (last && list.some(p => p.id === last)) return last;
  return list.at(-1)?.id ?? null;
}

/*
  New pool's dialog: the name, focused and selected (manager.js
  promptForm's `select`), "New pool" until the GM types over it. And the
  pencil's Rename pool, the same field with the pool's name.
*/
export function poolNameHTML(name, esc) {
  return `<label>${t("LOOTCRATES.Manager.Name")} <input name="name" value="${esc(name)}" autocomplete="off" spellcheck="false" autofocus></label>`;
}

/*
  Add from compendium's filters: the compendium (dnd5e's own item pack
  picked when the world has it, the pack a first crate is most likely
  built from), then Types and Rarities as rows of ticked chips, every
  choice and its state in sight (they were 32 px multi-selects whose
  pre-picked options sat out of view, with nothing saying Ctrl-click),
  then Name contains. `packs` [{ id, label }], `types` [{ key, label }].
  The dialog's first button reads Preview: nothing is added until the
  preview's Add.
*/
export const BULK_TYPES = ["weapon", "equipment", "consumable", "tool"];
export const BULK_PACK = "dnd5e.items";
const chip = (name, value, label, on, esc) => `<label class="lc-chipbox"><input type="checkbox" name="${name}" value="${esc(value)}" data-multi${on ? " checked" : ""}> <span>${esc(label)}</span></label>`;
export function bulkAddHTML({ packs = [], types = [], picked = BULK_TYPES, esc }) {
  const pack = packs.some(p => p.id === BULK_PACK) ? BULK_PACK : packs[0]?.id;
  return `
      <label>${t("LOOTCRATES.Manager.Compendium")} <select name="pack">${packs.map(p => `<option value="${esc(p.id)}"${p.id === pack ? " selected" : ""}>${esc(p.label)} (${esc(p.id)})</option>`).join("")}</select></label>
      <fieldset class="lc-chipset" aria-describedby="lc-bulk-types-hint"><legend>${t("LOOTCRATES.Manager.Types")}</legend>
        <div class="lc-chipset__chips">${types.map(k => chip("types", k.key, k.label, picked.includes(k.key), esc)).join("")}</div>
        <p class="lc-form__hint" id="lc-bulk-types-hint">${t("LOOTCRATES.Manager.TypesHint")}</p>
      </fieldset>
      <fieldset class="lc-chipset" aria-describedby="lc-bulk-rarities-hint"><legend>${t("LOOTCRATES.Manager.Rarities")}</legend>
        <div class="lc-chipset__chips">${RARITIES.map(r => chip("rarities", r, RARITY_LABEL[r], r !== "common", esc)).join("")}</div>
        <p class="lc-form__hint" id="lc-bulk-rarities-hint">${t("LOOTCRATES.Manager.RaritiesHint")}</p>
      </fieldset>
      <label>${t("LOOTCRATES.Manager.NameContains")} <input name="name" placeholder="${t("LOOTCRATES.Manager.NameContainsPlaceholder")}" autocomplete="off"></label>`;
}

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

const CHIP_NAME = words({ unset: "LOOTCRATES.Pools.NoRarity", never: "LOOTCRATES.Pools.NeverDrops", missing: "LOOTCRATES.Pools.Missing", renamed: "LOOTCRATES.Pools.Renamed" });

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
    cleared.push(t("LOOTCRATES.Pools.TheFilter", { name: RARITY_LABEL[next.chip] ?? CHIP_NAME[next.chip] ?? next.chip }));
    next.chip = null;
  }
  if (String(next.q ?? "").trim() && pinned.some(r => !filterRows([r], { q: next.q }).length)) {
    cleared.push(t("LOOTCRATES.Pools.TheSearch"));
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
  const where = pool?.name ?? t("LOOTCRATES.Pools.ThePool");
  let text;
  if (duplicate && rows[0]) text = t("LOOTCRATES.Pools.AlreadyIn", { name: rows[0].name, pool: where });
  else if (added === 1 && rows[0]) {
    const r = rows[0];
    text = t("LOOTCRATES.Pools.AddedOne", { name: r.name, pool: where, rarity: r.unset ? t("LOOTCRATES.Pools.UnsetDrawsCommon") : RARITY_LABEL[r.rarity] });
  } else {
    const top = added > rows.length ? t("LOOTCRATES.Pools.FirstAtTop", { count: rows.length }) : t("LOOTCRATES.Pools.AllAtTop");
    const items = plural(added, "LOOTCRATES.Editor.ItemsOne", "LOOTCRATES.Editor.ItemsMany");
    text = label ? t("LOOTCRATES.Pools.AddedFrom", { items, label, pool: where, top }) : t("LOOTCRATES.Pools.AddedMany", { items, pool: where, top });
  }
  if (cleared.length) text += ` ${t(rows.length === 1 ? "LOOTCRATES.Pools.ClearedOne" : "LOOTCRATES.Pools.ClearedMany", { what: cleared.join(t("LOOTCRATES.Common.And")) })}`;
  return text;
}

/*
  What the tab's status line says once a field saved in place: a Boxes
  row's price ("Saved: Goblin Crate, 12 gp 5 sp.") or a pool row's weight
  or rarity ("Saved: Flame Tongue, weight 3."). One sentence shape for every
  in-place save, so a screen reader hears that it happened and what stands.
*/
export const savedNotice = (name, value) => t("LOOTCRATES.Pools.Saved", { name: name || t("LOOTCRATES.Pools.TheRow"), value });

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

// "1 item", "3 items": `one` and `many` are keys with a {count}.
const plural = (n, one, many) => t(n === 1 ? one : many, { count: n });
const CHIP_TEXT = {
  unset: n => t("LOOTCRATES.Pools.CountUnset", { count: n }),
  never: n => plural(n, "LOOTCRATES.Pools.CountNeverOne", "LOOTCRATES.Pools.CountNeverMany"),
  missing: n => t("LOOTCRATES.Pools.CountMissing", { count: n }),
  renamed: n => t("LOOTCRATES.Pools.CountRenamed", { count: n }),
};
// "8 common": a count of one rarity, its name in lower case.
const rarityCount = (n, r) => t("LOOTCRATES.Pools.CountRarity", { count: n, rarity: RARITY_LABEL[r].toLowerCase() });

// Every chip with a count, plus the active one even at 0 so it can be
// turned off. Counts come from matchesChip, so a chip shows what it says.
export function chipList(rows, active = null) {
  const out = [];
  for (const chip of [...RARITIES, ...PROBLEM_CHIPS]) {
    const n = rows.filter(r => matchesChip(r, chip)).length;
    if (!n && chip !== active) continue;
    const rarity = RARITIES.includes(chip);
    out.push({ chip, n, rarity, label: rarity ? rarityCount(n, chip) : CHIP_TEXT[chip](n) });
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
  const comma = t("LOOTCRATES.Common.ListComma");
  const problems = [missing && CHIP_TEXT.missing(missing), renamed && CHIP_TEXT.renamed(renamed), unset && CHIP_TEXT.unset(unset)].filter(Boolean).join(comma);
  return `${plural(n, "LOOTCRATES.Editor.ItemsOne", "LOOTCRATES.Editor.ItemsMany")}${counts.length ? " · " + counts.map(([r, c]) => rarityCount(c, r)).join(comma) : ""}${never ? ` · ${CHIP_TEXT.never(never)}` : ""}${problems ? ` · <span class="lc-pool__problems">${problems}</span>` : ""}`;
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
export const nameList = listAnd;
const strongList = (boxes, esc) => nameList(boxes.map(b => `<strong>${esc(b.name)}</strong>`));
export const USERS_SHOWN = 3;

// The header's quiet line: "In Adventurer's Crate, Royal Crate", "In A, B, C
// and 2 more", or "Not in any box".
export function usersText(names) {
  const shown = names.slice(0, USERS_SHOWN).join(t("LOOTCRATES.Common.ListComma"));
  return !names.length ? t("LOOTCRATES.Pools.InNoBox")
    : names.length > USERS_SHOWN ? t("LOOTCRATES.Pools.InBoxesMore", { names: shown, count: names.length - USERS_SHOWN }) : t("LOOTCRATES.Pools.InBoxes", { names: shown });
}
export function usersLine(names, esc) {
  return `<span class="lc-pool__users">${esc(usersText(names))}</span>`;
}

const emptiedText = (emptied, esc) => t(emptied.length === 1 ? "LOOTCRATES.Pools.EmptiedOne" : "LOOTCRATES.Pools.EmptiedMany", { names: strongList(emptied, esc) });

// The Delete pool confirm: the boxes that use it by name, and in a sentence
// of its own the ones it would leave with nothing inside.
export function deletePoolText(pool, { users = [], emptied = [], kept = [] }, esc) {
  const out = [`<p>${t("LOOTCRATES.Game.DeleteAsk", { name: `<strong>${esc(pool.name)}</strong>` })} ${users.length ? t("LOOTCRATES.Pools.ItIsIn", { names: strongList(users, esc) }) : t("LOOTCRATES.Pools.NoBoxDraws")}</p>`];
  if (kept.length) out.push(`<p>${t(kept.length === 1 ? "LOOTCRATES.Pools.KeptOne" : "LOOTCRATES.Pools.KeptMany", { names: strongList(kept, esc) })}</p>`);
  if (emptied.length) out.push(`<p>${emptiedText(emptied, esc)}</p>`);
  return out.join("");
}

// The Remove confirm, asked only when the removal empties a box.
export function removeEntryText(name, pool, emptied, esc) {
  return `<p>${t("LOOTCRATES.Pools.RemoveAsk", { name: `<strong>${esc(name)}</strong>`, pool: `<strong>${esc(pool.name)}</strong>`, boxes: nameList(emptied.map(b => esc(b.name))) })}</p><p>${emptiedText(emptied, esc)}</p>`;
}

export function chipsHTML(pool, rows, view, esc) {
  return chipList(rows, view.chip).map(c => `<button type="button" class="lc-odd lc-chip ${c.rarity ? `lc-rarity-${c.chip}` : "lc-chip--problem"}" data-action="filterChip" data-pool="${esc(pool.id)}" data-chip="${c.chip}" aria-pressed="${c.chip === view.chip}">${esc(c.label)}</button>`).join("");
}

// "Set rarity for N unset", over the rows the search and chip let through.
export function unsetButton(pool, matched, view, esc) {
  const n = matched.filter(r => r.unset).length;
  if (!n) return "";
  const narrowed = !!(view.q?.trim() || view.chip);
  const title = narrowed ? t("LOOTCRATES.Pools.SetRarityTipMatching") : t("LOOTCRATES.Pools.SetRarityTip");
  return `<button type="button" data-action="setUnsetRarity" data-pool="${esc(pool.id)}" title="${title}">${t(narrowed ? "LOOTCRATES.Pools.SetRarityMatching" : "LOOTCRATES.Pools.SetRarity", { count: n })}</button>`;
}

// "Showing 50 of 273" and "Show 50 more (223 left)", or why nothing shows.
export function footHTML(pool, all, matched, page, esc) {
  if (!all.length) return "";
  if (!matched.length) return `<span class="lc-pool__shown">${t("LOOTCRATES.Pools.NoMatch")}</span>`;
  const text = page.left > 0 ? t("LOOTCRATES.Pools.Showing", { shown: matched.length - page.left, count: matched.length }) : matched.length < all.length ? t("LOOTCRATES.Pools.Match", { count: matched.length, all: all.length }) : "";
  const more = page.left > 0 ? `<button type="button" class="lc-pool__more" data-action="showMore" data-pool="${esc(pool.id)}">${t("LOOTCRATES.Pools.ShowMore", { next: page.next, left: page.left })}</button>` : "";
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
      ${has ? `<input type="search" class="lc-pool__search" data-pool="${id}" value="${esc(view.q ?? "")}" placeholder="${t("LOOTCRATES.Pools.SearchPlaceholder")}" aria-label="${t("LOOTCRATES.Pools.SearchLabel", { name: esc(pool.name) })}" autocomplete="off" spellcheck="false">` : ""}
      <span class="lc-pool__unset">${unsetButton(pool, matched, view, esc)}</span>
      <span class="lc-tabs__spacer"></span>
      <button type="button" data-action="bulkAdd" data-pool="${id}" title="${t("LOOTCRATES.Pools.BulkAddTip")}"><i class="fas fa-book"></i> ${t("LOOTCRATES.Pools.BulkAdd")}</button>
      <button type="button" data-action="crateFromPool" data-pool="${id}" aria-label="${t("LOOTCRATES.Pools.CrateFromLabel", { name: esc(pool.name) })}" title="${t("LOOTCRATES.Pools.CrateFromTip")}"><i class="fas fa-box-open"></i> ${t("LOOTCRATES.Pools.CrateFrom")}</button>
      <button type="button" data-action="editPool" data-pool="${id}" aria-label="${t("LOOTCRATES.Pools.RenameLabel", { name: esc(pool.name) })}" data-tooltip="${t("LOOTCRATES.Manager.EditPool")}"><i class="fas fa-pen" inert></i></button>
      <button type="button" data-action="deletePool" data-pool="${id}" aria-label="${t("LOOTCRATES.Boxes.DeleteLabel", { name: esc(pool.name) })}"><i class="fas fa-trash"></i></button>
    </div>
    ${has ? `<div class="lc-pool__chips" role="group" aria-label="${t("LOOTCRATES.Pools.FilterLabel", { name: esc(pool.name) })}">${chipsHTML(pool, rows, view, esc)}</div>` : ""}
    <p class="lc-pool__hint">${t(missing ? "LOOTCRATES.Pools.DropHintRelink" : "LOOTCRATES.Pools.DropHint")}</p>
    ${has ? `<p class="lc-pool__hint" id="${esc(rarityHintId(pool.id))}">${t("LOOTCRATES.Pools.RarityHint")}</p>` : ""}
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
    `<option value="" ${current === "" ? "selected" : ""}>${blank ? t("LOOTCRATES.Pools.NotSetCommon") : t("LOOTCRATES.Pools.FromSource", { rarity: RARITY_LABEL[fromSource] })}</option>`,
    ...RARITIES.filter(r => blank || r !== fromSource).map(r => `<option value="${r}" ${current === r ? "selected" : ""}>${RARITY_LABEL[r]}</option>`),
  ].join("");
  return `<select class="lc-entry__rarity" data-curate="rarity" ${ids}${learn} aria-label="${t("LOOTCRATES.Pools.RarityOf", { name: esc(name) })}" aria-describedby="${esc(rarityHintId(poolId))}" title="${t("LOOTCRATES.Pools.RarityTip")}">${options}</select>
    <input class="lc-entry__weight" type="number" min="0" step="1" inputmode="numeric" value="${entryWeight(e)}" data-curate="weight" ${ids}${learn} aria-label="${t("LOOTCRATES.Pools.WeightOf", { name: esc(name) })}" title="${t("LOOTCRATES.Pools.WeightTip")}">`;
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
    if (src.name !== e.name) notes.push(t("LOOTCRATES.Pools.WasName", { name: e.name }));
    if (src.rarity != null && normalizeRarity(src.rarity) !== sourceRarityOf(e)) notes.push(t("LOOTCRATES.Pools.NowAtSource", { rarity: RARITY_LABEL[normalizeRarity(src.rarity)] }));
  }
  if (unset) notes.push(CHIP_NAME.unset);
  if (never) notes.push(CHIP_NAME.never);
  const just = row.recent ? `<span class="lc-entry__new">${t("LOOTCRATES.Pools.JustAdded")}</span>${notes.length ? " · " : ""}` : "";
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
    const remove = `<button type="button" class="lc-entry__remove" data-action="removeEntry" ${ids} aria-label="${t("LOOTCRATES.Pools.RemoveLabel", { name: esc(e.name) })}" data-tooltip="${t("LOOTCRATES.Pools.Remove")}"><i class="fa-solid fa-xmark" inert></i></button>`;
    return `<li class="lc-entry lc-entry--missing lc-rarity-${effectiveRarity(e)}" data-entry="${esc(e.uuid)}" data-pool="${esc(poolId)}" data-relink="${esc(e.uuid)}" title="${t("LOOTCRATES.Pools.RelinkTip")}">
      <img src="${esc(e.img || FALLBACK_IMG)}" alt="">
      <span class="lc-entry__text"><span class="lc-entry__name">${esc(e.name)}</span><small class="lc-entry__status">${t("LOOTCRATES.Pools.SourceMissing")}</small></span>
      <button type="button" class="lc-entry__update" data-action="relinkEntry" ${ids} aria-label="${t("LOOTCRATES.Pools.RelinkLabel", { name: esc(e.name) })}">${t("LOOTCRATES.Pools.Relink")}</button>
      ${remove}</li>`;
  }
  const parts = entryParts(row, esc);
  const remove = `<button type="button" class="lc-entry__remove" data-action="removeEntry" ${ids} aria-label="${t("LOOTCRATES.Pools.RemoveLabel", { name: esc(parts.name) })}" data-tooltip="${t("LOOTCRATES.Pools.Remove")}"><i class="fa-solid fa-xmark" inert></i></button>`;
  const update = status === "renamed" ? `<button type="button" class="lc-entry__update" data-action="updateEntry" ${ids} aria-label="${t("LOOTCRATES.Pools.UpdateLabel", { from: esc(e.name), to: esc(parts.name) })}">${t("LOOTCRATES.Pools.Update")}</button>` : "";
  return `<li class="${parts.className}" data-entry="${esc(e.uuid)}">
    <img src="${esc((status === "renamed" && src.img) || e.img || FALLBACK_IMG)}" alt="">
    ${parts.text}
    ${curateControls(poolId, e, src, status, parts.name, esc)}
    ${update}${remove}</li>`;
}

/* ---------- The preview before a drop goes in ---------- */

// "{count} spell", "{count} spells": the item types a drop leaves out.
export const SKIPPED_NAMES = {
  spell: ["LOOTCRATES.Pools.SpellOne", "LOOTCRATES.Pools.SpellMany"],
  feat: ["LOOTCRATES.Pools.FeatOne", "LOOTCRATES.Pools.FeatMany"],
  class: ["LOOTCRATES.Pools.ClassOne", "LOOTCRATES.Pools.ClassMany"],
  subclass: ["LOOTCRATES.Pools.SubclassOne", "LOOTCRATES.Pools.SubclassMany"],
  background: ["LOOTCRATES.Pools.BackgroundOne", "LOOTCRATES.Pools.BackgroundMany"],
  race: ["LOOTCRATES.Pools.SpeciesOne", "LOOTCRATES.Pools.SpeciesMany"],
  facility: ["LOOTCRATES.Pools.FacilityOne", "LOOTCRATES.Pools.FacilityMany"],
};
// The same types' names alone, for "Fireball is a spell, not loot."
export const SKIPPED_NOUN = words({
  spell: "LOOTCRATES.Pools.NounSpell", feat: "LOOTCRATES.Pools.NounFeat", class: "LOOTCRATES.Pools.NounClass", subclass: "LOOTCRATES.Pools.NounSubclass",
  background: "LOOTCRATES.Pools.NounBackground", race: "LOOTCRATES.Pools.NounSpecies", facility: "LOOTCRATES.Pools.NounFacility",
});
const skippedName = (type, n) => (SKIPPED_NAMES[type] ? plural(n, ...SKIPPED_NAMES[type]) : `${n} ${n === 1 ? type : `${type}s`}`);

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
  if (flattened) lines.push(plural(flattened, "LOOTCRATES.Pools.FlattenedOne", "LOOTCRATES.Pools.FlattenedMany"));
  if (duplicates) lines.push(t("LOOTCRATES.Pools.Duplicates", { count: duplicates }));
  const kinds = Object.entries(notLoot).map(([type, n]) => skippedName(type, n));
  if (kinds.length) lines.push(t("LOOTCRATES.Pools.NotLoot", { kinds: kinds.join(t("LOOTCRATES.Common.ListComma")) }));
  if (text) lines.push(t(textAsNothing ? (text === 1 ? "LOOTCRATES.Pools.TextNothingOne" : "LOOTCRATES.Pools.TextNothingMany") : (text === 1 ? "LOOTCRATES.Pools.TextSkippedOne" : "LOOTCRATES.Pools.TextSkippedMany"), { count: text }));
  if (notItems) lines.push(plural(notItems, "LOOTCRATES.Pools.NotItemsOne", "LOOTCRATES.Pools.NotItemsMany"));
  if (tooDeep) lines.push(t(tooDeep === 1 ? "LOOTCRATES.Pools.TooDeepOne" : "LOOTCRATES.Pools.TooDeepMany", { count: tooDeep, depth }));
  if (emptyTables) lines.push(plural(emptyTables, "LOOTCRATES.Pools.EmptyTablesOne", "LOOTCRATES.Pools.EmptyTablesMany"));
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
  const items = plural(n, "LOOTCRATES.Editor.ItemsOne", "LOOTCRATES.Editor.ItemsMany");
  return `<div class="lc-preview">
        <p class="lc-preview__lead">${t("LOOTCRATES.Pools.PreviewLead", { items: `<strong>${items}</strong>`, label: `<strong>${esc(plan.label)}</strong>`, pool: `<strong>${esc(poolName)}</strong>` })}</p>
        <p class="lc-preview__rarities" aria-label="${t("LOOTCRATES.Pools.ByRarity")}">${RARITIES.filter(r => counts[r]).map(r => `<span class="lc-odd lc-rarity-${r}">${rarityCount(counts[r], r)}</span>`).join("")}</p>
        ${skipped.length ? `<ul class="lc-preview__skipped">${skipped.map(line => `<li>${esc(line)}</li>`).join("")}</ul>` : ""}
        <ul class="lc-preview__list">${shown.map(e => `<li class="lc-entry lc-rarity-${normalizeRarity(e.rarity)}"><img src="${esc(e.img || FALLBACK_IMG)}" alt=""><span class="lc-entry__name">${esc(e.name)}</span>${e.weight > 1 ? `<small class="lc-preview__weight">${t("LOOTCRATES.Pools.WeightN", { weight: esc(e.weight) })}</small>` : ""}<em>${RARITY_LABEL[normalizeRarity(e.rarity)]}</em></li>`).join("")}</ul>
        ${n > shown.length ? `<p class="lc-preview__more">${t("LOOTCRATES.Card.AndMore", { count: n - shown.length })}</p>` : ""}
      </div>`;
}
