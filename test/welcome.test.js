/*
  The GM's welcome and the note after an update (welcome.js), and the
  changelog data it reads (changelog.js): when each shows, what a close
  writes, the words and markup, and that the data matches module.json and
  CHANGELOG.md.
*/
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { compareVersions, parseVersion, welcomeView, welcomeState, stateAfterClose, newsFor, welcomeHTML, WELCOME_HEADING, QUIET_LABEL } from "../module/scripts/welcome.js";
import { LATEST } from "../module/scripts/changelog.js";

const read = p => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("module/module.json"));
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// One load after another for a GM: what shows, then what closing it writes.
function load(state, version, { isGM = true, quiet = false } = {}) {
  const view = welcomeView({ isGM, version, state });
  const next = view ? stateAfterClose({ state, version, quiet }) ?? state : state;
  return { view, state: next };
}

describe("versions", () => {
  it("reads and orders version numbers part by part", () => {
    expect(parseVersion("0.14.0")).toEqual([0, 14, 0]);
    expect(parseVersion("v1.2")).toEqual([1, 2]);
    expect(compareVersions("0.14.0", "0.9.0")).toBe(1);
    expect(compareVersions("0.9.0", "0.14.0")).toBe(-1);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.1", "1.0.0")).toBe(1);
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBe(0);
  });
});

describe("when the welcome shows", () => {
  it("opens the welcome for a GM in a world that has never seen it", () => {
    expect(welcomeView({ isGM: true, version: "0.14.0", state: undefined })).toBe("welcome");
    expect(welcomeView({ isGM: true, version: "0.14.0", state: { seen: null, off: false } })).toBe("welcome");
  });

  it("shows once per world: a close marks the version seen and the next load shows nothing", () => {
    let s = load(undefined, "0.14.0");
    expect(s.view).toBe("welcome");
    expect(s.state).toEqual({ seen: "0.14.0", off: false });
    s = load(s.state, "0.14.0");
    expect(s.view).toBe(null);
    expect(load(s.state, "0.14.0").view).toBe(null);
  });

  it("shows What's new once per newer version, and never on the same version or a downgrade", () => {
    let s = load(undefined, "0.14.0");
    s = load(s.state, "0.15.0");
    expect(s.view).toBe("news");
    expect(s.state).toEqual({ seen: "0.15.0", off: false });
    expect(load(s.state, "0.15.0").view).toBe(null);
    // A downgrade shows nothing and doesn't lower what was seen, so going
    // back up to 0.15.0 shows nothing twice.
    const down = load(s.state, "0.14.0");
    expect(down.view).toBe(null);
    expect(down.state).toEqual({ seen: "0.15.0", off: false });
    expect(load(down.state, "0.15.0").view).toBe(null);
    expect(load(down.state, "0.15.1").view).toBe("news");
    expect(load(down.state, "1.0.0").view).toBe("news");
  });

  it("Don't show again sticks: no welcome and no update notes after it, at any version", () => {
    const first = load(undefined, "0.14.0", { quiet: true });
    expect(first.view).toBe("welcome");
    expect(first.state).toEqual({ seen: "0.14.0", off: true });
    for (const v of ["0.14.0", "0.14.1", "0.15.0", "2.0.0"]) expect(load(first.state, v).view).toBe(null);
    // Pressed on a What's new, the same.
    const news = load({ seen: "0.14.0", off: false }, "0.15.0", { quiet: true });
    expect(news.view).toBe("news");
    expect(load(news.state, "0.16.0").view).toBe(null);
  });

  it("Show the welcome (the settings menu) brings it back, and closing it then turns the notes back on", () => {
    const off = { seen: "0.14.0", off: true };
    expect(welcomeView({ isGM: true, version: "0.14.0", state: off, asked: true })).toBe("welcome");
    const back = stateAfterClose({ state: off, version: "0.14.0" });
    expect(back).toEqual({ seen: "0.14.0", off: false });
    expect(welcomeView({ isGM: true, version: "0.15.0", state: back })).toBe("news");
  });

  it("never shows anything to a player, whatever the state or version, even asked", () => {
    for (const state of [undefined, { seen: null, off: false }, { seen: "0.13.0", off: false }, { seen: "0.14.0", off: true }]) {
      for (const version of ["0.13.0", "0.14.0", "1.0.0"]) {
        expect(welcomeView({ isGM: false, version, state })).toBe(null);
        expect(welcomeView({ isGM: false, version, state, asked: true })).toBe(null);
      }
    }
  });

  it("reads a stored state defensively and writes nothing when a close changes nothing", () => {
    expect(welcomeState(null)).toEqual({ seen: null, off: false });
    expect(welcomeState({ seen: " ", off: "yes" })).toEqual({ seen: null, off: false });
    expect(welcomeState({ seen: "0.14.0", off: true, more: 1 })).toEqual({ seen: "0.14.0", off: true });
    expect(stateAfterClose({ state: { seen: "0.14.0", off: false }, version: "0.14.0" })).toBe(null);
  });
});

