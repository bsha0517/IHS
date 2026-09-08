import "server-only"
import { db } from "@/lib/db"
import { requiredString, optionalString, optionalNumber, optionalDate } from "@/lib/platform/import/parsers"
import type { ImporterDefinition, RowIssue } from "@/lib/platform/import/types"

/**
 * P4.9.2 §19 — Asset Register master data. Mapped against `Asset`
 * (prisma/schema.prisma). Deliberately does NOT call the interactive
 * `createAsset` (assets.ts) domain function — that function posts a real
 * Dr Fixed Asset / Cr [tender or Accounts Payable] journal via
 * `postAssetAcquired` whenever `cost > 0`, which is exactly the kind of
 * "operational transaction" §5's Core Rule forbids a master-data importer
 * from creating. `cost`/`purchaseDate` are imported as pure informational
 * metadata; no acquisition journal is ever posted by this import, the same
 * restraint Opening Inventory already applies to its own financial
 * consequence (§17) — post a manual journal separately if the clinic wants
 * migrated asset cost reflected on the books. Depreciation fields (§19)
 * are intentionally not exposed here at all — nothing reads them yet
 * (schema.prisma's own doc comment on `Asset` confirms this), so there is
 * nothing safe to import into them.
 */
export type AssetRow = {
  assetCode: string
  name: string
  category: string
  serialNumber: string | null
  manufacturer: string | null
  model: string | null
  branchId: string
  departmentId: string | null
  employeeId: string | null
  purchaseDate: Date | null
  cost: number | null
  warrantyExpiryDate: Date | null
  notes: string | null
}

export function createAssetsImporter(branchByCode: Map<string, string>, departmentByName: Map<string, string>, employeeByNumber: Map<string, string>): ImporterDefinition<AssetRow> {
  return {
    type: "assets",
    group: "Operations",
    templateVersion: "assets-v1",
    label: "Assets",
    requiredHeaders: ["assetCode", "name", "category", "branchCode"],
    optionalHeaders: ["serialNumber", "manufacturer", "model", "department", "employeeNumber", "purchaseDate", "cost", "warrantyExpiryDate", "notes"],
    helpText: [
      "assetCode must be unique within your organization (your own asset tag/code).",
      "branchCode must match an existing branch.",
      "department (optional): must match an existing department's name if given.",
      "employeeNumber (optional): must match an existing employee's number if given — assigns the asset to them.",
      "purchaseDate/warrantyExpiryDate (optional): YYYY-MM-DD.",
      "cost (optional): a non-negative number — recorded as informational metadata only. This import never posts an acquisition journal; post one manually if you want migrated asset cost reflected on the books.",
      "This import does not create depreciation schedules or records.",
    ],
    async parseRow(raw) {
      const issues: RowIssue[] = []
      const push = (i: RowIssue | null) => i && issues.push(i)

      const assetCode = requiredString(raw.assetCode, "assetCode", 50)
      push(assetCode.error)
      const name = requiredString(raw.name, "name", 200)
      push(name.error)
      const category = requiredString(raw.category, "category", 100)
      push(category.error)
      const purchaseDate = optionalDate(raw.purchaseDate, "purchaseDate")
      push(purchaseDate.error)
      const cost = optionalNumber(raw.cost, "cost", { min: 0, max: 99999999 })
      push(cost.error)
      const warrantyExpiryDate = optionalDate(raw.warrantyExpiryDate, "warrantyExpiryDate")
      push(warrantyExpiryDate.error)

      const branchCodeRaw = raw.branchCode?.trim()
      let branchId: string | null = null
      if (!branchCodeRaw) {
        issues.push({ field: "branchCode", code: "REQUIRED_FIELD", message: "branchCode is required." })
      } else {
        branchId = branchByCode.get(branchCodeRaw.toLowerCase()) ?? null
        if (!branchId) issues.push({ field: "branchCode", code: "UNKNOWN_BRANCH", message: `branchCode "${branchCodeRaw}" does not match any branch in this organization.` })
      }

      let departmentId: string | null = null
      const deptRaw = raw.department?.trim()
      if (deptRaw) {
        departmentId = departmentByName.get(deptRaw.toLowerCase()) ?? null
        if (!departmentId) issues.push({ field: "department", code: "UNKNOWN_DEPARTMENT", message: `department "${deptRaw}" does not match any department in this organization.` })
      }

      let employeeId: string | null = null
      const empRaw = raw.employeeNumber?.trim()
      if (empRaw) {
        employeeId = employeeByNumber.get(empRaw.toLowerCase()) ?? null
        if (!employeeId) issues.push({ field: "employeeNumber", code: "UNKNOWN_REFERENCE", message: `employeeNumber "${empRaw}" does not match any existing employee.` })
      }

      if (issues.length > 0) return { normalized: null, issues }
      return {
        normalized: {
          assetCode: assetCode.value!,
          name: name.value!,
          category: category.value!,
          serialNumber: optionalString(raw.serialNumber, "serialNumber", 100).value,
          manufacturer: optionalString(raw.manufacturer, "manufacturer", 150).value,
          model: optionalString(raw.model, "model", 150).value,
          branchId: branchId!,
          departmentId,
          employeeId,
          purchaseDate: purchaseDate.value,
          cost: cost.value,
          warrantyExpiryDate: warrantyExpiryDate.value,
          notes: null,
        },
        issues: [],
      }
    },

    async detectDuplicates(rows, ctx) {
      const candidates = rows.filter((r) => r.normalized)
      if (candidates.length === 0) return
      const codes = [...new Set(candidates.map((r) => r.normalized!.assetCode))]
      const existing = await db.asset.findMany({ where: { organizationId: ctx.organizationId, assetNumber: { in: codes } }, select: { assetNumber: true } })
      const existingCodes = new Set(existing.map((e) => e.assetNumber.toLowerCase()))
      const seen = new Set<string>()
      for (const row of candidates) {
        const code = row.normalized!.assetCode.toLowerCase()
        if (existingCodes.has(code)) {
          row.duplicate = true
          row.duplicateReason = `An asset with code "${row.normalized!.assetCode}" already exists.`
        } else if (seen.has(code)) {
          row.duplicate = true
          row.duplicateReason = "Duplicate assetCode within this same file."
        }
        seen.add(code)
      }
    },

    async commitBatch(tx, rows, ctx) {
      const data = rows.map((r) => ({
        organizationId: ctx.organizationId,
        branchId: r.normalized!.branchId,
        departmentId: r.normalized!.departmentId,
        assignedEmployeeId: r.normalized!.employeeId,
        assetNumber: r.normalized!.assetCode,
        name: r.normalized!.name,
        category: r.normalized!.category,
        manufacturer: r.normalized!.manufacturer,
        model: r.normalized!.model,
        serialNumber: r.normalized!.serialNumber,
        purchaseDate: r.normalized!.purchaseDate,
        cost: r.normalized!.cost,
        warrantyExpiryDate: r.normalized!.warrantyExpiryDate,
      }))
      const result = await tx.asset.createMany({ data })
      return { imported: result.count, skipped: 0 }
    },
  }
}
