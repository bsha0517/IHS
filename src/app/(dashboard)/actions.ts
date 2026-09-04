"use server"

import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import { logout } from "@/lib/auth/service"
import { getCurrentSession } from "@/lib/auth/session"
import { setActiveBranch } from "@/lib/domains/identity/org-structure"

export async function logoutAction() {
  await logout()
  redirect("/login")
}

export type SwitchBranchState = { error?: string }

/** P3.12 §18-21: the global branch switcher. A preference change only — see org-structure.ts's `setActiveBranch` for the actual authorization narrowing. */
export async function switchBranchAction(_prev: SwitchBranchState, formData: FormData): Promise<SwitchBranchState> {
  const session = await getCurrentSession()
  if (!session) return { error: "Not authenticated." }

  const branchId = String(formData.get("branchId") ?? "")
  if (!branchId) return { error: "Select a branch." }

  try {
    await setActiveBranch(session, branchId)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to switch branch." }
  }
  // Every page under (dashboard) can read the new activeBranchId on its
  // next render — a full-layout revalidate, not a targeted one, since
  // which pages consume it varies.
  revalidatePath("/", "layout")
  return {}
}
