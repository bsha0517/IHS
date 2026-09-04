import "server-only"
import { db } from "@/lib/db"
import { can, assertCan } from "@/lib/platform/permissions-core"
import { listLowStock, listNearExpiryBatches } from "@/lib/domains/inventory/stock"
import { listMaintenanceDue } from "@/lib/domains/assets/assets"
import { getProviderForUser } from "@/lib/domains/providers/service"
import { getAuthorizedBranchScope, narrowBranchFilter } from "@/lib/platform/branch-scope"
import type { SessionContext } from "@/lib/auth/session"

/**
 * Every number below is computed live from persisted rows at read time — no
 * cached/stored aggregate, no placeholder value (spec.md §92: "never fake
 * dashboard statistics"). This is the cross-module pass the Phase 1 dashboard
 * placeholder (src/app/(dashboard)/dashboard/page.tsx) explicitly deferred to
 * Phase 13.
 */

function todayRange() {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
  return { start, end }
}

function monthToDateRange() {
  const now = new Date()
  return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: now }
}

/**
 * Reuses `reports.export` as the gate for the Management Dashboard section —
 * it is already granted to exactly the management-tier roles (Super Admin,
 * Org Admin, Clinic Manager, Accountant, HR Manager) per SECURITY.md's
 * permission matrix, so this avoids inventing a parallel "dashboard.view"
 * permission for a section that maps 1:1 onto an existing capability.
 */
export async function getManagementDashboard(session: SessionContext, filters: { branchId?: string } = {}) {
  assertCan(session, "reports.export")
  const organizationId = session.user.organizationId
  const { start: todayStart, end: todayEnd } = todayRange()
  const { start: monthStart, end: monthEnd } = monthToDateRange()
  const scope = getAuthorizedBranchScope(session)
  const scopedBranchId = narrowBranchFilter(scope, filters.branchId)
  const branchWhere = scopedBranchId !== undefined ? { branchId: scopedBranchId } : {}

  const [
    todaysAppointments,
    checkedIn,
    waiting,
    completed,
    noShows,
    newPatients,
    revenueToday,
    collectionsToday,
    outstandingReceivables,
    expensesToday,
    topServices,
    doctorRevenue,
    branchPerformance,
    lowStock,
    expiringStock,
    maintenanceDue,
    employeesPresentToday,
    activeEmployeeCount,
  ] = await Promise.all([
    db.appointment.count({ where: { organizationId, ...branchWhere, startTime: { gte: todayStart, lt: todayEnd } } }),
    db.appointment.count({ where: { organizationId, ...branchWhere, status: { in: ["checked_in", "waiting", "in_consultation"] }, queueEntry: { checkedInAt: { gte: todayStart, lt: todayEnd } } } }),
    db.appointment.count({ where: { organizationId, ...branchWhere, status: "waiting" } }),
    db.appointment.count({ where: { organizationId, ...branchWhere, status: "completed", startTime: { gte: todayStart, lt: todayEnd } } }),
    db.appointment.count({ where: { organizationId, ...branchWhere, status: "no_show", startTime: { gte: todayStart, lt: todayEnd } } }),
    db.patient.count({ where: { organizationId, createdAt: { gte: todayStart, lt: todayEnd } } }),
    db.invoice.aggregate({ where: { organizationId, ...branchWhere, issuedAt: { gte: todayStart, lt: todayEnd }, status: { not: "void" } }, _sum: { totalAmount: true } }),
    db.payment.aggregate({ where: { organizationId, ...branchWhere, status: "completed", receivedAt: { gte: todayStart, lt: todayEnd } }, _sum: { amount: true } }),
    db.invoice.aggregate({ where: { organizationId, ...branchWhere, status: { in: ["issued", "partially_paid"] } }, _sum: { totalAmount: true, paidAmount: true } }),
    db.expense.aggregate({ where: { organizationId, ...branchWhere, expenseDate: { gte: todayStart, lt: todayEnd } }, _sum: { amount: true } }),
    db.charge.groupBy({ by: ["serviceId"], where: { organizationId, ...branchWhere, status: { not: "void" }, createdAt: { gte: monthStart, lte: monthEnd }, serviceId: { not: null } }, _sum: { amount: true }, orderBy: { _sum: { amount: "desc" } }, take: 5 }),
    db.charge.groupBy({ by: ["providerId"], where: { organizationId, ...branchWhere, status: { not: "void" }, createdAt: { gte: monthStart, lte: monthEnd }, providerId: { not: null } }, _sum: { amount: true }, orderBy: { _sum: { amount: "desc" } }, take: 5 }),
    db.invoice.groupBy({ by: ["branchId"], where: { organizationId, ...branchWhere, status: { not: "void" }, issuedAt: { gte: monthStart, lte: monthEnd } }, _sum: { totalAmount: true } }),
    // P3.9: this whole dashboard is gated on `reports.export` alone, which
    // Accountant holds without `inventory.view` (seed.ts) — these three
    // calls were unconditional despite each internally requiring
    // `inventory.view`, crashing the ENTIRE dashboard (not just these
    // tiles) for Accountant on every login. Found live during this batch's
    // own browser walkthrough — the same "unconditional fetch gated behind
    // a permission the qualifying role doesn't hold" class of bug P3.2/
    // P3.5/P3.6/P3.7 each found and fixed in their own domains. Degrades
    // to empty (0-count tiles) for a role that can't see inventory, rather
    // than crashing the whole page.
    can(session, "inventory.view") ? listLowStock(session, filters.branchId) : Promise.resolve([]),
    can(session, "inventory.view") ? listNearExpiryBatches(session, filters.branchId) : Promise.resolve([]),
    can(session, "inventory.view") ? listMaintenanceDue(session) : Promise.resolve([]),
    db.attendanceRecord.count({ where: { organizationId, ...branchWhere, date: { gte: todayStart, lt: todayEnd }, status: "present" } }),
    db.employee.count({ where: { organizationId, ...branchWhere, status: "active" } }),
  ])

  const [serviceNames, providerNames, branchNames] = await Promise.all([
    db.service.findMany({ where: { id: { in: topServices.map((s) => s.serviceId).filter((id): id is string => !!id) } } }),
    db.provider.findMany({ where: { id: { in: doctorRevenue.map((d) => d.providerId).filter((id): id is string => !!id) } } }),
    db.branch.findMany({ where: { id: { in: branchPerformance.map((b) => b.branchId) } } }),
  ])

  return {
    todaysAppointments,
    checkedIn,
    waiting,
    completed,
    noShows,
    newPatients,
    revenue: Number(revenueToday._sum.totalAmount ?? 0),
    collections: Number(collectionsToday._sum.amount ?? 0),
    outstandingReceivables: Number(outstandingReceivables._sum.totalAmount ?? 0) - Number(outstandingReceivables._sum.paidAmount ?? 0),
    expenses: Number(expensesToday._sum.amount ?? 0),
    topServices: topServices.map((s) => ({
      serviceName: serviceNames.find((sv) => sv.id === s.serviceId)?.name ?? "Unknown",
      amount: Number(s._sum.amount ?? 0),
    })),
    doctorRevenue: doctorRevenue.map((d) => {
      const provider = providerNames.find((p) => p.id === d.providerId)
      return { providerName: provider ? `${provider.firstName} ${provider.lastName}` : "Unknown", amount: Number(d._sum.amount ?? 0) }
    }),
    branchPerformance: branchPerformance.map((b) => ({
      branchName: branchNames.find((br) => br.id === b.branchId)?.name ?? "Unknown",
      amount: Number(b._sum.totalAmount ?? 0),
    })),
    lowStockCount: lowStock.length,
    expiringStockCount: expiringStock.length,
    assetsRequiringMaintenance: maintenanceDue.length,
    employeesPresent: employeesPresentToday,
    employeesAbsent: Math.max(activeEmployeeCount - employeesPresentToday, 0),
  }
}

