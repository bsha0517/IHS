import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { resolveDefaultLandingRoute } from "@/lib/platform/landing"

export default async function RootPage() {
  const session = await getCurrentSession()
  redirect(session ? resolveDefaultLandingRoute(session) : "/login")
}
