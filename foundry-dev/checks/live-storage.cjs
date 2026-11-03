// Live probe: where could the GM keep what a player must not read? (round 31
// B2). Five kinds of Foundry storage, each written by the Gamemaster with a
// marked value, then read by a player's client the ways a player can (what
// the world sent it at load, what an update broadcast, and a direct get
// from the server):
//
//   setting   the module's own world setting (`boxes`, config: false), with
//             an auction whose reserve and house budget are the marks
//   journal   a flag on a JournalEntry with default ownership NONE
//   userFlag  a flag on the Gamemaster's own User
//   userSetting  a user-scoped Setting document for the Gamemaster
//   pack      a document in a world compendium with PLAYER and TRUSTED NONE
//
//   FOUNDRY_URL=http://<host>:30000 NODE_PATH=$(npm root -g) \
//     node foundry-dev/checks/live-storage.cjs     (or: npm run live -- live-storage)
//
// Env: PLAYER (default Player2). Reports, for each, whether the player read
// the mark at load and after an update. On Foundry 14.369 every one of them
// is read (2026-11-02): no storage hides data from a player's client, so the
// module's GM-only values stay behind foundry/hidden.js and the README says
// they are not secret from a player's console. ok means the probe ran and
// put everything back; `hidden` lists any store a player could not read.
//
// Restored in a finally: the journal entry and the compendium deleted (both
// made by this run), the user flag and the user setting removed, the
// auction record deleted. Nothing else is touched.
/* global game, foundry, JournalEntry, Setting, CONFIG */
const { chromium } = require("playwright");
const FOUNDRY = process.env.FOUNDRY_URL || "http://localhost:30000";
const PLAYER = process.env.PLAYER || "Player2";
const STAMP = Date.now().toString(36);

async function join(browser, user) {
  const page = await (await browser.newContext()).newPage();
  await page.goto(FOUNDRY + "/join", { waitUntil: "networkidle" });
  const free = await page.$eval("select[name=userId]", (s, u) => [...s.options].some(o => o.textContent.trim() === u && !o.disabled), user);
  if (!free) { await page.context().close(); return null; }
  await page.selectOption("select[name=userId]", { label: user });
  await page.click("button[name=join], button[type=submit]");
  await page.waitForURL(/\/game/, { timeout: 30000 });
  await page.waitForFunction(() => window.game?.ready, null, { timeout: 120000 });
  await page.evaluate(() => globalThis.canvas?.app?.ticker?.stop());
  return page;
}

// What the player's client holds, and what the server hands it on a get.
const look = (page, ids) => page.evaluate(async ids => {
  const r = {};
  const flag = d => d?.flags?.["loot-crates"]?.probe ?? null;
  const get = async (cls, op) => { try { return (await CONFIG.DatabaseBackend.get(cls, op)).map(d => d); } catch (e) { return `refused: ${e.message}`; } };
  const boxes = game.settings.storage.get("world").find(s => s.key === "loot-crates.boxes")?.value;
  const parsed = typeof boxes === "string" ? JSON.parse(boxes) : boxes;
  const lot = parsed?.[ids.boxId]?.auction;
  r.setting = { held: lot ? `${lot.reserve}/${lot.house?.budget}` : null };
  const j = game.journal.get(ids.journal);
  const jGot = await get(JournalEntry, { query: { _id: ids.journal } });
  r.journal = { held: flag(j), fromServer: Array.isArray(jGot) ? jGot.map(flag) : jGot };
  r.userFlag = { held: flag(game.users.get(ids.gm)) };
  const us = game.settings.storage.get("world").filter(s => s.key === ids.userKey);
  const usGot = await get(Setting, { query: { key: ids.userKey } });
  r.userSetting = { held: us.map(s => s.value), fromServer: Array.isArray(usGot) ? usGot.map(s => s.value) : usGot };
  const pack = game.packs.get(ids.pack);
  let docs;
  try { docs = (await pack.getDocuments()).map(flag); } catch (e) { docs = `refused: ${e.message}`; }
  r.pack = { visible: pack?.visible ?? null, fromServer: docs };
  return r;
}, ids);

const readMark = (entry, mark) => JSON.stringify(entry).includes(mark);

