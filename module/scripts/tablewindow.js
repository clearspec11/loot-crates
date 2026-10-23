/*
  The shared table window: one room for any table kind's round (kinds.js
  `table: true`; Roulette and the Auction). It opens on every
  client when the GM opens a round (table.js announces it), shows every
  stake as it arrives (the GM's "staked" broadcast, then the log setting's
  redraw for a refund), the clock or "waiting for the GM", a player's bet
  form and the GM's Spin, and plays the round's reveal through the core's
  one hold (reveal.js showRound hands this window the round's `land`; the
  round's chat card stays sealed until it is called). Reduced motion and a
  hidden page land at once. The words and markup are tableview.js's; the
  stage, the rail and the bets are the kind's (kind.tableView).

  One window per round (the id carries the round's id). A bet is a stake on
  the core (socket.js requestStake: the GM's guards, queue and money path);
  the GM's Spin is table.js resolveRound, and a kind with a cancelLabel
  gives the GM table.js cancelRound. The kind's words name the buttons (the
  Auction's "Bid 55 gp" and "Bring the gavel down") and a kind may keep its
  form in step with the table as stakes land (tableView.syncForm). Nothing
  here writes.
*/
import { MODULE_ID, SETTINGS } from "./config.js";
import { getBoxes, getLog, getRounds } from "./store.js";
import { getKind, kindOf, PullError } from "./kinds.js";
import { stakesOf, liveRoundOf, STATUS } from "./round.js";
import { onTable, openRound, resolveRound, cancelRound } from "./table.js";
import { requestStake, isActiveGM } from "./socket.js";
import { setTableWindow } from "./reveal.js";
import { buyableActors } from "./shop.js";
import { tableBodyHTML, phaseOf, stateText, stakeSentence, countFor, countdownText, betLabelFor } from "./tableview.js";
import { cascadeOffset } from "./revealcard.js";
import "./roulette.js";
import "./auction.js";

const { ApplicationV2 } = foundry.applications.api;
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
const pageHidden = () => document.visibilityState === "hidden";

// The open windows by round id, and the hold's land() for rounds whose
// reveal has arrived (reveal.js setTableWindow), by round id.
const windows = new Map();
const landFns = new Map();

// The characters this user may bet with: a player's own; the GM's assigned
// character alone (the GM runs the table, and every character is theirs).
function viewerActors() {
  if (game.user.isGM) return game.user.character ? [game.user.character] : [];
  return buyableActors();
}

