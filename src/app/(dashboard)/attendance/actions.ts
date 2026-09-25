"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import { assertModuleEnabled } from "@/lib/platform/entitlements"
import { createShift, checkIn, checkOut, adjustAttendance } from "@/lib/domains/hr/attendance"
import { shiftSchema, checkInSchema, attendanceAdjustSchema } from "@/lib/domains/hr/schemas"

export type ActionState = { error?: string; success?: boolean }

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  await assertModuleEnabled(session.user.organizationId, "hr")
  return session
}

export async function createShiftAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = shiftSchema.safeParse({
    name: formData.get("name"),
    startTime: formData.get("startTime"),
    endTime: formData.get("endTime"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    const session = await requireSession()
    await createShift(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create shift." }
  }
  revalidatePath("/attendance")
  return { success: true }
}

export async function checkInSimpleAction(employeeId: string, branchId: string, shiftId: string | null) {
  const session = await requireSession()
  const parsed = checkInSchema.safeParse({ employeeId, branchId, shiftId })
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid input.")
  await checkIn(session, parsed.data)
  revalidatePath("/attendance")
}

export async function checkOutSimpleAction(attendanceRecordId: string) {
  const session = await requireSession()
  await checkOut(session, attendanceRecordId)
  revalidatePath("/attendance")
}

export async function adjustAttendanceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const attendanceRecordId = String(formData.get("attendanceRecordId") ?? "")
  const parsed = attendanceAdjustSchema.safeParse({
    checkInAt: formData.get("checkInAt"),
    checkOutAt: formData.get("checkOutAt"),
    breakMinutes: formData.get("breakMinutes"),
    status: formData.get("status"),
    notes: formData.get("notes"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    const session = await requireSession()
    await adjustAttendance(session, attendanceRecordId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to adjust attendance." }
  }
  revalidatePath("/attendance")
  return { success: true }
}
