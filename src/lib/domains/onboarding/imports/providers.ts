import "server-only"
import { db } from "@/lib/db"
import { requiredString, optionalString, requiredNumber, optionalDate, requiredEnum } from "@/lib/platform/import/parsers"
import type { ImporterDefinition, RowIssue } from "@/lib/platform/import/types"

const PROVIDER_TYPES = ["doctor", "dentist", "physiotherapist", "nurse", "therapist", "other"] as const

/** P4.6 §27 — master records only, never a login (`userId` always null here — linking stays a separate Admin action, same as Employees). */
export type ProviderRow = {
  providerType: (typeof PROVIDER_TYPES)[number]
  firstName: string
  lastName: string
  specialty: string | null
  licenseNumber: string | null
  consultationFee: number
  defaultAppointmentDurationMinutes: number
  branchIds: string[]
}

export function createProvidersImporter(branchByCode: Map<string, string>): ImporterDefinition<ProviderRow> {
  return {
    type: "providers",
    group: "Operations",
    templateVersion: "providers-v1",
    label: "Providers",
    requiredHeaders: ["providerType", "firstName", "lastName", "consultationFee", "defaultAppointmentDurationMinutes", "branchCodes"],
    optionalHeaders: ["specialty", "licenseNumber", "licenseExpiryDate"],
    helpText: [
      `providerType: ${PROVIDER_TYPES.join(", ")}.`,
      "branchCodes: one or more existing branch codes, separated by \";\" (a provider can work at multiple branches).",
      "This import never creates a login account — link a user to an imported provider afterward from the Providers page.",
    ],
    async parseRow(raw) {
      const issues: RowIssue[] = []
      const push = (i: RowIssue | null) => i && issues.push(i)

      const providerType = requiredEnum(raw.providerType, "providerType", PROVIDER_TYPES)
      push(providerType.error)
      const firstName = requiredString(raw.firstName, "firstName", 100)
      push(firstName.error)
      const lastName = requiredString(raw.lastName, "lastName", 100)
      push(lastName.error)
      const consultationFee = requiredNumber(raw.consultationFee, "consultationFee", { min: 0 })
      push(consultationFee.error)
      const duration = requiredNumber(raw.defaultAppointmentDurationMinutes, "defaultAppointmentDurationMinutes", { min: 5, max: 480, integer: true })
      push(duration.error)
      const licenseExpiryDate = optionalDate(raw.licenseExpiryDate, "licenseExpiryDate")
      push(licenseExpiryDate.error)

      const codesRaw = raw.branchCodes?.trim()
      const branchIds: string[] = []
      if (!codesRaw) {
        issues.push({ field: "branchCodes", code: "REQUIRED_FIELD", message: "branchCodes is required (at least one branch)." })
      } else {
        for (const code of codesRaw.split(";").map((c) => c.trim()).filter(Boolean)) {
          const id = branchByCode.get(code.toLowerCase())
          if (!id) issues.push({ field: "branchCodes", code: "UNKNOWN_BRANCH", message: `branchCodes: "${code}" does not match any branch in this organization.` })
          else branchIds.push(id)
        }
      }

      if (issues.length > 0) return { normalized: null, issues }
      return {
        normalized: {
          providerType: providerType.value!,
          firstName: firstName.value!,
          lastName: lastName.value!,
          specialty: optionalString(raw.specialty, "specialty", 150).value,
          licenseNumber: optionalString(raw.licenseNumber, "licenseNumber", 100).value,
          consultationFee: consultationFee.value!,
          defaultAppointmentDurationMinutes: duration.value!,
          branchIds: [...new Set(branchIds)],
        },
        issues: [],
      }
    },

    async detectDuplicates(rows, ctx) {
      const candidates = rows.filter((r) => r.normalized)
      if (candidates.length === 0) return
      // Providers are a small roster (tens, not thousands) even for a large
      // clinic — one unfiltered fetch, matched in JS, is simpler and cheap
      // here (unlike Patients/Products, which use a targeted WHERE ... IN
      // because that list can genuinely be large).
      const existing = await db.provider.findMany({ where: { organizationId: ctx.organizationId }, select: { firstName: true, lastName: true, licenseNumber: true } })
      const seen = new Set<string>()
      for (const row of candidates) {
        const n = row.normalized!
        const matchedExisting = existing.some(
          (e) => (n.licenseNumber && e.licenseNumber === n.licenseNumber) || (e.firstName.toLowerCase() === n.firstName.toLowerCase() && e.lastName.toLowerCase() === n.lastName.toLowerCase())
        )
        const key = `${n.firstName.toLowerCase()}|${n.lastName.toLowerCase()}|${n.licenseNumber ?? ""}`
        if (matchedExisting) {
          row.duplicate = true
          row.duplicateReason = "Matches an existing provider (license number or full name)."
        } else if (seen.has(key)) {
          row.duplicate = true
          row.duplicateReason = "Duplicate of an earlier row in this same file."
        }
        seen.add(key)
      }
    },

    async commitBatch(tx, rows, ctx) {
      let imported = 0
      for (const row of rows) {
        const n = row.normalized!
        const created = await tx.provider.create({
          data: {
            organizationId: ctx.organizationId,
            providerType: n.providerType,
            firstName: n.firstName,
            lastName: n.lastName,
            specialty: n.specialty,
            licenseNumber: n.licenseNumber,
            consultationFee: n.consultationFee,
            defaultAppointmentDurationMinutes: n.defaultAppointmentDurationMinutes,
          },
        })
        if (n.branchIds.length > 0) {
          await tx.providerBranch.createMany({ data: n.branchIds.map((branchId) => ({ providerId: created.id, branchId })) })
        }
        imported++
      }
      return { imported, skipped: 0 }
    },
  }
}
