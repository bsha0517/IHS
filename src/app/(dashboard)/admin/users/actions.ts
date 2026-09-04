"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import { createUser, updateUser } from "@/lib/domains/identity/users"
import { createUserSchema, updateUserSchema } from "@/lib/domains/identity/schemas"

export type ActionState = { error?: string; success?: boolean }

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  return session
}

export async function createUserAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = createUserSchema.safeParse({
    email: formData.get("email"),
    username: formData.get("username") || null,
    firstName: formData.get("firstName"),
    lastName: formData.get("lastName"),
    password: formData.get("password"),
    roleIds: formData.getAll("roleIds"),
    branchIds: formData.getAll("branchIds"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await createUser(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create user." }
  }
  revalidatePath("/admin/users")
  return { success: true }
}

export async function toggleUserStatusAction(userId: string, status: "active" | "inactive") {
  const session = await requireSession()
  await updateUser(session, userId, { status })
  revalidatePath("/admin/users")
}

/**
 * P3.12 §16: previously the only way to change an existing user's role(s)
 * or authorized branch(es) was direct DB access — `updateUser` supported
 * it, nothing in the UI ever called it with `roleIds`/`branchIds`.
 *
 * A plain HTML checkbox group submits nothing at all for `name="roleIds"`
 * when every box is unchecked — indistinguishable, via `formData.has`
 * alone, from the field never having been rendered. That distinction
 * matters here: "the admin explicitly cleared every role" (a real, if
 * unusual, intent — `roleIds: []`) must NOT be confused with "this field
 * wasn't part of the submission at all" (must stay `undefined`, so
 * `updateUser` leaves existing roles untouched). The dialog therefore adds
 * an explicit hidden marker alongside each checkbox group; presence of the
 * marker, not of any checked box, decides whether that field is included.
 */
export async function updateUserAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const userId = String(formData.get("userId") ?? "")
  const parsed = updateUserSchema.safeParse({
    firstName: formData.get("firstName"),
    lastName: formData.get("lastName"),
    status: formData.get("status"),
    roleIds: formData.has("rolesFieldPresent") ? formData.getAll("roleIds") : undefined,
    branchIds: formData.has("branchesFieldPresent") ? formData.getAll("branchIds") : undefined,
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await updateUser(session, userId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update user." }
  }
  revalidatePath("/admin/users")
  return { success: true }
}
