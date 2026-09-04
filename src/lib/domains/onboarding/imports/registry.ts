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
import type { ImporterDefinition } from "@/lib/platform/import/types"
import type { SessionContext } from "@/lib/auth/session"

export const IMPORT_TYPES = ["patients", "services", "products", "suppliers", "medications", "employees", "providers", "opening_inventory"] as const
export type ImportType = (typeof IMPORT_TYPES)[number]

/**
 * P4.6 §46 — every entry point into this module (dry run, commit, template
 * download, help text) goes through here, so the one `data_import.manage`
 * permission check and the one "never trust organizationId from anywhere
 * but the session" (§47) discipline apply uniformly, not per-importer.
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
      const [branchByCode, productBySku, supplierByCode] = await Promise.all([loadBranchMap(organizationId), loadProductMap(organizationId), loadSupplierMap(organizationId)])
      return createOpeningInventoryImporter(branchByCode, productBySku, supplierByCode) as ImporterDefinition<unknown>
    }
  }
}

export function isImportType(value: string): value is ImportType {
  return (IMPORT_TYPES as readonly string[]).includes(value)
}

/** Static metadata (label/headers/help text) for every importer, for the onboarding page's own display — always derived from the real definitions, never a separately-maintained duplicate that could drift. */
export async function getImporterCatalog(session: SessionContext) {
  const importers = await Promise.all(IMPORT_TYPES.map((type) => getImporter(session, type).then((i) => ({ type, importer: i }))))
  return importers.map(({ type, importer: i }) => ({ type, label: i.label, templateVersion: i.templateVersion, requiredHeaders: i.requiredHeaders, optionalHeaders: i.optionalHeaders, helpText: i.helpText }))
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
