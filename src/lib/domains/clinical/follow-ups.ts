import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import type { SessionContext } from "@/lib/auth/session"
import type { FollowUpInput } from "@/lib/domains/clinical/schemas"

export async function recommendFollowUp(session: SessionContext, encounterId: string, input: FollowUpInput) {
  assertCan(session, "clinical_notes.edit")

  const encounter = await db.encounter.findFirstOrThrow({
    where: { id: encounterId, organizationId: session.user.organizationId },
  })

  const followUp = await db.followUpRecommendation.create({
    data: {
      organizationId: session.user.organizationId,
      encounterId,
      patientId: encounter.patientId,
      recommendedDate: input.recommendedDate,
      reason: input.reason ?? null,
      createdBy: session.user.id,
    },
  })

  await auditFromSession(session, "create", "follow_up_recommendation", followUp.id, { new: input })
  return followUp
}

export async function dismissFollowUp(session: SessionContext, followUpId: string) {
  assertCan(session, "clinical_notes.edit")
  const before = await db.followUpRecommendation.findFirstOrThrow({
    where: { id: followUpId, organizationId: session.user.organizationId },
  })
  const updated = await db.followUpRecommendation.update({ where: { id: followUpId }, data: { status: "dismissed" } })
  await auditFromSession(session, "dismiss", "follow_up_recommendation", followUpId, { old: before, new: updated })
  return updated
}

/** Linked once a follow-up appointment is actually booked — keeps the recommendation from going stale/duplicated. */
export async function linkFollowUpToAppointment(session: SessionContext, followUpId: string, appointmentId: string) {
  assertCan(session, "clinical_notes.edit")
  const updated = await db.followUpRecommendation.update({
    where: { id: followUpId },
    data: { status: "scheduled", appointmentId },
  })
  await auditFromSession(session, "update", "follow_up_recommendation", followUpId, { new: { appointmentId } })
  return updated
}

export async function listOpenFollowUps(session: SessionContext, params: { branchId?: string } = {}) {
  assertCan(session, "clinical_notes.view")
  return db.followUpRecommendation.findMany({
    where: {
      organizationId: session.user.organizationId,
      status: "open",
      ...(params.branchId ? { patient: { registrationBranchId: params.branchId } } : {}),
    },
    include: { patient: true, encounter: { include: { provider: true } } },
    orderBy: { recommendedDate: "asc" },
  })
}

export async function listPatientFollowUps(session: SessionContext, patientId: string) {
  assertCan(session, "encounter.view")
  return db.followUpRecommendation.findMany({
    where: { organizationId: session.user.organizationId, patientId },
    orderBy: { recommendedDate: "desc" },
  })
}
