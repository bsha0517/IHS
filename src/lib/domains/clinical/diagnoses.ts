import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { writeClinicalAccessLog } from "@/lib/platform/access-log"
import { getAuthorizedBranchScope, narrowBranchFilter, assertBranchAccess } from "@/lib/platform/branch-scope"
import type { SessionContext } from "@/lib/auth/session"
import type { DiagnosisInput } from "@/lib/domains/clinical/schemas"

export async function addDiagnosis(session: SessionContext, encounterId: string, input: DiagnosisInput) {
  assertCan(session, "clinical_notes.edit")

  // P3.3 §33: see clinical/vitals.ts's comment — `findFirstOrThrow` leaked
  // a raw Prisma message for a stale/invalid encounterId.
  const encounter = await db.encounter.findFirst({
    where: { id: encounterId, organizationId: session.user.organizationId },
  })
  if (!encounter) throw new Error("This encounter no longer exists or is not accessible.")
  // P3.3 §34: same branch-write gap fixed across every encounter-scoped
  // write this batch touched — see vitals.ts's comment for the full
  // reasoning.
  assertBranchAccess(getAuthorizedBranchScope(session), encounter.branchId)

  const diagnosis = await db.diagnosis.create({
    data: {
      organizationId: session.user.organizationId,
      patientId: encounter.patientId,
      encounterId,
      episodeId: encounter.episodeId,
      diagnosisCode: input.diagnosisCode ?? null,
      description: input.description,
      isPrimary: input.isPrimary,
      diagnosedBy: session.user.id,
    },
  })

  await auditFromSession(session, "create", "diagnosis", diagnosis.id, { new: input })
  return diagnosis
}

export async function updateDiagnosisStatus(
  session: SessionContext,
  diagnosisId: string,
  status: "active" | "resolved" | "ruled_out"
) {
  assertCan(session, "clinical_notes.edit")
  // Targeted backlog closure, item 6 (BACKLOG.md's "secondary fetch-before-
  // update lookups still use findFirstOrThrow") — same findFirst + friendly
  // Error pattern P3.3 already established for the primary encounter lookup.
  const before = await db.diagnosis.findFirst({
    where: { id: diagnosisId, organizationId: session.user.organizationId },
    include: { encounter: { select: { branchId: true } } },
  })
  if (!before) throw new Error("This diagnosis no longer exists or is not accessible.")
  assertBranchAccess(getAuthorizedBranchScope(session), before.encounter.branchId)
  const updated = await db.diagnosis.update({ where: { id: diagnosisId }, data: { status } })
  await auditFromSession(session, "update", "diagnosis", diagnosisId, { old: before, new: updated })
  return updated
}

export async function searchDiagnosisCodes(query: string) {
  if (!query.trim()) return []
  return db.diagnosisCode.findMany({
    where: {
      isActive: true,
      OR: [
        { code: { contains: query, mode: "insensitive" } },
        { description: { contains: query, mode: "insensitive" } },
      ],
    },
    take: 10,
    orderBy: { code: "asc" },
  })
}

/** P2 §7: a patient's diagnosis/problem list — real chart content, not a trivial index. */
export async function listPatientDiagnoses(session: SessionContext, patientId: string) {
  assertCan(session, "encounter.view")
  const scope = getAuthorizedBranchScope(session)
  const diagnoses = await db.diagnosis.findMany({
    where: {
      organizationId: session.user.organizationId,
      patientId,
      ...(scope.isOrgWide ? {} : { encounter: { branchId: narrowBranchFilter(scope) } }),
    },
    // P3.2 §13/§20: `encounter: true` here was never read by any caller —
    // Patient 360's Diagnoses tab only needs `encounterId` to link back to
    // the encounter (the scalar FK, already present on every row without an
    // include), not the full Encounter record. Dropped the unused include.
    include: { code: true },
    orderBy: { diagnosedAt: "desc" },
  })
  await writeClinicalAccessLog({ session, patientId, resourceType: "diagnoses", action: "view" })
  return diagnoses
}

export async function createDiagnosisCode(session: SessionContext, input: { code: string; description: string; category?: string | null }) {
  assertCan(session, "settings.edit")
  const created = await db.diagnosisCode.create({
    data: { code: input.code, description: input.description, category: input.category ?? null },
  })
  await auditFromSession(session, "create", "diagnosis_code", created.code, { new: input })
  return created
}
