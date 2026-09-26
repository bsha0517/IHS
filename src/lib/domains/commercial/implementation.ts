import "server-only"
import { db } from "@/lib/db"
import { writeAuditLog } from "@/lib/platform/audit"
import { requirePlatformOperator } from "@/lib/platform/operator-guard"
import { getModuleEntitlements } from "@/lib/platform/entitlements"
import { getOrganizationCommercialDetail, getGoLiveBlockers } from "@/lib/domains/commercial/organizations"
import { listOnboardingChecklist, ONBOARDING_CHECKLIST_ITEMS } from "@/lib/domains/commercial/onboarding-checklist"
import { listPilotUats } from "@/lib/domains/commercial/pilot-uat"
import { listSupportTicketsForPlatform } from "@/lib/domains/commercial/support-tickets"
import { getFinancialReadinessGaps } from "@/lib/domains/accounting/posting-service"
import type { ModuleKey } from "@/lib/platform/entitlements-shared"
import type { $Enums } from "@/generated/prisma/client"

/**
 * P5.8 — orchestration only. Every readiness signal below is READ from its
 * own existing, untouched domain (onboarding checklist, PilotUat, support
 * tickets, financial readiness, go-live blockers/approval, module
 * entitlements) — this file never recomputes or second-guesses any of
 * those rules, it only composes their existing outputs into one coherent
 * per-customer view. The only genuinely new persistence is
 * `ImplementationTraining`/`ImplementationNote` and three additive fields
 * on `OrganizationCommercialProfile` (`targetGoLiveDate`,
 * `handoverCompletedAt`, `handoverCompletedByOperatorId`) — see the
 * schema's own P5.8 doc comment for why nothing else needed a new table.
 */

// ---------------------------------------------------------------------------
// Training — lightweight tracker, explicitly NOT an LMS (§17). Same
// module-aware, lazily-seeded-catalog pattern as onboarding-checklist.ts's
// own ONBOARDING_CHECKLIST_ITEMS/ensureOnboardingChecklist.
// ---------------------------------------------------------------------------

type TrainingAreaDefinition = { key: string; label: string; moduleKey?: ModuleKey }

export const IMPLEMENTATION_TRAINING_AREAS: TrainingAreaDefinition[] = [
  { key: "reception", label: "Reception", moduleKey: "reception" },
  { key: "doctors", label: "Doctors / Clinical", moduleKey: "clinical" },
  { key: "nursing", label: "Nursing", moduleKey: "nursing" },
  { key: "laboratory", label: "Laboratory", moduleKey: "laboratory" },
  { key: "radiology", label: "Radiology", moduleKey: "radiology" },
  { key: "pharmacy", label: "Pharmacy", moduleKey: "pharmacy" },
  { key: "billing_pos", label: "Billing / POS", moduleKey: "pos_billing" },
  { key: "inventory", label: "Inventory", moduleKey: "inventory" },
  { key: "finance", label: "Finance", moduleKey: "finance" },
  { key: "hr", label: "HR", moduleKey: "hr" },
  { key: "administration", label: "Administration" },
]
const TRAINING_LABEL_BY_KEY = Object.fromEntries(IMPLEMENTATION_TRAINING_AREAS.map((a) => [a.key, a.label]))

async function applicableTrainingAreas(organizationId: string): Promise<TrainingAreaDefinition[]> {
  const entitlements = await getModuleEntitlements(organizationId)
  return IMPLEMENTATION_TRAINING_AREAS.filter((a) => !a.moduleKey || entitlements[a.moduleKey])
}

/** Idempotent, self-healing seed — mirrors `ensureOnboardingChecklist`'s own doc comment exactly: never touches an existing row, safe to call on every read. */
export async function ensureImplementationTraining(organizationId: string): Promise<void> {
  const applicable = await applicableTrainingAreas(organizationId)
  const existing = await db.implementationTraining.findMany({ where: { organizationId }, select: { area: true } })
  const existingKeys = new Set(existing.map((r) => r.area))
  const missing = applicable.filter((a) => !existingKeys.has(a.key))
  if (missing.length === 0) return
  await db.implementationTraining.createMany({
    data: missing.map((a) => ({ organizationId, area: a.key })),
    skipDuplicates: true,
  })
}

