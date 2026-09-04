import "server-only"
import { db } from "@/lib/db"
import { can, assertCan, ForbiddenError } from "@/lib/platform/permissions-core"
import { getAuthorizedBranchScope, narrowBranchFilter } from "@/lib/platform/branch-scope"
import { assertExportRowLimit } from "@/lib/platform/reports"
import type { $Enums } from "@/generated/prisma/client"
import type { SessionContext } from "@/lib/auth/session"
import type { ReportFilters } from "@/lib/domains/analytics/schemas"

const SCREEN_PREVIEW_ROWS = 200

/**
 * spec.md §65's "Revenue Cycle" report bullets: Charges, Claims, Rejections,
 * Collections, Patient responsibility. Spans both the billing-ops staff who
 * hold invoice.view and the insurance staff who hold claim.create — gated on
 * either rather than inventing a new permission for a category that's really
 * two existing capabilities' data viewed together.
 */
export async function getRevenueCycleReport(session: SessionContext, filters: ReportFilters) {
  if (!can(session, "invoice.view") && !can(session, "claim.create")) {
    throw new ForbiddenError("invoice.view|claim.create")
  }
  const organizationId = session.user.organizationId
  const scope = getAuthorizedBranchScope(session)
  const scopedBranchId = narrowBranchFilter(scope, filters.branchId)
  const branchWhere = scopedBranchId !== undefined ? { branchId: scopedBranchId } : {}

  const [chargesByStatus, claimsByStatus, rejectedClaims, collections, patientResponsibility] = await Promise.all([
    db.charge.groupBy({ by: ["status"], where: { organizationId, ...branchWhere, createdAt: { gte: filters.from, lte: filters.to } }, _count: { _all: true }, _sum: { amount: true } }),
    db.claim.groupBy({ by: ["status"], where: { organizationId, ...branchWhere, createdAt: { gte: filters.from, lte: filters.to } }, _count: { _all: true }, _sum: { submittedAmount: true } }),
    db.claim.findMany({ where: { organizationId, ...branchWhere, status: "rejected", createdAt: { gte: filters.from, lte: filters.to } }, include: { patient: true, payor: true }, orderBy: { createdAt: "desc" } }),
    db.payment.aggregate({ where: { organizationId, ...branchWhere, status: "completed", receivedAt: { gte: filters.from, lte: filters.to } }, _sum: { amount: true } }),
    db.invoice.aggregate({
      where: { organizationId, ...branchWhere, issuedAt: { gte: filters.from, lte: filters.to }, status: { not: "void" } },
      _sum: { estimatedPatientResponsibility: true, finalPatientResponsibility: true },
    }),
  ])

  return {
    chargesByStatus: chargesByStatus.map((c) => ({ status: c.status, count: c._count._all, amount: Number(c._sum.amount ?? 0) })),
    claimsByStatus: claimsByStatus.map((c) => ({ status: c.status, count: c._count._all, amount: Number(c._sum.submittedAmount ?? 0) })),
    rejectedClaims,
    rejectedAmount: rejectedClaims.reduce((sum, c) => sum + Number(c.rejectedAmount ?? c.submittedAmount ?? 0), 0),
    collections: Number(collections._sum.amount ?? 0),
    estimatedPatientResponsibility: Number(patientResponsibility._sum.estimatedPatientResponsibility ?? 0),
    finalPatientResponsibility: Number(patientResponsibility._sum.finalPatientResponsibility ?? 0),
  }
}

/**
 * P4.7 §15 — Invoice Report: one row per invoice with gross/discount/tax/
 * net/paid/outstanding, exactly the fields §15 names. `net` here means
 * `totalAmount` (post discount/tax, matching how Invoice.totalAmount is
 * already computed at issue time — see billing/invoices.ts) — `outstanding`
 * is the same `totalAmount - paidAmount` every other outstanding-balance
 * figure in this codebase already uses (financial.ts's own AR figure,
 * listOutstandingInvoices).
 */
function invoiceWhere(organizationId: string, branchFilter: string | { in: string[] } | undefined, filters: ReportFilters & { status?: $Enums.InvoiceStatus }) {
  return {
    organizationId,
    branchId: branchFilter,
    issuedAt: { gte: filters.from, lte: filters.to },
    ...(filters.status ? { status: filters.status } : {}),
  }
}

export async function getInvoiceReport(session: SessionContext, filters: ReportFilters & { status?: $Enums.InvoiceStatus }) {
  assertCan(session, "invoice.view")
  const organizationId = session.user.organizationId
  const scope = getAuthorizedBranchScope(session)
  const branchFilter = narrowBranchFilter(scope, filters.branchId)
  const where = invoiceWhere(organizationId, branchFilter, filters)
  const [total, rows] = await Promise.all([
    db.invoice.count({ where }),
    db.invoice.findMany({
      where,
      include: { patient: { select: { firstName: true, lastName: true, mrn: true } }, branch: { select: { name: true } } },
      orderBy: { issuedAt: "desc" },
      take: SCREEN_PREVIEW_ROWS,
    }),
  ])
  return { total, rows, truncated: total > rows.length }
}

