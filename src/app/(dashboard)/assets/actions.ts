"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import { assertModuleEnabled } from "@/lib/platform/entitlements"
import { createAsset, updateAsset, updateAssetStatus, addMaintenanceRecord, addCalibrationRecord } from "@/lib/domains/assets/assets"
import { assetSchema, maintenanceRecordSchema, calibrationRecordSchema } from "@/lib/domains/assets/schemas"

export type ActionState = { error?: string; success?: boolean }

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  await assertModuleEnabled(session.user.organizationId, "assets")
  return session
}

function readAssetForm(formData: FormData) {
  return assetSchema.safeParse({
    branchId: formData.get("branchId"),
    departmentId: formData.get("departmentId"),
    roomId: formData.get("roomId"),
    barcode: formData.get("barcode"),
    name: formData.get("name"),
    category: formData.get("category"),
    manufacturer: formData.get("manufacturer"),
    model: formData.get("model"),
    serialNumber: formData.get("serialNumber"),
    assignedEmployeeId: formData.get("assignedEmployeeId"),
    supplierId: formData.get("supplierId"),
    purchaseDate: formData.get("purchaseDate"),
    cost: formData.get("cost"),
    paidVia: formData.get("paidVia"),
    warrantyExpiryDate: formData.get("warrantyExpiryDate"),
  })
}

export async function createAssetAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = readAssetForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    const session = await requireSession()
    await createAsset(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create asset." }
  }
  revalidatePath("/assets")
  return { success: true }
}

export async function updateAssetAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const assetId = String(formData.get("assetId") ?? "")
  const parsed = readAssetForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    const session = await requireSession()
    await updateAsset(session, assetId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update asset." }
  }
  revalidatePath("/assets")
  revalidatePath(`/assets/${assetId}`)
  return { success: true }
}

export async function updateAssetStatusAction(assetId: string, status: string) {
  const session = await requireSession()
  await updateAssetStatus(session, assetId, status)
  revalidatePath(`/assets/${assetId}`)
}

export async function addMaintenanceRecordAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const assetId = String(formData.get("assetId") ?? "")
  const parsed = maintenanceRecordSchema.safeParse({
    maintenanceType: formData.get("maintenanceType"),
    serviceProvider: formData.get("serviceProvider"),
    cost: formData.get("cost"),
    workPerformed: formData.get("workPerformed"),
    serviceDate: formData.get("serviceDate"),
    nextServiceDate: formData.get("nextServiceDate"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    const session = await requireSession()
    await addMaintenanceRecord(session, assetId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to add maintenance record." }
  }
  revalidatePath(`/assets/${assetId}`)
  return { success: true }
}

export async function addCalibrationRecordAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const assetId = String(formData.get("assetId") ?? "")
  const parsed = calibrationRecordSchema.safeParse({
    calibrationDate: formData.get("calibrationDate"),
    certificateNumber: formData.get("certificateNumber"),
    result: formData.get("result"),
    provider: formData.get("provider"),
    nextCalibrationDate: formData.get("nextCalibrationDate"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    const session = await requireSession()
    await addCalibrationRecord(session, assetId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to add calibration record." }
  }
  revalidatePath(`/assets/${assetId}`)
  return { success: true }
}
