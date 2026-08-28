import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { nextNumber } from "@/lib/platform/sequences"
import { writeOutboxEvent, dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import "@/lib/platform/event-handlers"
import { ManualSubmissionAdapter } from "@/lib/domains/claims/adapters/manual-adapter"
import type { ClaimSubmissionAdapter } from "@/lib/domains/claims/adapters/types"
import { getAuthorizedBranchScope, narrowBranchFilter, assertBranchAccess } from "@/lib/platform/branch-scope"
import { applyPaymentAtomically } from "@/lib/domains/billing/invoices"
import type { SessionContext } from "@/lib/auth/session"
import type { CreateClaimInput, AdjudicateClaimInput, RecordRemittanceInput } from "@/lib/domains/claims/schemas"

const CLAIM_INCLUDE = {
  patient: true,
  payor: true,
  patientCoverage: { include: { policy: { include: { insurancePlan: true } } } },
  invoice: true,
  encounter: true,
  items: { include: { invoiceLine: true, diagnosis: true } },
  resubmissionOf: true,
  resubmittedBy: true,
  payments: true,
} as const

/**
 * "Create adapters for future country-specific integrations" (spec.md §39).
 * Always resolves to the manual adapter today — no live clearinghouse
 * connection exists for any payor yet. Kept as its own function (rather
 * than instantiating `ManualSubmissionAdapter` inline at the call site) so a
 * future per-payor/region routing rule has exactly one place to live.
 */
function resolveAdapter(payorId: string): ClaimSubmissionAdapter {
  void payorId // every payor resolves to the manual adapter today; kept as a parameter so a future per-payor/region adapter has a place to route on
  return new ManualSubmissionAdapter()
}

/**
 * Translates an issued Invoice's lines into a structured, submittable Claim
 * (spec.md §39's Treatment -> Claim step) — the identical doctor/billing-
 * intent-vs-structured-execution split every clinical support system since
 * Phase 8 has used, applied here to the revenue cycle: the Invoice already
 * captures what was billed; a Claim captures what's being submitted to a
 * specific payor for reimbursement, which lines, and against which
 * diagnoses. claimNumber uses the "CLM" sequence reserved since Phase 1 but
 * never used until now.
 */
export async function createClaim(session: SessionContext, input: CreateClaimInput) {
  const invoice = await db.invoice.findFirstOrThrow({
    where: { id: input.invoiceId, organizationId: session.user.organizationId },
  })
  assertCan(session, "claim.create", { branchId: invoice.branchId })
  if (invoice.status === "void") throw new Error("Cannot create a claim against a void invoice.")

  const coverage = await db.patientCoverage.findFirstOrThrow({
    where: { id: input.patientCoverageId, organizationId: session.user.organizationId, patientId: invoice.patientId },
    include: { policy: { include: { insurancePlan: true } } },
  })

  const lines = await db.invoiceLine.findMany({
    where: { id: { in: input.items.map((i) => i.invoiceLineId) }, invoiceId: invoice.id },
  })
  if (lines.length !== input.items.length) {
    throw new Error("One or more selected invoice lines do not belong to this invoice.")
  }
  const lineById = new Map(lines.map((l) => [l.id, l]))

  const submittedAmount = lines.reduce((sum, l) => sum.add(l.lineTotal), new Decimal(0))

  const claim = await db.$transaction(async (tx) => {
    const claimNumber = await nextNumber({ organizationId: session.user.organizationId, sequenceType: "CLM", prefix: "CLM" })

    const created = await tx.claim.create({
      data: {
        organizationId: session.user.organizationId,
        branchId: invoice.branchId,
        claimNumber,
        patientId: invoice.patientId,
        patientCoverageId: coverage.id,
        payorId: coverage.policy.insurancePlan.payorId,
        encounterId: invoice.providerId ? null : null, // encounter not derivable from Invoice directly; left null (see ClaimItem for line-level provenance)
        invoiceId: invoice.id,
        // Invoice doesn't carry a single encounterId of its own (its lines
        // can span several charges from different encounters), so this is
        // left unset at claim level — line-level provenance still exists
        // via each ClaimItem's invoiceLine -> charge -> encounter chain.
        submittedAmount,
        createdBy: session.user.id,
      },
    })

    for (const item of input.items) {
      const line = lineById.get(item.invoiceLineId)!
      await tx.claimItem.create({
        data: {
          claimId: created.id,
          invoiceLineId: line.id,
          diagnosisId: item.diagnosisId ?? null,
          procedureCode: item.procedureCode ?? null,
          submittedAmount: line.lineTotal,
        },
      })
    }

    return created
  })

  await auditFromSession(session, "create", "claim", claim.id, {
    new: { claimNumber: claim.claimNumber, invoiceId: invoice.id, submittedAmount: Number(submittedAmount) },
  })
  return claim
}

/** "Submission" (spec.md §39) — via the resolved adapter (manual today). */
export async function submitClaim(session: SessionContext, claimId: string) {
  const claim = await db.claim.findFirstOrThrow({ where: { id: claimId, organizationId: session.user.organizationId }, include: { payor: true } })
  assertCan(session, "claim.create", { branchId: claim.branchId })
  if (claim.status !== "draft") throw new Error(`Only a draft claim can be submitted (this one is "${claim.status}").`)

  const adapter = resolveAdapter(claim.payorId)
  const result = await adapter.submit({
    claimId: claim.id,
    claimNumber: claim.claimNumber,
    payorName: claim.payor.name,
    submittedAmount: Number(claim.submittedAmount),
  })

  const updated = await db.claim.update({
    where: { id: claimId },
    data: { status: "submitted", submittedAt: result.submittedAt, externalReference: result.externalReference },
  })
  await auditFromSession(session, "update", "claim", claimId, { new: { status: "submitted" } })
  return updated
}

/**
 * "Adjudication" (spec.md §39) — records the payor's per-item decision.
 * Whatever isn't approved becomes the patient's responsibility (a
 * documented simplification, not a real coordination-of-benefits
 * calculation — see PROJECT_STATUS.md's Phase 11 Known Issues). A claim
 * with zero approved anywhere goes straight to `rejected` rather than the
 * intermediate `adjudicated` state, since there's nothing left to remit.
 */
export async function adjudicateClaim(session: SessionContext, claimId: string, input: AdjudicateClaimInput) {
  const claim = await db.claim.findFirstOrThrow({ where: { id: claimId, organizationId: session.user.organizationId }, include: { items: true } })
  assertCan(session, "claim.adjudicate", { branchId: claim.branchId })
  if (claim.status !== "submitted") throw new Error(`Only a submitted claim can be adjudicated (this one is "${claim.status}").`)

  const itemById = new Map(claim.items.map((i) => [i.id, i]))
  for (const line of input.items) {
    if (!itemById.has(line.claimItemId)) throw new Error("One or more claim items do not belong to this claim.")
  }

  const updated = await db.$transaction(async (tx) => {
    let approvedTotal = new Decimal(0)
    let rejectedTotal = new Decimal(0)

    for (const line of input.items) {
      const item = itemById.get(line.claimItemId)!
      const approved = Decimal.min(new Decimal(line.approvedAmount), item.submittedAmount)
      const rejected = new Decimal(item.submittedAmount).sub(approved)
      approvedTotal = approvedTotal.add(approved)
      rejectedTotal = rejectedTotal.add(rejected)
      await tx.claimItem.update({
        where: { id: item.id },
        data: { approvedAmount: approved, rejectedAmount: rejected, denialReason: rejected.greaterThan(0) ? (line.denialReason ?? null) : null },
      })
    }

    const status = approvedTotal.equals(0) ? "rejected" : "adjudicated"
    return tx.claim.update({
      where: { id: claimId },
      data: {
        status,
        approvedAmount: approvedTotal,
        rejectedAmount: rejectedTotal,
        patientResponsibilityAmount: rejectedTotal,
        rejectionReason: status === "rejected" ? (input.rejectionReason ?? null) : null,
        adjudicatedAt: new Date(),
      },
    })
  })

  await auditFromSession(session, "update", "claim", claimId, { new: { status: updated.status, approvedAmount: Number(updated.approvedAmount ?? 0) } })
  return updated
}

/**
 * "Remittance" (spec.md §39) — recorded as an ordinary insurance-tender
 * Payment (spec.md §35 already lists "Insurance" as a payment method),
 * reusing the exact same PaymentReceived accounting/commission posting
 * every other payment already goes through, rather than a second, parallel
 * posting path. Deliberately bypasses the cashier-session requirement
 * `recordPayment()` enforces (see billing/payments.ts) — a remittance
 * arrives via bank transfer/EFT reconciliation, not a POS register, so
 * forcing it through an open cashier session would model something that
 * doesn't happen in practice.
 */
export async function recordRemittance(session: SessionContext, claimId: string, input: RecordRemittanceInput) {
  const claim = await db.claim.findFirstOrThrow({ where: { id: claimId, organizationId: session.user.organizationId }, include: { invoice: true } })
  assertCan(session, "claim.adjudicate", { branchId: claim.branchId })
  if (claim.status !== "adjudicated") throw new Error(`Only an adjudicated claim can be remitted (this one is "${claim.status}").`)

  const invoice = claim.invoice
  // Fast, pre-transaction check for the common (non-racing) case — see
  // applyPaymentAtomically's own doc comment (billing/invoices.ts) for the
  // actual safety mechanism, shared with payments.ts's recordPayment
  // precisely because both write the same invoice.paid_amount column and
  // must be guarded together, not independently (P1 §29).
  const preliminaryOutstanding = new Decimal(invoice.totalAmount).sub(invoice.paidAmount)
  if (new Decimal(input.amount).greaterThan(preliminaryOutstanding)) {
    throw new Error(`Remittance of ${input.amount.toFixed(2)} exceeds the invoice's outstanding balance of ${preliminaryOutstanding.toFixed(2)}.`)
  }

  // Timeout widened from Prisma's 5000ms default — see posting-service.ts's
  // POSTING_TRANSACTION_OPTIONS for why this environment's real Supabase
  // latency needs the headroom.
  const payment = await db.$transaction(async (tx) => {
    await applyPaymentAtomically(tx, invoice.id, new Decimal(input.amount))

    const receiptNumber = await nextNumber({ organizationId: session.user.organizationId, sequenceType: "PAY", prefix: "PAY" })
    const created = await tx.payment.create({
      data: {
        organizationId: session.user.organizationId,
        branchId: invoice.branchId,
        receiptNumber,
        method: "insurance",
        amount: new Decimal(input.amount),
        reference: input.reference ?? null,
        claimId: claim.id,
        receivedBy: session.user.id,
      },
    })
    await tx.paymentAllocation.create({
      data: { paymentId: created.id, invoiceId: invoice.id, amount: new Decimal(input.amount) },
    })

    // Not part of the balance invariant applyPaymentAtomically guards — a
    // plain overwrite of this remittance's own responsibility-split fields
    // is safe under concurrency regardless of paid_amount's current value.
    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        finalPayorResponsibility: new Decimal(input.amount),
        finalPatientResponsibility: claim.patientResponsibilityAmount ?? new Decimal(0),
      },
    })

    await tx.claim.update({ where: { id: claimId }, data: { status: "remitted", remittedAt: new Date() } })

    await writeOutboxEvent(tx, {
      organizationId: session.user.organizationId,
      eventType: "PaymentReceived",
      payload: {
        invoiceId: invoice.id,
        patientId: invoice.patientId,
        amount: input.amount,
        tenders: [{ method: "insurance", amount: input.amount }],
        paymentIds: [created.id],
      },
    })

    return created
  }, { timeout: 20_000, maxWait: 10_000 })

  await auditFromSession(session, "create", "payment", payment.id, { new: { claimId, amount: input.amount, method: "insurance" } })
  await dispatchPendingOutboxEvents(session.user.organizationId)
  return payment
}