export async function listImplementationTraining(organizationId: string) {
  await ensureImplementationTraining(organizationId)
  const rows = await db.implementationTraining.findMany({ where: { organizationId }, orderBy: { createdAt: "asc" } })
  return rows.map((r) => ({ ...r, label: TRAINING_LABEL_BY_KEY[r.area] ?? r.area }))
}

export type UpdateImplementationTrainingInput = {
  status: $Enums.ImplementationTrainingStatus
  scheduledAt?: Date | null
  notes?: string | null
}

export async function updateImplementationTraining(organizationId: string, trainingId: string, operatorId: string, input: UpdateImplementationTrainingInput) {
  const before = await db.implementationTraining.findFirstOrThrow({ where: { id: trainingId, organizationId } })
  const isCompleting = input.status === "completed" && before.status !== "completed"
  const updated = await db.implementationTraining.update({
    where: { id: trainingId },
    data: {
      status: input.status,
      scheduledAt: input.scheduledAt ?? before.scheduledAt,
      completedAt: isCompleting ? new Date() : input.status === "completed" ? before.completedAt : null,
      notes: input.notes ?? before.notes,
      recordedByOperatorId: operatorId,
    },
  })
  await writeAuditLog({
    organizationId,
    userId: operatorId,
    action: "platform.implementation_training.updated",
    entityType: "implementation_training",
    entityId: updated.id,
    oldValues: { area: before.area, status: before.status },
    newValues: { area: updated.area, status: updated.status },
  })
  return updated
}

// ---------------------------------------------------------------------------
// Implementation notes — the smallest sensible freeform timeline (§29). See
// the schema's own doc comment for why SupportTicketNote/AuditLog/
// internalNotes don't already cover this shape.
// ---------------------------------------------------------------------------

export async function listImplementationNotes(organizationId: string) {
  return db.implementationNote.findMany({ where: { organizationId }, orderBy: { createdAt: "desc" } })
}

export async function addImplementationNote(organizationId: string, operatorId: string, body: string) {
  const created = await db.implementationNote.create({ data: { organizationId, body, authorOperatorId: operatorId } })
  await writeAuditLog({
    organizationId,
    userId: operatorId,
    action: "platform.implementation_note.created",
    entityType: "implementation_note",
    entityId: created.id,
    newValues: { body },
  })
  return created
}

// ---------------------------------------------------------------------------
// Target go-live date (§27) — a PLANNED date, distinct from
// `goLiveApprovedAt` (the actual approval-event timestamp, already
// authoritative for "when did this org actually go live").
// ---------------------------------------------------------------------------

export async function updateTargetGoLiveDate(organizationId: string, operatorId: string, targetGoLiveDate: Date | null) {
  const before = await db.organizationCommercialProfile.findUniqueOrThrow({ where: { organizationId } })
  const updated = await db.organizationCommercialProfile.update({ where: { organizationId }, data: { targetGoLiveDate } })
  await writeAuditLog({
    organizationId,
    userId: operatorId,
    action: "platform.implementation.target_go_live_updated",
    entityType: "organization_commercial_profile",
    entityId: updated.id,
    oldValues: { targetGoLiveDate: before.targetGoLiveDate },
    newValues: { targetGoLiveDate: updated.targetGoLiveDate },
  })
  return updated
}

// ---------------------------------------------------------------------------
// Handover (§30) — recorded ONLY here, only after re-checking the SAME
// authoritative `getGoLiveBlockers()` go-live approval itself uses — never
// a second, looser definition of "ready."
// ---------------------------------------------------------------------------

export class HandoverNotReadyError extends Error {
  constructor(public readonly reasons: string[]) {
    super(`This organization cannot be handed over yet: ${reasons.join(" ")}`)
    this.name = "HandoverNotReadyError"
  }
}

/**
 * `getGoLiveBlockers()` intentionally reports "Organization is already
 * live"/"Organization is closed" as blockers — correct for its own purpose
 * (preventing a second go-live approval), but wrong to surface as an
 * implementation *gap* once an org is expected to already be live (handover,
 * the consolidated blockers list below). Filtered out ONLY here, at the
 * display/handover layer — `getGoLiveBlockers` itself is never touched.
 */
