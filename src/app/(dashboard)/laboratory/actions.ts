"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import { createLabTest, updateLabTest, deactivateLabTest, createLabPanel, deactivateLabPanel } from "@/lib/domains/laboratory/catalog"
import { assignTests, collectSpecimen, rejectSpecimen, receiveSpecimen } from "@/lib/domains/laboratory/orders"
import { enterNumericResult, enterTextResult, verifyResult } from "@/lib/domains/laboratory/results"
import { labTestSchema, labPanelSchema, assignTestsSchema, enterNumericResultSchema, enterTextResultSchema } from "@/lib/domains/laboratory/schemas"

export type ActionState = { error?: string; success?: boolean }

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
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
  const session = await requireSession()
  const parsed = readTestForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    await createLabTest(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create lab test." }
  }
  revalidatePath("/laboratory")
  return { success: true }
}

export async function updateLabTestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const id = String(formData.get("labTestId") ?? "")
  const parsed = readTestForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    await updateLabTest(session, id, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update lab test." }
  }
  revalidatePath("/laboratory")
  return { success: true }
}

export async function deactivateLabTestAction(id: string) {
  const session = await requireSession()
  await deactivateLabTest(session, id)
  revalidatePath("/laboratory")
}

export async function createLabPanelAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = labPanelSchema.safeParse({
    code: formData.get("code"),
    name: formData.get("name"),
    price: formData.get("price"),
    testIds: formData.getAll("testIds"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    await createLabPanel(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create panel." }
  }
  revalidatePath("/laboratory")
  return { success: true }
}

export async function deactivateLabPanelAction(id: string) {
  const session = await requireSession()
  await deactivateLabPanel(session, id)
  revalidatePath("/laboratory")
}

export async function assignTestsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
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
  const session = await requireSession()
  const labOrderTestId = String(formData.get("labOrderTestId") ?? "")
  const clinicalOrderId = String(formData.get("clinicalOrderId") ?? "")
  const parsed = enterNumericResultSchema.safeParse({
    numericValue: formData.get("numericValue"),
    notes: formData.get("notes"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    await enterNumericResult(session, labOrderTestId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to enter result." }
  }
  revalidatePath(`/laboratory/orders/${clinicalOrderId}`)
  return { success: true }
}

export async function enterTextResultAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const labOrderTestId = String(formData.get("labOrderTestId") ?? "")
  const clinicalOrderId = String(formData.get("clinicalOrderId") ?? "")
  const parsed = enterTextResultSchema.safeParse({
    textValue: formData.get("textValue"),
    notes: formData.get("notes"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
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
