import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { isPharmacyEnabled } from "@/lib/platform/settings"
import type { SessionContext } from "@/lib/auth/session"
import type { $Enums } from "@/generated/prisma/client"

/**
 * P4.6 §5/§6 — derived, not stored: every check here reads the ORG'S OWN
 * actual configuration at call time (no new "isOnboarded" flag anywhere,
 * no dozens of arbitrary booleans on Organization). A module a clinic
 * doesn't intend to use (pharmacy/inventory, for a clinic with no
 * dispensing) never becomes a blocking requirement — gated on the same
 * `isPharmacyEnabled` toggle the rest of the app already uses to decide
 * whether that module is even switched on (§5's own "do not require
 * modules a clinic does not intend to use" instruction).
 */

export type ReadinessState = "not_started" | "in_progress" | "ready" | "optional" | "attention_required"

export type ReadinessItem = {
  area: string
  label: string
  status: ReadinessState
  required: boolean
  completed: boolean
  count?: number
  destination: string
  reason: string
}

export type OnboardingStatus = {
  items: ReadinessItem[]
  /** True only once every REQUIRED item is complete — optional items never block this. */
  operationallyReady: boolean
}

export async function getOnboardingStatus(session: SessionContext): Promise<OnboardingStatus> {
  assertCan(session, "data_import.manage")
  const organizationId = session.user.organizationId

  const [
    organization,
    branches,
    adminCount,
    operationalUserCount,
    providerCount,
    serviceCount,
    mappings,
    pharmacyEnabled,
    productCount,
    medicationCount,
    stockBatchCount,
    openingBalanceCount,
    patientCount,
    recentImportCount,
    labTestCount,
    imagingServiceCount,
  ] = await Promise.all([
    db.organization.findUniqueOrThrow({ where: { id: organizationId } }),
    db.branch.findMany({ where: { organizationId }, select: { id: true, status: true } }),
    db.user.count({ where: { organizationId, status: "active", roles: { some: { role: { permissions: { some: { permission: { code: "users.manage" } } } } } } } }),
    db.user.count({ where: { organizationId, status: "active" } }),
    db.provider.count({ where: { organizationId } }),
    db.service.count({ where: { organizationId, isActive: true } }),
    db.accountMapping.findMany({ where: { organizationId }, select: { intent: true } }),
    isPharmacyEnabled(organizationId),
    db.product.count({ where: { organizationId } }),
    db.medication.count({ where: { organizationId } }),
    db.stockLedgerEntry.count({ where: { organizationId } }),
    // P4.9.2 §17 — distinct from the "opening inventory exists" check below:
    // specifically the rows an Opening Inventory import produces (never an
    // auto-posted journal — see opening-inventory.ts's own doc comment).
    db.stockLedgerEntry.count({ where: { organizationId, referenceType: "opening_balance" } }),
    db.patient.count({ where: { organizationId } }),
    db.importJob.count({ where: { organizationId, status: "completed" } }),
    db.labTest.count({ where: { organizationId, isActive: true } }),
    db.imagingService.count({ where: { organizationId, isActive: true } }),
  ])

  const activeBranches = branches.filter((b) => b.status === "active")
  const mappedIntents = new Set<$Enums.PostingIntent>(mappings.map((m) => m.intent))
  const TENDER_INTENTS: $Enums.PostingIntent[] = ["cash", "card", "bank", "online", "insurance"]
  const hasTenderMapping = TENDER_INTENTS.some((i) => mappedIntents.has(i))
  const hasCoreBilling = mappedIntents.has("accounts_receivable") && mappedIntents.has("revenue") && hasTenderMapping
  const hasInventoryMappings = mappedIntents.has("inventory_asset") && mappedIntents.has("cogs")

  const items: ReadinessItem[] = []

  items.push({
    area: "organization",
    label: "Organization identity",
    required: true,
    completed: Boolean(organization.legalName && organization.displayName && organization.defaultCurrency && organization.defaultTimezone && organization.status === "active"),
    status: organization.legalName && organization.displayName && organization.defaultCurrency && organization.defaultTimezone && organization.status === "active" ? "ready" : "attention_required",
    destination: "/admin/settings",
    reason: organization.status !== "active" ? "Organization is not active." : "Legal name, display name, currency, and timezone are all configured.",
    count: undefined,
  })

  items.push({
    area: "structure",
    label: "Active branch",
    required: true,
    completed: activeBranches.length > 0,
    status: activeBranches.length > 0 ? "ready" : "not_started",
    destination: "/admin/settings",
    reason: activeBranches.length > 0 ? `${activeBranches.length} active branch(es) configured.` : "No active branch exists yet — a branch is required before any operational workflow can run.",
    count: activeBranches.length,
  })

  items.push({
    area: "staff",
    label: "Administrator account",
    required: true,
    completed: adminCount > 0,
    status: adminCount > 0 ? "ready" : "attention_required",
    destination: "/admin/users",
    reason: adminCount > 0 ? `${adminCount} active administrator(s).` : "No active user holds an administrator role.",
    count: adminCount,
  })

  items.push({
    area: "staff",
    label: "Operational users",
    required: true,
    completed: operationalUserCount > 1, // more than just the one bootstrap admin
    status: operationalUserCount > 1 ? "ready" : "in_progress",
    destination: "/admin/users",
    reason: `${operationalUserCount} active user(s) — at least one non-administrator operational user (reception, clinical, billing) is expected before go-live.`,
    count: operationalUserCount,
  })

  items.push({
    area: "clinical",
    label: "Providers",
    required: true,
    completed: providerCount > 0,
    status: providerCount > 0 ? "ready" : "not_started",
    destination: "/providers",
    reason: providerCount > 0 ? `${providerCount} provider(s) configured.` : "No providers exist — appointment booking and consultation require at least one.",
    count: providerCount,
  })

  items.push({
    area: "clinical",
    label: "Services",
    required: true,
    completed: serviceCount > 0,
    status: serviceCount > 0 ? "ready" : "not_started",
    destination: "/services",
    reason: serviceCount > 0 ? `${serviceCount} active service(s) configured.` : "No billable services exist — appointment booking and billing require at least one.",
    count: serviceCount,
  })

  items.push({
    area: "billing",
    label: "Accounting mappings",
    required: true,
    completed: hasCoreBilling,
    status: hasCoreBilling ? "ready" : "attention_required",
    destination: "/accounting",
    reason: hasCoreBilling
      ? "Accounts Receivable, Revenue, and at least one tender/payment account are mapped."
      : "Missing required account mapping(s): Accounts Receivable, Revenue, and/or a tender (cash/card/bank/online/insurance) account.",
    count: mappedIntents.size,
  })

  items.push({
    area: "inventory",
    label: "Products / Medications",
    required: pharmacyEnabled,
    completed: !pharmacyEnabled || productCount > 0 || medicationCount > 0,
    status: !pharmacyEnabled ? "optional" : productCount > 0 || medicationCount > 0 ? "ready" : "not_started",
    destination: "/inventory",
    reason: !pharmacyEnabled
      ? "Pharmacy/inventory is disabled for this organization — not required."
      : productCount > 0 || medicationCount > 0
        ? `${productCount} product(s), ${medicationCount} medication(s).`
        : "Pharmacy is enabled but no products/medications exist yet.",
    count: productCount + medicationCount,
  })

  items.push({
    area: "inventory",
    label: "Inventory accounting mappings",
    required: pharmacyEnabled,
    completed: !pharmacyEnabled || hasInventoryMappings,
    status: !pharmacyEnabled ? "optional" : hasInventoryMappings ? "ready" : "attention_required",
    destination: "/accounting",
    reason: !pharmacyEnabled ? "Pharmacy/inventory is disabled — not required." : hasInventoryMappings ? "Inventory Asset and COGS accounts are mapped." : "Missing Inventory Asset and/or COGS account mapping.",
    count: undefined,
  })

  items.push({
    area: "inventory",
    label: "Opening inventory",
    required: false, // a clinic may legitimately start with zero stock and receive it operationally from day one
    completed: stockBatchCount > 0,
    status: !pharmacyEnabled ? "optional" : stockBatchCount > 0 ? "ready" : "optional",
    destination: "/admin/onboarding",
    reason: stockBatchCount > 0 ? `${stockBatchCount} stock ledger entries recorded.` : "No opening stock recorded yet — optional; stock can also be received operationally after go-live.",
    count: stockBatchCount,
  })

  if (openingBalanceCount > 0) {
    // P4.9.2 §17 — closes the narrow P4.9/BACKLOG.md finding: previously
    // nothing here told an administrator that imported opening stock has
    // no corresponding GL journal until one is posted manually. Never
    // auto-posts anything (see opening-inventory.ts) — this is a visibility
    // fix only. Not `required` (a clinic can legitimately choose to post
    // the opening journal later, or never, if it doesn't need the Balance
    // Sheet to reflect it) — it exists to be seen, not to block readiness.
    items.push({
      area: "inventory",
      label: "Opening inventory GL confirmation",
      required: false,
      completed: false,
      status: "attention_required",
      destination: "/accounting",
      reason: "Opening inventory has been imported. Confirm/post the corresponding opening GL journal before relying on the Balance Sheet.",
      count: openingBalanceCount,
    })
  }

  items.push({
    area: "clinical",
    label: "Laboratory test catalogue",
    required: false,
    completed: labTestCount > 0,
    status: labTestCount > 0 ? "ready" : "optional",
    destination: "/admin/onboarding",
    reason: labTestCount > 0 ? `${labTestCount} active lab test(s) configured.` : "No lab tests configured yet — optional; only needed if this clinic runs laboratory services.",
    count: labTestCount,
  })

  items.push({
    area: "clinical",
    label: "Imaging service catalogue",
    required: false,
    completed: imagingServiceCount > 0,
    status: imagingServiceCount > 0 ? "ready" : "optional",
    destination: "/admin/onboarding",
    reason: imagingServiceCount > 0 ? `${imagingServiceCount} active imaging service(s) configured.` : "No imaging services configured yet — optional; only needed if this clinic runs radiology services.",
    count: imagingServiceCount,
  })

  items.push({
    area: "patients",
    label: "Patient records",
    required: false,
    completed: patientCount > 0,
    status: patientCount > 0 ? "ready" : "optional",
    destination: "/admin/onboarding",
    reason: patientCount > 0 ? `${patientCount} patient(s) on file.` : "No patients yet — optional; patients can also be registered one at a time as they arrive.",
    count: patientCount,
  })

  if (recentImportCount > 0) {
    items.push({
      area: "migration",
      label: "Data imports completed",
      required: false,
      completed: true,
      status: "ready",
      destination: "/admin/onboarding",
      reason: `${recentImportCount} import(s) committed.`,
      count: recentImportCount,
    })
  }

  const operationallyReady = items.filter((i) => i.required).every((i) => i.completed)

  return { items, operationallyReady }
}
