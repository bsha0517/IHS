import { z } from "zod"

const emptyToNull = (v: unknown) => (v === "" ? null : v)

export const assetStatuses = ["available", "in_use", "maintenance", "damaged", "lost", "retired", "disposed"] as const

export const assetSchema = z.object({
  branchId: z.uuid(),
  departmentId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
  roomId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
  barcode: z.preprocess(emptyToNull, z.string().max(100).nullable().optional()),
  name: z.string().min(1).max(200),
  category: z.string().min(1).max(100),
  manufacturer: z.preprocess(emptyToNull, z.string().max(200).nullable().optional()),
  model: z.preprocess(emptyToNull, z.string().max(200).nullable().optional()),
  serialNumber: z.preprocess(emptyToNull, z.string().max(200).nullable().optional()),
  assignedEmployeeId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
  supplierId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
  purchaseDate: z.preprocess(emptyToNull, z.coerce.date().nullable().optional()),
  cost: z.preprocess(emptyToNull, z.coerce.number().min(0).max(9999999).nullable().optional()),
  // P1 §17: how the acquisition was paid — set, posts Dr Fixed Asset / Cr
  // this tender's account; left null, Dr Fixed Asset / Cr Accounts Payable
  // (acquired on credit). See postAssetAcquired (posting-service.ts).
  paidVia: z.preprocess(emptyToNull, z.enum(["cash", "card", "bank", "online", "insurance", "credit", "other"]).nullable().optional()),
  warrantyExpiryDate: z.preprocess(emptyToNull, z.coerce.date().nullable().optional()),
})
export type AssetInput = z.infer<typeof assetSchema>

export const assetStatusSchema = z.object({
  status: z.enum(assetStatuses),
})

export const maintenanceTypes = ["preventive", "corrective"] as const

export const maintenanceRecordSchema = z.object({
  maintenanceType: z.enum(maintenanceTypes),
  serviceProvider: z.preprocess(emptyToNull, z.string().max(200).nullable().optional()),
  cost: z.preprocess(emptyToNull, z.coerce.number().min(0).max(9999999).nullable().optional()),
  workPerformed: z.string().min(1).max(1000),
  serviceDate: z.coerce.date(),
  nextServiceDate: z.preprocess(emptyToNull, z.coerce.date().nullable().optional()),
})
export type MaintenanceRecordInput = z.infer<typeof maintenanceRecordSchema>

export const calibrationResults = ["pass", "fail", "conditional"] as const

export const calibrationRecordSchema = z.object({
  calibrationDate: z.coerce.date(),
  certificateNumber: z.preprocess(emptyToNull, z.string().max(100).nullable().optional()),
  result: z.enum(calibrationResults),
  provider: z.preprocess(emptyToNull, z.string().max(200).nullable().optional()),
  nextCalibrationDate: z.preprocess(emptyToNull, z.coerce.date().nullable().optional()),
})
export type CalibrationRecordInput = z.infer<typeof calibrationRecordSchema>