export async function exportInvoiceRows(session: SessionContext, filters: ReportFilters & { status?: $Enums.InvoiceStatus }) {
  assertCan(session, "invoice.view")
  const organizationId = session.user.organizationId
  const scope = getAuthorizedBranchScope(session)
  const branchFilter = narrowBranchFilter(scope, filters.branchId)
  const where = invoiceWhere(organizationId, branchFilter, filters)
  const total = await db.invoice.count({ where })
  assertExportRowLimit(total)
  return db.invoice.findMany({
    where,
    include: { patient: { select: { firstName: true, lastName: true, mrn: true } }, branch: { select: { name: true } } },
    orderBy: { issuedAt: "desc" },
  })
}

/** P4.7 §15 — Collections Report: one row per completed payment receipt. */
export async function getCollectionsReport(session: SessionContext, filters: ReportFilters) {
  assertCan(session, "payment.view")
  const organizationId = session.user.organizationId
  const scope = getAuthorizedBranchScope(session)
  const branchFilter = narrowBranchFilter(scope, filters.branchId)
  const where = { organizationId, branchId: branchFilter, status: "completed" as const, receivedAt: { gte: filters.from, lte: filters.to } }
  const [total, rows] = await Promise.all([
    db.payment.count({ where }),
    db.payment.findMany({
      where,
      include: {
        branch: { select: { name: true } },
        receivedByUser: { select: { firstName: true, lastName: true } },
        // Payment has no direct patient FK — one payment can be allocated
        // across several invoices/patients (PaymentAllocation is a bridge
        // table) — traverse it the same way payments/actions.ts's own
        // detail view already does, rather than adding a redundant column.
        allocations: { include: { invoice: { select: { invoiceNumber: true, patient: { select: { firstName: true, lastName: true, mrn: true } } } } } },
      },
      orderBy: { receivedAt: "desc" },
      take: SCREEN_PREVIEW_ROWS,
    }),
  ])
  return { total, rows, truncated: total > rows.length }
}

export async function exportCollectionsRows(session: SessionContext, filters: ReportFilters) {
  assertCan(session, "payment.view")
  const organizationId = session.user.organizationId
  const scope = getAuthorizedBranchScope(session)
  const branchFilter = narrowBranchFilter(scope, filters.branchId)
  const where = { organizationId, branchId: branchFilter, status: "completed" as const, receivedAt: { gte: filters.from, lte: filters.to } }
  const total = await db.payment.count({ where })
  assertExportRowLimit(total)
  return db.payment.findMany({
    where,
    include: {
      branch: { select: { name: true } },
      receivedByUser: { select: { firstName: true, lastName: true } },
      allocations: { include: { invoice: { select: { invoiceNumber: true, patient: { select: { firstName: true, lastName: true, mrn: true } } } } } },
    },
    orderBy: { receivedAt: "desc" },
  })
}

/** P4.7 §15 — Refund Report: one row per refund, whatever its current status (not only completed ones — a manager reviewing refunds needs to see requested/authorized/rejected too). */
export async function getRefundReport(session: SessionContext, filters: ReportFilters) {
  assertCan(session, "payment.view")
  const organizationId = session.user.organizationId
  const scope = getAuthorizedBranchScope(session)
  const branchFilter = narrowBranchFilter(scope, filters.branchId)
  const where = { organizationId, branchId: branchFilter, requestedAt: { gte: filters.from, lte: filters.to } }
  const [total, rows] = await Promise.all([
    db.refund.count({ where }),
    db.refund.findMany({
      where,
      include: {
        invoice: { select: { invoiceNumber: true, patient: { select: { firstName: true, lastName: true, mrn: true } } } },
        requestedByUser: { select: { firstName: true, lastName: true } },
        authorizedByUser: { select: { firstName: true, lastName: true } },
      },
      orderBy: { requestedAt: "desc" },
      take: SCREEN_PREVIEW_ROWS,
    }),
  ])
  return { total, rows, truncated: total > rows.length }
}

export async function exportRefundRows(session: SessionContext, filters: ReportFilters) {
  assertCan(session, "payment.view")
  const organizationId = session.user.organizationId
  const scope = getAuthorizedBranchScope(session)
  const branchFilter = narrowBranchFilter(scope, filters.branchId)
  const where = { organizationId, branchId: branchFilter, requestedAt: { gte: filters.from, lte: filters.to } }
  const total = await db.refund.count({ where })
  assertExportRowLimit(total)
  return db.refund.findMany({
    where,
    include: {
      invoice: { select: { invoiceNumber: true, patient: { select: { firstName: true, lastName: true, mrn: true } } } },
      requestedByUser: { select: { firstName: true, lastName: true } },
      authorizedByUser: { select: { firstName: true, lastName: true } },
    },
    orderBy: { requestedAt: "desc" },
  })
}
