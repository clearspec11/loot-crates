/*
  The window that plays the spin. Opens on every client when a reveal is
  broadcast, so the whole table watches the pull.

  One window per pull: the id carries the requestId, so two players buying
  within a few seconds of each other get two windows side by side rather than
  the second render replacing the first mid-spin. `landed` resolves when the
  result card is under the marker (or the window is closed early), which is
  what the chat card waits for; `render` itself resolves after the spin on
  Foundry v14, which awaits _onRender, so callers that must not block use
  `landed` rather than the render.
*/
import { MODULE_ID, RARITY_LABEL, SETTINGS } from "./config.js";
import { mountSpin } from "./spin.js";
import { formatPrice } from "./currency.js";
import { playTick, playSlow, playReveal } from "./sound.js";

const { ApplicationV2 } = foundry.applications.api;

export class CrateReveal extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "loot-crates-reveal-{id}",
    classes: ["loot-crates", "lc-reveal"],
    window: { title: "Opening a crate", resizable: false },
    position: { width: 720, height: "auto" },
    actions: { close: CrateReveal.#close },
  };

  #resolveLanded;
  landed = new Promise(resolve => { this.#resolveLanded = resolve; });

  constructor(reveal, options = {}) {
    super(reveal.requestId ? { id: `loot-crates-reveal-${reveal.requestId}`, ...options } : options);
    this.reveal = reveal;
  }

  static #close() { this.close(); }

  _onClose(options) {
    super._onClose(options);
    this.#resolveLanded();
  }

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
        this.#resolveLanded();
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
