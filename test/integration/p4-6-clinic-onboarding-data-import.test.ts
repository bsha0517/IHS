import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { getOnboardingStatus } from "@/lib/domains/onboarding/readiness"
import { getImporter } from "@/lib/domains/onboarding/imports/registry"
import { runDryRun, runCommit, ImportValidationError } from "@/lib/platform/import/engine"
import { toCsv } from "@/lib/platform/import/csv"
import { setMapping } from "@/lib/domains/accounting/account-mappings"
import { setSetting, PHARMACY_ENABLED_KEY } from "@/lib/platform/settings"
import { createBranch } from "@/lib/domains/identity/org-structure"
import { createService } from "@/lib/domains/services/service"
import { createProvider } from "@/lib/domains/providers/service"
import { bookAppointment, checkIn } from "@/lib/domains/appointments/service"
import { startEncounter } from "@/lib/domains/clinical/encounters"
import { generateSystemCharge } from "@/lib/domains/billing/charges"
import { generateInvoice } from "@/lib/domains/billing/invoices"
import { recordPayment } from "@/lib/domains/billing/payments"
import { openSession as openCashierSession } from "@/lib/domains/billing/cashier"
import type { SessionContext } from "@/lib/auth/session"

const TIMEOUT = 60000

// The two fixture legalNames this suite ever creates — shared between the
// real afterAll and the beforeAll self-healing sweep below.
const FIXTURE_ORG_NAMES = ["P4.6 Fresh Clinic LLC", "P4.6 Other Org LLC"]

/**
 * FK-safe deletion of everything under the given organization id(s) — the
 * same order this suite's afterAll always used, factored out so the
 * beforeAll orphan sweep (see `cleanupOrphanedFixtureOrgs`) can reuse it
 * verbatim instead of drifting out of sync with a second copy. Does not
 * disconnect `db` — callers that are done with the client for good do that
 * themselves.
 */
async function deleteOrgData(orgIds: string[]) {
  if (orgIds.length === 0) return
  // audit_log and clinical_access_log are both append-only for the
  // restricted app runtime role (no UPDATE/DELETE grant — the same
  // tamper-evidence design as every other audit-style table in this
  // schema), so both must go through the owner-role connection.
  const ownerDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DIRECT_DATABASE_URL }) })
  await ownerDb.auditLog.deleteMany({ where: { organizationId: { in: orgIds } } })
  await ownerDb.clinicalAccessLog.deleteMany({ where: { organizationId: { in: orgIds } } })
  await ownerDb.$disconnect()

  await db.importJobError.deleteMany({ where: { job: { organizationId: { in: orgIds } } } })
  await db.importJob.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.journalLine.deleteMany({ where: { journal: { organizationId: { in: orgIds } } } })
  await db.journal.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.queueEntry.deleteMany({ where: { appointment: { organizationId: { in: orgIds } } } })
  await db.appointmentStatusHistory.deleteMany({ where: { appointment: { organizationId: { in: orgIds } } } })
  await db.encounter.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.paymentAllocation.deleteMany({ where: { payment: { organizationId: { in: orgIds } } } })
  await db.payment.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.cashMovement.deleteMany({ where: { cashierSession: { organizationId: { in: orgIds } } } })
  await db.cashierSession.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.invoiceLine.deleteMany({ where: { invoice: { organizationId: { in: orgIds } } } })
  await db.invoice.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.charge.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.appointment.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.patient.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.stockLedgerEntry.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.productBatch.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.medication.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.product.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.supplier.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.employee.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.providerBranch.deleteMany({ where: { provider: { organizationId: { in: orgIds } } } })
  await db.provider.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.service.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.accountMapping.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.setting.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.chartOfAccount.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.userRole.deleteMany({ where: { user: { organizationId: { in: orgIds } } } })
  await db.user.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.role.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.numberSequence.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.outboxEvent.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.notification.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.idempotencyKey.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.department.deleteMany({ where: { branch: { organizationId: { in: orgIds } } } })
  await db.branch.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.organization.deleteMany({ where: { id: { in: orgIds } } })
}

/**
 * Self-healing safety net (see the beforeAll call site): if an earlier run
 * of this suite was interrupted before its own afterAll could execute, its
 * org(s) — recognizable by these exact fixture legalNames, which no other
 * suite uses — are still in the database. Left alone, they silently
 * accumulate across every interrupted run and can leak into unrelated
 * tests that query "any" org/branch (e.g. `findFirstOrThrow()` with no
 * filter picks whichever row Postgres returns first). Sweep them before
 * this run creates its own fixtures.
 */
async function cleanupOrphanedFixtureOrgs() {
  const orphans = await db.organization.findMany({ where: { legalName: { in: FIXTURE_ORG_NAMES } }, select: { id: true } })
  if (orphans.length > 0) await deleteOrgData(orphans.map((o) => o.id))
}

/**
 * P4.6 (Data Import / Clinic Onboarding / Initial Setup) — a genuinely
 * fresh, isolated organization fixture (§62's own explicit "do not rely
 * only on the large existing seed"), proving: readiness starts incomplete
 * and becomes ready as real setup/imports happen; every high-priority
 * importer's dry-run/commit/duplicate/idempotency behavior; opening
 * inventory's ledger-correctness and expired-stock rejection; tenant
 * isolation; and a fresh-clinic smoke workflow end to end.
 */
