import "server-only"
import { db } from "@/lib/db"
import type { Prisma } from "@/generated/prisma/client"
import type { SessionContext } from "@/lib/auth/session"

export type AuditRequestMeta = {
  ip?: string | null
  userAgent?: string | null
}

type WriteAuditLogInput = {
  organizationId: string
  userId: string | null
  action: string
  entityType: string
  entityId: string
  oldValues?: Record<string, unknown> | null
  newValues?: Record<string, unknown> | null
  meta?: AuditRequestMeta
}

/**
 * The only writer of audit_log (spec.md §62). Called from the data-access layer of
 * every domain service that mutates an audited entity — never scattered ad hoc, so
 * it can't be forgotten on a new code path. Insert-only by convention here; DB-level
 * privilege enforcement (no UPDATE/DELETE grant for the app role) lands in Phase 14.
 */
export async function writeAuditLog(input: WriteAuditLogInput): Promise<void> {
  await db.auditLog.create({
    data: {
      organizationId: input.organizationId,
      userId: input.userId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      oldValues: (input.oldValues ?? undefined) as Prisma.InputJsonValue | undefined,
      newValues: (input.newValues ?? undefined) as Prisma.InputJsonValue | undefined,
      ip: input.meta?.ip ?? null,
      userAgent: input.meta?.userAgent ?? null,
    },
  })
}

/** Convenience wrapper that pulls organization/user off an authenticated session. */
export function auditFromSession(
  session: SessionContext,
  action: string,
  entityType: string,
  entityId: string,
  values: { old?: Record<string, unknown> | null; new?: Record<string, unknown> | null } = {},
  meta?: AuditRequestMeta
) {
  return writeAuditLog({
    organizationId: session.user.organizationId,
    userId: session.user.id,
    action,
    entityType,
    entityId,
    oldValues: values.old ?? null,
    newValues: values.new ?? null,
    meta,
  })
}
