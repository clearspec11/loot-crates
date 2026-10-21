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
  somewhere else (typing in chat while another player's crate opens). The
  buyer's own Buy for this crate doesn't count as busy: the shop keeps focus
  on the Buy they pressed (boxcard.js patchShop), so their Close still gets
  it, and closing the reveal hands focus back to that Buy.

  A hidden page runs no animation frames, so a spin there would wait, frozen,
  until the viewer came back and then play six seconds the table had already
  seen. A reveal that opens while the page is hidden lands at once (the
  reduced-motion path), and one playing when the page is hidden lands then,
  without a frame: coming back shows the result. Silently, since nobody is
  looking.

  The chat card is posted with the result (socket.js showAndPost), so on a
  client whose spin is still playing it would give the result away seconds
  early. sealChatCard (a renderChatMessageHTML hook, main.js) shows such a
  card's head with "Opening…" in place of the item until this client's
  reveal of that pull lands or is closed. Display only: the message is the
  same for everyone, and a client with no spin playing sees it whole.
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

// The landed promise of each reveal still spinning on this client, by the
// pull's logId (what its chat card carries in flags).
const spinning = new Map();

function focusIsFree(root, reveal) {
  const a = document.activeElement;
  return !a || a === document.body || a === document.documentElement || root?.contains(a) || (!!reveal && a === ownBuy(reveal));
}

// The shop's Buy for this pull's crate, when this client is the buyer.
function ownBuy(reveal) {
  if (!reveal.userId || reveal.userId !== game.user.id || reveal.box?.id == null) return null;
  return [...document.querySelectorAll(".lc-shop .lc-box__buy")].find(b => b.dataset.box === reveal.box.id) ?? null;
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
    if (reveal.logId) {
      spinning.set(reveal.logId, this.landed);
      this.landed.then(() => spinning.delete(reveal.logId));
    }
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
    // Back to the crate they bought, unless they have moved on elsewhere.
    const buy = ownBuy(this.reveal);
    if (buy?.isConnected && focusIsFree(this.element)) buy.focus({ preventScroll: true });
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
        if (focusIsFree(root, r)) btn.focus({ preventScroll: true });
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

// renderChatMessageHTML: seal a pull's card while its spin plays here. Each
// rendered copy (the log, the notification) is opened by its own reference,
// so a copy put in the page after the landing is never left sealed.
export function sealChatCard(message, html) {
  const logId = message?.flags?.[MODULE_ID]?.logId;
  const landed = logId ? spinning.get(logId) : null;
  const card = landed ? html?.querySelector?.(".lc-chat") : null;
  if (!card || card.classList.contains("lc-chat--refunded")) return;
  const sealed = document.createElement("div");
  sealed.className = "lc-chat__sealed";
  sealed.textContent = "Opening…";
  card.classList.add("lc-chat--sealed");
  card.append(sealed);
  landed.then(() => {
    card.classList.remove("lc-chat--sealed");
    sealed.remove();
  });
}

export async function showReveal(reveal) {
  const app = new CrateReveal(reveal);
  await app.render({ force: true });
  return app;
}
