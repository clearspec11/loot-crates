import { configDefaults, defineConfig } from "vitest/config";

// .council/ is the improvement council's local files (git-excluded, and
// ignored by eslint.config.js the same way); it may hold copies of test
// files, which are not this repo's tests.
export default defineConfig({ test: { exclude: [...configDefaults.exclude, ".council/**"] } });
