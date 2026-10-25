/*
  The GM's welcome, and the short "What's new" after an update. Words,
  markup and the rule for when each shows; welcomewindow.js is the Foundry
  window and the world setting it keeps.

  - The welcome opens once per world for a GM: what the module does, where
    the shop and the manager are, three first steps, and Add starter
    crates (starter.js), Open the manager, Read the guide.
  - After that, when the module's version is newer than the last one a GM
    saw, "What's new in X" shows the lines of changelog.js once. The same
    version again, or an older one (a downgrade), shows nothing; so does a
    newer one changelog.js has no lines for.
  - Closing either window keeps it closed (the version is marked seen);
    Don't show again turns both off for good. Game Settings, Loot Crates,
    Show the welcome brings the welcome back, and closing it then turns the
    update notes on again.
  - A player never sees either.

  The state is one world record, { seen: "0.14.0" | null, off: false }.
  No Foundry globals: the caller passes the user, the version and the state.
*/
import { LATEST } from "../core/changelog.js";
import { t, onStrings } from "../core/i18n.js";

export let WELCOME_TITLE = "";
export let WELCOME_HEADING = "";
export let QUIET_LABEL = "";
onStrings(() => {
  WELCOME_TITLE = t("LOOTCRATES.Welcome.Title");
  WELCOME_HEADING = t("LOOTCRATES.Welcome.Heading");
  QUIET_LABEL = t("LOOTCRATES.Welcome.Quiet");
});
export const newsHeading = version => t("LOOTCRATES.Welcome.NewsHeading", { version });

