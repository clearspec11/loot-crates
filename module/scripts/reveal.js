/*
  The window that plays the spin. Opens on every client when a reveal is
  broadcast, so the whole table watches the pull.

  One window per pull: the id carries the requestId, so two players buying
  within a few seconds of each other get two windows, cascaded 32px apart
  (revealcard.js cascadeOffset) rather than stacked exactly on top of each
  other. `landed` resolves when the result card is under the marker (or the
  window is closed early).

  _onRender starts the spin and does not wait for it: Foundry v14 awaits
  _onRender and only then applies the window's position, so awaiting the
  spin there played all six seconds in an unplaced window in the top-left
  corner and jumped it to the centre on landing.

  The one button reads Skip during the spin and Close once landed, so a
  keyboard or screen-reader user is never stuck behind six seconds of
  animation. On landing, focus moves to it, unless the viewer is busy
  somewhere else (typing in chat while another player's crate opens).

  A hidden page runs no animation frames, so a spin there would wait, frozen,
  until the viewer came back and then play six seconds the table had already
  seen. A reveal that opens while the page is hidden lands at once (the
  reduced-motion path), and one playing when the page is hidden lands then,
  without a frame: coming back shows the result. Silently, since nobody is
  looking.
*/
import { MODULE_ID, SETTINGS } from "./config.js";
import { mountSpin } from "./spin.js";
import { formatPrice } from "./currency.js";
import { cascadeOffset, canSeePurse, resultHTML, freeSlot, CLOSE_GRACE_MS } from "./revealcard.js";
import { oddsRibbon } from "./boxcard.js";
import { playTick, playSlow, playReveal } from "./sound.js";

const { ApplicationV2 } = foundry.applications.api;
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));

// The cascade slots of reveal windows already open or opening, found by
// class rather than id (the id carries the requestId).
function usedSlots() {
  const apps = foundry.applications.instances?.values?.() ?? [];
  return [...apps].filter(app => app.options?.classes?.includes("lc-reveal") && app.state > 0).map(app => app.slot);
}

// Focus is ours to move when nothing else has it, or it's already in here.
const pageHidden = () => document.visibilityState === "hidden";

function focusIsFree(root) {
  const a = document.activeElement;
  return !a || a === document.body || a === document.documentElement || root.contains(a);
}

export class CrateReveal extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "loot-crates-reveal-{id}",
    classes: ["loot-crates", "lc-reveal"],
    window: { title: "Opening a crate", resizable: false },
    position: { width: 720, height: "auto" },
    actions: { dismiss: CrateReveal.#dismiss, skip: CrateReveal.#skip, openItem: CrateReveal.#openItem },
  };

  #resolveLanded;
  #spin = null;
  #slowTimer = null;
  #closed = false;
  #landedAt = -Infinity;
  #onHidden = null;
  landed = new Promise(resolve => { this.#resolveLanded = resolve; });

  constructor(reveal, options = {}) {
    // The first free slot, so a third window doesn't land on the second
    // after the first has closed.
    const slot = freeSlot(usedSlots());
    const position = { height: "auto", ...cascadeOffset(slot, { width: window.innerWidth, height: window.innerHeight }) };
    super({ ...(reveal.requestId ? { id: `loot-crates-reveal-${reveal.requestId}` } : {}), position, ...options });
    this.slot = slot;
    this.reveal = reveal;
  }

  get canSee() {
    return canSeePurse(this.reveal, { isGM: game.user.isGM, userId: game.user.id });
  }

  // Skip turns into Close on the next frame, so the second click of a
  // double-click on Skip (or a held Enter) would close the window before the
  // result was seen: ignore Close for a moment after landing. The action is
  // "dismiss" because ApplicationV2 handles a data-action of "close" itself,
  // before any handler here would run.
  static #dismiss(event) {
    if (event?.detail > 1 || performance.now() - this.#landedAt < CLOSE_GRACE_MS) return;
    this.close();
  }
  static #skip() { this.#spin?.skip(); }

  static async #openItem(_event, button) {
    const item = this.reveal.itemUuid ? await fromUuid(this.reveal.itemUuid).catch(() => null) : null;
    if (!item) {
      button.hidden = true;
      ui.notifications.warn(`${this.reveal.result.name} is no longer in ${this.reveal.actorName}'s inventory.`);
      return;
    }
    item.sheet.render(true);
  }

  _onClose(options) {
    super._onClose(options);
    this.#closed = true;
    clearTimeout(this.#slowTimer);
    this.#stopWatching();
    // End the loop now rather than animating a detached strip for seconds.
    this.#spin?.skip();
    this.#resolveLanded();
  }

  async _renderHTML() {
    const r = this.reveal;
    const root = document.createElement("div");
    root.className = "lc-reveal__body";
    root.innerHTML = `
      <div class="lc-reveal__head">
        <span class="lc-reveal__who">${esc(r.actorName)}</span> opens
        <strong class="lc-reveal__crate">${esc(r.box.name)}</strong>
        <span class="lc-reveal__price">${esc(formatPrice(r.box.price))}</span>
      </div>
      <div class="lc-vault lc-rarity-${esc(r.result.rarity)}">
        ${r.odds?.length ? oddsRibbon(r.odds) : ""}
        <div class="lc-reveal__spin"></div>
        <div class="lc-reveal__result lc-rarity-${esc(r.result.rarity)}" aria-live="polite"></div>
      </div>
      <div class="lc-reveal__actions">
        <button type="button" class="lc-reveal__open" data-action="openItem" hidden>Open item</button>
        <button type="button" class="lc-reveal__close" data-action="skip">Skip</button>
      </div>`;
    return root;
  }

  _replaceHTML(result, content) { content.replaceChildren(result); }

  // Shown only to the buyer and GMs, and only while the item is still there.
  #itemStillThere() {
    if (!this.canSee || !this.reveal.itemUuid) return false;
    try { return !!fromUuidSync(this.reveal.itemUuid); } catch { return false; }
  }

  #stopWatching() {
    if (this.#onHidden) document.removeEventListener("visibilitychange", this.#onHidden);
    this.#onHidden = null;
  }

  _onRender() {
    const root = this.element;
    const host = root.querySelector(".lc-reveal__spin");
    const out = root.querySelector(".lc-reveal__result");
    const btn = root.querySelector(".lc-reveal__close");
    const open = root.querySelector(".lc-reveal__open");
    const sound = game.settings.get(MODULE_ID, SETTINGS.SOUND);
    const r = this.reveal;
    this.#spin = mountSpin(host, r.strip, {
      onTick: sound ? i => playTick(i / r.strip.landIndex) : null,
      onLand: () => {
        clearTimeout(this.#slowTimer);
        this.#stopWatching();
        this.#resolveLanded();
        if (this.#closed) return;
        this.#landedAt = performance.now();
        out.innerHTML = resultHTML(r, { esc, canSee: this.canSee });
        open.hidden = !this.#itemStillThere();
        btn.dataset.action = "dismiss";
        btn.textContent = "Close";
        if (focusIsFree(root)) btn.focus({ preventScroll: true });
        if (sound && !pageHidden()) playReveal(r.result.rarity);
      },
    });
    if (pageHidden()) this.#spin.skip();
    else {
      this.#onHidden = () => { if (pageHidden()) this.#spin?.skip({ now: true }); };
      document.addEventListener("visibilitychange", this.#onHidden);
    }
    if (sound && !this.#spin.landed && !pageHidden()) this.#slowTimer = setTimeout(playSlow, 3600);
    this.#spin.play();
  }
}

export async function showReveal(reveal) {
  const app = new CrateReveal(reveal);
  await app.render({ force: true });
  return app;
}
