import "server-only"
import { db } from "@/lib/db"
import { Prisma } from "@/generated/prisma/client"
import { requirePlatformOperator } from "@/lib/platform/operator-guard"
import { writeAuditLog } from "@/lib/platform/audit"
import { revokeAllUserSessions } from "@/lib/auth/session"
import { getModuleEntitlements, setModuleEntitlement, seedModuleEntitlementsFromPlan, type ModuleKey } from "@/lib/platform/entitlements"
import { getOnboardingChecklistSummary } from "@/lib/domains/commercial/onboarding-checklist"
import { ensureCommunicationTemplates } from "@/lib/domains/communications/templates"
import { getFinancialReadinessGaps } from "@/lib/domains/accounting/posting-service"
import type {
  UpdateCommercialProfileInput,
  UpdateSubscriptionInput,
} from "@/lib/domains/commercial/schemas"
import type { $Enums } from "@/generated/prisma/client"

// ---------------------------------------------------------------------------
// Platform organization list (§20/§22/§46/§74/§86) — operational metadata
// only, NEVER patient/clinical content. Branch/user counts are computed via
// two batched `groupBy` queries for the whole page, not one query per
// organization (§74's own N+1 caution).
// ---------------------------------------------------------------------------

export async function listOrganizationsForPlatform(
  input: {
    page?: number
    pageSize?: number
    search?: string
    country?: string
    subscriptionStatus?: $Enums.SubscriptionStatus
    onboardingStatus?: $Enums.CommercialOnboardingStatus
    commercialLifecycle?: $Enums.CommercialLifecycle
  } = {}
) {
  await requirePlatformOperator()
  const page = Math.max(1, input.page ?? 1)
  const pageSize = Math.min(100, Math.max(1, input.pageSize ?? 25))
  const search = input.search?.trim()

  const filters: Prisma.OrganizationWhereInput[] = []
  if (search) {
    filters.push({
      OR: [
        { displayName: { contains: search, mode: "insensitive" } },
        { legalName: { contains: search, mode: "insensitive" } },
        { commercialProfile: { customerCode: { contains: search, mode: "insensitive" } } },
        { commercialProfile: { primaryContactName: { contains: search, mode: "insensitive" } } },
        { commercialProfile: { primaryContactEmail: { contains: search, mode: "insensitive" } } },
      ],
    })
  }
  if (input.country) filters.push({ commercialProfile: { country: input.country.toUpperCase() } })
  if (input.onboardingStatus) filters.push({ commercialProfile: { onboardingStatus: input.onboardingStatus } })
  if (input.commercialLifecycle) filters.push({ commercialProfile: { commercialLifecycle: input.commercialLifecycle } })
  if (input.subscriptionStatus) {
    filters.push({ commercialProfile: { subscriptions: { some: { status: input.subscriptionStatus } } } })
  }
  const where: Prisma.OrganizationWhereInput = filters.length > 0 ? { AND: filters } : {}

  const [organizations, total] = await Promise.all([
    db.organization.findMany({
      where,
      include: {
        commercialProfile: {
          include: { subscriptions: { orderBy: { createdAt: "desc" }, take: 1, include: { plan: true } } },
        },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.organization.count({ where }),
  ])

  const orgIds = organizations.map((o) => o.id)
  const [branchCounts, userCounts] = orgIds.length
    ? await Promise.all([
        db.branch.groupBy({ by: ["organizationId"], where: { organizationId: { in: orgIds }, status: "active" }, _count: { _all: true } }),
        db.user.groupBy({ by: ["organizationId"], where: { organizationId: { in: orgIds }, status: "active" }, _count: { _all: true } }),
      ])
    : [[], []]
  const branchCountByOrg = new Map(branchCounts.map((b) => [b.organizationId, b._count._all]))
  const userCountByOrg = new Map(userCounts.map((u) => [u.organizationId, u._count._all]))

  return {
    organizations: organizations.map((o) => ({
      id: o.id,
      displayName: o.displayName,
      status: o.status,
      createdAt: o.createdAt,
      customerCode: o.commercialProfile?.customerCode ?? null,
      country: o.commercialProfile?.country ?? null,
      commercialLifecycle: o.commercialProfile?.commercialLifecycle ?? null,
      onboardingStatus: o.commercialProfile?.onboardingStatus ?? null,
      currentSubscription: o.commercialProfile?.subscriptions[0] ?? null,
      activeBranchCount: branchCountByOrg.get(o.id) ?? 0,
      activeUserCount: userCountByOrg.get(o.id) ?? 0,
    })),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  }
}

/** P5.6 Part 2: distinct countries for the organizations list's filter dropdown — no new table, just the existing commercial-profile field grouped. */
export async function listOrganizationCountries(): Promise<string[]> {
  await requirePlatformOperator()
  const rows = await db.organizationCommercialProfile.findMany({
    where: { country: { not: "" } },
    select: { country: true },
    distinct: ["country"],
    orderBy: { country: "asc" },
  })
  return rows.map((r) => r.country)
}

/**
 * P5.1 §45: kept deliberately minimal — no revenue/MRR analytics (§45's own
 * explicit "do not create... unless commercial billing data genuinely
 * supports it," and it doesn't: V1 billing is manual, §12). "Readiness
 * attention" is a cheap proxy (commercial onboarding status still
 * not_started/in_progress) rather than a real per-org readiness.ts
 * computation across every tenant — that function needs a clinic
 * `SessionContext` and is expensive to run N times; documented here rather
 * than silently approximated without comment.
 */
export async function getPlatformDashboardMetrics() {
  await requirePlatformOperator()
  const soon = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)

  const [totalOrganizations, activeClinics, onboarding, suspended, trialsExpiring, readinessAttention, openTickets, unassignedTickets] = await Promise.all([
    db.organization.count(),
    db.organization.count({ where: { status: "active", commercialProfile: { commercialLifecycle: "live" } } }),
    db.organization.count({ where: { commercialProfile: { commercialLifecycle: "onboarding" } } }),
    db.organization.count({ where: { status: "suspended" } }),
    db.organizationSubscription.count({
      where: { status: "trial", trialEndsAt: { not: null, lte: soon } },
    }),
    db.organization.count({ where: { commercialProfile: { onboardingStatus: { in: ["not_started", "in_progress"] } } } }),
    // P5.2 §5: operational/commercial metadata only, same as every other
    // metric here — a ticket count, never ticket CONTENT.
    db.supportTicket.count({ where: { status: { in: ["open", "in_progress", "waiting_on_customer"] } } }),
    db.supportTicket.count({ where: { status: { in: ["open", "in_progress"] }, assignedOperatorId: null } }),
  ])

  return { totalOrganizations, activeClinics, onboarding, suspended, trialsExpiring, readinessAttention, openTickets, unassignedTickets }
}

/**
 * P5.2 §5: cross-organization activity feed for the platform dashboard —
 * operational/commercial audit rows only (`platform.*` actions, the exact
 * same filter `getOrganizationCommercialDetail`'s own per-org audit table
 * already uses), joined with each row's organization name. Never touches a
 * clinical table.
 */
export async function getPlatformRecentActivity(limit = 15) {
  await requirePlatformOperator()
  return db.auditLog.findMany({
    where: { action: { startsWith: "platform." } },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { organization: { select: { id: true, displayName: true } } },
  })
}

// ---------------------------------------------------------------------------
// Organization detail (§47) — no PHI; links to the clinic's own /admin for
// anything genuinely clinic-internal rather than duplicating it here (§47's
// own "do not duplicate full clinic Admin functionality").
// ---------------------------------------------------------------------------

export async function getOrganizationCommercialDetail(organizationId: string) {
  await requirePlatformOperator()

  const organization = await db.organization.findUniqueOrThrow({
    where: { id: organizationId },
    include: {
      commercialProfile: {
        include: {
          subscriptions: { orderBy: { createdAt: "desc" }, include: { plan: true } },
          goLiveConditions: true,
        },
      },
      branches: { orderBy: { name: "asc" } },
    },
  })

  const admins = await db.user.findMany({
    where: { organizationId, roles: { some: { role: { permissions: { some: { permission: { code: "users.manage" } } } } } } },
    select: { id: true, email: true, firstName: true, lastName: true, status: true, lastLoginAt: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  })

  // ensureCommunicationTemplates's read here (no actorOperatorId — self-heal
  // only, same convention as getOnboardingChecklistSummary's own internal
  // ensureOnboardingChecklist call) backfills any organization provisioned
  // before P5.4 (including P5.3's own pilot org) the same way visiting this
  // page already backfills a stale onboarding checklist.
  const [activeBranchCount, activeUserCount, entitlements, recentAudit, usage, checklistSummary, goLiveBlockers, openTicketCount] = await Promise.all([
    db.branch.count({ where: { organizationId, status: "active" } }),
    db.user.count({ where: { organizationId, status: "active" } }),
    getModuleEntitlements(organizationId),
    db.auditLog.findMany({
      where: { organizationId, action: { startsWith: "platform." } },
      orderBy: { createdAt: "desc" },
      take: 25,
    }),
    getOrganizationUsage(organizationId),
    getOnboardingChecklistSummary(organizationId),
    getGoLiveBlockers(organizationId),
    db.supportTicket.count({ where: { organizationId, status: { in: ["open", "in_progress", "waiting_on_customer"] } } }),
    ensureCommunicationTemplates(organizationId),
  ])

  // "Who verified this" display resolution — a small, bounded lookup (at
  // most a handful of distinct operator ids per organization), never a full
  // PlatformOperator table scan.
  const operatorIds = Array.from(
    new Set(
      [
        ...organization.commercialProfile?.goLiveConditions.map((c) => c.completedByOperatorId) ?? [],
        organization.commercialProfile?.goLiveApprovedByOperatorId,
      ].filter((id): id is string => Boolean(id))
    )
  )
  const operators = operatorIds.length ? await db.platformOperator.findMany({ where: { id: { in: operatorIds } }, select: { id: true, email: true } }) : []
  const operatorEmails = Object.fromEntries(operators.map((o) => [o.id, o.email]))

  return { organization, admins, activeBranchCount, activeUserCount, entitlements, recentAudit, usage, checklistSummary, goLiveBlockers, openTicketCount, operatorEmails }
}

// ---------------------------------------------------------------------------
// Lifecycle — reuses the existing, proven OrgStatus enforcement (§7); never
// a second suspension mechanism. Sessions are revoked immediately on
// suspend so an already-issued session cannot keep working until its own
// natural expiry (mirrors P4.3's own "re-checked on every request" design —
// this makes the transition immediate rather than relying solely on that
// per-request check, belt-and-braces on a high-impact action).
// ---------------------------------------------------------------------------

export async function suspendOrganization(organizationId: string, reason: string | null) {
  const operator = await requirePlatformOperator()
  const before = await db.organization.findUniqueOrThrow({ where: { id: organizationId } })
  const updated = await db.organization.update({ where: { id: organizationId }, data: { status: "suspended" } })

  const orgUsers = await db.user.findMany({ where: { organizationId }, select: { id: true } })
  await Promise.all(orgUsers.map((u) => revokeAllUserSessions(u.id)))

  await writeAuditLog({
    organizationId,
    userId: operator.operator.id,
    action: "platform.organization.suspended",
    entityType: "organization",
    entityId: organizationId,
    oldValues: { status: before.status },
    newValues: { status: updated.status, reason },
  })
  return updated
}

export async function reactivateOrganization(organizationId: string) {
  const operator = await requirePlatformOperator()
  const before = await db.organization.findUniqueOrThrow({ where: { id: organizationId } })
  const updated = await db.organization.update({ where: { id: organizationId }, data: { status: "active" } })

  await writeAuditLog({
    organizationId,
    userId: operator.operator.id,
    action: "platform.organization.reactivated",
    entityType: "organization",
    entityId: organizationId,
    oldValues: { status: before.status },
    newValues: { status: updated.status },
  })
  return updated
}

// ---------------------------------------------------------------------------
// Commercial profile / subscription / onboarding / UAT / go-live
// ---------------------------------------------------------------------------

export async function updateCommercialProfile(organizationId: string, input: UpdateCommercialProfileInput) {
  const operator = await requirePlatformOperator()
  const before = await db.organizationCommercialProfile.findUniqueOrThrow({ where: { organizationId } })
  const updated = await db.organizationCommercialProfile.update({
    where: { organizationId },
    data: input,
  })
  await writeAuditLog({
    organizationId,
    userId: operator.operator.id,
    action: "platform.commercial_profile.updated",
    entityType: "organization_commercial_profile",
    entityId: updated.id,
    oldValues: before,
    newValues: updated,
  })
  return updated
}

/**
 * §10/§18/§41: creates a NEW subscription row (history preserved, never
 * mutates a prior one in place) — the "current" subscription is simply the
 * most recent row for this organization. Never touches branches/users/
 * module data regardless of how the new plan's limits compare to the old
 * one (§41 — an over-limit state is surfaced by the limit-check helpers
 * below as "cannot create MORE," never as "delete what already exists").
 */
export async function updateSubscription(organizationId: string, input: UpdateSubscriptionInput) {
  const operator = await requirePlatformOperator()
  const commercialProfile = await db.organizationCommercialProfile.findUniqueOrThrow({ where: { organizationId } })

  const created = await db.organizationSubscription.create({
    data: {
      organizationId,
      commercialProfileId: commercialProfile.id,
      planId: input.planId,
      status: input.status,
      startDate: input.startDate,
      endDate: input.endDate ?? null,
      trialEndsAt: input.trialEndsAt ?? null,
      agreedUserLimit: input.agreedUserLimit ?? null,
      agreedBranchLimit: input.agreedBranchLimit ?? null,
      agreedAmount: input.agreedAmount ?? null,
      currency: input.currency ?? null,
      billingCycle: input.billingCycle ?? null,
      notes: input.notes ?? null,
    },
  })

  await writeAuditLog({
    organizationId,
    userId: operator.operator.id,
    action: "platform.subscription.updated",
    entityType: "organization_subscription",
    entityId: created.id,
    newValues: created,
  })
  return created
}

export async function updateOnboardingStatus(organizationId: string, status: $Enums.CommercialOnboardingStatus) {
  const operator = await requirePlatformOperator()
  const before = await db.organizationCommercialProfile.findUniqueOrThrow({ where: { organizationId } })
  const updated = await db.organizationCommercialProfile.update({ where: { organizationId }, data: { onboardingStatus: status } })
  await writeAuditLog({
    organizationId,
    userId: operator.operator.id,
    action: "platform.onboarding_status.updated",
    entityType: "organization_commercial_profile",
    entityId: updated.id,
    oldValues: { onboardingStatus: before.onboardingStatus },
    newValues: { onboardingStatus: updated.onboardingStatus },
  })
  return updated
}

export async function updateUatStatus(organizationId: string, status: $Enums.UatStatus, note: string | null) {
  const operator = await requirePlatformOperator()
  const before = await db.organizationCommercialProfile.findUniqueOrThrow({ where: { organizationId } })
  const updated = await db.organizationCommercialProfile.update({ where: { organizationId }, data: { uatStatus: status, uatNote: note } })
  await writeAuditLog({
    organizationId,
    userId: operator.operator.id,
    action: "platform.uat_status.updated",
    entityType: "organization_commercial_profile",
    entityId: updated.id,
    oldValues: { uatStatus: before.uatStatus, uatNote: before.uatNote },
    newValues: { uatStatus: updated.uatStatus, uatNote: updated.uatNote },
  })
  return updated
}

/** §33/§34: evidence, never the external system itself — no credentials/tokens/backups/patient data belong in `note`. */
export async function updateGoLiveCondition(
  organizationId: string,
  code: $Enums.GoLiveConditionCode,
  status: $Enums.GoLiveConditionStatus,
  note: string | null
) {
  const operator = await requirePlatformOperator()
  const commercialProfile = await db.organizationCommercialProfile.findUniqueOrThrow({ where: { organizationId } })
  const before = await db.goLiveCondition.findUniqueOrThrow({ where: { commercialProfileId_code: { commercialProfileId: commercialProfile.id, code } } })

  const updated = await db.goLiveCondition.update({
    where: { commercialProfileId_code: { commercialProfileId: commercialProfile.id, code } },
    data: {
      status,
      note,
      completedByOperatorId: status === "complete" ? operator.operator.id : null,
      completedAt: status === "complete" ? new Date() : null,
    },
  })

  await writeAuditLog({
    organizationId,
    userId: operator.operator.id,
    action: "platform.go_live_condition.updated",
    entityType: "go_live_condition",
    entityId: updated.id,
    oldValues: { status: before.status },
    newValues: { status: updated.status, note },
  })
  return updated
}

export async function updateModuleEntitlement(organizationId: string, moduleKey: ModuleKey, enabled: boolean) {
  const operator = await requirePlatformOperator()
  await setModuleEntitlement({ organizationId, moduleKey, enabled, operatorId: operator.operator.id })
}

/** Recovery path if provisioning's own entitlement-seeding step failed after the core transaction committed (see provisioning.ts's own doc comment). */
export async function resetEntitlementsToPlanDefaults(organizationId: string) {
  const operator = await requirePlatformOperator()
  const subscription = await db.organizationSubscription.findFirst({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
    include: { plan: true },
  })
  if (!subscription) throw new Error("This organization has no subscription to derive default entitlements from.")
  await seedModuleEntitlementsFromPlan({ organizationId, defaultModuleKeys: subscription.plan.defaultModuleKeys, operatorId: operator.operator.id })
}

// ---------------------------------------------------------------------------
// Limits (§17/§18/§65) — centralized so every creation path (branch, user
// activation) enforces the same rule the same way. Counts ACTIVE records
// only (§17's own "prefer counting active... rather than historical
// inactive records") and never deletes/deactivates anything to satisfy a
// limit (§41/§42) — these only ever block creating ONE MORE.
// ---------------------------------------------------------------------------

async function getEffectiveLimits(organizationId: string): Promise<{ userLimit: number | null; branchLimit: number | null }> {
  const subscription = await db.organizationSubscription.findFirst({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
    include: { plan: true },
  })
  if (!subscription) return { userLimit: null, branchLimit: null }
  return {
    userLimit: subscription.agreedUserLimit ?? subscription.plan.userLimit ?? null,
    branchLimit: subscription.agreedBranchLimit ?? subscription.plan.branchLimit ?? null,
  }
}

export class SubscriptionLimitError extends Error {}

/** Call BEFORE creating a new active user / activating an inactive one. No-ops (no query at all) for an organization with no commercial subscription — the pre-P5.1 seed/bootstrap tenant is never limited. */
export async function assertWithinUserLimit(organizationId: string): Promise<void> {
  const { userLimit } = await getEffectiveLimits(organizationId)
  if (userLimit === null) return
  const activeCount = await db.user.count({ where: { organizationId, status: "active" } })
  if (activeCount >= userLimit) {
    throw new SubscriptionLimitError(`This organization's subscription allows at most ${userLimit} active user(s). Increase the plan/subscription limit before adding another.`)
  }
}

/** Call BEFORE creating a new branch / reactivating an inactive one. */
export async function assertWithinBranchLimit(organizationId: string): Promise<void> {
  const { branchLimit } = await getEffectiveLimits(organizationId)
  if (branchLimit === null) return
  const activeCount = await db.branch.count({ where: { organizationId, status: "active" } })
  if (activeCount >= branchLimit) {
    throw new SubscriptionLimitError(`This organization's subscription allows at most ${branchLimit} active branch(es). Increase the plan/subscription limit before adding another.`)
  }
}

// ---------------------------------------------------------------------------
// P5.2 §6: centralized commercial usage — one place every "how much of its
// plan is this org using" view (platform dashboard, organization detail,
// onboarding workspace) reads from, instead of scattering its own counts.
// Counts ACTIVE records only, matching P5.1's own limit-enforcement
// convention exactly (assertWithinUserLimit/assertWithinBranchLimit above).
// ---------------------------------------------------------------------------

export type OrganizationUsage = {
  activeUserCount: number
  userLimit: number | null
  activeBranchCount: number
  branchLimit: number | null
  enabledModuleCount: number
  totalModuleCount: number
  subscriptionStatus: $Enums.SubscriptionStatus | null
  planName: string | null
  planCode: string | null
}

export async function getOrganizationUsage(organizationId: string): Promise<OrganizationUsage> {
  const [{ userLimit, branchLimit }, activeUserCount, activeBranchCount, entitlements, subscription] = await Promise.all([
    getEffectiveLimits(organizationId),
    db.user.count({ where: { organizationId, status: "active" } }),
    db.branch.count({ where: { organizationId, status: "active" } }),
    getModuleEntitlements(organizationId),
    db.organizationSubscription.findFirst({ where: { organizationId }, orderBy: { createdAt: "desc" }, include: { plan: true } }),
  ])

  const moduleValues = Object.values(entitlements)
  return {
    activeUserCount,
    userLimit,
    activeBranchCount,
    branchLimit,
    enabledModuleCount: moduleValues.filter(Boolean).length,
    totalModuleCount: moduleValues.length,
    subscriptionStatus: subscription?.status ?? null,
    planName: subscription?.plan.name ?? null,
    planCode: subscription?.plan.code ?? null,
  }
}

// ---------------------------------------------------------------------------
// P5.2 §4: controlled go-live approval — the ONE place `commercialLifecycle`
// and `onboardingStatus` are ever moved to `live` together, and only after
// this function's own server-side validation passes. Never relies on the
// UI hiding an "Approve go-live" button; a direct call with unmet
// conditions is rejected exactly the same way. Idempotent in the sense that
// re-approving an already-live org is rejected (there is exactly one real
// approval event to record), not silently repeated.
// ---------------------------------------------------------------------------

export class GoLiveNotReadyError extends Error {
  constructor(public readonly reasons: string[]) {
    super(`This organization is not ready to go live: ${reasons.join("; ")}`)
    this.name = "GoLiveNotReadyError"
  }
}

/** Every reason (if any) this organization currently CANNOT go live — an empty array means it can. Exported so the UI can render the same reasons the server would reject on, without duplicating the logic. */
export async function getGoLiveBlockers(organizationId: string): Promise<string[]> {
  const organization = await db.organization.findUniqueOrThrow({ where: { id: organizationId } })
  const profile = await db.organizationCommercialProfile.findUnique({
    where: { organizationId },
    include: { goLiveConditions: true, subscriptions: { orderBy: { createdAt: "desc" }, take: 1 } },
  })

  const reasons: string[] = []
  if (organization.status !== "active") reasons.push("Organization is suspended.")
  if (!profile) {
    reasons.push("No commercial profile exists yet.")
    return reasons
  }
  if (profile.commercialLifecycle === "live") reasons.push("Organization is already live.")
  if (profile.commercialLifecycle === "closed") reasons.push("Organization is closed.")

  const subscription = profile.subscriptions[0]
  if (!subscription) reasons.push("No subscription is assigned.")
  else if (!["trial", "active"].includes(subscription.status)) reasons.push(`Subscription status (${subscription.status}) is not trial/active.`)

  const requiredConditions = profile.goLiveConditions.filter((c) => c.status !== "not_applicable")
  const unmet = requiredConditions.filter((c) => c.status !== "complete")
  if (unmet.length > 0) reasons.push(`${unmet.length} go-live condition(s) not yet verified: ${unmet.map((c) => c.code).join(", ")}.`)

  const checklistSummary = await getOnboardingChecklistSummary(organizationId)
  if (!checklistSummary.allRequiredComplete) {
    reasons.push(`${checklistSummary.requiredItems - checklistSummary.requiredComplete} required onboarding checklist item(s) not yet complete.`)
  }

  // P5.4 §4/§10: missing financial configuration must be visible BEFORE
  // go-live, not discovered the first time a real clinic day silently fails
  // to post a journal (the exact P5.3 defect this closes). Authoritative,
  // server-side, and in the same blocker list the UI renders from — never a
  // UI-only check, per this phase's own explicit instruction.
  const financialGaps = await getFinancialReadinessGaps(organizationId)
  if (financialGaps.length > 0) {
    reasons.push(`${financialGaps.length} required account mapping(s) not yet configured: ${financialGaps.map((g) => g.label).join(", ")}.`)
  }

  return reasons
}

/**
 * `operatorId` required, not resolved internally — same testability
 * reasoning as `onboarding-checklist.ts`'s equivalent functions (see that
 * file's own doc comment): `requirePlatformOperator()` depends on Next's
 * request-scoped `cookies()` and cannot run in an integration test. The
 * Server Action caller resolves the real, cookie-verified operator first.
 */
export async function approveGoLive(organizationId: string, operatorId: string, notes: string | null) {
  const blockers = await getGoLiveBlockers(organizationId)
  // Re-check the two conditions above that are about to be resolved by THIS
  // call are excluded from "already live"/"closed" style self-blocking —
  // getGoLiveBlockers already only reports genuine unmet prerequisites.
  if (blockers.length > 0) throw new GoLiveNotReadyError(blockers)

  const profile = await db.organizationCommercialProfile.findUniqueOrThrow({ where: { organizationId } })
  const updated = await db.organizationCommercialProfile.update({
    where: { organizationId },
    data: {
      commercialLifecycle: "live",
      onboardingStatus: "live",
      goLiveApprovedByOperatorId: operatorId,
      goLiveApprovedAt: new Date(),
      goLiveNotes: notes,
    },
  })

  await writeAuditLog({
    organizationId,
    userId: operatorId,
    action: "platform.go_live.approved",
    entityType: "organization_commercial_profile",
    entityId: updated.id,
    oldValues: { commercialLifecycle: profile.commercialLifecycle, onboardingStatus: profile.onboardingStatus },
    newValues: { commercialLifecycle: updated.commercialLifecycle, onboardingStatus: updated.onboardingStatus, notes },
  })
  return updated
}
