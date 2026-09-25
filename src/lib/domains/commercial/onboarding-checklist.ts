import "server-only"
import { db } from "@/lib/db"
import { writeAuditLog } from "@/lib/platform/audit"
import { getModuleEntitlements } from "@/lib/platform/entitlements"
import type { $Enums } from "@/generated/prisma/client"

/**
 * P5.2 §2: a manually operator-tracked implementation project checklist —
 * "has the human implementation project done X," never "does the database
 * currently contain configuration Y" (that remains `readiness.ts`'s own,
 * untouched, derived-live job — see its doc comment). This file owns the
 * fixed catalog of what checklist items CAN exist for an organization; it
 * never invents a requirement Avant HIS doesn't actually support, and an
 * "operational configuration" item only ever appears for an org whose real
 * module entitlements make it relevant (a clinic with laboratory disabled
 * is never shown "configure the lab catalogue").
 */

export type OnboardingChecklistCategory = "organization" | "branches" | "users" | "operational_configuration"

type CatalogItem = {
  key: string
  category: OnboardingChecklistCategory
  label: string
  description: string
  required: boolean
  /** If set, this item only applies when the named module is enabled for the organization. */
  moduleKey?: import("@/lib/platform/entitlements-shared").ModuleKey
}

/**
 * The fixed catalog — every item Avant HIS's onboarding workspace can ever
 * show. Reuses existing, already-built functionality (services, products,
 * suppliers, medications, lab/imaging catalogues, packages, payors, chart
 * of accounts, opening inventory, assets, HR) rather than inventing new
 * configuration surfaces; each item's `description` points at the real
 * existing screen/workflow that satisfies it.
 */
export const ONBOARDING_CHECKLIST_ITEMS: CatalogItem[] = [
  // Organization
  { key: "commercial_profile", category: "organization", label: "Commercial profile completed", description: "Primary/billing contact and country recorded on the organization's commercial profile.", required: true },
  { key: "plan_subscription", category: "organization", label: "Plan and subscription assigned", description: "A commercial plan and subscription are attached to this organization.", required: true },
  { key: "module_selection", category: "organization", label: "Modules selected", description: "The modules this clinic has purchased are enabled on the organization's entitlements.", required: true },

  // Branches
  { key: "initial_branch", category: "branches", label: "Initial branch configured", description: "The clinic's first branch exists with a name, code, and timezone.", required: true },
  { key: "additional_branches", category: "branches", label: "Additional branches configured (if applicable)", description: "Any further branches the clinic operates are added under Admin → Settings → Branches.", required: false },

  // Users
  { key: "initial_admin_activated", category: "users", label: "Initial administrator activated", description: "The clinic's initial Super Admin has used their activation link and set a password.", required: true },
  { key: "required_staff_added", category: "users", label: "Required staff added", description: "Reception/clinical/other operational staff accounts are created under Admin → Users.", required: true },
  { key: "providers_added", category: "users", label: "Providers added", description: "Doctors/practitioners are added under Providers, with schedules where applicable.", required: false },
  { key: "user_limit_headroom", category: "users", label: "User count within the subscription's limit", description: "Active user count is at or under the subscription's user limit.", required: true },

  // Operational configuration — only shown for an org where the relevant module is entitled
  { key: "services_configured", category: "operational_configuration", label: "Services configured", description: "Billable services exist under Services.", required: true },
  { key: "products_configured", category: "operational_configuration", label: "Products configured", description: "Stocked products exist under Inventory.", required: true, moduleKey: "inventory" },
  { key: "suppliers_configured", category: "operational_configuration", label: "Suppliers configured", description: "Suppliers exist under Purchasing → Suppliers.", required: false, moduleKey: "procurement" },
  { key: "medications_configured", category: "operational_configuration", label: "Medications configured", description: "The medication formulary exists under Pharmacy.", required: true, moduleKey: "pharmacy" },
  { key: "lab_catalogue_configured", category: "operational_configuration", label: "Lab catalogue configured", description: "Lab tests/panels exist under Laboratory.", required: true, moduleKey: "laboratory" },
  { key: "imaging_catalogue_configured", category: "operational_configuration", label: "Imaging catalogue configured", description: "Imaging services exist under Radiology.", required: true, moduleKey: "radiology" },
  { key: "packages_configured", category: "operational_configuration", label: "Packages configured (if applicable)", description: "Any bundled service packages the clinic sells are configured under Packages.", required: false },
  { key: "payors_configured", category: "operational_configuration", label: "Payors configured (if applicable)", description: "Insurance payors/plans are configured under Payors, if the clinic bills insurers.", required: false },
  { key: "chart_of_accounts_configured", category: "operational_configuration", label: "Chart of accounts configured", description: "The chart of accounts and default account mappings exist under Accounting.", required: true, moduleKey: "finance" },
  { key: "opening_inventory_imported", category: "operational_configuration", label: "Opening inventory imported (if applicable)", description: "Existing stock-on-hand is imported via the onboarding data-import workflow.", required: false, moduleKey: "inventory" },
  { key: "assets_configured", category: "operational_configuration", label: "Assets configured (if applicable)", description: "Clinic equipment/assets are recorded under Assets.", required: false, moduleKey: "assets" },
  { key: "hr_configuration", category: "operational_configuration", label: "HR configuration (if applicable)", description: "Departments, shifts, and leave policies are configured under HR.", required: false, moduleKey: "hr" },
]

