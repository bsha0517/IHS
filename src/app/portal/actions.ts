"use server"

import { redirect } from "next/navigation"
import { z } from "zod"
import { portalLogout } from "@/lib/auth/portal-service"
import { getCurrentPortalSession } from "@/lib/auth/portal-session"
import { updatePortalProfile } from "@/lib/domains/portal/data"

export async function portalLogoutAction() {
  await portalLogout()
  redirect("/portal/login")
}

export type PortalProfileFormState = { error?: string; success?: boolean }

const updateProfileSchema = z.object({
  mobile: z.string().min(5).max(30),
  email: z.string().email().or(z.literal("")),
  addressLine: z.string().max(300).optional(),
  city: z.string().max(100).optional(),
})

export async function updatePortalProfileAction(_prev: PortalProfileFormState, formData: FormData): Promise<PortalProfileFormState> {
  const session = await getCurrentPortalSession()
  if (!session) redirect("/portal/login")

  const parsed = updateProfileSchema.safeParse({
    mobile: formData.get("mobile"),
    email: formData.get("email"),
    addressLine: formData.get("addressLine"),
    city: formData.get("city"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  await updatePortalProfile(session, {
    mobile: parsed.data.mobile,
    email: parsed.data.email || undefined,
    addressLine: parsed.data.addressLine,
    city: parsed.data.city,
  })
  return { success: true }
}
