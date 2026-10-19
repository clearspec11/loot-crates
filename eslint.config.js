import js from "@eslint/js";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";

// Foundry supplies these globals inside a world. The module is not bundled;
// its scripts are plain ES modules loaded by Foundry, and the pure ones
// (odds.js, currency.js, strip.js) are also run by Vitest and the harness.
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
  // foundry-dev/checks/*.js are async function bodies run by headless/run.cjs (top-level return), not modules.
  globalIgnores(["dist", "node_modules", "screenshots", ".claude", "foundry-dev/checks"]),
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
  {
    files: ["module/**/*.js", "foundry-dev/**/*.js"],
    languageOptions: { globals: { ...globals.browser, ...FOUNDRY_GLOBALS } },
  },
  {
    files: ["scripts/**/*.mjs", "foundry-dev/**/*.cjs"],
    languageOptions: { sourceType: "script", globals: globals.node },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { sourceType: "module" },
  },
  {
    files: ["test/**/*.js"],
    languageOptions: { globals: { ...globals.node, ...globals.vitest } },
  },
]);
