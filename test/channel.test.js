/*
  The dev channel (tools/lib/channel.mjs): dev versions count up and stay
  newer than the release they build on, the way Foundry compares them, and
  a dev manifest points its updates at the dev release, never at latest.
*/
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DEV_MANIFEST, nextDevVersion, devManifest } from "../tools/lib/channel.mjs";

const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(path.join(root, "module/module.json"), "utf8"));

// Foundry v14's foundry.utils.isNewerVersion, as read from /scripts/foundry.mjs.
function isNewerVersion(v1, v0) {
  const a = String(v1).split("."), b = String(v0).split(".");
  const num = s => s !== "" && Number.isFinite(Number(s));
  for (const [i, p1] of a.entries()) {
    const p0 = b[i];
    if (p0 === undefined) return true;
    if (num(p0) && num(p1) && Number(p1) !== Number(p0)) return Number(p1) > Number(p0);
    if (p1 !== p0) return p1 > p0;
  }
  if (b.length > a.length) return false;
  return a.join(".") !== b.join(".");
}

describe("dev versions", () => {
  it("start at 1 for a new branch version and count up for the same one", () => {
    expect(nextDevVersion("1.2.0", null)).toBe("1.2.0-dev.1");
    expect(nextDevVersion("1.2.0", "1.1.0-dev.4")).toBe("1.2.0-dev.1");
    expect(nextDevVersion("1.2.0", "1.2.0-dev.1")).toBe("1.2.0-dev.2");
    expect(nextDevVersion("1.2.0", "1.2.0-dev.9")).toBe("1.2.0-dev.10");
  });

  it("are newer, to Foundry, than the release before and than the last dev build", () => {
    expect(isNewerVersion("1.2.0-dev.1", "1.1.0")).toBe(true);
    expect(isNewerVersion("1.1.0-dev.1", "1.1.0")).toBe(true);
    expect(isNewerVersion("1.2.0-dev.2", "1.2.0-dev.1")).toBe(true);
    expect(isNewerVersion("1.2.0-dev.10", "1.2.0-dev.9")).toBe(true);
    expect(isNewerVersion("1.3.0-dev.1", "1.2.0-dev.7")).toBe(true);
    expect(isNewerVersion("1.2.0-dev.1", "1.2.0-dev.1")).toBe(false);
  });
});

describe("a dev manifest", () => {
  it("carries the dev version and updates from the dev release only", () => {
    const dev = devManifest(manifest, `${manifest.version}-dev.3`);
    expect(dev.version).toBe(`${manifest.version}-dev.3`);
    expect(dev.manifest).toBe(DEV_MANIFEST);
    expect(dev.download).toBe("https://github.com/clearspec11/loot-crates/releases/download/dev/module.zip");
    expect(JSON.stringify(dev)).not.toContain("/latest/");
    expect({ ...dev, version: manifest.version, manifest: manifest.manifest, download: manifest.download }).toEqual(manifest);
  });

  it("refuses a dev version that isn't a build of the branch's version", () => {
    expect(() => devManifest(manifest, "9.9.9-dev.1")).toThrow(/not a build/);
  });
});
