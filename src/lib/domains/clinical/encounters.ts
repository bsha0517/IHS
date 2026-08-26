import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { nextNumber } from "@/lib/platform/sequences"
import { writeOutboxEvent, dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import "@/lib/platform/event-handlers"
import { writeClinicalAccessLog } from "@/lib/platform/access-log"
import { callPatient, completeConsultation } from "@/lib/domains/appointments/service"
import type { SessionContext } from "@/lib/auth/session"
import type { EncounterInput } from "@/lib/domains/clinical/schemas"

const ENCOUNTER_WORKSPACE_INCLUDE = {
  patient: {
    include: {
      allergies: { orderBy: { notedAt: "desc" as const } },
      conditions: { orderBy: { notedAt: "desc" as const } },
      medicationHistory: { orderBy: { notedAt: "desc" as const } },
    },
  },
  episode: true,
  appointment: true,
  provider: true,
  department: true,
  vitalSigns: { orderBy: { recordedAt: "desc" as const } },
  notes: { where: { isCurrent: true }, orderBy: { createdAt: "asc" as const } },
  diagnoses: { include: { code: true }, orderBy: { diagnosedAt: "desc" as const } },
  orders: {
    include: { labDetail: true, imagingDetail: true, procedureDetail: true, referralDetail: { include: { referredToProvider: true } } },
    orderBy: { orderedAt: "desc" as const },
  },
  prescriptions: { include: { items: true }, orderBy: { issuedAt: "desc" as const } },
  followUps: { orderBy: { createdAt: "desc" as const } },
} as const

/**
 * Opens an encounter — either standalone (walk-in, no appointment) or tied to
 * an appointment (the normal check-in → queue → "Start Encounter" path). When
 * tied to an appointment still in "waiting", this also drives the appointment
 * into "in_consultation" (reusing appointments/service's own transition
 * rather than duplicating the status-guard logic) so the two domains stay in
 * sync without the UI having to sequence two separate actions.
 */
export async function startEncounter(session: SessionContext, input: EncounterInput) {
  assertCan(session, "encounter.create", { branchId: input.branchId })

  if (input.appointmentId) {
    const appointment = await db.appointment.findFirstOrThrow({ where: { id: input.appointmentId } })
    if (appointment.status === "waiting") {
      await callPatient(session, input.appointmentId)
    } else if (!["in_consultation", "checked_in"].includes(appointment.status)) {
      throw new Error(`Cannot start an encounter from an appointment with status "${appointment.status}".`)
    }
  }

  const encounter = await db.$transaction(async (tx) => {
    const encounterNumber = await nextNumber({
      organizationId: session.user.organizationId,
      sequenceType: "ENC",
      prefix: "ENC",
    })
    return tx.encounter.create({
      data: {
        organizationId: session.user.organizationId,
        branchId: input.branchId,
        departmentId: input.departmentId ?? null,
        patientId: input.patientId,
        episodeId: input.episodeId ?? null,
        appointmentId: input.appointmentId ?? null,
        providerId: input.providerId,
        encounterNumber,
        encounterType: input.encounterType,
        status: "active",
        createdBy: session.user.id,
      },
    })
  })

  await auditFromSession(session, "create", "encounter", encounter.id, {
    new: { encounterNumber: encounter.encounterNumber, encounterType: encounter.encounterType },
  })

  return encounter
}

/**
 * The clinical-content read this build's `clinical_access_log` was built for
 * in Phase 1 (spec.md §63) but had no caller until Phase 14 — this is a full
 * encounter workspace read (notes, diagnoses, orders, vitals, prescriptions),
 * the "chart/encounter/result view" SECURITY.md §5 names, not the routine
 * demographic Patient 360 header view (deliberately excluded per Phase 3's
 * Known Issues note on what does and doesn't count as "clinical access").
 */
export async function getEncounter(session: SessionContext, encounterId: string) {
  assertCan(session, "encounter.view")
  const encounter = await db.encounter.findFirstOrThrow({
    where: { id: encounterId, organizationId: session.user.organizationId },
    include: ENCOUNTER_WORKSPACE_INCLUDE,
  })
  await writeClinicalAccessLog({ session, patientId: encounter.patientId, resourceType: "encounter", resourceId: encounter.id, action: "view" })
  return encounter
}

export async function listPatientEncounters(session: SessionContext, patientId: string) {
  assertCan(session, "encounter.view")
  return db.encounter.findMany({
    where: { organizationId: session.user.organizationId, patientId },
    include: { provider: true, episode: true },
    orderBy: { startAt: "desc" },
  })
}

/**
 * Completing = documentation done, consultation over; closes the linked
 * appointment/queue entry too. Fires EncounterCompleted (spec.md §73's own
 * named example) with a real handler: the billing engine generates the
 * consultation Charge here — matching the Core End-to-End Test's explicit
 * "Consultation Completed -> Charges Generated" order (spec.md §85), not at
 * finalization, since the patient should be able to pay before the doctor
 * necessarily finalizes their notes.
 */
export async function completeEncounter(session: SessionContext, encounterId: string) {
  assertCan(session, "encounter.create")
  const encounter = await db.encounter.findFirstOrThrow({
    where: { id: encounterId, organizationId: session.user.organizationId },
    include: { appointment: { include: { service: true } } },
  })
  if (encounter.status !== "active") {
    throw new Error(`Cannot complete an encounter with status "${encounter.status}".`)
  }

  const updated = await db.$transaction(async (tx) => {
    const result = await tx.encounter.update({
      where: { id: encounterId },
      data: { status: "completed", endAt: new Date() },
    })
    await writeOutboxEvent(tx, {
      organizationId: session.user.organizationId,
      eventType: "EncounterCompleted",
      payload: {
        encounterId,
        patientId: encounter.patientId,
        branchId: encounter.branchId,
        providerId: encounter.providerId,
        serviceId: encounter.appointment?.serviceId ?? null,
        servicePrice: encounter.appointment?.service ? Number(encounter.appointment.service.price) : null,
      },
    })
    return result
  })

  if (encounter.appointmentId) {
    const appointment = await db.appointment.findUnique({ where: { id: encounter.appointmentId } })
    if (appointment?.status === "in_consultation") {
      await completeConsultation(session, encounter.appointmentId)
    }
  }

  await auditFromSession(session, "update", "encounter", encounterId, { old: encounter, new: updated })
  await dispatchPendingOutboxEvents(session.user.organizationId)
  return updated
}

/**
 * Finalized encounters — and every clinical note attached to them — are never
 * silently overwritten (spec.md §25/§92). This is the one-way lock; corrections
 * after this point are amendments (see notes.ts), never in-place edits.
 */
export async function finalizeEncounter(session: SessionContext, encounterId: string) {
  assertCan(session, "encounter.finalize")
  const encounter = await db.encounter.findFirstOrThrow({
    where: { id: encounterId, organizationId: session.user.organizationId },
  })
  if (encounter.status !== "completed") {
    throw new Error("An encounter must be completed before it can be finalized.")
  }

  const updated = await db.$transaction(async (tx) => {
    await tx.clinicalNote.updateMany({
      where: { encounterId, status: "draft" },
      data: { status: "finalized", finalizedBy: session.user.id, finalizedAt: new Date() },
    })
    const result = await tx.encounter.update({ where: { id: encounterId }, data: { status: "finalized" } })
    await writeOutboxEvent(tx, {
      organizationId: session.user.organizationId,
      eventType: "EncounterFinalized",
      payload: { encounterId, patientId: encounter.patientId, providerId: encounter.providerId },
    })
    return result
  })

  await auditFromSession(session, "finalize", "encounter", encounterId, { old: encounter, new: updated })
  await dispatchPendingOutboxEvents(session.user.organizationId)
  return updated
}
