// npm run db:load-test:setup
//
// P4.5 §11/§12: creates (or recreates clean) the dedicated `his_load_test`
// database, applies every Prisma migration, and grants the restricted
// runtime role access — the same local Postgres cluster `his_dev`/`his_test`
// already live in, but a genuinely separate database, never touched by
// `npm run dev` or the integration suite. Does NOT run `prisma/seed.ts` —
// load testing needs a large synthetic dataset, not the small dev-fixture
// catalog; see load-tests/seed/generate-load-data.ts for that, run
// separately after this script.
//
// DOES run `prisma/seed.ts` — his_load_test needs the same system/catalog
// baseline every other environment has (the permission catalog, system
// roles, chart of accounts, communication templates) so the real domain
// functions the concurrency scenarios call behave identically to
// production. The BULK synthetic volume (10,000+ patients, 20,000+
// appointments, ...) is a separate, later step —
// load-tests/seed/generate-load-data.ts — layered on top of this baseline,
// not a replacement for it.
//
// Requires LOAD_TEST_DIRECT_DATABASE_URL / LOAD_TEST_DATABASE_URL in .env,
// both pointed at `his_load_test` on the same local Postgres cluster (see
// .env.example) — this script refuses to run against anything else
// (assertIsLoadTestDatabase, assertNotRemoteHost).

import "dotenv/config"
import { Client } from "pg"
import { assertIsLoadTestDatabase, assertNotRemoteHost, requireEnv, waitForReachable } from "./lib"
import { setupDatabase } from "./setup-database"

async function main() {
  const directUrl = requireEnv("LOAD_TEST_DIRECT_DATABASE_URL")
  const runtimeUrl = requireEnv("LOAD_TEST_DATABASE_URL")

  assertNotRemoteHost(directUrl, "LOAD_TEST_DIRECT_DATABASE_URL")
  assertNotRemoteHost(runtimeUrl, "LOAD_TEST_DATABASE_URL")
  assertIsLoadTestDatabase(directUrl, "LOAD_TEST_DIRECT_DATABASE_URL")
  assertIsLoadTestDatabase(runtimeUrl, "LOAD_TEST_DATABASE_URL")

  // Connect to the cluster's maintenance database to create his_load_test
  // if it doesn't exist yet — unlike his_dev/his_test (created once by
  // local-init.sql when the container's volume is first initialized),
  // his_load_test is created here, on demand, the first time this script
  // runs against an existing cluster.
  const maintenanceUrl = new URL(directUrl)
  maintenanceUrl.pathname = "/postgres"
  await waitForReachable(maintenanceUrl.toString(), "Local Postgres", { attempts: 10, delayMs: 1000 })

  // Always drop-and-recreate clean — his_load_test is disposable, generated
  // test data, never anything worth preserving across runs, and §60's own
  // "a future engineer must be able to rerun the same benchmark"
  // requirement means every run should start from the same deterministic
  // empty state, not accumulate duplicates from a previous run left
  // partway through (generate-load-data.ts itself is not idempotent — it
  // always appends, by design, for speed).
  const maintenance = new Client({ connectionString: maintenanceUrl.toString() })
  await maintenance.connect()
  try {
    console.log('[his_load_test] Dropping (if exists) and recreating clean...')
    await maintenance.query('DROP DATABASE IF EXISTS "his_load_test" WITH (FORCE)')
    await maintenance.query('CREATE DATABASE "his_load_test"')
  } finally {
    await maintenance.end()
  }

  await setupDatabase({ label: "his_load_test", directUrl, runtimeUrl, seed: true })
  console.log("\n[his_load_test] Ready (system/catalog baseline seeded). Next: npx tsx load-tests/seed/generate-load-data.ts")
}

main().catch((err) => {
  console.error(`\ndb:load-test:setup failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
