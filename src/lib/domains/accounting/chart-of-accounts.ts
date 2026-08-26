import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import type { SessionContext } from "@/lib/auth/session"
import type { ChartOfAccountInput } from "@/lib/domains/accounting/schemas"

export async function listAccounts(session: SessionContext) {
  assertCan(session, "accounting.view")
  return db.chartOfAccount.findMany({
    where: { organizationId: session.user.organizationId },
    orderBy: { code: "asc" },
  })
}

export async function createAccount(session: SessionContext, input: ChartOfAccountInput) {
  assertCan(session, "chart_of_account.manage")
  const created = await db.chartOfAccount.create({
    data: {
      organizationId: session.user.organizationId,
      code: input.code,
      name: input.name,
      type: input.type,
      parentAccountId: input.parentAccountId ?? null,
    },
  })
  await auditFromSession(session, "create", "chart_of_account", created.id, { new: { code: created.code, name: created.name } })
  return created
}

export async function updateAccount(session: SessionContext, id: string, input: ChartOfAccountInput) {
  assertCan(session, "chart_of_account.manage")
  const existing = await db.chartOfAccount.findFirstOrThrow({ where: { id, organizationId: session.user.organizationId } })
  const updated = await db.chartOfAccount.update({
    where: { id },
    data: { code: input.code, name: input.name, type: input.type, parentAccountId: input.parentAccountId ?? null },
  })
  await auditFromSession(session, "update", "chart_of_account", id, { old: existing, new: input })
  return updated
}
