/*
  The player's Crate Shop: the boxes on offer, what each costs, whether this
  character can afford it, and a Buy button that asks the GM to do the pull.

  While a pull of a crate spins on this client, that crate's card keeps the
  character's pity line and odds from before the pull (reveal.js heldState):
  the GM writes the new state about 0.3 s after the reveal goes out, and a
  card redrawn from it said whether the pull hit Rare or better seconds
  before the marker stopped. The card changes when the spin lands
  (onRelease), as part of the payoff. Until then that crate's Buy is off
  ("Still spinning"): the held odds aren't the ones a second pull would be
  rolled at.

  The character is picked again on every render and every Buy (boxcard.js
  pickActor), from the characters this player owns now: the GM can take one
  away, give one or assign the player's own while the shop is open, and the
  hooks in registerShopHooks redraw it when they do. A pull that is out
  keeps the character it was sent for until it settles, and so does the
  character select: aria-disabled while busy, its changes ignored, so the
  character and purse on screen are always the ones the pull charges.

  A Buy that looked live but did nothing says why in the shop's notice (the
  header's one live region): the character was re-picked under it, the GM
  raised the price past the purse, or the crate became unbuyable a moment
  before the redraw showed it. That line stays while it still holds and
  clears on the next Buy that goes out.
*/
import { getBoxes, getPools, getLog, getActorState, isShopOpen, todayKey } from "./store.js";
import { formatGold } from "./currency.js";
import { actorPicker, boxCard, buyReason, changedCharacterLine, crateReason, refusalLine, shopHTML, shopNotice, shopReason, patchShop, pickActor } from "./boxcard.js";
import { shopOdds } from "./odds.js";
import { requestPull } from "./socket.js";
import { heldState, onRelease } from "./reveal.js";
import { getKind, kindOf } from "./kinds.js";
// The crate and the well register themselves when imported, so every record is found.
import "./crate.js";
import "./well.js";

const { ApplicationV2 } = foundry.applications.api;
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));

/*
  The shop sells every kind of game (kinds.js) by the same rules: a kind's
  own card and buy reason when it has them, else the crate's (boxcard.js),
  so a game this client doesn't know still shows as a crate-shaped card
  that says why it can't be bought rather than nothing at all.
*/
const shopOf = game => getKind(kindOf(game))?.shop ?? {};
const cardFor = (game, pools, ctx) => (shopOf(game).card ?? boxCard)(game, pools, ctx);
const reasonFor = (game, pools, ctx) => (shopOf(game).reason ?? ((b, p, c) => buyReason(b, shopOdds(b, p, c.stateOf(b.id)), c)))(game, pools, ctx);

export function buyableActors(user = game.user) {
  const owned = game.actors.filter(a => a.type === "character" && a.testUserPermission(user, "OWNER"));
  const main = user.character;
  return main && owned.includes(main) ? [main, ...owned.filter(a => a !== main)] : owned;
}