describe("P4.6: clinic onboarding & data import", () => {
  let orgAId: string
  let orgBId: string // a second, isolated organization — cross-org reference/isolation proofs only
  let branchAId: string
  let adminUserId: string
  let providerId: string
  let serviceId: string
  const createdPatientIds: string[] = []
  const createdImportJobIds: string[] = []

  function adminSession(): SessionContext {
    return {
      sessionId: "test-p4-6-admin",
      user: { id: adminUserId, organizationId: orgAId, email: "p4-6-admin@test.local", firstName: "P4.6", lastName: "Admin" },
      activeBranchId: branchAId,
      branchIds: [branchAId],
      permissions: new Set([
        "data_import.manage", "settings.view", "settings.edit", "branch.view", "branch.manage",
        "department.view", "department.manage", "users.manage", "provider.view", "provider.manage",
        "service.view", "service.manage", "product.manage", "supplier.manage", "employee.manage",
        "accounting.view", "account_mapping.manage", "inventory.view", "inventory.adjust",
        "patient.view", "patient.create", "appointment.view", "appointment.create", "appointment.checkin",
        "encounter.view", "encounter.create", "encounter.finalize", "charge.create",
        "invoice.view", "invoice.create", "payment.view", "payment.create", "cashier.open", "cashier.view",
      ]),
      roleNames: ["Organization Administrator"],
    }
  }

  beforeAll(async () => {
    // Self-healing guard: if a PRIOR run of this suite was interrupted
    // (Ctrl-C, a timeout, a crash) before its own afterAll could run, its
    // org(s) — with these exact fixture legalNames — are still sitting in
    // the test database and would otherwise silently accumulate forever,
    // eventually colluding with unrelated tests that pick "any" org/branch
    // (e.g. `findFirstOrThrow()` with no filter). Sweep and remove any such
    // leftovers, using the same owner-role connection + FK-safe order as
    // this suite's own afterAll, before creating this run's fixtures.
    await cleanupOrphanedFixtureOrgs()

    // A real, brand-new Organization — not the shared seeded one — so
    // readiness genuinely starts from zero.
    const org = await db.organization.create({
      data: { legalName: "P4.6 Fresh Clinic LLC", displayName: "P4.6 Fresh Clinic" },
    })
    orgAId = org.id
    const orgB = await db.organization.create({ data: { legalName: "P4.6 Other Org LLC", displayName: "P4.6 Other Org" } })
    orgBId = orgB.id

    const role = await db.role.create({ data: { organizationId: orgAId, name: "P4.6 Org Admin" } })
    const permission = await db.permission.findUniqueOrThrow({ where: { code: "users.manage" } })
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } })
    const admin = await db.user.create({
      data: { organizationId: orgAId, email: `p4-6-admin-${Date.now()}@test.local`, passwordHash: "x", firstName: "P4.6", lastName: "Admin" },
    })
    adminUserId = admin.id
    await db.userRole.create({ data: { userId: admin.id, roleId: role.id } })
  }, TIMEOUT)

  afterAll(async () => {
    // Explicit id-scoped deletes first (belt-and-suspenders in case an
    // in-memory tracked id ever diverges from its organizationId), then the
    // shared FK-safe org-scoped sweep for everything else — which is what
    // actually removes createdPatientIds' rows too (via organizationId),
    // in the correct position relative to clinical_access_log.
    await db.importJobError.deleteMany({ where: { job: { id: { in: createdImportJobIds } } } })
    await db.importJob.deleteMany({ where: { id: { in: createdImportJobIds } } })
    await deleteOrgData([orgAId, orgBId])
    await db.$disconnect()
  }, TIMEOUT)

  describe("§62 fresh-organization onboarding readiness", () => {
    it("before any setup: readiness reports the real, missing requirements", async () => {
      const status = await getOnboardingStatus(adminSession())
      expect(status.operationallyReady).toBe(false)
      const branchItem = status.items.find((i) => i.label === "Active branch")
      expect(branchItem?.completed).toBe(false)
      const providerItem = status.items.find((i) => i.label === "Providers")
      expect(providerItem?.completed).toBe(false)
      const mappingItem = status.items.find((i) => i.label === "Accounting mappings")
      expect(mappingItem?.completed).toBe(false)
    }, TIMEOUT)

    it("after setup: readiness reflects the real, now-complete configuration", async () => {
      const branch = await createBranch(adminSession(), { name: "Main Branch", code: "MAIN", timezone: "Asia/Dubai" })
      branchAId = branch.id
      const provider = await createProvider({ ...adminSession(), activeBranchId: branchAId, branchIds: [branchAId] }, {
        providerType: "doctor", firstName: "P4.6", lastName: "Doctor", consultationFee: 100, defaultAppointmentDurationMinutes: 30, branchIds: [branchAId], departmentIds: [],
      })
      providerId = provider.id
      const service = await createService(adminSession(), { code: "P46-CONS", name: "P4.6 Consultation", category: "Consultation", durationMinutes: 30, price: 100, billable: true, isActive: true, providerIds: [] })
      serviceId = service.id

      // This fresh org has no chart of accounts yet (only the shared seeded
      // org gets the default one) — create the 3 minimal accounts
      // setMapping needs directly.
      const [ar, revenue, cash] = await Promise.all([
        db.chartOfAccount.create({ data: { organizationId: orgAId, code: "P46-AR", name: "P4.6 AR", type: "asset" } }),
        db.chartOfAccount.create({ data: { organizationId: orgAId, code: "P46-REV", name: "P4.6 Revenue", type: "revenue" } }),
        db.chartOfAccount.create({ data: { organizationId: orgAId, code: "P46-CASH", name: "P4.6 Cash", type: "asset" } }),
      ])
      await setMapping(adminSession(), { intent: "accounts_receivable", accountId: ar.id, branchId: null })
      await setMapping(adminSession(), { intent: "revenue", accountId: revenue.id, branchId: null })
      await setMapping(adminSession(), { intent: "cash", accountId: cash.id, branchId: null })
      // A real operational (non-administrator) user — "Operational users" requires more than just the one bootstrap admin.
      await db.user.create({ data: { organizationId: orgAId, email: `p4-6-reception-${Date.now()}@test.local`, passwordHash: "x", firstName: "P4.6", lastName: "Reception" } })
      // This fresh clinic is consultation-only, no dispensing — pharmacy/inventory readiness items are correctly gated off rather than required (§5's own "do not require modules a clinic does not intend to use").
      await setSetting(adminSession(), PHARMACY_ENABLED_KEY, false)

      const status = await getOnboardingStatus(adminSession())
      expect(status.items.find((i) => i.label === "Active branch")?.completed).toBe(true)
      expect(status.items.find((i) => i.label === "Providers")?.completed).toBe(true)
      expect(status.items.find((i) => i.label === "Services")?.completed).toBe(true)
      expect(status.items.find((i) => i.label === "Accounting mappings")?.completed).toBe(true)
      expect(status.items.find((i) => i.label === "Administrator account")?.completed).toBe(true)
      expect(status.operationallyReady).toBe(true)
    }, TIMEOUT)
  })

  describe("§63 patient import", () => {
    it("clean import: dry run classifies rows correctly and creates no Patients; commit creates exactly the valid rows", async () => {
      const csv = toCsv(
        ["firstName", "lastName", "dob", "gender", "mobile", "branchCode"],
        [
          ["Alice", "Anderson", "1990-01-01", "female", "P46-M-0001", "MAIN"],
          ["Bob", "Brown", "1985-05-05", "male", "P46-M-0002", "MAIN"],
        ]
      )
      const importer = await getImporter(adminSession(), "patients")
      const before = await db.patient.count({ where: { organizationId: orgAId } })

      const { jobId, summary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "patients.csv" })
      createdImportJobIds.push(jobId)
      expect(summary.validRows).toBe(2)
      expect(summary.invalidRows).toBe(0)
      const afterDryRun = await db.patient.count({ where: { organizationId: orgAId } })
      expect(afterDryRun).toBe(before) // dry run creates no Patients

      const result = await runCommit(adminSession(), importer, { jobId, fileText: csv })
      expect(result.status).toBe("completed")
      expect(result.importedRows).toBe(2)
      const afterCommit = await db.patient.count({ where: { organizationId: orgAId } })
      expect(afterCommit).toBe(before + 2)

      const created = await db.patient.findMany({ where: { organizationId: orgAId, mobile: { in: ["P46-M-0001", "P46-M-0002"] } } })
      createdPatientIds.push(...created.map((p) => p.id))
      // A real, sequence-generated Avant MRN — never blank, never client-supplied.
      for (const p of created) expect(p.mrn).toMatch(/^MRN-\d{6,}$/)
    }, TIMEOUT)

    it("invalid required field and invalid date are both reported with a field-level, human-readable message", async () => {
      const csv = toCsv(
        ["firstName", "lastName", "dob", "gender", "mobile", "branchCode"],
        [
          ["", "Missing", "1990-01-01", "female", "P46-M-0003", "MAIN"], // missing firstName
          ["Dana", "Baddate", "02/30/2026", "female", "P46-M-0004", "MAIN"], // ambiguous/invalid date
        ]
      )
      const importer = await getImporter(adminSession(), "patients")
      const { jobId, summary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "patients-invalid.csv" })
      createdImportJobIds.push(jobId)
      expect(summary.invalidRows).toBe(2)
      expect(summary.validRows).toBe(0)
      const errors = await db.importJobError.findMany({ where: { jobId } })
      expect(errors.some((e) => e.errorCode === "REQUIRED_FIELD" && e.field === "firstName")).toBe(true)
      expect(errors.some((e) => e.errorCode === "INVALID_DATE" && e.field === "dob")).toBe(true)
      // Never a raw Prisma/stack-trace-shaped message.
      for (const e of errors) expect(e.message).not.toMatch(/PrismaClient|at Object\.|node_modules/)
    }, TIMEOUT)

    it("duplicate detection (matches an existing patient's mobile) marks the row duplicate, not imported", async () => {
      const csv = toCsv(["firstName", "lastName", "dob", "gender", "mobile", "branchCode"], [["Alice", "Duplicate", "1999-09-09", "female", "P46-M-0001", "MAIN"]])
      const importer = await getImporter(adminSession(), "patients")
      const { jobId, summary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "patients-dup.csv" })
      createdImportJobIds.push(jobId)
      expect(summary.duplicateRows).toBe(1)
      const before = await db.patient.count({ where: { organizationId: orgAId } })
      const result = await runCommit(adminSession(), importer, { jobId, fileText: csv })
      expect(result.importedRows).toBe(0)
      expect(result.skippedRows).toBe(1)
      const after = await db.patient.count({ where: { organizationId: orgAId } })
      expect(after).toBe(before) // no duplicate created
    }, TIMEOUT)

    it("unknown branchCode is reported as an invalid reference, not silently dropped or defaulted", async () => {
      const csv = toCsv(["firstName", "lastName", "dob", "gender", "mobile", "branchCode"], [["Eve", "Nobranch", "1992-02-02", "female", "P46-M-0099", "NOSUCHBRANCH"]])
      const importer = await getImporter(adminSession(), "patients")
      const { summary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "patients-unknownbranch.csv" })
      expect(summary.invalidRows).toBe(1)
    }, TIMEOUT)

    it("50+ row import: dry run and commit both handle a realistic batch correctly", async () => {
      const rows = Array.from({ length: 55 }, (_, i) => [`Bulk${i}`, "Patient", "1988-08-08", "unknown", `P46-BULK-${i}`, "MAIN"])
      const csv = toCsv(["firstName", "lastName", "dob", "gender", "mobile", "branchCode"], rows)
      const importer = await getImporter(adminSession(), "patients")
      const { jobId, summary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "patients-bulk.csv" })
      createdImportJobIds.push(jobId)
      expect(summary.totalRows).toBe(55)
      expect(summary.validRows).toBe(55)
      const result = await runCommit(adminSession(), importer, { jobId, fileText: csv })
      expect(result.importedRows).toBe(55)
      const created = await db.patient.findMany({ where: { organizationId: orgAId, mobile: { startsWith: "P46-BULK-" } } })
      createdPatientIds.push(...created.map((p) => p.id))
    }, TIMEOUT)

    it("P4.9 §31: a 250-row import genuinely crosses the engine's 200-row COMMIT_BATCH_SIZE boundary — both batches commit, no data loss", async () => {
      // Prior coverage only exercised 55 rows (a single batch). This is the
      // first test to actually cross COMMIT_BATCH_SIZE (engine.ts, 200),
      // proving runCommit's batch-loop really does span multiple
      // `db.$transaction` calls for one job and that every row from both
      // batches lands, not just the first.
      const rows = Array.from({ length: 250 }, (_, i) => [`P49Batch${i}`, "Patient", "1990-01-01", "unknown", `P49-BATCH-${i}`, "MAIN"])
      const csv = toCsv(["firstName", "lastName", "dob", "gender", "mobile", "branchCode"], rows)
      const importer = await getImporter(adminSession(), "patients")
      const { jobId, summary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "patients-p49-250.csv" })
      createdImportJobIds.push(jobId)
      expect(summary.totalRows).toBe(250)
      expect(summary.validRows).toBe(250)
      const result = await runCommit(adminSession(), importer, { jobId, fileText: csv })
      expect(result.totalBatches).toBe(2) // 200 + 50
      expect(result.failedAtBatch).toBeUndefined()
      expect(result.importedRows).toBe(250)
      const created = await db.patient.findMany({ where: { organizationId: orgAId, mobile: { startsWith: "P49-BATCH-" } } })
      expect(created).toHaveLength(250)
      createdPatientIds.push(...created.map((p) => p.id))
      const job = await db.importJob.findUniqueOrThrow({ where: { id: jobId } })
      expect(job.status).toBe("completed")
      expect(job.importedRows).toBe(250)
    }, TIMEOUT)

    it("P4.9 §31: a fresh retry submission after a job already has committed rows never re-creates them — duplicate detection spans jobs, not just within one file", async () => {
      // Simulates the operationally-relevant half of "interrupted batch +
      // retry": rather than fabricating a mid-transaction crash (there is no
      // safe way to do that without modifying engine.ts itself — see
      // P4_9_COMMERCIAL_READINESS_ACCEPTANCE_REPORT.md's Import/Retry
      // section for the full reasoning), this proves the actual safety
      // property end to end: once ANY rows are genuinely committed (job A,
      // below), a completely separate, later import job (job B — the
      // "retry," a fresh dry-run + commit, exactly what an operator does
      // after engine.ts marks a failed job un-recommittable) that includes
      // some of the same people is correctly detected as duplicate and
      // skipped, never re-inserted. Composed with the batch-boundary test
      // above (multi-batch commits work) and the existing "double-submit
      // rejected outright" test (the same job can't be re-committed), this
      // covers the full interrupted-import-then-retry guarantee without
      // needing an artificial crash injection point in production code.
      const firstRows = Array.from({ length: 5 }, (_, i) => [`P49Retry${i}`, "First", "1985-05-05", "unknown", `P49-RETRY-${i}`, "MAIN"])
      const firstCsv = toCsv(["firstName", "lastName", "dob", "gender", "mobile", "branchCode"], firstRows)
      const importer = await getImporter(adminSession(), "patients")
      const jobA = await runDryRun(adminSession(), importer, { fileText: firstCsv, fileName: "patients-p49-retry-a.csv" })
      createdImportJobIds.push(jobA.jobId)
      const resultA = await runCommit(adminSession(), importer, { jobId: jobA.jobId, fileText: firstCsv })
      expect(resultA.importedRows).toBe(5)
      const committedA = await db.patient.findMany({ where: { organizationId: orgAId, mobile: { startsWith: "P49-RETRY-" } } })
      createdPatientIds.push(...committedA.map((p) => p.id))

      // Job B: a "retry" file with the same 5 rows (as if re-exported from
      // whatever source system produced job A) plus 2 genuinely new rows.
      const retryRows = [...firstRows, ["P49RetryNew0", "Second", "1986-06-06", "unknown", "P49-RETRY-NEW-0", "MAIN"], ["P49RetryNew1", "Second", "1986-06-06", "unknown", "P49-RETRY-NEW-1", "MAIN"]]
      const retryCsv = toCsv(["firstName", "lastName", "dob", "gender", "mobile", "branchCode"], retryRows)
      const jobB = await runDryRun(adminSession(), importer, { fileText: retryCsv, fileName: "patients-p49-retry-b.csv" })
      createdImportJobIds.push(jobB.jobId)
      expect(jobB.summary.duplicateRows).toBe(5) // the 5 already-committed rows, detected against the DB job A just wrote
      expect(jobB.summary.validRows).toBe(2)
      const resultB = await runCommit(adminSession(), importer, { jobId: jobB.jobId, fileText: retryCsv })
      expect(resultB.importedRows).toBe(2)
      expect(resultB.skippedRows).toBe(5)
      // No duplicates were created: still exactly 1 patient per original mobile.
      for (const p of committedA) {
        const count = await db.patient.count({ where: { organizationId: orgAId, mobile: p.mobile! } })
        expect(count).toBe(1)
      }
      const newOnes = await db.patient.findMany({ where: { organizationId: orgAId, mobile: { startsWith: "P49-RETRY-NEW-" } } })
      expect(newOnes).toHaveLength(2)
      createdPatientIds.push(...newOnes.map((p) => p.id))
    }, TIMEOUT)

    it("a repeated commit of the same file (double-submit/retry) is rejected outright — no duplicate rows", async () => {
      const csv = toCsv(["firstName", "lastName", "dob", "gender", "mobile", "branchCode"], [["Idem", "Potent", "1991-01-01", "other", "P46-M-IDEM", "MAIN"]])
      const importer = await getImporter(adminSession(), "patients")
      const { jobId } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "patients-idem.csv" })
      createdImportJobIds.push(jobId)
      const first = await runCommit(adminSession(), importer, { jobId, fileText: csv })
      expect(first.importedRows).toBe(1)
      await expect(runCommit(adminSession(), importer, { jobId, fileText: csv })).rejects.toThrow(ImportValidationError)
      const count = await db.patient.count({ where: { organizationId: orgAId, mobile: "P46-M-IDEM" } })
      expect(count).toBe(1)
      const created = await db.patient.findFirstOrThrow({ where: { organizationId: orgAId, mobile: "P46-M-IDEM" } })
      createdPatientIds.push(created.id)
    }, TIMEOUT)

    it("cross-org isolation: an admin from a different organization cannot dry-run/commit into orgA, and branchCode never resolves across organizations", async () => {
      const otherRole = await db.role.create({ data: { organizationId: orgBId, name: "P4.6 Other Admin" } })
      const permission = await db.permission.findUniqueOrThrow({ where: { code: "data_import.manage" } })
      await db.rolePermission.create({ data: { roleId: otherRole.id, permissionId: permission.id } })
      const otherUser = await db.user.create({ data: { organizationId: orgBId, email: `p4-6-otheradmin-${Date.now()}@test.local`, passwordHash: "x", firstName: "Other", lastName: "Admin" } })
      await db.userRole.create({ data: { userId: otherUser.id, roleId: otherRole.id } })
      const otherSession: SessionContext = {
        sessionId: "test-p4-6-other",
        user: { id: otherUser.id, organizationId: orgBId, email: "other@test.local", firstName: "Other", lastName: "Admin" },
        activeBranchId: null,
        branchIds: [],
        permissions: new Set(["data_import.manage"]),
        roleNames: ["Other Org Admin"],
      }

      // orgB has no branch named MAIN — the SAME csv that worked for orgA must fail reference resolution for orgB.
      const csv = toCsv(["firstName", "lastName", "dob", "gender", "mobile", "branchCode"], [["Cross", "Org", "1990-01-01", "unknown", "P46-M-CROSS", "MAIN"]])
      const otherImporter = await getImporter(otherSession, "patients")
      const { jobId: otherJobId, summary } = await runDryRun(otherSession, otherImporter, { fileText: csv, fileName: "cross.csv" })
      createdImportJobIds.push(otherJobId)
      expect(summary.invalidRows).toBe(1) // MAIN branch belongs to orgA, not orgB — never resolved across organizations

      // The commit endpoint itself also refuses a job that doesn't belong to the caller's own organization.
      const ownImporter = await getImporter(adminSession(), "patients")
      const { jobId: ownJobId } = await runDryRun(adminSession(), ownImporter, { fileText: csv, fileName: "own.csv" })
      createdImportJobIds.push(ownJobId)
      await expect(runCommit(otherSession, ownImporter, { jobId: ownJobId, fileText: csv })).rejects.toThrow(ImportValidationError)

      // otherUser/otherRole are cleaned up by the outer afterAll (by
      // organizationId, after import jobs are deleted) — this test's own
      // ImportJob rows reference otherUser.id via started_by, so deleting
      // the user here (before those jobs are gone) would violate the FK.
      void otherRole
    }, TIMEOUT)

    it("error report contains only row/field/code/message — never raw source-row field values", async () => {
      const csv = toCsv(["firstName", "lastName", "dob", "gender", "mobile", "branchCode"], [["", "Sensitive Name Co", "not-a-date", "female", "SENSITIVE-PHONE-999", "MAIN"]])
      const importer = await getImporter(adminSession(), "patients")
      const { jobId } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "patients-safe-errors.csv" })
      createdImportJobIds.push(jobId)
      const errors = await db.importJobError.findMany({ where: { jobId } })
      expect(errors.length).toBeGreaterThan(0)
      for (const e of errors) {
        expect(e.message).not.toContain("SENSITIVE-PHONE-999")
        expect(e.message).not.toContain("Sensitive Name Co")
      }
    }, TIMEOUT)
  })

  describe("§64 product / service / supplier import", () => {
    it("products: valid row, invalid row, duplicate SKU, dry run, commit, repeat-commit idempotency", async () => {
      const importer = await getImporter(adminSession(), "products")
      const csv = toCsv(["sku", "name", "category", "unit", "purchaseCost"], [["P46-SKU-1", "P4.6 Bandage", "supply", "box", "5.50"]])
      const { jobId, summary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "products.csv" })
      createdImportJobIds.push(jobId)
      expect(summary.validRows).toBe(1)
      const result = await runCommit(adminSession(), importer, { jobId, fileText: csv })
      expect(result.importedRows).toBe(1)

      const invalidCsv = toCsv(["sku", "name", "category", "unit", "purchaseCost"], [["P46-SKU-2", "", "supply", "box", "-5"]])
      const { summary: invalidSummary } = await runDryRun(adminSession(), importer, { fileText: invalidCsv, fileName: "products-invalid.csv" })
      expect(invalidSummary.invalidRows).toBe(1)

      const { jobId: dupJobId, summary: dupSummary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "products-dup.csv" })
      createdImportJobIds.push(dupJobId)
      expect(dupSummary.duplicateRows).toBe(1)
      const dupResult = await runCommit(adminSession(), importer, { jobId: dupJobId, fileText: csv })
      expect(dupResult.importedRows).toBe(0)
      const count = await db.product.count({ where: { organizationId: orgAId, sku: "P46-SKU-1" } })
      expect(count).toBe(1) // repeat commit never doubles the product
    }, TIMEOUT)

    it("suppliers: valid row, duplicate code, dry run, commit", async () => {
      const importer = await getImporter(adminSession(), "suppliers")
      const csv = toCsv(["code", "companyName"], [["P46-SUP-1", "P4.6 Medical Supplies Co"]])
      const { jobId, summary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "suppliers.csv" })
      createdImportJobIds.push(jobId)
      expect(summary.validRows).toBe(1)
      const result = await runCommit(adminSession(), importer, { jobId, fileText: csv })
      expect(result.importedRows).toBe(1)
      const { summary: dupSummary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "suppliers-dup.csv" })
      expect(dupSummary.duplicateRows).toBe(1)
    }, TIMEOUT)

    it("services: unknown department reference is reported, valid row commits", async () => {
      const importer = await getImporter(adminSession(), "services")
      const badCsv = toCsv(["code", "name", "category", "durationMinutes", "price", "department"], [["P46-SVC-BAD", "Bad Dept Service", "General", "20", "50", "No Such Dept"]])
      const { summary: badSummary } = await runDryRun(adminSession(), importer, { fileText: badCsv, fileName: "services-bad.csv" })
      expect(badSummary.invalidRows).toBe(1)

      const csv = toCsv(["code", "name", "category", "durationMinutes", "price"], [["P46-SVC-1", "P4.6 Follow-up", "General", "15", "50"]])
      const { jobId, summary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "services.csv" })
      createdImportJobIds.push(jobId)
      expect(summary.validRows).toBe(1)
      const result = await runCommit(adminSession(), importer, { jobId, fileText: csv })
      expect(result.importedRows).toBe(1)
    }, TIMEOUT)
  })

  describe("§65 opening inventory", () => {
    it("creates a real ProductBatch + StockLedgerEntry with correct quantity/cost/branch/expiry, traceable to the ImportJob", async () => {
      const product = await db.product.create({ data: { organizationId: orgAId, sku: "P46-OI-1", name: "P4.6 Opening Item", category: "supply", unit: "unit", purchaseCost: 10 } })
      const importer = await getImporter(adminSession(), "opening_inventory")
      const csv = toCsv(
        ["sku", "branchCode", "batchNumber", "quantity", "unitCost", "expiryDate"],
        [["P46-OI-1", "MAIN", "P46-BATCH-1", "40", "12.50", "2030-01-01"]]
      )
      const { jobId, summary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "opening.csv" })
      createdImportJobIds.push(jobId)
      expect(summary.validRows).toBe(1)
      const result = await runCommit(adminSession(), importer, { jobId, fileText: csv })
      expect(result.importedRows).toBe(1)

      const batch = await db.productBatch.findFirstOrThrow({ where: { organizationId: orgAId, productId: product.id, batchNumber: "P46-BATCH-1" } })
      expect(Number(batch.purchaseCost)).toBe(12.5)
      expect(batch.expiryDate?.toISOString().slice(0, 10)).toBe("2030-01-01")

      const ledger = await db.stockLedgerEntry.findFirstOrThrow({ where: { organizationId: orgAId, batchId: batch.id } })
      expect(Number(ledger.quantity)).toBe(40)
      expect(ledger.branchId).toBe(branchAId)
      expect(ledger.referenceType).toBe("opening_balance")
      expect(ledger.referenceId).toBe(jobId) // traceable to the import job
    }, TIMEOUT)

    it("expired stock is rejected — never becomes available/FEFO-eligible inventory", async () => {
      const importer = await getImporter(adminSession(), "opening_inventory")
      const csv = toCsv(["sku", "branchCode", "batchNumber", "quantity", "unitCost", "expiryDate"], [["P46-OI-1", "MAIN", "P46-BATCH-EXPIRED", "10", "5", "2020-01-01"]])
      const { summary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "opening-expired.csv" })
      expect(summary.invalidRows).toBe(1)
      const batch = await db.productBatch.findFirst({ where: { organizationId: orgAId, batchNumber: "P46-BATCH-EXPIRED" } })
      expect(batch).toBeNull() // never created
    }, TIMEOUT)

    it("missing cost fails validation rather than defaulting to zero", async () => {
      const importer = await getImporter(adminSession(), "opening_inventory")
      const csv = toCsv(["sku", "branchCode", "batchNumber", "quantity", "unitCost"], [["P46-OI-1", "MAIN", "P46-BATCH-NOCOST", "10", ""]])
      const { summary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "opening-nocost.csv" })
      expect(summary.invalidRows).toBe(1)
    }, TIMEOUT)

    it("negative and zero quantity are both rejected", async () => {
      const importer = await getImporter(adminSession(), "opening_inventory")
      const csv = toCsv(
        ["sku", "branchCode", "batchNumber", "quantity", "unitCost"],
        [
          ["P46-OI-1", "MAIN", "P46-BATCH-NEG", "-5", "5"],
          ["P46-OI-1", "MAIN", "P46-BATCH-ZERO", "0", "5"],
        ]
      )
      const { summary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "opening-badqty.csv" })
      expect(summary.invalidRows).toBe(2)
    }, TIMEOUT)

    it("a cross-org product SKU can never be referenced by an opening-inventory import", async () => {
      const otherProduct = await db.product.create({ data: { organizationId: orgBId, sku: "P46-CROSS-SKU", name: "Other Org Product", category: "supply", unit: "unit", purchaseCost: 1 } })
      const importer = await getImporter(adminSession(), "opening_inventory")
      const csv = toCsv(["sku", "branchCode", "batchNumber", "quantity", "unitCost"], [["P46-CROSS-SKU", "MAIN", "P46-BATCH-CROSS", "10", "5"]])
      const { summary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "opening-cross.csv" })
      expect(summary.invalidRows).toBe(1) // resolved against orgA's own product map only — orgB's SKU is invisible
      await db.product.delete({ where: { id: otherProduct.id } })
    }, TIMEOUT)

    it("repeat commit of the same opening-inventory file does not double stock", async () => {
      const importer = await getImporter(adminSession(), "opening_inventory")
      const csv = toCsv(["sku", "branchCode", "batchNumber", "quantity", "unitCost"], [["P46-OI-1", "MAIN", "P46-BATCH-REPEAT", "20", "5"]])
      const { jobId } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "opening-repeat.csv" })
      createdImportJobIds.push(jobId)
      await runCommit(adminSession(), importer, { jobId, fileText: csv })
      await expect(runCommit(adminSession(), importer, { jobId, fileText: csv })).rejects.toThrow(ImportValidationError)

      const { jobId: secondJobId, summary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "opening-repeat2.csv" })
      createdImportJobIds.push(secondJobId)
      expect(summary.duplicateRows).toBe(1) // the same batchNumber is now detected as a duplicate, not re-imported
      const balance = await db.stockLedgerEntry.aggregate({ where: { organizationId: orgAId, productId: (await db.product.findFirstOrThrow({ where: { sku: "P46-OI-1", organizationId: orgAId } })).id }, _sum: { quantity: true } })
      expect(Number(balance._sum.quantity)).toBeLessThan(100) // sanity bound — not doubled across every test above
    }, TIMEOUT)

    it("P4.9.2 §52/§73: a fresh retry file mixing an already-committed batch with genuinely new batches only imports the new ones — no duplicated quantity, no duplicated ledger entries", async () => {
      const importer = await getImporter(adminSession(), "opening_inventory")
      const firstCsv = toCsv(["sku", "branchCode", "batchNumber", "quantity", "unitCost"], [["P46-OI-1", "MAIN", "P492-RETRY-A", "15", "5"]])
      const { jobId: firstJobId } = await runDryRun(adminSession(), importer, { fileText: firstCsv, fileName: "opening-retry-a.csv" })
      createdImportJobIds.push(firstJobId)
      await runCommit(adminSession(), importer, { jobId: firstJobId, fileText: firstCsv })

      // "Retry" file: the same already-committed batch (P492-RETRY-A) plus
      // two genuinely new ones — simulating an operator re-submitting a
      // superset file after an earlier partial/interrupted run, exactly the
      // scenario P4.9's own interrupted-import test proved safe generically;
      // this proves it specifically for Opening Inventory's own stock/ledger
      // consequences, not just row-level duplicate detection.
      const retryImporter = await getImporter(adminSession(), "opening_inventory")
      const retryCsv = toCsv(
        ["sku", "branchCode", "batchNumber", "quantity", "unitCost"],
        [
          ["P46-OI-1", "MAIN", "P492-RETRY-A", "15", "5"],
          ["P46-OI-1", "MAIN", "P492-RETRY-B", "8", "6"],
          ["P46-OI-1", "MAIN", "P492-RETRY-C", "12", "7"],
        ]
      )
      const { jobId: retryJobId, summary } = await runDryRun(adminSession(), retryImporter, { fileText: retryCsv, fileName: "opening-retry-mixed.csv" })
      createdImportJobIds.push(retryJobId)
      expect(summary.duplicateRows).toBe(1)
      expect(summary.validRows).toBe(2)
      const result = await runCommit(adminSession(), retryImporter, { jobId: retryJobId, fileText: retryCsv })
      expect(result.importedRows).toBe(2)

      const product = await db.product.findFirstOrThrow({ where: { sku: "P46-OI-1", organizationId: orgAId } })
      const batchA = await db.productBatch.findMany({ where: { organizationId: orgAId, productId: product.id, batchNumber: "P492-RETRY-A" } })
      expect(batchA).toHaveLength(1) // never duplicated
      const ledgerForA = await db.stockLedgerEntry.count({ where: { organizationId: orgAId, batchId: batchA[0]!.id } })
      expect(ledgerForA).toBe(1) // exactly one ledger entry — the original commit's, not a second from the retry
      const batchB = await db.productBatch.findFirstOrThrow({ where: { organizationId: orgAId, productId: product.id, batchNumber: "P492-RETRY-B" } })
      expect(batchB.receivedQuantity).toBe(8) // genuinely created, correct quantity
      const batchC = await db.productBatch.findFirstOrThrow({ where: { organizationId: orgAId, productId: product.id, batchNumber: "P492-RETRY-C" } })
      expect(batchC.receivedQuantity).toBe(12)
    }, TIMEOUT)
  })

  describe("§66 accounting readiness", () => {
    it("readiness correctly detects a missing required mapping, then reflects it once configured (already proven end-to-end in the §62 before/after test above)", async () => {
      const status = await getOnboardingStatus(adminSession())
      const mappingItem = status.items.find((i) => i.label === "Accounting mappings")
      expect(mappingItem?.completed).toBe(true) // configured in the §62 "after setup" test
      expect(mappingItem?.reason).toMatch(/Accounts Receivable, Revenue/)
    }, TIMEOUT)
  })

  describe("§67 representative import performance", () => {
    it("1,000-row Patients import — dry run and commit both complete in a reasonable, measured time", async () => {
      const rows = Array.from({ length: 1000 }, (_, i) => [`Perf${i}`, "Patient", "1988-08-08", "unknown", `P46-PERF-P-${i}`, "MAIN"])
      const csv = toCsv(["firstName", "lastName", "dob", "gender", "mobile", "branchCode"], rows)
      const importer = await getImporter(adminSession(), "patients")

      const dryRunStart = Date.now()
      const { jobId, summary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "patients-perf.csv" })
      const dryRunMs = Date.now() - dryRunStart
      createdImportJobIds.push(jobId)
      expect(summary.validRows).toBe(1000)

      const commitStart = Date.now()
      const result = await runCommit(adminSession(), importer, { jobId, fileText: csv })
      const commitMs = Date.now() - commitStart
      expect(result.importedRows).toBe(1000)

      // Deliberate console.log — this number IS the P4.6 §67 deliverable, reported in the phase report, not incidental debug output.
      console.log(`[P4.6 §67] Patients import (1,000 rows): dry run ${dryRunMs}ms, commit ${commitMs}ms.`)

      const created = await db.patient.findMany({ where: { organizationId: orgAId, mobile: { startsWith: "P46-PERF-P-" } } })
      createdPatientIds.push(...created.map((p) => p.id))
    }, 120000)

    it("1,000-row Products import — dry run and commit both complete in a reasonable, measured time", async () => {
      const rows = Array.from({ length: 1000 }, (_, i) => [`P46-PERF-SKU-${i}`, `P4.6 Perf Product ${i}`, "supply", "unit", "5.00"])
      const csv = toCsv(["sku", "name", "category", "unit", "purchaseCost"], rows)
      const importer = await getImporter(adminSession(), "products")

      const dryRunStart = Date.now()
      const { jobId, summary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "products-perf.csv" })
      const dryRunMs = Date.now() - dryRunStart
      createdImportJobIds.push(jobId)
      expect(summary.validRows).toBe(1000)

      const commitStart = Date.now()
      const result = await runCommit(adminSession(), importer, { jobId, fileText: csv })
      const commitMs = Date.now() - commitStart
      expect(result.importedRows).toBe(1000)

      // Deliberate console.log — see the Patients perf test's identical comment above.
      console.log(`[P4.6 §67] Products import (1,000 rows): dry run ${dryRunMs}ms, commit ${commitMs}ms.`)
    }, 120000)
  })

  describe("§61 fresh-clinic smoke workflow", () => {
    it("Patient → Appointment → Check-in → Encounter → Charge → Invoice → Payment → Accounting, on a freshly onboarded organization", async () => {
      const patient = await db.patient.create({
        data: {
          organizationId: orgAId, registrationBranchId: branchAId,
          mrn: `P46-SMOKE-${Date.now()}`, firstName: "Smoke", lastName: "Test",
          dob: new Date("1995-01-01"), gender: "unknown", mobile: `P46SMOKE${Date.now()}`,
        },
      })
      createdPatientIds.push(patient.id)

      const appt = await bookAppointment(adminSession(), {
        branchId: branchAId, patientId: patient.id, providerId, serviceId,
        startTime: new Date(Date.now() + 60 * 60 * 1000), durationMinutes: 30, bookingSource: "walk_in",
      })
      await checkIn(adminSession(), appt.id)
      const encounter = await startEncounter(adminSession(), { branchId: branchAId, patientId: patient.id, providerId, appointmentId: appt.id, encounterType: "consultation" })

      const charge = await db.$transaction((tx) =>
        generateSystemCharge(tx, { organizationId: orgAId, branchId: branchAId, patientId: patient.id, sourceType: "consultation", sourceReferenceId: encounter.id, description: "Smoke test consultation", quantity: 1, unitPrice: 100 })
      )
      const invoice = await generateInvoice(adminSession(), { patientId: patient.id, branchId: branchAId, chargeIds: [charge.id], discountAmount: 0 })
      expect(Number(invoice.totalAmount)).toBe(100)

      const register = await openCashierSession(adminSession(), { branchId: branchAId, openingCash: 0 })
      const payments = await recordPayment(adminSession(), { invoiceId: invoice.id, cashierSessionId: register.id, tenders: [{ method: "cash", amount: 100 }] })
      expect(payments).toHaveLength(1)

      const reloadedInvoice = await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
      expect(reloadedInvoice.status).toBe("paid")

      const journal = await db.journal.findFirst({ where: { organizationId: orgAId, referenceType: "invoice", referenceId: invoice.id } })
      expect(journal).not.toBeNull() // real accounting posting happened on a freshly onboarded org
      if (journal) {
        const lines = await db.journalLine.findMany({ where: { journalId: journal.id } })
        const debit = lines.reduce((s, l) => s + Number(l.debit), 0)
        const credit = lines.reduce((s, l) => s + Number(l.credit), 0)
        expect(debit).toBeCloseTo(credit, 2)
      }
    }, TIMEOUT)
  })
})
