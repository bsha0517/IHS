"use server"

import { redirect } from "next/navigation"
import { platformLogout } from "@/lib/auth/platform-service"

export async function platformLogoutAction() {
  await platformLogout()
  redirect("/platform/login")
}
