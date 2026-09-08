import "server-only"
import { db } from "@/lib/db"
import { requiredString, optionalString, optionalEmail, optionalPhone } from "@/lib/platform/import/parsers"
import type { ImporterDefinition, RowIssue } from "@/lib/platform/import/types"

/** P4.6 §25 — mapped against procurement/schemas.ts's own `supplierSchema`. No invented tax/regulatory fields beyond the existing free-text `taxNumber`. */
export type SupplierRow = {
  code: string
  companyName: string
  contactName: string | null
  phone: string | null
  email: string | null
  address: string | null
  taxNumber: string | null
  paymentTerms: string | null
}

export function createSuppliersImporter(): ImporterDefinition<SupplierRow> {
  return {
    type: "suppliers",
    group: "Commercial",
    templateVersion: "suppliers-v1",
    label: "Suppliers",
    requiredHeaders: ["code", "companyName"],
    optionalHeaders: ["contactName", "phone", "email", "address", "taxNumber", "paymentTerms"],
    helpText: ["code must be unique within your organization.", "email, if given, must be a valid address."],
    async parseRow(raw) {
      const issues: RowIssue[] = []
      const push = (i: RowIssue | null) => i && issues.push(i)

      const code = requiredString(raw.code, "code", 50)
      push(code.error)
      const companyName = requiredString(raw.companyName, "companyName", 200)
      push(companyName.error)
      const email = optionalEmail(raw.email, "email")
      push(email.error)

      if (issues.length > 0) return { normalized: null, issues }
      return {
        normalized: {
          code: code.value!,
          companyName: companyName.value!,
          contactName: optionalString(raw.contactName, "contactName", 200).value,
          phone: optionalPhone(raw.phone, "phone").value,
          email: email.value,
          address: optionalString(raw.address, "address", 500).value,
          taxNumber: optionalString(raw.taxNumber, "taxNumber", 100).value,
          paymentTerms: optionalString(raw.paymentTerms, "paymentTerms", 100).value,
        },
        issues: [],
      }
    },

    async detectDuplicates(rows, ctx) {
      const candidates = rows.filter((r) => r.normalized)
      if (candidates.length === 0) return
      const codes = [...new Set(candidates.map((r) => r.normalized!.code))]
      const existing = await db.supplier.findMany({ where: { organizationId: ctx.organizationId, code: { in: codes } }, select: { code: true } })
      const existingCodes = new Set(existing.map((e) => e.code.toLowerCase()))
      const seen = new Set<string>()
      for (const row of candidates) {
        const code = row.normalized!.code.toLowerCase()
        if (existingCodes.has(code)) {
          row.duplicate = true
          row.duplicateReason = `A supplier with code "${row.normalized!.code}" already exists.`
        } else if (seen.has(code)) {
          row.duplicate = true
          row.duplicateReason = "Duplicate code within this same file."
        }
        seen.add(code)
      }
    },

    async commitBatch(tx, rows, ctx) {
      const data = rows.map((r) => ({
        organizationId: ctx.organizationId,
        code: r.normalized!.code,
        companyName: r.normalized!.companyName,
        contactName: r.normalized!.contactName,
        phone: r.normalized!.phone,
        email: r.normalized!.email,
        address: r.normalized!.address,
        taxNumber: r.normalized!.taxNumber,
        paymentTerms: r.normalized!.paymentTerms,
      }))
      const result = await tx.supplier.createMany({ data })
      return { imported: result.count, skipped: 0 }
    },
  }
}
