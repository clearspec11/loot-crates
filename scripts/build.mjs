/* npm run build: check the manifest, parse every module script, and pack the
   module into dist/ as Foundry's installer expects it:
     dist/loot-crates/          the module folder
     dist/module.zip            module.json at the zip root
     dist/module.json           the manifest, for a release's download URL */
import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { glob } from "node:fs/promises";

const root = path.resolve(import.meta.dirname, "..");
const src = path.join(root, "module");
const dist = path.join(root, "dist");
const manifest = JSON.parse(await readFile(path.join(src, "module.json"), "utf8"));

const fail = msg => { console.error(`build: ${msg}`); process.exit(1); };
if (manifest.id !== "loot-crates") fail("module.json id must be loot-crates");
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) fail(`bad version ${manifest.version}`);
if (manifest.socket !== true) fail("module.json needs socket: true (purchases go over the module socket)");
for (const f of [...manifest.esmodules, ...manifest.styles]) {
  try { await stat(path.join(src, f)); } catch { fail(`${f} is listed in module.json but missing`); }
}

let scripts = 0;
for await (const f of glob("scripts/**/*.js", { cwd: src })) {
  execFileSync(process.execPath, ["--check", path.join(src, f)], { stdio: "inherit" });
  scripts++;
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(src, path.join(dist, manifest.id), { recursive: true });
await cp(path.join(src, "module.json"), path.join(dist, "module.json"));
execFileSync("zip", ["-qr", path.join(dist, "module.zip"), "."], { cwd: path.join(dist, manifest.id) });
console.log(`build: ${manifest.id} ${manifest.version}, ${scripts} scripts parsed, dist/module.zip written`);
