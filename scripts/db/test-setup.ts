// npm run db:test:setup
//
// Applies the exact same Prisma migrations to `his_test` (no separate
// schema/migration history) and grants the restricted runtime role access
// to the resulting tables.
//
// Also seeds — deliberately, not by default/oversight. Every one of this
// suite's 33 integration test files reads baseline fixtures the seed
// script creates (an Organization, at least one Branch, the permission/role
// catalog, a seeded User, the default Chart of Accounts, and a handful of
// catalog rows like DiagnosisCode) via `db.<model>.findFirstOrThrow()`
// rather than creating that baseline themselves — only their own
// transactional fixtures (a patient, an invoice, a specific test batch, ...)
// are self-created. This is the "tests depend on explicitly documented seed
// fixtures" exception this task's own §5 names, not "normal demo/development
// data" — see LOCAL_DATABASE_SETUP.md for the full list of what's relied on.
//
// Also runs prisma/test-seed-extra.ts — real evidence from the first live
// run against a freshly built his_test (not a guess): seed.ts alone was
// missing a second Branch, a Provider, a Service, and a Product that 8
// files' `findFirstOrThrow()` calls needed and the old shared Supabase dev
// database happened to have accumulated organically. See that file's own
// header comment for the full explanation.

// npm doesn't auto-load .env the way Next.js/Prisma's own CLI do — this
// script is a plain tsx entry point, so it needs the same explicit load
// prisma/seed.ts already uses.
import "dotenv/config"
import { requireEnv } from "./lib"
import { setupDatabase } from "./setup-database"

setupDatabase({
  label: "his_test",
  directUrl: requireEnv("TEST_DIRECT_DATABASE_URL"),
  runtimeUrl: requireEnv("TEST_DATABASE_URL"),
  seed: true,
  extraTestFixtures: true,
}).catch((err) => {
  console.error(`\ndb:test:setup failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
