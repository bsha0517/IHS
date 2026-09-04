"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import { createClaim, submitClaim, adjudicateClaim, recordRemittance, resubmitClaimAsIs } from "@/lib/domains/claims/service"
import { addPatientCoverage, deactivatePatientCoverage, requestAuthorization, approveAuthorization, denyAuthorization } from "@/lib/domains/claims/coverage"
import {
  createClaimSchema,
  adjudicateClaimSchema,
  recordRemittanceSchema,
  patientCoverageSchema,
  requestAuthorizationSchema,
  decideAuthorizationSchema,
} from "@/lib/domains/claims/schemas"

export type ActionState = { error?: string; success?: boolean; claimId?: string }

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  return session
}

function readClaimItems(formData: FormData) {
  let items: unknown
  try {
    items = JSON.parse(String(formData.get("items") ?? "[]"))
  } catch {
    return null
  }
  return items
}

export async function createClaimAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const items = readClaimItems(formData)
  if (items === null) return { error: "Invalid line selection." }
  const parsed = createClaimSchema.safeParse({
    invoiceId: formData.get("invoiceId"),
    patientCoverageId: formData.get("patientCoverageId"),
    items,
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    const claim = await createClaim(session, parsed.data)
    revalidatePath("/claims")
    revalidatePath(`/invoices/${parsed.data.invoiceId}`)
    return { success: true, claimId: claim.id }
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create claim." }
  }
}

export async function submitClaimAction(claimId: string) {
  const session = await requireSession()
  await submitClaim(session, claimId)
  revalidatePath(`/claims/${claimId}`)
  revalidatePath("/claims")
}

export async function adjudicateClaimAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const claimId = String(formData.get("claimId") ?? "")
  const items = readClaimItems(formData)
  if (items === null) return { error: "Invalid item adjudication data." }
  const parsed = adjudicateClaimSchema.safeParse({ items, rejectionReason: formData.get("rejectionReason") })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    await adjudicateClaim(session, claimId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to record adjudication." }
  }
  revalidatePath(`/claims/${claimId}`)
  revalidatePath("/claims")
  return { success: true }
}

export async function recordRemittanceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const claimId = String(formData.get("claimId") ?? "")
  const parsed = recordRemittanceSchema.safeParse({ amount: formData.get("amount"), reference: formData.get("reference") })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    await recordRemittance(session, claimId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to record remittance." }
  }
  revalidatePath(`/claims/${claimId}`)
  revalidatePath("/claims")
  return { success: true }
}

export async function resubmitClaimAction(claimId: string) {
  const session = await requireSession()
  const claim = await resubmitClaimAsIs(session, claimId)
  revalidatePath("/claims")
  return claim.id
}

export async function deactivatePatientCoverageAction(id: string, patientId: string) {
  const session = await requireSession()
  await deactivatePatientCoverage(session, id)
  revalidatePath(`/patients/${patientId}`)
}

export async function addPatientCoverageAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const patientId = String(formData.get("patientId") ?? "")
  const parsed = patientCoverageSchema.safeParse({
    policyId: formData.get("policyId"),
    memberId: formData.get("memberId"),
    relationshipToSubscriber: formData.get("relationshipToSubscriber") || "self",
    startDate: formData.get("startDate"),
    endDate: formData.get("endDate"),
    copayAmount: formData.get("copayAmount"),
    copayPercent: formData.get("copayPercent"),
    deductibleAmount: formData.get("deductibleAmount"),
    annualLimitAmount: formData.get("annualLimitAmount"),
    isPrimary: formData.get("isPrimary") === "on",
    notes: formData.get("notes"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    await addPatientCoverage(session, patientId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to add coverage." }
  }
  revalidatePath(`/patients/${patientId}`)
  return { success: true }
}

export async function requestAuthorizationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const patientId = String(formData.get("patientId") ?? "")
  const parsed = requestAuthorizationSchema.safeParse({
    patientCoverageId: formData.get("patientCoverageId"),
    encounterId: formData.get("encounterId"),
    notes: formData.get("notes"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    await requestAuthorization(session, patientId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to request authorization." }
  }
  revalidatePath(`/patients/${patientId}`)
  return { success: true }
}

function readDecideAuthorizationForm(formData: FormData) {
  return decideAuthorizationSchema.safeParse({
    authNumber: formData.get("authNumber"),
    validFrom: formData.get("validFrom"),
    validUntil: formData.get("validUntil"),
    notes: formData.get("notes"),
  })
}

export async function approveAuthorizationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const id = String(formData.get("authorizationId") ?? "")
  const patientId = String(formData.get("patientId") ?? "")
  const parsed = readDecideAuthorizationForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    await approveAuthorization(session, id, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to approve authorization." }
  }
  revalidatePath(`/patients/${patientId}`)
  return { success: true }
}

export async function denyAuthorizationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const id = String(formData.get("authorizationId") ?? "")
  const patientId = String(formData.get("patientId") ?? "")
  const parsed = readDecideAuthorizationForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    await denyAuthorization(session, id, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to deny authorization." }
  }
  revalidatePath(`/patients/${patientId}`)
  return { success: true }
}
