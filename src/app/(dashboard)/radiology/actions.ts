"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import { createImagingService, updateImagingService, deactivateImagingService } from "@/lib/domains/radiology/catalog"
import { assignImagingService, scheduleImaging, markPerformed } from "@/lib/domains/radiology/orders"
import { writeReport, verifyImagingResult } from "@/lib/domains/radiology/results"
import { imagingServiceSchema, assignImagingServiceSchema, scheduleImagingSchema, writeReportSchema } from "@/lib/domains/radiology/schemas"

export type ActionState = { error?: string; success?: boolean }

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  return session
}

function readServiceForm(formData: FormData) {
  return imagingServiceSchema.safeParse({
    code: formData.get("code"),
    name: formData.get("name"),
    category: formData.get("category"),
    bodyPart: formData.get("bodyPart"),
    price: formData.get("price"),
    turnaroundHours: formData.get("turnaroundHours"),
  })
}

export async function createImagingServiceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = readServiceForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    await createImagingService(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create imaging service." }
  }
  revalidatePath("/radiology")
  return { success: true }
}

export async function updateImagingServiceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const id = String(formData.get("imagingServiceId") ?? "")
  const parsed = readServiceForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    await updateImagingService(session, id, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update imaging service." }
  }
  revalidatePath("/radiology")
  return { success: true }
}

export async function deactivateImagingServiceAction(id: string) {
  const session = await requireSession()
  await deactivateImagingService(session, id)
  revalidatePath("/radiology")
}

export async function assignImagingServiceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const clinicalOrderId = String(formData.get("clinicalOrderId") ?? "")
  const parsed = assignImagingServiceSchema.safeParse({ imagingServiceId: formData.get("imagingServiceId") })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    await assignImagingService(session, clinicalOrderId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to assign imaging service." }
  }
  revalidatePath(`/radiology/orders/${clinicalOrderId}`)
  revalidatePath("/radiology")
  return { success: true }
}

export async function scheduleImagingAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const imagingOrderId = String(formData.get("imagingOrderId") ?? "")
  const clinicalOrderId = String(formData.get("clinicalOrderId") ?? "")
  const parsed = scheduleImagingSchema.safeParse({
    scheduledAt: formData.get("scheduledAt"),
    roomId: formData.get("roomId"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    await scheduleImaging(session, imagingOrderId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to schedule." }
  }
  revalidatePath(`/radiology/orders/${clinicalOrderId}`)
  return { success: true }
}

export async function markPerformedAction(imagingOrderId: string, clinicalOrderId: string) {
  const session = await requireSession()
  await markPerformed(session, imagingOrderId)
  revalidatePath(`/radiology/orders/${clinicalOrderId}`)
}

export async function writeReportAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const imagingOrderId = String(formData.get("imagingOrderId") ?? "")
  const clinicalOrderId = String(formData.get("clinicalOrderId") ?? "")
  const parsed = writeReportSchema.safeParse({
    reportText: formData.get("reportText"),
    impression: formData.get("impression"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    await writeReport(session, imagingOrderId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to save report." }
  }
  revalidatePath(`/radiology/orders/${clinicalOrderId}`)
  return { success: true }
}

export async function verifyImagingResultAction(imagingOrderId: string, clinicalOrderId: string) {
  const session = await requireSession()
  await verifyImagingResult(session, imagingOrderId)
  revalidatePath(`/radiology/orders/${clinicalOrderId}`)
}
