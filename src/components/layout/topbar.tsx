import { LogOut } from "lucide-react"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { NotificationBell } from "@/components/layout/notification-bell"
import { BranchSwitcher } from "@/components/layout/branch-switcher"
import { logoutAction } from "@/app/(dashboard)/actions"

export function Topbar({
  user,
  roleNames,
  unreadNotificationCount,
  switchableBranches,
  activeBranchId,
}: {
  user: { firstName: string; lastName: string; email: string }
  roleNames: string[]
  unreadNotificationCount: number
  switchableBranches: { id: string; name: string }[]
  activeBranchId: string | null
}) {
  const initials = `${user.firstName[0] ?? ""}${user.lastName[0] ?? ""}`.toUpperCase()

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
      <div className="flex items-center gap-2">
        <SidebarTrigger />
        <Separator orientation="vertical" className="h-5" />
        {/* P3.12 §53: the active branch is real context worth showing next to
            navigation, not just inside the user menu — but only rendered
            once there's an actual choice to make (P3.12 §18-21). */}
        {switchableBranches.length > 1 && (
          <BranchSwitcher branches={switchableBranches} activeBranchId={activeBranchId} />
        )}
      </div>

      <div className="flex items-center gap-1">
        <NotificationBell unreadCount={unreadNotificationCount} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="flex items-center gap-2 px-2">
              <Avatar className="size-7">
                <AvatarFallback className="text-xs">{initials}</AvatarFallback>
              </Avatar>
              <span className="text-sm font-medium">
                {user.firstName} {user.lastName}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">
                  {user.firstName} {user.lastName}
                </span>
                <span className="text-xs text-muted-foreground">{user.email}</span>
                {/* P3.12 §53: role(s) shown here, not the sidebar/header — a user
                    menu is exactly where "who am I signed in as" belongs, and
                    this is display-only (no UI reads it for authorization). */}
                {roleNames.length > 0 && (
                  <span className="text-xs text-muted-foreground">{roleNames.join(", ")}</span>
                )}
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <form action={logoutAction}>
              <DropdownMenuItem asChild>
                <button type="submit" className="flex w-full items-center gap-2">
                  <LogOut className="size-4" />
                  Log out
                </button>
              </DropdownMenuItem>
            </form>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
