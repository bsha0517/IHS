import "server-only"
import { db } from "@/lib/db"
import { nextNumber } from "@/lib/platform/sequences"
import { requiredString, optionalString, requiredDate, optionalEmail, optionalPhone, requiredEnum } from "@/lib/platform/import/parsers"
import type { ImporterDefinition, ParsedRow, RowIssue } from "@/lib/platform/import/types"

/**
 * P4.6 §19 — mapped directly against the real `Patient` schema fields
 * (patients/schemas.ts's own `patientSchema`), demographic/administrative
 * only. No clinical-history fields exist here or anywhere in this
 * importer — §19's own explicit instruction.
 */
export type PatientRow = {
  legacyMrn: string | null
  firstName: string
  middleName: string | null
  lastName: string
  dob: Date
  gender: "male" | "female" | "other" | "unknown"
  mobile: string
  email: string | null
  nationalId: string | null
  passportNumber: string | null
  addressLine: string | null
  city: string | null
  country: string | null
  emergencyContactName: string | null
  emergencyContactPhone: string | null
  branchId: string
}

const GENDERS = ["male", "female", "other", "unknown"] as const

export function createPatientsImporter(branchByCode: Map<string, string>): ImporterDefinition<PatientRow> {
  return {
    type: "patients",
    templateVersion: "patients-v1",
    label: "Patients",
    requiredHeaders: ["firstName", "lastName", "dob", "gender", "mobile", "branchCode"],
    optionalHeaders: ["legacyMrn", "middleName", "email", "nationalId", "passportNumber", "addressLine", "city", "country", "emergencyContactName", "emergencyContactPhone"],
    helpText: [
      "dob format: YYYY-MM-DD.",
      "gender: male, female, other, or unknown.",
      "branchCode must match an existing branch's code (see /admin/settings).",
      "legacyMrn is your old system's chart/MRN number, kept for reference only — Avant always assigns its own new MRN.",
      "Duplicate detection: mobile, email, national ID, or (name + date of birth) matching an existing patient marks a row as a likely duplicate — it is skipped, not merged.",
    ],
    async parseRow(raw) {
      const issues: RowIssue[] = []
      const push = (i: RowIssue | null) => i && issues.push(i)

      const firstName = requiredString(raw.firstName, "firstName", 100)
      push(firstName.error)
      const lastName = requiredString(raw.lastName, "lastName", 100)
      push(lastName.error)
      const dob = requiredDate(raw.dob, "dob")
      push(dob.error)
      const gender = requiredEnum(raw.gender, "gender", GENDERS)
      push(gender.error)
      const mobile = requiredString(raw.mobile, "mobile", 30)
      push(mobile.error)
      const email = optionalEmail(raw.email, "email")
      push(email.error)

      const branchCodeRaw = raw.branchCode?.trim()
      let branchId: string | null = null
      if (!branchCodeRaw) {
        issues.push({ field: "branchCode", code: "REQUIRED_FIELD", message: "branchCode is required." })
      } else {
        branchId = branchByCode.get(branchCodeRaw.toLowerCase()) ?? null
        if (!branchId) issues.push({ field: "branchCode", code: "UNKNOWN_BRANCH", message: `branchCode "${branchCodeRaw}" does not match any branch in this organization.` })
      }

      if (issues.length > 0) return { normalized: null, issues }

      return {
        normalized: {
          legacyMrn: optionalString(raw.legacyMrn, "legacyMrn", 100).value,
          firstName: firstName.value!,
          middleName: optionalString(raw.middleName, "middleName", 100).value,
          lastName: lastName.value!,
          dob: dob.value!,
          gender: gender.value!,
          mobile: mobile.value!,
          email: email.value,
          nationalId: optionalString(raw.nationalId, "nationalId", 50).value,
          passportNumber: optionalString(raw.passportNumber, "passportNumber", 50).value,
          addressLine: optionalString(raw.addressLine, "addressLine", 300).value,
          city: optionalString(raw.city, "city", 100).value,
          country: optionalString(raw.country, "country", 100).value,
          emergencyContactName: optionalString(raw.emergencyContactName, "emergencyContactName", 150).value,
          emergencyContactPhone: optionalPhone(raw.emergencyContactPhone, "emergencyContactPhone").value,
          branchId: branchId!,
        },
        issues: [],
      }
    },

    /**
     * P4.6 §20 — reuses the exact signals `findPotentialDuplicates`
     * (patients/service.ts) already uses in the interactive registration
     * flow: mobile, email, national ID, or name+DOB — against BOTH the
     * existing database (one bulk query, not N) and other rows already
     * seen earlier in this same file (a duplicate can arrive twice within
     * one CSV, not only against pre-existing data).
     */
    async detectDuplicates(rows, ctx) {
      const candidates = rows.filter((r) => r.normalized)
      if (candidates.length === 0) return

      const mobiles = [...new Set(candidates.map((r) => r.normalized!.mobile))]
      const emails = [...new Set(candidates.map((r) => r.normalized!.email).filter((e): e is string => !!e))]
      const nationalIds = [...new Set(candidates.map((r) => r.normalized!.nationalId).filter((n): n is string => !!n))]

      const existing = await db.patient.findMany({
        where: {
          organizationId: ctx.organizationId,
          OR: [
            mobiles.length > 0 ? { mobile: { in: mobiles } } : undefined,
            emails.length > 0 ? { email: { in: emails } } : undefined,
            nationalIds.length > 0 ? { nationalId: { in: nationalIds } } : undefined,
          ].filter((c): c is NonNullable<typeof c> => c != null),
        },
        select: { mobile: true, email: true, nationalId: true, firstName: true, lastName: true, dob: true },
      })

      const seenInFile = new Set<string>()
      for (const row of candidates) {
        const n = row.normalized!
        const matchedExisting = existing.some(
          (e) =>
            e.mobile === n.mobile ||
            (n.email && e.email === n.email) ||
            (n.nationalId && e.nationalId === n.nationalId) ||
            (e.firstName.toLowerCase() === n.firstName.toLowerCase() && e.lastName.toLowerCase() === n.lastName.toLowerCase() && e.dob.getTime() === n.dob.getTime())
        )
        const fileKey = `${n.mobile}|${n.email ?? ""}|${n.nationalId ?? ""}`
        const dupInFile = seenInFile.has(fileKey)
        seenInFile.add(fileKey)

        if (matchedExisting) {
          row.duplicate = true
          row.duplicateReason = "Matches an existing patient (mobile, email, national ID, or name+DOB)."
        } else if (dupInFile) {
          row.duplicate = true
          row.duplicateReason = "Duplicate of an earlier row in this same file."
        }
      }
    },

    async commitBatch(tx, rows, ctx) {
      let imported = 0
      for (const row of rows) {
        const n = row.normalized!
        // P4.6 §73: PatientRegistered's own handler is a documented no-op
        // today (event-handlers.ts) — no Outbox event is written per
        // imported row (avoiding a needless event storm for a bulk import
        // with no actual subscriber), while the MRN still comes from the
        // real, system-generated sequence (§21) exactly like the
        // interactive registerPatient() flow.
        const mrn = await nextNumber({ organizationId: ctx.organizationId, sequenceType: "MRN", prefix: "MRN" })
        await tx.patient.create({
          data: {
            organizationId: ctx.organizationId,
            registrationBranchId: n.branchId,
            mrn,
            legacyMrn: n.legacyMrn,
            firstName: n.firstName,
            middleName: n.middleName,
            lastName: n.lastName,
            dob: n.dob,
            gender: n.gender,
            mobile: n.mobile,
            email: n.email,
            nationalId: n.nationalId,
            passportNumber: n.passportNumber,
            addressLine: n.addressLine,
            city: n.city,
            country: n.country,
            emergencyContactName: n.emergencyContactName,
            emergencyContactPhone: n.emergencyContactPhone,
            createdBy: ctx.session.user.id,
          },
        })
        imported++
      }
      return { imported, skipped: 0 }
    },
  }
}

export function isParsedPatientRow(row: ParsedRow<PatientRow>): row is ParsedRow<PatientRow> & { normalized: PatientRow } {
  return row.normalized !== null
}
