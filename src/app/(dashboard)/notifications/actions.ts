"use server"

import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import { markNotificationRead, markAllNotificationsRead, isSafeInternalPath } from "@/lib/domains/notifications/service"

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  return session
}

/**
 * Bound per-row (`.bind(null, id, destination)`) to a plain `<form>`'s
 * action — opening a notification marks it read AND navigates to its real
 * destination in one progressive-enhancement-friendly step, no client
 * component required. `destination` is always a value this app's own
 * `resolveNotificationDestination` produced (never client-supplied), and is
 * re-validated here regardless (§14 — never trust a stored/passed path
 * blindly, even one this app generated itself).
 */
export async function openNotificationAction(id: string, destination: string) {
  const session = await requireSession()
  await markNotificationRead(session, id)
  revalidatePath("/notifications")
  if (isSafeInternalPath(destination)) redirect(destination)
  redirect("/notifications")
}

export async function markNotificationReadAction(id: string) {
  const session = await requireSession()
  await markNotificationRead(session, id)
  revalidatePath("/notifications")
}

export async function markAllNotificationsReadAction() {
  const session = await requireSession()
  await markAllNotificationsRead(session)
  revalidatePath("/notifications")
}