// A version's numbers ("0.14.0" → [0, 14, 0]); anything after a number in a
// part ("1.0.0-beta") is ignored, and a part with none counts as 0.
export function parseVersion(v) {
  return String(v ?? "").trim().replace(/^v/i, "").split(".").map(p => {
    const n = parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

// -1, 0 or 1 as `a` is older than, the same as or newer than `b`.
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// The stored state, whatever the setting held (nothing yet, or a record
// written by a later version with more in it).
export function welcomeState(raw) {
  const seen = typeof raw?.seen === "string" && raw.seen.trim() ? raw.seen.trim() : null;
  return { seen, off: raw?.off === true };
}

/*
  Which window a user gets at load: "welcome", "news" or null. Only a GM
  gets either; `asked` (the settings menu) opens the welcome whatever the
  state says.
*/
export function welcomeView({ isGM = false, version, state, asked = false } = {}) {
  if (!isGM) return null;
  if (asked) return "welcome";
  const { seen, off } = welcomeState(state);
  if (off) return null;
  if (!seen) return "welcome";
  return compareVersions(version, seen) > 0 ? "news" : null;
}

/*
  The state once a GM has closed the window: this version is seen (never
  lowered, so a downgrade and back shows nothing twice), and Don't show
  again is what the last close said. Null when nothing needs writing.
*/
export function stateAfterClose({ state, version, quiet = false } = {}) {
  const { seen, off } = welcomeState(state);
  const next = { seen: seen && compareVersions(seen, version) > 0 ? seen : String(version), off: !!quiet };
  return next.seen === seen && next.off === off ? null : next;
}

// The note for an update to `version`: the changelog's entry when it is
// that version, else null (a version with no lines of its own shows
// nothing, rather than an older version's lines under its name).
export function newsFor(version, entry = LATEST) {
  if (!entry?.lines?.length) return null;
  return compareVersions(entry.version, version) === 0 ? entry : null;
}

/*
  The window's content. `view` is "welcome" or "news"; `empty` (no games
  in the world yet) makes Add starter crates the primary action, else Open
  the manager is; Don't show again sits at the end beside the line that
  says what it does. The primary is the window's one gold button and the one
  marked data-primary, which the window focuses. `guideUrl` and
  `changelogUrl` are the README and the changelog on GitHub.
*/
export function welcomeHTML({ view = "welcome", version = LATEST.version, entry = LATEST, empty = false, guideUrl = "", changelogUrl = "", esc = s => String(s ?? "") } = {}) {
  const btn = (action, icon, label, primary) =>
    `<button type="button" class="lc-welcome__btn${primary ? " lc-welcome__primary" : ""}" data-action="${action}"${primary ? " data-primary" : ""}><i class="${icon}" inert></i> ${esc(label)}</button>`;
  const link = (href, icon, label) => href
    ? `<a class="lc-welcome__link" href="${esc(href)}" target="_blank" rel="noopener"><i class="${icon}" inert></i> ${esc(label)}</a>` : "";
  const quiet = `<button type="button" class="lc-welcome__quiet" data-action="welcomeQuiet">${QUIET_LABEL}</button>`;
  if (view === "news") {
    const lines = (entry?.lines ?? []).map(l => `<li>${esc(l)}</li>`).join("");
    return `<section class="lc-welcome" aria-labelledby="lc-welcome-heading">
      <h2 class="lc-welcome__heading" id="lc-welcome-heading">${esc(newsHeading(version))}</h2>
      ${entry?.title ? `<p class="lc-welcome__lede">${esc(entry.title)}.</p>` : ""}
      <div class="lc-welcome__card"><ul class="lc-welcome__list lc-welcome__news">${lines}</ul></div>
      <div class="lc-welcome__actions">
        ${btn("welcomeDone", "fas fa-check", t("LOOTCRATES.Common.Close"), true)}
        ${btn("welcomeManager", "fas fa-screwdriver-wrench", t("LOOTCRATES.Welcome.OpenManager"), false)}
        ${link(changelogUrl, "fas fa-book", t("LOOTCRATES.Welcome.ReadChangelog"))}
      </div>
      <div class="lc-welcome__end">
        <p class="lc-welcome__foot">${t("LOOTCRATES.Welcome.NewsFoot")}</p>
        ${quiet}
      </div>
    </section>`;
  }
  const starter = btn("welcomeStarter", "fas fa-box-open", t("LOOTCRATES.Starter.Label"), empty);
  const manager = btn("welcomeManager", "fas fa-screwdriver-wrench", t("LOOTCRATES.Welcome.OpenManager"), !empty);
  return `<section class="lc-welcome" aria-labelledby="lc-welcome-heading">
      <h2 class="lc-welcome__heading" id="lc-welcome-heading">${WELCOME_HEADING}</h2>
      <p class="lc-welcome__lede">${t("LOOTCRATES.Welcome.Lede")}</p>
      <div class="lc-welcome__card">
      <h3 class="lc-welcome__sub">${t("LOOTCRATES.Welcome.WhereHeading")}</h3>
      <ul class="lc-welcome__list">
        <li>${t("LOOTCRATES.Welcome.WhereShop", { crates: `<strong>${t("LOOTCRATES.Route.Crates")}</strong>` })}</li>
        <li>${t("LOOTCRATES.Welcome.WhereManager", { manage: `<strong>${t("LOOTCRATES.Route.Manage")}</strong>` })}</li>
      </ul>
      <h3 class="lc-welcome__sub">${t("LOOTCRATES.Welcome.StepsHeading")}</h3>
      <ol class="lc-welcome__list lc-welcome__steps">
        <li>${t("LOOTCRATES.Welcome.Step1")}</li>
        <li>${t("LOOTCRATES.Welcome.Step2")}</li>
        <li>${t("LOOTCRATES.Welcome.Step3")}</li>
      </ol>
      </div>
      <div class="lc-welcome__actions">
        ${empty ? starter + manager : manager + starter}
        ${link(guideUrl, "fas fa-book", t("LOOTCRATES.Welcome.ReadGuide"))}
      </div>
      <div class="lc-welcome__end">
        <p class="lc-welcome__foot">${t("LOOTCRATES.Welcome.Foot", { version: esc(version) })}</p>
        ${quiet}
      </div>
    </section>`;
}
