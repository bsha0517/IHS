import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { createPatientsImporter } from "@/lib/domains/onboarding/imports/patients"
import { createServicesImporter } from "@/lib/domains/onboarding/imports/services"
import { createProductsImporter } from "@/lib/domains/onboarding/imports/products"
import { createSuppliersImporter } from "@/lib/domains/onboarding/imports/suppliers"
import { createMedicationsImporter } from "@/lib/domains/onboarding/imports/medications"
import { createEmployeesImporter } from "@/lib/domains/onboarding/imports/employees"
import { createProvidersImporter } from "@/lib/domains/onboarding/imports/providers"
import { createOpeningInventoryImporter } from "@/lib/domains/onboarding/imports/opening-inventory"
import { createLabTestsImporter } from "@/lib/domains/onboarding/imports/lab-tests"
import { createLabPanelsImporter } from "@/lib/domains/onboarding/imports/lab-panels"
import { createImagingServicesImporter } from "@/lib/domains/onboarding/imports/imaging-services"
import { createPackagesImporter } from "@/lib/domains/onboarding/imports/packages"
import { createPayorsImporter } from "@/lib/domains/onboarding/imports/payors"
import { createAssetsImporter } from "@/lib/domains/onboarding/imports/assets"
import { createChartOfAccountsImporter } from "@/lib/domains/onboarding/imports/chart-of-accounts"
import { createPayrollRunsImporter } from "@/lib/domains/onboarding/imports/payroll-runs"
import { createUsersImporter } from "@/lib/domains/onboarding/imports/users"
import type { ImporterDefinition } from "@/lib/platform/import/types"
import type { SessionContext } from "@/lib/auth/session"

// P4.9.2 §4: the extended clinic data import catalogue — see
// P4_9_2_EXTENDED_CLINIC_DATA_IMPORT_REPORT.md's Import Catalogue Matrix
// for which of these are new this phase vs. carried from P4.6.
export const IMPORT_TYPES = [
  "patients",
  "services",
  "products",
  "suppliers",
  "medications",
  "employees",
  "providers",
  "opening_inventory",
  "lab_tests",
  "lab_panels",
  "imaging_services",
  "packages",
  "payors",
  "assets",
  "chart_of_accounts",
  "payroll_runs",
  "users",
] as const
export type ImportType = (typeof IMPORT_TYPES)[number]

/**
 * P4.6 §46 — every entry point into this module (dry run, commit, template
 * download, help text) goes through here, so the one `data_import.manage`
 * permission check and the one "never trust organizationId from anywhere
 * but the session" (§47) discipline apply uniformly, not per-importer.
 *
 * P4.9.2 §47: `data_import.manage` alone is not sufficient authority for
 * the four high-risk importers — each additionally requires the same
 * domain permission the equivalent interactive screen already requires,
 * checked here (not duplicated per-importer file).
 */
export async function getImporter(session: SessionContext, type: ImportType): Promise<ImporterDefinition<unknown>> {
  assertCan(session, "data_import.manage")
  const organizationId = session.user.organizationId

  switch (type) {
    case "patients": {
      const branchByCode = await loadBranchMap(organizationId)
      return createPatientsImporter(branchByCode) as ImporterDefinition<unknown>
    }
    case "services": {
      const departmentByName = await loadDepartmentMap(organizationId)
      return createServicesImporter(departmentByName) as ImporterDefinition<unknown>
    }
    case "products":
      return createProductsImporter() as ImporterDefinition<unknown>
    case "suppliers":
      return createSuppliersImporter() as ImporterDefinition<unknown>
    case "medications":
      return createMedicationsImporter() as ImporterDefinition<unknown>
    case "employees": {
      const [branchByCode, departmentByName] = await Promise.all([loadBranchMap(organizationId), loadDepartmentMap(organizationId)])
      return createEmployeesImporter(branchByCode, departmentByName) as ImporterDefinition<unknown>
    }
    case "providers": {
      const branchByCode = await loadBranchMap(organizationId)
      return createProvidersImporter(branchByCode) as ImporterDefinition<unknown>
    }
    case "opening_inventory": {
      assertCan(session, "inventory.adjust") // P4.9.2 §47 — inventory authority, in addition to data_import.manage
      const [branchByCode, productBySku, supplierByCode] = await Promise.all([loadBranchMap(organizationId), loadProductMap(organizationId), loadSupplierMap(organizationId)])
      return createOpeningInventoryImporter(branchByCode, productBySku, supplierByCode) as ImporterDefinition<unknown>
    }
    case "lab_tests":
      return createLabTestsImporter() as ImporterDefinition<unknown>
    case "lab_panels": {
      const testCodeById = await loadLabTestMap(organizationId)
      return createLabPanelsImporter(testCodeById) as ImporterDefinition<unknown>
    }
    case "imaging_services":
      return createImagingServicesImporter() as ImporterDefinition<unknown>
    case "packages": {
      const serviceIdByCode = await loadServiceMap(organizationId)
      return createPackagesImporter(serviceIdByCode) as ImporterDefinition<unknown>
    }
    case "payors":
      return createPayorsImporter() as ImporterDefinition<unknown>
    case "assets": {
      assertCan(session, "asset.manage") // P4.9.2 §47 — asset management authority
      const [branchByCode, departmentByName, employeeByNumber] = await Promise.all([loadBranchMap(organizationId), loadDepartmentMap(organizationId), loadEmployeeMap(organizationId)])
      const employeeIdByNumber = new Map([...employeeByNumber].map(([code, e]) => [code, e.id]))
      return createAssetsImporter(branchByCode, departmentByName, employeeIdByNumber) as ImporterDefinition<unknown>
    }
    case "chart_of_accounts":
      assertCan(session, "chart_of_account.manage") // P4.9.2 §47 — accounting/admin authority
      return createChartOfAccountsImporter() as ImporterDefinition<unknown>
    case "payroll_runs": {
      assertCan(session, "payroll.process") // P4.9.2 §47 — payroll authority
      const [branchByCode, employeeByNumber] = await Promise.all([loadBranchMap(organizationId), loadEmployeeMap(organizationId)])
      return createPayrollRunsImporter(branchByCode, employeeByNumber) as ImporterDefinition<unknown>
    }
    case "users": {
      assertCan(session, "users.manage") // P4.9.2 §47 — RBAC administration authority
      const [roleIdByName, branchByCode, employeeByNumber] = await Promise.all([loadRoleMap(organizationId), loadBranchMap(organizationId), loadEmployeeMap(organizationId)])
      const employeeIdByNumber = new Map([...employeeByNumber].map(([code, e]) => [code, e.id]))
      return createUsersImporter(roleIdByName, branchByCode, employeeIdByNumber) as ImporterDefinition<unknown>
    }
  }
}

