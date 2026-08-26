import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { nextNumber } from "@/lib/platform/sequences"
import type { SessionContext } from "@/lib/auth/session"
import type { EpisodeInput } from "@/lib/domains/clinical/schemas"

export async function listPatientEpisodes(session: SessionContext, patientId: string) {
  assertCan(session, "encounter.view")
  return db.episode.findMany({
    where: { organizationId: session.user.organizationId, patientId },
    include: { primaryProvider: true, encounters: { orderBy: { startAt: "desc" } } },
    orderBy: { startDate: "desc" },
  })
}

export async function getEpisode(session: SessionContext, episodeId: string) {
  assertCan(session, "encounter.view")
  return db.episode.findFirstOrThrow({
    where: { id: episodeId, organizationId: session.user.organizationId },
    include: {
      primaryProvider: true,
      patient: true,
      encounters: { include: { provider: true }, orderBy: { startAt: "desc" } },
      diagnoses: { include: { code: true }, orderBy: { diagnosedAt: "desc" } },
    },
  })
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
