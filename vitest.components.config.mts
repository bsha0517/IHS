import { defineConfig } from "vitest/config"
import path from "node:path"

const rootDir = import.meta.dirname

/**
 * P4.7A §66/§95 — a deliberately separate config from vitest.config.mts,
 * not a merged/projects setup: component tests need a `jsdom` environment
 * and must NOT go through `test/setup-test-database.ts` (they touch no
 * database at all, and requiring Postgres reachability just to run a
 * component test would be a real, unnecessary coupling). The main
 * integration config is untouched — zero risk to the 583+ tests already
 * passing there. Run via `npm run test:components`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup-component-tests.ts"],
    include: ["test/components/**/*.test.tsx"],
  },
})