function filterLifecycleSelfBlockers(reasons: string[]): string[] {
  return reasons.filter((r) => r !== "Organization is already live." && r !== "Organization is closed.")
}

export async function completeHandover(organizationId: string, operatorId: string) {
  const profile = await db.organizationCommercialProfile.findUniqueOrThrow({ where: { organizationId } })
  const reasons: string[] = []
  if (profile.handoverCompletedAt) reasons.push("Handover has already been completed for this organization.")
  if (profile.commercialLifecycle !== "live") reasons.push("This organization has not been approved for go-live yet.")
  const blockers = filterLifecycleSelfBlockers(await getGoLiveBlockers(organizationId))
  reasons.push(...blockers)
  if (reasons.length > 0) throw new HandoverNotReadyError(reasons)

  const updated = await db.organizationCommercialProfile.update({
    where: { organizationId },
    data: { handoverCompletedAt: new Date(), handoverCompletedByOperatorId: operatorId },
  })
  await writeAuditLog({
    organizationId,
    userId: operatorId,
    action: "platform.implementation.handover_completed",
    entityType: "organization_commercial_profile",
    entityId: updated.id,
    newValues: { handoverCompletedAt: updated.handoverCompletedAt },
  })
  return updated
}

// ---------------------------------------------------------------------------
// Stage derivation (§7/§8) — pure composition over already-fetched data, no
// new business rules. Stage status is DERIVED, never separately persisted
// (§8's own "prefer derived statuses where possible").
// ---------------------------------------------------------------------------

export type ImplementationStageStatus = "not_started" | "in_progress" | "blocked" | "ready" | "complete"
export type ImplementationStageKey =
  | "provisioning"
  | "organization_configuration"
  | "master_data"
  | "staff_providers"
  | "opening_data"
  | "training"
  | "uat"
  | "go_live_readiness"
  | "go_live_approval"
  | "handover"

export type ImplementationStageItem = { label: string; complete: boolean; note?: string; href?: string | null }
export type ImplementationStage = { key: ImplementationStageKey; label: string; status: ImplementationStageStatus; items: ImplementationStageItem[] }

export type ImplementationBlockerSeverity = "blocking" | "warning" | "information"
export type ImplementationBlocker = { severity: ImplementationBlockerSeverity; message: string; nextActionLabel?: string; nextActionHref?: string }

export type ImplementationSummary = {
  status: "not_started" | "in_progress" | "blocked" | "live_pending_handover" | "complete"
  targetGoLiveDate: Date | null
  completedStageCount: number
  totalStageCount: number
  blockingCount: number
  warningCount: number
  nextAction: string | null
}

const MASTER_DATA_HREF: Record<string, string> = {
  services_configured: "/services",
  products_configured: "/inventory",
  suppliers_configured: "/suppliers",
  medications_configured: "/pharmacy",
  lab_catalogue_configured: "/laboratory",
  imaging_catalogue_configured: "/radiology",
  packages_configured: "/packages",
  payors_configured: "/payors",
  assets_configured: "/assets",
  hr_configuration: "/hr",
}
const MASTER_DATA_KEYS = Object.keys(MASTER_DATA_HREF)

function checklistItemStatusComplete(status: $Enums.OnboardingChecklistStatus): boolean {
  return status === "completed" || status === "waived"
}

function stageStatusFromItems(items: ImplementationStageItem[], anyBlocked: boolean): ImplementationStageStatus {
  if (items.length === 0) return "complete"
  if (anyBlocked) return "blocked"
  const completeCount = items.filter((i) => i.complete).length
  if (completeCount === items.length) return "complete"
  if (completeCount === 0) return "not_started"
  return "in_progress"
}

type ChecklistItem = Awaited<ReturnType<typeof listOnboardingChecklist>>[number]

