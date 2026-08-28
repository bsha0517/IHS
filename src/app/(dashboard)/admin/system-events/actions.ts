"use server"

import { getCurrentSession } from "@/lib/auth/session"
import { retrySystemEventAsAdmin, sweepSystemEventsAsAdmin } from "@/lib/platform/system-events"

export type RetryEventState = { error?: string; success?: boolean }

export async function retrySystemEventAction(_prevState: RetryEventState, formData: FormData): Promise<RetryEventState> {
  const session = await getCurrentSession()
  if (!session) return { error: "Not authenticated." }

  const eventId = formData.get("eventId")
  if (typeof eventId !== "string" || !eventId) return { error: "Missing event id." }

  try {
    await retrySystemEventAsAdmin(session, eventId)
    return { success: true }
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Retry failed." }
  }
}

export type SweepState = { error?: string; success?: boolean; recovered?: number; processed?: number }

export async function sweepSystemEventsAction(): Promise<SweepState> {
  const session = await getCurrentSession()
  if (!session) return { error: "Not authenticated." }

  try {
    const result = await sweepSystemEventsAsAdmin(session)
    return { success: true, ...result }
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Sweep failed." }
  }
}
