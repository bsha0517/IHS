import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import type { SessionContext } from "@/lib/auth/session"
import type { PayorInput, InsurancePlanInput, PolicyInput } from "@/lib/domains/claims/schemas"

export async function listPayors(session: SessionContext) {
  assertCan(session, "payor.manage")
  return db.payor.findMany({
    where: { organizationId: session.user.organizationId, isActive: true },
    include: { insurancePlans: { where: { isActive: true }, include: { policies: { where: { isActive: true } } } } },
    orderBy: { name: "asc" },
  })
}

export async function createPayor(session: SessionContext, input: PayorInput) {
  assertCan(session, "payor.manage")
  const created = await db.payor.create({
    data: {
      organizationId: session.user.organizationId,
      code: input.code,
      name: input.name,
      payorType: input.payorType,
      contactName: input.contactName ?? null,
      contactPhone: input.contactPhone ?? null,
      contactEmail: input.contactEmail ?? null,
      address: input.address ?? null,
    },
  })
  await auditFromSession(session, "create", "payor", created.id, { new: { code: created.code, name: created.name } })
  return created
}

export async function updatePayor(session: SessionContext, id: string, input: PayorInput) {
  assertCan(session, "payor.manage")
  const existing = await db.payor.findFirstOrThrow({ where: { id, organizationId: session.user.organizationId } })
  const updated = await db.payor.update({
    where: { id },
    data: {
      code: input.code,
      name: input.name,
      payorType: input.payorType,
      contactName: input.contactName ?? null,
      contactPhone: input.contactPhone ?? null,
      contactEmail: input.contactEmail ?? null,
      address: input.address ?? null,
    },
  })
  await auditFromSession(session, "update", "payor", id, { old: existing, new: input })
  return updated
}

export async function deactivatePayor(session: SessionContext, id: string) {
  assertCan(session, "payor.manage")
  const updated = await db.payor.update({ where: { id }, data: { isActive: false } })
  await auditFromSession(session, "update", "payor", id, { new: { isActive: false } })
  return updated
}

export async function createInsurancePlan(session: SessionContext, input: InsurancePlanInput) {
  assertCan(session, "payor.manage")
  const created = await db.insurancePlan.create({
    data: { organizationId: session.user.organizationId, payorId: input.payorId, code: input.code, name: input.name },
  })
  await auditFromSession(session, "create", "insurance_plan", created.id, { new: { code: created.code, name: created.name } })
  return created
}

export async function deactivateInsurancePlan(session: SessionContext, id: string) {
  assertCan(session, "payor.manage")
  const updated = await db.insurancePlan.update({ where: { id }, data: { isActive: false } })
  await auditFromSession(session, "update", "insurance_plan", id, { new: { isActive: false } })
  return updated
}

export async function createPolicy(session: SessionContext, input: PolicyInput) {
  assertCan(session, "payor.manage")
  const created = await db.policy.create({
    data: {
      organizationId: session.user.organizationId,
      insurancePlanId: input.insurancePlanId,
      policyNumber: input.policyNumber,
      groupNumber: input.groupNumber ?? null,
    },
  })
  await auditFromSession(session, "create", "policy", created.id, { new: { policyNumber: created.policyNumber } })
  return created
}

export async function deactivatePolicy(session: SessionContext, id: string) {
  assertCan(session, "payor.manage")
  const updated = await db.policy.update({ where: { id }, data: { isActive: false } })
  await auditFromSession(session, "update", "policy", id, { new: { isActive: false } })
  return updated
}
