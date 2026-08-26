import "server-only"
import type { SessionContext } from "@/lib/auth/session"

const SUPER_ADMIN_ROLE = "Super Admin"

export type CanOptions = {
  /** If set, the session's active/assigned branches must include this branch. */
  branchId?: string | null
  /** If set, the session's user must equal this id (self-service permissions, e.g. viewing own payslip). */
  resourceOwnerId?: string
}

/**
 * The single authorization chokepoint. Every route handler, server action, and
 * permission-aware query projection calls this — no permission decision is made
 * anywhere else. Super Admin bypasses the permission-code check but is still
 * subject to branch scoping, and every check funnels through here so it stays
 * auditable in one place (see SECURITY.md §2).
 */
export function can(session: SessionContext | null, permission: string, options: CanOptions = {}): boolean {
  if (!session) return false

  const isSuperAdmin = session.roleNames.includes(SUPER_ADMIN_ROLE)

  if (!isSuperAdmin && !session.permissions.has(permission)) {
    return false
  }

  if (options.branchId && !session.branchIds.includes(options.branchId) && !isSuperAdmin) {
    return false
  }

  if (options.resourceOwnerId && options.resourceOwnerId !== session.user.id && !isSuperAdmin) {
    return false
  }

  return true
}

/** Throws-variant for use at the top of service functions where failure should abort the operation. */
export class ForbiddenError extends Error {
  constructor(permission: string) {
    super(`Missing permission: ${permission}`)
    this.name = "ForbiddenError"
  }
}

export function assertCan(session: SessionContext | null, permission: string, options: CanOptions = {}): void {
  if (!can(session, permission, options)) {
    throw new ForbiddenError(permission)
  }
}
