/* npm run live -- <check> [args]: run one live check against a dev world.

   <check> is a check's name in foundry-dev/checks/. A .cjs there is a Node
   script that drives its own browsers (`npm run live -- live-dice`); a .js
   is a page script that foundry-dev/run.cjs runs as the GM inside the world
   (`npm run live -- live-tabs`). `npm run live -- --list` lists them all.

   Settings come from the environment, then from an untracked .env at the
   repository root (copy .env.example): FOUNDRY_URL (the dev world),
   MODULE_BASE (where this checkout's module/ is served with CORS, see
   `npm run foundry:serve`), and optionally PLAYER. NODE_PATH defaults to the
   global npm root, where Playwright lives. Extra args go to the check
   (`--shot out.png`), and env for one run goes before npm as usual
   (`SEAL=1 npm run live -- player-pull`). */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const CHECKS = path.join(root, "foundry-dev/checks");
const RUNNER = path.join(root, "foundry-dev/run.cjs");
const fail = msg => { console.error(`live: ${msg}`); process.exit(1); };

// KEY=value lines; a value already in the environment wins.
function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
}

// The first sentence of a check's header comment, for --list.
function about(file) {
  const head = readFileSync(file, "utf8").split("\n").filter(l => l.startsWith("//")).slice(0, 4).map(l => l.replace(/^\/\/\s?/, "")).join(" ");
  return (/^(.*?\.)(\s|$)/.exec(head)?.[1] ?? head).replace(/^Live check:\s*/, "").slice(0, 110);
}

const checks = () => readdirSync(CHECKS)
  .filter(f => /\.c?js$/.test(f))
  .map(f => ({ name: f.replace(/\.c?js$/, ""), kind: f.endsWith(".cjs") ? "browsers" : "in page", file: path.join(CHECKS, f) }))
  .sort((a, b) => a.name.localeCompare(b.name));

const [arg, ...rest] = process.argv.slice(2);
if (!arg || arg === "--help") fail("usage: npm run live -- <check> [args], or npm run live -- --list");
if (arg === "--list") {
  for (const c of checks()) console.log(`${c.name.padEnd(20)} ${c.kind.padEnd(9)} ${about(c.file)}`);
  process.exit(0);
}

const name = arg.replace(/\.c?js$/, "");
const check = checks().find(c => c.name === name);
if (!check) fail(`no check named ${name}; npm run live -- --list shows them`);

loadEnv(path.join(root, ".env"));
for (const key of ["FOUNDRY_URL", "MODULE_BASE"]) if (!process.env[key]) fail(`${key} is not set: copy .env.example to .env and fill it in`);
process.env.NODE_PATH ??= execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();

const args = check.kind === "browsers" ? [check.file, ...rest] : [RUNNER, check.file, ...rest];
const { status } = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", env: process.env });
process.exit(status ?? 1);