export class TableWindow extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "loot-crates-table-{id}",
    classes: ["loot-crates", "lc-table"],
    window: { title: "The table", resizable: false },
    position: { width: 760, height: "auto" },
    actions: { spin: TableWindow.#spin, cancelRound: TableWindow.#cancel, dismiss: TableWindow.#dismiss, skip: TableWindow.#skip },
  };

  #ctrl = null;
  #spinning = null;
  #values = {};
  #extra = new Map();
  #fresh = new Set();
  #busy = false;
  #onHidden = null;
  #landedAt = -Infinity;
  // The phase the body was last drawn for: a change of phase draws it again.
  #drawn = null;
  // The round as the GM's last "staked" carried it (the Auction's gavel,
  // moved by the bid), until the rounds setting here catches up.
  #heardRound = null;
  reveal = null;
  landed = false;
  // The round was called off without a write here (table.js undoResolve's
  // void, { onReload }): its stakes come back on the GM's next load.
  voided = null;

  constructor(roundId, boxId, options = {}) {
    super({ id: `loot-crates-table-${roundId}`, position: { height: "auto", ...cascadeOffset(0, { width: window.innerWidth, height: window.innerHeight }, { width: 760, height: 560 }) }, ...options });
    this.roundId = roundId;
    this.boxId = boxId;
  }

  get round() {
    const r = getRounds()[this.roundId] ?? null;
    const h = this.#heardRound;
    if (!h || (r && (r.status !== h.status || (r.closesAt ?? 0) >= (h.closesAt ?? 0)))) return r;
    return { ...(r ?? {}), ...h };
  }
  get game() { return getBoxes()[this.round?.boxId ?? this.boxId] ?? null; }
  get kind() { return getKind(kindOf(this.game ?? this.reveal ?? {})) ?? null; }
  get title() { return this.kind?.tableView?.title?.(this.game) ?? "The table"; }
  get phase() { return phaseOf(this.round, { reveal: this.reveal, landed: this.landed, voided: !!this.voided }); }
  get stateOpts() { return { kind: this.kind, onReload: !!this.voided?.onReload }; }

  // The round's stakes as this client knows them. Before the spin: the
  // log's live rows, plus the ones the GM's "staked" broadcast named before
  // the setting reached here (dropped once the log knows them, refunded or
  // not). After it: the resolve's stakes with what each won, less any the
  // log has since refunded (the GM's Refund drops its chip) and keeping any
  // the log doesn't hold here yet.
  stakes() {
    const log = getLog();
    const rows = stakesOf(log, this.roundId);
    const known = new Set(log.filter(r => r?.roundId === this.roundId).map(r => r.id));
    if (this.reveal) {
      const live = new Set(rows.map(r => r.id));
      return this.reveal.stakes.filter(s => live.has(s.logId) || !known.has(s.logId)).map(s => ({ id: s.logId, actorId: s.actorId, actorName: s.actorName, price: s.price, stake: s.stake, name: s.stake?.label ?? "", status: s.action === "settle" ? "settled" : "refunded", payoutCp: s.payoutCp, result: s.result }));
    }
    for (const [id, row] of this.#extra) if (known.has(id)) this.#extra.delete(id); else rows.unshift(row);
    return rows.filter(r => !this.#beaten.has(r.id));
  }

  // Every stake of the round, the ones refunded since included (the
  // Auction's beaten bids, for its last five and its count), newest first.
  history() {
    const rows = getLog().filter(r => r?.roundId === this.roundId);
    const known = new Set(rows.map(r => r.id));
    return [...[...this.#extra.values()].filter(r => !known.has(r.id)).reverse(), ...rows]
      .map(r => (this.#beaten.has(r.id) && !r.refunded ? { ...r, status: "refunded", refunded: true, refundReason: "outbid" } : r));
  }

  // A stake the GM just took (socket.js "staked"): its chip on the rail at
  // once, the count and the list with it, and the bet said in the status
  // line. The body stays as it is, so a player's own Place a bet (still
  // "Placing…", still focused) and the live region are the same elements.
  heardStake(msg) {
    const view = this.kind?.tableView;
    const row = { id: msg.logId, actorId: msg.actorId, actorName: msg.actorName, price: msg.price, stake: msg.stake, name: msg.stake?.label ?? "Stake", status: "open", roundId: msg.roundId, ...(msg.house ? { house: true } : {}) };
    const before = this.history();
    const outbid = (msg.outbid ?? []).map(id => before.find(r => r.id === id)).filter(Boolean);
    // The stakes it displaced are refunded already on the GM: shown so here
    // at once, before the log setting arrives.
    for (const id of msg.outbid ?? []) this.#beaten.add(id);
    this.#extra.set(msg.logId, row);
    this.#fresh.add(msg.logId);
    if (msg.round?.id === this.roundId) this.#heardRound = msg.round;
    this.refresh();
    if (game.settings.get(MODULE_ID, SETTINGS.SOUND) && !pageHidden()) view?.sounds?.bid?.();
    this.#say(typeof view?.announce === "function" ? view.announce(row, { outbid }) : `${stakeSentence(row, view?.verb, view)}. ${countFor(view, this.stakes(), this.history())}.`);
  }

  // Log rows the GM's "staked" said were outbid before the log here knew it.
  #beaten = new Set();

  // The window's status line, for a screen reader.
  #say(text) {
    const live = this.element?.querySelector(".lc-table__live");
    if (live && live.textContent !== text) live.textContent = text;
  }

  // A stake, a refund or the round's change of state (redraw.js, the
  // clock): the head, the rail and the list follow in place. The body is
  // drawn again only when the phase changes (the clock runs out, the GM
  // closes the round), and never once the stage is playing.
  refresh() {
    if (!this.rendered) return;
    this.refreshHead();
    this.#paintRail();
  }

  // The clock's tick and a round's change of state. A new phase draws
  // the body again and is then said in the status line (the head's state
  // is a fresh node, which a screen reader doesn't announce; the clock,
  // ticking, is a timer and never read aloud on its own).
  refreshHead() {
    const root = this.element;
    if (!root) return;
    if (!this.reveal && this.phase !== this.#drawn) {
      this.render().then(() => this.#say(stateText(this.round, this.phase, this.stateOpts).text)).catch(() => {});
      return;
    }
    const state = stateText(this.round, this.phase, this.stateOpts);
    const el = root.querySelector(".lc-table__state");
    if (el && el.textContent !== state.text) { el.textContent = state.text; el.dataset.state = state.key; }
    const count = root.querySelector(".lc-table__count");
    if (count) count.textContent = countFor(this.kind?.tableView, this.stakes(), this.history());
  }

  async _renderHTML() {
    this.#drawn = this.phase;
    const root = document.createElement("div");
    root.className = "lc-table__body";
    const kind = this.kind;
    if (!kind?.tableView) { root.innerHTML = `<p class="lc-empty">This client can't show this table.</p>`; return root; }
    root.innerHTML = tableBodyHTML({ kind, game: this.game ?? { id: this.boxId, name: this.reveal?.box?.name ?? "" }, round: this.round, stakes: this.stakes(), history: this.history(), viewer: { isGM: game.user.isGM, actors: viewerActors().map(a => ({ id: a.id, name: a.name })) }, phase: this.phase, esc, values: this.#values, onReload: !!this.voided?.onReload });
    const form = root.querySelector(".lc-table__form");
    if (form) {
      form.addEventListener("submit", e => { e.preventDefault(); this.#placeBet(form); });
      form.addEventListener("input", () => {
        kind.tableView.onInput?.(form, { game: this.game, stakes: this.stakes() });
        this.#values = readValues(form);
      });
      // The pick's options follow the bet type.
      form.addEventListener("change", e => {
        this.#values = readValues(form);
        if (e.target.matches?.(".lc-table__type") && kind.tableView.pickOptions) {
          const pick = form.querySelector(".lc-table__pick");
          if (pick) pick.innerHTML = kind.tableView.pickOptions(this.game, e.target.value, null, esc);
          this.#values = readValues(form);
        }
      });
    }
    return root;
  }

  _replaceHTML(result, content) {
    const active = content.contains(document.activeElement) ? document.activeElement : null;
    const key = active?.name ? `[name="${CSS.escape(active.name)}"]` : active?.dataset?.action ? `[data-action="${CSS.escape(active.dataset.action)}"]` : active?.classList?.contains("lc-table__bet") ? ".lc-table__bet" : null;
    content.replaceChildren(result);
    this.#mount();
    if (key) content.querySelector(key)?.focus({ preventScroll: true });
  }

  // The kind's stage and the rail in the vault; a reveal already here
  // plays, or, once landed, is posed landed again.
  #mount() {
    const host = this.element?.querySelector(".lc-table__host");
    const view = this.kind?.tableView;
    if (!host || !view) return;
    const game = this.game ?? {};
    const pockets = this.reveal ? view.pocketsIn(this.reveal) : view.pockets(game);
    this.#ctrl = view.mount(host, { pockets, esc });
    this.#paintRail();
    if (!this.reveal) return;
    if (this.landed) { this.#ctrl.spin({ index: view.outcomeIndex(this.reveal), reducedMotion: true }).play(); this.#showLanding(); }
    else this.#play();
  }

  #paintRail() {
    const view = this.kind?.tableView;
    if (!this.#ctrl || !view) return;
    const game = this.game ?? { ...(this.reveal ?? {}), roulette: { pockets: this.reveal?.pockets, colours: this.reveal?.colours } };
    // The outcome as it ended, in the kind's reading (the Auction's sale
    // whose item couldn't be granted reads as no sale).
    const outcome = this.landed ? (view.outcomeOf?.(this.reveal) ?? this.reveal?.outcome ?? null) : null;
    const stakes = this.stakes();
    const history = this.history();
    this.#ctrl.rail(view.rail(game, stakes, { esc, outcome, fresh: [...this.#fresh], actorIds: viewerActors().map(a => a.id), round: this.round, history }));
    this.#fresh.clear();
    const list = this.element?.querySelector(".lc-table__list");
    if (list) list.innerHTML = stakes.filter(r => r.status !== "refunded").map(r => `<li>${esc(stakeSentence(r, view.verb, view))}</li>`).join("");
    // The form follows the table: the Auction's field and button move to
    // the next legal bid as bids land.
    const form = this.element?.querySelector(".lc-table__form");
    if (form && !this.#busy) view.syncForm?.(form, { game, stakes });
  }

  // A player's bet: read, checked here first (so a slip is said before any
  // round trip), then a stake on the core. The button says what it is doing.
  async #placeBet(form) {
    if (this.#busy) return;
    const view = this.kind?.tableView;
    const why = form.querySelector(".lc-table__why");
    const btn = form.querySelector(".lc-table__bet");
    const values = readValues(form);
    this.#values = values;
    let bet;
    try { bet = view.readBet(this.game, values, this.stakes()); } catch (err) { if (why) why.textContent = err.message; return; }
    const actorId = values.actorId ?? viewerActors()[0]?.id;
    if (!actorId) { if (why) why.textContent = "You have no character to bet with."; return; }
    this.#busy = true;
    if (why) why.textContent = "";
    btn.setAttribute("aria-disabled", "true");
    btn.textContent = view.busyLabel ?? "Placing…";
    try {
      await requestStake({ boxId: this.game.id, roundId: this.roundId, actorId, price: bet.price, bet: bet.bet });
      if (why) why.textContent = "";
    } catch (err) {
      if (why) why.textContent = err instanceof PullError ? err.message : "The bet couldn't be placed. Check the GM's console.";
      if (!(err instanceof PullError)) console.error("loot-crates | the bet failed", err);
    } finally {
      this.#busy = false;
      if (btn.isConnected) {
        btn.removeAttribute("aria-disabled");
        btn.textContent = betLabelFor(view, this.game, { stakes: this.stakes(), values: readValues(form) });
        view.syncForm?.(form, { game: this.game, stakes: this.stakes() });
      }
    }
  }

  // The GM's Spin: the round's one resolve (table.js). The reveal comes
  // back through the broadcast, as it does for everyone.
  static async #spin(_event, button) {
    if (button.getAttribute("aria-disabled") === "true") return;
    const view = this.kind?.tableView;
    button.setAttribute("aria-disabled", "true");
    button.textContent = view?.spinningLabel ?? "Spinning…";
    try {
      await resolveRound(this.roundId);
    } catch (err) {
      ui.notifications.warn(err instanceof PullError ? err.message : `The ${this.kind?.noun ?? "wheel"} jammed. Check the console.`);
      if (!(err instanceof PullError)) console.error("loot-crates | the spin failed", err);
      if (button.isConnected) { button.removeAttribute("aria-disabled"); button.textContent = view?.spinLabel ?? "Spin"; }
    }
  }

  // The GM calls the round off (a kind with a cancelLabel: the Auction):
  // every open stake comes back (table.js cancelRound), once confirmed.
  static async #cancel(_event, button) {
    if (button.getAttribute("aria-disabled") === "true") return;
    const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: this.kind?.tableView?.cancelLabel ?? "Call it off" }, content: `<p>Call off <strong>${esc(this.game?.name ?? "this round")}</strong>? Every open ${this.kind?.tableView?.verb === "bids" ? "bid" : "stake"} goes back to its character, and nothing is sold.</p>` });
    if (!ok) return button.isConnected && button.focus();
    button.setAttribute("aria-disabled", "true");
    try {
      await cancelRound(this.roundId);
    } catch (err) {
      ui.notifications.warn(err instanceof PullError ? err.message : "The round couldn't be called off. Check the console.");
      if (!(err instanceof PullError)) console.error("loot-crates | calling the round off failed", err);
      if (button.isConnected) button.removeAttribute("aria-disabled");
    }
  }

  static #dismiss(event) {
    if (event?.detail > 1 || performance.now() - this.#landedAt < 500) return;
    this.close();
  }

  static #skip() { this.#spinning?.skip(); }

  // The round was called off (a void message naming it): the form and Spin
  // go, and the head says where the stakes went.
  heardVoid(msg) {
    if (this.reveal) return;
    this.voided = { onReload: !!msg?.onReload };
    this.refresh();
  }

  // The resolve arrived: one render mounts the stage, which plays once and
  // lands with the hold (a closed window is opened for it).
  play(reveal) {
    this.reveal = reveal;
    return this.render({ force: true });
  }

  #play() {
    const view = this.kind?.tableView;
    const r = this.reveal;
    if (!view || !r || this.#spinning || this.landed) return;
    const sound = game.settings.get(MODULE_ID, SETTINGS.SOUND);
    this.#stopWatching();
    const spin = this.#spinning = this.#ctrl.spin({
      index: view.outcomeIndex(r),
      onTick: sound ? p => { if (!pageHidden()) view.sounds?.tick?.(p); } : null,
      onDrop: sound ? () => { if (!pageHidden()) view.sounds?.drop?.(); } : null,
      onLand: () => {
        this.#stopWatching();
        this.landed = true;
        this.#landedAt = performance.now();
        landFns.get(this.roundId)?.();
        landFns.delete(this.roundId);
        this.#showLanding();
        if (sound && !pageHidden()) view.sting?.(r, { actorIds: viewerActors().map(x => x.id) });
      },
    });
    if (pageHidden()) spin.skip();
    else {
      this.#onHidden = () => { if (pageHidden()) spin.skip(); };
      document.addEventListener("visibilitychange", this.#onHidden);
    }
    spin.play();
  }

  // The ball is down: the vault takes the pocket's rarity, the verdict and
  // each character's net go to the live region, the winning spots light,
  // and the one button reads Close, focused unless the viewer is elsewhere.
  #showLanding() {
    const root = this.element;
    const view = this.kind?.tableView;
    const r = this.reveal;
    if (!root?.isConnected || !view || !r) return;
    const vault = root.querySelector(".lc-vault");
    if (vault) vault.className = `lc-vault lc-rarity-${esc(view.rarityOf(r))}`;
    root.querySelector(".lc-table__result").innerHTML = view.result(r, { esc });
    this.#paintRail();
    this.refreshHead();
    const btn = root.querySelector(".lc-reveal__close");
    if (!btn) return;
    btn.dataset.action = "dismiss";
    btn.textContent = "Close";
    const a = document.activeElement;
    if (!a || a === document.body || root.contains(a)) btn.focus({ preventScroll: true });
  }

  #stopWatching() {
    if (this.#onHidden) document.removeEventListener("visibilitychange", this.#onHidden);
    this.#onHidden = null;
  }

  _onClose(options) {
    super._onClose(options);
    this.#stopWatching();
    this.#spinning?.skip();
    // A window closed mid-spin lets the table's hold go.
    landFns.get(this.roundId)?.();
    landFns.delete(this.roundId);
    if (windows.get(this.roundId) === this) windows.delete(this.roundId);
  }
}

// The form's values by name, for the kind's readBet.
function readValues(form) {
  const out = {};
  for (const [k, v] of new FormData(form).entries()) out[k] = v;
  return out;
}

// The one window for a round.
function tableFor(roundId, boxId) {
  let win = windows.get(roundId);
  if (!win) {
    win = new TableWindow(roundId, boxId ?? getRounds()[roundId]?.boxId ?? null);
    windows.set(roundId, win);
  }
  return win;
}

// The window for a round, opened or brought forward. A round on a clock
// starts the page's one clock, so a client that joined after the round
// opened (and never heard the "open" message) sees its head count down.
export function openTable(roundId, boxId) {
  const win = tableFor(roundId, boxId);
  win.render({ force: true });
  const round = getRounds()[roundId];
  if (round && round.status !== STATUS.RESOLVED && round.closesAt != null) startClock();
  return win;
}

/*
  From a table game's card (shop.js) or the manager: the GM opens a round
  (one at a time per game, its clock the record's) and the window; a player
  gets the open round's window, or is told there is none.
*/
export async function openTableFor(boxId) {
  const box = getBoxes()[boxId];
  const kind = box ? getKind(kindOf(box)) : null;
  if (!kind?.table) return null;
  let round = liveRoundOf(getRounds(), boxId);
  if (!round) {
    if (!isActiveGM()) { ui.notifications.warn(`No round is open at ${box.name} yet.`); return null; }
    round = await openRound(boxId, { windowMs: kind.tableView?.windowMs?.(box) ?? 0 });
  }
  return openTable(round.id, boxId);
}

// Open tables redraw when the log or the rounds change (redraw.js).
export function refreshTables() {
  for (const win of windows.values()) if (win.rendered) win.refresh();
}

/*
  The one clock for every countdown on the page: the table windows' heads
  and the shop cards' "Bets close in 0:42" lines (data-lc-countdown), once
  a second while a round with a clock is open. When a clock runs out the
  shop is told to redraw (its Buy goes off), the window drops its form.
  Started by the round's "open" message, by a table window opening on a
  clocked round, and by a shop drawing a card with a countdown (shop.js),
  so a client that loads mid-round ticks too; it stops itself when no
  clock is left on the page.
*/
let clock = null;
function tick() {
  const now = Date.now();
  for (const win of windows.values()) if (win.rendered) win.refreshHead();
  let crossed = false;
  for (const el of document.querySelectorAll(".lc-shop [data-lc-countdown]")) {
    // In the card's game's own words (its kind's tableView.words).
    const box = getBoxes()[el.closest("[data-box]")?.dataset.box];
    const { text, done } = countdownText(box ? getKind(kindOf(box)) : null, el.dataset.lcCountdown, now);
    el.textContent = text;
    if (done) { crossed = true; delete el.dataset.lcCountdown; }
  }
  if (crossed) import("./shop.js").then(m => m.refreshShop()).catch(() => {});
  const live = Object.values(getRounds()).some(r => r && r.status !== STATUS.RESOLVED && r.closesAt != null && r.closesAt > now);
  if (!live && !document.querySelector("[data-lc-countdown]")) { clearInterval(clock); clock = null; }
}
export function startClock() { clock ??= setInterval(tick, 1000); }

// The round's messages (table.js onTable), on every client.
onTable(msg => {
  if (msg?.type === "round" && msg.event === "open") {
    openTable(msg.round.id, msg.round.boxId);
    if (msg.round.closesAt != null) startClock();
    return;
  }
  if (msg?.type === "staked") return windows.get(msg.roundId)?.heardStake(msg);
  if (msg?.type !== "round") return;
  // The resolve's one render mounts the stage that plays (a second would
  // leave the spin on a stage no longer in the page).
  if (msg.event === "resolve") return tableFor(msg.roundId, msg.boxId).play(msg);
  if (msg.event === "void") {
    for (const id of msg.roundIds ?? []) {
      const win = windows.get(id);
      if (!win) continue;
      if (msg.onReload || msg.cancelled) win.heardVoid(msg); else win.refresh();
    }
    return;
  }
  windows.get(msg.round?.id)?.refresh();
});

// The core's hold hands this window the round's land(): called once the
// stage has landed here, or the window is closed first.
setTableWindow((reveal, { land }) => { landFns.set(reveal.roundId, land); });
