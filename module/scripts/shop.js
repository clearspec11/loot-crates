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
  keeps the character it was sent for until it settles.
*/
import { getBoxes, getPools, getActorState, isShopOpen } from "./store.js";
import { formatGold } from "./currency.js";
import { boxCard, buyReason, shopHTML, shopNotice, patchShop, pickActor } from "./boxcard.js";
import { shopOdds } from "./odds.js";
import { requestPull } from "./socket.js";
import { heldState, onRelease } from "./reveal.js";

const { ApplicationV2 } = foundry.applications.api;
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));

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
      this.render();
      return;
    }
    const boxId = target.dataset.box;
    const box = getBoxes()[boxId];
    const ctx = this.#ctx();
    if (!box || buyReason(box, shopOdds(box, getPools(), ctx.stateOf(boxId)), ctx)) return;
    this.busy = true;
    this.busyBox = boxId;
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

  // A change listener, not a data-action: ApplicationV2 runs actions on click,
  // and re-rendering on the click that opens the list closed it again.
  #choose(select) {
    this.actorId = select.value;
    this.render();
  }

  // What decides whether a crate can be bought, for the cards and for #buy.
  // stateOf reads this character's pity count and owned items per box (a
  // world setting, so a player's client can read it), so each card shows
  // the odds draw() will use for them.
  #ctx() {
    const actor = this.actor;
    const gm = !!game.users.activeGM;
    return {
      purse: actor?.system?.currency ?? {}, open: isShopOpen() && gm, gmOnline: gm, hasActor: !!actor,
      actorName: actor?.name ?? "", stateOf: boxId => (actor ? heldState(actor.id, boxId) ?? getActorState(actor.id, boxId) : {}),
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
    const picker = actors.length > 1
      ? `<label class="lc-shop__field"><span class="lc-label">Character</span><select class="lc-shop__actor">${actors.map(a => `<option value="${a.id}"${a.id === this.actorId ? " selected" : ""}>${esc(a.name)}</option>`).join("")}</select></label>`
      : `<div class="lc-shop__field"><span class="lc-label">Character</span><span class="lc-shop__who">${esc(actor?.name ?? "No character")}</span></div>`;
    const purseField = actor ? `<div class="lc-shop__field lc-shop__field--purse"><span class="lc-label">Purse</span><span class="lc-shop__purse">${esc(formatGold(purse))}</span></div>` : "";

    // The shop-wide reason (closed, no GM, no character) or the wait is said
    // once, in the header's live region; the cards only point at it.
    this.notice = shopNotice(ctx);
    root.innerHTML = shopHTML({
      fields: picker + purseField,
      cards: boxes.length ? boxes.map(b => boxCard(b, pools, ctx)).join("") : `<p class="lc-shop__empty">No crates on the shelf yet. The GM builds them from Game Settings, Loot Crates.</p>`,
      notice: this.notice,
    });
    root.querySelector(".lc-shop__actor")?.addEventListener("change", e => this.#choose(e.currentTarget));
    return root;
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
}
// A held pity line and odds change when the spin lands.
onRelease(() => refreshShop());
