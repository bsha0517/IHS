import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { Prisma } from "@/generated/prisma/client"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { nextNumber } from "@/lib/platform/sequences"
import { postAssetAcquired } from "@/lib/domains/accounting/posting-service"
import { getAuthorizedBranchScope, narrowBranchFilter, assertBranchAccess } from "@/lib/platform/branch-scope"
import { resolvePage, paginationSkipTake, totalPages } from "@/lib/platform/pagination"
import type { SessionContext } from "@/lib/auth/session"
import type { AssetInput, MaintenanceRecordInput, CalibrationRecordInput } from "@/lib/domains/assets/schemas"

const ASSET_INCLUDE = { branch: true, department: true, room: true, assignedEmployee: true, supplier: true } as const
const ASSET_LIST_PAGE_SIZE = 50

/** P2 §8: was fully unbounded (no `take` at all). Real server-side pagination now. */
export async function listAssets(session: SessionContext, filters: { branchId?: string; status?: string; category?: string; page?: number } = {}) {
  assertCan(session, "inventory.view")
  const scope = getAuthorizedBranchScope(session)
  const page = resolvePage(filters.page)
  const where: Prisma.AssetWhereInput = {
    organizationId: session.user.organizationId,
    branchId: narrowBranchFilter(scope, filters.branchId),
    status: filters.status as never,
    category: filters.category,
  }
  const [assets, total] = await Promise.all([
    db.asset.findMany({
      where,
      include: ASSET_INCLUDE,
      orderBy: { assetNumber: "asc" },
      ...paginationSkipTake(page, ASSET_LIST_PAGE_SIZE),
    }),
    db.asset.count({ where }),
  ])
  return { assets, total, page, pageSize: ASSET_LIST_PAGE_SIZE, totalPages: totalPages(total, ASSET_LIST_PAGE_SIZE) }
}

export async function getAsset(session: SessionContext, id: string) {
  assertCan(session, "inventory.view")
  const asset = await db.asset.findFirstOrThrow({
    where: { id, organizationId: session.user.organizationId },
    include: {
      ...ASSET_INCLUDE,
      maintenanceRecords: { orderBy: { serviceDate: "desc" } },
      calibrationRecords: { orderBy: { calibrationDate: "desc" } },
    },
  })
  assertBranchAccess(getAuthorizedBranchScope(session), asset.branchId)
  return asset
}

/**
 * P1 §17: when `cost` is given, this posts synchronously in the same
 * transaction as the Asset row (Dr Fixed Asset, not ordinary Inventory
 * Expense — see postAssetAcquired's doc comment) — the same
 * immediate-confirmation reasoning as createExpense (accounting/expenses.ts).
 * A cost-less asset record (e.g. a donated or pre-owned item entered for
 * tracking only) posts nothing, matching postExpense/postGoodsReceiptCompleted's
 * own "nothing to post" guards for a zero amount.
 */
export async function createAsset(session: SessionContext, input: AssetInput) {
  assertCan(session, "asset.manage", { branchId: input.branchId })

  const assetNumber = await nextNumber({ organizationId: session.user.organizationId, sequenceType: "AST", prefix: "AST" })
  const created = await db.$transaction(async (tx) => {
    const asset = await tx.asset.create({
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
        paidVia: input.paidVia ?? null,
        warrantyExpiryDate: input.warrantyExpiryDate ?? null,
      },
    })

    if (input.cost != null && input.cost > 0) {
      await postAssetAcquired(tx, {
        organizationId: session.user.organizationId,
        branchId: input.branchId,
        assetId: asset.id,
        amount: input.cost,
        paidVia: input.paidVia ?? null,
        description: `Asset acquired — ${asset.name} (${asset.assetNumber})`,
        postedBy: session.user.id,
      })
    }

    return asset
  }, { timeout: 20_000, maxWait: 10_000 }) // widened for the same reason posting-service.ts's POSTING_TRANSACTION_OPTIONS is — postAssetAcquired does real sequential work (resolveAccountId x2, nextNumber, postJournal) on top of the asset create itself, and Prisma's 5000ms default proved too tight under this environment's real Supabase pooler latency (surfaced by a real P2028 timeout in this batch's own full-suite run, not a defensive guess)
  await auditFromSession(session, "create", "asset", created.id, { new: { assetNumber: created.assetNumber, name: created.name, cost: input.cost ?? null } })
  return created
}

/**
 * Deliberately does NOT re-post to accounting even if `cost` changes —
 * postAssetAcquired only ever fires once, from createAsset, matching
 * spec's "asset purchases post to a fixed asset account" as an
 * acquisition-time event, not a correction/revaluation flow (which this
 * batch's scope doesn't cover — see PROJECT_STATUS.md if a future phase
 * adds cost corrections).
 */
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
      paidVia: input.paidVia ?? null,
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
  const scope = getAuthorizedBranchScope(session)
  const horizon = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

  const [warrantyExpiring, calibrationDue] = await Promise.all([
    db.asset.findMany({
      where: {
        organizationId: session.user.organizationId,
        branchId: narrowBranchFilter(scope),
        warrantyExpiryDate: { not: null, lte: horizon },
        status: { notIn: ["retired", "disposed"] },
      },
      orderBy: { warrantyExpiryDate: "asc" },
    }),
    db.calibrationRecord.findMany({
      where: {
        organizationId: session.user.organizationId,
        nextCalibrationDate: { not: null, lte: horizon },
        asset: { branchId: narrowBranchFilter(scope) },
      },
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
  const scope = getAuthorizedBranchScope(session)
  const horizon = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  return db.maintenanceRecord.findMany({
    where: {
      organizationId: session.user.organizationId,
      nextServiceDate: { not: null, lte: horizon },
      asset: { branchId: narrowBranchFilter(scope) },
    },
    include: { asset: true },
    orderBy: { nextServiceDate: "asc" },
    distinct: ["assetId"],
  })
}
