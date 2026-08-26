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
  },
})
