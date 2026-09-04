import "server-only"
import type { SessionContext } from "@/lib/auth/session"
import { ForbiddenError } from "@/lib/platform/permissions-core"
import { log } from "@/lib/platform/logger"

const SUPER_ADMIN_ROLE = "Super Admin"

export type BranchScope = {
  organizationId: string
  /** True only for Super Admin — the system's one existing org-wide bypass (mirrors `can()`). */
  isOrgWide: boolean
  /** The caller's own `user_branch_access` rows. Ignored when `isOrgWide` is true. */
  branchIds: string[]
}

/**
 * P0-01: the single place that decides which branches a session may read data
 * from. Every branch-scoped list/get function in the domain layer should
 * derive its `WHERE branchId IN (...)` (or its post-fetch branch check) from
 * this, rather than trusting a `branchId` value supplied by a query string,
 * route param, form, or client component — none of those are proof of
 * access. Super Admin is the only role treated as org-wide; every other
 * role's actual reach is exactly its `user_branch_access` rows, matching how
 * `can()`'s existing `options.branchId` check already treats branch scoping
 * on write paths (see permissions-core.ts) — this extends the same model to
 * reads instead of introducing a second one.
 */
export function getAuthorizedBranchScope(session: SessionContext): BranchScope {
  const isOrgWide = session.roleNames.includes(SUPER_ADMIN_ROLE)
  return {
    organizationId: session.user.organizationId,
    isOrgWide,
    branchIds: session.branchIds,
  }
}

/**
 * Narrows an optional caller-supplied branch filter (e.g. a Reports page's
 * branch dropdown) against the session's real access. Returns `undefined`
 * (no filter — see everything the session is authorized for) if the caller
 * didn't ask for a specific branch. Throws if the caller asked for a branch
 * they don't have access to, rather than silently ignoring the request.
 */
export function narrowBranchFilter(scope: BranchScope, requestedBranchId?: string | null): string | { in: string[] } | undefined {
  if (requestedBranchId) {
    if (!scope.isOrgWide && !scope.branchIds.includes(requestedBranchId)) {
      throw new ForbiddenError("branch.access")
    }
    return requestedBranchId
  }
  if (scope.isOrgWide) return undefined
  return { in: scope.branchIds }
}

/**
 * Throws if `branchId` (the branch a specific already-fetched record actually
 * belongs to) isn't within the session's authorized scope. Use this after a
 * get-by-id query — for models that don't carry `branchId` directly, resolve
 * it from the owning parent (Encounter, Invoice, Payment, ...) first; do not
 * add a redundant `branchId` column merely to make this check simpler
 * (P0.md §5 — authorization may traverse trusted relationships).
 *
 * Throwing ForbiddenError here is intentional, not merely defensive: callers
 * should let it propagate as a generic failure (matching how `findFirstOrThrow`
 * scoped to `organizationId` already behaves for a wrong-org id) rather than
 * distinguish "forbidden" from "not found" in the response — never confirm to
 * an unauthorized caller that a record exists in a branch they can't see.
 */
export function assertBranchAccess(scope: BranchScope, branchId: string | null | undefined): void {
  if (scope.isOrgWide) return
  if (!branchId || !scope.branchIds.includes(branchId)) {
    // P2 §16: "authorization anomalies" — deliberately not logged at every
    // `can()`/`assertCan()` permission denial (those are routine — a nav
    // item hidden from a role, a button correctly disabled — and logging
    // every one would be exactly the "noisy logging for every ordinary
    // operation" P2.md §16 warns against). This one is narrower and more
    // meaningful: a session that already passed a permission check is
    // reaching for one *specific, already-identified* record outside its
    // own branch scope — either a UI bug linking somewhere it shouldn't, or
    // someone probing a resource id directly. Worth a log line either way.
    log({
      level: "warn", event: "auth.branch_access_denied", domain: "auth", operation: "assertBranchAccess",
      organizationId: scope.organizationId, branchId: branchId ?? undefined,
    })
    throw new ForbiddenError("branch.access")
  }
}

/**
 * Patients aren't single-branch records the way an Invoice or Appointment is —
 * a patient registered at Branch A may legitimately be treated at Branch B
 * (spec.md's multi-branch design), and most clinical child records (Diagnosis,
 * ClinicalNote, Prescription, Episode, FollowUpRecommendation) don't carry
 * their own `branchId` at all, only inheriting scope from the patient they
 * belong to. "Visible to this scope" therefore means: registered at an
 * authorized branch, OR has an appointment at one — not a redundant new
 * branchId column on every clinical child table, per P0.md §5's "authorization
 * may traverse trusted relationships." Used as a Prisma `where` fragment on
 * `Patient` directly, or nested under `patient: { ... }` for a model one hop
 * away. Returns `null` for org-wide sessions (no filter needed).
 */
export function patientVisibilityWhere(scope: BranchScope): { OR: [{ registrationBranchId: { in: string[] } }, { appointments: { some: { branchId: { in: string[] } } } }] } | null {
  if (scope.isOrgWide) return null
  return {
    OR: [
      { registrationBranchId: { in: scope.branchIds } },
      { appointments: { some: { branchId: { in: scope.branchIds } } } },
    ],
  }
}
