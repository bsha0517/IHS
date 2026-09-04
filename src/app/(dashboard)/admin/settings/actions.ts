"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import {
  updateOrganization,
  createBranch,
  updateBranch,
  createDepartment,
  updateDepartment,
  createRoom,
} from "@/lib/domains/identity/org-structure"
import { organizationSchema, branchSchema, departmentSchema, roomSchema } from "@/lib/domains/identity/schemas"
import { setSetting, PORTAL_CLINICAL_RELEASE_KEY } from "@/lib/platform/settings"

export type ActionState = { error?: string; success?: boolean }

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  return session
}

export async function updateOrganizationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = organizationSchema.safeParse({
    legalName: formData.get("legalName"),
    displayName: formData.get("displayName"),
    defaultCurrency: formData.get("defaultCurrency"),
    defaultTimezone: formData.get("defaultTimezone"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await updateOrganization(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update organization." }
  }
  revalidatePath("/admin/settings")
  return { success: true }
}

export async function createBranchAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = branchSchema.safeParse({
    name: formData.get("name"),
    code: formData.get("code"),
    timezone: formData.get("timezone"),
    address: formData.get("address") || null,
    phone: formData.get("phone") || null,
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await createBranch(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create branch." }
  }
  revalidatePath("/admin/settings")
  return { success: true }
}

export async function createDepartmentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = departmentSchema.safeParse({
    branchId: formData.get("branchId"),
    name: formData.get("name"),
    code: formData.get("code"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await createDepartment(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create department." }
  }
  revalidatePath("/admin/settings")
  return { success: true }
}

export async function createRoomAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = roomSchema.safeParse({
    departmentId: formData.get("departmentId"),
    name: formData.get("name"),
    code: formData.get("code"),
    roomType: formData.get("roomType"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await createRoom(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create room." }
  }
  revalidatePath("/admin/settings")
  return { success: true }
}

/**
 * P3.12 §9: a branch with historical appointments/invoices/stock/journals/
 * employees/payroll/clinical records must never be destructively deleted —
 * `Branch.status` (active/inactive) already existed in the schema with no
 * UI to change it. No delete button is being added; this is the only
 * lifecycle control a branch gets.
 */
export async function toggleBranchStatusAction(branchId: string, status: "active" | "inactive") {
  const session = await requireSession()
  await updateBranch(session, branchId, { status })
  revalidatePath("/admin/settings")
}

/** P3.12 §38: resolves the P3.10 backlog item — minimal Department management (status only; create already existed above). */
export async function toggleDepartmentStatusAction(departmentId: string, status: "active" | "inactive") {
  const session = await requireSession()
  await updateDepartment(session, departmentId, { status })
  revalidatePath("/admin/settings")
}

export async function setPortalClinicalReleaseAction(enabled: boolean) {
  const session = await requireSession()
  await setSetting(session, PORTAL_CLINICAL_RELEASE_KEY, enabled)
  revalidatePath("/admin/settings")
}
