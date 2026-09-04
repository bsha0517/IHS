"use server"

import { z } from "zod"
import { requestPasswordReset, confirmPasswordReset } from "@/lib/auth/service"

export type ResetRequestState = { error?: string; submitted?: boolean }

const requestSchema = z.object({ email: z.email().max(254) })

/**
 * Always returns the same shape regardless of whether the account exists
 * (no enumeration) — the UI shows one honest, generic message either way:
 * "if that account exists, this is where a reset email would go, but
 * delivery isn't configured in this environment."
 */
export async function requestPasswordResetAction(_prevState: ResetRequestState, formData: FormData): Promise<ResetRequestState> {
  const parsed = requestSchema.safeParse({ email: formData.get("email") })
  if (!parsed.success) {
    return { error: "Enter a valid email address." }
  }
  await requestPasswordReset(parsed.data.email)
  return { submitted: true }
}

export type ResetConfirmState = { error?: string; success?: boolean }

const confirmSchema = z.object({
  token: z.string().min(1).max(256),
  password: z.string().min(8, "Password must be at least 8 characters").max(256),
  confirmPassword: z.string().max(256),
})

export async function confirmPasswordResetAction(_prevState: ResetConfirmState, formData: FormData): Promise<ResetConfirmState> {
  const parsed = confirmSchema.safeParse({
    token: formData.get("token"),
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  }
  if (parsed.data.password !== parsed.data.confirmPassword) {
    return { error: "Passwords do not match." }
  }

  const result = await confirmPasswordReset(parsed.data.token, parsed.data.password)
  if (!result.ok) {
    return { error: result.error ?? "This reset link is invalid or has expired." }
  }
  return { success: true }
}
