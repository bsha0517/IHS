// Vitest setupFile (see vitest.config.mts's `setupFiles`) — runs before any
// test file is imported, and therefore before `src/lib/db.ts` (which reads
// `process.env.DATABASE_URL` synchronously at module-evaluation time) is
// ever imported by a test.
//
// Purpose: make the integration suite always run against the local
// `his_test` database, never whatever `DATABASE_URL`/`DIRECT_DATABASE_URL`
// happen to be set to for `npm run dev` — without requiring every test file
// (or a developer's own shell) to remember to swap connection strings by
// hand. Production/application code never imports this file and continues
// reading `DATABASE_URL` exactly as before; only the test process's own
// environment is touched, here, once, before anything else runs.
//
// Ordering matters: listed in vitest.config.mts AFTER "dotenv/config" so
// `.env` has already populated `process.env.TEST_DATABASE_URL` /
// `process.env.TEST_DIRECT_DATABASE_URL` by the time this file reads them.

import { assertNotRemoteHost, requireEnv, waitForReachable } from "../scripts/db/lib"

const testDatabaseUrl = requireEnv("TEST_DATABASE_URL")
// Also required, not optional: test/integration/audit-log-immutability.test.ts
// opens a second, owner-level connection directly via
// `process.env.DIRECT_DATABASE_URL`. If this bootstrap only overrode
// DATABASE_URL and left DIRECT_DATABASE_URL untouched, that one test would
// silently connect to whatever real (possibly Supabase) owner connection
// the developer's own .env has configured for `npm run dev` — exactly the
// "no integration test may touch Supabase" guarantee this setup exists to
// provide. Both must be local, or neither runs.
const testDirectDatabaseUrl = requireEnv("TEST_DIRECT_DATABASE_URL")

assertNotRemoteHost(testDatabaseUrl, "TEST_DATABASE_URL")
assertNotRemoteHost(testDirectDatabaseUrl, "TEST_DIRECT_DATABASE_URL")

await waitForReachable(testDatabaseUrl, "TEST_DATABASE_URL (his_test, runtime role)", {
  attempts: 5,
  delayMs: 500,
})

// The actual substitution this file exists for — production code keeps
// reading DATABASE_URL/DIRECT_DATABASE_URL unchanged; only this test
// process's own environment now resolves them to the local test database.
process.env.DATABASE_URL = testDatabaseUrl
process.env.DIRECT_DATABASE_URL = testDirectDatabaseUrl
