"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import { createService, updateService } from "@/lib/domains/services/service"
import { serviceSchema } from "@/lib/domains/services/schemas"
import { setServiceConsumption } from "@/lib/domains/inventory/consumption-templates"
import { consumptionTemplateSchema } from "@/lib/domains/inventory/schemas"

export type ActionState = { error?: string; success?: boolean }

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  return session
}

function readForm(formData: FormData) {
  return serviceSchema.safeParse({
    code: formData.get("code"),
    name: formData.get("name"),
    category: formData.get("category"),
    departmentId: formData.get("departmentId"),
    description: formData.get("description"),
    durationMinutes: formData.get("durationMinutes"),
    price: formData.get("price"),
    billable: formData.get("billable") === "on",
    isActive: formData.get("isActive") === "on",
    requiredRoomType: formData.get("requiredRoomType"),
    providerIds: formData.getAll("providerIds"),
  })
}

export async function createServiceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = readForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await createService(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create service." }
  }
  revalidatePath("/services")
  return { success: true }
}

export async function setServiceConsumptionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const serviceId = String(formData.get("serviceId") ?? "")
  let rawLines: unknown
  try {
    rawLines = JSON.parse(String(formData.get("lines") ?? "[]"))
  } catch {
    return { error: "Invalid consumption list." }
  }
  const parsed = consumptionTemplateSchema.safeParse({ serviceId, lines: rawLines })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await setServiceConsumption(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to save consumption template." }
  }
  revalidatePath("/services")
  return { success: true }
}

export async function updateServiceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const serviceId = String(formData.get("serviceId") ?? "")
  const parsed = readForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await updateService(session, serviceId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update service." }
  }
  revalidatePath("/services")
  return { success: true }
}
