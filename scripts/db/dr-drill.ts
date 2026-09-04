// P4.2 §15-31: the actual, mandatory backup/restore disaster-recovery
// drill. Not a mock, not a dry run — this creates a real, isolated local
// database (`his_dr_drill`), populates it with a relationally-connected
// fixture using this codebase's OWN real domain functions (the same ones
// P3.7's own integration tests call — see that file's own header comment
// for the pattern this reuses), takes a real pg_dump backup, deliberately
// destroys part of the data, restores from the backup into a second
// isolated database (`his_restore_test_p42drill`, matching the
// `assertIsSafeRestoreTarget` naming guard), and verifies the restored
// data reconciles against a baseline captured before any of this happened.
//
// npm run db:dr:drill
//
// Never touches `his_dev` or `his_test` — every database this script
// creates, mutates, or drops is one of the two scratch databases named
// above, both recreated from scratch at the start of a run and dropped at
// the end. Requires the local Docker Postgres container (see
// docker-compose.yml) — this is a local-only tool, not something CI or
// production runs automatically (see docs/BACKUP_DISASTER_RECOVERY.md's
// "Restore Drill Schedule" for the recurring-drill recommendation instead).
import "dotenv/config"
import { writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import { Client } from "pg"
import { assertNotRemoteHost, requireEnv, waitForReachable } from "./lib"
import { setupDatabase } from "./setup-database"
import { runBackup } from "./backup"
import { runRestore } from "./restore"
import { runStep } from "./lib"

const DOCKER_CONTAINER = process.env.DOCKER_EXEC_CONTAINER ?? "avant_his_postgres"
const DRILL_DB = "his_dr_drill"
const RESTORE_DB = "his_restore_test_p42drill"

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

async function recreateDatabase(maintenanceUrl: string, dbName: string): Promise<void> {
  const client = new Client({ connectionString: maintenanceUrl })
  await client.connect()
  try {
    await client.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
    await client.query(`CREATE DATABASE "${dbName}"`)
  } finally {
    await client.end()
  }
}

type Counts = Record<string, number>

async function captureCounts(pgUrl: string, organizationId: string): Promise<Counts> {
  const client = new Client({ connectionString: pgUrl })
  await client.connect()
  try {
    const tables: Record<string, string> = {
      patient: "patient", appointment: "appointment", encounter: "encounter",
      invoice: "invoice", payment: "payment", journal: "journal",
      stockLedgerEntry: "stock_ledger_entry", auditLog: "audit_log", clinicalAccessLog: "clinical_access_log",
    }
    const counts: Counts = {}
    for (const [key, table] of Object.entries(tables)) {
      const result = await client.query(`SELECT count(*)::int AS n FROM "${table}" WHERE organization_id = $1`, [organizationId])
      counts[key] = result.rows[0].n
    }
    return counts
  } finally {
    await client.end()
  }
}

function assertCountsEqual(label: string, before: Counts, after: Counts): void {
  const mismatches = Object.keys(before).filter((k) => before[k] !== after[k])
  if (mismatches.length > 0) {
    throw new Error(
      `${label}: count mismatch on [${mismatches.join(", ")}] — before=${JSON.stringify(before)} after=${JSON.stringify(after)}`
    )
  }
}

async function main() {
  console.log("=".repeat(70))
  console.log("P4.2 Disaster Recovery Drill — starting")
  console.log("=".repeat(70))

  const directUrl = requireEnv("DIRECT_DATABASE_URL")
  const runtimeTemplateUrl = requireEnv("TEST_DATABASE_URL") // local runtime-role credentials (his_app_runtime), db name swapped below
  assertNotRemoteHost(directUrl, "DIRECT_DATABASE_URL")
  assertNotRemoteHost(runtimeTemplateUrl, "TEST_DATABASE_URL")

  const drillOwnerUrl = withDb(directUrl, DRILL_DB)
  const drillRuntimeUrl = withDb(runtimeTemplateUrl, DRILL_DB)
  const maintenanceUrl = withDb(directUrl, "postgres")

  // --- Phase 1: fresh, isolated drill source database ------------------
  console.log(`\n[1/8] Recreating isolated drill-source database "${DRILL_DB}"...`)
  await waitForReachable(maintenanceUrl, "Local Postgres")
  await recreateDatabase(maintenanceUrl, DRILL_DB)
  await setupDatabase({ label: DRILL_DB, directUrl: drillOwnerUrl, runtimeUrl: drillRuntimeUrl, seed: true, extraTestFixtures: true })

  // Point this process's own DATABASE_URL at the drill database BEFORE
  // dynamically importing any app domain module — src/lib/db.ts's Prisma
  // singleton binds to process.env.DATABASE_URL the moment it's first
  // imported, and every domain function below reaches the database only
  // through that singleton.
  process.env.DATABASE_URL = drillRuntimeUrl
  process.env.DIRECT_DATABASE_URL = drillOwnerUrl

  const { db } = await import("../../src/lib/db")
  const { generateSystemCharge } = await import("../../src/lib/domains/billing/charges")
  const { generateInvoice } = await import("../../src/lib/domains/billing/invoices")
  const { recordPayment } = await import("../../src/lib/domains/billing/payments")
  const { openSession: openCashierSession } = await import("../../src/lib/domains/billing/cashier")
  const { recordAdjustment, receiveStock } = await import("../../src/lib/domains/inventory/stock")
  const { dispatchPendingOutboxEvents } = await import("../../src/lib/platform/outbox")

  // --- Phase 2: build a relationally-connected fixture via real domain functions ---
  console.log(`\n[2/8] Building the fixture (real domain functions — same pattern as test/integration/p3-7-*.test.ts)...`)

  const organization = await db.organization.findFirstOrThrow()
  const branch = await db.branch.findFirstOrThrow({ where: { organizationId: organization.id }, orderBy: { createdAt: "asc" } })
  const provider = await db.provider.findFirstOrThrow({ where: { organizationId: organization.id } })
  const product = await db.product.findFirstOrThrow({ where: { organizationId: organization.id } })
  const staffUser = await db.user.findFirstOrThrow({ where: { organizationId: organization.id } })

  async function buildSession() {
    return {
      sessionId: "dr-drill-session",
      user: { id: staffUser.id, organizationId: organization.id, email: "dr-drill@test.local", firstName: "DR", lastName: "Drill" },
      activeBranchId: branch.id,
      branchIds: [branch.id],
      permissions: new Set([
        "patient.view", "patient.create", "service.view",
        "charge.create", "invoice.view", "invoice.create",
        "payment.view", "payment.create", "cashier.open", "cashier.view",
        "inventory.view", "inventory.adjust",
      ]),
      roleNames: ["DR Drill Fixture"],
    }
  }
  const session = await buildSession()

  const patient = await db.patient.create({
    data: {
      organizationId: organization.id, registrationBranchId: branch.id,
      mrn: "DRILL-MRN-0001", firstName: "Drill", lastName: "FixturePatient",
      dob: new Date("1985-06-15"), gender: "unknown", mobile: "DRILL-MOBILE-0001",
    },
  })

  const appointment = await db.appointment.create({
    data: {
      organizationId: organization.id, branchId: branch.id, appointmentNumber: "DRILL-APT-0001",
      patientId: patient.id, providerId: provider.id,
      startTime: new Date(), endTime: new Date(Date.now() + 30 * 60 * 1000),
      status: "completed",
    },
  })

  const encounter = await db.encounter.create({
    data: {
      organizationId: organization.id, branchId: branch.id, patientId: patient.id, providerId: provider.id,
      appointmentId: appointment.id, encounterNumber: "DRILL-ENC-0001", encounterType: "consultation", status: "completed",
    },
  })

  // Financial: Charge -> Invoice -> partial Payment (real functions, real
  // posting service) — leaves a genuine, non-trivial outstanding balance.
  const charge = await db.$transaction((tx) =>
    generateSystemCharge(tx, {
      organizationId: organization.id, branchId: branch.id, patientId: patient.id, encounterId: encounter.id,
      sourceType: "consultation", description: "P4.2 DR drill fixture charge", quantity: 1, unitPrice: 150,
    })
  )
  const cashierReg = await openCashierSession(session, { branchId: branch.id, openingCash: 100 })
  const invoice = await generateInvoice(session, { patientId: patient.id, branchId: branch.id, chargeIds: [charge.id], discountAmount: 0 })
  await recordPayment(session, { invoiceId: invoice.id, cashierSessionId: cashierReg.id, tenders: [{ method: "cash", amount: 100 }] })

  // Inventory: a receipt (opening stock) then a real adjustment (out) —
  // real functions, real StockLedgerEntry rows, real financial posting for
  // the adjustment (InventoryAdjusted event).
  const batch = await db.$transaction((tx) =>
    receiveStock(tx, {
      organizationId: organization.id, branchId: branch.id, productId: product.id,
      batchNumber: "DRILL-BATCH-0001", purchaseCost: 10, quantity: 100,
      referenceType: "dr_drill_fixture", referenceId: "dr-drill-fixture", performedBy: staffUser.id,
    })
  )
  const adjustmentEntry = await recordAdjustment(session, {
    branchId: branch.id, productId: product.id, batchId: batch.id,
    direction: "out", quantity: 10, transactionType: "adjustment", reason: "P4.2 DR drill fixture consumption",
  })

  // Flush every outbox event queued by the writes above — this is what
  // actually posts the accounting Journal(s) via the central posting
  // service (InvoiceIssued, PaymentReceived, InventoryAdjusted).
  await dispatchPendingOutboxEvents(organization.id)

  // One ClinicalAccessLog fixture row (§15: "if practical") — a direct
  // insert representing a plausible "viewed patient record" access, rather
  // than driving a full page-view request path just to produce one row.
  const accessLog = await db.clinicalAccessLog.create({
    data: { organizationId: organization.id, userId: staffUser.id, patientId: patient.id, resourceType: "patient", resourceId: patient.id, action: "view" },
  })

  const invoiceReloaded = await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
  const journals = await db.journal.findMany({ where: { organizationId: organization.id }, include: { lines: true } })
  const stockBalance = await db.stockLedgerEntry.aggregate({
    where: { organizationId: organization.id, productId: product.id, branchId: branch.id },
    _sum: { quantity: true },
  })

  console.log(`  Fixture created: patient=${patient.id.slice(0, 8)} invoice=${invoice.id.slice(0, 8)} (total=${invoiceReloaded.totalAmount}, paid=${invoiceReloaded.paidAmount}) journals=${journals.length} stockBalance=${stockBalance._sum.quantity}`)

  // --- Phase 3: baseline ------------------------------------------------
  console.log(`\n[3/8] Capturing baseline (counts + reconciliation values)...`)
  const baselineCounts = await captureCounts(drillOwnerUrl, organization.id)
  const baseline = {
    counts: baselineCounts,
    fixtureIds: {
      organizationId: organization.id, branchId: branch.id, productId: product.id,
      patientId: patient.id, appointmentId: appointment.id, encounterId: encounter.id,
      chargeId: charge.id, invoiceId: invoice.id, journalIds: journals.map((j) => j.id),
      adjustmentEntryId: adjustmentEntry.id, accessLogId: accessLog.id,
    },
    patientReconciliation: {
      invoiceTotal: Number(invoiceReloaded.totalAmount).toFixed(2),
      invoicePaid: Number(invoiceReloaded.paidAmount).toFixed(2),
      outstandingBalance: Number(invoiceReloaded.totalAmount.sub(invoiceReloaded.paidAmount)).toFixed(2),
    },
    inventoryReconciliation: {
      // stock_ledger_entry.quantity is numeric(14,3) — format consistently
      // with how raw SQL returns it (see the restored-side query below)
      // rather than Prisma Decimal's own toString(), which drops trailing
      // zeros ("90" vs "90.000") and would make an apples-to-oranges string
      // comparison fail despite the values being numerically identical.
      opening: "0", receipts: "100", adjustmentsOut: "10", expectedClosing: "90.000",
      actualClosing: Number(stockBalance._sum.quantity ?? 0).toFixed(3),
    },
    accountingReconciliation: journals.map((j) => ({
      journalId: j.id, journalNumber: j.journalNumber,
      sumDebit: j.lines.reduce((s, l) => s + Number(l.debit), 0),
      sumCredit: j.lines.reduce((s, l) => s + Number(l.credit), 0),
    })),
  }
  console.log(`  Baseline counts: ${JSON.stringify(baselineCounts)}`)
  for (const j of baseline.accountingReconciliation) {
    if (j.sumDebit !== j.sumCredit) throw new Error(`Baseline journal ${j.journalNumber} does not balance before we even start: debit=${j.sumDebit} credit=${j.sumCredit}`)
  }
  if (baseline.inventoryReconciliation.actualClosing !== baseline.inventoryReconciliation.expectedClosing) {
    throw new Error(`Baseline inventory doesn't match expected closing balance: expected 90, got ${baseline.inventoryReconciliation.actualClosing}`)
  }

  // --- Phase 4: real backup ---------------------------------------------
  console.log(`\n[4/8] Running the real backup mechanism (pg_dump via docker exec ${DOCKER_CONTAINER})...`)
  const backupResult = await runBackup({ label: DRILL_DB, directUrl: drillOwnerUrl, backupDir: "./backups", dockerExecContainer: DOCKER_CONTAINER })
  console.log(`  Backup complete: ${backupResult.filePath} (${backupResult.sizeBytes} bytes)`)

  // --- Phase 5: destructive simulation -----------------------------------
  console.log(`\n[5/8] Simulating a destructive event (post-backup, in the drill-source database only)...`)
  await db.stockLedgerEntry.delete({ where: { id: adjustmentEntry.id } }) // operational record deletion
  await db.patient.update({ where: { id: patient.id }, data: { lastName: "CORRUPTED-BY-DRILL" } }) // deliberate data alteration
  // clinical_access_log cannot be deleted through the restricted runtime
  // role at all (P0-06's own immutability guarantee, empirically proving
  // itself right here) — a real destructive event against it would have to
  // come from elevated/owner-level access (a bad admin script, a
  // misconfigured migration), which this simulates honestly by using the
  // owner connection for this one statement instead of routing around the
  // restriction.
  const destructiveOwnerClient = new Client({ connectionString: drillOwnerUrl })
  await destructiveOwnerClient.connect()
  await destructiveOwnerClient.query('DELETE FROM "clinical_access_log" WHERE id = $1', [accessLog.id])
  await destructiveOwnerClient.end()
  const postDestructionCounts = await captureCounts(drillOwnerUrl, organization.id)
  const differsFromBaseline = Object.keys(baselineCounts).some((k) => baselineCounts[k] !== postDestructionCounts[k])
  const corruptedPatient = await db.patient.findUniqueOrThrow({ where: { id: patient.id } })
  if (!differsFromBaseline || corruptedPatient.lastName !== "CORRUPTED-BY-DRILL") {
    throw new Error("Destructive simulation did not actually change the database state — drill is invalid.")
  }
  console.log(`  Post-destruction counts: ${JSON.stringify(postDestructionCounts)} (confirmed to differ from baseline)`)
  console.log(`  Patient lastName corrupted to: "${corruptedPatient.lastName}" (confirmed)`)

  // --- Phase 6: restore into an isolated database -------------------------
  console.log(`\n[6/8] Restoring into isolated "${RESTORE_DB}" (assertIsSafeRestoreTarget-guarded)...`)
  const restoreOwnerUrl = withDb(directUrl, RESTORE_DB)
  const restoreResult = await runRestore({ backupFilePath: backupResult.filePath, targetDirectUrl: restoreOwnerUrl, dockerExecContainer: DOCKER_CONTAINER })
  console.log(`  Restore complete: target database "${restoreResult.targetDatabase}"`)

  // --- Phase 7: verification -----------------------------------------------
  console.log(`\n[7/8] Verifying the restored database...`)

  // Schema/migration coherence via the REAL Prisma CLI, not a hand-rolled check.
  await runStep("npx", ["prisma", "migrate", "status"], { ...process.env, DIRECT_DATABASE_URL: restoreOwnerUrl })

  // Extension verification.
  const ownerClient = new Client({ connectionString: restoreOwnerUrl })
  await ownerClient.connect()
  const extResult = await ownerClient.query("SELECT extname FROM pg_extension")
  const extensions = extResult.rows.map((r) => r.extname)
  if (!extensions.includes("btree_gist")) throw new Error(`Restored database is missing the required "btree_gist" extension — found: ${extensions.join(", ")}`)
  console.log(`  Extensions present: ${extensions.join(", ")}`)
  await ownerClient.end()

  // Data verification through the RESTRICTED RUNTIME connection (proves
  // the runtime role's grants were genuinely re-established, not just that
  // data exists when read as owner).
  const restoreRuntimeUrl = withCredentials(withDb(runtimeTemplateUrl, RESTORE_DB), "his_app_runtime", "his_app_runtime_dev_only")
  const restoredCounts = await captureCounts(restoreRuntimeUrl, organization.id)
  assertCountsEqual("Restored vs. baseline", baselineCounts, restoredCounts)
  console.log(`  Restored counts match baseline exactly: ${JSON.stringify(restoredCounts)}`)

  const runtimeClient = new Client({ connectionString: restoreRuntimeUrl })
  await runtimeClient.connect()
  try {
    // Specific fixture IDs exist.
    for (const [table, id] of [["patient", patient.id], ["appointment", appointment.id], ["encounter", encounter.id], ["invoice", invoice.id]] as const) {
      const r = await runtimeClient.query(`SELECT id FROM "${table}" WHERE id = $1`, [id])
      if (r.rowCount !== 1) throw new Error(`Restored database is missing expected fixture row: ${table}.id=${id}`)
    }
    // Patient corruption was reverted by the restore (proves restore came
    // from the BACKUP, not from undoing the destructive SQL in place).
    const restoredPatient = await runtimeClient.query('SELECT last_name FROM "patient" WHERE id = $1', [patient.id])
    if (restoredPatient.rows[0].last_name !== "FixturePatient") {
      throw new Error(`Restored patient.lastName is "${restoredPatient.rows[0].last_name}", expected the pre-corruption value "FixturePatient".`)
    }
    console.log(`  Patient reconciliation: restored lastName="${restoredPatient.rows[0].last_name}" (corruption reverted, from backup — not an in-place undo)`)

    // Patient financial reconciliation.
    const invRow = await runtimeClient.query('SELECT total_amount, paid_amount FROM "invoice" WHERE id = $1', [invoice.id])
    const restoredOutstanding = (Number(invRow.rows[0].total_amount) - Number(invRow.rows[0].paid_amount)).toFixed(2)
    if (restoredOutstanding !== baseline.patientReconciliation.outstandingBalance) {
      throw new Error(`Restored outstanding balance ${restoredOutstanding} != baseline ${baseline.patientReconciliation.outstandingBalance}`)
    }
    const allocRow = await runtimeClient.query('SELECT COALESCE(sum(amount),0)::text AS total FROM "payment_allocation" WHERE invoice_id = $1', [invoice.id])
    if (Number(allocRow.rows[0].total).toFixed(2) !== Number(invRow.rows[0].paid_amount).toFixed(2)) {
      throw new Error(`Restored payment_allocation total ${allocRow.rows[0].total} does not match invoice.paid_amount ${invRow.rows[0].paid_amount}`)
    }
    console.log(`  Patient financial reconciliation OK: total=${invRow.rows[0].total_amount} paid=${invRow.rows[0].paid_amount} outstanding=${restoredOutstanding} (matches baseline, and payment_allocation sum reconciles to paid_amount)`)

    // Inventory reconciliation — the deleted adjustment row must be back
    // (restore came from backup, taken BEFORE the destructive delete).
    const stockRow = await runtimeClient.query('SELECT COALESCE(sum(quantity),0)::text AS balance FROM "stock_ledger_entry" WHERE organization_id = $1 AND product_id = $2 AND branch_id = $3', [organization.id, product.id, branch.id])
    if (stockRow.rows[0].balance !== baseline.inventoryReconciliation.actualClosing) {
      throw new Error(`Restored stock balance ${stockRow.rows[0].balance} != baseline ${baseline.inventoryReconciliation.actualClosing}`)
    }
    console.log(`  Inventory reconciliation OK: opening=0 receipts=100 adjustmentsOut=10 restoredClosing=${stockRow.rows[0].balance} (matches expected 90 and baseline)`)

    // Accounting reconciliation — every journal still balances, and matches baseline sums exactly.
    for (const j of baseline.accountingReconciliation) {
      const lineRow = await runtimeClient.query('SELECT COALESCE(sum(debit),0)::text AS d, COALESCE(sum(credit),0)::text AS c FROM "journal_line" WHERE journal_id = $1', [j.journalId])
      const d = Number(lineRow.rows[0].d), c = Number(lineRow.rows[0].c)
      if (d !== c) throw new Error(`Restored journal ${j.journalNumber} does not balance: debit=${d} credit=${c}`)
      if (d !== j.sumDebit || c !== j.sumCredit) throw new Error(`Restored journal ${j.journalNumber} sums (${d}/${c}) don't match baseline (${j.sumDebit}/${j.sumCredit})`)
    }
    console.log(`  Accounting reconciliation OK: ${baseline.accountingReconciliation.length} journal(s), each balanced and matching baseline exactly`)

    // Audit log integrity + runtime role immutability enforcement.
    const auditCountRow = await runtimeClient.query("SELECT count(*)::int AS n FROM audit_log WHERE organization_id = $1", [organization.id])
    console.log(`  audit_log rows restored: ${auditCountRow.rows[0].n} (baseline had ${baselineCounts.auditLog})`)
    let immutabilityHeld = false
    try {
      await runtimeClient.query(
        "UPDATE audit_log SET action = 'tampered' WHERE id = (SELECT id FROM audit_log WHERE organization_id = $1 LIMIT 1)",
        [organization.id]
      )
    } catch {
      immutabilityHeld = true
    }
    if (!immutabilityHeld) throw new Error("SECURITY REGRESSION: the restricted runtime role was able to UPDATE audit_log after restore — grants were not correctly re-established.")
    console.log(`  Runtime DB role verification OK: UPDATE against audit_log correctly rejected post-restore (grants re-established via local-grant-runtime-role.sql)`)

    // Sequence/identity: confirm number_sequence rows survived, then prove
    // no PK collision by inserting and cleaning up one throwaway row.
    const seqRow = await runtimeClient.query("SELECT count(*)::int AS n FROM number_sequence WHERE organization_id = $1", [organization.id])
    console.log(`  number_sequence rows restored: ${seqRow.rows[0].n}`)
    const throwawayId = "00000000-dddd-4444-8888-000000000001"
    await runtimeClient.query(
      'INSERT INTO "patient" (id, organization_id, registration_branch_id, mrn, first_name, last_name, dob, gender, mobile, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())',
      [throwawayId, organization.id, branch.id, "DRILL-SEQ-CHECK", "Sequence", "Check", "1990-01-01", "unknown", "DRILL-SEQ-MOBILE"]
    )
    await runtimeClient.query('DELETE FROM "patient" WHERE id = $1', [throwawayId])
    console.log(`  Sequence/identity check OK: post-restore insert (UUID PK) succeeded with no collision, cleaned up`)
  } finally {
    await runtimeClient.end()
  }

  // --- Phase 8: cleanup ------------------------------------------------
  if (process.env.DR_DRILL_KEEP_DATABASES === "1") {
    console.log(`\n[8/8] DR_DRILL_KEEP_DATABASES=1 — leaving "${DRILL_DB}" and "${RESTORE_DB}" in place (e.g. for a manual application-boot check against the restored DB). Drop them by hand when done.`)
  } else {
    console.log(`\n[8/8] Cleaning up (dropping both scratch databases)...`)
    // Close our own Prisma pool against his_dr_drill first — WITH (FORCE)
    // below would handle lingering connections anyway, but disconnecting
    // cleanly is the well-behaved order.
    await db.$disconnect()
    const cleanupClient = new Client({ connectionString: maintenanceUrl })
    await cleanupClient.connect()
    await cleanupClient.query(`DROP DATABASE IF EXISTS "${DRILL_DB}" WITH (FORCE)`)
    await cleanupClient.query(`DROP DATABASE IF EXISTS "${RESTORE_DB}" WITH (FORCE)`)
    await cleanupClient.end()
    console.log(`  Dropped "${DRILL_DB}" and "${RESTORE_DB}".`)
  }

  const summary = {
    ranAt: new Date().toISOString(),
    backup: { filePath: backupResult.filePath, sizeBytes: backupResult.sizeBytes, postgresVersion: backupResult.postgresVersion.split(",")[0], migrationCount: backupResult.migrationCount },
    baselineCounts,
    postDestructionCounts,
    restoredCounts,
    baseline,
  }
  mkdirSync("./backups", { recursive: true })
  const summaryPath = path.resolve("./backups", `dr-drill-summary-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2))

  console.log("\n" + "=".repeat(70))
  console.log("P4.2 Disaster Recovery Drill — PASSED")
  console.log(`Summary written to ${summaryPath}`)
  console.log("=".repeat(70))
}

main().catch((err) => {
  console.error(`\nDR drill FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
  process.exit(1)
})