export class CrateShop extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "loot-crates-shop",
    classes: ["loot-crates", "lc-shop"],
    window: { title: "Crate Shop", resizable: true },
    position: { width: 640, height: "auto" },
    actions: { buy: CrateShop.#buy },
  };

  // The character the cards were last drawn for (see #resolve).
  actorId = pickActor(null, buyableActors(), game.user.character);
  busy = false;
  // The box whose Buy was pressed, so only that card says "Opening…".
  busyBox = null;
  // Why it is taking long, once it is: "gm" or "hidden" (socket.js onWait).
  waiting = null;
  // Why the last Buy did nothing, while it still holds: { text, actorId,
  // holds() } (see #refuse), or null.
  said = null;

  get actor() { return game.actors.get(this.actorId) ?? null; }

  // Who the shop buys for now: the stored pick while the player still owns
  // it, else their own character, else the first they own, else nobody.
  // While a pull is out it stays the one that pull was sent for.
  #resolve(actors = buyableActors()) {
    return this.busy ? this.actorId : pickActor(this.actorId, actors, game.user.character);
  }

  /*
    An unbuyable Buy is aria-disabled, not disabled (it keeps focus), so a
    click or Enter on it still lands here: check again, from fresh data, that
    nothing is out and this crate can be bought now.
  */
  static async #buy(_event, target) {
    if (this.busy) return;
    // The cards on screen were drawn for this.actorId. If the player no
    // longer owns it (or now owns one where they had none), those cards
    // are someone else's: redraw them for the right character instead of
    // sending a pull the GM would refuse, or one for a character the
    // player never saw named.
    const actorId = this.#resolve();
    if (actorId !== this.actorId) {
      this.actorId = actorId;
      // No character at all is the notice's own reason.
      const name = this.actor?.name;
      this.said = name ? { text: changedCharacterLine(name), actorId, holds: () => true } : null;
      this.render();
      return;
    }
    const boxId = target.dataset.box;
    const box = getBoxes()[boxId];
    const ctx = this.#ctx();
    if (!box || reasonFor(box, getPools(), ctx)) {
      // An aria-disabled Buy already shows its reason; one that looked live
      // was drawn before the change, so say what changed.
      if (target.getAttribute?.("aria-disabled") !== "true") this.#refuse(boxId, target.dataset.price, ctx);
      return;
    }
    this.busy = true;
    this.busyBox = boxId;
    this.said = null;
    this.render();
    const onWait = why => {
      if (this.busyBox !== boxId) return;
      this.waiting = why;
      this.render();
    };
    // The price this Buy showed, not the setting's now: if the GM changed it
    // since this card was drawn, the GM refuses the pull rather than charge
    // a price the buyer never saw (pull.js expectedPrice).
    const shown = target.dataset.price;
    const price = shown != null && shown !== "" && Number.isFinite(Number(shown)) ? Number(shown) : undefined;
    try {
      await requestPull({ boxId, actorId, price }, { onWait });
    } catch (err) {
      ui.notifications.warn(err.message);
    } finally {
      this.busy = false;
      this.busyBox = null;
      this.waiting = null;
      this.render();
    }
  }

  /*
    Puts why a live-looking Buy of `boxId` did nothing in the notice and
    redraws, so the cards catch up too. The line holds while the shop buys
    for the same character and the crate is still unbuyable at the same
    price (or still gone); a shop-wide reason is the notice's own.
  */
  #refuse(boxId, shown, ctx) {
    if (shopReason(ctx)) {
      this.said = null;
      this.render();
      return;
    }
    // The game's own reason as it stands now (the kind's, else the crate's).
    const reasonNow = box => {
      const now = this.#ctx();
      const own = shopOf(box).reason;
      return own ? own(box, getPools(), now) : crateReason(box, shopOdds(box, getPools(), now.stateOf(boxId)), now);
    };
    const box = getBoxes()[boxId];
    const text = refusalLine({ box, reason: box ? reasonNow(box) : "", shown, purse: ctx.purse, actorName: ctx.actorName });
    const price = box?.price;
    const holds = () => {
      const now = getBoxes()[boxId];
      if (!box) return !now;
      return !!now && now.price === price && !!reasonNow(now);
    };
    this.said = text ? { text, actorId: this.actorId, holds } : null;
    this.render();
  }

  // The notice: a shop-wide reason or a slow GM first, else why the last Buy
  // did nothing while that still holds.
  #notice(ctx) {
    const notice = shopNotice(ctx);
    if (notice.text) return notice;
    if (this.said && (this.said.actorId !== this.actorId || !this.said.holds())) this.said = null;
    return this.said ? { text: this.said.text, tone: "warn" } : notice;
  }

  // A change listener, not a data-action: ApplicationV2 runs actions on click,
  // and re-rendering on the click that opens the list closed it again.
  // While a pull is out the select is aria-disabled and a change is put back.
  #choose(select) {
    if (this.busy) {
      select.value = this.actorId;
      return;
    }
    this.actorId = select.value;
    this.render();
  }

  // Keeps an aria-disabled select shut: no list on a press, no arrow-key,
  // Space, Enter or type-ahead change. Tab, Escape and shortcuts with Ctrl
  // or Cmd still work. A change that gets through anyway (a touch picker) is
  // put back by #choose.
  #hold(event) {
    if (!this.busy) return;
    const key = event.key ?? "";
    const changes = event.type === "mousedown" || /^(Arrow|Page)|^(Home|End|Enter| )$/.test(key) || (key.length === 1 && !event.ctrlKey && !event.metaKey);
    if (changes) event.preventDefault();
  }

  // What decides whether a crate can be bought, for the cards and for #buy.
  // stateOf reads this character's pity count and owned items per box (a
  // world setting, so a player's client can read it), so each card shows
  // the odds draw() will use for them. `today` and `log` are for a game
  // that counts plays per in-game day (the well's cap, well.js).
  #ctx() {
    const actor = this.actor;
    const gm = !!game.users.activeGM;
    return {
      purse: actor?.system?.currency ?? {}, open: isShopOpen() && gm, gmOnline: gm, hasActor: !!actor,
      actorId: actor?.id ?? null, actorName: actor?.name ?? "", stateOf: boxId => (actor ? heldState(actor.id, boxId) ?? getActorState(actor.id, boxId) : {}),
      today: todayKey(), log: getLog(),
      held: boxId => !!(actor && heldState(actor.id, boxId)),
      busy: this.busy, busyBox: this.busyBox, waiting: this.waiting, art: `<i class="fas fa-box-open"></i>`, esc,
    };
  }

  async _renderHTML() {
    const root = document.createElement("div");
    root.className = "lc-shop__body";
    const actors = buyableActors();
    this.actorId = this.#resolve(actors);
    const actor = this.actor;
    const boxes = Object.values(getBoxes());
    const pools = getPools();
    const purse = actor?.system?.currency ?? {};
    const ctx = this.#ctx();
    // A pull that is out keeps its character on screen even if the player no
    // longer owns it, so the field names who it charges.
    const shown = actor && !actors.includes(actor) ? [actor, ...actors] : actors;
    const picker = actorPicker({ actors: shown, actorId: this.actorId, busy: this.busy, esc });
    const purseField = actor ? `<div class="lc-shop__field lc-shop__field--purse"><span class="lc-label">Purse</span><span class="lc-shop__purse">${esc(formatGold(purse))}</span></div>` : "";

    // The shop-wide reason (closed, no GM, no character) or the wait is said
    // once, in the header's live region; the cards only point at it.
    this.notice = this.#notice(ctx);
    root.innerHTML = shopHTML({
      fields: picker + purseField,
      cards: boxes.length ? boxes.map(b => cardFor(b, pools, ctx)).join("") : `<p class="lc-shop__empty">No crates on the shelf yet. The GM builds them from Game Settings, Loot Crates.</p>`,
      notice: this.notice,
    });
    const select = root.querySelector(".lc-shop__actor");
    select?.addEventListener("change", e => this.#choose(e.currentTarget));
    select?.addEventListener("mousedown", e => this.#hold(e));
    select?.addEventListener("keydown", e => this.#hold(e));
    return root;
  }

  // Why a Buy did nothing is about that press; a shop opened again later
  // starts without it.
  _onClose(options) {
    this.said = null;
    super._onClose?.(options);
  }

  // The notice node, the cards and the focused Buy are kept across renders
  // (see boxcard.js patchShop). The <select> is kept too, with the change
  // listener it got on the first render.
  _replaceHTML(result, content) { patchShop(content, result, this.notice); }
}

let shop = null;
export function openShop() {
  shop ??= new CrateShop();
  shop.render({ force: true });
  return shop;
}
export function refreshShop() { if (shop?.rendered) shop.render(); }

/*
  What redraws an open shop besides the world settings (redraw.js): its
  purse changing, a GM coming online, and anything that changes which
  characters this player owns: an actor's ownership, an actor created or
  deleted, or this user's own character assigned or cleared. Called from
  main.js at load; `hooks` is Foundry's Hooks.
*/
export function registerShopHooks(hooks = globalThis.Hooks) {
  hooks.on("updateActor", (_actor, change) => {
    if (change?.system?.currency || change?.ownership) refreshShop();
  });
  hooks.on("createActor", () => refreshShop());
  hooks.on("deleteActor", () => refreshShop());
  hooks.on("updateUser", (user, change) => {
    if (user?.id === game.user?.id && change && "character" in change) refreshShop();
  });
  hooks.on("userConnected", () => refreshShop());
  // The in-game day moved (the GM's calendar, a long rest that advances
  // time): a well's throws today start again (well.js).
  hooks.on("updateWorldTime", () => refreshShop());
}
// A held pity line and odds change when the spin lands.
onRelease(() => refreshShop());
