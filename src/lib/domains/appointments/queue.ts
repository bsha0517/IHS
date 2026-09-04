import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { getProviderForUser } from "@/lib/domains/providers/service"
import type { SessionContext } from "@/lib/auth/session"

function todayRange() {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
  return { start, end }
}

/**
 * Reception queue: everyone checked in today at a branch, waiting or in
 * progress. Also the nurse/pre-consultation view (P3.4 §5) — reused as-is
 * rather than a second queue, since Receptionist and Nurse already share
 * `appointment.checkin`. The include below was extended for that reuse:
 * `service` (§5's own field list), and a "vitals recorded" / alert signal
 * derived entirely inside this one query (§35 — a nested include, not an
 * extra query per row) rather than a per-patient follow-up fetch.
 */
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
    include: {
      patient: {
        include: {
          allergies: { where: { isAlert: true }, select: { id: true }, take: 1 },
          conditions: { where: { isAlert: true }, select: { id: true }, take: 1 },
        },
      },
      provider: true,
      service: true,
      queueEntry: true,
      encounter: {
        select: {
          id: true,
          status: true,
          vitalSigns: { select: { id: true, recordedAt: true }, orderBy: { recordedAt: "desc" }, take: 1 },
        },
      },
    },
    orderBy: { queueEntry: { checkedInAt: "asc" } },
  })
}

/** Doctor queue: the signed-in user's own patients waiting/in consultation today. */
export async function listMyQueue(session: SessionContext) {
  const provider = await getProviderForUser(session.user.id)
  if (!provider) return []

  const { start, end } = todayRange()
  return db.appointment.findMany({
    where: {
      organizationId: session.user.organizationId,
      providerId: provider.id,
      status: { in: ["waiting", "in_consultation"] },
      queueEntry: { checkedInAt: { gte: start, lt: end } },
    },
    include: {
      patient: true,
      queueEntry: true,
      // P3.3 §6: "service" is one of the fields the provider queue should
      // show — the include was missing it entirely, so My Queue could
      // never have rendered it even though the field already existed
      // everywhere else appointments are listed.
      service: true,
      // P3.4 §18/§19: narrowed from `encounter: true` to just what's
      // needed — the encounter id (for "Open encounter") plus the latest
      // vital sign's timestamp, so the doctor can see "Vitals recorded"
      // and when, without opening the encounter, and without an extra
      // query per row (a nested select inside this same query).
      encounter: {
        select: { id: true, vitalSigns: { select: { recordedAt: true }, orderBy: { recordedAt: "desc" }, take: 1 } },
      },
    },
    orderBy: { queueEntry: { checkedInAt: "asc" } },
  })
}
