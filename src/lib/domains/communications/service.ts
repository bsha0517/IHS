import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { NullSmsAdapter } from "@/lib/domains/communications/adapters/sms-adapter"
import { NullWhatsAppAdapter } from "@/lib/domains/communications/adapters/whatsapp-adapter"
import { NullEmailAdapter } from "@/lib/domains/communications/adapters/email-adapter"
import type { CommunicationAdapter } from "@/lib/domains/communications/adapters/types"
import type { SessionContext } from "@/lib/auth/session"
import type { $Enums } from "@/generated/prisma/client"

const SMS_ADAPTER = new NullSmsAdapter()
const WHATSAPP_ADAPTER = new NullWhatsAppAdapter()
const EMAIL_ADAPTER = new NullEmailAdapter()

/** Every payor/region resolves to the same channel-appropriate Null adapter today — see adapters/types.ts. */
function resolveAdapter(channel: $Enums.CommChannel): CommunicationAdapter {
  if (channel === "sms") return SMS_ADAPTER
  if (channel === "whatsapp") return WHATSAPP_ADAPTER
  return EMAIL_ADAPTER
}

export function renderTemplate(text: string, variables: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key: string) => variables[key] ?? match)
}

/**
 * The communication engine's core send path (spec.md §56) — deliberately no
 * permission check of its own, the same "internal, reachable only from an
 * already-authorized action or a trusted system trigger" reasoning as
 * `generateSystemCharge()` (Phase 4). Renders the named template against the
 * supplied variables, resolves the channel's adapter, and always writes a
 * `CommMessage` row — even on failure — since "maintain communication
 * history" means recording every attempt, not just the successful ones.
 */
export async function sendMessage(input: {
  organizationId: string
  patientId: string
  templateKey: string
  variables: Record<string, string>
  referenceType?: string | null
  referenceId?: string | null
  sentBy?: string | null
}) {
  const template = await db.commTemplate.findFirstOrThrow({
    where: { organizationId: input.organizationId, key: input.templateKey, isActive: true },
  })
  const patient = await db.patient.findFirstOrThrow({ where: { id: input.patientId, organizationId: input.organizationId } })

  const recipientAddress = template.channel === "email" ? patient.email : template.channel === "whatsapp" ? (patient.whatsapp ?? patient.mobile) : patient.mobile

  const subject = template.subject ? renderTemplate(template.subject, input.variables) : null
  const body = renderTemplate(template.body, input.variables)

  let result: Awaited<ReturnType<CommunicationAdapter["send"]>>
  if (!recipientAddress) {
    result = { status: "failed", error: `Patient has no ${template.channel} address on file.` }
  } else {
    result = await resolveAdapter(template.channel).send({ to: recipientAddress, subject, body })
  }

  return db.commMessage.create({
    data: {
      organizationId: input.organizationId,
      patientId: input.patientId,
      channel: template.channel,
      templateId: template.id,
      subject,
      body,
      recipientAddress: recipientAddress ?? "",
      status: result.status,
      providerReference: result.status === "sent" ? result.providerReference : null,
      error: result.status === "failed" ? result.error : null,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      sentBy: input.sentBy ?? null,
    },
  })
}

/** Staff-facing wrapper — permission-gated, used by manual "Send" actions in the UI. */
export async function sendTemplateMessage(
  session: SessionContext,
  input: { patientId: string; templateKey: string; variables: Record<string, string>; referenceType?: string | null; referenceId?: string | null }
) {
  assertCan(session, "communication.send")
  const message = await sendMessage({
    organizationId: session.user.organizationId,
    patientId: input.patientId,
    templateKey: input.templateKey,
    variables: input.variables,
    referenceType: input.referenceType ?? null,
    referenceId: input.referenceId ?? null,
    sentBy: session.user.id,
  })
  await auditFromSession(session, "create", "comm_message", message.id, { new: { templateKey: input.templateKey, status: message.status } })
  return message
}

export async function listMessageHistory(session: SessionContext, filters: { patientId?: string } = {}) {
  assertCan(session, "communication.send")
  return db.commMessage.findMany({
    where: { organizationId: session.user.organizationId, patientId: filters.patientId },
    include: { patient: true, template: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  })
}
