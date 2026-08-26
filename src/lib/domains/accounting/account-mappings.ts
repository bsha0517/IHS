import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import type { SessionContext } from "@/lib/auth/session"
import type { AccountMappingInput } from "@/lib/domains/accounting/schemas"

export async function listMappings(session: SessionContext) {
  assertCan(session, "accounting.view")
  return db.accountMapping.findMany({
    where: { organizationId: session.user.organizationId },
    include: { account: true, branch: true },
    orderBy: [{ intent: "asc" }],
  })
}

/** One mapping per (intent, branch) — an existing mapping for the same pair is replaced, never duplicated. */
export async function setMapping(session: SessionContext, input: AccountMappingInput) {
  assertCan(session, "account_mapping.manage")

  const existing = await db.accountMapping.findFirst({
    where: { organizationId: session.user.organizationId, branchId: input.branchId ?? null, intent: input.intent },
  })

  const result = existing
    ? await db.accountMapping.update({ where: { id: existing.id }, data: { accountId: input.accountId } })
    : await db.accountMapping.create({
        data: {
          organizationId: session.user.organizationId,
          branchId: input.branchId ?? null,
          intent: input.intent,
          accountId: input.accountId,
        },
      })

  await auditFromSession(session, existing ? "update" : "create", "account_mapping", result.id, {
    new: { intent: input.intent, branchId: input.branchId ?? null, accountId: input.accountId },
  })
  return result
}
