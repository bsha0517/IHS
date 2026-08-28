import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { getAuthorizedBranchScope, narrowBranchFilter } from "@/lib/platform/branch-scope"
import type { SessionContext } from "@/lib/auth/session"

type StatementLine = {
  date: Date
  type: "invoice" | "payment" | "refund"
  description: string
  charge: number
  credit: number
  runningBalance: number
  referenceId: string
  referenceNumber: string
}

/**
 * P1 §36: one chronological ledger of every invoice, payment (including an
 * insurance remittance — `recordRemittance`, claims/service.ts, reuses this
 * same Payment/PaymentAllocation path with `method: "insurance"` and a
 * `claimId`, spec.md §35's own "Insurance" tender, not a second parallel
 * mechanism), and refund for one patient, each contributing a signed amount
 * to a running balance — proven, in
 * test/integration/patient-statement-reconciliation.test.ts, to always
 * equal the same AR figure `getFinancialReport`'s own `accountsReceivable`
 * computes for this patient's invoices, since both are built from the
 * identical `Invoice.totalAmount`/`paidAmount` fields, just read two
 * different ways (a running sum here vs. a direct aggregate there).
 *
 * A void invoice is excluded entirely, not shown as a zeroed line —
 * `voidInvoice` refuses to void an invoice with any payment applied
 * (`paidAmount > 0` throws "issue a refund instead"), so a void invoice by
 * construction never contributed to the patient's balance and never has a
 * payment/refund of its own to reconcile.
 */
export async function getPatientStatement(session: SessionContext, patientId: string) {
  assertCan(session, "invoice.view")
  assertCan(session, "payment.view")
  const scope = getAuthorizedBranchScope(session)
  const branchFilter = narrowBranchFilter(scope)

  const patient = await db.patient.findFirstOrThrow({
    where: { id: patientId, organizationId: session.user.organizationId },
  })

  const invoices = await db.invoice.findMany({
    where: { organizationId: session.user.organizationId, patientId, branchId: branchFilter },
    orderBy: { issuedAt: "asc" },
  })
  const invoiceIds = invoices.map((i) => i.id)

  const payments = await db.payment.findMany({
    where: { organizationId: session.user.organizationId, branchId: branchFilter, allocations: { some: { invoiceId: { in: invoiceIds } } } },
    include: { allocations: { where: { invoiceId: { in: invoiceIds } } } },
    orderBy: { receivedAt: "asc" },
  })

  const refunds = await db.refund.findMany({
    where: { organizationId: session.user.organizationId, branchId: branchFilter, invoiceId: { in: invoiceIds }, status: "completed" },
    orderBy: { completedAt: "asc" },
  })

  type Event = { date: Date; type: StatementLine["type"]; description: string; charge: number; credit: number; referenceId: string; referenceNumber: string }
  const events: Event[] = []

  for (const inv of invoices) {
    if (inv.status === "void") continue
    events.push({
      date: inv.issuedAt, type: "invoice", charge: Number(inv.totalAmount), credit: 0,
      description: `Invoice ${inv.invoiceNumber}`, referenceId: inv.id, referenceNumber: inv.invoiceNumber,
    })
  }
  for (const p of payments) {
    const allocatedToThisPatient = p.allocations.reduce((sum, a) => sum + Number(a.amount), 0)
    if (allocatedToThisPatient === 0) continue
    const isInsurance = p.claimId !== null
    events.push({
      date: p.receivedAt, type: "payment", charge: 0, credit: allocatedToThisPatient,
      description: `Payment ${p.receiptNumber} — ${p.method}${isInsurance ? " (insurance)" : ""}`,
      referenceId: p.id, referenceNumber: p.receiptNumber,
    })
  }
  for (const r of refunds) {
    events.push({
      date: r.completedAt ?? r.requestedAt, type: "refund", charge: Number(r.amount), credit: 0,
      description: `Refund${r.refundNumber ? ` ${r.refundNumber}` : ""} — ${r.method}: ${r.reason}`,
      referenceId: r.id, referenceNumber: r.refundNumber ?? r.id,
    })
  }

  events.sort((a, b) => a.date.getTime() - b.date.getTime())

  let runningBalance = 0
  const lines: StatementLine[] = events.map((e) => {
    runningBalance += e.charge - e.credit
    return { date: e.date, type: e.type, description: e.description, charge: e.charge, credit: e.credit, runningBalance, referenceId: e.referenceId, referenceNumber: e.referenceNumber }
  })

  // The same AR-style figure getFinancialReport().accountsReceivable
  // computes, scoped to this one patient — the running ledger above must
  // land here exactly, by construction (paidAmount is incremented by
  // payments and decremented by refunds, the identical two signed
  // contributions the ledger sums independently).
  const outstandingBalance = invoices
    .filter((inv) => inv.status !== "void")
    .reduce((sum, inv) => sum + (Number(inv.totalAmount) - Number(inv.paidAmount)), 0)

  return {
    patient,
    invoices,
    payments,
    refunds,
    lines,
    outstandingBalance,
    reconciled: Math.abs((lines.at(-1)?.runningBalance ?? 0) - outstandingBalance) < 0.01,
  }
}
