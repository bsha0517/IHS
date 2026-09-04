import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { writeClinicalAccessLog } from "@/lib/platform/access-log"
import { getAuthorizedBranchScope, narrowBranchFilter, assertBranchAccess } from "@/lib/platform/branch-scope"
import type { SessionContext } from "@/lib/auth/session"
import type { VitalSignInput } from "@/lib/domains/clinical/schemas"

function computeBmi(heightCm?: number | null, weightKg?: number | null): number | null {
  if (!heightCm || !weightKg || heightCm <= 0) return null
  const heightM = heightCm / 100
  return Math.round((weightKg / (heightM * heightM)) * 10) / 10
}

export async function recordVitals(session: SessionContext, encounterId: string, input: VitalSignInput) {
  assertCan(session, "vitals.record")

  // P3.3 §33: `findFirstOrThrow` throws Prisma's own raw "Invalid
  // `db.encounter.findFirstOrThrow()` invocation... No record was found"
  // message, which action.ts's generic `e.message` catch then displayed
  // verbatim to the doctor for a stale/invalid encounterId — exactly the
  // "stale encounter state" case this section names. Same fix already
  // applied to startEncounter's own appointment lookup.
  const encounter = await db.encounter.findFirst({
    where: { id: encounterId, organizationId: session.user.organizationId },
  })
  if (!encounter) throw new Error("This encounter no longer exists or is not accessible.")
  // P3.3 §34: this write path checked org membership but never branch
  // access — a session with `vitals.record` and any encounterId from the
  // same org (any branch) could write to it. `getEncounter` (the read used
  // to open the encounter workspace) already enforces this; every write
  // path reachable from inside it must too, not just implicitly rely on the
  // page having been branch-checked on load. Same pattern P2 already
  // established for the prescription/follow-up leak this section warns
  // against reintroducing.
  assertBranchAccess(getAuthorizedBranchScope(session), encounter.branchId)

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

/** P2 §7: a patient's vitals history — real chart content, previously unlogged. */
export async function listPatientVitals(session: SessionContext, patientId: string) {
  assertCan(session, "encounter.view")
  const scope = getAuthorizedBranchScope(session)
  const vitals = await db.vitalSign.findMany({
    where: { organizationId: session.user.organizationId, patientId, branchId: narrowBranchFilter(scope) },
    // P3.4 §3/§21: closes the P3.3 vitals-attribution backlog item on
    // Patient 360 too, matching the same small select added to the
    // encounter workspace's own vitals include.
    include: { recordedByUser: { select: { firstName: true, lastName: true } } },
    orderBy: { recordedAt: "desc" },
  })
  await writeClinicalAccessLog({ session, patientId, resourceType: "vital_signs", action: "view" })
  return vitals
}
