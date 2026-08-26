import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { nextNumber } from "@/lib/platform/sequences"
import { writeOutboxEvent, dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import "@/lib/platform/event-handlers"
import type { SessionContext } from "@/lib/auth/session"
import type { PatientInput, AllergyInput, ConditionInput, MedicationHistoryInput } from "@/lib/domains/patients/schemas"

export type DuplicateCandidate = {
  id: string
  mrn: string
  firstName: string
  lastName: string
  dob: Date
  mobile: string
  email: string | null
  matchedOn: string[]
}

/**
 * Duplicate detection per spec.md §9 — warn, never silently block. Matches on
 * phone, email, national ID, or name+DOB, each candidate annotated with which
 * signal(s) matched so the registration UI can explain the warning.
 */
export async function findPotentialDuplicates(
  session: SessionContext,
  input: Pick<PatientInput, "mobile" | "email" | "nationalId" | "firstName" | "lastName" | "dob">
): Promise<DuplicateCandidate[]> {
  assertCan(session, "patient.view")

  const candidates = await db.patient.findMany({
    where: {
      organizationId: session.user.organizationId,
      OR: [
        { mobile: input.mobile },
        ...(input.email ? [{ email: input.email }] : []),
        ...(input.nationalId ? [{ nationalId: input.nationalId }] : []),
        { firstName: { equals: input.firstName, mode: "insensitive" }, lastName: { equals: input.lastName, mode: "insensitive" }, dob: input.dob },
      ],
    },
    take: 10,
  })

  return candidates.map((c) => {
    const matchedOn: string[] = []
    if (c.mobile === input.mobile) matchedOn.push("phone")
    if (input.email && c.email === input.email) matchedOn.push("email")
    if (input.nationalId && c.nationalId === input.nationalId) matchedOn.push("national ID")
    if (
      c.firstName.toLowerCase() === input.firstName.toLowerCase() &&
      c.lastName.toLowerCase() === input.lastName.toLowerCase() &&
      c.dob.getTime() === input.dob.getTime()
    ) {
      matchedOn.push("name + date of birth")
    }
    return { id: c.id, mrn: c.mrn, firstName: c.firstName, lastName: c.lastName, dob: c.dob, mobile: c.mobile, email: c.email, matchedOn }
  })
}

export async function registerPatient(
  session: SessionContext,
  input: PatientInput,
  opts: { duplicateOverrideReason?: string } = {}
) {
  assertCan(session, "patient.create")

  const patient = await db.$transaction(async (tx) => {
    const mrn = await nextNumber({
      organizationId: session.user.organizationId,
      sequenceType: "MRN",
      prefix: "MRN",
    })

    const created = await tx.patient.create({
      data: {
        organizationId: session.user.organizationId,
        registrationBranchId: input.registrationBranchId,
        mrn,
        firstName: input.firstName,
        middleName: input.middleName ?? null,
        lastName: input.lastName,
        dob: input.dob,
        gender: input.gender,
        nationality: input.nationality ?? null,
        mobile: input.mobile,
        whatsapp: input.whatsapp ?? null,
        email: input.email ?? null,
        addressLine: input.addressLine ?? null,
        city: input.city ?? null,
        country: input.country ?? null,
        nationalId: input.nationalId ?? null,
        passportNumber: input.passportNumber ?? null,
        emergencyContactName: input.emergencyContactName ?? null,
        emergencyContactRelationship: input.emergencyContactRelationship ?? null,
        emergencyContactPhone: input.emergencyContactPhone ?? null,
        preferredLanguage: input.preferredLanguage ?? null,
        referralSource: input.referralSource ?? null,
        preferredProviderId: input.preferredProviderId ?? null,
        createdBy: session.user.id,
      },
    })

    await writeOutboxEvent(tx, {
      organizationId: session.user.organizationId,
      eventType: "PatientRegistered",
      payload: { patientId: created.id, mrn: created.mrn, registeredBy: session.user.id },
    })

    return created
  })

  // Duplicate-override reason is logged to the audit trail (BLUEPRINT.md
  // correction #5) so an accumulating pattern of overridden warnings can
  // actually be investigated later, rather than the decision vanishing.
  await auditFromSession(session, "create", "patient", patient.id, {
    new: {
      mrn: patient.mrn,
      firstName: patient.firstName,
      lastName: patient.lastName,
      duplicateOverrideReason: opts.duplicateOverrideReason ?? null,
    },
  })

  await dispatchPendingOutboxEvents(session.user.organizationId)

  return patient
}

export async function listPatients(session: SessionContext, params: { search?: string; page?: number } = {}) {
  assertCan(session, "patient.view")
  const page = Math.max(1, params.page ?? 1)
  const pageSize = 25
  const search = params.search?.trim()

  const where = {
    organizationId: session.user.organizationId,
    ...(search
      ? {
          OR: [
            { firstName: { contains: search, mode: "insensitive" as const } },
            { lastName: { contains: search, mode: "insensitive" as const } },
            { mrn: { contains: search, mode: "insensitive" as const } },
            { mobile: { contains: search } },
          ],
        }
      : {}),
  }

  const [patients, total] = await Promise.all([
    db.patient.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
    db.patient.count({ where }),
  ])

  return { patients, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) }
}

export async function getPatient(session: SessionContext, patientId: string) {
  assertCan(session, "patient.view")
  return db.patient.findFirstOrThrow({
    where: { id: patientId, organizationId: session.user.organizationId },
    include: {
      registrationBranch: true,
      preferredProvider: true,
      allergies: { orderBy: { notedAt: "desc" } },
      conditions: { orderBy: { notedAt: "desc" } },
      medicationHistory: { orderBy: { notedAt: "desc" } },
    },
  })
}

export async function updatePatient(session: SessionContext, patientId: string, input: Partial<PatientInput>) {
  assertCan(session, "patient.edit")
  const before = await db.patient.findFirstOrThrow({ where: { id: patientId, organizationId: session.user.organizationId } })
  const updated = await db.patient.update({ where: { id: patientId }, data: input })
  await auditFromSession(session, "update", "patient", patientId, { old: before, new: updated })
  return updated
}

// ---------------------------------------------------------------------------
// Medical profile (spec.md §12)
// ---------------------------------------------------------------------------

export async function addAllergy(session: SessionContext, patientId: string, input: AllergyInput) {
  assertCan(session, "patient.edit")
  const allergy = await db.patientAllergy.create({
    data: { patientId, ...input, notedBy: session.user.id },
  })
  await auditFromSession(session, "create", "patient_allergy", allergy.id, { new: input })
  return allergy
}

export async function addCondition(session: SessionContext, patientId: string, input: ConditionInput) {
  assertCan(session, "patient.edit")
  const condition = await db.patientCondition.create({
    data: { patientId, ...input, notedBy: session.user.id },
  })
  await auditFromSession(session, "create", "patient_condition", condition.id, { new: input })
  return condition
}

export async function addMedicationHistory(session: SessionContext, patientId: string, input: MedicationHistoryInput) {
  assertCan(session, "patient.edit")
  const record = await db.patientMedicationHistory.create({
    data: { patientId, ...input, notedBy: session.user.id },
  })
  await auditFromSession(session, "create", "patient_medication_history", record.id, { new: input })
  return record
}
