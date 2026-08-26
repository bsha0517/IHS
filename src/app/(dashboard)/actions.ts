"use server"

import { redirect } from "next/navigation"
import { logout } from "@/lib/auth/service"

export async function logoutAction() {
  await logout()
  redirect("/login")
}
