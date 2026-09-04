"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import { createEmployee, updateEmployee, updateEmployeeStatus, addEmployeeDocument } from "@/lib/domains/hr/employees"
import { linkEmployeeUser, unlinkEmployeeUser } from "@/lib/domains/identity/users"
import { employeeSchema, employeeDocumentSchema, updateEmployeeStatusSchema } from "@/lib/domains/hr/schemas"

export type ActionState = { error?: string; success?: boolean }

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  return session
}

function readEmployeeForm(formData: FormData) {
  return employeeSchema.safeParse({
    branchId: formData.get("branchId"),
    departmentId: formData.get("departmentId"),
    userId: formData.get("userId"),
    firstName: formData.get("firstName"),
    lastName: formData.get("lastName"),
    designation: formData.get("designation"),
    managerId: formData.get("managerId"),
    joiningDate: formData.get("joiningDate"),
    employmentType: formData.get("employmentType"),
    basicSalary: formData.get("basicSalary"),
    bankDetails: formData.get("bankDetails"),
  })
}

export async function createEmployeeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = readEmployeeForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await createEmployee(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create employee." }
  }
  revalidatePath("/employees")
  return { success: true }
}

export async function updateEmployeeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const employeeId = String(formData.get("employeeId") ?? "")
  const parsed = readEmployeeForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await updateEmployee(session, employeeId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update employee." }
  }
  revalidatePath("/employees")
  revalidatePath(`/employees/${employeeId}`)
  return { success: true }
}

/**
 * P3.10 §12/§13: `updateEmployeeStatus` (hr/employees.ts) already existed —
 * permission-gated, branch-checked, audited, and safe (it only ever flips a
 * status column, never deletes the row or its attendance/leave/payroll/
 * commission history) — but no UI anywhere ever called it. HR had no way
 * to mark an employee terminated/on-leave/active except through the
 * general "Edit employee" form, which doesn't expose status at all. Wires
 * the existing action; no new lifecycle states, no settlement workflow.
 */
export async function updateEmployeeStatusAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const employeeId = String(formData.get("employeeId") ?? "")
  const parsed = updateEmployeeStatusSchema.safeParse({ status: formData.get("status") })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await updateEmployeeStatus(session, employeeId, parsed.data.status)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update employee status." }
  }
  revalidatePath("/employees")
  revalidatePath(`/employees/${employeeId}`)
  return { success: true }
}

/** P3.12 §14: resolves the P3.10 backlog item — Admin-only (`users.manage`, checked in the domain function, not merely by the button being hidden). */
export async function linkEmployeeUserAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const employeeId = String(formData.get("employeeId") ?? "")
  const userId = String(formData.get("userId") ?? "")
  if (!userId) return { error: "Select a user to link." }

  try {
    await linkEmployeeUser(session, employeeId, userId)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to link user." }
  }
  revalidatePath(`/employees/${employeeId}`)
  return { success: true }
}

export async function unlinkEmployeeUserAction(employeeId: string) {
  const session = await requireSession()
  await unlinkEmployeeUser(session, employeeId)
  revalidatePath(`/employees/${employeeId}`)
}

export async function addEmployeeDocumentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const employeeId = String(formData.get("employeeId") ?? "")
  const parsed = employeeDocumentSchema.safeParse({
    documentType: formData.get("documentType"),
    documentNumber: formData.get("documentNumber"),
    issueDate: formData.get("issueDate"),
    expiryDate: formData.get("expiryDate"),
    notes: formData.get("notes"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await addEmployeeDocument(session, employeeId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to add document." }
  }
  revalidatePath(`/employees/${employeeId}`)
  return { success: true }
}
