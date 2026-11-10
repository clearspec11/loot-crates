// The GM's count of tickets (tickets.js, store.js ticketsHeld) for a live
// check, wired on the headless Gamemaster as main.js wires it: the branch's
// createItem, updateItem and deleteItem hooks, what each ticket holds
// remembered, and the world counted once. The installed build may have no
// count at all, so the state setting's `tickets` key is put back as it was
// (taken out when the world had none) by restore(): left counted, a later
// check that hands a ticket over without these hooks would be refused.
//
//   const count = ticketCount(MODULE_BASE);
//   out.count = await count.wire(gm.page);        // after the GM has joined
//   await count.held(gm.page, actorId, boxId);    // the count, null if uncounted
//   await count.until(gm.page, actorId, boxId, 2) // polled: hook moves are queued
//   out.countRestored = await count.restore(gm.page);  // in the finally, last
/* global game, Hooks */
function ticketCount(base) {
  let snap; // undefined until wired; null when the world had no count
  return {
    async wire(page) {
      const res = await page.evaluate(async base => {
        const { MODULE_ID, SETTINGS } = await import(base + "scripts/core/config.js");
        const before = game.settings.get(MODULE_ID, SETTINGS.STATE)?.tickets ?? null;
        // No query string on the import: the same module instance socket.js
        // and pull.js use, so own() and the hooks share one mark.
        const tk = await import(base + "scripts/foundry/tickets.js");
        for (const name of ["createItem", "updateItem", "deleteItem"]) {
          for (const h of [...(Hooks.events?.[name] ?? [])]) if (/heardTicket/.test(String(h.fn))) Hooks.off(name, h.fn);
        }
        const hooks = tk.ticketItemHooks();
        Hooks.on("createItem", hooks.created);
        Hooks.on("updateItem", hooks.updated);
        Hooks.on("deleteItem", hooks.deleted);
        tk.rememberTickets();
        const seeded = await tk.seedTickets();
        const now = game.settings.get(MODULE_ID, SETTINGS.STATE)?.tickets ?? null;
        return { before: before ? JSON.parse(JSON.stringify(before)) : null, seeded, counted: !!now?.v, keys: Object.keys(now?.held ?? {}).length };
      }, base);
      snap = res.before;
      return { hadCount: !!res.before, seeded: res.seeded, counted: res.counted, keys: res.keys };
    },
    held: (page, actorId, boxId) => page.evaluate(async ({ base, actorId, boxId }) => (await import(base + "scripts/foundry/store.js")).ticketsHeld(actorId, boxId), { base, actorId, boxId }),
    async until(page, actorId, boxId, want, ms = 6000) {
      const t0 = Date.now();
      let n = await this.held(page, actorId, boxId);
      while (n !== want && Date.now() - t0 < ms) { await page.waitForTimeout(100); n = await this.held(page, actorId, boxId); }
      return n;
    },
    async restore(page) {
      if (snap === undefined) return { restored: true, wired: false };
      const out = await page.evaluate(async ({ base, snap }) => {
        const { MODULE_ID, SETTINGS } = await import(base + "scripts/core/config.js");
        const store = await import(base + "scripts/foundry/store.js");
        await store.enqueueWrite(async () => {
          const all = { ...(game.settings.get(MODULE_ID, SETTINGS.STATE) ?? {}) };
          if (snap) all.tickets = snap;
          else delete all.tickets;
          await game.settings.set(MODULE_ID, SETTINGS.STATE, all);
        });
        const now = game.settings.get(MODULE_ID, SETTINGS.STATE)?.tickets ?? null;
        return { now: now ? JSON.stringify(now) : null, was: snap ? JSON.stringify(snap) : null };
      }, { base, snap });
      const restored = out.now === out.was;
      if (!restored) process.exitCode = 1;
      return { restored, hadCount: !!snap };
    },
  };
}

module.exports = { ticketCount };
