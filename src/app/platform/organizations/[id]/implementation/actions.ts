"use server"

import { revalidatePath } from "next/cache"
import {
  updateImplementationTraining,
  addImplementationNote,
  updateTargetGoLiveDate,
  completeHandover,
} from "@/lib/domains/commercial/implementation"
import { updateImplementationTrainingSchema, addImplementationNoteSchema, updateTargetGoLiveDateSchema } from "@/lib/domains/commercial/schemas"
import { updateCommercialProfile } from "@/lib/domains/commercial/organizations"
import { updateCommercialProfileSchema } from "@/lib/domains/commercial/schemas"
import { requirePlatformOperator } from "@/lib/platform/operator-guard"

export type ActionState = { error?: string; success?: boolean }
const ok: ActionState = { success: true }

function revalidate(organizationId: string) {
  revalidatePath(`/platform/organizations/${organizationId}/implementation`)
  revalidatePath(`/platform/organizations/${organizationId}`)
  revalidatePath("/platform/implementations")
}

export async function updateImplementationTrainingAction(organizationId: string, trainingId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = updateImplementationTrainingSchema.safeParse({
    status: formData.get("status"),
    scheduledAt: formData.get("scheduledAt") || null,
    notes: formData.get("notes") || null,
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    const operator = await requirePlatformOperator()
    await updateImplementationTraining(organizationId, trainingId, operator.operator.id, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update training." }
  }
  revalidate(organizationId)
  return ok
}

export async function addImplementationNoteAction(organizationId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = addImplementationNoteSchema.safeParse({ body: formData.get("body") })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    const operator = await requirePlatformOperator()
    await addImplementationNote(organizationId, operator.operator.id, parsed.data.body)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to add note." }
  }
  revalidate(organizationId)
  return ok
}

/**
 * §27/§28: one form, two independent underlying mutations — a planned date
 * (`updateTargetGoLiveDate`, new this phase) and the free-text owner
 * (`updateCommercialProfile`, already existing since P5.1 —
 * `implementationOwner` is already a field on it, never a second
 * profile-mutation path). Combined into a single Server Action only because
 * the dialog edits both together; each underlying function remains its own
 * independently-callable, independently-audited mutation.
 */
export async function updateImplementationSummaryAction(organizationId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const dateParsed = updateTargetGoLiveDateSchema.safeParse({ targetGoLiveDate: formData.get("targetGoLiveDate") || null })
  if (!dateParsed.success) return { error: dateParsed.error.issues[0]?.message ?? "Invalid target go-live date." }
  const ownerParsed = updateCommercialProfileSchema.safeParse({ implementationOwner: formData.get("implementationOwner") || null })
  if (!ownerParsed.success) return { error: ownerParsed.error.issues[0]?.message ?? "Invalid implementation owner." }

  try {
    const operator = await requirePlatformOperator()
    await updateTargetGoLiveDate(organizationId, operator.operator.id, dateParsed.data.targetGoLiveDate ?? null)
    await updateCommercialProfile(organizationId, ownerParsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update target go-live date / implementation owner." }
  }
  revalidate(organizationId)
  return ok
}

export async function completeHandoverAction(organizationId: string): Promise<ActionState> {
  try {
    const operator = await requirePlatformOperator()
    await completeHandover(organizationId, operator.operator.id)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to complete handover." }
  }
  revalidate(organizationId)
  return ok
}
