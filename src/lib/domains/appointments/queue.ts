import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import type { SessionContext } from "@/lib/auth/session"

function todayRange() {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
  return { start, end }
}

/** Reception queue: everyone checked in today at a branch, waiting or in progress. */
export async function listBranchQueue(session: SessionContext, branchId: string) {
  assertCan(session, "appointment.checkin", { branchId })
  const { start, end } = todayRange()

  return db.appointment.findMany({
    where: {
      organizationId: session.user.organizationId,
      branchId,
      status: { in: ["waiting", "in_consultation"] },
      queueEntry: { checkedInAt: { gte: start, lt: end } },
    },
    include: { patient: true, provider: true, queueEntry: true },
    orderBy: { queueEntry: { checkedInAt: "asc" } },
  })
}

/** Doctor queue: the signed-in user's own patients waiting/in consultation today. */
export async function listMyQueue(session: SessionContext) {
  const provider = await db.provider.findUnique({ where: { userId: session.user.id } })
  if (!provider) return []

  const { start, end } = todayRange()
  return db.appointment.findMany({
    where: {
      organizationId: session.user.organizationId,
      providerId: provider.id,
      status: { in: ["waiting", "in_consultation"] },
      queueEntry: { checkedInAt: { gte: start, lt: end } },
    },
    include: { patient: true, queueEntry: true, encounter: true },
    orderBy: { queueEntry: { checkedInAt: "asc" } },
  })
}
