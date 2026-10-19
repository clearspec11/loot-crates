/*
  The player's Crate Shop: the boxes on offer, what each costs, whether this
  character can afford it, and a Buy button that asks the GM to do the pull.
*/
import { RARITY_LABEL } from "./config.js";
import { getBoxes, getPools, isShopOpen } from "./store.js";
import { oddsTable } from "./odds.js";
import { canAfford, formatPrice, toCopper } from "./currency.js";
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
    actions: { buy: CrateShop.#buy, pickActor: CrateShop.#pickActor },
  };

  actorId = buyableActors()[0]?.id ?? null;
  busy = false;

  get actor() { return game.actors.get(this.actorId) ?? null; }

  static async #buy(_event, target) {
    if (this.busy) return;
    const boxId = target.dataset.box;
    this.busy = true;
    this.render();
    try {
      await requestPull({ boxId, actorId: this.actorId });
    } catch (err) {
      ui.notifications.warn(err.message);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  static #pickActor(_event, target) {
    this.actorId = target.value;
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
      ? `<select data-action="pickActor" data-change="pickActor">${actors.map(a => `<option value="${a.id}"${a.id === this.actorId ? " selected" : ""}>${esc(a.name)}</option>`).join("")}</select>`
      : `<span class="lc-shop__who">${esc(actor?.name ?? "No character")}</span>`;

    root.innerHTML = `
      <div class="lc-shop__head">
        ${picker}
        <span class="lc-shop__purse" title="Your coins, as gold">${actor ? esc((toCopper(purse) / 100).toFixed(toCopper(purse) % 100 ? 2 : 0)) + " gp" : ""}</span>
        ${open ? "" : `<span class="lc-shop__closed">${game.users.activeGM ? "The GM has closed the shop." : "Closed until a GM is online."}</span>`}
      </div>
      <div class="lc-shop__grid">
        ${boxes.length ? boxes.map(b => this.#boxCard(b, pools, purse, open)).join("") : `<p class="lc-shop__empty">No crates on the shelf yet. The GM builds them from Game Settings, Loot Crates.</p>`}
      </div>`;
    root.querySelector("select[data-change]")?.addEventListener("change", e => CrateShop.#pickActor.call(this, e, e.currentTarget));
    return root;
  }

  #boxCard(box, pools, purse, open) {
    const odds = oddsTable(box, pools);
    const afford = this.actor && canAfford(purse, box.price);
    const soldOut = box.rules?.stock != null && box.rules.stock <= 0;
    const top = odds.length ? odds[odds.length - 1].rarity : "common";
    const reasons = [!open && "closed", soldOut && "sold out", !this.actor && "no character", this.actor && !afford && "can't afford"].filter(Boolean);
    return `
      <div class="lc-box lc-rarity-${esc(top)}">
        <div class="lc-box__art"><i class="fas fa-box-open"></i></div>
        <div class="lc-box__name">${esc(box.name)}</div>
        <div class="lc-box__odds">${odds.map(o => `<span class="lc-odd lc-rarity-${o.rarity}" title="${esc(RARITY_LABEL[o.rarity])}">${Math.round(o.chance * 100)}%</span>`).join("")}</div>
        ${box.rules?.stock != null ? `<div class="lc-box__stock">${box.rules.stock} left</div>` : ""}
        <button type="button" class="lc-box__buy" data-action="buy" data-box="${esc(box.id)}" ${reasons.length || this.busy ? "disabled" : ""} title="${esc(reasons.join(", "))}">
          ${this.busy ? "Opening…" : `Open for ${esc(formatPrice(box.price))}`}
        </button>
      </div>`;
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
