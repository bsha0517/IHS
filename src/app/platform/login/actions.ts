"use server"

import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { z } from "zod"
import { platformLogin } from "@/lib/auth/platform-service"
import { safeInternalRedirectPath } from "@/lib/platform/safe-redirect"

const platformLoginSchema = z.object({
  email: z.email("Enter a valid email address").max(254),
  password: z.string().min(1, "Password is required").max(256),
  from: z.string().max(2048).optional(),
})

export type PlatformLoginFormState = {
  error?: string
}

export async function platformLoginAction(_prevState: PlatformLoginFormState, formData: FormData): Promise<PlatformLoginFormState> {
  const parsed = platformLoginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    from: formData.get("from"),
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  }

  const headerList = await headers()
  const ip = headerList.get("x-forwarded-for") ?? headerList.get("x-real-ip")
  const userAgent = headerList.get("user-agent")

  const result = await platformLogin(parsed.data.email, parsed.data.password, { ip, userAgent })

  if (!result.ok) {
    return { error: result.error }
  }

  redirect(safeInternalRedirectPath(parsed.data.from) ?? "/platform")
}
