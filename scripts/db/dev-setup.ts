// npm run db:dev:setup
//
// Applies every Prisma migration to `his_dev`, grants the restricted
// runtime role access to the resulting tables, and seeds development data
// (permission catalog, default roles, org/branch, chart of accounts, the
// initial Super Admin — prisma/seed.ts). Safe to re-run any time a new
// migration lands.

// npm doesn't auto-load .env the way Next.js/Prisma's own CLI do — this
// script is a plain tsx entry point, so it needs the same explicit load
// prisma/seed.ts already uses.
import "dotenv/config"
import { requireEnv } from "./lib"
import { setupDatabase } from "./setup-database"

setupDatabase({
  label: "his_dev",
  directUrl: requireEnv("DIRECT_DATABASE_URL"),
  runtimeUrl: requireEnv("DATABASE_URL"),
  seed: true,
}).catch((err) => {
  console.error(`\ndb:dev:setup failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
