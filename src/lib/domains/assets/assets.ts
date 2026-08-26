import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { nextNumber } from "@/lib/platform/sequences"
import type { SessionContext } from "@/lib/auth/session"
import type { AssetInput, MaintenanceRecordInput, CalibrationRecordInput } from "@/lib/domains/assets/schemas"

const ASSET_INCLUDE = { branch: true, department: true, room: true, assignedEmployee: true, supplier: true } as const

export async function listAssets(session: SessionContext, filters: { branchId?: string; status?: string; category?: string } = {}) {
  assertCan(session, "inventory.view")
  return db.asset.findMany({
    where: {
      organizationId: session.user.organizationId,
      branchId: filters.branchId,
      status: filters.status as never,
      category: filters.category,
    },
    include: ASSET_INCLUDE,
    orderBy: { assetNumber: "asc" },
  })
}

export async function getAsset(session: SessionContext, id: string) {
  assertCan(session, "inventory.view")
  return db.asset.findFirstOrThrow({
    where: { id, organizationId: session.user.organizationId },
    include: {
      ...ASSET_INCLUDE,
      maintenanceRecords: { orderBy: { serviceDate: "desc" } },
      calibrationRecords: { orderBy: { calibrationDate: "desc" } },
    },
  })
}

export async function createAsset(session: SessionContext, input: AssetInput) {
  assertCan(session, "asset.manage", { branchId: input.branchId })

  const assetNumber = await nextNumber({ organizationId: session.user.organizationId, sequenceType: "AST", prefix: "AST" })
  const created = await db.asset.create({
    data: {
      organizationId: session.user.organizationId,
      branchId: input.branchId,
      departmentId: input.departmentId ?? null,
      roomId: input.roomId ?? null,
      assetNumber,
      barcode: input.barcode ?? null,
      name: input.name,
      category: input.category,
      manufacturer: input.manufacturer ?? null,
      model: input.model ?? null,
      serialNumber: input.serialNumber ?? null,
      assignedEmployeeId: input.assignedEmployeeId ?? null,
      supplierId: input.supplierId ?? null,
      purchaseDate: input.purchaseDate ?? null,
      cost: input.cost != null ? new Decimal(input.cost) : null,
      warrantyExpiryDate: input.warrantyExpiryDate ?? null,
    },
  })
  await auditFromSession(session, "create", "asset", created.id, { new: { assetNumber: created.assetNumber, name: created.name } })
  return created
}

export async function updateAsset(session: SessionContext, id: string, input: AssetInput) {
  assertCan(session, "asset.manage", { branchId: input.branchId })

  const existing = await db.asset.findFirstOrThrow({ where: { id, organizationId: session.user.organizationId } })
  const updated = await db.asset.update({
    where: { id },
    data: {
      branchId: input.branchId,
      departmentId: input.departmentId ?? null,
      roomId: input.roomId ?? null,
      barcode: input.barcode ?? null,
      name: input.name,
      category: input.category,
      manufacturer: input.manufacturer ?? null,
      model: input.model ?? null,
      serialNumber: input.serialNumber ?? null,
      assignedEmployeeId: input.assignedEmployeeId ?? null,
      supplierId: input.supplierId ?? null,
      purchaseDate: input.purchaseDate ?? null,
      cost: input.cost != null ? new Decimal(input.cost) : null,
      warrantyExpiryDate: input.warrantyExpiryDate ?? null,
    },
  })
  await auditFromSession(session, "update", "asset", id, { old: existing, new: input })
  return updated
}

export async function updateAssetStatus(session: SessionContext, id: string, status: string) {
  assertCan(session, "asset.manage")
  const existing = await db.asset.findFirstOrThrow({ where: { id, organizationId: session.user.organizationId } })
  const updated = await db.asset.update({ where: { id }, data: { status: status as never } })
  await auditFromSession(session, "update", "asset", id, { old: { status: existing.status }, new: { status } })
  return updated
}

export async function addMaintenanceRecord(session: SessionContext, assetId: string, input: MaintenanceRecordInput) {
  assertCan(session, "asset.manage")
  const asset = await db.asset.findFirstOrThrow({ where: { id: assetId, organizationId: session.user.organizationId } })

  const created = await db.$transaction(async (tx) => {
    const record = await tx.maintenanceRecord.create({
      data: {
        organizationId: session.user.organizationId,
        assetId: asset.id,
        maintenanceType: input.maintenanceType,
        serviceProvider: input.serviceProvider ?? null,
        cost: input.cost != null ? new Decimal(input.cost) : null,
        workPerformed: input.workPerformed,
        serviceDate: input.serviceDate,
        nextServiceDate: input.nextServiceDate ?? null,
        performedBy: session.user.id,
      },
    })
    if (asset.status !== "retired" && asset.status !== "disposed") {
      await tx.asset.update({ where: { id: asset.id }, data: { status: "available" } })
    }
    return record
  })

  await auditFromSession(session, "create", "maintenance_record", created.id, { new: { assetId: asset.id, maintenanceType: input.maintenanceType } })
  return created
}

export async function addCalibrationRecord(session: SessionContext, assetId: string, input: CalibrationRecordInput) {
  assertCan(session, "asset.manage")
  const asset = await db.asset.findFirstOrThrow({ where: { id: assetId, organizationId: session.user.organizationId } })

  const created = await db.calibrationRecord.create({
    data: {
      organizationId: session.user.organizationId,
      assetId: asset.id,
      calibrationDate: input.calibrationDate,
      certificateNumber: input.certificateNumber ?? null,
      result: input.result,
      provider: input.provider ?? null,
      nextCalibrationDate: input.nextCalibrationDate ?? null,
    },
  })
  await auditFromSession(session, "create", "calibration_record", created.id, { new: { assetId: asset.id, result: input.result } })
  return created
}

/** Every alert computed live from real data — never a stored flag (same discipline as Phase 5's low-stock/near-expiry alerts). */
export async function listAssetAlerts(session: SessionContext) {
  assertCan(session, "inventory.view")
  const horizon = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

  const [warrantyExpiring, calibrationDue] = await Promise.all([
    db.asset.findMany({
      where: { organizationId: session.user.organizationId, warrantyExpiryDate: { not: null, lte: horizon }, status: { notIn: ["retired", "disposed"] } },
      orderBy: { warrantyExpiryDate: "asc" },
    }),
    db.calibrationRecord.findMany({
      where: { organizationId: session.user.organizationId, nextCalibrationDate: { not: null, lte: horizon } },
      include: { asset: true },
      orderBy: { nextCalibrationDate: "asc" },
      distinct: ["assetId"],
    }),
  ])

  return { warrantyExpiring, calibrationDue }
}

/** Assets due (or overdue) for preventive service in the next 30 days — the maintenance counterpart to listAssetAlerts' warranty/calibration alerts, split out since the Management Dashboard (Phase 13) needs it as its own tile. */
export async function listMaintenanceDue(session: SessionContext) {
  assertCan(session, "inventory.view")
  const horizon = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  return db.maintenanceRecord.findMany({
    where: { organizationId: session.user.organizationId, nextServiceDate: { not: null, lte: horizon } },
    include: { asset: true },
    orderBy: { nextServiceDate: "asc" },
    distinct: ["assetId"],
  })
}
