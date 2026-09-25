"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { LogOut, Building2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { platformLogoutAction } from "@/app/platform/actions"

const NAV = [
  { label: "Dashboard", href: "/platform" },
  { label: "Organizations", href: "/platform/organizations" },
  { label: "Provision Clinic", href: "/platform/provision" },
  { label: "Plans", href: "/platform/plans" },
  { label: "Support Tickets", href: "/platform/tickets" },
]

/**
 * P5.1 §20/§44: deliberately its own component, not a reuse of the clinic
 * `Topbar`/`AppSidebar` — no branch switcher, no notification bell, no
 * module-color sidebar (§44's own "do not make them look like clinical
 * screens"). Neutral slate + the Avant teal brand mark, a flat top nav
 * (four destinations total — a sidebar would be over-built for this many).
 */
export function PlatformTopbar({ operator }: { operator: { firstName: string; lastName: string; email: string } }) {
  const pathname = usePathname()
  const initials = `${operator.firstName[0] ?? ""}${operator.lastName[0] ?? ""}`.toUpperCase()

  return (
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 md:px-6">
        <div className="flex items-center gap-6">
          <Link href="/platform" className="flex items-center gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-slate-100">
              <Building2 className="size-4 text-slate-600" />
            </span>
            <span className="text-sm font-semibold">Avant Platform</span>
          </Link>
          <nav className="hidden items-center gap-1 sm:flex">
            {NAV.map((item) => {
              const isActive = pathname === item.href || (item.href !== "/platform" && pathname.startsWith(`${item.href}/`))
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    isActive ? "bg-slate-100 text-slate-900" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  {item.label}
                </Link>
              )
            })}
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <Avatar className="size-7">
            <AvatarFallback className="text-xs">{initials}</AvatarFallback>
          </Avatar>
          <span className="hidden text-sm text-muted-foreground sm:inline">
            {operator.firstName} {operator.lastName}
          </span>
          <form action={platformLogoutAction}>
            <Button type="submit" variant="ghost" size="icon-sm" aria-label="Sign out">
              <LogOut className="size-4" />
            </Button>
          </form>
        </div>
      </div>
      <nav className="flex items-center gap-1 overflow-x-auto border-t border-border px-4 py-2 sm:hidden">
        {NAV.map((item) => (
          <Link key={item.href} href={item.href} className="shrink-0 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted">
            {item.label}
          </Link>
        ))}
      </nav>
    </header>
  )
}
