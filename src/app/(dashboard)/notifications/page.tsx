import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { listNotifications, getNotificationTypesForUser, getOperationalAwarenessLinks, getUnreadCount } from "@/lib/domains/notifications/service"
import { formatDateTime } from "@/lib/utils/dates"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { PageHeader } from "@/components/ui/page-header"
import Link from "next/link"
import { NotificationFilters } from "@/app/(dashboard)/notifications/notification-filters"
import { MarkReadButton } from "@/app/(dashboard)/notifications/mark-read-button"
import { MarkAllReadButton } from "@/app/(dashboard)/notifications/mark-all-read-button"
import { openNotificationAction } from "@/app/(dashboard)/notifications/actions"
import { PaginationControls } from "@/components/domain/pagination-controls"

/**
 * P3.11 §7 — the Notification Center P2 left as an explicit backlog item
 * ("Notifications have no read-side UI"). Any authenticated user may open
 * this — Notification is inherently scoped to `recipientUserId`, not gated
 * by a permission code (none exists in the seed catalog, and none is
 * needed: "can you see this" is answered entirely by "is this addressed to
 * you").
 */
export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; type?: string; page?: string }>
}) {
  const session = await getCurrentSession()
  if (!session) redirect("/login")

  const sp = await searchParams
  const status = sp.status === "unread" || sp.status === "read" ? sp.status : undefined

  const [{ notifications, total, page, totalPages }, types, awarenessLinks, unreadCount] = await Promise.all([
    listNotifications(session, { status, type: sp.type, page: sp.page ? Number(sp.page) : undefined }),
    getNotificationTypesForUser(session),
    getOperationalAwarenessLinks(session),
    getUnreadCount(session),
  ])

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Notifications"
        module="notifications"
        description={unreadCount > 0 ? `${unreadCount} unread notification(s).` : "You're all caught up."}
        primaryAction={<MarkAllReadButton disabled={unreadCount === 0} />}
      />

      {/* §53: links/counts into existing operational queues — never a copy of their records. */}
      {awarenessLinks.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {awarenessLinks.map((link) => (
            <Link key={link.href + link.label} href={link.href}>
              <Card className="transition-colors hover:bg-muted/50">
                <CardContent className="flex items-center justify-between pt-6">
                  <span className="text-sm text-muted-foreground">{link.label}</span>
                  <span className="text-xl font-semibold">{link.count}</span>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <NotificationFilters types={types} sp={sp} />

      <Card>
        <CardContent className="p-0">
          {notifications.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">No notifications requiring your attention.</p>
          ) : (
            <ul className="divide-y divide-border">
              {notifications.map((n) => {
                const isUnread = n.status === "unread"
                const content = (
                  <div className="flex flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {/* §52: unread state is never color-only — an explicit "Unread" badge plus bold text carry the distinction too. */}
                      {isUnread && (
                        <Badge variant="default" className="text-[10px]">
                          Unread
                        </Badge>
                      )}
                      <Badge variant="outline" className="text-[10px]">
                        {n.typeLabel}
                      </Badge>
                      <span className="text-xs text-muted-foreground">{formatDateTime(n.createdAt)}</span>
                    </div>
                    <span className={isUnread ? "font-semibold" : "font-medium"}>{n.title}</span>
                    <p className="text-sm text-muted-foreground">{n.body}</p>
                  </div>
                )

                return (
                  <li key={n.id} className="flex items-start gap-3 p-4">
                    {n.destination ? (
                      <form action={openNotificationAction.bind(null, n.id, n.destination)} className="flex-1 text-left">
                        <button type="submit" className="flex w-full flex-1 text-left">
                          {content}
                        </button>
                      </form>
                    ) : (
                      content
                    )}
                    {isUnread && <MarkReadButton id={n.id} />}
                  </li>
                )
              })}
            </ul>
          )}
          <div className="px-4 pb-4">
            <PaginationControls page={page} totalPages={totalPages} total={total} basePath="/notifications" searchParams={sp} />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
