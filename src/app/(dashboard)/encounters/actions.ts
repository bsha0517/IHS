"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { startEncounter, completeEncounter, finalizeEncounter } from "@/lib/domains/clinical/encounters"
import { recordVitals } from "@/lib/domains/clinical/vitals"
import { saveNote, createAmendment } from "@/lib/domains/clinical/notes"
import { addDiagnosis, updateDiagnosisStatus, searchDiagnosisCodes } from "@/lib/domains/clinical/diagnoses"
import { createOrder, updateOrderStatus } from "@/lib/domains/clinical/orders"
import { createPrescription, cancelPrescription } from "@/lib/domains/clinical/prescriptions"
import { recommendFollowUp, dismissFollowUp } from "@/lib/domains/clinical/follow-ups"
import {
  encounterSchema,
  vitalSignSchema,
  clinicalNoteSchema,
  diagnosisSchema,
  clinicalOrderSchema,
  prescriptionSchema,
  followUpSchema,
} from "@/lib/domains/clinical/schemas"

export type ActionState = { error?: string; success?: boolean }

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  return session
}

function revalidateEncounter(encounterId: string) {
  revalidatePath(`/encounters/${encounterId}`)
  revalidatePath("/appointments")
  revalidatePath("/reception")
  revalidatePath("/queue")
}

export async function startEncounterAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = encounterSchema.safeParse({
    branchId: formData.get("branchId"),
    departmentId: formData.get("departmentId"),
    patientId: formData.get("patientId"),
    episodeId: formData.get("episodeId"),
    appointmentId: formData.get("appointmentId"),
    providerId: formData.get("providerId"),
    encounterType: formData.get("encounterType") || "consultation",
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  let encounter
  try {
    encounter = await startEncounter(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to start encounter." }
  }
  redirect(`/encounters/${encounter.id}`)
}

export async function completeEncounterAction(encounterId: string) {
  const session = await requireSession()
  await completeEncounter(session, encounterId)
  revalidateEncounter(encounterId)
}

export async function finalizeEncounterAction(encounterId: string) {
  const session = await requireSession()
  await finalizeEncounter(session, encounterId)
  revalidateEncounter(encounterId)
}

export async function recordVitalsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const encounterId = String(formData.get("encounterId") ?? "")
  const parsed = vitalSignSchema.safeParse({
    heightCm: formData.get("heightCm"),
    weightKg: formData.get("weightKg"),
    bloodPressureSystolic: formData.get("bloodPressureSystolic"),
    bloodPressureDiastolic: formData.get("bloodPressureDiastolic"),
    pulseBpm: formData.get("pulseBpm"),
    temperatureCelsius: formData.get("temperatureCelsius"),
    oxygenSaturationPercent: formData.get("oxygenSaturationPercent"),
    respiratoryRatePerMin: formData.get("respiratoryRatePerMin"),
    bloodGlucoseMgDl: formData.get("bloodGlucoseMgDl"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await recordVitals(session, encounterId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to record vitals." }
  }
  revalidateEncounter(encounterId)
  return { success: true }
}

function readNoteForm(formData: FormData) {
  return clinicalNoteSchema.safeParse({
    noteType: formData.get("noteType") || "consultation",
    chiefComplaint: formData.get("chiefComplaint"),
    historyOfPresentIllness: formData.get("historyOfPresentIllness"),
    reviewOfSystems: formData.get("reviewOfSystems"),
    examinationFindings: formData.get("examinationFindings"),
    assessment: formData.get("assessment"),
    treatmentPlan: formData.get("treatmentPlan"),
    content: formData.get("content"),
  })
}

export async function saveNoteAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const encounterId = String(formData.get("encounterId") ?? "")
  const parsed = readNoteForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await saveNote(session, encounterId, parsed.data.noteType, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to save note." }
  }
  revalidateEncounter(encounterId)
  return { success: true }
}

export async function createAmendmentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const noteId = String(formData.get("noteId") ?? "")
  const encounterId = String(formData.get("encounterId") ?? "")
  const parsed = readNoteForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await createAmendment(session, noteId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to save amendment." }
  }
  revalidateEncounter(encounterId)
  return { success: true }
}

export async function searchDiagnosisCodesAction(query: string) {
  await requireSession()
  return searchDiagnosisCodes(query)
}

export async function addDiagnosisAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const encounterId = String(formData.get("encounterId") ?? "")
  const parsed = diagnosisSchema.safeParse({
    diagnosisCode: formData.get("diagnosisCode"),
    description: formData.get("description"),
    isPrimary: formData.get("isPrimary") === "on",
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await addDiagnosis(session, encounterId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to add diagnosis." }
  }
  revalidateEncounter(encounterId)
  return { success: true }
}

export async function updateDiagnosisStatusAction(
  encounterId: string,
  diagnosisId: string,
  status: "active" | "resolved" | "ruled_out"
) {
  const session = await requireSession()
  await updateDiagnosisStatus(session, diagnosisId, status)
  revalidateEncounter(encounterId)
}

export async function createOrderAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const encounterId = String(formData.get("encounterId") ?? "")
  const parsed = clinicalOrderSchema.safeParse({
    orderType: formData.get("orderType"),
    priority: formData.get("priority") || "routine",
    instructions: formData.get("instructions"),
    testName: formData.get("testName"),
    specimenType: formData.get("specimenType"),
    imagingType: formData.get("imagingType"),
    bodyPart: formData.get("bodyPart"),
    procedureName: formData.get("procedureName"),
    referralScope: formData.get("referralScope"),
    referredToProviderId: formData.get("referredToProviderId"),
    referredToExternal: formData.get("referredToExternal"),
    reason: formData.get("reason"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await createOrder(session, encounterId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create order." }
  }
  revalidateEncounter(encounterId)
  return { success: true }
}

export async function updateOrderStatusAction(
  encounterId: string,
  orderId: string,
  status: "acknowledged" | "in_progress" | "completed" | "cancelled"
) {
  const session = await requireSession()
  await updateOrderStatus(session, orderId, status)
  revalidateEncounter(encounterId)
}

export async function createPrescriptionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const encounterId = String(formData.get("encounterId") ?? "")

  let rawItems: unknown
  try {
    rawItems = JSON.parse(String(formData.get("items") ?? "[]"))
  } catch {
    return { error: "Invalid medication list." }
  }
  const parsed = prescriptionSchema.safeParse({ items: rawItems })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await createPrescription(session, encounterId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create prescription." }
  }
  revalidateEncounter(encounterId)
  return { success: true }
}

export async function cancelPrescriptionAction(encounterId: string, prescriptionId: string) {
  const session = await requireSession()
  await cancelPrescription(session, prescriptionId)
  revalidateEncounter(encounterId)
}

export async function recommendFollowUpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const encounterId = String(formData.get("encounterId") ?? "")
  const parsed = followUpSchema.safeParse({
    recommendedDate: formData.get("recommendedDate"),
    reason: formData.get("reason"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await recommendFollowUp(session, encounterId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to add follow-up." }
  }
  revalidateEncounter(encounterId)
  return { success: true }
}

export async function dismissFollowUpAction(encounterId: string, followUpId: string) {
  const session = await requireSession()
  await dismissFollowUp(session, followUpId)
  revalidateEncounter(encounterId)
}
