// P4.8 §33/§55/§56/§85 — migration rehearsal / upgrade-safety drill.
//
// npm run db:upgrade:drill
//
// Proves that the CURRENT migration set (`prisma/schema.prisma` +
// `prisma/migrations/*`) applies cleanly against a real, populated,
// already-migrated database — a genuine "does upgrading an existing clinic's
// data work" rehearsal, not a fresh-empty-database check (that's already
// covered every time `db:dev:setup`/`db:test:setup`/CI run `migrate deploy`
// against a brand-new database).
//
// What this does NOT do, and why (§55's own documented fallback): Prisma
// has no supported "rewind to an earlier migration checkpoint" operation,
// and this project's own standing discipline (DATABASE_MIGRATION_SAFETY.md)
// is "never write down-migrations, forward-fix instead" — so this script
// does not reconstruct an "old-ish" schema from scratch. Instead it takes
// the closest honest real equivalent: a real pg_dump/pg_restore copy of
// `his_dev` (already-migrated, already-populated, real relational data —
// reused via the exact same backup.ts/restore.ts P4.2 built and drilled,
// never a second copy of that logic), then verifies `prisma migrate
// status`/`migrate deploy` behave correctly against that copy and that the
// existing data's own financial/inventory integrity still reconciles
// afterward. This is the documented limitation §87 asks to be explicit
// about, not silently presented as more than it is.
//
// Hard guard: refuses anything that isn't the local Postgres cluster
// (assertNotRemoteHost) — this can never touch Supabase/staging/production,
// and the restore target must match the same `his_restore_test*` naming
// pattern P4.2's own restore guard (assertIsSafeRestoreTarget) already
// enforces, reused here unmodified rather than a second guard.
import "dotenv/config"
import { writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import { Client } from "pg"
import { assertNotRemoteHost, requireEnv, runStep, waitForReachable } from "./lib"
import { runBackup } from "./backup"
import { runRestore } from "./restore"

const DOCKER_CONTAINER = process.env.DOCKER_EXEC_CONTAINER ?? "avant_his_postgres"
const RESTORE_DB = "his_restore_test_upgrade_drill"

function withDb(url: string, dbName: string): string {
  const u = new URL(url)
  u.pathname = `/${dbName}`
  return u.toString()
}

function withCredentials(url: string, user: string, password: string): string {
  const u = new URL(url)
  u.username = encodeURIComponent(user)
  u.password = encodeURIComponent(password)
  return u.toString()
}

type ReconciliationResult = { label: string; ok: boolean; detail: string }

async function reconcile(pgUrl: string): Promise<ReconciliationResult[]> {
  const client = new Client({ connectionString: pgUrl })
  await client.connect()
  const results: ReconciliationResult[] = []
  try {
    // Every journal still balances (debit == credit) — the same invariant
    // this codebase's own report-reconciliation/journal-balance tests check,
    // re-run here against whatever real data the drill database happens to
    // hold, not a fixture this script creates.
    const journalRows = await client.query(`
      SELECT j.id, j.journal_number,
             COALESCE(SUM(l.debit), 0)::text AS debit,
             COALESCE(SUM(l.credit), 0)::text AS credit
      FROM "journal" j
      LEFT JOIN "journal_line" l ON l.journal_id = j.id
      GROUP BY j.id, j.journal_number
    `)
    const unbalanced = journalRows.rows.filter((r) => Number(r.debit) !== Number(r.credit))
    results.push({
      label: "Every journal balances (debit == credit)",
      ok: unbalanced.length === 0,
      detail: unbalanced.length === 0
        ? `${journalRows.rowCount} journal(s) checked, all balanced.`
        : `${unbalanced.length} unbalanced journal(s): ${unbalanced.map((r) => r.journal_number).join(", ")}`,
    })

    // Every invoice's paid_amount reconciles to the sum of its payment allocations.
    const invoiceRows = await client.query(`
      SELECT i.id, i.invoice_number, i.paid_amount::text AS paid_amount,
             COALESCE((SELECT SUM(pa.amount) FROM "payment_allocation" pa WHERE pa.invoice_id = i.id), 0)::text AS allocated
      FROM "invoice" i
    `)
    const mismatched = invoiceRows.rows.filter((r) => Number(r.paid_amount).toFixed(2) !== Number(r.allocated).toFixed(2))
    results.push({
      label: "Every invoice.paidAmount matches its payment_allocation sum",
      ok: mismatched.length === 0,
      detail: mismatched.length === 0
        ? `${invoiceRows.rowCount} invoice(s) checked, all reconciled.`
        : `${mismatched.length} mismatched invoice(s): ${mismatched.map((r) => r.invoice_number).join(", ")}`,
    })

    // No negative stock balances that shouldn't exist (a real integrity
    // signal, not a fixture-only check) — same class of query
    // analytics/reports/inventory.ts's own reconciliation report uses.
    const negativeStock = await client.query(`
      SELECT product_id, branch_id, SUM(quantity) AS balance
      FROM "stock_ledger_entry"
      GROUP BY product_id, branch_id
      HAVING SUM(quantity) < 0
    `)
    results.push({
      label: "No negative stock balances",
      ok: negativeStock.rowCount === 0,
      detail: negativeStock.rowCount === 0 ? "None found." : `${negativeStock.rowCount} negative balance(s) found.`,
    })

    return results
  } finally {
    await client.end()
  }
}

async function main() {
  console.log("=".repeat(70))
  console.log("P4.8 Migration Rehearsal / Upgrade Drill — starting")
  console.log("=".repeat(70))

  const directUrl = requireEnv("DIRECT_DATABASE_URL")
  const runtimeTemplateUrl = requireEnv("DATABASE_URL")
  assertNotRemoteHost(directUrl, "DIRECT_DATABASE_URL")
  assertNotRemoteHost(runtimeTemplateUrl, "DATABASE_URL")

  const maintenanceUrl = withDb(directUrl, "postgres")
  await waitForReachable(maintenanceUrl, "Local Postgres")

  // --- 1. Real backup of the source (his_dev by default) -----------------
  console.log(`\n[1/5] Taking a real backup of the source database (pg_dump via docker exec ${DOCKER_CONTAINER})...`)
  const backupResult = await runBackup({ label: "upgrade_drill_source", directUrl, backupDir: "./backups", dockerExecContainer: DOCKER_CONTAINER })
  console.log(`  Backup complete: ${backupResult.filePath} (${backupResult.sizeBytes} bytes, ${backupResult.migrationCount} migrations applied at source)`)

  // --- 2. Restore into an isolated rehearsal database ---------------------
  console.log(`\n[2/5] Restoring into isolated rehearsal database "${RESTORE_DB}"...`)
  const restoreOwnerUrl = withDb(directUrl, RESTORE_DB)
  const restoreResult = await runRestore({ backupFilePath: backupResult.filePath, targetDirectUrl: restoreOwnerUrl, dockerExecContainer: DOCKER_CONTAINER })
  console.log(`  Restore complete: target database "${restoreResult.targetDatabase}"`)

  // --- 3. Migration status + deploy against the rehearsal copy -----------
  // This is the actual rehearsal: does `prisma migrate deploy` apply
  // cleanly against a real, populated copy of the source database? If a new
  // migration hasn't been applied to the source yet, this is exactly where
  // it gets exercised against real data before it ever touches production.
  console.log(`\n[3/5] Checking migration status against the rehearsal copy...`)
  await runStep("npx", ["prisma", "migrate", "status"], { ...process.env, DIRECT_DATABASE_URL: restoreOwnerUrl })
  console.log(`\n[3/5] Applying migrations (prisma migrate deploy) against the rehearsal copy...`)
  await runStep("npx", ["prisma", "migrate", "deploy"], { ...process.env, DIRECT_DATABASE_URL: restoreOwnerUrl })

  // --- 4. Schema/runtime-grant verification -------------------------------
  console.log(`\n[4/5] Verifying schema and runtime-role grants on the rehearsal copy...`)
  const ownerClient = new Client({ connectionString: restoreOwnerUrl })
  await ownerClient.connect()
  const extResult = await ownerClient.query("SELECT extname FROM pg_extension")
  const extensions = extResult.rows.map((r) => r.extname)
  if (!extensions.includes("btree_gist")) throw new Error(`Rehearsal database is missing the required "btree_gist" extension — found: ${extensions.join(", ")}`)
  const migrationCountResult = await ownerClient.query('SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')
  console.log(`  Extensions OK (${extensions.join(", ")}). Applied migrations: ${migrationCountResult.rows[0].n}.`)
  await ownerClient.end()

  // Reconciliation runs through the RESTRICTED RUNTIME connection — proves
  // the runtime role's grants were genuinely re-established by the restore
  // (reused from restore.ts, not re-implemented here) and that the app's
  // own connection can actually read the data it needs to.
  const runtimeUser = new URL(runtimeTemplateUrl).username
  const runtimePassword = decodeURIComponent(new URL(runtimeTemplateUrl).password)
  const restoreRuntimeUrl = withCredentials(withDb(runtimeTemplateUrl, RESTORE_DB), runtimeUser, runtimePassword)

  // --- 5. Reconciliation / representative checks --------------------------
  console.log(`\n[5/5] Running reconciliation checks against the rehearsal copy (via the restricted runtime connection)...`)
  const results = await reconcile(restoreRuntimeUrl)
  for (const r of results) console.log(`  [${r.ok ? "OK" : "FAIL"}] ${r.label} — ${r.detail}`)
  const failed = results.filter((r) => !r.ok)

  // --- Cleanup -------------------------------------------------------------
  if (process.env.UPGRADE_DRILL_KEEP_DATABASE === "1") {
    console.log(`\nUPGRADE_DRILL_KEEP_DATABASE=1 — leaving "${RESTORE_DB}" in place for manual inspection. Drop it by hand when done.`)
  } else {
    console.log(`\nCleaning up (dropping "${RESTORE_DB}")...`)
    const cleanupClient = new Client({ connectionString: maintenanceUrl })
    await cleanupClient.connect()
    await cleanupClient.query(`DROP DATABASE IF EXISTS "${RESTORE_DB}" WITH (FORCE)`)
    await cleanupClient.end()
    console.log(`  Dropped "${RESTORE_DB}".`)
  }

  const summary = {
    ranAt: new Date().toISOString(),
    backup: { filePath: backupResult.filePath, sizeBytes: backupResult.sizeBytes, migrationCount: backupResult.migrationCount },
    reconciliation: results,
  }
  mkdirSync("./backups", { recursive: true })
  const summaryPath = path.resolve("./backups", `upgrade-drill-summary-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2))
  console.log(`\nSummary written to ${summaryPath}`)

  if (failed.length > 0) {
    console.error("\n" + "=".repeat(70))
    console.error(`UPGRADE DRILL FAILED — ${failed.length} reconciliation check(s) failed.`)
    console.error("=".repeat(70))
    process.exit(1)
  }

  console.log("\n" + "=".repeat(70))
  console.log("P4.8 Migration Rehearsal / Upgrade Drill — PASSED")
  console.log("=".repeat(70))
}

main().catch((err) => {
  console.error(`\nUpgrade drill FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
  process.exit(1)
})
