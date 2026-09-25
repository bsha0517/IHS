import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { writeAuditLog } from "@/lib/platform/audit"
import { isModuleEnabled } from "@/lib/platform/entitlements"
import type { SessionContext } from "@/lib/auth/session"
import type { CommTemplateInput } from "@/lib/domains/communications/schemas"
import type { $Enums } from "@/generated/prisma/client"

export async function listTemplates(session: SessionContext) {
  assertCan(session, "communication.manage")
  return db.commTemplate.findMany({
    where: { organizationId: session.user.organizationId },
    orderBy: [{ channel: "asc" }, { name: "asc" }],
  })
}

export async function createTemplate(session: SessionContext, input: CommTemplateInput) {
  assertCan(session, "communication.manage")
  const created = await db.commTemplate.create({
    data: {
      organizationId: session.user.organizationId,
      key: input.key,
      channel: input.channel,
      name: input.name,
      subject: input.subject ?? null,
      body: input.body,
    },
  })
  await auditFromSession(session, "create", "comm_template", created.id, { new: { key: created.key, channel: created.channel } })
  return created
}

export async function updateTemplate(session: SessionContext, id: string, input: CommTemplateInput) {
  assertCan(session, "communication.manage")
  const existing = await db.commTemplate.findFirstOrThrow({ where: { id, organizationId: session.user.organizationId } })
  const updated = await db.commTemplate.update({
    where: { id },
    data: {
      key: input.key,
      channel: input.channel,
      name: input.name,
      subject: input.subject ?? null,
      body: input.body,
    },
  })
  await auditFromSession(session, "update", "comm_template", id, { old: existing, new: input })
  return updated
}

export async function deactivateTemplate(session: SessionContext, id: string) {
  assertCan(session, "communication.manage")
  const updated = await db.commTemplate.update({ where: { id }, data: { isActive: false } })
  await auditFromSession(session, "update", "comm_template", id, { new: { isActive: false } })
  return updated
}

/**
 * P5.4 §3 — every `templateKey` any event handler
 * (`platform/event-handlers.ts`'s AppointmentBooked/AppointmentCancelled) or
 * dashboard action (`communications/actions.ts`'s reminder/payment-reminder/
 * birthday sends) actually looks up via `sendMessage()`'s
 * `db.commTemplate.findFirstOrThrow`. Provisioning creates none of this
 * automatically (confirmed by inspection, and the real P5.3 UAT defect this
 * closes) — a freshly-provisioned clinic's very first appointment booking
 * or cancellation would otherwise fail to notify the patient at all, every
 * time, forever, with no visible error anywhere in the UI.
 *
 * Generic operational copy only — no price, tax, clinical, or regulatory
 * content, so it is safe as a universal default for every clinic (P5.4's own
 * "safe global default" test) and reasonable as-is for a small pilot clinic
 * to launch on immediately, while still being a normal, editable
 * `CommTemplate` row a clinic can customize like any other.
 */
const DEFAULT_TEMPLATE_CATALOG: {
  key: string
  channel: $Enums.CommChannel
  name: string
  body: string
  /** Only seeded when at least one of these modules is enabled — omit for a template every clinic can use regardless of optional modules. */
  requiresAnyModule?: readonly ("pos_billing" | "finance")[]
}[] = [
  {
    key: "appointment_confirmation",
    channel: "sms",
    name: "Appointment Confirmation",
    body: "Hi {{patientName}}, your appointment with {{providerName}} is confirmed for {{appointmentDate}} {{appointmentTime}} at {{branchName}}.",
  },
  {
    key: "appointment_cancellation",
    channel: "sms",
    name: "Appointment Cancellation",
    body: "Hi {{patientName}}, your appointment on {{appointmentDate}} {{appointmentTime}} has been cancelled.",
  },
  {
    key: "appointment_reminder",
    channel: "sms",
    name: "Appointment Reminder",
    body: "Reminder: {{patientName}}, you have an appointment with {{providerName}} on {{appointmentDate}} {{appointmentTime}}.",
  },
  {
    key: "payment_reminder",
    channel: "sms",
    name: "Payment Reminder",
    body: "Hi {{patientName}}, invoice {{invoiceNumber}} has an outstanding balance of {{outstandingAmount}}. Please contact the clinic to arrange payment.",
    requiresAnyModule: ["pos_billing", "finance"],
  },
  {
    key: "birthday",
    channel: "sms",
    name: "Birthday Greeting",
    body: "Happy birthday, {{patientName}}! Wishing you good health from all of us.",
  },
]

/**
 * Idempotent baseline-template seeding — same pattern as
 * `onboarding-checklist.ts`'s `ensureOnboardingChecklist` (missing-only
 * insert, `skipDuplicates: true`, audit gated on the actual insert count so
 * a concurrent double-call can't double-log): safe to call once, twice, or
 * on every provisioning/organization-load, never duplicates a key (`@@unique
 * ([organizationId, key])`), and never touches a template that already
 * exists — including one a clinic has edited or deliberately deactivated —
 * since existence alone, not `isActive`, is what "missing" means here.
 */
export async function ensureCommunicationTemplates(organizationId: string, actorOperatorId?: string): Promise<void> {
  const [enabledPos, enabledFinance] = await Promise.all([isModuleEnabled(organizationId, "pos_billing"), isModuleEnabled(organizationId, "finance")])
  const enabledModules = new Set<string>([...(enabledPos ? ["pos_billing"] : []), ...(enabledFinance ? ["finance"] : [])])

  const applicable = DEFAULT_TEMPLATE_CATALOG.filter((t) => !t.requiresAnyModule || t.requiresAnyModule.some((m) => enabledModules.has(m)))

  const existing = await db.commTemplate.findMany({ where: { organizationId }, select: { key: true } })
  const existingKeys = new Set(existing.map((r) => r.key))
  const missing = applicable.filter((t) => !existingKeys.has(t.key))
  if (missing.length === 0) return

  const isFirstSeed = existing.length === 0
  const result = await db.commTemplate.createMany({
    data: missing.map((t) => ({ organizationId, key: t.key, channel: t.channel, name: t.name, body: t.body })),
    skipDuplicates: true,
  })

  if (result.count > 0 && actorOperatorId) {
    await writeAuditLog({
      organizationId,
      userId: actorOperatorId,
      action: isFirstSeed ? "platform.comm_template.seeded" : "platform.comm_template.backfilled",
      entityType: "comm_template",
      entityId: organizationId,
      newValues: { keys: missing.map((t) => t.key), insertedCount: result.count },
    })
  }
}
