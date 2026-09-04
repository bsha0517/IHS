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
    // Targeted backlog closure, item 8.
    substitutionConfirmed: formData.get("substitutionConfirmed") === "on",
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

export async function verifyDispensingRecordAction(id: string, prescriptionId: string): Promise<ActionState> {
  const session = await requireSession()
  try {
    await verifyDispensingRecord(session, id)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to verify dispensing record." }
  }
  revalidatePath(`/pharmacy/${prescriptionId}`)
  return { success: true }
}

export async function dispenseRecordAction(id: string, prescriptionId: string): Promise<ActionState> {
  const session = await requireSession()
  try {
    await dispenseRecord(session, id)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to dispense." }
  }
  revalidatePath(`/pharmacy/${prescriptionId}`)
  revalidatePath("/pharmacy")
  return { success: true }
}

export type ReturnActionState = ActionState & { financialReversal?: "reversed" | "manual_review_required" | "not_applicable" }

/**
 * P3.9 §39: `financialReversal` is relayed back to the dialog so it can
 * state plainly what actually happened financially — never let a
 * successful stock return silently imply money was refunded or credited.
 * See returnDispensingRecord's own doc comment (dispensing.ts) for the
 * three possible outcomes and why.
 */
export async function returnDispensingRecordAction(_prev: ReturnActionState, formData: FormData): Promise<ReturnActionState> {
  const session = await requireSession()
  const id = String(formData.get("dispensingRecordId") ?? "")
  const prescriptionId = String(formData.get("prescriptionId") ?? "")
  const parsed = returnDispensingSchema.safeParse({
    quantityReturned: formData.get("quantityReturned"),
    reason: formData.get("reason"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  let financialReversal: ReturnActionState["financialReversal"]
  try {
    const result = await returnDispensingRecord(session, id, parsed.data)
    financialReversal = result.financialReversal
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to record return." }
  }
  revalidatePath(`/pharmacy/${prescriptionId}`)
  return { success: true, financialReversal }
}

export async function setPharmacyEnabledAction(enabled: boolean) {
  const session = await requireSession()
  await setSetting(session, PHARMACY_ENABLED_KEY, enabled)
  revalidatePath("/admin/settings")
}
