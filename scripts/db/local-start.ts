// npm run db:local:start
//
// Starts the local Postgres container (docker-compose.yml) and waits until
// it genuinely accepts connections before exiting — so the very next step
// in a developer's copy/paste (`npm run db:dev:setup`) never races a
// still-starting container.

// npm doesn't auto-load .env the way Next.js/Prisma's own CLI do — this
// script is a plain tsx entry point, so it needs the same explicit load
// prisma/seed.ts already uses. Not strictly needed by this file's own logic
// today (no env var is read here), but kept consistent with the other
// scripts/db/*.ts entry points so that never becomes a silent trap later.
import "dotenv/config"
import { waitForReachable, runStep } from "./lib"

async function main() {
  console.log("Starting local Postgres (docker compose up -d postgres)...")
  await runStep("docker", ["compose", "up", "-d", "postgres"], process.env)

  console.log("Waiting for Postgres to accept connections on localhost:5433...")
  // The owner/superuser connects to the container's default maintenance
  // database (`postgres`) — created directly from POSTGRES_DB in
  // docker-compose.yml, independent of whether local-init.sql has run yet.
  await waitForReachable("postgresql://postgres:postgres@localhost:5433/postgres", "Local Postgres")

  console.log("Local Postgres is up. Next: npm run db:dev:setup (and/or npm run db:test:setup).")
}

main().catch((err) => {
  console.error(`\ndb:local:start failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