function buildMasterDataStage(checklistItems: ChecklistItem[], entitlements: Record<ModuleKey, boolean>): ImplementationStage {
  const items: ImplementationStageItem[] = []
  // Items the checklist actually seeded (module already applicable).
  for (const item of checklistItems) {
    if (!MASTER_DATA_KEYS.includes(item.key)) continue
    items.push({ label: item.label, complete: checklistItemStatusComplete(item.status), href: MASTER_DATA_HREF[item.key] })
  }
  // §11/§32: a disabled module's master-data item is never seeded at all —
  // shown explicitly as Not Applicable (complete: true, so it never counts
  // as a gap) rather than silently omitted or shown as incomplete.
  const seededKeys = new Set(checklistItems.map((i) => i.key))
  for (const catalogItem of ONBOARDING_CHECKLIST_ITEMS) {
    if (!MASTER_DATA_KEYS.includes(catalogItem.key) || seededKeys.has(catalogItem.key)) continue
    if (catalogItem.moduleKey && !entitlements[catalogItem.moduleKey]) {
      items.push({ label: catalogItem.label, complete: true, note: "Not applicable — module disabled" })
    }
  }
  const anyBlocked = checklistItems.some((i) => MASTER_DATA_KEYS.includes(i.key) && i.status === "blocked")
  return { key: "master_data", label: "Master Data", status: stageStatusFromItems(items, anyBlocked), items }
}

export type ImplementationWorkspace = Awaited<ReturnType<typeof getImplementationWorkspace>>

/**
 * The one aggregate read the workspace page and portfolio row derive from.
 * Reuses `getOrganizationCommercialDetail` (already the "one aggregate
 * read" every existing organization-detail card consumes) rather than
 * re-querying anything it already computes — this function only adds the
 * handful of parallel reads that function doesn't already do (full
 * checklist item list, PilotUat cycles, support tickets, financial gap
 * detail, provider count, training, notes).
 */
