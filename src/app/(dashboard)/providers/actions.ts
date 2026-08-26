"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import {
  createProvider,
  updateProvider,
  createProviderSchedule,
  deleteProviderSchedule,
  createProviderLeaveBlock,
  deleteProviderLeaveBlock,
  linkEmployee,
} from "@/lib/domains/providers/service"
import { providerSchema, providerScheduleSchema, providerLeaveBlockSchema, linkEmployeeSchema } from "@/lib/domains/providers/schemas"

export type ActionState = { error?: string; success?: boolean }

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  return session
}

export async function createProviderAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = providerSchema.safeParse({
    providerType: formData.get("providerType"),
    firstName: formData.get("firstName"),
    lastName: formData.get("lastName"),
    specialty: formData.get("specialty"),
    qualification: formData.get("qualification"),
    licenseNumber: formData.get("licenseNumber"),
    licenseAuthority: formData.get("licenseAuthority"),
    licenseExpiryDate: formData.get("licenseExpiryDate"),
    consultationFee: formData.get("consultationFee"),
    defaultAppointmentDurationMinutes: formData.get("defaultAppointmentDurationMinutes"),
    branchIds: formData.getAll("branchIds"),
    departmentIds: formData.getAll("departmentIds"),
    userId: formData.get("userId"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await createProvider(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create provider." }
  }
  revalidatePath("/providers")
  return { success: true }
}

export async function updateProviderAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const providerId = String(formData.get("providerId") ?? "")
  const parsed = providerSchema.safeParse({
    providerType: formData.get("providerType"),
    firstName: formData.get("firstName"),
    lastName: formData.get("lastName"),
    specialty: formData.get("specialty"),
    qualification: formData.get("qualification"),
    licenseNumber: formData.get("licenseNumber"),
    licenseAuthority: formData.get("licenseAuthority"),
    licenseExpiryDate: formData.get("licenseExpiryDate"),
    consultationFee: formData.get("consultationFee"),
    defaultAppointmentDurationMinutes: formData.get("defaultAppointmentDurationMinutes"),
    branchIds: formData.getAll("branchIds"),
    departmentIds: formData.getAll("departmentIds"),
    userId: formData.get("userId"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await updateProvider(session, providerId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update provider." }
  }
  revalidatePath(`/providers/${providerId}`)
  return { success: true }
}

export async function createProviderScheduleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const providerId = String(formData.get("providerId") ?? "")
  const parsed = providerScheduleSchema.safeParse({
    branchId: formData.get("branchId"),
    departmentId: formData.get("departmentId"),
    roomId: formData.get("roomId"),
    dayOfWeek: formData.get("dayOfWeek"),
    startTime: formData.get("startTime"),
    endTime: formData.get("endTime"),
    slotDurationMinutes: formData.get("slotDurationMinutes"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await createProviderSchedule(session, providerId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to add schedule." }
  }
  revalidatePath(`/providers/${providerId}`)
  return { success: true }
}

export async function deleteProviderScheduleAction(providerId: string, scheduleId: string) {
  const session = await requireSession()
  await deleteProviderSchedule(session, scheduleId)
  revalidatePath(`/providers/${providerId}`)
}

export async function createProviderLeaveBlockAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const providerId = String(formData.get("providerId") ?? "")
  const parsed = providerLeaveBlockSchema.safeParse({
    startAt: formData.get("startAt"),
    endAt: formData.get("endAt"),
    reason: formData.get("reason"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await createProviderLeaveBlock(session, providerId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to add leave block." }
  }
  revalidatePath(`/providers/${providerId}`)
  return { success: true }
}

export async function deleteProviderLeaveBlockAction(providerId: string, blockId: string) {
  const session = await requireSession()
  await deleteProviderLeaveBlock(session, blockId)
  revalidatePath(`/providers/${providerId}`)
}

export async function linkEmployeeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const providerId = String(formData.get("providerId") ?? "")
  const parsed = linkEmployeeSchema.safeParse({ employeeId: formData.get("employeeId") })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await linkEmployee(session, providerId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to link employee." }
  }
  revalidatePath(`/providers/${providerId}`)
  return { success: true }
}
