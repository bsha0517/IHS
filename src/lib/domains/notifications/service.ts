import "server-only"
import { db } from "@/lib/db"
import { Prisma } from "@/generated/prisma/client"
import { can } from "@/lib/platform/permissions-core"
import { getAuthorizedBranchScope } from "@/lib/platform/branch-scope"
import { resolvePage, paginationSkipTake, totalPages } from "@/lib/platform/pagination"
import { log } from "@/lib/platform/logger"
import { listAccountingExceptions } from "@/lib/domains/accounting/exceptions"
import { listLowStock } from "@/lib/domains/inventory/stock"
import { notificationTypeLabel } from "@/lib/domains/notifications/labels"
import type { SessionContext } from "@/lib/auth/session"

// P3.11 §6: the real Notification model has existed since Phase 2
// (organization_id, recipient_user_id, type, title, body, reference_type,
// reference_id, status, created_at — see prisma/schema.prisma) and already
// had six real producers writing to it (event-handlers.ts x5, outbox.ts's
// notifyDeadLetter). What never existed was any read-side UI or a shared,
// idempotent creation path — this file is that missing piece, reusing the
// existing model exactly as-is. No NotificationV2/Alert/InboxMessage.

const NOTIFICATION_PAGE_SIZE = 50

export { notificationTypeLabel }

// ---------------------------------------------------------------------------
// Safe internal destination resolution (§12-14) — a notification never
// stores a URL; `referenceType`/`referenceId` (the model's own pre-existing
// fields) are resolved through this hardcoded, allowlisted switch, the only
// place a route string is ever produced. Nothing here is ever built from a
// stored free-text value, so there is no open-redirect / external-URL
// surface to defend against — `isSafeInternalPath` is a defense-in-depth
// assertion of that property, not the actual guard.
// ---------------------------------------------------------------------------

const DESTINATION_BUILDERS: Record<string, (referenceId: string) => string> = {
  appointment: (id) => `/appointments/${id}`,
  lab_order: (id) => `/laboratory/orders/${id}`,
  imaging_order: (id) => `/radiology/orders/${id}`,
  employee: (id) => `/employees/${id}`,
  leave_request: () => `/leave`,
  purchase_request: () => `/purchasing`,
  accounting_exception: () => `/accounting?tab=exceptions`,
  // Legacy value — every notifyDeadLetter row written before this batch
  // used this referenceType; kept resolvable so pre-existing his_dev rows
  // aren't left with a dead link.
  outbox_event: () => `/admin/system-events`,
}

export function isSafeInternalPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.includes("://")
}

export function resolveNotificationDestination(n: { referenceType: string | null; referenceId: string | null }): string | null {
  if (!n.referenceType || !n.referenceId) return null
  const builder = DESTINATION_BUILDERS[n.referenceType]
  if (!builder) return null
  const path = builder(n.referenceId)
  return isSafeInternalPath(path) ? path : null
}

// ---------------------------------------------------------------------------
// Idempotent creation primitives live in ./create.ts (a dependency-free leaf
// module — see that file's own doc comment for why: platform/outbox.ts and
// platform/event-handlers.ts import from there directly, never from this
// file, to avoid a circular import through this file's own dependency on
// domains/accounting/exceptions.ts, which imports FROM platform/outbox.ts).
// Re-exported here so every other caller (hr/leave.ts,
// procurement/purchase-requests.ts, this file's own operational-awareness
// helpers) can import everything notification-related from one place.
// ---------------------------------------------------------------------------

export { createNotificationOnce, createNotificationsOnce, type NotificationCreateInput } from "@/lib/domains/notifications/create"

/**
 * Best-effort wrapper for producers that create a notification as a side
 * effect of a synchronous, in-request action (leave/purchase-request
 * submission and decision — not outbox-triggered) — a notification failure
 * must never fail the real workflow action it's attached to. Outbox-
 * triggered producers don't need this: the outbox's own retry already
 * covers a failure inside the handler.
 */
export async function notifyBestEffort(fn: () => Promise<void>, context: { event: string; organizationId: string }): Promise<void> {
  try {
    await fn()
  } catch (error) {
    log({ level: "warn", event: context.event, domain: "notifications", operation: "notifyBestEffort", organizationId: context.organizationId, error })
  }
}

// ---------------------------------------------------------------------------
// Branch-aware recipient resolution (§15/§16/§31) — the same "org-wide role
// is Super Admin only, everyone else is exactly their user_branch_access
// rows" convention branch-scope.ts already established for reads, applied
// here to notification fan-out so a branch-scoped approver never receives a
// notification for a branch they can't act on.
// ---------------------------------------------------------------------------

const ORG_WIDE_ROLE = "Super Admin"

export async function resolveBranchPermissionRecipientIds(organizationId: string, permissionCode: string, branchId: string): Promise<string[]> {
  const users = await db.user.findMany({
    where: {
      organizationId,
      status: "active",
      roles: { some: { role: { permissions: { some: { permission: { code: permissionCode } } } } } },
      OR: [{ roles: { some: { role: { name: ORG_WIDE_ROLE } } } }, { branchAccess: { some: { branchId } } }],
    },
    select: { id: true },
  })
  return users.map((u) => u.id)
}

