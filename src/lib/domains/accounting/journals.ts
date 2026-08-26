import "server-only"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { postManualJournal } from "@/lib/domains/accounting/posting-service"
import type { SessionContext } from "@/lib/auth/session"
import type { ManualJournalInput } from "@/lib/domains/accounting/schemas"

/** The one path where an accountant enters arbitrary debit/credit lines directly rather than the system deriving them. */
export async function createManualJournal(session: SessionContext, input: ManualJournalInput) {
  assertCan(session, "accounting.post", { branchId: input.branchId })

  const journal = await postManualJournal({
    organizationId: session.user.organizationId,
    branchId: input.branchId,
    journalDate: input.journalDate,
    description: input.description,
    postedBy: session.user.id,
    lines: input.lines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit, description: l.description })),
  })

  await auditFromSession(session, "create", "journal", journal.id, {
    new: { description: input.description, lineCount: input.lines.length },
  })
  return journal
}
