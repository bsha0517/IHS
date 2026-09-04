// Shared routine behind `npm run db:dev:setup` / `npm run db:test:setup` —
// not itself a runnable script. Both commands do the same three things
// against a different target database (his_dev vs. his_test): apply every
// Prisma migration, (re-)apply the restricted runtime role's table grants,
// and optionally seed. One schema, one migration history, one grant script
// — reused for both, per this task's own "don't maintain a second schema"
// and "reuse the existing runtime-role script, don't build a competing
// design" instructions.

import { readFileSync } from "node:fs"
import path from "node:path"
import { waitForReachable, runSql, runStep, assertNotRemoteHost } from "./lib"

const GRANT_SQL_PATH = path.resolve(import.meta.dirname, "../../prisma/db-setup/local-grant-runtime-role.sql")

export async function setupDatabase({
  label,
  directUrl,
  runtimeUrl,
  seed,
  extraTestFixtures = false,
}: {
  /** "his_dev" or "his_test" — used only for log messages. */
  label: string
  /** Owner-role connection string (DDL rights) — migrations + grants run through this. */
  directUrl: string
  /** Restricted-role connection string — what the app/tests actually use; seeding runs through this. */
  runtimeUrl: string
  /** Whether to run `tsx prisma/seed.ts` afterward. */
  seed: boolean
  /** Whether to also run prisma/test-seed-extra.ts afterward — his_test only,
   * never his_dev. See that file's own header comment for why it exists:
   * seed.ts alone doesn't create a second Branch, a Provider, a Service, or
   * a Product, which several integration tests require and the old shared
   * Supabase dev database happened to have accumulated organically. */
  extraTestFixtures?: boolean
}): Promise<void> {
  // Both local dev/test setup entry points call this — guard here too
  // (not just in the reset script) so a mistyped .env value can never
  // apply migrations/grants/seed data against a real remote database.
  assertNotRemoteHost(directUrl, `${label} direct/owner connection`)
  assertNotRemoteHost(runtimeUrl, `${label} runtime connection`)

  console.log(`\n[${label}] Checking the owner connection is reachable...`)
  await waitForReachable(directUrl, `${label} owner connection`, { attempts: 10, delayMs: 1000 })

  console.log(`[${label}] Applying Prisma migrations (prisma migrate deploy)...`)
  await runStep("npx", ["prisma", "migrate", "deploy"], {
    ...process.env,
    DIRECT_DATABASE_URL: directUrl,
  })

  console.log(`[${label}] Applying the restricted runtime role's table grants...`)
  const grantSql = readFileSync(GRANT_SQL_PATH, "utf8")
  await runSql(directUrl, grantSql)

  if (seed) {
    console.log(`[${label}] Seeding (tsx prisma/seed.ts)...`)
    await runStep("npx", ["tsx", "prisma/seed.ts"], {
      ...process.env,
      DATABASE_URL: runtimeUrl,
    })
  } else {
    console.log(`[${label}] Skipping seed (seed=false).`)
  }

  if (extraTestFixtures) {
    console.log(`[${label}] Seeding extra test-only fixtures (tsx prisma/test-seed-extra.ts)...`)
    await runStep("npx", ["tsx", "prisma/test-seed-extra.ts"], {
      ...process.env,
      DATABASE_URL: runtimeUrl,
    })
  }

  console.log(`[${label}] Done.`)
}
