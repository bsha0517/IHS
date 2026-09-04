"use server"

import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { z } from "zod"
import { login as loginService } from "@/lib/auth/service"
import { safeInternalRedirectPath } from "@/lib/platform/safe-redirect"

const loginSchema = z.object({
  // P4.3 §33: a bounded max on top of the existing email format check — an
  // unauthenticated endpoint accepting an unbounded string is a resource-
  // abuse surface (a multi-megabyte "email" field costs this handler real
  // parsing/hashing-adjacent work before it's ever rejected as invalid).
  email: z.email("Enter a valid email address").max(254),
  // No format constraint here beyond presence — this verifies an EXISTING
  // password's hash, it doesn't create one, so the complexity policy in
  // identity/schemas.ts's createUserSchema doesn't apply. The max is purely
  // a resource-abuse bound (§33), generous enough to never reject any real
  // password/passphrase a user actually set.
  password: z.string().min(1, "Password is required").max(256),
  from: z.string().max(2048).optional(),
})

export type LoginFormState = {
  error?: string
}

export async function loginAction(_prevState: LoginFormState, formData: FormData): Promise<LoginFormState> {
  const parsed = loginSchema.safeParse({
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

  const result = await loginService(parsed.data.email, parsed.data.password, { ip, userAgent })

  if (!result.ok) {
    return { error: result.error }
  }

  redirect(safeInternalRedirectPath(parsed.data.from) ?? result.redirectTo)
}
