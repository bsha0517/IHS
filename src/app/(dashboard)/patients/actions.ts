"use server"

import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import {
  findPotentialDuplicates,
  registerPatient,
  addAllergy,
  addCondition,
  addMedicationHistory,
  listPatients,
  type DuplicateCandidate,
} from "@/lib/domains/patients/service"
import { patientSchema, allergySchema, conditionSchema, medicationHistorySchema } from "@/lib/domains/patients/schemas"
import { enablePortalAccess, resetPortalPassword, deactivatePortalAccess } from "@/lib/domains/portal/service"

export type ActionState = { error?: string; success?: boolean }

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  return session
}

function readPatientForm(formData: FormData) {
  return patientSchema.safeParse({
    registrationBranchId: formData.get("registrationBranchId"),
    firstName: formData.get("firstName"),
    middleName: formData.get("middleName"),
    lastName: formData.get("lastName"),
    dob: formData.get("dob"),
    gender: formData.get("gender"),
    nationality: formData.get("nationality"),
    mobile: formData.get("mobile"),
    whatsapp: formData.get("whatsapp"),
    email: formData.get("email"),
    addressLine: formData.get("addressLine"),
    city: formData.get("city"),
    country: formData.get("country"),
    nationalId: formData.get("nationalId"),
    passportNumber: formData.get("passportNumber"),
    emergencyContactName: formData.get("emergencyContactName"),
    emergencyContactRelationship: formData.get("emergencyContactRelationship"),
    emergencyContactPhone: formData.get("emergencyContactPhone"),
    preferredLanguage: formData.get("preferredLanguage"),
    referralSource: formData.get("referralSource"),
    preferredProviderId: formData.get("preferredProviderId"),
  })
}

export type CheckDuplicatesState = { error?: string; candidates?: DuplicateCandidate[]; checked?: boolean }

export async function checkDuplicatesAction(
  _prev: CheckDuplicatesState,
  formData: FormData
): Promise<CheckDuplicatesState> {
  const session = await requireSession()
  const parsed = readPatientForm(formData)
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Fix the highlighted fields first." }
  }

  const candidates = await findPotentialDuplicates(session, {
    mobile: parsed.data.mobile,
    email: parsed.data.email,
    nationalId: parsed.data.nationalId,
    firstName: parsed.data.firstName,
    lastName: parsed.data.lastName,
    dob: parsed.data.dob,
  })

  return { candidates, checked: true }
}

export async function registerPatientAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = readPatientForm(formData)
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Fix the highlighted fields first." }
  }

  const duplicateOverrideReason = String(formData.get("duplicateOverrideReason") ?? "").trim() || undefined

  let patient
  try {
    patient = await registerPatient(session, parsed.data, { duplicateOverrideReason })
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to register patient." }
  }

  redirect(`/patients/${patient.id}`)
}

/** Lightweight live-search used by patient-picker combobox controls (booking, reception). */
export async function searchPatientsAction(query: string) {
  const session = await requireSession()
  if (!query.trim()) return []
  const { patients } = await listPatients(session, { search: query, page: 1 })
  return patients.slice(0, 8).map((p) => ({
    id: p.id,
    mrn: p.mrn,
    firstName: p.firstName,
    lastName: p.lastName,
    mobile: p.mobile,
  }))
}

export async function addAllergyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const patientId = String(formData.get("patientId") ?? "")
  const parsed = allergySchema.safeParse({
    allergen: formData.get("allergen"),
    reaction: formData.get("reaction"),
    severity: formData.get("severity"),
    isAlert: formData.get("isAlert") === "on",
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await addAllergy(session, patientId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to add allergy." }
  }
  revalidatePath(`/patients/${patientId}`)
  return { success: true }
}

export async function addConditionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const patientId = String(formData.get("patientId") ?? "")
  const parsed = conditionSchema.safeParse({
    category: formData.get("category"),
    description: formData.get("description"),
    isAlert: formData.get("isAlert") === "on",
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await addCondition(session, patientId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to add condition." }
  }
  revalidatePath(`/patients/${patientId}`)
  return { success: true }
}

export async function addMedicationHistoryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const patientId = String(formData.get("patientId") ?? "")
  const parsed = medicationHistorySchema.safeParse({
    medicationName: formData.get("medicationName"),
    dose: formData.get("dose"),
    status: formData.get("status"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await addMedicationHistory(session, patientId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to add medication history." }
  }
  revalidatePath(`/patients/${patientId}`)
  return { success: true }
}

export type PortalActionState = { error?: string; success?: boolean; tempPassword?: string }

export async function enablePortalAccessAction(_prev: PortalActionState, formData: FormData): Promise<PortalActionState> {
  const session = await requireSession()
  const patientId = String(formData.get("patientId") ?? "")
  const email = String(formData.get("email") ?? "")
  if (!email) return { error: "Email is required." }
  try {
    const { tempPassword } = await enablePortalAccess(session, patientId, email)
    revalidatePath(`/patients/${patientId}`)
    return { success: true, tempPassword }
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to enable portal access." }
  }
}

export async function resetPortalPasswordAction(patientId: string): Promise<PortalActionState> {
  const session = await requireSession()
  try {
    const { tempPassword } = await resetPortalPassword(session, patientId)
    revalidatePath(`/patients/${patientId}`)
    return { success: true, tempPassword }
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to reset password." }
  }
}

export async function deactivatePortalAccessAction(patientId: string) {
  const session = await requireSession()
  await deactivatePortalAccess(session, patientId)
  revalidatePath(`/patients/${patientId}`)
}
