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
 * it can't be forgotten on a new code path. Insert-only by application convention
 * (no update/delete function exists in this module — see
 * test/integration/audit-log-immutability.test.ts, which asserts that directly).
 *
 * DB-level privilege enforcement (P0-06, SECURITY.md) is real but not yet live for
 * this connection: the role this app has connected as since Phase 1 is the OWNER of
 * this table, and a table owner's privileges can't be revoked from itself in
 * PostgreSQL — only a genuinely separate, non-owner role's privileges can be. That
 * role (`avant_app_runtime`) now exists with UPDATE/DELETE revoked on this table
 * (prisma/db-setup/p0-06-create-runtime-role.sql, empirically verified), but cutting
 * this app's live DATABASE_URL over to it is a deliberate deployment step this
 * remediation pass documents rather than performs unilaterally — see
 * P0_REMEDIATION_REPORT.md.
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
