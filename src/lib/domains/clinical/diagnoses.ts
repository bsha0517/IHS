import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { getAuthorizedBranchScope, narrowBranchFilter } from "@/lib/platform/branch-scope"
import type { SessionContext } from "@/lib/auth/session"
import type { DiagnosisInput } from "@/lib/domains/clinical/schemas"

export async function addDiagnosis(session: SessionContext, encounterId: string, input: DiagnosisInput) {
  assertCan(session, "clinical_notes.edit")

  const encounter = await db.encounter.findFirstOrThrow({
    where: { id: encounterId, organizationId: session.user.organizationId },
  })

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
  const before = await db.diagnosis.findFirstOrThrow({
    where: { id: diagnosisId, organizationId: session.user.organizationId },
  })
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

export async function listPatientDiagnoses(session: SessionContext, patientId: string) {
  assertCan(session, "encounter.view")
  const scope = getAuthorizedBranchScope(session)
  return db.diagnosis.findMany({
    where: {
      organizationId: session.user.organizationId,
      patientId,
      ...(scope.isOrgWide ? {} : { encounter: { branchId: narrowBranchFilter(scope) } }),
    },
    include: { code: true, encounter: true },
    orderBy: { diagnosedAt: "desc" },
  })
}

export async function createDiagnosisCode(session: SessionContext, input: { code: string; description: string; category?: string | null }) {
  assertCan(session, "settings.edit")
  const created = await db.diagnosisCode.create({
    data: { code: input.code, description: input.description, category: input.category ?? null },
  })
  await auditFromSession(session, "create", "diagnosis_code", created.code, { new: input })
  return created
}
