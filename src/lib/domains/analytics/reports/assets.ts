import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import type { SessionContext } from "@/lib/auth/session"
import type { ReportFilters } from "@/lib/domains/analytics/schemas"

/** spec.md §65's "Assets" report bullets: Register, Maintenance, Calibration, Costs. Gated on inventory.view, matching listAssets' own gate. */
export async function getAssetsReport(session: SessionContext, filters: ReportFilters) {
  assertCan(session, "inventory.view")
  const organizationId = session.user.organizationId
  const branchWhere = filters.branchId ? { branchId: filters.branchId } : {}

  const [registerByStatus, registerByCategory, register, maintenanceRecords, calibrationRecords, acquisitionCost] = await Promise.all([
    db.asset.groupBy({ by: ["status"], where: { organizationId, ...branchWhere }, _count: { _all: true } }),
    db.asset.groupBy({ by: ["category"], where: { organizationId, ...branchWhere }, _count: { _all: true } }),
    db.asset.findMany({ where: { organizationId, ...branchWhere }, include: { branch: true }, orderBy: { assetNumber: "asc" } }),
    db.maintenanceRecord.findMany({
      where: { organizationId, serviceDate: { gte: filters.from, lte: filters.to }, asset: branchWhere },
      include: { asset: true },
      orderBy: { serviceDate: "desc" },
    }),
    db.calibrationRecord.findMany({
      where: { organizationId, calibrationDate: { gte: filters.from, lte: filters.to }, asset: branchWhere },
      include: { asset: true },
      orderBy: { calibrationDate: "desc" },
    }),
    db.asset.aggregate({ where: { organizationId, ...branchWhere, purchaseDate: { gte: filters.from, lte: filters.to } }, _sum: { cost: true } }),
  ])

  const maintenanceCost = maintenanceRecords.reduce((sum, m) => sum + Number(m.cost ?? 0), 0)
  const calibrationByResult = calibrationRecords.reduce<Record<string, number>>((acc, c) => {
    acc[c.result] = (acc[c.result] ?? 0) + 1
    return acc
  }, {})

  return {
    registerByStatus: registerByStatus.map((r) => ({ status: r.status, count: r._count._all })),
    registerByCategory: registerByCategory.map((r) => ({ category: r.category, count: r._count._all })),
    totalAssets: registerByStatus.reduce((sum, r) => sum + r._count._all, 0),
    register,
    maintenanceRecords,
    maintenanceCost,
    calibrationRecords,
    calibrationByResult,
    acquisitionCost: Number(acquisitionCost._sum.cost ?? 0),
    totalCosts: maintenanceCost + Number(acquisitionCost._sum.cost ?? 0),
  }
}