// ---------------------------------------------------------------------------
// Read side (new this batch — P2's "Notifications have no read-side UI").
// Every function here is scoped to `session.user.id` as the recipient —
// never a client-supplied user id — and to `session.user.organizationId`.
// ---------------------------------------------------------------------------

export async function listNotifications(
  session: SessionContext,
  filters: { status?: "unread" | "read"; type?: string; page?: number } = {}
) {
  const page = resolvePage(filters.page)
  const where: Prisma.NotificationWhereInput = {
    organizationId: session.user.organizationId,
    recipientUserId: session.user.id,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.type ? { type: filters.type } : {}),
  }

  const [rows, total] = await Promise.all([
    db.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      ...paginationSkipTake(page, NOTIFICATION_PAGE_SIZE),
    }),
    db.notification.count({ where }),
  ])

  const notifications = rows.map((n) => ({
    ...n,
    typeLabel: notificationTypeLabel(n.type),
    destination: resolveNotificationDestination(n),
  }))

  return { notifications, total, page, pageSize: NOTIFICATION_PAGE_SIZE, totalPages: totalPages(total, NOTIFICATION_PAGE_SIZE) }
}

/** §9/§49: one indexed count query — matches `@@index([recipientUserId, status])` exactly. Never fetches the list to count it. */
export async function getUnreadCount(session: SessionContext): Promise<number> {
  return db.notification.count({
    where: { organizationId: session.user.organizationId, recipientUserId: session.user.id, status: "unread" },
  })
}

/** Distinct types the caller actually has notifications of — backs the lightweight category filter (§38), never a hardcoded taxonomy. */
export async function getNotificationTypesForUser(session: SessionContext): Promise<string[]> {
  const rows = await db.notification.findMany({
    where: { organizationId: session.user.organizationId, recipientUserId: session.user.id },
    select: { type: true },
    distinct: ["type"],
  })
  return rows.map((r) => r.type).sort()
}

/**
 * §11: ownership enforced by scoping the fetch itself to
 * (id, organizationId, recipientUserId) — never trusts a client-supplied id
 * alone. A wrong-owner or wrong-org id throws exactly like any other
 * `findFirstOrThrow` in this codebase (no distinction between "doesn't
 * exist" and "exists but isn't yours" — same reasoning as
 * assertBranchAccess). §42: marking an already-`read` row read again is a
 * harmless no-op, not an error — repeated calls converge to the same state.
 */
export async function markNotificationRead(session: SessionContext, id: string): Promise<void> {
  const notification = await db.notification.findFirstOrThrow({
    where: { id, organizationId: session.user.organizationId, recipientUserId: session.user.id },
  })
  if (notification.status === "unread") {
    await db.notification.update({ where: { id: notification.id }, data: { status: "read" } })
  }
}

/** §36: a single bulk update, never one query per row. Scoped to the caller's own notifications only. */
export async function markAllNotificationsRead(session: SessionContext): Promise<{ count: number }> {
  const result = await db.notification.updateMany({
    where: { organizationId: session.user.organizationId, recipientUserId: session.user.id, status: "unread" },
    data: { status: "read" },
  })
  return { count: result.count }
}

// ---------------------------------------------------------------------------
// §53: operational awareness links — counts/links into EXISTING
// source-of-truth modules, never a copy of their records into Notification.
// Each entry only appears if the caller actually holds the permission that
// module already requires.
// ---------------------------------------------------------------------------

export async function getOperationalAwarenessLinks(session: SessionContext): Promise<{ label: string; count: number; href: string }[]> {
  const links: { label: string; count: number; href: string }[] = []
  const scope = getAuthorizedBranchScope(session)

  if (can(session, "leave.approve")) {
    const count = await db.leaveRequest.count({
      where: {
        organizationId: session.user.organizationId,
        status: "requested",
        ...(scope.isOrgWide ? {} : { employee: { branchId: { in: scope.branchIds } } }),
      },
    })
    links.push({ label: "Pending leave approvals", count, href: "/leave" })
  }

  if (can(session, "accounting.view")) {
    const { needsAttention } = await listAccountingExceptions(session, {})
    links.push({ label: "Accounting exceptions", count: needsAttention, href: "/accounting?tab=exceptions" })
  }

  if (can(session, "inventory.view")) {
    const lowStock = await listLowStock(session)
    links.push({ label: "Low stock products", count: lowStock.length, href: "/inventory" })
  }

  if (can(session, "purchase_request.approve")) {
    const count = await db.purchaseRequest.count({
      where: {
        organizationId: session.user.organizationId,
        status: "submitted",
        branchId: scope.isOrgWide ? undefined : { in: scope.branchIds },
      },
    })
    links.push({ label: "Pending purchase request approvals", count, href: "/purchasing" })
  }

  return links
}
