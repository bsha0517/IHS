import "server-only"
import { db } from "@/lib/db"
import type { SessionContext } from "@/lib/auth/session"

/**
 * The read-audit counterpart to audit.ts (spec.md §63) — distinct from audit_log,
 * distinct permission gate (audit.review), insert-only. No clinical screens exist
 * yet (Phase 2+), but the write path is established from Phase 1 so every future
 * chart/encounter/result view goes through this from day one rather than being
 * retrofitted later. patient_id has no FK until the `patient` table lands in
 * Phase 2 (see prisma/schema.prisma comment on ClinicalAccessLog).
 */
export async function writeClinicalAccessLog(input: {
  session: SessionContext
  patientId: string
  resourceType: string
  resourceId?: string | null
  action: "view" | "print" | "export"
}): Promise<void> {
  await db.clinicalAccessLog.create({
    data: {
      organizationId: input.session.user.organizationId,
      userId: input.session.user.id,
      patientId: input.patientId,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      action: input.action,
    },
  })
}
