"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Stethoscope } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { NAV_GROUPS } from "@/components/layout/nav-config"
import type { ModuleKey } from "@/lib/platform/entitlements-shared"

export function AppSidebar({
  permissions,
  entitlements,
}: {
  permissions: string[]
  /** P5.1 §15: which modules this organization's subscription has enabled — undefined entries default to visible (see nav-config.ts's own NavItem.moduleKey doc comment). */
  entitlements?: Partial<Record<ModuleKey, boolean>>
}) {
  const pathname = usePathname()
  const permissionSet = new Set(permissions)

  const visibleGroups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => {
      if (item.permission && !permissionSet.has(item.permission)) return false
      if (item.moduleKey && entitlements?.[item.moduleKey] === false) return false
      return true
    }),
  })).filter((group) => group.items.length > 0)

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        {/* P4.10 §8 — the one deliberate, one-time use of the warm accent
            color: the brand mark itself, so the wordmark carries a touch of
            personality while every recurring surface in the app (nav items,
            buttons, badges) stays on the cooler primary/neutral palette —
            "sparingly" taken literally, not "everywhere at 10% opacity." */}
        <div className="flex items-center gap-2 px-2 py-1.5">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent-warm-surface">
            <Stethoscope className="size-4 text-accent-warm" />
          </span>
          <span className="truncate text-sm font-semibold group-data-[collapsible=icon]:hidden">
            Avant Health
          </span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        {visibleGroups.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`)
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton asChild isActive={isActive} tooltip={item.label}>
                        <Link href={item.href}>
                          <item.icon className={cn(!isActive && group.accentClass)} />
                          <span>{item.label}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
    </Sidebar>
  )
}
