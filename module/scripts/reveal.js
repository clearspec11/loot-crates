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

  "Watch again" (watchAgain, a renderChatMessageHTML hook beside
  sealChatCard): a pull's card carries a display-only snapshot of its strip
  (revealcard.js replaySnapshot), and its button plays that spin again here
  only, in a window titled "Replay: ...". A replay shows no purse and no Open
  item, writes nothing, posts nothing and never seals a chat card. One
  replay window per card: a second press brings the open one forward.
  showReplay is the one way to open a replay window.

  Watch again in the reveal itself: a reveal this client didn't see spin (it
  landed on a hidden page, the page was hidden mid-spin, or Skip was
  pressed) offers Watch again beside Close. It plays the same strip again in
  the same host, through the same #mount as the first spin, display only: it
  leaves `landed`, the chat card's seal and the GM's side alone. While it
  plays the button reads Skip and the result is hidden; on landing the same
  result shows with the sting, and once a replay has run to its end the
  button goes, focus passing to Close if it was on it. Never offered under
  reduced motion (nothing would move) or after a spin that played out here.
*/
import { MODULE_ID, SETTINGS } from "./config.js";
import { mountSpin } from "./spin.js";
import { formatPrice } from "./currency.js";
import { cascadeOffset, canSeePurse, resultHTML, freeSlot, CLOSE_GRACE_MS, replayReveal, replayTitle, replayWindowId, revealActionsHTML } from "./revealcard.js";
import { REFUNDED_CLASS } from "./chatcard.js";
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

const pageHidden = () => document.visibilityState === "hidden";

// The landed promise of each reveal still spinning on this client, by the
// pull's logId (what its chat card carries in flags).
const spinning = new Map();

