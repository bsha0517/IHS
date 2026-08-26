"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import { createMedication, updateMedication } from "@/lib/domains/pharmacy/medications"
import { createDispensingRecord, verifyDispensingRecord, dispenseRecord, returnDispensingRecord } from "@/lib/domains/pharmacy/dispensing"
import { medicationSchema, createDispensingRecordSchema, returnDispensingSchema } from "@/lib/domains/pharmacy/schemas"
import { setSetting, PHARMACY_ENABLED_KEY } from "@/lib/platform/settings"

export type ActionState = { error?: string; success?: boolean }

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  return session
}

function readMedicationForm(formData: FormData) {
  return medicationSchema.safeParse({
    sku: formData.get("sku"),
    barcode: formData.get("barcode"),
    name: formData.get("name"),
    category: formData.get("category"),
    brand: formData.get("brand"),
    unit: formData.get("unit"),
    purchaseCost: formData.get("purchaseCost"),
    sellingPrice: formData.get("sellingPrice"),
    reorderLevel: formData.get("reorderLevel"),
    minimumStock: formData.get("minimumStock"),
    maximumStock: formData.get("maximumStock"),
    genericName: formData.get("genericName"),
    strength: formData.get("strength"),
    dosageForm: formData.get("dosageForm"),
    route: formData.get("route"),
    controlledSubstance: formData.get("controlledSubstance") === "on",
    requiresPrescription: formData.get("requiresPrescription") === "on",
  })
}

export async function createMedicationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = readMedicationForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    await createMedication(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create medication." }
  }
  revalidatePath("/pharmacy")
  return { success: true }
}

export async function updateMedicationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const id = String(formData.get("medicationId") ?? "")
  const parsed = readMedicationForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    await updateMedication(session, id, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update medication." }
  }
  revalidatePath("/pharmacy")
  return { success: true }
}

export async function createDispensingRecordAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const prescriptionId = String(formData.get("prescriptionId") ?? "")
  const parsed = createDispensingRecordSchema.safeParse({
    prescriptionItemId: formData.get("prescriptionItemId"),
    medicationId: formData.get("medicationId"),
    quantityDispensed: formData.get("quantityDispensed"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    await createDispensingRecord(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create dispensing record." }
  }
  revalidatePath(`/pharmacy/${prescriptionId}`)
  revalidatePath("/pharmacy")
  return { success: true }
}

export async function verifyDispensingRecordAction(id: string, prescriptionId: string) {
  const session = await requireSession()
  await verifyDispensingRecord(session, id)
  revalidatePath(`/pharmacy/${prescriptionId}`)
}

export async function dispenseRecordAction(id: string, prescriptionId: string) {
  const session = await requireSession()
  await dispenseRecord(session, id)
  revalidatePath(`/pharmacy/${prescriptionId}`)
  revalidatePath("/pharmacy")
}

export async function returnDispensingRecordAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const id = String(formData.get("dispensingRecordId") ?? "")
  const prescriptionId = String(formData.get("prescriptionId") ?? "")
  const parsed = returnDispensingSchema.safeParse({
    quantityReturned: formData.get("quantityReturned"),
    reason: formData.get("reason"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    await returnDispensingRecord(session, id, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to record return." }
  }
  revalidatePath(`/pharmacy/${prescriptionId}`)
  return { success: true }
}

export async function setPharmacyEnabledAction(enabled: boolean) {
  const session = await requireSession()
  await setSetting(session, PHARMACY_ENABLED_KEY, enabled)
  revalidatePath("/admin/settings")
}
