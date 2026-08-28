import "server-only"
import { db } from "@/lib/db"
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

/**
 * P1 §24: "Journal: Use REVERSAL. Never physical delete once posted." — P0
 * already made sure nothing in this codebase can delete a Journal; this is
 * the missing other half — a real correction path for a manual journal
 * that turns out to be wrong. Scoped to `referenceType: "manual"` only
 * (a bare, non-domain-tied correction — see postManualJournal's own doc
 * comment): a journal a DOMAIN posting produced (Invoice, Payment, Refund,
 * ...) is reversed through that domain's own proper workflow instead (void,
 * refund, ...) — see postInvoiceVoided above for the Invoice case — since
 * reversing it directly here would desync the domain record's own status
 * from what the GL now shows. Posts an exact mirror (every line's
 * debit/credit swapped), never edits or deletes the original.
 */
export async function reverseJournal(session: SessionContext, journalId: string, reason: string) {
  const original = await db.journal.findFirstOrThrow({
    where: { id: journalId, organizationId: session.user.organizationId },
    include: { lines: true },
  })
  assertCan(session, "accounting.post", { branchId: original.branchId })
  if (original.referenceType !== "manual") {
    throw new Error("Only a manual journal can be reversed directly — reverse the underlying record instead (void the invoice, refund the payment, ...).")
  }
  const existingReversal = await db.journal.findFirst({
    where: { organizationId: session.user.organizationId, referenceType: "manual_reversal", referenceId: original.id },
  })
  if (existingReversal) {
    throw new Error("This journal has already been reversed.")
  }

  const reversal = await postManualJournal({
    organizationId: session.user.organizationId,
    branchId: original.branchId,
    journalDate: new Date(),
    description: `Reversal: ${reason} (of ${original.journalNumber})`,
    postedBy: session.user.id,
    lines: original.lines.map((l) => ({ accountId: l.accountId, debit: Number(l.credit), credit: Number(l.debit), description: l.description })),
  })
  // postManualJournal always posts referenceType "manual" — re-key this one
  // specifically to "manual_reversal"/original.id so the guard above (and a
  // reader looking at the journal list) can tell it apart from an ordinary
  // manual entry and trace it back to what it reverses.
  await db.journal.update({ where: { id: reversal.id }, data: { referenceType: "manual_reversal", referenceId: original.id } })

  await auditFromSession(session, "reverse", "journal", reversal.id, {
    old: { reverses: original.id, journalNumber: original.journalNumber },
    new: { reason },
  })
  return reversal
}
