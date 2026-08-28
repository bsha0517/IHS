"use server"

import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { z } from "zod"
import { login as loginService } from "@/lib/auth/service"

const loginSchema = z.object({
  email: z.email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
  from: z.string().optional(),
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

  redirect(parsed.data.from && parsed.data.from.startsWith("/") ? parsed.data.from : "/dashboard")
}
