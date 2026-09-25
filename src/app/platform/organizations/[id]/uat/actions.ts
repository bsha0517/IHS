"use server"

import { revalidatePath } from "next/cache"
import { createPilotUat, recordUatScenario, completePilotUat } from "@/lib/domains/commercial/pilot-uat"
import { createPilotUatSchema, recordUatScenarioSchema, completePilotUatSchema } from "@/lib/domains/commercial/schemas"
import { requirePlatformOperator } from "@/lib/platform/operator-guard"

export type ActionState = { error?: string; success?: boolean }

function revalidate(organizationId: string) {
  revalidatePath(`/platform/organizations/${organizationId}/uat`)
  revalidatePath(`/platform/organizations/${organizationId}`)
}

export async function createPilotUatAction(organizationId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = createPilotUatSchema.safeParse({ cycleLabel: formData.get("cycleLabel"), testerName: formData.get("testerName") })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    const operator = await requirePlatformOperator()
    await createPilotUat(operator.operator.id, { organizationId, ...parsed.data })
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create UAT cycle." }
  }
  revalidate(organizationId)
  return { success: true }
}

export async function recordUatScenarioAction(organizationId: string, uatId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = recordUatScenarioSchema.safeParse({
    area: formData.get("area"),
    scenario: formData.get("scenario"),
    passed: formData.get("passed"),
    notes: formData.get("notes") || null,
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    await requirePlatformOperator()
    await recordUatScenario(uatId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to record scenario." }
  }
  revalidate(organizationId)
  return { success: true }
}

export async function completePilotUatAction(organizationId: string, uatId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = completePilotUatSchema.safeParse({
    result: formData.get("result"),
    blockers: formData.get("blockers") || null,
    notes: formData.get("notes") || null,
    signOff: formData.get("signOff") === "on",
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    const operator = await requirePlatformOperator()
    await completePilotUat(uatId, operator.operator.id, parsed.data, parsed.data.signOff)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to complete UAT cycle." }
  }
  revalidate(organizationId)
  return { success: true }
}
