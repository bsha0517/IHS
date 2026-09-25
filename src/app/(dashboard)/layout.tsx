import type { ReactNode } from "react"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { getUnreadCount } from "@/lib/domains/notifications/service"
import { listSwitchableBranches } from "@/lib/domains/identity/org-structure"
import { getModuleEntitlements } from "@/lib/platform/entitlements"
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar"
import { AppSidebar } from "@/components/layout/app-sidebar"
import { Topbar } from "@/components/layout/topbar"

// Authoritative session check (Node runtime, DB-backed) — the second of three
// independent authorization layers described in ARCHITECTURE.md §10. Middleware's
// cookie-presence check is optimistic only; this is where an expired/revoked
// session actually gets rejected.
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await getCurrentSession()

  if (!session) {
    redirect("/login")
  }

  // P3.11 §8/§49: one cheap indexed count query in the root layout, not a
  // full notification fetch and not another domain dashboard — the bell's
  // badge is the only thing this layout needs from the notification
  // system. P3.12 §63: same discipline for the branch switcher — one small
  // query for the whole layout, not a query per nav item.
  const [unreadNotificationCount, switchableBranches, entitlements] = await Promise.all([
    getUnreadCount(session),
    listSwitchableBranches(session),
    getModuleEntitlements(session.user.organizationId),
  ])

  return (
    <SidebarProvider>
      <AppSidebar permissions={Array.from(session.permissions)} entitlements={entitlements} />
      <SidebarInset>
        <Topbar
          user={session.user}
          roleNames={session.roleNames}
          unreadNotificationCount={unreadNotificationCount}
          switchableBranches={switchableBranches}
          activeBranchId={session.activeBranchId}
        />
        <main className="flex flex-1 flex-col gap-4 p-4 md:p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  )
}
