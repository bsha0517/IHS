"use server"

import { revalidatePath } from "next/cache"
import { createPlan, updatePlan } from "@/lib/domains/commercial/plans"
import { commercialPlanSchema } from "@/lib/domains/commercial/schemas"

export type PlanActionState = { error?: string; success?: boolean }

function parsePlanForm(formData: FormData) {
  const moduleKeys = formData.getAll("defaultModuleKeys").map(String)
  return commercialPlanSchema.safeParse({
    code: formData.get("code"),
    name: formData.get("name"),
    description: formData.get("description") || null,
    active: formData.get("active") === "on",
    userLimit: formData.get("userLimit") || null,
    branchLimit: formData.get("branchLimit") || null,
    defaultModuleKeys: moduleKeys,
    notes: formData.get("notes") || null,
  })
}

export async function createPlanAction(_prev: PlanActionState, formData: FormData): Promise<PlanActionState> {
  const parsed = parsePlanForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    await createPlan(parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create plan." }
  }
  revalidatePath("/platform/plans")
  return { success: true }
}

export async function updatePlanAction(planId: string, _prev: PlanActionState, formData: FormData): Promise<PlanActionState> {
  const parsed = parsePlanForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    await updatePlan(planId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update plan." }
  }
  revalidatePath("/platform/plans")
  return { success: true }
}
