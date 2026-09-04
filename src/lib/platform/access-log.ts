import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import type { Prisma } from "@/generated/prisma/client"
import type { SessionContext } from "@/lib/auth/session"

/**
 * The read-audit counterpart to audit.ts (spec.md §63) — distinct from audit_log,
 * distinct permission gate (audit.review), insert-only. No clinical screens exist
 * yet (Phase 2+), but the write path is established from Phase 1 so every future
 * chart/encounter/result view goes through this from day one rather than being
 * retrofitted later. patient_id has no FK until the `patient` table lands in
 * Phase 2 (see prisma/schema.prisma comment on ClinicalAccessLog).
 */
export async function writeClinicalAccessLog(input: {
  session: SessionContext
  patientId: string
  resourceType: string
  resourceId?: string | null
  action: "view" | "print" | "export"
}): Promise<void> {
  await db.clinicalAccessLog.create({
    data: {
      organizationId: input.session.user.organizationId,
      userId: input.session.user.id,
      patientId: input.patientId,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      action: input.action,
    },
  })
}

const PAGE_SIZE = 50

/**
 * P2 §7: the admin/security read side finally built to match the write
 * side above — see P2_FINDINGS.md §7 ("the write side is real; the
 * read/admin side ... is what's still missing"). Gated on `audit.review`,
 * the same permission the mutation audit log viewer (`/admin/audit`) uses
 * — its own seed description already read "View audit log and clinical
 * access log" before this function existed, so this isn't a new RBAC
 * concept, just the second half of what that permission was always meant
 * to cover.
 *
 * `ClinicalAccessLog` has no `branchId` column of its own (see its schema
 * comment) — a genuine gap this function can't paper over. `branchId`
 * here filters via the accessed patient's `registrationBranchId` instead:
 * a real, honest approximation ("this patient's home branch"), not "the
 * branch the accessing user was physically at," which nothing in this
 * schema records. Documented rather than silently assumed exact.
 *
 * `encounterId` similarly only matches entries where `resourceType` is
 * literally `"encounter"` — the one resource type whose `resourceId` is an
 * encounter id (see `getEncounter`, clinical/encounters.ts). Other
 * resource types (diagnoses, prescriptions, vitals, ...) aren't scoped to
 * one encounter in this log, matching P2.md §7's own "encounter if
 * available" hedge rather than overclaiming a join this data can't
 * support.
 *
 * Org-wide, not branch-scoped to the viewer's own assignment — same as
 * `listAuditLog`'s existing convention for this class of admin/security
 * page (a compliance/security reviewer needs org-wide visibility, not
 * their own operational branch scope).
 */
export async function listClinicalAccessLog(
  session: SessionContext,
  filters: {
    page?: number
    dateFrom?: Date
    dateTo?: Date
    userId?: string
    patientId?: string
    encounterId?: string
    action?: string
    branchId?: string
  } = {}
) {
  assertCan(session, "audit.review")
  const page = Math.max(1, filters.page ?? 1)

  const where: Prisma.ClinicalAccessLogWhereInput = {
    organizationId: session.user.organizationId,
    userId: filters.userId,
    patientId: filters.patientId,
    action: filters.action,
    createdAt: { gte: filters.dateFrom, lte: filters.dateTo },
    ...(filters.encounterId ? { resourceType: "encounter", resourceId: filters.encounterId } : {}),
    ...(filters.branchId ? { patient: { registrationBranchId: filters.branchId } } : {}),
  }

  const [entries, total] = await Promise.all([
    db.clinicalAccessLog.findMany({
      where,
      include: { patient: true },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    db.clinicalAccessLog.count({ where }),
  ])

  // Batched user-name resolution — one query for every distinct accessor on
  // this page, not one per row (same discipline as listAuditLog).
  const userIds = Array.from(new Set(entries.map((e) => e.userId)))
  const users = userIds.length > 0 ? await db.user.findMany({ where: { id: { in: userIds } } }) : []
  const userById = new Map(users.map((u) => [u.id, u]))

  return {
    entries: entries.map((entry) => ({ ...entry, user: userById.get(entry.userId) ?? null })),
    total,
    page,
    pageSize: PAGE_SIZE,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  }
}

/**
 * Minimal user list for the viewer's "User" filter dropdown — deliberately
 * NOT `identity/users.ts`'s `listUsers`, which requires `users.manage` (a
 * separate, unrelated permission a security/audit reviewer holding only
 * `audit.review` may not have — this page must not depend on it).
 */
export async function listUsersForAccessLogFilter(session: SessionContext) {
  assertCan(session, "audit.review")
  return db.user.findMany({
    where: { organizationId: session.user.organizationId },
    select: { id: true, firstName: true, lastName: true },
    orderBy: { firstName: "asc" },
  })
}
