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
