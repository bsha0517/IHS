"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import { requestLeave, approveLeave, rejectLeave, setLeaveBalance } from "@/lib/domains/hr/leave"
import { leaveRequestSchema, leaveBalanceSchema } from "@/lib/domains/hr/schemas"

export type ActionState = { error?: string; success?: boolean }

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  return session
}

export async function requestLeaveAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = leaveRequestSchema.safeParse({
    employeeId: formData.get("employeeId"),
    leaveType: formData.get("leaveType"),
    startDate: formData.get("startDate"),
    endDate: formData.get("endDate"),
    reason: formData.get("reason"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await requestLeave(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to submit leave request." }
  }
  revalidatePath("/leave")
  return { success: true }
}

export async function approveLeaveAction(leaveRequestId: string) {
  const session = await requireSession()
  await approveLeave(session, leaveRequestId)
  revalidatePath("/leave")
}

export async function rejectLeaveAction(leaveRequestId: string, reason: string) {
  const session = await requireSession()
  await rejectLeave(session, leaveRequestId, reason)
  revalidatePath("/leave")
}

export async function setLeaveBalanceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = leaveBalanceSchema.safeParse({
    employeeId: formData.get("employeeId"),
    leaveType: formData.get("leaveType"),
    year: formData.get("year"),
    allocatedDays: formData.get("allocatedDays"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await setLeaveBalance(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to set leave balance." }
  }
  revalidatePath("/leave")
  return { success: true }
}
