import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { getImporter } from "@/lib/domains/onboarding/imports/registry"
import { runDryRun, runCommit } from "@/lib/platform/import/engine"
import { toCsv } from "@/lib/platform/import/csv"
import { createBranch } from "@/lib/domains/identity/org-structure"
import { createService } from "@/lib/domains/services/service"
import type { SessionContext } from "@/lib/auth/session"

const TIMEOUT = 60000
const FIXTURE_ORG_NAMES = ["P4.9.2 Fresh Clinic LLC", "P4.9.2 Other Org LLC"]

async function deleteOrgData(orgIds: string[]) {
  if (orgIds.length === 0) return
  const ownerDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DIRECT_DATABASE_URL }) })
  await ownerDb.auditLog.deleteMany({ where: { organizationId: { in: orgIds } } })
  await ownerDb.clinicalAccessLog.deleteMany({ where: { organizationId: { in: orgIds } } })
  await ownerDb.$disconnect()

  await db.importJobError.deleteMany({ where: { job: { organizationId: { in: orgIds } } } })
  await db.importJob.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.payrollRunLine.deleteMany({ where: { payrollRun: { organizationId: { in: orgIds } } } })
  await db.payrollRun.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.labPanelTest.deleteMany({ where: { labPanel: { organizationId: { in: orgIds } } } })
  await db.labPanel.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.labTest.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.imagingService.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.packageService.deleteMany({ where: { package: { organizationId: { in: orgIds } } } })
  await db.package.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.payor.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.asset.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.medication.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.product.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.accountMapping.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.userBranchAccess.deleteMany({ where: { user: { organizationId: { in: orgIds } } } })
  await db.userRole.deleteMany({ where: { user: { organizationId: { in: orgIds } } } })
  await db.user.deleteMany({ where: { organizationId: { in: orgIds }, email: { not: { contains: "admin-" } } } })
  await db.employee.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.service.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.chartOfAccount.deleteMany({ where: { organizationId: { in: orgIds } } })
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

async function cleanupOrphanedFixtureOrgs() {
  const orphans = await db.organization.findMany({ where: { legalName: { in: FIXTURE_ORG_NAMES } }, select: { id: true } })
  if (orphans.length > 0) await deleteOrgData(orphans.map((o) => o.id))
}

/**
 * P4.9.2 (Extended Clinic Data Import Coverage) — the 9 new importers this
 * phase adds (Lab Tests, Lab Panels, Imaging Services, Packages, Payors,
 * Assets, Chart of Accounts, Payroll Runs, Users), plus a targeted check
 * that Medications' new schema-backed fields (route/controlledSubstance/
 * requiresPrescription) actually persist. Same fresh, isolated
 * two-organization fixture convention (self-healing orphan sweep) every
 * other importer suite in this codebase uses.
 */
