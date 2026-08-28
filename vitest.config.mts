import { defineConfig } from "vitest/config"
import path from "node:path"

const rootDir = import.meta.dirname

export default defineConfig({
  resolve: {
    alias: {
      "server-only": path.resolve(rootDir, "test/server-only-stub.ts"),
      "@": path.resolve(rootDir, "src"),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["dotenv/config"],
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // Integration tests share one real Postgres connection pool (src/lib/db.ts) and some
    // create/delete real rows scoped to their own uniquely-named fixtures — run files
    // serially so two suites never race the same connection pool teardown.
    fileParallelism: false,
    // Vitest's 5000ms default test/hook timeout is tighter than real round-trips
    // against this environment's Supabase pooler under full-suite cumulative load
    // (a single file in isolation is fast enough, but 15 files sequentially sharing
    // one pooled connection is not). Raised globally rather than annotated
    // per-test, since the shortfall is environmental, not specific to any one test.
    testTimeout: 20000,
    hookTimeout: 30000,
  },
})
