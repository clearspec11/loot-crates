/* npm run release:dev: publish the checked-out commit to the dev channel
   (scripts/lib/channel.mjs). The commit must be clean and pushed. It
   builds with the next dev version, then replaces the "dev" pre-release
   (and its tag) with one at this commit. The public "latest" release is
   never touched: --latest=false, and a pre-release is never latest. */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DEV_TAG, DEV_MANIFEST, nextDevVersion } from "./lib/channel.mjs";

const root = path.resolve(import.meta.dirname, "..");
const run = (cmd, args, opts = {}) => String(execFileSync(cmd, args, { cwd: root, encoding: "utf8", ...opts }) ?? "").trim();
const fail = msg => { console.error(`release:dev: ${msg}`); process.exit(1); };

if (run("git", ["status", "--porcelain", "--untracked-files=no"])) fail("commit or stash your changes first");
const sha = run("git", ["rev-parse", "HEAD"]);
const branch = run("git", ["branch", "--show-current"]);
run("git", ["fetch", "-q", "origin"]);
if (!run("git", ["branch", "-r", "--contains", sha])) fail(`${sha.slice(0, 7)} is not on GitHub yet: push ${branch} first`);

const { version } = JSON.parse(await readFile(path.join(root, "module/module.json"), "utf8"));
let current = null;
try {
  const r = JSON.parse(run("gh", ["release", "view", DEV_TAG, "--json", "name"], { stdio: "pipe" }));
  current = /(\d+\.\d+\.\d+-dev\.\d+)/.exec(r.name)?.[1] ?? null;
} catch { /* no dev release yet */ }
const dev = nextDevVersion(version, current);

run("npm", ["run", "build", "--", `--dev=${dev}`], { stdio: "inherit" });
if (current) run("gh", ["release", "delete", DEV_TAG, "--cleanup-tag", "--yes"]);
const notes = `Dev build ${dev} of ${branch} at ${sha.slice(0, 7)}. Not for players: install from ${DEV_MANIFEST} in a test world to get each dev build as an update.`;
run("gh", ["release", "create", DEV_TAG, "dist/module.zip", "dist/module.json", "--prerelease", "--latest=false",
  "--target", sha, "--title", `Loot Crates ${dev} (dev)`, "--notes", notes]);
console.log(`release:dev: published ${dev} (was ${current ?? "none"}); waiting for GitHub to serve it`);

// GitHub serves a new release's download URLs a minute or two after it is
// made (a 404 or the old build until then), so say when Foundry can update.
const zipUrl = DEV_MANIFEST.replace(/module\.json$/, "module.zip");
for (let i = 0; i < 30; i++) {
  const m = await fetch(DEV_MANIFEST, { cache: "no-store" }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  const z = await fetch(zipUrl, { method: "HEAD", cache: "no-store" }).then(r => r.ok).catch(() => false);
  if (m?.version === dev && z) { console.log(`release:dev: ${dev} is live at ${DEV_MANIFEST}`); process.exit(0); }
  await new Promise(r => setTimeout(r, 10_000));
}
fail(`${dev} is published but GitHub isn't serving it after 5 minutes; check ${DEV_MANIFEST} by hand`);
