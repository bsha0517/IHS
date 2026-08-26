"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import { createUser, updateUser } from "@/lib/domains/identity/users"
import { createUserSchema } from "@/lib/domains/identity/schemas"

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
