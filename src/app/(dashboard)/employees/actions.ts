"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import { createEmployee, updateEmployee, addEmployeeDocument } from "@/lib/domains/hr/employees"
import { employeeSchema, employeeDocumentSchema } from "@/lib/domains/hr/schemas"

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
