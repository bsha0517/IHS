import { z } from "zod"
import { MODULE_KEYS } from "@/lib/platform/entitlements"
import { SUPPORT_TICKET_CATEGORIES } from "@/lib/domains/commercial/support-tickets-shared"

export const commercialPlanSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional().nullable(),
  active: z.boolean().default(true),
  userLimit: z.coerce.number().int().positive().optional().nullable(),
  branchLimit: z.coerce.number().int().positive().optional().nullable(),
  defaultModuleKeys: z.array(z.enum(MODULE_KEYS)).default([]),
  notes: z.string().max(1000).optional().nullable(),
})
export type CommercialPlanInput = z.infer<typeof commercialPlanSchema>

/**
 * P5.1 §24/§25: one deliberate workflow, not scattered admin pages. No
 * `password` field for the initial admin (§26) — provisioning always issues
 * a secure activation path, never accepts/echoes a client-chosen or
 * generated password through this form.
 */
export const provisionClinicSchema = z.object({
  idempotencyKey: z.uuid(),

  // Organization
  legalName: z.string().min(1).max(300),
  displayName: z.string().min(1).max(200),
  defaultCurrency: z.string().length(3),
  defaultTimezone: z.string().min(1),

  // Commercial profile
  legalBusinessName: z.string().max(300).optional().nullable(),
  primaryContactName: z.string().max(200).optional().nullable(),
  primaryContactEmail: z.email().max(254).optional().nullable(),
  primaryContactPhone: z.string().max(50).optional().nullable(),
  billingContactName: z.string().max(200).optional().nullable(),
  billingContactEmail: z.email().max(254).optional().nullable(),
  country: z.string().length(2, "Use a 2-letter ISO country code (e.g. PK, AE, SA)"),
  implementationOwner: z.string().max(200).optional().nullable(),
  internalNotes: z.string().max(2000).optional().nullable(),

  // Plan / subscription
  planId: z.uuid(),
  subscriptionStatus: z.enum(["trial", "active"]).default("trial"),
  startDate: z.coerce.date(),
  trialEndsAt: z.coerce.date().optional().nullable(),
  agreedUserLimit: z.coerce.number().int().positive().optional().nullable(),
  agreedBranchLimit: z.coerce.number().int().positive().optional().nullable(),
  agreedAmount: z.coerce.number().nonnegative().optional().nullable(),
  currency: z.string().length(3).optional().nullable(),
  billingCycle: z.enum(["monthly", "quarterly", "annual", "custom"]).optional().nullable(),
  subscriptionNotes: z.string().max(1000).optional().nullable(),

  // Initial branch
  branchName: z.string().min(1).max(200),
  branchCode: z.string().min(1).max(20),
  branchAddress: z.string().max(500).optional().nullable(),
  branchPhone: z.string().max(50).optional().nullable(),

  // Initial administrator
  adminEmail: z.email().max(254),
  adminFirstName: z.string().min(1).max(100),
  adminLastName: z.string().min(1).max(100),

  // Module selection — defaults to the plan's own defaults when omitted (see provisioning.ts)
  moduleKeys: z.array(z.enum(MODULE_KEYS)).optional(),
})
export type ProvisionClinicInput = z.infer<typeof provisionClinicSchema>

export const updateCommercialProfileSchema = z.object({
  legalBusinessName: z.string().max(300).optional().nullable(),
  primaryContactName: z.string().max(200).optional().nullable(),
  primaryContactEmail: z.email().max(254).optional().nullable(),
  primaryContactPhone: z.string().max(50).optional().nullable(),
  billingContactName: z.string().max(200).optional().nullable(),
  billingContactEmail: z.email().max(254).optional().nullable(),
  country: z.string().length(2).optional(),
  implementationOwner: z.string().max(200).optional().nullable(),
  internalNotes: z.string().max(2000).optional().nullable(),
})
export type UpdateCommercialProfileInput = z.infer<typeof updateCommercialProfileSchema>

export const updateSubscriptionSchema = z.object({
  planId: z.uuid(),
  status: z.enum(["trial", "active", "past_due", "suspended", "cancelled", "expired"]),
  startDate: z.coerce.date(),
  endDate: z.coerce.date().optional().nullable(),
  trialEndsAt: z.coerce.date().optional().nullable(),
  agreedUserLimit: z.coerce.number().int().positive().optional().nullable(),
  agreedBranchLimit: z.coerce.number().int().positive().optional().nullable(),
  agreedAmount: z.coerce.number().nonnegative().optional().nullable(),
  currency: z.string().length(3).optional().nullable(),
  billingCycle: z.enum(["monthly", "quarterly", "annual", "custom"]).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
})
export type UpdateSubscriptionInput = z.infer<typeof updateSubscriptionSchema>

// P5.2 — onboarding checklist, go-live approval, support tickets, pilot UAT

export const updateOnboardingChecklistItemSchema = z.object({
  status: z.enum(["not_started", "in_progress", "blocked", "completed", "waived"]),
  ownerLabel: z.string().max(200).optional().nullable(),
  dueDate: z.coerce.date().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  evidenceReference: z.string().max(500).optional().nullable(),
})
export type UpdateOnboardingChecklistItemSchemaInput = z.infer<typeof updateOnboardingChecklistItemSchema>

export const approveGoLiveSchema = z.object({
  notes: z.string().max(2000).optional().nullable(),
})

export const updateGoLiveConditionInputSchema = z.object({
  status: z.enum(["pending", "complete", "not_applicable", "blocked"]),
  note: z.string().max(2000).optional().nullable(),
})

export const createSupportTicketSchema = z.object({
  organizationId: z.uuid(),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  category: z.enum(SUPPORT_TICKET_CATEGORIES),
  priority: z.enum(["low", "normal", "high", "critical"]).default("normal"),
})
export type CreateSupportTicketSchemaInput = z.infer<typeof createSupportTicketSchema>

export const createClinicSupportTicketSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  category: z.enum(SUPPORT_TICKET_CATEGORIES),
  priority: z.enum(["low", "normal", "high", "critical"]).default("normal"),
})

export const supportTicketNoteSchema = z.object({
  body: z.string().min(1).max(5000),
})

export const operatorSupportTicketNoteSchema = z.object({
  body: z.string().min(1).max(5000),
  visibility: z.enum(["internal", "customer"]).default("internal"),
})

export const createPilotUatSchema = z.object({
  cycleLabel: z.string().min(1).max(200),
  testerName: z.string().min(1).max(200),
})

export const recordUatScenarioSchema = z.object({
  area: z.string().min(1).max(100),
  scenario: z.string().min(1).max(300),
  passed: z.enum(["true", "false", "unknown"]).transform((v) => (v === "unknown" ? null : v === "true")),
  notes: z.string().max(1000).optional().nullable(),
})

export const completePilotUatSchema = z.object({
  result: z.enum(["in_progress", "passed", "failed"]),
  blockers: z.string().max(2000).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  signOff: z.coerce.boolean().default(false),
})

// P5.8 — implementation workspace

export const updateImplementationTrainingSchema = z.object({
  status: z.enum(["not_scheduled", "scheduled", "completed", "not_applicable"]),
  scheduledAt: z.coerce.date().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
})
export type UpdateImplementationTrainingSchemaInput = z.infer<typeof updateImplementationTrainingSchema>

export const addImplementationNoteSchema = z.object({
  body: z.string().min(1).max(2000),
})

export const updateTargetGoLiveDateSchema = z.object({
  targetGoLiveDate: z.coerce.date().optional().nullable(),
})
