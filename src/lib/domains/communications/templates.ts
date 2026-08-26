import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import type { SessionContext } from "@/lib/auth/session"
import type { CommTemplateInput } from "@/lib/domains/communications/schemas"

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
