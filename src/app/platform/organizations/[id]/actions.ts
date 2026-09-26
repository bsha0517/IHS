"use server"

import { revalidatePath } from "next/cache"
import {
  suspendOrganization,
  reactivateOrganization,
  updateCommercialProfile,
  updateSubscription,
  updateOnboardingStatus,
  updateUatStatus,
  updateGoLiveCondition,
  updateModuleEntitlement,
  resetEntitlementsToPlanDefaults,
  approveGoLive,
  getPlanChangeImpact,
  type PlanChangeImpact,
} from "@/lib/domains/commercial/organizations"
import { updateCommercialProfileSchema, updateSubscriptionSchema } from "@/lib/domains/commercial/schemas"
import { requirePlatformOperator } from "@/lib/platform/operator-guard"
import type { ModuleKey } from "@/lib/platform/entitlements"
import type { $Enums } from "@/generated/prisma/client"

export type ActionState = { error?: string; success?: boolean }
const ok: ActionState = { success: true }

function revalidate(organizationId: string) {
  revalidatePath(`/platform/organizations/${organizationId}`)
  revalidatePath("/platform/organizations")
  revalidatePath("/platform")
}

export async function suspendOrganizationAction(organizationId: string, reason: string): Promise<ActionState> {
  try {
    await suspendOrganization(organizationId, reason || null)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to suspend organization." }
  }
  revalidate(organizationId)
  return ok
}

export async function reactivateOrganizationAction(organizationId: string): Promise<ActionState> {
  try {
    await reactivateOrganization(organizationId)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to reactivate organization." }
  }
  revalidate(organizationId)
  return ok
}

export async function updateCommercialProfileAction(organizationId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = updateCommercialProfileSchema.safeParse({
    legalBusinessName: formData.get("legalBusinessName") || null,
    primaryContactName: formData.get("primaryContactName") || null,
    primaryContactEmail: formData.get("primaryContactEmail") || null,
    primaryContactPhone: formData.get("primaryContactPhone") || null,
    billingContactName: formData.get("billingContactName") || null,
    billingContactEmail: formData.get("billingContactEmail") || null,
    country: formData.get("country") || undefined,
    implementationOwner: formData.get("implementationOwner") || null,
    internalNotes: formData.get("internalNotes") || null,
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await updateCommercialProfile(organizationId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update commercial profile." }
  }
  revalidate(organizationId)
  return ok
}

export async function updateSubscriptionAction(organizationId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = updateSubscriptionSchema.safeParse({
    planId: formData.get("planId"),
    status: formData.get("status"),
    startDate: formData.get("startDate"),
    endDate: formData.get("endDate") || null,
    trialEndsAt: formData.get("trialEndsAt") || null,
    agreedUserLimit: formData.get("agreedUserLimit") || null,
    agreedBranchLimit: formData.get("agreedBranchLimit") || null,
    agreedAmount: formData.get("agreedAmount") || null,
    currency: formData.get("currency") || null,
    billingCycle: formData.get("billingCycle") || null,
    notes: formData.get("notes") || null,
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await updateSubscription(organizationId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update subscription." }
  }
  revalidate(organizationId)
  return ok
}

/** P5.7 Part 12/13: read-only preview for the SubscriptionDialog — never mutates anything; `updateSubscriptionAction` above independently re-checks and enforces the same block server-side regardless of what this returns. */
export async function getPlanChangeImpactAction(
  organizationId: string,
  planId: string,
  agreedUserLimit: number | null,
  agreedBranchLimit: number | null
): Promise<{ impact?: PlanChangeImpact; error?: string }> {
  try {
    const impact = await getPlanChangeImpact(organizationId, planId, { agreedUserLimit, agreedBranchLimit })
    return { impact }
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to compute plan-change impact." }
  }
}

export async function updateOnboardingStatusAction(organizationId: string, status: $Enums.CommercialOnboardingStatus): Promise<ActionState> {
  try {
    await updateOnboardingStatus(organizationId, status)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update onboarding status." }
  }
  revalidate(organizationId)
  return ok
}

export async function updateUatStatusAction(organizationId: string, status: $Enums.UatStatus, note: string): Promise<ActionState> {
  try {
    await updateUatStatus(organizationId, status, note || null)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update UAT status." }
  }
  revalidate(organizationId)
  return ok
}

export async function updateGoLiveConditionAction(
  organizationId: string,
  code: $Enums.GoLiveConditionCode,
  status: $Enums.GoLiveConditionStatus,
  note: string
): Promise<ActionState> {
  try {
    await updateGoLiveCondition(organizationId, code, status, note || null)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update go-live condition." }
  }
  revalidate(organizationId)
  return ok
}

export async function updateModuleEntitlementAction(organizationId: string, moduleKey: ModuleKey, enabled: boolean): Promise<ActionState> {
  try {
    await updateModuleEntitlement(organizationId, moduleKey, enabled)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update module entitlement." }
  }
  revalidate(organizationId)
  return ok
}

export async function resetEntitlementsToPlanDefaultsAction(organizationId: string): Promise<ActionState> {
  try {
    await resetEntitlementsToPlanDefaults(organizationId)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to reset entitlements." }
  }
  revalidate(organizationId)
  return ok
}

/** P5.2 §4: server-side validation lives entirely in `approveGoLive()` — this is a thin dispatch, never a second copy of the readiness rules. */
export async function approveGoLiveAction(organizationId: string, notes: string): Promise<ActionState> {
  try {
    const operator = await requirePlatformOperator()
    await approveGoLive(organizationId, operator.operator.id, notes || null)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to approve go-live." }
  }
  revalidate(organizationId)
  return ok
}
