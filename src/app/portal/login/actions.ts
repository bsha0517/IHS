"use server"

import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { z } from "zod"
import { portalLogin } from "@/lib/auth/portal-service"

const portalLoginSchema = z.object({
  // P4.3 §33: same resource-abuse bound as staff login (src/app/login/actions.ts).
  email: z.email("Enter a valid email address").max(254),
  password: z.string().min(1, "Password is required").max(256),
})

export type PortalLoginFormState = { error?: string }

export async function portalLoginAction(_prevState: PortalLoginFormState, formData: FormData): Promise<PortalLoginFormState> {
  const parsed = portalLoginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  }

  const headerList = await headers()
  const ip = headerList.get("x-forwarded-for") ?? headerList.get("x-real-ip")
  const userAgent = headerList.get("user-agent")

  const result = await portalLogin(parsed.data.email, parsed.data.password, { ip, userAgent })
  if (!result.ok) {
    return { error: result.error }
  }

  redirect("/portal")
}
