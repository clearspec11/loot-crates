import js from "@eslint/js";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";

// Foundry supplies these globals inside a world. The module is not bundled;
// its scripts are plain ES modules loaded by Foundry, and the pure ones
// (module/scripts/core, games and views) are also run by Vitest and the harness.
const FOUNDRY_GLOBALS = {
  game: "readonly",
  Hooks: "readonly",
  ui: "readonly",
  foundry: "readonly",
  CONFIG: "readonly",
  CONST: "readonly",
  Actor: "readonly",
  Item: "readonly",
  Folder: "readonly",
  ChatMessage: "readonly",
  Roll: "readonly",
  fromUuid: "readonly",
  fromUuidSync: "readonly",
  dnd5e: "readonly",
};

export default defineConfig([
  // foundry-dev/checks/*.js are async function bodies run by foundry-dev/run.cjs (top-level return), not modules;
  // the .cjs checks beside them are ordinary Node scripts and are linted.
  // .council/ is the improvement council's local files (git-excluded), including a workflow script.
  globalIgnores(["dist", "node_modules", "screenshots", ".claude", ".council", "foundry-dev/checks/*.js"]),
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: globals.browser,
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  // Only main.js and foundry/ may reach Foundry. core/, games/ and views/
  // are pure (CLAUDE.md, "Pure first"): Vitest and the harness run them, so
  // a Foundry global there is a lint error, not a habit to remember.
  {
    files: ["module/scripts/main.js", "module/scripts/foundry/**/*.js", "foundry-dev/**/*.js"],
    languageOptions: { globals: { ...globals.browser, ...FOUNDRY_GLOBALS } },
  },
  {
    files: ["tools/**/*.mjs", "foundry-dev/**/*.cjs"],
    languageOptions: { sourceType: "script", globals: globals.node },
  },
  {
    files: ["tools/**/*.mjs"],
    languageOptions: { sourceType: "module" },
  },
  {
    files: ["test/**/*.js"],
    languageOptions: { globals: { ...globals.node, ...globals.vitest } },
  },
]);
