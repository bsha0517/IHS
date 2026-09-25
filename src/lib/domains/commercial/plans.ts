import "server-only"
import { db } from "@/lib/db"
import { Prisma } from "@/generated/prisma/client"
import { requirePlatformOperator } from "@/lib/platform/operator-guard"
import { writeAuditLog } from "@/lib/platform/audit"
import type { CommercialPlanInput } from "@/lib/domains/commercial/schemas"

/**
 * P5.1 §9/§20: plan CRUD is platform-operator-only — there is no clinic-
 * facing route anywhere that can list, create, or edit a `CommercialPlan`.
 * Plan-change audit rows use the special entity type "commercial_plan" with
 * no organizationId of their own to scope to (a Plan isn't owned by any one
 * clinic) — written against a synthetic/shared "platform" audit scope isn't
 * possible with the existing organization-scoped `AuditLog` (§39's "use
 * existing audit architecture where appropriate" — the appropriate reuse
 * here is per-organization audit rows for org-affecting actions, e.g.
 * subscription/entitlement changes in commercial/organizations.ts; a plan
 * definition itself, before any org is subscribed to it, has no
 * organization to audit against, so plan CRUD is deliberately NOT audited
 * to AuditLog — it has no PHI/financial impact on any tenant until a
 * subscription references it).
 */
export async function listPlans() {
  await requirePlatformOperator()
  return db.commercialPlan.findMany({ orderBy: { createdAt: "asc" } })
}

export async function getPlan(planId: string) {
  await requirePlatformOperator()
  return db.commercialPlan.findUniqueOrThrow({ where: { id: planId } })
}

export async function createPlan(input: CommercialPlanInput) {
  await requirePlatformOperator()
  try {
    return await db.commercialPlan.create({ data: input })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new Error("A plan with this code already exists.")
    }
    throw e
  }
}

export async function updatePlan(planId: string, input: CommercialPlanInput) {
  await requirePlatformOperator()
  try {
    return await db.commercialPlan.update({ where: { id: planId }, data: input })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new Error("A plan with this code already exists.")
    }
    throw e
  }
}

/** Re-exported for provisioning.ts/organizations.ts, which DO audit against a real organization once one references a plan. */
export { writeAuditLog }
