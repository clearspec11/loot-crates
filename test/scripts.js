/*
  The module's scripts for tests that read their source: every .js under
  module/scripts, in its folders (core, games, views, foundry) and main.js.
  `file` is the bare name ("i18n.js"), which is unique across the folders,
  so a test can find a script without knowing its folder; `rel` is the
  path inside module/scripts ("core/i18n.js").
*/
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export const SCRIPTS_DIR = path.resolve(import.meta.dirname, "../module/scripts");

export const scriptFiles = () => readdirSync(SCRIPTS_DIR, { recursive: true })
  .map(rel => String(rel).split(path.sep).join("/"))
  .filter(rel => rel.endsWith(".js"))
  .sort()
  .map(rel => ({ rel, file: path.basename(rel), path: path.join(SCRIPTS_DIR, rel), src: readFileSync(path.join(SCRIPTS_DIR, rel), "utf8") }));

// One script's source by its bare name.
export function scriptSource(file) {
  const hit = scriptFiles().find(s => s.file === file);
  if (!hit) throw new Error(`no script named ${file} under module/scripts`);
  return hit.src;
}
