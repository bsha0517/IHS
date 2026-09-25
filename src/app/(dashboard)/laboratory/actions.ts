"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import { assertModuleEnabled } from "@/lib/platform/entitlements"
import { createLabTest, updateLabTest, createLabPanel } from "@/lib/domains/laboratory/catalog"
import { assignTests, collectSpecimen, rejectSpecimen, receiveSpecimen } from "@/lib/domains/laboratory/orders"
import { enterNumericResult, enterTextResult, verifyResult, amendLabResult } from "@/lib/domains/laboratory/results"
import { labTestSchema, labPanelSchema, assignTestsSchema, enterNumericResultSchema, enterTextResultSchema } from "@/lib/domains/laboratory/schemas"

export type ActionState = { error?: string; success?: boolean }

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  await assertModuleEnabled(session.user.organizationId, "laboratory")
  return session
}

function readTestForm(formData: FormData) {
  return labTestSchema.safeParse({
    code: formData.get("code"),
    name: formData.get("name"),
    category: formData.get("category"),
    specimenType: formData.get("specimenType"),
    resultType: formData.get("resultType"),
    unit: formData.get("unit"),
    referenceRangeLow: formData.get("referenceRangeLow"),
    referenceRangeHigh: formData.get("referenceRangeHigh"),
    referenceRangeText: formData.get("referenceRangeText"),
    price: formData.get("price"),
    turnaroundHours: formData.get("turnaroundHours"),
  })
}

export async function createLabTestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = readTestForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    const session = await requireSession()
    await createLabTest(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create lab test." }
  }
  revalidatePath("/laboratory")
  return { success: true }
}

export async function updateLabTestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = String(formData.get("labTestId") ?? "")
  const parsed = readTestForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    const session = await requireSession()
    await updateLabTest(session, id, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update lab test." }
  }
  revalidatePath("/laboratory")
  return { success: true }
}

export async function createLabPanelAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = labPanelSchema.safeParse({
    code: formData.get("code"),
    name: formData.get("name"),
    price: formData.get("price"),
    testIds: formData.getAll("testIds"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    const session = await requireSession()
    await createLabPanel(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create panel." }
  }
  revalidatePath("/laboratory")
  return { success: true }
}

export async function assignTestsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const clinicalOrderId = String(formData.get("clinicalOrderId") ?? "")

  let lines: unknown
  try {
    lines = JSON.parse(String(formData.get("lines") ?? "[]"))
  } catch {
    return { error: "Invalid test selection." }
  }

  const parsed = assignTestsSchema.safeParse({ specimenType: formData.get("specimenType"), lines })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    const session = await requireSession()
    await assignTests(session, clinicalOrderId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to assign tests." }
  }
  revalidatePath(`/laboratory/orders/${clinicalOrderId}`)
  revalidatePath("/laboratory")
  return { success: true }
}

export async function collectSpecimenAction(specimenId: string, clinicalOrderId: string) {
  const session = await requireSession()
  await collectSpecimen(session, specimenId)
  revalidatePath(`/laboratory/orders/${clinicalOrderId}`)
}

export async function receiveSpecimenAction(specimenId: string, clinicalOrderId: string) {
  const session = await requireSession()
  await receiveSpecimen(session, specimenId)
  revalidatePath(`/laboratory/orders/${clinicalOrderId}`)
}

export async function rejectSpecimenAction(specimenId: string, clinicalOrderId: string, reason: string) {
  const session = await requireSession()
  await rejectSpecimen(session, specimenId, { rejectionReason: reason })
  revalidatePath(`/laboratory/orders/${clinicalOrderId}`)
}

export async function enterNumericResultAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const labOrderTestId = String(formData.get("labOrderTestId") ?? "")
  const clinicalOrderId = String(formData.get("clinicalOrderId") ?? "")
  const parsed = enterNumericResultSchema.safeParse({
    numericValue: formData.get("numericValue"),
    notes: formData.get("notes"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    const session = await requireSession()
    await enterNumericResult(session, labOrderTestId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to enter result." }
  }
  revalidatePath(`/laboratory/orders/${clinicalOrderId}`)
  return { success: true }
}

export async function enterTextResultAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const labOrderTestId = String(formData.get("labOrderTestId") ?? "")
  const clinicalOrderId = String(formData.get("clinicalOrderId") ?? "")
  const parsed = enterTextResultSchema.safeParse({
    textValue: formData.get("textValue"),
    notes: formData.get("notes"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    const session = await requireSession()
    await enterTextResult(session, labOrderTestId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to enter result." }
  }
  revalidatePath(`/laboratory/orders/${clinicalOrderId}`)
  return { success: true }
}

export async function verifyResultAction(labOrderTestId: string, clinicalOrderId: string) {
  const session = await requireSession()
  await verifyResult(session, labOrderTestId)
  revalidatePath(`/laboratory/orders/${clinicalOrderId}`)
}

/** P1 §21: corrects an already-verified result via a new, isCurrent row — never edits the original in place. */
export async function amendNumericResultAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const labOrderTestId = String(formData.get("labOrderTestId") ?? "")
  const clinicalOrderId = String(formData.get("clinicalOrderId") ?? "")
  const parsed = enterNumericResultSchema.safeParse({
    numericValue: formData.get("numericValue"),
    notes: formData.get("notes"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    const session = await requireSession()
    await amendLabResult(session, labOrderTestId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to amend result." }
  }
  revalidatePath(`/laboratory/orders/${clinicalOrderId}`)
  return { success: true }
}

export async function amendTextResultAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const labOrderTestId = String(formData.get("labOrderTestId") ?? "")
  const clinicalOrderId = String(formData.get("clinicalOrderId") ?? "")
  const parsed = enterTextResultSchema.safeParse({
    textValue: formData.get("textValue"),
    notes: formData.get("notes"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    const session = await requireSession()
    await amendLabResult(session, labOrderTestId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to amend result." }
  }
  revalidatePath(`/laboratory/orders/${clinicalOrderId}`)
  return { success: true }
}
