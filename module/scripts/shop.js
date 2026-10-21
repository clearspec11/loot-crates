/*
  The player's Crate Shop: the boxes on offer, what each costs, whether this
  character can afford it, and a Buy button that asks the GM to do the pull.
*/
import { getBoxes, getPools, isShopOpen } from "./store.js";
import { formatGold } from "./currency.js";
import { boxCard, buyReason, shopHTML, shopNotice, patchShop } from "./boxcard.js";
import { shopOdds } from "./odds.js";
import { requestPull } from "./socket.js";

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

  actorId = buyableActors()[0]?.id ?? null;
  busy = false;
  // The box whose Buy was pressed, so only that card says "Opening…".
  busyBox = null;
  // Why it is taking long, once it is: "gm" or "hidden" (socket.js onWait).
  waiting = null;

  get actor() { return game.actors.get(this.actorId) ?? null; }

  /*
    An unbuyable Buy is aria-disabled, not disabled (it keeps focus), so a
    click or Enter on it still lands here: check again, from fresh data, that
    nothing is out and this crate can be bought now.
  */
  static async #buy(_event, target) {
    if (this.busy) return;
    const boxId = target.dataset.box;
    const box = getBoxes()[boxId];
    if (!box || buyReason(box, shopOdds(box, getPools()), this.#ctx())) return;
    this.busy = true;
    this.busyBox = boxId;
    this.render();
    const onWait = why => {
      if (this.busyBox !== boxId) return;
      this.waiting = why;
      this.render();
    };
    try {
      await requestPull({ boxId, actorId: this.actorId }, { onWait });
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
  #pickActor(select) {
    this.actorId = select.value;
    this.render();
  }

  // What decides whether a crate can be bought, for the cards and for #buy.
  #ctx() {
    const actor = this.actor;
    const gm = !!game.users.activeGM;
    return {
      purse: actor?.system?.currency ?? {}, open: isShopOpen() && gm, gmOnline: gm, hasActor: !!actor,
      busy: this.busy, busyBox: this.busyBox, waiting: this.waiting, art: `<i class="fas fa-box-open"></i>`, esc,
    };
  }

  async _renderHTML() {
    const root = document.createElement("div");
    root.className = "lc-shop__body";
    const actor = this.actor;
    const actors = buyableActors();
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
    root.querySelector(".lc-shop__actor")?.addEventListener("change", e => this.#pickActor(e.currentTarget));
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