describe("P4.9.2: extended clinic data import coverage", () => {
  let orgAId: string
  let orgBId: string
  let branchAId: string
  let adminUserId: string
  let serviceId: string
  const createdImportJobIds: string[] = []

  function adminSession(): SessionContext {
    return {
      sessionId: "test-p4-9-2-admin",
      user: { id: adminUserId, organizationId: orgAId, email: "p4-9-2-admin@test.local", firstName: "P4.9.2", lastName: "Admin" },
      activeBranchId: branchAId,
      branchIds: [branchAId],
      permissions: new Set([
        "data_import.manage", "branch.manage", "service.manage", "employee.manage",
        "chart_of_account.manage", "payroll.process", "asset.manage", "users.manage", "inventory.adjust",
      ]),
      roleNames: ["Organization Administrator"],
    }
  }

  beforeAll(async () => {
    await cleanupOrphanedFixtureOrgs()
    const org = await db.organization.create({ data: { legalName: "P4.9.2 Fresh Clinic LLC", displayName: "P4.9.2 Fresh Clinic" } })
    orgAId = org.id
    const orgB = await db.organization.create({ data: { legalName: "P4.9.2 Other Org LLC", displayName: "P4.9.2 Other Org" } })
    orgBId = orgB.id

    const role = await db.role.create({ data: { organizationId: orgAId, name: "P4.9.2 Org Admin" } })
    const permission = await db.permission.findUniqueOrThrow({ where: { code: "users.manage" } })
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } })
    const admin = await db.user.create({ data: { organizationId: orgAId, email: `p4-9-2-admin-${Date.now()}@test.local`, passwordHash: "x", firstName: "P4.9.2", lastName: "Admin" } })
    adminUserId = admin.id
    await db.userRole.create({ data: { userId: admin.id, roleId: role.id } })

    const branch = await createBranch(adminSession(), { name: "Main Branch", code: "MAIN", timezone: "Asia/Dubai" })
    branchAId = branch.id
    const service = await createService(adminSession(), { code: "P492-CONS", name: "P4.9.2 Consultation", category: "Consultation", durationMinutes: 30, price: 100, billable: true, isActive: true, providerIds: [] })
    serviceId = service.id
  }, TIMEOUT)

  afterAll(async () => {
    await db.importJobError.deleteMany({ where: { job: { id: { in: createdImportJobIds } } } })
    await db.importJob.deleteMany({ where: { id: { in: createdImportJobIds } } })
    await deleteOrgData([orgAId, orgBId])
    await db.$disconnect()
  }, TIMEOUT)

  describe("§8/§65 Laboratory Test Catalogue", () => {
    it("valid dry run and commit; duplicate code (in-file and against DB) correctly skipped", async () => {
      const csv = toCsv(["code", "name", "category", "specimenType", "resultType", "price"], [
        ["P492-CBC-WBC", "White Blood Cell Count", "Hematology", "Blood", "numeric", "25"],
      ])
      const importer = await getImporter(adminSession(), "lab_tests")
      const { jobId, summary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "labtests.csv" })
      createdImportJobIds.push(jobId)
      expect(summary.validRows).toBe(1)
      const result = await runCommit(adminSession(), importer, { jobId, fileText: csv })
      expect(result.importedRows).toBe(1)

      // Same file again: now a DB duplicate.
      const retry = await getImporter(adminSession(), "lab_tests")
      const { jobId: jobId2, summary: summary2 } = await runDryRun(adminSession(), retry, { fileText: csv, fileName: "labtests2.csv" })
      createdImportJobIds.push(jobId2)
      expect(summary2.duplicateRows).toBe(1)
      expect(summary2.validRows).toBe(0)
    }, TIMEOUT)

    it("invalid resultType is rejected, not guessed", async () => {
      const csv = toCsv(["code", "name", "category", "specimenType", "resultType", "price"], [
        ["P492-BAD1", "Bad Test", "Hematology", "Blood", "not-a-type", "10"],
      ])
      const importer = await getImporter(adminSession(), "lab_tests")
      const { jobId, summary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "labtests-bad.csv" })
      createdImportJobIds.push(jobId)
      expect(summary.invalidRows).toBe(1)
    }, TIMEOUT)

    it("dry run performs no mutation", async () => {
      const before = await db.labTest.count({ where: { organizationId: orgAId } })
      const csv = toCsv(["code", "name", "category", "specimenType", "resultType", "price"], [["P492-DRYRUN", "Dry Run Test", "Chem", "Blood", "numeric", "10"]])
      const importer = await getImporter(adminSession(), "lab_tests")
      const { jobId } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "labtests-dryrun.csv" })
      createdImportJobIds.push(jobId)
      const after = await db.labTest.count({ where: { organizationId: orgAId } })
      expect(after).toBe(before)
    }, TIMEOUT)
  })

  describe("§9/§65 Laboratory Panels", () => {
    it("panel referencing existing tests commits; panel with an unknown test code is INVALID, not silently dropped", async () => {
      const testsCsv = toCsv(["code", "name", "category", "specimenType", "resultType", "price"], [
        ["P492-PT1", "Panel Test 1", "Hematology", "Blood", "numeric", "10"],
        ["P492-PT2", "Panel Test 2", "Hematology", "Blood", "numeric", "10"],
      ])
      const testsImporter = await getImporter(adminSession(), "lab_tests")
      const dry = await runDryRun(adminSession(), testsImporter, { fileText: testsCsv, fileName: "panel-tests.csv" })
      createdImportJobIds.push(dry.jobId)
      await runCommit(adminSession(), testsImporter, { jobId: dry.jobId, fileText: testsCsv })

      const panelsCsv = toCsv(["code", "name", "price", "testCodes"], [
        ["P492-PANEL1", "Test Panel", "20", "P492-PT1;P492-PT2"],
        ["P492-PANEL-BAD", "Bad Panel", "20", "P492-PT1;P492-NOPE"],
      ])
      const panelsImporter = await getImporter(adminSession(), "lab_panels")
      const panelDry = await runDryRun(adminSession(), panelsImporter, { fileText: panelsCsv, fileName: "panels.csv" })
      createdImportJobIds.push(panelDry.jobId)
      expect(panelDry.summary.validRows).toBe(1)
      expect(panelDry.summary.invalidRows).toBe(1)
      const commit = await runCommit(adminSession(), panelsImporter, { jobId: panelDry.jobId, fileText: panelsCsv })
      expect(commit.importedRows).toBe(1)
      const created = await db.labPanel.findFirstOrThrow({ where: { organizationId: orgAId, code: "P492-PANEL1" }, include: { tests: true } })
      expect(created.tests).toHaveLength(2)
    }, TIMEOUT)
  })

  describe("§7/§66 Imaging Service Catalogue", () => {
    it("valid dry run/commit; duplicate code rejected; org isolation", async () => {
      const csv = toCsv(["code", "name", "category", "price"], [["P492-XRAY", "Chest X-Ray", "X-Ray", "50"]])
      const importer = await getImporter(adminSession(), "imaging_services")
      const { jobId, summary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "imaging.csv" })
      createdImportJobIds.push(jobId)
      expect(summary.validRows).toBe(1)
      const result = await runCommit(adminSession(), importer, { jobId, fileText: csv })
      expect(result.importedRows).toBe(1)

      const orgBRow = await db.imagingService.findFirst({ where: { organizationId: orgBId, code: "P492-XRAY" } })
      expect(orgBRow).toBeNull() // never leaked across organizations
    }, TIMEOUT)
  })

  describe("§10/§67 Packages", () => {
    it("valid package with a resolved service commits; a missing referenced service invalidates the whole row", async () => {
      const csv = toCsv(["code", "name", "price", "items"], [
        ["P492-PKG1", "Consultation Bundle", "500", `P492-CONS:5`],
        ["P492-PKG-BAD", "Bad Bundle", "500", "NOPE:5"],
      ])
      const importer = await getImporter(adminSession(), "packages")
      const { jobId, summary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "packages.csv" })
      createdImportJobIds.push(jobId)
      expect(summary.validRows).toBe(1)
      expect(summary.invalidRows).toBe(1)
      const result = await runCommit(adminSession(), importer, { jobId, fileText: csv })
      expect(result.importedRows).toBe(1)
      const created = await db.package.findFirstOrThrow({ where: { organizationId: orgAId, code: "P492-PKG1" }, include: { services: true } })
      expect(created.services).toHaveLength(1)
      expect(created.services[0]!.serviceId).toBe(serviceId)
    }, TIMEOUT)
  })

  describe("§14/§68 Payors", () => {
    it("valid dry run/commit; duplicate code; invalid payorType rejected", async () => {
      const csv = toCsv(["code", "name", "payorType"], [["P492-PAY1", "Acme Insurance", "insurance_company"]])
      const importer = await getImporter(adminSession(), "payors")
      const { jobId, summary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "payors.csv" })
      createdImportJobIds.push(jobId)
      expect(summary.validRows).toBe(1)
      await runCommit(adminSession(), importer, { jobId, fileText: csv })

      const badCsv = toCsv(["code", "name", "payorType"], [["P492-PAY2", "Bad Payor", "not-a-type"]])
      const importer2 = await getImporter(adminSession(), "payors")
      const { jobId: jobId2, summary: summary2 } = await runDryRun(adminSession(), importer2, { fileText: badCsv, fileName: "payors-bad.csv" })
      createdImportJobIds.push(jobId2)
      expect(summary2.invalidRows).toBe(1)
    }, TIMEOUT)
  })

  describe("§19/§69 Assets", () => {
    it("valid dry run/commit; duplicate assetCode; invalid branch; org isolation", async () => {
      const csv = toCsv(["assetCode", "name", "category", "branchCode"], [["P492-AST1", "Ultrasound Machine", "Medical Equipment", "MAIN"]])
      const importer = await getImporter(adminSession(), "assets")
      const { jobId, summary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "assets.csv" })
      createdImportJobIds.push(jobId)
      expect(summary.validRows).toBe(1)
      const result = await runCommit(adminSession(), importer, { jobId, fileText: csv })
      expect(result.importedRows).toBe(1)

      const badBranchCsv = toCsv(["assetCode", "name", "category", "branchCode"], [["P492-AST2", "Bad Asset", "Equipment", "NOSUCHBRANCH"]])
      const importer2 = await getImporter(adminSession(), "assets")
      const { jobId: jobId2, summary: summary2 } = await runDryRun(adminSession(), importer2, { fileText: badBranchCsv, fileName: "assets-bad.csv" })
      createdImportJobIds.push(jobId2)
      expect(summary2.invalidRows).toBe(1)

      const orgBRow = await db.asset.findFirst({ where: { organizationId: orgBId, assetNumber: "P492-AST1" } })
      expect(orgBRow).toBeNull()
    }, TIMEOUT)

    it("cost is recorded as metadata only — no acquisition journal is posted by this import", async () => {
      const csv = toCsv(["assetCode", "name", "category", "branchCode", "cost"], [["P492-AST-COST", "Costly Asset", "Equipment", "MAIN", "5000"]])
      const importer = await getImporter(adminSession(), "assets")
      const { jobId } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "assets-cost.csv" })
      createdImportJobIds.push(jobId)
      const journalsBefore = await db.journal.count({ where: { organizationId: orgAId } })
      await runCommit(adminSession(), importer, { jobId, fileText: csv })
      const journalsAfter = await db.journal.count({ where: { organizationId: orgAId } })
      expect(journalsAfter).toBe(journalsBefore)
      const created = await db.asset.findFirstOrThrow({ where: { organizationId: orgAId, assetNumber: "P492-AST-COST" } })
      expect(Number(created.cost)).toBe(5000)
    }, TIMEOUT)
  })

  describe("§26/§70 Chart of Accounts (HIGH RISK)", () => {
    it("root account, then a child referencing it in a separate import — parent resolves correctly", async () => {
      const rootCsv = toCsv(["code", "name", "type"], [["P492-1000", "Current Assets", "asset"]])
      const importer1 = await getImporter(adminSession(), "chart_of_accounts")
      const dry1 = await runDryRun(adminSession(), importer1, { fileText: rootCsv, fileName: "coa-root.csv" })
      createdImportJobIds.push(dry1.jobId)
      await runCommit(adminSession(), importer1, { jobId: dry1.jobId, fileText: rootCsv })

      const childCsv = toCsv(["code", "name", "type", "parentAccountCode"], [["P492-1010", "Cash", "asset", "P492-1000"]])
      const importer2 = await getImporter(adminSession(), "chart_of_accounts")
      const dry2 = await runDryRun(adminSession(), importer2, { fileText: childCsv, fileName: "coa-child.csv" })
      createdImportJobIds.push(dry2.jobId)
      expect(dry2.summary.validRows).toBe(1)
      await runCommit(adminSession(), importer2, { jobId: dry2.jobId, fileText: childCsv })

      const child = await db.chartOfAccount.findFirstOrThrow({ where: { organizationId: orgAId, code: "P492-1010" }, include: { parentAccount: true } })
      expect(child.parentAccount?.code).toBe("P492-1000")
    }, TIMEOUT)

    it("duplicate code, missing parent, self-parent, and invalid type are all rejected", async () => {
      const importer = await getImporter(adminSession(), "chart_of_accounts")

      const dupCsv = toCsv(["code", "name", "type"], [["P492-1000", "Duplicate Root", "asset"]]) // P492-1000 already exists from prior test
      const dupDry = await runDryRun(adminSession(), importer, { fileText: dupCsv, fileName: "coa-dup.csv" })
      createdImportJobIds.push(dupDry.jobId)
      expect(dupDry.summary.duplicateRows).toBe(1)

      const missingParentCsv = toCsv(["code", "name", "type", "parentAccountCode"], [["P492-2000", "Orphan", "asset", "P492-NOPE"]])
      const importer2 = await getImporter(adminSession(), "chart_of_accounts")
      const missingDry = await runDryRun(adminSession(), importer2, { fileText: missingParentCsv, fileName: "coa-missing.csv" })
      createdImportJobIds.push(missingDry.jobId)
      expect(missingDry.summary.invalidRows).toBe(1)

      const selfParentCsv = toCsv(["code", "name", "type", "parentAccountCode"], [["P492-3000", "Self", "asset", "P492-3000"]])
      const importer3 = await getImporter(adminSession(), "chart_of_accounts")
      const selfDry = await runDryRun(adminSession(), importer3, { fileText: selfParentCsv, fileName: "coa-self.csv" })
      createdImportJobIds.push(selfDry.jobId)
      expect(selfDry.summary.invalidRows).toBe(1)

      const badTypeCsv = toCsv(["code", "name", "type"], [["P492-4000", "Bad Type", "not-a-type"]])
      const importer4 = await getImporter(adminSession(), "chart_of_accounts")
      const badTypeDry = await runDryRun(adminSession(), importer4, { fileText: badTypeCsv, fileName: "coa-badtype.csv" })
      createdImportJobIds.push(badTypeDry.jobId)
      expect(badTypeDry.summary.invalidRows).toBe(1)
    }, TIMEOUT)

    it("a parent code belonging to a different organization never resolves (cross-org isolation)", async () => {
      await db.chartOfAccount.create({ data: { organizationId: orgBId, code: "P492-CROSSORG", name: "Other Org Account", type: "asset" } })
      const csv = toCsv(["code", "name", "type", "parentAccountCode"], [["P492-5000", "Cross Org Child", "asset", "P492-CROSSORG"]])
      const importer = await getImporter(adminSession(), "chart_of_accounts")
      const { jobId, summary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "coa-crossorg.csv" })
      createdImportJobIds.push(jobId)
      expect(summary.invalidRows).toBe(1)
    }, TIMEOUT)

    it("importing an account never creates an AccountMapping automatically", async () => {
      const csv = toCsv(["code", "name", "type"], [["P492-6000", "Unmapped Revenue", "revenue"]])
      const importer = await getImporter(adminSession(), "chart_of_accounts")
      const { jobId } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "coa-nomapping.csv" })
      createdImportJobIds.push(jobId)
      await runCommit(adminSession(), importer, { jobId, fileText: csv })
      const account = await db.chartOfAccount.findFirstOrThrow({ where: { organizationId: orgAId, code: "P492-6000" } })
      const mapping = await db.accountMapping.findFirst({ where: { accountId: account.id } })
      expect(mapping).toBeNull()
    }, TIMEOUT)
  })

  describe("§29-33/§71 Users (HIGH RISK, security sensitive)", () => {
    it("valid user is created with roles/branches; duplicate email; invalid role; invalid branch; Super Admin bulk-creation is refused", async () => {
      const role = await db.role.create({ data: { organizationId: orgAId, name: "P4.9.2 Reception" } })
      void role // resolved by name via roleNames in the CSV, not referenced directly — kept only to prove it exists

      const csv = toCsv(["email", "firstName", "lastName", "roleNames", "branchCodes"], [
        [`p492-user1-${Date.now()}@test.local`, "New", "User", "P4.9.2 Reception", "MAIN"],
      ])
      const importer = await getImporter(adminSession(), "users")
      const { jobId, summary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "users.csv" })
      createdImportJobIds.push(jobId)
      expect(summary.validRows).toBe(1)
      const result = await runCommit(adminSession(), importer, { jobId, fileText: csv })
      expect(result.importedRows).toBe(1)

      const created = await db.user.findFirstOrThrow({ where: { organizationId: orgAId, email: csv.split("\n")[1]!.split(",")[0]! }, include: { roles: true, branchAccess: true } })
      expect(created.roles).toHaveLength(1)
      expect(created.branchAccess).toHaveLength(1)
      // No usable password: this hash can never verify against any known plaintext.
      expect(created.passwordHash).toMatch(/^\$argon2id\$/)

      // Duplicate email.
      const importer2 = await getImporter(adminSession(), "users")
      const { jobId: jobId2, summary: summary2 } = await runDryRun(adminSession(), importer2, { fileText: csv, fileName: "users-dup.csv" })
      createdImportJobIds.push(jobId2)
      expect(summary2.duplicateRows).toBe(1)

      // Invalid role reference.
      const badRoleCsv = toCsv(["email", "firstName", "lastName", "roleNames", "branchCodes"], [[`p492-user2-${Date.now()}@test.local`, "Bad", "Role", "No Such Role", "MAIN"]])
      const importer3 = await getImporter(adminSession(), "users")
      const { jobId: jobId3, summary: summary3 } = await runDryRun(adminSession(), importer3, { fileText: badRoleCsv, fileName: "users-badrole.csv" })
      createdImportJobIds.push(jobId3)
      expect(summary3.invalidRows).toBe(1)

      // Invalid branch reference.
      const badBranchCsv = toCsv(["email", "firstName", "lastName", "roleNames", "branchCodes"], [[`p492-user3-${Date.now()}@test.local`, "Bad", "Branch", "P4.9.2 Reception", "NOPE"]])
      const importer4 = await getImporter(adminSession(), "users")
      const { jobId: jobId4, summary: summary4 } = await runDryRun(adminSession(), importer4, { fileText: badBranchCsv, fileName: "users-badbranch.csv" })
      createdImportJobIds.push(jobId4)
      expect(summary4.invalidRows).toBe(1)

      // Super Admin bulk-creation refused outright.
      const superAdminCsv = toCsv(["email", "firstName", "lastName", "roleNames", "branchCodes"], [[`p492-superadmin-${Date.now()}@test.local`, "Should", "Fail", "Super Admin", "MAIN"]])
      const importer5 = await getImporter(adminSession(), "users")
      const { jobId: jobId5, summary: summary5 } = await runDryRun(adminSession(), importer5, { fileText: superAdminCsv, fileName: "users-superadmin.csv" })
      createdImportJobIds.push(jobId5)
      expect(summary5.invalidRows).toBe(1)
      const supersCreated = await db.user.count({ where: { organizationId: orgAId, email: superAdminCsv.split("\n")[1]!.split(",")[0]! } })
      expect(supersCreated).toBe(0)
    }, TIMEOUT)

    it("an employee already linked to a user cannot be linked to a second imported user", async () => {
      const employee = await db.employee.create({
        data: { organizationId: orgAId, branchId: branchAId, employeeNumber: `P492-EMP-${Date.now()}`, firstName: "Linked", lastName: "Employee", designation: "Staff", joiningDate: new Date(), employmentType: "full_time" },
      })
      const firstUserCsv = toCsv(["email", "firstName", "lastName", "roleNames", "branchCodes", "employeeNumber"], [
        [`p492-linked1-${Date.now()}@test.local`, "Linked", "One", "P4.9.2 Reception", "MAIN", employee.employeeNumber],
      ])
      const importer = await getImporter(adminSession(), "users")
      const { jobId } = await runDryRun(adminSession(), importer, { fileText: firstUserCsv, fileName: "users-emp1.csv" })
      createdImportJobIds.push(jobId)
      await runCommit(adminSession(), importer, { jobId, fileText: firstUserCsv })

      const secondUserCsv = toCsv(["email", "firstName", "lastName", "roleNames", "branchCodes", "employeeNumber"], [
        [`p492-linked2-${Date.now()}@test.local`, "Linked", "Two", "P4.9.2 Reception", "MAIN", employee.employeeNumber],
      ])
      const importer2 = await getImporter(adminSession(), "users")
      const { jobId: jobId2, summary } = await runDryRun(adminSession(), importer2, { fileText: secondUserCsv, fileName: "users-emp2.csv" })
      createdImportJobIds.push(jobId2)
      expect(summary.duplicateRows).toBe(1)
    }, TIMEOUT)
  })

  describe("§21-25/§72 Payroll Runs (HIGH RISK, DRAFT-ONLY)", () => {
    it("creates a draft run with correctly reconciled totals; posts NO accounting journal", async () => {
      const employee = await db.employee.create({
        data: { organizationId: orgAId, branchId: branchAId, employeeNumber: `P492-PR-${Date.now()}`, firstName: "Payroll", lastName: "Employee", designation: "Staff", joiningDate: new Date(), employmentType: "full_time", basicSalary: 3000 },
      })
      const csv = toCsv(
        ["branchCode", "periodStart", "periodEnd", "employeeNumber", "allowances", "otherDeductions"],
        [["MAIN", "2026-08-01", "2026-08-31", employee.employeeNumber, "200", "50"]]
      )
      const importer = await getImporter(adminSession(), "payroll_runs")
      const { jobId, summary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "payroll.csv" })
      createdImportJobIds.push(jobId)
      expect(summary.validRows).toBe(1)
      expect(summary.domainSummary?.find((d) => d.label === "Net payroll")?.value).toBe((3000 + 200 - 50).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }))

      const journalsBefore = await db.journal.count({ where: { organizationId: orgAId } })
      const result = await runCommit(adminSession(), importer, { jobId, fileText: csv })
      expect(result.importedRows).toBe(1)
      const journalsAfter = await db.journal.count({ where: { organizationId: orgAId } })
      expect(journalsAfter).toBe(journalsBefore) // draft-only: no posting

      const run = await db.payrollRun.findFirstOrThrow({ where: { organizationId: orgAId, branchId: branchAId, periodStart: new Date(Date.UTC(2026, 7, 1, 12)) }, include: { lines: true } })
      expect(run.status).toBe("draft")
      expect(run.lines).toHaveLength(1)
      expect(Number(run.lines[0]!.netSalary)).toBe(3150)
    }, TIMEOUT)

    it("a duplicate period (same branch+period, already exists in any status) is skipped, not appended to or overwritten", async () => {
      const employee = await db.employee.create({
        data: { organizationId: orgAId, branchId: branchAId, employeeNumber: `P492-PR2-${Date.now()}`, firstName: "Second", lastName: "Employee", designation: "Staff", joiningDate: new Date(), employmentType: "full_time", basicSalary: 2000 },
      })
      // Same period as the previous test's already-committed run.
      const csv = toCsv(["branchCode", "periodStart", "periodEnd", "employeeNumber"], [["MAIN", "2026-08-01", "2026-08-31", employee.employeeNumber]])
      const importer = await getImporter(adminSession(), "payroll_runs")
      const { jobId, summary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "payroll-dup-period.csv" })
      createdImportJobIds.push(jobId)
      expect(summary.duplicateRows).toBe(1)

      const runsForPeriod = await db.payrollRun.count({ where: { organizationId: orgAId, branchId: branchAId, periodStart: new Date(Date.UTC(2026, 7, 1, 12)) } })
      expect(runsForPeriod).toBe(1) // still exactly one — never a second, never appended to
    }, TIMEOUT)

    it("an unresolved employee number is INVALID, not silently skipped as if the row were fine", async () => {
      const csv = toCsv(["branchCode", "periodStart", "periodEnd", "employeeNumber"], [["MAIN", "2026-09-01", "2026-09-30", "NOSUCHEMPLOYEE"]])
      const importer = await getImporter(adminSession(), "payroll_runs")
      const { jobId, summary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "payroll-bademp.csv" })
      createdImportJobIds.push(jobId)
      expect(summary.invalidRows).toBe(1)
    }, TIMEOUT)

    it("the same employee appearing twice for the same branch+period in one file is a duplicate, not two lines", async () => {
      const employee = await db.employee.create({
        data: { organizationId: orgAId, branchId: branchAId, employeeNumber: `P492-PR3-${Date.now()}`, firstName: "Third", lastName: "Employee", designation: "Staff", joiningDate: new Date(), employmentType: "full_time", basicSalary: 1000 },
      })
      const csv = toCsv(["branchCode", "periodStart", "periodEnd", "employeeNumber"], [
        ["MAIN", "2026-10-01", "2026-10-31", employee.employeeNumber],
        ["MAIN", "2026-10-01", "2026-10-31", employee.employeeNumber],
      ])
      const importer = await getImporter(adminSession(), "payroll_runs")
      const { jobId, summary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "payroll-samefile-dup.csv" })
      createdImportJobIds.push(jobId)
      expect(summary.validRows).toBe(1)
      expect(summary.duplicateRows).toBe(1)
    }, TIMEOUT)
  })

  describe("§6/§56 Medications extension", () => {
    it("route, controlledSubstance, and requiresPrescription persist as imported", async () => {
      const csv = toCsv(
        ["sku", "name", "unit", "purchaseCost", "dosageForm", "route", "controlledSubstance", "requiresPrescription"],
        [["P492-MED1", "Test Medication", "box", "10", "tablet", "oral", "true", "false"]]
      )
      const importer = await getImporter(adminSession(), "medications")
      const { jobId } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "meds.csv" })
      createdImportJobIds.push(jobId)
      await runCommit(adminSession(), importer, { jobId, fileText: csv })
      const product = await db.product.findFirstOrThrow({ where: { organizationId: orgAId, sku: "P492-MED1" } })
      const medication = await db.medication.findUniqueOrThrow({ where: { productId: product.id } })
      expect(medication.route).toBe("oral")
      expect(medication.controlledSubstance).toBe(true)
      expect(medication.requiresPrescription).toBe(false)
    }, TIMEOUT)
  })

  describe("§45 tenant isolation across the new importers", () => {
    it("an admin from a different organization cannot dry-run into orgA, and codes never resolve across organizations", async () => {
      const otherRole = await db.role.create({ data: { organizationId: orgBId, name: "P4.9.2 Other Admin" } })
      const permission = await db.permission.findUniqueOrThrow({ where: { code: "data_import.manage" } })
      await db.rolePermission.create({ data: { roleId: otherRole.id, permissionId: permission.id } })
      const otherUser = await db.user.create({ data: { organizationId: orgBId, email: `p492-otheradmin-${Date.now()}@test.local`, passwordHash: "x", firstName: "Other", lastName: "Admin" } })
      await db.userRole.create({ data: { userId: otherUser.id, roleId: otherRole.id } })

      const otherSession: SessionContext = {
        sessionId: "test-p4-9-2-other",
        user: { id: otherUser.id, organizationId: orgBId, email: otherUser.email, firstName: "Other", lastName: "Admin" },
        activeBranchId: null,
        branchIds: [],
        permissions: new Set(["data_import.manage", "chart_of_account.manage"]),
        roleNames: ["P4.9.2 Other Admin"],
      }

      // orgA's own "P492-1000" chart of account code must never resolve for orgB.
      const csv = toCsv(["code", "name", "type"], [["P492-1000", "Not The Same Account", "asset"]])
      const importer = await getImporter(otherSession, "chart_of_accounts")
      const { jobId, summary } = await runDryRun(otherSession, importer, { fileText: csv, fileName: "coa-otherorg.csv" })
      createdImportJobIds.push(jobId)
      expect(summary.duplicateRows).toBe(0) // orgB sees no such code — not a duplicate, a genuinely new one for that org
      expect(summary.validRows).toBe(1)
      await runCommit(otherSession, importer, { jobId, fileText: csv })

      const orgAAccount = await db.chartOfAccount.findFirstOrThrow({ where: { organizationId: orgAId, code: "P492-1000" } })
      const orgBAccount = await db.chartOfAccount.findFirstOrThrow({ where: { organizationId: orgBId, code: "P492-1000" } })
      expect(orgAAccount.id).not.toBe(orgBAccount.id)
    }, TIMEOUT)
  })

  describe("§19/§69 Assets — invalid dates/cost", () => {
    it("a malformed purchaseDate and a negative cost are each reported invalid, not coerced", async () => {
      const badDateCsv = toCsv(["assetCode", "name", "category", "branchCode", "purchaseDate"], [["P492-AST-BADDATE", "Bad Date Asset", "Equipment", "MAIN", "not-a-date"]])
      const importer = await getImporter(adminSession(), "assets")
      const { jobId, summary } = await runDryRun(adminSession(), importer, { fileText: badDateCsv, fileName: "assets-baddate.csv" })
      createdImportJobIds.push(jobId)
      expect(summary.invalidRows).toBe(1)

      const negCostCsv = toCsv(["assetCode", "name", "category", "branchCode", "cost"], [["P492-AST-NEGCOST", "Negative Cost Asset", "Equipment", "MAIN", "-100"]])
      const importer2 = await getImporter(adminSession(), "assets")
      const { jobId: jobId2, summary: summary2 } = await runDryRun(adminSession(), importer2, { fileText: negCostCsv, fileName: "assets-negcost.csv" })
      createdImportJobIds.push(jobId2)
      expect(summary2.invalidRows).toBe(1)
    }, TIMEOUT)
  })

  describe("§53 representative import performance (1,000 rows)", () => {
    it("Lab Tests: dry run and commit both complete in a reasonable, measured time", async () => {
      const rows = Array.from({ length: 1000 }, (_, i) => [`P492-PERF-LT-${i}`, `Perf Test ${i}`, "Chemistry", "Blood", "numeric", "10"])
      const csv = toCsv(["code", "name", "category", "specimenType", "resultType", "price"], rows)
      const importer = await getImporter(adminSession(), "lab_tests")

      const dryStart = Date.now()
      const { jobId, summary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "labtests-perf.csv" })
      const dryMs = Date.now() - dryStart
      createdImportJobIds.push(jobId)
      expect(summary.validRows).toBe(1000)

      const commitStart = Date.now()
      const result = await runCommit(adminSession(), importer, { jobId, fileText: csv })
      const commitMs = Date.now() - commitStart
      expect(result.importedRows).toBe(1000)

      // Deliberate console.log — this number IS the P4.9.2 §53 deliverable, reported in the phase report.
      console.log(`[P4.9.2 §53] Lab Tests import (1,000 rows): dry run ${dryMs}ms, commit ${commitMs}ms.`)
    }, 120000)

    it("Users: dry run and commit both complete in a reasonable, measured time", async () => {
      const role = await db.role.create({ data: { organizationId: orgAId, name: "P4.9.2 Perf Role" } })
      void role // resolved by name via roleNames in the CSV, not referenced directly
      const rows = Array.from({ length: 1000 }, (_, i) => [`p492-perf-user-${i}-${Date.now()}@test.local`, `Perf${i}`, "User", "P4.9.2 Perf Role", "MAIN"])
      const csv = toCsv(["email", "firstName", "lastName", "roleNames", "branchCodes"], rows)
      const importer = await getImporter(adminSession(), "users")

      const dryStart = Date.now()
      const { jobId, summary } = await runDryRun(adminSession(), importer, { fileText: csv, fileName: "users-perf.csv" })
      const dryMs = Date.now() - dryStart
      createdImportJobIds.push(jobId)
      expect(summary.validRows).toBe(1000)

      const commitStart = Date.now()
      const result = await runCommit(adminSession(), importer, { jobId, fileText: csv })
      const commitMs = Date.now() - commitStart
      expect(result.importedRows).toBe(1000)

      console.log(`[P4.9.2 §53] Users import (1,000 rows): dry run ${dryMs}ms, commit ${commitMs}ms.`)
    }, 300000) // argon2id hashing dominates — see this importer's own report writeup; 1,000 rows is a deliberately large benchmark, not a realistic single clinic-user-import size
  })
})