export function isImportType(value: string): value is ImportType {
  return (IMPORT_TYPES as readonly string[]).includes(value)
}

/** Static metadata (label/headers/help text/group/risk) for every importer, for the onboarding page's own display — always derived from the real definitions, never a separately-maintained duplicate that could drift. */
export async function getImporterCatalog(session: SessionContext) {
  const importers = await Promise.all(IMPORT_TYPES.map((type) => getImporter(session, type).then((i) => ({ type, importer: i }))))
  return importers.map(({ type, importer: i }) => ({
    type,
    label: i.label,
    templateVersion: i.templateVersion,
    requiredHeaders: i.requiredHeaders,
    optionalHeaders: i.optionalHeaders,
    helpText: i.helpText,
    group: i.group,
    riskLevel: i.riskLevel,
    confirmationText: i.confirmationText,
  }))
}

async function loadBranchMap(organizationId: string): Promise<Map<string, string>> {
  const branches = await db.branch.findMany({ where: { organizationId, status: "active" }, select: { id: true, code: true } })
  return new Map(branches.map((b) => [b.code.toLowerCase(), b.id]))
}

async function loadDepartmentMap(organizationId: string): Promise<Map<string, string>> {
  const departments = await db.department.findMany({ where: { branch: { organizationId } }, select: { id: true, name: true } })
  return new Map(departments.map((d) => [d.name.toLowerCase(), d.id]))
}

async function loadProductMap(organizationId: string): Promise<Map<string, string>> {
  const products = await db.product.findMany({ where: { organizationId }, select: { id: true, sku: true } })
  return new Map(products.map((p) => [p.sku.toLowerCase(), p.id]))
}

async function loadSupplierMap(organizationId: string): Promise<Map<string, string>> {
  const suppliers = await db.supplier.findMany({ where: { organizationId }, select: { id: true, code: true } })
  return new Map(suppliers.map((s) => [s.code.toLowerCase(), s.id]))
}

async function loadLabTestMap(organizationId: string): Promise<Map<string, string>> {
  const tests = await db.labTest.findMany({ where: { organizationId }, select: { id: true, code: true } })
  return new Map(tests.map((t) => [t.code.toLowerCase(), t.id]))
}

async function loadServiceMap(organizationId: string): Promise<Map<string, string>> {
  const services = await db.service.findMany({ where: { organizationId }, select: { id: true, code: true } })
  return new Map(services.map((s) => [s.code.toLowerCase(), s.id]))
}

async function loadEmployeeMap(organizationId: string): Promise<Map<string, { id: string; basicSalary: number }>> {
  const employees = await db.employee.findMany({ where: { organizationId }, select: { id: true, employeeNumber: true, basicSalary: true } })
  return new Map(employees.map((e) => [e.employeeNumber.toLowerCase(), { id: e.id, basicSalary: Number(e.basicSalary) }]))
}

async function loadRoleMap(organizationId: string): Promise<Map<string, string>> {
  const roles = await db.role.findMany({ where: { organizationId }, select: { id: true, name: true } })
  return new Map(roles.map((r) => [r.name.toLowerCase(), r.id]))
}
