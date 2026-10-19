/*
  The player's Crate Shop: the boxes on offer, what each costs, whether this
  character can afford it, and a Buy button that asks the GM to do the pull.
*/
import { getBoxes, getPools, isShopOpen } from "./store.js";
import { formatGold } from "./currency.js";
import { boxCard } from "./boxcard.js";
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

  get actor() { return game.actors.get(this.actorId) ?? null; }

  static async #buy(_event, target) {
    if (this.busy) return;
    const boxId = target.dataset.box;
    this.busy = true;
    this.busyBox = boxId;
    this.render();
    try {
      await requestPull({ boxId, actorId: this.actorId });
    } catch (err) {
      ui.notifications.warn(err.message);
    } finally {
      this.busy = false;
      this.busyBox = null;
      this.render();
    }
  }

  // A change listener, not a data-action: ApplicationV2 runs actions on click,
  // and re-rendering on the click that opens the list closed it again.
  #pickActor(select) {
    this.actorId = select.value;
    this.render();
  }

  async _renderHTML() {
    const root = document.createElement("div");
    root.className = "lc-shop__body";
    const actor = this.actor;
    const actors = buyableActors();
    const boxes = Object.values(getBoxes());
    const pools = getPools();
    const open = isShopOpen() && !!game.users.activeGM;
    const purse = actor?.system?.currency ?? {};

    const picker = actors.length > 1
      ? `<label class="lc-shop__field"><span class="lc-label">Character</span><select class="lc-shop__actor">${actors.map(a => `<option value="${a.id}"${a.id === this.actorId ? " selected" : ""}>${esc(a.name)}</option>`).join("")}</select></label>`
      : `<div class="lc-shop__field"><span class="lc-label">Character</span><span class="lc-shop__who">${esc(actor?.name ?? "No character")}</span></div>`;

    root.innerHTML = `
      <div class="lc-shop__head">
        ${picker}
        ${actor ? `<div class="lc-shop__field lc-shop__field--purse"><span class="lc-label">Purse</span><span class="lc-shop__purse">${esc(formatGold(purse))}</span></div>` : ""}
        ${open ? "" : `<span class="lc-shop__closed">${game.users.activeGM ? "The GM has closed the shop." : "Closed until a GM is online."}</span>`}
      </div>
      <div class="lc-shop__grid">
        ${boxes.length ? boxes.map(b => this.#boxCard(b, pools, purse, open)).join("") : `<p class="lc-shop__empty">No crates on the shelf yet. The GM builds them from Game Settings, Loot Crates.</p>`}
      </div>`;
    root.querySelector(".lc-shop__actor")?.addEventListener("change", e => this.#pickActor(e.currentTarget));
    return root;
  }

  #boxCard(box, pools, purse, open) {
    return boxCard(box, pools, {
      purse, open, gmOnline: !!game.users.activeGM, hasActor: !!this.actor,
      busy: this.busy, busyBox: this.busyBox, art: `<i class="fas fa-box-open"></i>`, esc,
    });
  }

  _replaceHTML(result, content) { content.replaceChildren(result); }
}

let shop = null;
export function openShop() {
  shop ??= new CrateShop();
  shop.render({ force: true });
  return shop;
}
export function refreshShop() { if (shop?.rendered) shop.render(); }
