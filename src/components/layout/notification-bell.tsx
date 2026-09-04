import Link from "next/link"
import { Bell } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * P3.11 §8/§9/§44/§49: a plain server-rendered Link + badge — no client
 * component, no polling, no WebSocket. `unreadCount` is computed once in
 * the root dashboard layout (one cheap indexed `count()` query — see
 * getUnreadCount) and passed down; it refreshes whenever the layout
 * re-renders (any navigation), exactly the "page refresh, server-rendered
 * unread count" V1 behavior §44 asks for. §52: the count itself is the
 * accessible signal (aria-label spells it out), not a bare colored dot.
 */
export function NotificationBell({ unreadCount }: { unreadCount: number }) {
  const label = unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications, no unread"

  return (
    <Button asChild variant="ghost" size="icon" aria-label={label} className="relative">
      <Link href="/notifications">
        <Bell className="size-4.5" />
        {unreadCount > 0 && (
          <span className="absolute top-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium text-destructive-foreground">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </Link>
    </Button>
  )
}
