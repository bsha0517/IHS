"use server"

import { revalidatePath } from "next/cache"
import { updateOnboardingChecklistItem } from "@/lib/domains/commercial/onboarding-checklist"
import { updateOnboardingChecklistItemSchema } from "@/lib/domains/commercial/schemas"
import { requirePlatformOperator } from "@/lib/platform/operator-guard"

export type ActionState = { error?: string; success?: boolean }

export async function updateChecklistItemAction(organizationId: string, itemId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = updateOnboardingChecklistItemSchema.safeParse({
    status: formData.get("status"),
    ownerLabel: formData.get("ownerLabel") || null,
    dueDate: formData.get("dueDate") || null,
    notes: formData.get("notes") || null,
    evidenceReference: formData.get("evidenceReference") || null,
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    const operator = await requirePlatformOperator()
    await updateOnboardingChecklistItem(organizationId, itemId, operator.operator.id, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update checklist item." }
  }
  revalidatePath(`/platform/organizations/${organizationId}/onboarding`)
  revalidatePath(`/platform/organizations/${organizationId}`)
  return { success: true }
}