(async () => {
  const browser = await chromium.launch();
  const out = { player: PLAYER };
  let gm = null, ids = null;
  try {
    gm = await join(browser, "Gamemaster");
    if (!gm) throw new Error("the Gamemaster seat is taken");
    ids = await gm.evaluate(async stamp => {
      const boxId = `probe${stamp}`.slice(0, 16);
      const boxes = foundry.utils.deepClone(game.settings.get("loot-crates", "boxes") ?? {});
      boxes[boxId] = { id: boxId, name: `Storage probe ${stamp}`, kind: "auction", price: 1, pools: [], rules: { shelved: true }, auction: { lot: null, increment: 1, reserve: 4321, gavelSec: 20, house: { count: 1, budget: 8765, chance: 0 } } };
      await game.settings.set("loot-crates", "boxes", boxes);
      const journal = (await JournalEntry.create({ name: `Loot Crates storage probe ${stamp}`, ownership: { default: 0 }, flags: { "loot-crates": { probe: "mark-1" } } })).id;
      await game.user.setFlag("loot-crates", "probe", "mark-1");
      const userKey = `loot-crates.storageProbe${stamp}`;
      await Setting.create({ key: userKey, value: JSON.stringify("mark-1"), user: game.user.id });
      const pack = await foundry.documents.collections.CompendiumCollection.createCompendium({ type: "JournalEntry", label: `Loot Crates storage probe ${stamp}`, name: `lc-storage-probe-${stamp}`, ownership: { PLAYER: "NONE", TRUSTED: "NONE", ASSISTANT: "OWNER" } });
      const doc = (await JournalEntry.create({ name: "probe", flags: { "loot-crates": { probe: "mark-1" } } }, { pack: pack.collection })).id;
      return { boxId, journal, gm: game.user.id, userKey, pack: pack.collection, doc };
    }, STAMP);
    const pl = await join(browser, PLAYER);
    if (!pl) throw new Error(`${PLAYER} is not free to join`);
    out.atLoad = await look(pl, ids);
    await gm.evaluate(async ids => {
      const boxes = foundry.utils.deepClone(game.settings.get("loot-crates", "boxes"));
      boxes[ids.boxId].auction.reserve = 5432;
      await game.settings.set("loot-crates", "boxes", boxes);
      await game.journal.get(ids.journal).setFlag("loot-crates", "probe", "mark-2");
      await game.user.setFlag("loot-crates", "probe", "mark-2");
      await game.settings.storage.get("world").find(s => s.key === ids.userKey).update({ value: JSON.stringify("mark-2") });
      await (await game.packs.get(ids.pack).getDocument(ids.doc)).setFlag("loot-crates", "probe", "mark-2");
    }, ids);
    await pl.waitForTimeout(1500);
    out.afterUpdate = await look(pl, ids);
    const marks = { setting: ["4321", "5432"], journal: ["mark-1", "mark-2"], userFlag: ["mark-1", "mark-2"], userSetting: ["mark-1", "mark-2"], pack: ["mark-1", "mark-2"] };
    out.readable = Object.fromEntries(Object.entries(marks).map(([k, [a, b]]) => [k, { atLoad: readMark(out.atLoad[k], a), afterUpdate: readMark(out.afterUpdate[k], b) }]));
    out.hidden = Object.entries(out.readable).filter(([, v]) => !v.atLoad && !v.afterUpdate).map(([k]) => k);
    out.ok = true;
  } catch (err) {
    out.error = String(err?.stack || err);
    out.ok = false;
  } finally {
    try {
      out.restored = gm && ids ? await gm.evaluate(async ids => {
        const boxes = foundry.utils.deepClone(game.settings.get("loot-crates", "boxes"));
        delete boxes[ids.boxId];
        await game.settings.set("loot-crates", "boxes", boxes);
        await game.journal.get(ids.journal)?.delete();
        await game.user.unsetFlag("loot-crates", "probe");
        for (const s of game.settings.storage.get("world").filter(s => s.key === ids.userKey)) await s.delete();
        await game.packs.get(ids.pack)?.deleteCompendium();
        return { box: !game.settings.get("loot-crates", "boxes")[ids.boxId], journal: !game.journal.get(ids.journal), flag: game.user.getFlag("loot-crates", "probe") == null, setting: !game.settings.storage.get("world").some(s => s.key === ids.userKey), pack: !game.packs.get(ids.pack) };
      }, ids) : null;
    } catch (err) { out.restored = { error: String(err) }; }
    if (out.restored && Object.values(out.restored).some(v => v !== true)) out.ok = false;
    console.log(JSON.stringify(out, null, 1));
    if (!out.ok) process.exitCode = 1;
    await browser.close();
  }
})();
