import "server-only"
import { db } from "@/lib/db"
import { assertCan, can } from "@/lib/platform/permissions-core"
import { getAuthorizedBranchScope, narrowBranchFilter } from "@/lib/platform/branch-scope"
import { startOfLocalDay, endOfLocalDay } from "@/lib/utils/dates"
import type { SessionContext } from "@/lib/auth/session"

export type DailyOperationsFilters = {
  /** The one local calendar date this report covers — defaults to today if omitted. */
  date?: Date
  branchId?: string
}

/**
 * P4.7 §8 — the practical "how did today go" view a clinic manager checks
 * at end-of-day: one specific date (not a from/to range like every other
 * report in this file), every count computed live from the same
 * authoritative tables the rest of this app already reads/writes, no
 * separately-maintained rollup.
 *
 * §8's own explicit warning — "Do not mix accounting revenue recognition
 * with cash collections" — is why `invoicesRaised`/`invoicedAmount` (an
 * Invoice.issuedAt figure) and `paymentsCollected`/`collectedAmount` (a
 * Payment.receivedAt figure) are reported as two clearly separate lines,
 * never summed into one "revenue" number: an invoice raised today may be
 * paid days later, and a payment collected today may settle an invoice
 * raised days ago — conflating them would misstate both.
 */
export async function getDailyOperationsReport(session: SessionContext, filters: DailyOperationsFilters = {}) {
  assertCan(session, "appointment.view")
  const organizationId = session.user.organizationId
  const scope = getAuthorizedBranchScope(session)
  const scopedBranchId = narrowBranchFilter(scope, filters.branchId)
  const branchWhere = scopedBranchId !== undefined ? { branchId: scopedBranchId } : {}

  const day = filters.date ?? new Date()
  const dayStart = startOfLocalDay(day)
  const dayEnd = endOfLocalDay(day)
  const dayRange = { gte: dayStart, lte: dayEnd }

  const canBilling = can(session, "invoice.view")
  const canPayments = can(session, "payment.view")
  const canPharmacy = can(session, "inventory.view")
  const canLab = can(session, "lab_result.verify") || can(session, "lab_result.enter")
  const canImaging = can(session, "imaging_result.verify") || can(session, "imaging_order.perform")

  const [
    appointmentsByStatus,
    walkInCount,
    encountersCompleted,
    invoicesRaised,
    paymentsAgg,
    refundsAgg,
    pharmacyDispensed,
    labOrdered,
    labResulted,
    imagingOrdered,
    imagingReported,
  ] = await Promise.all([
    db.appointment.groupBy({ by: ["status"], where: { organizationId, ...branchWhere, startTime: dayRange }, _count: { _all: true } }),
    db.appointment.count({ where: { organizationId, ...branchWhere, bookingSource: "walk_in", startTime: dayRange } }),
    db.encounter.count({ where: { organizationId, ...branchWhere, status: "completed", startAt: dayRange } }),
    canBilling
      ? db.invoice.aggregate({ where: { organizationId, ...branchWhere, status: { not: "void" }, issuedAt: dayRange }, _count: { _all: true }, _sum: { totalAmount: true } })
      : null,
    canPayments
      ? db.payment.aggregate({ where: { organizationId, ...branchWhere, status: "completed", receivedAt: dayRange }, _count: { _all: true }, _sum: { amount: true } })
      : null,
    canPayments
      ? db.refund.aggregate({ where: { organizationId, ...branchWhere, status: "completed", completedAt: dayRange }, _count: { _all: true }, _sum: { amount: true } })
      : null,
    canPharmacy ? db.dispensingRecord.count({ where: { organizationId, ...branchWhere, status: "dispensed", dispensedAt: dayRange } }) : null,
    canLab ? db.clinicalOrder.count({ where: { organizationId, ...branchWhere, orderType: "lab", orderedAt: dayRange } }) : null,
    canLab ? db.labOrderTest.count({ where: { organizationId, isCurrent: true, status: "verified", verifiedAt: dayRange, clinicalOrder: branchWhere } }) : null,
    canImaging ? db.clinicalOrder.count({ where: { organizationId, ...branchWhere, orderType: "imaging", orderedAt: dayRange } }) : null,
    canImaging ? db.imagingOrder.count({ where: { organizationId, status: "verified", verifiedAt: dayRange, clinicalOrder: branchWhere } }) : null,
  ])

  const statusCount = (status: string) => appointmentsByStatus.find((s) => s.status === status)?._count._all ?? 0
  const totalAppointments = appointmentsByStatus.reduce((sum, s) => sum + s._count._all, 0)

  return {
    date: dayStart,
    appointments: {
      scheduled: totalAppointments,
      checkedIn: statusCount("checked_in") + statusCount("waiting") + statusCount("in_consultation") + statusCount("completed"),
      completed: statusCount("completed"),
      cancelled: statusCount("cancelled"),
      noShow: statusCount("no_show"),
      walkIn: walkInCount,
    },
    encountersCompleted,
    billing: canBilling
      ? { invoicesRaised: invoicesRaised!._count._all, invoicedAmount: Number(invoicesRaised!._sum.totalAmount ?? 0) }
      : null,
    collections: canPayments
      ? { paymentsCollected: paymentsAgg!._count._all, collectedAmount: Number(paymentsAgg!._sum.amount ?? 0), refundsIssued: refundsAgg!._count._all, refundedAmount: Number(refundsAgg!._sum.amount ?? 0) }
      : null,
    pharmacy: canPharmacy ? { dispensesCompleted: pharmacyDispensed! } : null,
    lab: canLab ? { ordersPlaced: labOrdered!, resultsVerified: labResulted! } : null,
    imaging: canImaging ? { ordersPlaced: imagingOrdered!, reportsVerified: imagingReported! } : null,
  }
}
