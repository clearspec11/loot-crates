/* npm run build: check the manifest, parse every module script, and pack the
   module into dist/ as Foundry's installer expects it:
     dist/loot-crates/          the module folder
     dist/module.zip            module.json at the zip root
     dist/module.json           the manifest, for a release's download URL
   It packs only what package-files.mjs allows (module.json, scripts/*.js,
   styles/*.css, lang/*.json) plus the repository's LICENSE, which MIT
   requires in every copy, and says the zip's size and file count.
   `npm run build -- --dev=1.2.0-dev.3` packs a dev-channel build instead:
   the same files with a dev manifest (tools/lib/channel.mjs). */
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { glob } from "node:fs/promises";
import { shippable } from "./package-files.mjs";
import { devManifest } from "./lib/channel.mjs";

const root = path.resolve(import.meta.dirname, "..");
const src = path.join(root, "module");
const dist = path.join(root, "dist");
const manifest = JSON.parse(await readFile(path.join(src, "module.json"), "utf8"));

const fail = msg => { console.error(`build: ${msg}`); process.exit(1); };
if (manifest.id !== "loot-crates") fail("module.json id must be loot-crates");
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) fail(`bad version ${manifest.version}`);
if (manifest.socket !== true) fail("module.json needs socket: true (purchases go over the module socket)");
const devArg = process.argv.find(a => a.startsWith("--dev="));
let shipped = manifest;
if (devArg) {
  try { shipped = devManifest(manifest, devArg.slice("--dev=".length)); } catch (e) { fail(e.message); }
}
for (const f of [...manifest.esmodules, ...manifest.styles]) {
  try { await stat(path.join(src, f)); } catch { fail(`${f} is listed in module.json but missing`); }
}

const files = [];
for await (const f of glob("**/*", { cwd: src, withFileTypes: true })) {
  if (f.isFile()) files.push(path.relative(src, path.join(f.parentPath, f.name)).split(path.sep).join("/"));
}
const stray = files.filter(f => !shippable(f));
if (stray.length) fail(`module/ holds files that must not ship: ${stray.join(", ")}`);

let scripts = 0;
for await (const f of glob("scripts/**/*.js", { cwd: src })) {
  execFileSync(process.execPath, ["--check", path.join(src, f)], { stdio: "inherit" });
  scripts++;
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(src, path.join(dist, manifest.id), { recursive: true });
const manifestText = `${JSON.stringify(shipped, null, 2)}\n`;
if (shipped === manifest) await cp(path.join(src, "module.json"), path.join(dist, "module.json"));
else for (const p of [path.join(dist, "module.json"), path.join(dist, manifest.id, "module.json")]) await writeFile(p, manifestText);
try { await cp(path.join(root, "LICENSE"), path.join(dist, manifest.id, "LICENSE")); } catch { fail("LICENSE is missing at the repository root"); }
execFileSync("zip", ["-qr", path.join(dist, "module.zip"), "."], { cwd: path.join(dist, manifest.id) });
const { size } = await stat(path.join(dist, "module.zip"));
console.log(`build: ${manifest.id} ${shipped.version}, ${scripts} scripts parsed, dist/module.zip written (${files.length} files, ${Math.round(size / 1024)} KB)`);
