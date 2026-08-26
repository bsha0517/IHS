"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import { createRole, updateRolePermissions } from "@/lib/domains/identity/roles"
import { roleSchema } from "@/lib/domains/identity/schemas"

export type ActionState = { error?: string; success?: boolean }

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  return session
}

export async function createRoleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = roleSchema.safeParse({
    name: formData.get("name"),
    permissionIds: formData.getAll("permissionIds"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await createRole(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create role." }
  }
  revalidatePath("/admin/roles")
  return { success: true }
}

export async function updateRolePermissionsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const roleId = String(formData.get("roleId") ?? "")
  const permissionIds = formData.getAll("permissionIds").map(String)
  if (!roleId) return { error: "Missing role." }

  try {
    await updateRolePermissions(session, roleId, permissionIds)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update role." }
  }
  revalidatePath("/admin/roles")
  return { success: true }
}
