"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import { createPayor, updatePayor, deactivatePayor, createInsurancePlan, deactivateInsurancePlan, createPolicy, deactivatePolicy } from "@/lib/domains/claims/payors"
import { payorSchema, insurancePlanSchema, policySchema } from "@/lib/domains/claims/schemas"

export type ActionState = { error?: string; success?: boolean }

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  return session
}

function readPayorForm(formData: FormData) {
  return payorSchema.safeParse({
    code: formData.get("code"),
    name: formData.get("name"),
    payorType: formData.get("payorType"),
    contactName: formData.get("contactName"),
    contactPhone: formData.get("contactPhone"),
    contactEmail: formData.get("contactEmail"),
    address: formData.get("address"),
  })
}

export async function createPayorAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = readPayorForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    await createPayor(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create payor." }
  }
  revalidatePath("/payors")
  return { success: true }
}

export async function updatePayorAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const id = String(formData.get("payorId") ?? "")
  const parsed = readPayorForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    await updatePayor(session, id, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update payor." }
  }
  revalidatePath("/payors")
  return { success: true }
}

export async function deactivatePayorAction(id: string) {
  const session = await requireSession()
  await deactivatePayor(session, id)
  revalidatePath("/payors")
}

export async function createInsurancePlanAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = insurancePlanSchema.safeParse({
    payorId: formData.get("payorId"),
    code: formData.get("code"),
    name: formData.get("name"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    await createInsurancePlan(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create insurance plan." }
  }
  revalidatePath("/payors")
  return { success: true }
}

export async function deactivateInsurancePlanAction(id: string) {
  const session = await requireSession()
  await deactivateInsurancePlan(session, id)
  revalidatePath("/payors")
}

export async function createPolicyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = policySchema.safeParse({
    insurancePlanId: formData.get("insurancePlanId"),
    policyNumber: formData.get("policyNumber"),
    groupNumber: formData.get("groupNumber"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    await createPolicy(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create policy." }
  }
  revalidatePath("/payors")
  return { success: true }
}

export async function deactivatePolicyAction(id: string) {
  const session = await requireSession()
  await deactivatePolicy(session, id)
  revalidatePath("/payors")
}