/** Which catalog items actually apply to this organization right now, given its real module entitlements — never a static list. */
async function applicableCatalogItems(organizationId: string): Promise<CatalogItem[]> {
  const entitlements = await getModuleEntitlements(organizationId)
  return ONBOARDING_CHECKLIST_ITEMS.filter((item) => !item.moduleKey || entitlements[item.moduleKey])
}

/**
 * Idempotent: inserts one row per currently-applicable catalog item the
 * organization doesn't already have (keyed by `[organizationId, key]`).
 * Never touches an existing row's status/notes/owner/etc. — safe to call
 * repeatedly (e.g. after entitlements change, to pick up newly-relevant
 * items) without ever resetting an operator's own progress. Called from
 * provisioning and from the onboarding workspace's own first load.
 * `actorOperatorId` is optional — omitted when called from a context (e.g. a
 * routine "sync new items" read) that shouldn't write a fresh
 * `platform.onboarding.created` row; a genuinely first-ever seed always
 * audits, so pass it whenever the caller has an operator in scope.
 */
export async function ensureOnboardingChecklist(organizationId: string, actorOperatorId?: string): Promise<void> {
  const applicable = await applicableCatalogItems(organizationId)
  const existing = await db.onboardingChecklistItem.findMany({ where: { organizationId }, select: { key: true } })
  const existingKeys = new Set(existing.map((r) => r.key))
  const missing = applicable.filter((item) => !existingKeys.has(item.key))
  if (missing.length === 0) return

  const isFirstSeed = existing.length === 0
  // `getOrganizationCommercialDetail` calls this (via getOnboardingChecklistSummary,
  // both directly and through getGoLiveBlockers) twice in the same Promise.all —
  // two concurrent first-seed calls for the same brand-new organization would
  // otherwise both compute the same "missing" set and race on the
  // (organizationId, key) unique constraint. skipDuplicates makes the losing
  // call's insert a no-op instead of a thrown UniqueConstraintViolation, and
  // gating the audit on the actual insert count (not the pre-read snapshot)
  // keeps `platform.onboarding.created` from firing twice if a future caller
  // ever passes actorOperatorId from both racing sides.
  const result = await db.onboardingChecklistItem.createMany({
    data: missing.map((item) => ({
      organizationId,
      category: item.category,
      key: item.key,
      label: item.label,
      required: item.required,
    })),
    skipDuplicates: true,
  })

  if (isFirstSeed && result.count > 0 && actorOperatorId) {
    await writeAuditLog({
      organizationId,
      userId: actorOperatorId,
      action: "platform.onboarding.created",
      entityType: "onboarding_checklist",
      entityId: organizationId,
      newValues: { itemCount: result.count },
    })
  }
}

