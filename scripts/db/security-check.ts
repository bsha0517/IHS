// npm run db:security:check
//
// Read-only verification that every public-schema table has Row Level
// Security enabled and the expected runtime-role policy — see
// scripts/db/security.ts's checkSecurity(). Safe to run against production;
// performs no writes and never prints a connection string or credential.
// Exits nonzero (and lists exactly which tables are unsafe) if anything is
// missing — the release-gate-friendly half of P4.9.1's "a new table cannot
// quietly enter production with RLS disabled" requirement.

import "dotenv/config"
import { requireEnv } from "./lib"
import { checkSecurity } from "./security"

const directUrl = requireEnv("DIRECT_DATABASE_URL")
const runtimeUrl = requireEnv("DATABASE_URL")

checkSecurity({ directUrl, runtimeUrl, label: "db:security:check" })
  .then((result) => {
    console.log(`db:security:check: ${result.tablesChecked} table(s) checked.`)
    if (result.tablesWithoutRls.length > 0) {
      console.error(`  RLS DISABLED on: ${result.tablesWithoutRls.join(", ")}`)
    }
    if (result.tablesWithoutPolicy.length > 0) {
      console.error(`  Missing the expected runtime-role policy on: ${result.tablesWithoutPolicy.join(", ")}`)
    }
    if (result.ok) {
      console.log("  All tables are protected. Run `npm run db:security:apply` after any migration that adds new tables.")
    } else {
      console.error("\ndb:security:check: UNSAFE — run `npm run db:security:apply` before this release ships.")
      process.exit(1)
    }
  })
  .catch((err) => {
    console.error(`\ndb:security:check failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