/**
 * "Rejection -> Resubmission" (spec.md §39) — a NEW Claim row referencing
 * the rejected original via resubmissionOfId, never an in-place edit — the
 * same "never overwrite a finalized/historical record" discipline as
 * Appointment.rescheduledFromId (Phase 2) and ClinicalNote amendments
 * (Phase 3). Starts back at `draft`; staff correct the items/codes and
 * submit it again through the normal submitClaim() path.
 */
export async function resubmitClaim(session: SessionContext, claimId: string, input: CreateClaimInput) {
  const original = await db.claim.findFirstOrThrow({ where: { id: claimId, organizationId: session.user.organizationId } })
  assertCan(session, "claim.create", { branchId: original.branchId })
  if (original.status !== "rejected") throw new Error(`Only a rejected claim can be resubmitted (this one is "${original.status}").`)

  const created = await createClaim(session, input)
  const updated = await db.claim.update({ where: { id: created.id }, data: { resubmissionOfId: original.id } })
  await auditFromSession(session, "update", "claim", updated.id, { new: { resubmissionOfId: original.id } })
  return updated
}

/** Convenience wrapper: resubmits a rejected claim with its original items unchanged (staff correct codes outside this flow if needed, then create a fresh claim manually for a deeper correction). */
export async function resubmitClaimAsIs(session: SessionContext, claimId: string) {
  const original = await db.claim.findFirstOrThrow({
    where: { id: claimId, organizationId: session.user.organizationId },
    include: { items: true },
  })
  return resubmitClaim(session, claimId, {
    invoiceId: original.invoiceId,
    patientCoverageId: original.patientCoverageId,
    items: original.items.map((i) => ({
      invoiceLineId: i.invoiceLineId,
      diagnosisId: i.diagnosisId,
      procedureCode: i.procedureCode,
    })),
  })
}

export async function listClaims(session: SessionContext, filters: { status?: string } = {}) {
  assertCan(session, "claim.create")
  const scope = getAuthorizedBranchScope(session)
  return db.claim.findMany({
    where: {
      organizationId: session.user.organizationId,
      status: filters.status ? (filters.status as never) : undefined,
      branchId: narrowBranchFilter(scope),
    },
    include: { patient: true, payor: true, invoice: true },
    orderBy: { createdAt: "desc" },
  })
}

export async function getClaim(session: SessionContext, id: string) {
  assertCan(session, "claim.create")
  const claim = await db.claim.findFirstOrThrow({
    where: { id, organizationId: session.user.organizationId },
    include: CLAIM_INCLUDE,
  })
  assertBranchAccess(getAuthorizedBranchScope(session), claim.branchId)
  return claim
}
