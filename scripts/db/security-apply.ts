// npm run db:security:apply
//
// Applies Row Level Security to every table in the target database's
// `public` schema, with a permissive policy scoped to the restricted
// runtime role only — see prisma/db-setup/apply-rls.sql and
// scripts/db/security.ts for the full reasoning. Idempotent; safe to run
// against a database that already has this applied (e.g. after every
// migration that adds new tables — see DATABASE.md's "Row Level Security"
// section for exactly when to re-run this).
//
// Targets whatever DIRECT_DATABASE_URL/DATABASE_URL currently resolve to —
// local `his_dev`/`his_test` during development (via db:dev:setup/
// db:test:setup, which already call this), or a real hosted Supabase
// project when run with that project's own connection strings. Requires the
// owner/direct connection (DIRECT_DATABASE_URL); refuses a pooled one.

import "dotenv/config"
import { requireEnv } from "./lib"
import { applySecurity } from "./security"

const directUrl = requireEnv("DIRECT_DATABASE_URL")
const runtimeUrl = requireEnv("DATABASE_URL")

applySecurity({ directUrl, runtimeUrl, label: "db:security:apply" })
  .then(() => {
    console.log("db:security:apply: Row Level Security applied to every public-schema table.")
  })
  .catch((err) => {
    console.error(`\ndb:security:apply failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
