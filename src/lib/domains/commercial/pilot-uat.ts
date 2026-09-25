import "server-only"
import { db } from "@/lib/db"
import { writeAuditLog } from "@/lib/platform/audit"
import type { $Enums } from "@/generated/prisma/client"

/**
 * P5.2 §11/§13: a lightweight, repeatable pilot-UAT record — not a
 * regulatory certification and not a clinical claim about the product (see
 * this file's own callers in the platform UI for the explicit copy that
 * says so). `PilotUat` is one test cycle; `PilotUatScenario` rows are its
 * per-checklist-item pass/fail detail, matching §11's own Reception/Doctor/
 * Inventory/Billing/Finance/clinical/multi-user/multi-branch/security areas.
 *
 * Every function takes `operatorId` as an explicit parameter rather than
 * resolving it internally via `requirePlatformOperator()` — see
 * `onboarding-checklist.ts`'s own doc comment for why (testability;
 * `requirePlatformOperator()` needs Next's request-scoped `cookies()` and
 * cannot run in an integration test). The Server Action caller resolves the
 * real, cookie-verified operator first and passes its id through.
 */

export type CreatePilotUatInput = {
  organizationId: string
  cycleLabel: string
  testerName: string
}

export async function createPilotUat(operatorId: string, input: CreatePilotUatInput) {
  const uat = await db.pilotUat.create({
    data: { organizationId: input.organizationId, cycleLabel: input.cycleLabel, testerName: input.testerName, startedAt: new Date() },
  })
  await writeAuditLog({
    organizationId: input.organizationId,
    userId: operatorId,
    action: "platform.uat.created",
    entityType: "pilot_uat",
    entityId: uat.id,
    newValues: { cycleLabel: input.cycleLabel },
  })
  return uat
}

export async function listPilotUats(organizationId: string) {
  return db.pilotUat.findMany({
    where: { organizationId },
    include: { scenarios: { orderBy: { createdAt: "asc" } } },
    orderBy: { createdAt: "desc" },
  })
}

export async function getPilotUat(uatId: string) {
  return db.pilotUat.findUniqueOrThrow({ where: { id: uatId }, include: { scenarios: { orderBy: { createdAt: "asc" } } } })
}

export type RecordUatScenarioInput = { area: string; scenario: string; passed: boolean | null; notes?: string | null }

export async function recordUatScenario(uatId: string, input: RecordUatScenarioInput) {
  // 404s cleanly on a bad uatId rather than surfacing a raw FK error below —
  // organizationId isn't a column on this table (reachable only via its
  // parent PilotUat).
  await db.pilotUat.findUniqueOrThrow({ where: { id: uatId } })
  return db.pilotUatScenario.create({
    data: { uatId, area: input.area, scenario: input.scenario, passed: input.passed, notes: input.notes ?? null },
  })
}

export type CompletePilotUatInput = { result: $Enums.PilotUatResultStatus; blockers?: string | null; notes?: string | null }

/** §13: recording a signoff is an explicit, separate step from merely setting `result` — `signedOffAt` is the durable proof a human actually reviewed and accepted this cycle's outcome. */
export async function completePilotUat(uatId: string, operatorId: string, input: CompletePilotUatInput, signOff: boolean) {
  const before = await db.pilotUat.findUniqueOrThrow({ where: { id: uatId } })

  const updated = await db.pilotUat.update({
    where: { id: uatId },
    data: {
      result: input.result,
      blockers: input.blockers ?? null,
      notes: input.notes ?? null,
      completedAt: new Date(),
      signedOffByOperatorId: signOff ? operatorId : before.signedOffByOperatorId,
      signedOffAt: signOff ? new Date() : before.signedOffAt,
    },
  })

  await writeAuditLog({
    organizationId: before.organizationId,
    userId: operatorId,
    action: "platform.uat.completed",
    entityType: "pilot_uat",
    entityId: updated.id,
    oldValues: { result: before.result },
    newValues: { result: updated.result, signedOff: signOff },
  })
  return updated
}
