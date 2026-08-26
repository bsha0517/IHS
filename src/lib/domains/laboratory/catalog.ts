import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import type { SessionContext } from "@/lib/auth/session"
import type { LabTestInput, LabPanelInput } from "@/lib/domains/laboratory/schemas"

export async function listLabTests(session: SessionContext) {
  assertCan(session, "lab_result.enter")
  return db.labTest.findMany({
    where: { organizationId: session.user.organizationId, isActive: true },
    orderBy: [{ category: "asc" }, { name: "asc" }],
  })
}

export async function createLabTest(session: SessionContext, input: LabTestInput) {
  assertCan(session, "lab_test.manage")
  const created = await db.labTest.create({
    data: {
      organizationId: session.user.organizationId,
      code: input.code,
      name: input.name,
      category: input.category,
      specimenType: input.specimenType,
      resultType: input.resultType,
      unit: input.unit ?? null,
      referenceRangeLow: input.referenceRangeLow != null ? new Decimal(input.referenceRangeLow) : null,
      referenceRangeHigh: input.referenceRangeHigh != null ? new Decimal(input.referenceRangeHigh) : null,
      referenceRangeText: input.referenceRangeText ?? null,
      price: new Decimal(input.price),
      turnaroundHours: input.turnaroundHours ?? null,
    },
  })
  await auditFromSession(session, "create", "lab_test", created.id, { new: { code: created.code, name: created.name } })
  return created
}

export async function updateLabTest(session: SessionContext, id: string, input: LabTestInput) {
  assertCan(session, "lab_test.manage")
  const existing = await db.labTest.findFirstOrThrow({ where: { id, organizationId: session.user.organizationId } })
  const updated = await db.labTest.update({
    where: { id },
    data: {
      code: input.code,
      name: input.name,
      category: input.category,
      specimenType: input.specimenType,
      resultType: input.resultType,
      unit: input.unit ?? null,
      referenceRangeLow: input.referenceRangeLow != null ? new Decimal(input.referenceRangeLow) : null,
      referenceRangeHigh: input.referenceRangeHigh != null ? new Decimal(input.referenceRangeHigh) : null,
      referenceRangeText: input.referenceRangeText ?? null,
      price: new Decimal(input.price),
      turnaroundHours: input.turnaroundHours ?? null,
    },
  })
  await auditFromSession(session, "update", "lab_test", id, { old: existing, new: input })
  return updated
}

export async function deactivateLabTest(session: SessionContext, id: string) {
  assertCan(session, "lab_test.manage")
  const updated = await db.labTest.update({ where: { id }, data: { isActive: false } })
  await auditFromSession(session, "update", "lab_test", id, { new: { isActive: false } })
  return updated
}

export async function listLabPanels(session: SessionContext) {
  assertCan(session, "lab_result.enter")
  return db.labPanel.findMany({
    where: { organizationId: session.user.organizationId, isActive: true },
    include: { tests: { include: { labTest: true } } },
    orderBy: { name: "asc" },
  })
}

export async function createLabPanel(session: SessionContext, input: LabPanelInput) {
  assertCan(session, "lab_test.manage")
  const created = await db.$transaction(async (tx) => {
    const panel = await tx.labPanel.create({
      data: {
        organizationId: session.user.organizationId,
        code: input.code,
        name: input.name,
        price: new Decimal(input.price),
      },
    })
    await tx.labPanelTest.createMany({ data: input.testIds.map((labTestId) => ({ labPanelId: panel.id, labTestId })) })
    return panel
  })
  await auditFromSession(session, "create", "lab_panel", created.id, { new: { code: created.code, name: created.name } })
  return created
}

export async function deactivateLabPanel(session: SessionContext, id: string) {
  assertCan(session, "lab_test.manage")
  const updated = await db.labPanel.update({ where: { id }, data: { isActive: false } })
  await auditFromSession(session, "update", "lab_panel", id, { new: { isActive: false } })
  return updated
}