export async function getImplementationWorkspace(organizationId: string) {
  const operator = await requirePlatformOperator()
  const detail = await getOrganizationCommercialDetail(organizationId)
  const profile = detail.organization.commercialProfile
  if (!profile) {
    throw new Error("This organization has no commercial profile and is not part of the implementation workspace.")
  }

  const [checklistItems, pilotUats, tickets, financialGaps, training, notes, providerCount] = await Promise.all([
    listOnboardingChecklist(organizationId, operator.operator.id),
    listPilotUats(organizationId),
    listSupportTicketsForPlatform({ organizationId }),
    getFinancialReadinessGaps(organizationId),
    listImplementationTraining(organizationId),
    listImplementationNotes(organizationId),
    db.provider.count({ where: { organizationId } }),
  ])

  const entitlements = detail.entitlements

  // --- Provisioning --------------------------------------------------------
  const provisioningItems: ImplementationStageItem[] = [
    { label: "Commercial profile created", complete: true },
    { label: "Subscription assigned", complete: profile.subscriptions.length > 0 },
    { label: "Initial branch created", complete: detail.organization.branches.length > 0 },
    { label: "Initial administrator created", complete: detail.admins.length > 0 },
    { label: "Onboarding checklist initialized", complete: checklistItems.length > 0 },
    { label: "Go-live conditions initialized", complete: profile.goLiveConditions.length > 0 },
  ]
  const provisioningStage: ImplementationStage = {
    key: "provisioning",
    label: "Provisioning",
    status: stageStatusFromItems(provisioningItems, false),
    items: provisioningItems,
  }

  // --- Organization Configuration -------------------------------------------
  const orgConfigItems = checklistItems
    .filter((i) => i.category === "organization" || i.category === "branches")
    .map((i): ImplementationStageItem => ({ label: i.label, complete: checklistItemStatusComplete(i.status) }))
  const orgConfigBlocked = checklistItems.some((i) => (i.category === "organization" || i.category === "branches") && i.status === "blocked")
  const organizationConfigurationStage: ImplementationStage = {
    key: "organization_configuration",
    label: "Organization Configuration",
    status: stageStatusFromItems(orgConfigItems, orgConfigBlocked),
    items: orgConfigItems,
  }

  // --- Master Data (module-aware, §11/§32) ---------------------------------
  const masterDataStage = buildMasterDataStage(checklistItems, entitlements)

  // --- Staff & Providers -----------------------------------------------------
  const staffItems = checklistItems
    .filter((i) => i.category === "users")
    .map((i): ImplementationStageItem => ({ label: i.label, complete: checklistItemStatusComplete(i.status) }))
  const staffBlocked = checklistItems.some((i) => i.category === "users" && i.status === "blocked")
  const staffProvidersStage: ImplementationStage = {
    key: "staff_providers",
    label: "Staff & Providers",
    status: stageStatusFromItems(staffItems, staffBlocked),
    items: staffItems,
  }

  // --- Opening Data (§13 — includes the opening-inventory/GL caveat) -------
  const openingItems: ImplementationStageItem[] = []
  const coaItem = checklistItems.find((i) => i.key === "chart_of_accounts_configured")
  if (coaItem) openingItems.push({ label: coaItem.label, complete: checklistItemStatusComplete(coaItem.status), href: "/accounting" })
  const inventoryItem = checklistItems.find((i) => i.key === "opening_inventory_imported")
  if (inventoryItem) {
    openingItems.push({
      label: inventoryItem.label,
      complete: checklistItemStatusComplete(inventoryItem.status),
      href: "/admin/onboarding",
      note:
        checklistItemStatusComplete(inventoryItem.status) && inventoryItem.status !== "waived"
          ? "Opening inventory import creates stock records only — confirm the corresponding opening GL journal (Dr Inventory Asset / Cr Opening Balance Equity) has been posted via Accounting → Manual Journal."
          : undefined,
    })
  }
  for (const gap of financialGaps) {
    openingItems.push({ label: `Account mapping: ${gap.label}`, complete: false, href: "/accounting" })
  }
  const openingDataStage: ImplementationStage = {
    key: "opening_data",
    label: "Opening Data",
    status: stageStatusFromItems(openingItems, false),
    items: openingItems,
  }

  // --- Training --------------------------------------------------------------
  const trainingItems: ImplementationStageItem[] = training.map((t) => ({
    label: t.label,
    complete: t.status === "completed" || t.status === "not_applicable",
  }))
  const trainingStage: ImplementationStage = {
    key: "training",
    label: "Training",
    status: stageStatusFromItems(trainingItems, false),
    items: trainingItems,
  }

  // --- UAT (reuses PilotUat exactly — §18/§19) --------------------------------
  const latestUat = pilotUats[0] ?? null
  const uatFailed = pilotUats.some((u) => u.result === "failed") && !pilotUats.some((u) => u.result === "passed" && u.signedOffAt)
  const uatItems: ImplementationStageItem[] = pilotUats.map((u) => ({
    label: `${u.cycleLabel} — ${u.scenarios.filter((s) => s.passed === true).length}/${u.scenarios.length} scenarios passed`,
    complete: u.result === "passed" && Boolean(u.signedOffAt),
    note: u.result === "failed" ? "Failed — see blockers/notes on this cycle." : undefined,
  }))
  const uatStage: ImplementationStage = {
    key: "uat",
    label: "UAT",
    status: uatFailed ? "blocked" : latestUat?.signedOffAt ? "complete" : pilotUats.length > 0 ? "in_progress" : "not_started",
    items: uatItems,
  }

  // --- Go-Live Readiness (§24 — getGoLiveBlockers is THE authority; the
  // "already live"/"already closed" self-blockers are filtered here for
  // DISPLAY only — see filterLifecycleSelfBlockers' own doc comment. The raw
  // `detail.goLiveBlockers` remains unfiltered for GoLiveApprovalCard's own
  // use, which never renders once already live anyway.) -------------------
  const blockers = filterLifecycleSelfBlockers(detail.goLiveBlockers)
  const goLiveReadinessItems: ImplementationStageItem[] =
    blockers.length === 0 ? [{ label: "All go-live conditions met", complete: true }] : blockers.map((reason) => ({ label: reason, complete: false }))
  const goLiveReadinessStage: ImplementationStage = {
    key: "go_live_readiness",
    label: "Go-Live Readiness",
    status: profile.commercialLifecycle === "live" ? "complete" : blockers.length === 0 ? "ready" : "blocked",
    items: goLiveReadinessItems,
  }

  // --- Go-Live Approval (§25 — reuses approveGoLive(), never a second button) --
  const goLiveApprovalStage: ImplementationStage = {
    key: "go_live_approval",
    label: "Go-Live Approval",
    status: profile.commercialLifecycle === "live" ? "complete" : blockers.length === 0 ? "ready" : "not_started",
    items: [{ label: "Go-live approved", complete: profile.commercialLifecycle === "live", note: profile.goLiveApprovedAt ? `Approved ${profile.goLiveApprovedAt.toISOString()}` : undefined }],
  }

  // --- Handover (§30) ---------------------------------------------------------
  const handoverStage: ImplementationStage = {
    key: "handover",
    label: "Handover",
    status: profile.handoverCompletedAt ? "complete" : profile.commercialLifecycle === "live" && blockers.length === 0 ? "ready" : "not_started",
    items: [{ label: "Handover completed", complete: Boolean(profile.handoverCompletedAt) }],
  }

  const stages: ImplementationStage[] = [
    provisioningStage,
    organizationConfigurationStage,
    masterDataStage,
    staffProvidersStage,
    openingDataStage,
    trainingStage,
    uatStage,
    goLiveReadinessStage,
    goLiveApprovalStage,
    handoverStage,
  ]

  // --- Consolidated blockers (§21/§22) ---------------------------------------
  const consolidatedBlockers: ImplementationBlocker[] = []
  for (const reason of blockers) {
    consolidatedBlockers.push({ severity: "blocking", message: reason, nextActionHref: `/platform/organizations/${organizationId}#go-live` })
  }
  if (uatFailed) {
    consolidatedBlockers.push({
      severity: "warning",
      message: "At least one UAT cycle failed without a later signed-off pass.",
      nextActionLabel: "Review UAT",
      nextActionHref: `/platform/organizations/${organizationId}/uat`,
    })
  }
  const incompleteTraining = training.filter((t) => t.status !== "completed" && t.status !== "not_applicable")
  if (incompleteTraining.length > 0) {
    consolidatedBlockers.push({
      severity: "warning",
      message: `${incompleteTraining.length} training area(s) not yet completed: ${incompleteTraining.map((t) => t.label).join(", ")}.`,
      nextActionLabel: "Update training",
      nextActionHref: `/platform/organizations/${organizationId}/implementation`,
    })
  }
  const blockingTickets = tickets.filter((t) => ["high", "critical"].includes(t.priority) && !["resolved", "closed"].includes(t.status))
  if (blockingTickets.length > 0) {
    consolidatedBlockers.push({
      severity: "warning",
      message: `${blockingTickets.length} high/critical-priority support ticket(s) open.`,
      nextActionLabel: "View tickets",
      nextActionHref: `/platform/tickets?organizationId=${organizationId}`,
    })
  }
  if (entitlements.clinical && providerCount === 0) {
    consolidatedBlockers.push({
      severity: "warning",
      message: "Doctor/Clinical module is enabled but no provider record exists yet.",
      nextActionLabel: "Add first provider",
      nextActionHref: "/providers",
    })
  }
  const optionalIncomplete = checklistItems.filter((i) => !i.required && !checklistItemStatusComplete(i.status))
  if (optionalIncomplete.length > 0) {
    consolidatedBlockers.push({ severity: "information", message: `${optionalIncomplete.length} optional onboarding item(s) not yet addressed.` })
  }

  // --- Summary (§31 — explicit conditions, never a numeric readiness score) --
  const blockingCount = consolidatedBlockers.filter((b) => b.severity === "blocking").length
  const warningCount = consolidatedBlockers.filter((b) => b.severity === "warning").length
  const completedStageCount = stages.filter((s) => s.status === "complete").length

  let summaryStatus: ImplementationSummary["status"]
  if (profile.handoverCompletedAt) summaryStatus = "complete"
  else if (profile.commercialLifecycle === "live") summaryStatus = "live_pending_handover"
  else if (blockingCount > 0) summaryStatus = "blocked"
  else if (completedStageCount <= 1) summaryStatus = "not_started"
  else summaryStatus = "in_progress"

  const firstBlocking = consolidatedBlockers.find((b) => b.severity === "blocking")
  const firstWarning = consolidatedBlockers.find((b) => b.severity === "warning")
  const nextAction =
    firstBlocking?.nextActionLabel ??
    (firstBlocking ? firstBlocking.message : undefined) ??
    firstWarning?.nextActionLabel ??
    (profile.commercialLifecycle !== "live" && blockingCount === 0 ? "Approve go-live" : null) ??
    (profile.commercialLifecycle === "live" && !profile.handoverCompletedAt ? "Complete handover" : null) ??
    null

  const summary: ImplementationSummary = {
    status: summaryStatus,
    targetGoLiveDate: profile.targetGoLiveDate,
    completedStageCount,
    totalStageCount: stages.length,
    blockingCount,
    warningCount,
    nextAction,
  }

  // "Who did this" display resolution for the notes/training/handover
  // authorship this workspace adds — same small, bounded-lookup pattern
  // `getOrganizationCommercialDetail`'s own `operatorEmails` already uses.
  const newOperatorIds = Array.from(
    new Set([...notes.map((n) => n.authorOperatorId), ...training.map((t) => t.recordedByOperatorId), profile.handoverCompletedByOperatorId].filter((id): id is string => Boolean(id)))
  ).filter((id) => !(id in detail.operatorEmails))
  const newOperators = newOperatorIds.length ? await db.platformOperator.findMany({ where: { id: { in: newOperatorIds } }, select: { id: true, email: true } }) : []
  const operatorEmails = { ...detail.operatorEmails, ...Object.fromEntries(newOperators.map((o) => [o.id, o.email])) }

  return { detail, stages, blockers: consolidatedBlockers, summary, training, notes, pilotUats, tickets, operatorEmails }
}

