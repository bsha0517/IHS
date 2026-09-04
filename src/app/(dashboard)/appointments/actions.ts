"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import {
  bookAppointment,
  confirmAppointment,
  markArrived,
  cancelAppointment,
  markNoShow,
  rescheduleAppointment,
  listStaffAvailableSlots,
} from "@/lib/domains/appointments/service"
import { checkIn as checkInPatient, callPatient, completeConsultation } from "@/lib/domains/appointments/service"
import { bookAppointmentSchema, rescheduleAppointmentSchema } from "@/lib/domains/appointments/schemas"

export type ActionState = { error?: string; success?: boolean }

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  return session
}

export async function bookAppointmentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = bookAppointmentSchema.safeParse({
    branchId: formData.get("branchId"),
    patientId: formData.get("patientId"),
    providerId: formData.get("providerId"),
    serviceId: formData.get("serviceId"),
    departmentId: formData.get("departmentId"),
    roomId: formData.get("roomId"),
    startTime: formData.get("startTime"),
    durationMinutes: formData.get("durationMinutes"),
    bookingSource: formData.get("bookingSource") || "staff",
    notes: formData.get("notes"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await bookAppointment(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to book appointment." }
  }
  revalidatePath("/appointments")
  revalidatePath("/reception")
  return { success: true }
}

export async function rescheduleAppointmentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const appointmentId = String(formData.get("appointmentId") ?? "")
  const parsed = rescheduleAppointmentSchema.safeParse({
    startTime: formData.get("startTime"),
    durationMinutes: formData.get("durationMinutes"),
    providerId: formData.get("providerId"),
    roomId: formData.get("roomId"),
    reason: formData.get("reason"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await rescheduleAppointment(session, appointmentId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to reschedule." }
  }
  revalidatePath("/appointments")
  return { success: true }
}

async function runStatusAction(fn: () => Promise<unknown>) {
  const paths = ["/appointments", "/reception", "/queue", "/dashboard"]
  try {
    await fn()
  } finally {
    for (const path of paths) revalidatePath(path)
  }
}

export async function confirmAppointmentAction(appointmentId: string) {
  const session = await requireSession()
  await runStatusAction(() => confirmAppointment(session, appointmentId))
}

export async function markArrivedAction(appointmentId: string) {
  const session = await requireSession()
  await runStatusAction(() => markArrived(session, appointmentId))
}

export async function checkInAction(appointmentId: string) {
  const session = await requireSession()
  await runStatusAction(() => checkInPatient(session, appointmentId))
}

export async function callPatientAction(appointmentId: string) {
  const session = await requireSession()
  await runStatusAction(() => callPatient(session, appointmentId))
}

export async function completeConsultationAction(appointmentId: string) {
  const session = await requireSession()
  await runStatusAction(() => completeConsultation(session, appointmentId))
}

export async function cancelAppointmentAction(appointmentId: string, reason: string) {
  const session = await requireSession()
  await runStatusAction(() => cancelAppointment(session, appointmentId, reason))
}

export async function markNoShowAction(appointmentId: string) {
  const session = await requireSession()
  await runStatusAction(() => markNoShow(session, appointmentId))
}

/**
 * P3.1 §12/§13: real-slot lookup for the New Appointment / Reschedule
 * dialogs. Returns ISO strings (not Date objects) across the client
 * boundary — the same convention `book/actions.ts`'s public equivalent
 * already established. Never throws a raw error to the client: an
 * unconfigured/no-schedule provider on the chosen day is a normal "no
 * slots" case, not a failure, and the underlying `listStaffAvailableSlots`
 * already returns an empty array for that rather than throwing.
 */
export async function listAvailableSlotsAction(
  providerId: string,
  branchId: string,
  dateIso: string,
  serviceDurationMinutes: number
): Promise<string[]> {
  const session = await requireSession()
  if (!providerId || !branchId || !dateIso) return []
  const slots = await listStaffAvailableSlots(session, {
    providerId,
    branchId,
    date: new Date(dateIso),
    serviceDurationMinutes: serviceDurationMinutes || 30,
  })
  return slots.map((s) => s.toISOString())
}
