"use server"

import {
  listPublicBranches,
  listPublicSpecialties,
  listPublicProviders,
  listPublicServices,
  listAvailableSlots,
  submitPublicBooking,
} from "@/lib/domains/booking/service"
import { publicBookingSchema } from "@/lib/domains/booking/schemas"

export async function fetchBranchesAction() {
  const branches = await listPublicBranches()
  return branches.map((b) => ({ id: b.id, name: b.name }))
}

export async function fetchSpecialtiesAction(branchId: string) {
  return listPublicSpecialties(branchId)
}

export async function fetchProvidersAction(branchId: string, specialty?: string) {
  const providers = await listPublicProviders(branchId, specialty)
  return providers.map((p) => ({ id: p.id, firstName: p.firstName, lastName: p.lastName, specialty: p.specialty }))
}

export async function fetchServicesAction(providerId: string) {
  const services = await listPublicServices(providerId)
  return services.map((s) => ({ id: s.id, name: s.name, durationMinutes: s.durationMinutes, price: Number(s.price) }))
}

export async function fetchSlotsAction(providerId: string, branchId: string, dateIso: string, serviceDurationMinutes: number) {
  const slots = await listAvailableSlots(providerId, branchId, new Date(dateIso), serviceDurationMinutes)
  return slots.map((s) => s.toISOString())
}

export type SubmitBookingState = { error?: string; success?: boolean; appointmentNumber?: string }

export async function submitBookingAction(_prev: SubmitBookingState, formData: FormData): Promise<SubmitBookingState> {
  const parsed = publicBookingSchema.safeParse({
    branchId: formData.get("branchId"),
    providerId: formData.get("providerId"),
    serviceId: formData.get("serviceId"),
    startTime: formData.get("startTime"),
    firstName: formData.get("firstName"),
    lastName: formData.get("lastName"),
    dob: formData.get("dob"),
    gender: formData.get("gender"),
    mobile: formData.get("mobile"),
    email: formData.get("email"),
    notes: formData.get("notes"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    const result = await submitPublicBooking(parsed.data)
    return { success: true, appointmentNumber: result.appointment.appointmentNumber }
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to book the appointment." }
  }
}