/**
 * `operatorId` is required, not resolved internally via `requirePlatformOperator()`
 * — every caller (a Server Action, a page's own data loader) must already
 * hold a real, cookie-verified `PlatformSessionContext` before calling in,
 * exactly the pattern `provisionClinic()` already established. This is a
 * deliberate design choice for every P5.2 platform-mutation function: it
 * keeps real authorization at the one place that can actually see the
 * request (Next's `cookies()`, request-scope-only), while making the
 * function itself callable directly from an integration test with a plain
 * string id — `requirePlatformOperator()` cannot run outside a request
 * scope at all, which made P5.1's own equivalent functions untestable
 * outside a browser/E2E context. See test/integration/p5-2-pilot-clinic-operations.test.ts.
 */
export async function listOnboardingChecklist(organizationId: string, operatorId: string) {
  await ensureOnboardingChecklist(organizationId, operatorId)
  return db.onboardingChecklistItem.findMany({
    where: { organizationId },
    orderBy: [{ category: "asc" }, { createdAt: "asc" }],
  })
}

export type UpdateOnboardingChecklistItemInput = {
  status: $Enums.OnboardingChecklistStatus
  ownerLabel?: string | null
  dueDate?: Date | null
  notes?: string | null
  evidenceReference?: string | null
}

/**
 * §2: waiving/completing a MANDATORY item is still an explicit, auditable
 * operator action with its own reason (`notes`) — this function never
 * blocks it (that would defeat "waived" as a real status for a condition
 * that genuinely doesn't apply to this clinic), but it also never happens
 * silently: every transition is audited with the before/after status.
 */
export async function updateOnboardingChecklistItem(organizationId: string, itemId: string, operatorId: string, input: UpdateOnboardingChecklistItemInput) {
  const before = await db.onboardingChecklistItem.findFirstOrThrow({ where: { id: itemId, organizationId } })
  const wasAllComplete = (await getOnboardingChecklistSummary(organizationId)).allRequiredComplete

  const isCompleting = input.status === "completed" && before.status !== "completed"
  const updated = await db.onboardingChecklistItem.update({
    where: { id: itemId },
    data: {
      status: input.status,
      ownerLabel: input.ownerLabel ?? before.ownerLabel,
      dueDate: input.dueDate ?? before.dueDate,
      notes: input.notes ?? before.notes,
      evidenceReference: input.evidenceReference ?? before.evidenceReference,
      completedByOperatorId: isCompleting ? operatorId : input.status === "completed" ? before.completedByOperatorId : null,
      completedAt: isCompleting ? new Date() : input.status === "completed" ? before.completedAt : null,
    },
  })

  await writeAuditLog({
    organizationId,
    userId: operatorId,
    action: "platform.onboarding.updated",
    entityType: "onboarding_checklist_item",
    entityId: updated.id,
    oldValues: { key: before.key, status: before.status },
    newValues: { key: updated.key, status: updated.status },
  })

  const nowAllComplete = (await getOnboardingChecklistSummary(organizationId)).allRequiredComplete
  if (nowAllComplete && !wasAllComplete) {
    await writeAuditLog({
      organizationId,
      userId: operatorId,
      action: "platform.onboarding.completed",
      entityType: "onboarding_checklist",
      entityId: organizationId,
      newValues: {},
    })
  }
  return updated
}

/** Summary counts for the organization detail / dashboard views — required items only count toward "complete". */
export async function getOnboardingChecklistSummary(organizationId: string) {
  await ensureOnboardingChecklist(organizationId)
  const items = await db.onboardingChecklistItem.findMany({ where: { organizationId } })
  const required = items.filter((i) => i.required)
  const requiredComplete = required.filter((i) => i.status === "completed" || i.status === "waived")
  return {
    totalItems: items.length,
    requiredItems: required.length,
    requiredComplete: requiredComplete.length,
    allRequiredComplete: required.length > 0 && requiredComplete.length === required.length,
  }
}