export async function getReceptionDashboard(session: SessionContext, filters: { branchId?: string } = {}) {
  assertCan(session, "appointment.checkin")
  const organizationId = session.user.organizationId
  const { start: todayStart, end: todayEnd } = todayRange()
  const scope = getAuthorizedBranchScope(session)
  const scopedBranchId = narrowBranchFilter(scope, filters.branchId)
  const branchWhere = scopedBranchId !== undefined ? { branchId: scopedBranchId } : {}

  const [todaysAppointments, arrivals, waiting, upcoming, noShows] = await Promise.all([
    db.appointment.findMany({ where: { organizationId, ...branchWhere, startTime: { gte: todayStart, lt: todayEnd } }, include: { patient: true, provider: true }, orderBy: { startTime: "asc" } }),
    db.appointment.count({ where: { organizationId, ...branchWhere, status: { in: ["arrived", "checked_in", "waiting", "in_consultation", "completed"] }, startTime: { gte: todayStart, lt: todayEnd } } }),
    db.appointment.count({ where: { organizationId, ...branchWhere, status: "waiting" } }),
    db.appointment.count({ where: { organizationId, ...branchWhere, status: { in: ["scheduled", "confirmed"] }, startTime: { gte: new Date(), lt: todayEnd } } }),
    db.appointment.count({ where: { organizationId, ...branchWhere, status: "no_show", startTime: { gte: todayStart, lt: todayEnd } } }),
  ])

  return { todaysAppointments, arrivals, waiting, upcoming, noShows }
}

