import type { ReactNode } from "react"
import { redirect } from "next/navigation"
import { getCurrentPlatformSession } from "@/lib/auth/platform-session"
import { PlatformTopbar } from "@/components/layout/platform-topbar"

/**
 * P5.1 §20/§84: the authenticated platform shell — a per-page wrapper
 * rather than a `layout.tsx`. A route-GROUP layout (`platform/(shell)/...`)
 * was tried first and worked functionally, but Next.js 16's Turbopack dev
 * server on Windows could not reliably write/read that route's manifest
 * once a dynamic segment sat two levels below the group
 * (`(shell)/organizations/[id]`) — reproducible, survived a full `.next`
 * cache clear and dev-server restart, isolated to that exact path shape.
 * This wrapper gets the identical result (session re-check + topbar) with
 * a flat file layout Turbopack has no trouble with. Every `/platform/*`
 * page except `/platform/login` wraps its content in this.
 */
export async function PlatformPageShell({ children }: { children: ReactNode }) {
  const session = await getCurrentPlatformSession()
  if (!session) redirect("/platform/login")

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <PlatformTopbar operator={session.operator} />
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 p-4 md:p-6">{children}</main>
    </div>
  )
}
