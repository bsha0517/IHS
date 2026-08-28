import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { getAuthorizedBranchScope, narrowBranchFilter } from "@/lib/platform/branch-scope"
import type { SessionContext } from "@/lib/auth/session"
import type { VitalSignInput } from "@/lib/domains/clinical/schemas"

function computeBmi(heightCm?: number | null, weightKg?: number | null): number | null {
  if (!heightCm || !weightKg || heightCm <= 0) return null
  const heightM = heightCm / 100
  return Math.round((weightKg / (heightM * heightM)) * 10) / 10
}

export async function recordVitals(session: SessionContext, encounterId: string, input: VitalSignInput) {
  assertCan(session, "vitals.record")

  const encounter = await db.encounter.findFirstOrThrow({
    where: { id: encounterId, organizationId: session.user.organizationId },
  })

  const vitals = await db.vitalSign.create({
    data: {
      organizationId: session.user.organizationId,
      patientId: encounter.patientId,
      encounterId,
      branchId: encounter.branchId,
      recordedBy: session.user.id,
      heightCm: input.heightCm ?? null,
      weightKg: input.weightKg ?? null,
      bmi: computeBmi(input.heightCm, input.weightKg),
      bloodPressureSystolic: input.bloodPressureSystolic ?? null,
      bloodPressureDiastolic: input.bloodPressureDiastolic ?? null,
      pulseBpm: input.pulseBpm ?? null,
      temperatureCelsius: input.temperatureCelsius ?? null,
      oxygenSaturationPercent: input.oxygenSaturationPercent ?? null,
      respiratoryRatePerMin: input.respiratoryRatePerMin ?? null,
      bloodGlucoseMgDl: input.bloodGlucoseMgDl ?? null,
    },
  })

  await auditFromSession(session, "create", "vital_sign", vitals.id, { new: input })
  return vitals
}

export async function listPatientVitals(session: SessionContext, patientId: string) {
  assertCan(session, "encounter.view")
  const scope = getAuthorizedBranchScope(session)
  return db.vitalSign.findMany({
    where: { organizationId: session.user.organizationId, patientId, branchId: narrowBranchFilter(scope) },
    orderBy: { recordedAt: "desc" },
  })
}