export async function getDoctorDashboard(session: SessionContext) {
  const provider = await getProviderForUser(session.user.id)
  if (!provider) return null

  const { start: todayStart, end: todayEnd } = todayRange()
  const organizationId = session.user.organizationId

  const [todaysSchedule, waitingPatients, currentEncounter, followUps, pendingOrders, recentPatientIds] = await Promise.all([
    db.appointment.findMany({ where: { organizationId, providerId: provider.id, startTime: { gte: todayStart, lt: todayEnd } }, include: { patient: true, service: true }, orderBy: { startTime: "asc" } }),
    db.appointment.count({ where: { organizationId, providerId: provider.id, status: { in: ["waiting", "in_consultation"] } } }),
    db.encounter.findFirst({ where: { organizationId, providerId: provider.id, status: { in: ["draft", "active"] } }, include: { patient: true }, orderBy: { startAt: "desc" } }),
    db.followUpRecommendation.findMany({ where: { organizationId, status: "open", encounter: { providerId: provider.id } }, include: { patient: true }, orderBy: { recommendedDate: "asc" }, take: 10 }),
    db.clinicalOrder.count({ where: { organizationId, orderingProviderId: provider.id, status: { in: ["draft", "ordered", "acknowledged", "in_progress"] } } }),
    db.encounter.findMany({ where: { organizationId, providerId: provider.id }, distinct: ["patientId"], orderBy: { startAt: "desc" }, take: 5, include: { patient: true } }),
  ])

  return {
    todaysSchedule,
    waitingPatients,
    currentEncounter,
    followUps,
    pendingClinicalTasks: pendingOrders,
    recentPatients: recentPatientIds.map((e) => e.patient),
  }
}

export async function getFinanceDashboard(session: SessionContext, filters: { branchId?: string } = {}) {
  assertCan(session, "accounting.view")
  const organizationId = session.user.organizationId
  const { start: monthStart, end: monthEnd } = monthToDateRange()
  const scope = getAuthorizedBranchScope(session)
  const scopedBranchId = narrowBranchFilter(scope, filters.branchId)
  const branchWhere = scopedBranchId !== undefined ? { branchId: scopedBranchId } : {}

  const [revenue, collections, receivables, payables, expenses, cashAccounts] = await Promise.all([
    db.invoice.aggregate({ where: { organizationId, ...branchWhere, status: { not: "void" }, issuedAt: { gte: monthStart, lte: monthEnd } }, _sum: { totalAmount: true } }),
    db.payment.aggregate({ where: { organizationId, ...branchWhere, status: "completed", receivedAt: { gte: monthStart, lte: monthEnd } }, _sum: { amount: true } }),
    db.invoice.aggregate({ where: { organizationId, ...branchWhere, status: { in: ["issued", "partially_paid"] } }, _sum: { totalAmount: true, paidAmount: true } }),
    db.supplierInvoice.aggregate({ where: { organizationId, ...branchWhere, status: { in: ["pending", "partially_paid"] } }, _sum: { amount: true, taxAmount: true, paidAmount: true } }),
    db.expense.aggregate({ where: { organizationId, ...branchWhere, expenseDate: { gte: monthStart, lte: monthEnd } }, _sum: { amount: true } }),
    db.chartOfAccount.findMany({ where: { organizationId, code: { in: ["1000", "1010"] } } }),
  ])

  const cashPosition = await db.journalLine.aggregate({
    where: { accountId: { in: cashAccounts.map((a) => a.id) }, journal: { organizationId, ...branchWhere } },
    _sum: { debit: true, credit: true },
  })

  return {
    revenue: Number(revenue._sum.totalAmount ?? 0),
    collections: Number(collections._sum.amount ?? 0),
    receivables: Number(receivables._sum.totalAmount ?? 0) - Number(receivables._sum.paidAmount ?? 0),
    // P3.9 §27: was `amount - paidAmount`, omitting tax — same fix as
    // listOutstandingSupplierInvoices (procurement/supplier-invoices.ts).
    payables: Number(payables._sum.amount ?? 0) + Number(payables._sum.taxAmount ?? 0) - Number(payables._sum.paidAmount ?? 0),
    expenses: Number(expenses._sum.amount ?? 0),
    cashPosition: Number(cashPosition._sum.debit ?? 0) - Number(cashPosition._sum.credit ?? 0),
  }
}

/** Which dashboard sections the signed-in user qualifies to see — role-aware per spec.md §8, driven by existing permissions rather than a new dashboard-specific one. */
export function visibleDashboardSections(session: SessionContext) {
  return {
    management: can(session, "reports.export"),
    reception: can(session, "appointment.checkin"),
    finance: can(session, "accounting.view"),
  }
}
