"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import { createEpisode } from "@/lib/domains/clinical/episodes"
import { episodeSchema } from "@/lib/domains/clinical/schemas"

export type ActionState = { error?: string; success?: boolean }

export async function createEpisodeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")

  const patientId = String(formData.get("patientId") ?? "")
  const parsed = episodeSchema.safeParse({
    branchId: formData.get("branchId"),
    patientId,
    episodeType: formData.get("episodeType"),
    title: formData.get("title"),
    description: formData.get("description"),
    startDate: formData.get("startDate"),
    primaryProviderId: formData.get("primaryProviderId"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await createEpisode(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create episode." }
  }
  revalidatePath(`/patients/${patientId}`)
  return { success: true }
}
