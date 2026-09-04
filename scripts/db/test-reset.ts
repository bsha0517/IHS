// npm run db:test:reset
//
// Drops and recreates `his_test`'s schema, reapplies every migration, then
// reapplies the runtime role's grants and reseeds — the "start every
// integration run from a known-clean database" mechanism this task's §6
// asks for.
//
// Safety, enforced before anything destructive runs, not just documented:
//   1. Requires TEST_DIRECT_DATABASE_URL to be set at all (no fallback).
//   2. Refuses to run against anything that isn't literally the `his_test`
//      database (assertIsTestDatabase) — his_dev, staging, and Supabase
//      production are all rejected the same way.
//   3. Refuses anything that looks like a hosted/shared host
//      (assertNotRemoteHost) — belt-and-suspenders with #2.
// These two checks are the same ones the test bootstrap
// (test/setup-test-database.ts) uses, imported from the one shared place
// (scripts/db/lib.ts) rather than duplicated, so they can never quietly
// diverge.

// npm doesn't auto-load .env the way Next.js/Prisma's own CLI do — this
// script is a plain tsx entry point, so it needs the same explicit load
// prisma/seed.ts already uses.
import "dotenv/config"
import { assertIsTestDatabase, assertNotRemoteHost, requireEnv, runStep } from "./lib"
import { setupDatabase } from "./setup-database"

async function main() {
  const directUrl = requireEnv("TEST_DIRECT_DATABASE_URL")
  const runtimeUrl = requireEnv("TEST_DATABASE_URL")

  assertNotRemoteHost(directUrl, "TEST_DIRECT_DATABASE_URL")
  assertNotRemoteHost(runtimeUrl, "TEST_DATABASE_URL")
  assertIsTestDatabase(directUrl, "TEST_DIRECT_DATABASE_URL")
  assertIsTestDatabase(runtimeUrl, "TEST_DATABASE_URL")

  // Prisma 7's `migrate reset` has no `--skip-seed` flag (it errors on an
  // unrecognized option, it doesn't just ignore it) — it always runs the
  // seed command configured in prisma.config.ts (`tsx prisma/seed.ts`)
  // immediately after resetting, before this script gets a chance to
  // reapply the runtime role's table grants. That seed subprocess reads
  // DATABASE_URL itself, so it's deliberately pointed at the OWNER
  // connection here, not the runtime one — the runtime role has no
  // privileges on the freshly-recreated tables yet at that point (`migrate
  // reset` drops and recreates every table, which drops any existing
  // grants on them too), so seeding through it would fail with a
  // permission error. The runtime connection gets its own, separate,
  // real exercise right after, once setupDatabase() below has reapplied
  // the grants.
  console.log("[his_test] Safety checks passed — resetting (prisma migrate reset --force)...")
  await runStep("npx", ["prisma", "migrate", "reset", "--force"], {
    ...process.env,
    DIRECT_DATABASE_URL: directUrl,
    DATABASE_URL: directUrl,
  })

  // `migrate reset` drops and recreates every table, which drops the
  // runtime role's grants on them too — reapply, then reseed through the
  // actual runtime connection (proving `his_app_runtime` can genuinely
  // write through it, not just the owner role above), and add the extra
  // test fixtures reset itself doesn't know about. seed.ts is idempotent
  // (checks before creating), so re-running it here after the owner-role
  // pass above is safe, not a duplicate-data risk.
  await setupDatabase({ label: "his_test", directUrl, runtimeUrl, seed: true, extraTestFixtures: true })

  console.log("\n[his_test] Reset complete.")
}

main().catch((err) => {
  console.error(`\ndb:test:reset failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