// ---------------------------------------------------------------------------
// Portfolio (§34) — a lighter per-organization summary for
// /platform/implementations. Deliberately reuses `getGoLiveBlockers` and the
// onboarding checklist summary rather than the full workspace aggregate
// above (which pulls tickets/UAT/training detail this list view doesn't
// render) — bounded per-page like `listOrganizationsForPlatform`.
// ---------------------------------------------------------------------------

export type ImplementationPortfolioRow = {
  organizationId: string
  displayName: string
  customerCode: string
  country: string
  planName: string | null
  implementationOwner: string | null
  commercialLifecycle: $Enums.CommercialLifecycle
  targetGoLiveDate: Date | null
  blockingCount: number
  handoverCompletedAt: Date | null
}

export async function listImplementationPortfolio(
  filters: { country?: string; implementationOwner?: string; commercialLifecycle?: $Enums.CommercialLifecycle } = {}
): Promise<ImplementationPortfolioRow[]> {
  await requirePlatformOperator()

  const profiles = await db.organizationCommercialProfile.findMany({
    where: {
      country: filters.country,
      implementationOwner: filters.implementationOwner,
      commercialLifecycle: filters.commercialLifecycle,
    },
    include: {
      organization: { select: { displayName: true } },
      subscriptions: { orderBy: { createdAt: "desc" }, take: 1, include: { plan: true } },
    },
    orderBy: { createdAt: "desc" },
  })

  const blockersByOrg = await Promise.all(profiles.map((p) => getGoLiveBlockers(p.organizationId)))

  return profiles.map((p, i) => ({
    organizationId: p.organizationId,
    displayName: p.organization.displayName,
    customerCode: p.customerCode,
    country: p.country,
    planName: p.subscriptions[0]?.plan.name ?? null,
    implementationOwner: p.implementationOwner,
    commercialLifecycle: p.commercialLifecycle,
    targetGoLiveDate: p.targetGoLiveDate,
    blockingCount: p.commercialLifecycle === "live" ? 0 : blockersByOrg[i].length,
    handoverCompletedAt: p.handoverCompletedAt,
  }))
}

export async function listImplementationOwners(): Promise<string[]> {
  await requirePlatformOperator()
  const rows = await db.organizationCommercialProfile.findMany({
    where: { implementationOwner: { not: null } },
    select: { implementationOwner: true },
    distinct: ["implementationOwner"],
  })
  return rows.map((r) => r.implementationOwner!).sort()
}
