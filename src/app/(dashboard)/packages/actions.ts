"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import { createPackage, purchasePackage, consumeSession } from "@/lib/domains/packages/service"
import { packageSchema, purchasePackageSchema, consumeSessionSchema } from "@/lib/domains/packages/schemas"

export type ActionState = { error?: string; success?: boolean }

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  return session
}

export async function createPackageAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  let services: unknown
  try {
    services = JSON.parse(String(formData.get("services") ?? "[]"))
  } catch {
    return { error: "Invalid service list." }
  }
  const parsed = packageSchema.safeParse({
    code: formData.get("code"),
    name: formData.get("name"),
    description: formData.get("description"),
    price: formData.get("price"),
    discountAmount: formData.get("discountAmount") || 0,
    validityDays: formData.get("validityDays"),
    services,
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await createPackage(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create package." }
  }
  revalidatePath("/packages")
  return { success: true }
}

export async function purchasePackageAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const patientId = String(formData.get("patientId") ?? "")
  const parsed = purchasePackageSchema.safeParse({
    patientId,
    branchId: formData.get("branchId"),
    packageId: formData.get("packageId"),
    priceOverride: formData.get("priceOverride"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await purchasePackage(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to sell package." }
  }
  revalidatePath(`/patients/${patientId}`)
  return { success: true }
}

export async function consumeSessionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const patientId = String(formData.get("patientId") ?? "")
  const parsed = consumeSessionSchema.safeParse({
    patientPackageId: formData.get("patientPackageId"),
    packageServiceId: formData.get("packageServiceId"),
    encounterId: formData.get("encounterId"),
    notes: formData.get("notes"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await consumeSession(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to record session usage." }
  }
  revalidatePath(`/patients/${patientId}`)
  return { success: true }
}
