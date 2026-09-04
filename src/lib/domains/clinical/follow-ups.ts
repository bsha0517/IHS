import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { getAuthorizedBranchScope, narrowBranchFilter, assertBranchAccess } from "@/lib/platform/branch-scope"
import { ForbiddenError } from "@/lib/platform/permissions-core"
import type { SessionContext } from "@/lib/auth/session"
import type { FollowUpInput } from "@/lib/domains/clinical/schemas"

export async function recommendFollowUp(session: SessionContext, encounterId: string, input: FollowUpInput) {
  assertCan(session, "clinical_notes.edit")

  // P3.3 §33: see clinical/vitals.ts's comment — `findFirstOrThrow` leaked
  // a raw Prisma message for a stale/invalid encounterId. Caught live in
  // this batch's own browser walkthrough.
  const encounter = await db.encounter.findFirst({
    where: { id: encounterId, organizationId: session.user.organizationId },
  })
  if (!encounter) throw new Error("This encounter no longer exists or is not accessible.")
  // P3.3 §34: follow-up is the other domain P2's original cross-branch leak
  // named explicitly — this write path had no branch check at all until
  // now. See clinical/vitals.ts's comment for the full reasoning.
  assertBranchAccess(getAuthorizedBranchScope(session), encounter.branchId)

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
  // Targeted backlog closure, item 6 — see clinical/diagnoses.ts's identical comment.
  const before = await db.followUpRecommendation.findFirst({
    where: { id: followUpId, organizationId: session.user.organizationId },
    include: { encounter: { select: { branchId: true } } },
  })
  if (!before) throw new Error("This follow-up recommendation no longer exists or is not accessible.")
  assertBranchAccess(getAuthorizedBranchScope(session), before.encounter.branchId)
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

/**
 * P2 §13: both functions below previously scoped only by `patient:
 * visibility`/`registrationBranchId` — the patient's own visibility, not
 * the recommendation's own encounter's branch. A follow-up recommendation
 * is per-encounter clinical content, same shape as Prescription/Diagnosis;
 * a patient visible via one authorized branch does not make every
 * follow-up from every other branch that patient was ever treated at
 * visible too. Found during this batch's own review, not previously
 * catalogued — fixed to match `listPatientDiagnoses`'s already-correct
 * `encounter: { branchId: ... }` check exactly (not ANDed with patient-level
 * visibility — a patient with an encounter at an authorized branch but no
 * registration/appointment there otherwise must still see that encounter's
 * own follow-up). `params.branchId` (an explicit branch filter, e.g. from
 * an admin's branch-picker dropdown) now means "recommended at this
 * branch's encounter" — the branch actually responsible for scheduling
 * it — rather than "patient registered at this branch," which could
 * previously show Branch A's front desk a follow-up a completely different
 * branch's doctor recommended for a patient who merely happens to be
 * registered at Branch A.
 */
export async function listOpenFollowUps(session: SessionContext, params: { branchId?: string } = {}) {
  assertCan(session, "clinical_notes.view")
  const scope = getAuthorizedBranchScope(session)
  if (params.branchId && !scope.isOrgWide && !scope.branchIds.includes(params.branchId)) {
    throw new ForbiddenError("branch.access")
  }
  return db.followUpRecommendation.findMany({
    where: {
      organizationId: session.user.organizationId,
      status: "open",
      ...(params.branchId
        ? { encounter: { branchId: params.branchId } }
        : scope.isOrgWide
          ? {}
          : { encounter: { branchId: narrowBranchFilter(scope) } }),
    },
    include: { patient: true, encounter: { include: { provider: true } } },
    orderBy: { recommendedDate: "asc" },
  })
}

export async function listPatientFollowUps(session: SessionContext, patientId: string) {
  assertCan(session, "encounter.view")
  const scope = getAuthorizedBranchScope(session)
  return db.followUpRecommendation.findMany({
    where: {
      organizationId: session.user.organizationId,
      patientId,
      ...(scope.isOrgWide ? {} : { encounter: { branchId: narrowBranchFilter(scope) } }),
    },
    orderBy: { recommendedDate: "desc" },
  })
}
