import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { nextNumber } from "@/lib/platform/sequences"
import { writeOutboxEvent, dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import "@/lib/platform/event-handlers"
import { assertValidTransition } from "@/lib/platform/state-machine"
import { getAuthorizedBranchScope, patientVisibilityWhere } from "@/lib/platform/branch-scope"
import type { SessionContext } from "@/lib/auth/session"
import type { $Enums } from "@/generated/prisma/client"
import type { PatientInput, AllergyInput, ConditionInput, MedicationHistoryInput, PatientStatusInput } from "@/lib/domains/patients/schemas"

/**
 * P1 §24: the explicit alternative to deleting a Patient (which P0 made
 * Restrict) — ACTIVE/INACTIVE freely reversible either direction (a patient
 * who stopped attending, then returns), DECEASED reachable from either but
 * terminal through this function: undoing a deceased marking is not a
 * routine status change and isn't given a path here (a genuine data-entry
 * correction would need direct administrative/DB intervention, deliberately
 * not a self-service action).
 */
const PATIENT_STATUS_TRANSITIONS: Readonly<Record<$Enums.PatientStatus, readonly $Enums.PatientStatus[]>> = {
  active: ["inactive", "deceased"],
  inactive: ["active", "deceased"],
  deceased: [],
}

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

/** Thin wrapper kept local for call-site brevity — see branch-scope.ts's `patientVisibilityWhere` doc comment. */
function patientBranchVisibility(session: SessionContext) {
  return patientVisibilityWhere(getAuthorizedBranchScope(session))
}

export async function listPatients(session: SessionContext, params: { search?: string; page?: number } = {}) {
  assertCan(session, "patient.view")
  const page = Math.max(1, params.page ?? 1)
  const pageSize = 25
  const search = params.search?.trim()
  const visibility = patientBranchVisibility(session)

  const where = {
    AND: [
      { organizationId: session.user.organizationId },
      ...(visibility ? [visibility] : []),
      ...(search
        ? [
            {
              OR: [
                { firstName: { contains: search, mode: "insensitive" as const } },
                { lastName: { contains: search, mode: "insensitive" as const } },
                { mrn: { contains: search, mode: "insensitive" as const } },
                { mobile: { contains: search } },
                // P3.1 §10: reception search should also find a patient by
                // national ID — the field already exists and is already
                // used for duplicate detection (findPotentialDuplicates
                // above); it just wasn't wired into ordinary search.
                { nationalId: { contains: search, mode: "insensitive" as const } },
              ],
            },
          ]
        : []),
    ],
  }

  const [patients, total] = await Promise.all([
    db.patient.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
    db.patient.count({ where }),
  ])

  return { patients, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) }
}

export async function getPatient(session: SessionContext, patientId: string) {
  assertCan(session, "patient.view")
  const visibility = patientBranchVisibility(session)
  return db.patient.findFirstOrThrow({
    where: { AND: [{ id: patientId, organizationId: session.user.organizationId }, ...(visibility ? [visibility] : [])] },
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
  const visibility = patientBranchVisibility(session)
  const before = await db.patient.findFirstOrThrow({
    where: { AND: [{ id: patientId, organizationId: session.user.organizationId }, ...(visibility ? [visibility] : [])] },
  })
  const updated = await db.patient.update({ where: { id: patientId }, data: input })
  await auditFromSession(session, "update", "patient", patientId, { old: before, new: updated })
  return updated
}

/** P1 §24: ACTIVE/INACTIVE/DECEASED — the record itself is never deleted (see PATIENT_STATUS_TRANSITIONS above for what's reachable from where). */
export async function updatePatientStatus(session: SessionContext, patientId: string, input: PatientStatusInput) {
  assertCan(session, "patient.edit")
  const visibility = patientBranchVisibility(session)
  const before = await db.patient.findFirstOrThrow({
    where: { AND: [{ id: patientId, organizationId: session.user.organizationId }, ...(visibility ? [visibility] : [])] },
  })
  assertValidTransition(PATIENT_STATUS_TRANSITIONS, before.status, input.status, "a patient")

  const updated = await db.patient.update({ where: { id: patientId }, data: { status: input.status } })
  await auditFromSession(session, "update", "patient", patientId, { old: { status: before.status }, new: { status: input.status, reason: input.reason } })
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
