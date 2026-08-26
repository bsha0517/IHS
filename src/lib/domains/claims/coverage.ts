import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import type { SessionContext } from "@/lib/auth/session"
import type {
  PatientCoverageInput,
  RequestAuthorizationInput,
  DecideAuthorizationInput,
} from "@/lib/domains/claims/schemas"

const COVERAGE_INCLUDE = { policy: { include: { insurancePlan: { include: { payor: true } } } } } as const

export async function listPatientCoverage(session: SessionContext, patientId: string) {
  assertCan(session, "coverage.manage")
  return db.patientCoverage.findMany({
    where: { organizationId: session.user.organizationId, patientId },
    include: COVERAGE_INCLUDE,
    orderBy: { createdAt: "desc" },
  })
}

export async function addPatientCoverage(session: SessionContext, patientId: string, input: PatientCoverageInput) {
  assertCan(session, "coverage.manage")
  const created = await db.patientCoverage.create({
    data: {
      organizationId: session.user.organizationId,
      patientId,
      policyId: input.policyId,
      memberId: input.memberId,
      relationshipToSubscriber: input.relationshipToSubscriber,
      startDate: input.startDate,
      endDate: input.endDate ?? null,
      copayAmount: input.copayAmount != null ? new Decimal(input.copayAmount) : null,
      copayPercent: input.copayPercent != null ? new Decimal(input.copayPercent) : null,
      deductibleAmount: input.deductibleAmount != null ? new Decimal(input.deductibleAmount) : null,
      annualLimitAmount: input.annualLimitAmount != null ? new Decimal(input.annualLimitAmount) : null,
      isPrimary: input.isPrimary,
      notes: input.notes ?? null,
    },
  })
  await auditFromSession(session, "create", "patient_coverage", created.id, { new: { patientId, memberId: created.memberId } })
  return created
}

export async function deactivatePatientCoverage(session: SessionContext, id: string) {
  assertCan(session, "coverage.manage")
  const updated = await db.patientCoverage.update({ where: { id }, data: { status: "inactive" } })
  await auditFromSession(session, "update", "patient_coverage", id, { new: { status: "inactive" } })
  return updated
}

/**
 * "Eligibility architecture" (spec.md §39) — a real check against the
 * PatientCoverage record's own status/dates, not a live payor API call
 * (spec.md §92 forbids faking an integration that doesn't exist). This is
 * the extensible seam a future country-specific real-time eligibility
 * adapter (X12 270/271 or a payor's own API) would plug into.
 */
export async function checkEligibility(session: SessionContext, patientCoverageId: string, asOf: Date = new Date()) {
  assertCan(session, "coverage.manage")
  const coverage = await db.patientCoverage.findFirstOrThrow({
    where: { id: patientCoverageId, organizationId: session.user.organizationId },
  })
  const withinDates = coverage.startDate <= asOf && (coverage.endDate == null || coverage.endDate >= asOf)
  const eligible = coverage.status === "active" && withinDates
  return {
    eligible,
    reason: eligible
      ? null
      : coverage.status !== "active"
        ? `Coverage status is "${coverage.status}".`
        : "Coverage is not active as of this date.",
  }
}

export async function requestAuthorization(session: SessionContext, patientId: string, input: RequestAuthorizationInput) {
  assertCan(session, "coverage.manage")
  const created = await db.priorAuthorization.create({
    data: {
      organizationId: session.user.organizationId,
      patientId,
      patientCoverageId: input.patientCoverageId,
      encounterId: input.encounterId ?? null,
      notes: input.notes ?? null,
      requestedBy: session.user.id,
    },
  })
  await auditFromSession(session, "create", "prior_authorization", created.id, { new: { patientId, patientCoverageId: input.patientCoverageId } })
  return created
}

async function decideAuthorization(
  session: SessionContext,
  id: string,
  status: "approved" | "denied",
  input: DecideAuthorizationInput
) {
  assertCan(session, "coverage.manage")
  const existing = await db.priorAuthorization.findFirstOrThrow({ where: { id, organizationId: session.user.organizationId } })
  if (existing.status !== "requested") throw new Error(`Only a requested authorization can be decided (this one is "${existing.status}").`)

  const updated = await db.priorAuthorization.update({
    where: { id },
    data: {
      status,
      decidedAt: new Date(),
      authNumber: input.authNumber ?? null,
      validFrom: input.validFrom ?? null,
      validUntil: input.validUntil ?? null,
      notes: input.notes ?? existing.notes,
    },
  })
  await auditFromSession(session, "update", "prior_authorization", id, { new: { status } })
  return updated
}

export async function approveAuthorization(session: SessionContext, id: string, input: DecideAuthorizationInput) {
  return decideAuthorization(session, id, "approved", input)
}

export async function denyAuthorization(session: SessionContext, id: string, input: DecideAuthorizationInput) {
  return decideAuthorization(session, id, "denied", input)
}

export async function listPatientAuthorizations(session: SessionContext, patientId: string) {
  assertCan(session, "coverage.manage")
  return db.priorAuthorization.findMany({
    where: { organizationId: session.user.organizationId, patientId },
    include: { patientCoverage: { include: COVERAGE_INCLUDE } },
    orderBy: { requestedAt: "desc" },
  })
}