describe("the changelog data", () => {
  it("its newest version is module.json's and package.json's", () => {
    expect(LATEST.version).toBe(manifest.version);
    expect(LATEST.version).toBe(JSON.parse(read("package.json")).version);
  });

  it("has three to five plain lines: no emoji, no shouting, nothing empty", () => {
    expect(LATEST.lines.length).toBeGreaterThanOrEqual(3);
    expect(LATEST.lines.length).toBeLessThanOrEqual(5);
    for (const line of LATEST.lines) {
      expect(line.trim().length).toBeGreaterThan(10);
      expect(line).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(line).not.toMatch(/\b[A-Z]{4,}\b/);
    }
  });

  it("matches CHANGELOG.md's newest entry: the same version, and every line one of its bullets", () => {
    const md = read("CHANGELOG.md");
    const heads = [...md.matchAll(/^## (\d+\.\d+\.\d+)\s*$/gm)];
    expect(heads[0]?.[1]).toBe(LATEST.version);
    const start = heads[0].index;
    const end = md.indexOf("\n## ", start + 1);
    const bullets = md.slice(start, end < 0 ? undefined : end).split("\n").filter(l => l.startsWith("- ")).map(l => l.slice(2).trim());
    for (const line of LATEST.lines) expect(bullets).toContain(line);
  });

  it("gives the note for its own version only, never another version's lines under a new name", () => {
    expect(newsFor(LATEST.version)).toBe(LATEST);
    const e = { version: "1.2.0", lines: ["a line here, long enough"] };
    expect(newsFor("1.2.0", e)).toBe(e);
    expect(newsFor("1.2", e)).toBe(e);
    expect(newsFor("1.2.3", e)).toBe(null);
    expect(newsFor("1.1.9", e)).toBe(null);
    expect(newsFor("1.2.0", { version: "1.2.0", lines: [] })).toBe(null);
  });
});

describe("the window's content", () => {
  const html = opts => welcomeHTML({ guideUrl: "https://github.com/x/loot-crates#readme", changelogUrl: "https://github.com/x/loot-crates/blob/main/CHANGELOG.md", esc, ...opts });
  const primaries = s => [...s.matchAll(/<button[^>]*data-primary[^>]*>(?:<i[^>]*><\/i>)?\s*([^<]+)<\/button>/g)].map(m => m[1].trim());

  it("names the window with a heading that the section is labelled by", () => {
    const s = html({ view: "welcome" });
    expect(s).toMatch(/<section class="lc-welcome" aria-labelledby="lc-welcome-heading">/);
    expect(s).toContain(`<h2 class="lc-welcome__heading" id="lc-welcome-heading">${WELCOME_HEADING}</h2>`);
    expect(html({ view: "news", version: "0.14.0" })).toContain(`id="lc-welcome-heading">What&#39;s new in 0.14.0</h2>`);
  });

  it("says where the shop and the manager are and gives three first steps", () => {
    const s = html({ view: "welcome" });
    expect(s).toMatch(/<strong>Crates<\/strong>, at the top of the Items sidebar/);
    expect(s).toMatch(/<strong>Manage crates<\/strong>, beside it/);
    const steps = s.match(/<ol class="lc-welcome__list lc-welcome__steps">([\s\S]*?)<\/ol>/)[1];
    expect(steps.match(/<li>/g)).toHaveLength(3);
  });

  it("makes Add starter crates the primary in an empty world, else Open the manager; one primary either way", () => {
    expect(primaries(html({ view: "welcome", empty: true }))).toEqual(["Add starter crates"]);
    expect(primaries(html({ view: "welcome", empty: false }))).toEqual(["Open the manager"]);
    expect(primaries(html({ view: "news" }))).toEqual(["Close"]);
    for (const s of [html({ view: "welcome", empty: true }), html({ view: "welcome" })]) {
      expect(s).toContain('data-action="welcomeStarter"');
      expect(s).toContain('data-action="welcomeManager"');
      expect(s).toMatch(/<a class="lc-welcome__link" href="https:\/\/github.com\/x\/loot-crates#readme" target="_blank" rel="noopener">.*Read the guide<\/a>/);
    }
  });

  it("lists the changelog's lines on What's new, escaped, with the full changelog a link away", () => {
    const s = html({ view: "news", entry: { version: "0.14.0", title: "A & B", lines: ["One <b>", "Two", "Three"] } });
    expect(s.match(/<li>/g)).toHaveLength(3);
    expect(s).toContain("<li>One &lt;b&gt;</li>");
    expect(s).toContain("A &amp; B.");
    expect(s).toMatch(/href="https:\/\/github.com\/x\/loot-crates\/blob\/main\/CHANGELOG.md"[^>]*>.*Read the full changelog/);
  });

  it("offers Don't show again on both, and says how the welcome comes back", () => {
    for (const s of [html({ view: "welcome" }), html({ view: "news" })]) {
      expect(s).toContain(`data-action="welcomeQuiet">${QUIET_LABEL}</button>`);
      expect(s).toMatch(/Show the welcome, in Game Settings under Loot Crates, brings/);
    }
  });

  it("uses no emoji, no caps kickers, and no ApplicationV2 reserved action", () => {
    for (const s of [html({ view: "welcome" }), html({ view: "welcome", empty: true }), html({ view: "news" })]) {
      const text = s.replace(/<[^>]+>/g, " ");
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(text).not.toMatch(/\b[A-Z]{4,}\b/);
      expect(s).not.toMatch(/data-action="(close|tab|toggleControls)"/);
    }
  });
});
