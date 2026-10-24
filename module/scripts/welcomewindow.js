/*
  The GM's welcome window, and "What's new" after an update (welcome.js has
  the words and the rule for when each shows). Foundry-side: the world
  setting that remembers the last version a GM saw and Don't show again,
  the settings menu that opens the welcome again, and the check at load.

  Closing the window in any way (its buttons, the title bar's close,
  Escape) marks this version seen; Don't show again also turns both off.
  Add starter crates and Open the manager close it first, then do that.
*/
import { MODULE_ID, SETTINGS } from "./config.js";
import { getBoxes } from "./store.js";
import { openManager, addStarterCrates } from "./manager.js";
import { WELCOME_TITLE, MENU_LABEL, welcomeView, welcomeState, stateAfterClose, newsFor, welcomeHTML } from "./welcome.js";

const { ApplicationV2 } = foundry.applications.api;
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
const moduleOf = () => game.modules.get(MODULE_ID);
const versionNow = () => moduleOf()?.version ?? "0.0.0";
const readState = () => welcomeState(game.settings.get(MODULE_ID, SETTINGS.WELCOME));

async function writeState(next) {
  if (!next) return;
  try { await game.settings.set(MODULE_ID, SETTINGS.WELCOME, next); }
  catch (err) { console.error("loot-crates | saving the welcome's state failed", err); }
}

export class WelcomeWindow extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "loot-crates-welcome",
    classes: ["loot-crates", "lc-welcome-window"],
    window: { title: WELCOME_TITLE, icon: "fas fa-box-open", resizable: false },
    position: { width: 540, height: "auto" },
    actions: {
      welcomeStarter: WelcomeWindow.#starter, welcomeManager: WelcomeWindow.#manager,
      welcomeDone: WelcomeWindow.#done, welcomeQuiet: WelcomeWindow.#quietly,
    },
  };

  // "welcome" or "news".
  view = "welcome";
  // Don't show again was pressed: the close that follows says so.
  #quiet = false;
  // The write the last close made, for a caller that needs it done.
  saved = Promise.resolve();

  async _renderHTML() {
    const root = document.createElement("div");
    const url = moduleOf()?.url ?? "";
    root.innerHTML = welcomeHTML({
      view: this.view, version: versionNow(), entry: newsFor(versionNow()) ?? undefined,
      empty: !Object.keys(getBoxes()).length,
      guideUrl: url ? `${url}#readme` : "", changelogUrl: url ? `${url}/blob/main/CHANGELOG.md` : "", esc,
    });
    return root.children[0];
  }

  _replaceHTML(result, content) { content.replaceChildren(result); }

  // The primary action takes focus, so Enter does the likely thing and Tab
  // walks the rest; Escape closes (Foundry's dismiss key).
  _onRender(context, options) {
    super._onRender?.(context, options);
    this.#quiet = false;
    requestAnimationFrame(() => this.element?.querySelector("[data-primary]")?.focus({ preventScroll: true }));
  }

  _onClose(options) {
    this.saved = writeState(stateAfterClose({ state: readState(), version: versionNow(), quiet: this.#quiet }));
    this.#quiet = false;
    return super._onClose?.(options);
  }

  static async #starter() {
    await this.close();
    try { await addStarterCrates(); } catch (err) { console.error("loot-crates | adding the starter crates failed", err); }
  }
  static async #manager() {
    await this.close();
    openManager();
  }
  static #done() { return this.close(); }
  static #quietly() {
    this.#quiet = true;
    return this.close();
  }
}

let win = null;
// Opens (or brings forward) the one welcome window on `view`.
export function openWelcome(view = "welcome") {
  if (!game.user?.isGM) return null;
  win ??= new WelcomeWindow();
  win.view = view;
  win.render({ force: true });
  return win;
}

// Game Settings, Loot Crates, Show the welcome: Foundry builds this and
// renders it; it opens the one welcome window instead.
export class WelcomeMenu extends ApplicationV2 {
  render() { return openWelcome("welcome"); }
}

export function registerWelcome() {
  game.settings.register(MODULE_ID, SETTINGS.WELCOME, { scope: "world", config: false, type: Object, default: { seen: null, off: false } });
  game.settings.registerMenu(MODULE_ID, "welcomeMenu", {
    name: "Welcome",
    label: MENU_LABEL,
    hint: "Where the shop and the manager are, and the first steps. Closing it turns the short notes after each update back on.",
    icon: "fas fa-circle-info",
    type: WelcomeMenu,
    restricted: true,
  });
}

/*
  At load (main.js, ready): a GM gets the welcome once per world, then the
  note once per newer version. An update with no lines of its own marks
  the version seen and shows nothing. A player gets nothing.
*/
export function welcomeAtLoad() {
  const isGM = !!game.user?.isGM;
  const version = versionNow();
  const view = welcomeView({ isGM, version, state: readState() });
  if (!view) return null;
  if (view === "news" && !newsFor(version)) {
    writeState(stateAfterClose({ state: readState(), version }));
    return null;
  }
  return openWelcome(view);
}
