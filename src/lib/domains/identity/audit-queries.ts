import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import type { SessionContext } from "@/lib/auth/session"

const PAGE_SIZE = 50

export async function listAuditLog(session: SessionContext, page = 1) {
  assertCan(session, "audit.review")

  const [entries, total] = await Promise.all([
    db.auditLog.findMany({
      where: { organizationId: session.user.organizationId },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    db.auditLog.count({ where: { organizationId: session.user.organizationId } }),
  ])

  const userIds = Array.from(new Set(entries.map((e) => e.userId).filter((id): id is string => Boolean(id))))
  const users = userIds.length > 0 ? await db.user.findMany({ where: { id: { in: userIds } } }) : []
  const userById = new Map(users.map((u) => [u.id, u]))

  return {
    entries: entries.map((entry) => ({ ...entry, user: entry.userId ? userById.get(entry.userId) ?? null : null })),
    total,
    page,
    pageSize: PAGE_SIZE,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  }
}
