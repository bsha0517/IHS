import "server-only"
import { db } from "@/lib/db"
import { requiredString, optionalString, optionalEmail, optionalPhone, requiredEnum } from "@/lib/platform/import/parsers"
import type { ImporterDefinition, RowIssue } from "@/lib/platform/import/types"

/**
 * P4.9.2 §14 — Payor/Insurance master data ONLY. Mapped against `Payor`
 * (prisma/schema.prisma) — no `taxIdentifier`/`paymentTerms` field exists
 * on this model (unlike Supplier, which has both), so neither is imported;
 * §60 boundary: this is internal payor configuration, never insurance
 * integration — no NPHIES, no clearinghouse, no eligibility verification.
 */
const PAYOR_TYPES = ["self_pay", "insurance_company", "corporate", "government", "other"] as const

export type PayorRow = {
  code: string
  name: string
  payorType: (typeof PAYOR_TYPES)[number]
  contactName: string | null
  contactPhone: string | null
  contactEmail: string | null
  address: string | null
}

export function createPayorsImporter(): ImporterDefinition<PayorRow> {
  return {
    type: "payors",
    group: "Commercial",
    templateVersion: "payors-v1",
    label: "Payors",
    requiredHeaders: ["code", "name", "payorType"],
    optionalHeaders: ["contactName", "contactPhone", "contactEmail", "address"],
    helpText: [
      "code must be unique within your organization.",
      `payorType: ${PAYOR_TYPES.join(", ")}.`,
      "This is internal payor master data only — not an insurance eligibility/claims integration.",
    ],
    async parseRow(raw) {
      const issues: RowIssue[] = []
      const push = (i: RowIssue | null) => i && issues.push(i)

      const code = requiredString(raw.code, "code", 30)
      push(code.error)
      const name = requiredString(raw.name, "name", 200)
      push(name.error)
      const payorType = requiredEnum(raw.payorType, "payorType", PAYOR_TYPES)
      push(payorType.error)
      const contactEmail = optionalEmail(raw.contactEmail, "contactEmail")
      push(contactEmail.error)

      if (issues.length > 0) return { normalized: null, issues }
      return {
        normalized: {
          code: code.value!,
          name: name.value!,
          payorType: payorType.value!,
          contactName: optionalString(raw.contactName, "contactName", 150).value,
          contactPhone: optionalPhone(raw.contactPhone, "contactPhone").value,
          contactEmail: contactEmail.value,
          address: optionalString(raw.address, "address", 500).value,
        },
        issues: [],
      }
    },

    async detectDuplicates(rows, ctx) {
      const candidates = rows.filter((r) => r.normalized)
      if (candidates.length === 0) return
      const codes = [...new Set(candidates.map((r) => r.normalized!.code))]
      const existing = await db.payor.findMany({ where: { organizationId: ctx.organizationId, code: { in: codes } }, select: { code: true } })
      const existingCodes = new Set(existing.map((e) => e.code.toLowerCase()))
      const seen = new Set<string>()
      for (const row of candidates) {
        const code = row.normalized!.code.toLowerCase()
        if (existingCodes.has(code)) {
          row.duplicate = true
          row.duplicateReason = `A payor with code "${row.normalized!.code}" already exists.`
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
        name: r.normalized!.name,
        payorType: r.normalized!.payorType,
        contactName: r.normalized!.contactName,
        contactPhone: r.normalized!.contactPhone,
        contactEmail: r.normalized!.contactEmail,
        address: r.normalized!.address,
      }))
      const result = await tx.payor.createMany({ data })
      return { imported: result.count, skipped: 0 }
    },
  }
}
