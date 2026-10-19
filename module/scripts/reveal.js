/*
  The window that plays the spin. Opens on every client when a reveal is
  broadcast, so the whole table watches the pull.
*/
import { MODULE_ID, RARITY_LABEL, SETTINGS } from "./config.js";
import { mountSpin } from "./spin.js";
import { formatPrice } from "./currency.js";
import { playTick, playSlow, playReveal } from "./sound.js";

const { ApplicationV2 } = foundry.applications.api;

export class CrateReveal extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "loot-crates-reveal",
    classes: ["loot-crates", "lc-reveal"],
    window: { title: "Opening a crate", resizable: false },
    position: { width: 720, height: "auto" },
    actions: { close: CrateReveal.#close },
  };

  constructor(reveal, options = {}) {
    super(options);
    this.reveal = reveal;
  }

  static #close() { this.close(); }

  async _renderHTML() {
    const r = this.reveal;
    const root = document.createElement("div");
    root.className = "lc-reveal__body";
    root.innerHTML = `
      <div class="lc-reveal__head">
        <span class="lc-reveal__who">${foundry.utils.escapeHTML(r.actorName)}</span> opens
        <strong>${foundry.utils.escapeHTML(r.box.name)}</strong>
        <span class="lc-reveal__price">${foundry.utils.escapeHTML(formatPrice(r.box.price))}</span>
      </div>
      <div class="lc-reveal__spin"></div>
      <div class="lc-reveal__result" aria-live="polite"></div>
      <div class="lc-reveal__actions"><button type="button" data-action="close" disabled>Close</button></div>`;
    return root;
  }

  _replaceHTML(result, content) { content.replaceChildren(result); }

  async _onRender() {
    const root = this.element;
    const host = root.querySelector(".lc-reveal__spin");
    const out = root.querySelector(".lc-reveal__result");
    const btn = root.querySelector("[data-action=close]");
    const sound = game.settings.get(MODULE_ID, SETTINGS.SOUND);
    const r = this.reveal;
    const spin = mountSpin(host, r.strip, {
      onTick: sound ? i => playTick(i / r.strip.landIndex) : null,
      onLand: () => {
        out.innerHTML = `<div class="lc-reveal__name">${foundry.utils.escapeHTML(r.result.name)}</div><div class="lc-reveal__rarity">${RARITY_LABEL[r.result.rarity] ?? r.result.rarity}${r.result.pity ? " · pity" : ""}</div>`;
        btn.disabled = false;
        if (sound) playReveal(r.result.rarity);
      },
    });
    if (sound) setTimeout(playSlow, 3600);
    await spin.play();
  }
}

export async function showReveal(reveal) {
  const app = new CrateReveal(reveal);
  await app.render({ force: true });
  return app;
}