// Focus is ours to move when nothing else has it, it's already in here, or
// it's still on what opened this window: the buyer's Buy, or the chat card's
// Watch again that opened a replay (`opener`). Enter on either leads to
// Close on landing, and back again on close.
function focusIsFree(root, reveal, opener = null) {
  const a = document.activeElement;
  return !a || a === document.body || a === document.documentElement || root?.contains(a) || (!!reveal && a === ownBuy(reveal)) || (!!opener && a === opener);
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
    actions: { dismiss: CrateReveal.#dismiss, skip: CrateReveal.#skip, openItem: CrateReveal.#openItem, watchAgain: CrateReveal.#watchAgain },
  };

  #resolveLanded;
  #spin = null;
  #slowSound = null;
  #closed = false;
  #landedAt = -Infinity;
  #onHidden = null;
  // True only once a spin has played to its natural end on this client.
  #watched = false;
  #replaying = false;
  // When Watch again last turned into Skip or back.
  #swappedAt = -Infinity;
  landed = new Promise(resolve => { this.#resolveLanded = resolve; });

  constructor(reveal, options = {}) {
    // The first free slot, so a third window doesn't land on the second
    // after the first has closed.
    const slot = freeSlot(usedSlots());
    const position = { height: "auto", ...cascadeOffset(slot, { width: window.innerWidth, height: window.innerHeight }) };
    const id = reveal.replay ? replayWindowId(reveal.replayKey) : reveal.requestId ? `loot-crates-reveal-${reveal.requestId}` : null;
    super({ ...(id ? { id } : {}), position, ...options });
    this.slot = slot;
    this.reveal = reveal;
    // A replay holds no chat card back: the card it came from is whole.
    if (reveal.logId && !reveal.replay) {
      spinning.set(reveal.logId, this.landed);
      this.landed.then(() => spinning.delete(reveal.logId));
    }
  }

  get title() {
    return this.reveal?.replay ? replayTitle(this.reveal) : super.title;
  }

  // Where focus goes back to when a replay closes (its Watch again).
  returnTo = null;

  get canSee() {
    if (this.reveal.replay) return false;
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
  // On Watch again's replay, the second click of a double-click (or a held
  // Enter) on Watch again would land on Skip: ignore it for a moment.
  static #skip(event) {
    if (this.#replaying && (event?.detail > 1 || performance.now() - this.#swappedAt < CLOSE_GRACE_MS)) return;
    this.#spin?.skip();
  }

  static #watchAgain(event, button) {
    if (this.#replaying || this.#closed || this.#watched) return;
    if (event?.detail > 1 || performance.now() - this.#swappedAt < CLOSE_GRACE_MS) return;
    this.#replaying = true;
    this.#swappedAt = performance.now();
    // The same node keeps focus; only its words and action change.
    button.textContent = "Skip";
    button.dataset.action = "skip";
    this.element.querySelector(".lc-reveal__result").hidden = true;
    this.#mount({ replay: true });
  }

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
    const buy = ownBuy(this.reveal) ?? this.returnTo;
    if (buy?.isConnected && focusIsFree(this.element)) buy.focus({ preventScroll: true });
    this.#closed = true;
    clearTimeout(this.#slowSound);
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
      ${revealActionsHTML()}`;
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

  _onRender() { this.#mount(); }

  /*
    Plays the strip in the window's host: the first time (the pull) and on
    Watch again (`replay`). Only the first resolves `landed`, which opens
    this client's sealed chat card; a replay touches nothing outside the
    window.
  */
  #mount({ replay = false } = {}) {
    const root = this.element;
    const host = root.querySelector(".lc-reveal__spin");
    const sound = game.settings.get(MODULE_ID, SETTINGS.SOUND);
    const r = this.reveal;
    this.#stopWatching();
    clearTimeout(this.#slowSound);
    const spin = this.#spin = mountSpin(host, r.strip, {
      onTick: sound ? i => playTick(i / r.strip.landIndex) : null,
      onLand: () => {
        clearTimeout(this.#slowSound);
        this.#stopWatching();
        if (!replay) this.#resolveLanded();
        if (this.#closed) return;
        // Played to its end here: not skipped, not landed hidden, not
        // reduced motion (which lands without moving).
        if (!spin.skipped && !spin.reducedMotion) this.#watched = true;
        if (replay) this.#landReplay(root);
        else this.#landFirst(root, spin);
        if (sound && !pageHidden()) playReveal(r.result.rarity);
      },
    });
    if (pageHidden()) spin.skip();
    else {
      this.#onHidden = () => { if (pageHidden()) spin.skip({ now: true }); };
      document.addEventListener("visibilitychange", this.#onHidden);
    }
    if (sound && !spin.landed && !pageHidden()) this.#slowSound = setTimeout(playSlow, 3600);
    spin.play();
  }

  #landFirst(root, spin) {
    const r = this.reveal;
    const btn = root.querySelector(".lc-reveal__close");
    this.#landedAt = performance.now();
    root.querySelector(".lc-reveal__result").innerHTML = resultHTML(r, { esc, canSee: this.canSee });
    root.querySelector(".lc-reveal__open").hidden = !this.#itemStillThere();
    root.querySelector(".lc-reveal__watch").hidden = this.#watched || spin.reducedMotion;
    btn.dataset.action = "dismiss";
    btn.textContent = "Close";
    if (focusIsFree(root, r, this.returnTo)) btn.focus({ preventScroll: true });
  }

  // The same result again, unhidden rather than rewritten, so a screen
  // reader isn't told it twice. Focus stays where the viewer left it, unless
  // it was on Watch again and Watch again is going.
  #landReplay(root) {
    const watch = root.querySelector(".lc-reveal__watch");
    this.#replaying = false;
    this.#swappedAt = performance.now();
    root.querySelector(".lc-reveal__result").hidden = false;
    if (this.#watched) {
      const had = document.activeElement === watch;
      watch.hidden = true;
      if (had) root.querySelector(".lc-reveal__close").focus({ preventScroll: true });
    } else {
      watch.textContent = "Watch again";
      watch.dataset.action = "watchAgain";
    }
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

/*
  Plays a pull again on this client only, from its stored snapshot. `key`
  names the window (the chat message's id). Resolves to the window, or null
  when the snapshot can't be played. `returnTo` gets focus back on close.
*/
export async function showReplay(snapshot, key, { returnTo = null } = {}) {
  const open = foundry.applications.instances?.get?.(replayWindowId(key));
  if (open && open.state > 0) {
    open.bringToFront?.();
    open.element?.querySelector?.(".lc-reveal__close")?.focus({ preventScroll: true });
    return open;
  }
  const reveal = replayReveal(snapshot, key);
  if (!reveal) return null;
  const app = new CrateReveal(reveal);
  app.returnTo = returnTo;
  await app.render({ force: true });
  return app;
}

// renderChatMessageHTML: a "Watch again" button on a pull's card that
// carries a replay snapshot. None on a refunded card (the win is withdrawn)
// or on a card from before snapshots. Hidden while the card is sealed (its
// spin is still playing here; module.css).
export function watchAgain(message, html) {
  const snapshot = message?.flags?.[MODULE_ID]?.replay;
  const card = snapshot ? html?.querySelector?.(".lc-chat") : null;
  if (!card || card.classList.contains(REFUNDED_CLASS) || card.querySelector(".lc-chat__replay")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "lc-chat__replay";
  btn.textContent = "Watch again";
  btn.setAttribute("aria-label", `Watch again: ${snapshot.actorName ?? ""} opens ${snapshot.box?.name ?? "a crate"}`);
  btn.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    showReplay(snapshot, message.id, { returnTo: btn }).catch(err => console.error("loot-crates | replay failed", err));
  });
  card.append(btn);
}

export async function showReveal(reveal) {
  const app = new CrateReveal(reveal);
  await app.render({ force: true });
  return app;
}
