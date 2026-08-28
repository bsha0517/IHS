import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { nextNumber } from "@/lib/platform/sequences"
import { getAuthorizedBranchScope, narrowBranchFilter, assertBranchAccess } from "@/lib/platform/branch-scope"
import type { SessionContext } from "@/lib/auth/session"
import type { $Enums } from "@/generated/prisma/client"
import type { EpisodeInput } from "@/lib/domains/clinical/schemas"

/**
 * Org/branch-wide episode list (as opposed to `listPatientEpisodes`, scoped
 * to one patient) — backs the top-level `/episodes` nav destination, which
 * previously had no page at all and fell through to the "coming soon"
 * catch-all despite Episode being a fully-built Phase 3 model. Same
 * search/paginate shape as `listPatients` (patients/service.ts).
 */
export async function listEpisodes(
  session: SessionContext,
  params: { search?: string; status?: $Enums.EpisodeStatus; page?: number } = {}
) {
  assertCan(session, "encounter.view")
  const scope = getAuthorizedBranchScope(session)
  const page = Math.max(1, params.page ?? 1)
  const pageSize = 25
  const search = params.search?.trim()

  const where = {
    organizationId: session.user.organizationId,
    branchId: narrowBranchFilter(scope),
    ...(params.status ? { status: params.status } : {}),
    ...(search
      ? {
          OR: [
            { episodeNumber: { contains: search, mode: "insensitive" as const } },
            { title: { contains: search, mode: "insensitive" as const } },
            { patient: { firstName: { contains: search, mode: "insensitive" as const } } },
            { patient: { lastName: { contains: search, mode: "insensitive" as const } } },
            { patient: { mrn: { contains: search, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  }

  const [episodes, total] = await Promise.all([
    db.episode.findMany({
      where,
      include: { patient: true, primaryProvider: true },
      orderBy: { startDate: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.episode.count({ where }),
  ])

  return { episodes, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) }
}

export async function listPatientEpisodes(session: SessionContext, patientId: string) {
  assertCan(session, "encounter.view")
  const scope = getAuthorizedBranchScope(session)
  return db.episode.findMany({
    where: { organizationId: session.user.organizationId, patientId, branchId: narrowBranchFilter(scope) },
    include: { primaryProvider: true, encounters: { orderBy: { startAt: "desc" } } },
    orderBy: { startDate: "desc" },
  })
}

export async function getEpisode(session: SessionContext, episodeId: string) {
  assertCan(session, "encounter.view")
  const episode = await db.episode.findFirstOrThrow({
    where: { id: episodeId, organizationId: session.user.organizationId },
    include: {
      primaryProvider: true,
      patient: true,
      encounters: { include: { provider: true }, orderBy: { startAt: "desc" } },
      diagnoses: { include: { code: true }, orderBy: { diagnosedAt: "desc" } },
    },
  })
  assertBranchAccess(getAuthorizedBranchScope(session), episode.branchId)
  return episode
}

export async function createEpisode(session: SessionContext, input: EpisodeInput) {
  assertCan(session, "encounter.create", { branchId: input.branchId })

  const episode = await db.$transaction(async (tx) => {
    const episodeNumber = await nextNumber({
      organizationId: session.user.organizationId,
      sequenceType: "EPS",
      prefix: "EPS",
    })
    return tx.episode.create({
      data: {
        organizationId: session.user.organizationId,
        branchId: input.branchId,
        patientId: input.patientId,
        episodeNumber,
        episodeType: input.episodeType,
        title: input.title,
        description: input.description ?? null,
        startDate: input.startDate,
        primaryProviderId: input.primaryProviderId ?? null,
        createdBy: session.user.id,
      },
    })
  })

  await auditFromSession(session, "create", "episode", episode.id, {
    new: { episodeNumber: episode.episodeNumber, title: episode.title },
  })

  return episode
}

export async function updateEpisodeStatus(
  session: SessionContext,
  episodeId: string,
  status: "open" | "active" | "completed" | "cancelled"
) {
  assertCan(session, "encounter.create")
  const before = await db.episode.findFirstOrThrow({
    where: { id: episodeId, organizationId: session.user.organizationId },
  })
  const updated = await db.episode.update({
    where: { id: episodeId },
    data: { status, endDate: status === "completed" || status === "cancelled" ? new Date() : undefined },
  })
  await auditFromSession(session, "update", "episode", episodeId, { old: before, new: updated })
  return updated
}
