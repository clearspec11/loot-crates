/*
  The starter crates' builder (starter.js holds the set): reads the packs
  the installed dnd5e lists, fills the four pools from their indexes by
  type, subtype and rarity, and writes the pools and the games in one
  queued task (store.js addRecords), every game off the shelf.

  Starter pools already in the world (by name) are used as they are and
  their packs are not read again; a starter game already there is added
  again as a copy only because the GM said so (the manager's confirm).
  A pack the system lists that the world can't open, or one whose index
  can't be read, is left out and named in the report's notes.
*/
import { STARTER_POOLS, starterPackPlan, pickEntries, buildStarter, starterPresent } from "../views/starter.js";
import { getPools, getBoxes, newId, indexRows, addRecords } from "./store.js";
import { t } from "../core/i18n.js";

// The item subtype (dnd5e's system.type.value): potion or scroll, armour or wondrous.
const SUBTYPE_FIELD = "system.type.value";

// The system's packs and rules, from the world as it is loaded.
export function starterPlan() {
  const system = globalThis.game?.system;
  const listed = [...(system?.packs ?? [])].map(p => p?.name).filter(Boolean);
  let rules = "modern";
  try { rules = game.settings.get("dnd5e", "rulesVersion") ?? rules; } catch { /* rulesVersion is dnd5e's since 4.0 (5.0.0 has it); without it, modern */ }
  return starterPackPlan({ system: system?.id ?? "", listed, loaded: id => !!game.packs?.get(id), rules });
}

/*
  Adds the set. Returns { pools, games, reused, notes, empty } for the
  status line (starter.js starterNotice); nothing is written when no pack
  could be read and no starter pool is already here.
*/
export async function addStarterSet() {
  const present = starterPresent(getPools(), getBoxes());
  const reuse = present.pools;
  const needed = STARTER_POOLS.filter(p => !reuse[p.key]);
  const notes = [];
  const packs = [];
  if (needed.length) {
    const plan = starterPlan();
    notes.push(...plan.notes);
    for (const id of plan.packs) {
      try {
        packs.push({ id, rows: await indexRows(game.packs.get(id), [SUBTYPE_FIELD]) });
      } catch (err) {
        console.error(`loot-crates | reading ${id} for the starter crates failed`, err);
        notes.push(t("LOOTCRATES.Starter.PackUnreadable", { id }));
      }
    }
    if (!packs.length && needed.length === STARTER_POOLS.length) return { pools: [], games: [], reused: 0, notes, empty: [] };
  }
  const entries = Object.fromEntries(needed.map(p => [p.key, pickEntries(p, packs)]));
  const names = Object.values(getBoxes()).map(b => b.name);
  const built = buildStarter({ entries, reuse, id: newId, names });
  await addRecords({ pools: built.pools, boxes: built.games });
  return { pools: built.pools, games: built.games, reused: Object.keys(reuse).length, notes, empty: built.empty };
}
