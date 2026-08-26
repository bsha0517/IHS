"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import { createPayrollRun, updatePayrollLine, movePayrollToReview, approvePayrollRun, markPayrollPaid } from "@/lib/domains/payroll/payroll"
import { payrollRunSchema, payrollLineSchema } from "@/lib/domains/payroll/schemas"

export type ActionState = { error?: string; success?: boolean }

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  return session
}

export async function createPayrollRunAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = payrollRunSchema.safeParse({
    branchId: formData.get("branchId"),
    periodStart: formData.get("periodStart"),
    periodEnd: formData.get("periodEnd"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await createPayrollRun(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create payroll run." }
  }
  revalidatePath("/payroll")
  return { success: true }
}

export async function updatePayrollLineAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const lineId = String(formData.get("lineId") ?? "")
  const payrollRunId = String(formData.get("payrollRunId") ?? "")
  const parsed = payrollLineSchema.safeParse({
    allowances: formData.get("allowances"),
    overtime: formData.get("overtime"),
    bonus: formData.get("bonus"),
    advances: formData.get("advances"),
    unpaidLeaveDeduction: formData.get("unpaidLeaveDeduction"),
    otherDeductions: formData.get("otherDeductions"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await updatePayrollLine(session, lineId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update payroll line." }
  }
  revalidatePath(`/payroll/${payrollRunId}`)
  return { success: true }
}

export async function movePayrollToReviewAction(payrollRunId: string) {
  const session = await requireSession()
  await movePayrollToReview(session, payrollRunId)
  revalidatePath(`/payroll/${payrollRunId}`)
}

export async function approvePayrollRunAction(payrollRunId: string) {
  const session = await requireSession()
  await approvePayrollRun(session, payrollRunId)
  revalidatePath(`/payroll/${payrollRunId}`)
}

export async function markPayrollPaidAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const payrollRunId = String(formData.get("payrollRunId") ?? "")
  const paidVia = String(formData.get("paidVia") ?? "")

  try {
    await markPayrollPaid(session, payrollRunId, paidVia)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to mark payroll paid." }
  }
  revalidatePath(`/payroll/${payrollRunId}`)
  return { success: true }
}
