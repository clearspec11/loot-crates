/*
  Release readiness: the README and the docs link only to files that exist
  (GitHub renders relative paths from each file's own folder), the
  screenshots are small and never shipped, module.json's store fields are
  well formed, the changelog has an entry for every release tag, and the zip
  holds only what package-files.mjs allows.
*/
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { shippable } from "../tools/package-files.mjs";
import { scriptFiles } from "./scripts.js";
import { STARTER_PACKS } from "../module/scripts/views/starter.js";

const root = path.resolve(import.meta.dirname, "..");
const read = f => readFileSync(path.join(root, f), "utf8");
const manifest = JSON.parse(read("module/module.json"));
const RAW = "https://raw.githubusercontent.com/clearspec11/loot-crates/main/";
const DOCS = ["README.md", "CHANGELOG.md", "CLAUDE.md", "PRODUCT.md", "docs/ARCHITECTURE.md", "docs/DESIGN.md", "docs/RELEASE.md", "docs/COMPATIBILITY.md", "foundry-dev/README.md"];

// GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens.
const slug = text => text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/g, "-");

// Every [text](target) and ![alt](target) outside fenced code blocks.
function links(md) {
  const prose = md.replace(/^```[\s\S]*?^```/gm, "");
  return [...prose.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map(m => ({ image: m[0].startsWith("!"), target: m[1] }));
}
const headings = md => md.replace(/^```[\s\S]*?^```/gm, "").split("\n").filter(l => /^#{1,6} /.test(l)).map(l => slug(l.replace(/^#+ /, "")));

// The relative targets in md (as if it were the file doc) that point nowhere.
function broken(doc, md) {
  const out = [];
  for (const { target } of links(md)) {
    if (/^(https?:|mailto:)/.test(target)) continue;
    const [file, anchor] = target.split("#");
    const resolved = file ? path.join(path.dirname(path.join(root, doc)), decodeURI(file)) : null;
    if (resolved && !existsSync(resolved)) { out.push(target); continue; }
    const targetMd = resolved ? (resolved.endsWith(".md") ? readFileSync(resolved, "utf8") : null) : md;
    if (anchor && targetMd !== null && !headings(targetMd).includes(anchor)) out.push(target);
  }
  return out;
}

describe("the docs' links", () => {
  for (const doc of DOCS) {
    it(`${doc}: every relative link and image resolves`, () => {
      expect(broken(doc, read(doc))).toEqual([]);
    });
  }

  it("the link checker itself catches a missing file and a missing anchor, and skips code blocks", () => {
    const md = "# Here\n[a](docs/nope.md) ![b](docs/images/nope.webp) [c](#nowhere) [d](#here) [e](docs/DESIGN.md) [f](CHANGELOG.md#unreleased) [g](README.md#nope)\n```\n[h](skip.md)\n```\n";
    expect(broken("README.md", md)).toEqual(["docs/nope.md", "docs/images/nope.webp", "#nowhere", "README.md#nope"]);
    expect(broken("docs/RELEASE.md", "[x](../CHANGELOG.md) [y](CHANGELOG.md)")).toEqual(["CHANGELOG.md"]);
    expect(slug("Dragon's Teeth")).toBe("dragons-teeth");
    expect(slug("Stock limits and the shelf")).toBe("stock-limits-and-the-shelf");
  });
});

describe("the README", () => {
  const md = read("README.md");

  it("gives the manifest URL module.json publishes, and the install steps", () => {
    expect(manifest.manifest).toBe("https://github.com/clearspec11/loot-crates/releases/latest/download/module.json");
    expect(md).toContain(manifest.manifest);
    for (const h of ["install", "quick-start-for-the-gm", "starter-crates", "the-games", "stock-limits-and-the-shelf", "what-players-see", "faq", "for-developers"]) {
      expect(headings(md)).toContain(h);
    }
  });

  it("names the Foundry and dnd5e versions module.json declares", () => {
    expect(md).toContain(`v${manifest.compatibility.minimum}`);
    expect(md).toContain(`v${manifest.compatibility.verified}`);
    expect(md).toContain(manifest.relationships.systems[0].compatibility.verified);
  });

  it("shows a screenshot for the shop, the manager and each of the six games, every one with alt text", () => {
    const images = links(md).filter(l => l.image).map(l => l.target);
    for (const name of ["shop", "manager-boxes", "crate-landed", "wishing-well", "dragons-teeth", "deck", "roulette", "auction"]) {
      expect(images).toContain(`docs/images/${name}.webp`);
    }
    expect(md).not.toMatch(/!\[\]\(/);
  });

  it("has no emoji", () => {
    expect(md).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe("the screenshots", () => {
  const dir = path.join(root, "docs/images");
  const files = readdirSync(dir);

  it("are each under 250 KB, and each one is used", () => {
    const used = DOCS.map(read).join("\n") + JSON.stringify(manifest.media);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(statSync(path.join(dir, f)).size, f).toBeLessThan(250 * 1024);
      expect(used, f).toContain(`docs/images/${f}`);
    }
  });

  it("are never shipped in the zip", () => {
    for (const f of files) expect(shippable(`docs/images/${f}`)).toBe(false);
  });
});

describe("module.json's store fields", () => {
  const url = s => { try { return new URL(s); } catch { return null; } };

  it("links the issues, the README and the changelog on main", () => {
    expect(manifest.bugs).toBe("https://github.com/clearspec11/loot-crates/issues");
    expect(manifest.readme).toBe(`${RAW}README.md`);
    expect(manifest.changelog).toBe(`${RAW}CHANGELOG.md`);
    for (const k of ["url", "bugs", "readme", "changelog", "manifest", "download"]) expect(url(manifest[k])?.protocol, k).toBe("https:");
  });

  it("lists three to five screenshots, each a raw URL on main for a file in docs/images, with a caption", () => {
    expect(manifest.media.length).toBeGreaterThanOrEqual(3);
    expect(manifest.media.length).toBeLessThanOrEqual(5);
    for (const m of manifest.media) {
      expect(m.type).toBe("screenshot");
      expect(url(m.url)?.protocol).toBe("https:");
      expect(m.url.startsWith(`${RAW}docs/images/`)).toBe(true);
      expect(existsSync(path.join(root, m.url.slice(RAW.length)))).toBe(true);
      expect(m.caption.length).toBeGreaterThan(10);
    }
  });

  it("names the author and ships under the MIT license", () => {
    expect(manifest.authors).toEqual([{ name: "clearspec11", url: "https://github.com/clearspec11" }]);
    expect(manifest.license).toBe("LICENSE");
    const license = read("LICENSE");
    expect(license).toMatch(/^MIT License/);
    expect(license).toMatch(/Copyright \(c\) 2026 clearspec11/);
    expect(read("tools/build.mjs")).toMatch(/"LICENSE"/);
  });
});

describe("the changelog", () => {
  const md = read("CHANGELOG.md");
  const versions = [...md.matchAll(/^## (\d+\.\d+\.\d+)\s*$/gm)].map(m => m[1]);
  const cmp = (a, b) => { const [x, y] = [a, b].map(v => v.split(".").map(Number)); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };

  it("starts with Unreleased, then every version newest first, ending at the first release", () => {
    expect(md.indexOf("## Unreleased")).toBeGreaterThan(0);
    expect(md.indexOf("## Unreleased")).toBeLessThan(md.indexOf(`## ${versions[0]}`));
    expect(versions[0]).toBe(manifest.version);
    expect([...versions].sort((a, b) => cmp(b, a))).toEqual(versions);
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions.at(-1)).toBe("0.3.0");
  });

  it("has an entry for every release tag in the repository", () => {
    let tags = [];
    try { tags = execFileSync("git", ["tag", "--list", "v*"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean); } catch { /* no git: nothing to compare */ }
    for (const tag of tags) expect(versions, tag).toContain(tag.replace(/^v/, ""));
  });

  it("gives every entry at least one bullet", () => {
    const entries = md.split(/^## /m).slice(1);
    for (const e of entries) expect(e.split("\n").some(l => l.startsWith("- ")), e.split("\n")[0]).toBe(true);
  });
});

describe("the package", () => {
  it("allows only the manifest, scripts, styles and translations", () => {
    for (const ok of ["module.json", "scripts/main.js", "styles/module.css", "lang/en.json"]) expect(shippable(ok), ok).toBe(true);
    for (const no of ["README.md", "docs/images/shop.webp", "scripts/notes.md", "scripts/.DS_Store", "styles/module.css.map", "test/x.test.js", "scripts/sub/dir.js", ".git/config"]) {
      expect(shippable(no), no).toBe(false);
    }
  });

  it("module/ holds nothing else, so the zip ships nothing else", () => {
    const walk = dir => readdirSync(path.join(root, "module", dir), { withFileTypes: true })
      .flatMap(e => e.isDirectory() ? walk(path.posix.join(dir, e.name)) : [path.posix.join(dir, e.name)]);
    const files = walk("");
    expect(files).toContain("module.json");
    expect(files.filter(f => !shippable(f))).toEqual([]);
  });
});

describe("docs/COMPATIBILITY.md", () => {
  const md = read("docs/COMPATIBILITY.md");
  const system = manifest.relationships.systems[0];
  // A row of a two-column table: "| Name | first | second |".
  const row = (text, name) => text.match(new RegExp(`^\\| ${name} \\| ([^|]+?) \\| ([^|]+?) \\|$`, "m"));

  it("states the minimums and verified versions module.json declares", () => {
    expect(system.id).toBe("dnd5e");
    const foundry = row(md, "Foundry VTT"), dnd5e = row(md, "D&D 5e system");
    expect(foundry?.[1]).toBe(manifest.compatibility.minimum);
    expect(foundry?.[2].split(" ")[0]).toBe(manifest.compatibility.verified);
    expect(dnd5e?.[1]).toBe(system.compatibility.minimum);
    expect(dnd5e?.[2]).toBe(system.compatibility.verified);
  });

  it("matches the README's table", () => {
    const readme = read("README.md");
    const foundry = row(readme, "Foundry VTT"), dnd5e = row(readme, "D&D 5e system");
    expect(foundry?.[1]).toContain(`v${manifest.compatibility.minimum} `);
    expect(foundry?.[1]).toContain(`v${manifest.compatibility.verified}`);
    expect(dnd5e?.[1].startsWith(`${system.compatibility.minimum} `)).toBe(true);
    expect(dnd5e?.[2]).toBe(system.compatibility.verified);
    expect(readme).toContain("(docs/COMPATIBILITY.md)");
  });

  // What the scripts use, read from their source.
  const src = scriptFiles().map(s => s.src).join("\n");
  const uses = re => [...new Set([...src.matchAll(re)].map(m => (m[1] ?? m[0]).replace(/\?/g, "")))];
  const hooks = uses(/\b[Hh]ooks\.(?:on|once)\(\s*"([^"]+)"/g);
  const paths = uses(/\bfoundry(?:\??\.[A-Za-z_$][\w$]*)+/g);
  const fields = uses(/\bsystem\.(?!json\b)[a-z]\w*(?:\.[a-z]\w*)?/g);

  it("finds the hooks, foundry paths and dnd5e fields the scripts use", () => {
    expect(hooks).toEqual(expect.arrayContaining(["init", "ready", "renderItemDirectory", "getRollTableContextOptions", "renderChatMessageHTML", "createItem", "dnd5e.restCompleted", "updateActor"]));
    expect(paths).toEqual(expect.arrayContaining(["foundry.applications.api", "foundry.utils.escapeHTML"]));
    expect(fields).toEqual(expect.arrayContaining(["system.rarity", "system.rarities", "system.currency", "system.type.value"]));
  });

  it("names every hook, foundry path, dnd5e field and starter pack the scripts use", () => {
    expect(hooks.filter(h => !md.includes(`\`${h}\``))).toEqual([]);
    expect(paths.filter(p => !md.includes(p))).toEqual([]);
    expect(fields.filter(f => !md.includes(`\`${f}\``))).toEqual([]);
    expect(STARTER_PACKS.map(p => `dnd5e.${p.name}`).filter(id => !md.includes(`\`${id}\``))).toEqual([]);
  });

  it("names every game.i18n call the scripts make (the module's words, i18n.js)", () => {
    const i18n = uses(/\bgame\.i18n\.[a-z]\w*/g);
    expect(i18n).toEqual(expect.arrayContaining(["game.i18n.has", "game.i18n.format", "game.i18n.localize"]));
    expect(i18n.filter(call => !md.includes(`\`${call}\``))).toEqual([]);
  });
});
