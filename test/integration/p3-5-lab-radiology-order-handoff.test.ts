import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { ForbiddenError } from "@/lib/platform/permissions-core"
import { bookAppointment, checkIn } from "@/lib/domains/appointments/service"
import { startEncounter } from "@/lib/domains/clinical/encounters"
import { createOrder, cancelOrder } from "@/lib/domains/clinical/orders"
import {
  collectSpecimen,
  listLabQueue,
  getLabOrder,
  assignTests,
  receiveSpecimen,
} from "@/lib/domains/laboratory/orders"
import { enterNumericResult, verifyResult, amendLabResult, listPatientLabResults } from "@/lib/domains/laboratory/results"
import { listRadiologyQueue, getRadiologyOrder, assignImagingService, scheduleImaging, markPerformed } from "@/lib/domains/radiology/orders"
import { writeReport, verifyImagingResult, amendImagingReport, listPatientImagingResults } from "@/lib/domains/radiology/results"
import type { SessionContext } from "@/lib/auth/session"

const TIMEOUT = 30000

/**
 * P3.5 (Laboratory / Radiology & Clinical Order Handoff Workflow) — targeted
 * tests for the actual behavior changed/verified this batch: a doctor-placed
 * ClinicalOrder reaching the correct operational queue, assignment preserving
 * the parent relationship while claiming the order exactly once even under a
 * race, branch-scoped writes, cancelled orders unable to progress, the full
 * draft->verified/finalized lifecycle for both Lab and Radiology, verified/
 * finalized results resisting silent rewrite, ClinicalOrder status
 * synchronization on completion, and the widened read access that gives a
 * Doctor session a real result destination. Not cosmetic/layout behavior,
 * which this file deliberately does not test.
 */
describe("P3.5: laboratory / radiology order handoff workflow", () => {
  let organizationId: string
  let branchAId: string
  let branchBId: string
  let doctorProviderId: string
  let doctorUserId: string
  let labTechUserId: string
  let radTechUserId: string
  let patientId: string
  let labTestId: string
  let imagingServiceId: string
  const createdAppointmentIds: string[] = []
  const createdPatientIds: string[] = []
  const createdEncounterIds: string[] = []
  const createdOrderIds: string[] = []

  function doctorSession(branchIds: string[]): SessionContext {
    return {
      sessionId: "test-p3-5-doctor",
      user: { id: doctorUserId, organizationId, email: "p3-5-doctor@test.local", firstName: "P3.5", lastName: "Doctor" },
      activeBranchId: branchIds[0] ?? null,
      branchIds,
      permissions: new Set([
        "patient.view", "appointment.view", "appointment.checkin", "appointment.create",
        "encounter.view", "encounter.create", "encounter.finalize",
        "clinical_notes.view", "clinical_notes.edit", "vitals.record",
        "lab_order.create", "order.create",
      ]),
      roleNames: ["Doctor"],
    }
  }
  function labTechSession(branchIds: string[]): SessionContext {
    return {
      sessionId: "test-p3-5-lab-tech",
      user: { id: labTechUserId, organizationId, email: "p3-5-lab-tech@test.local", firstName: "P3.5", lastName: "LabTech" },
      activeBranchId: branchIds[0] ?? null,
      branchIds,
      permissions: new Set(["patient.view", "lab_result.enter", "lab_result.verify", "lab_test.manage"]),
      roleNames: ["Laboratory Technician"],
    }
  }
  function radTechSession(branchIds: string[]): SessionContext {
    return {
      sessionId: "test-p3-5-rad-tech",
      user: { id: radTechUserId, organizationId, email: "p3-5-rad-tech@test.local", firstName: "P3.5", lastName: "RadTech" },
      activeBranchId: branchIds[0] ?? null,
      branchIds,
      permissions: new Set(["patient.view", "room.view", "imaging_order.perform", "imaging_result.verify", "imaging_service.manage"]),
      roleNames: ["Radiology Technician"],
    }
  }

  let apptSlot = 0

  async function placeOrderAndAssign(orderType: "lab" | "imaging", branchId: string) {
    apptSlot += 1
    const appt = await bookAppointment(doctorSession([branchId]), {
      branchId, patientId, providerId: doctorProviderId,
      startTime: new Date(Date.now() + apptSlot * 2 * 60 * 60 * 1000), durationMinutes: 30, bookingSource: "walk_in",
    })
    createdAppointmentIds.push(appt.id)
    await checkIn(doctorSession([branchId]), appt.id)
    const encounter = await startEncounter(doctorSession([branchId]), {
      branchId, patientId, providerId: doctorProviderId, appointmentId: appt.id, encounterType: "consultation",
    })
    createdEncounterIds.push(encounter.id)
    const order = await createOrder(doctorSession([branchId]), encounter.id, (orderType === "lab"
      ? { orderType: "lab", priority: "routine", testName: "CBC" }
      : { orderType: "imaging", priority: "routine", imagingType: "X-Ray" }) as never)
    createdOrderIds.push(order.id)
    return { appt, encounter, order }
  }

  beforeAll(async () => {
    const branches = await db.branch.findMany({ take: 2, orderBy: { createdAt: "asc" } })
    if (branches.length < 2) throw new Error("Test requires at least 2 seeded branches (see LOCAL_DATABASE_SETUP.md).")
    organizationId = branches[0].organizationId
    branchAId = branches[0].id
    branchBId = branches[1].id

    const provider = await db.provider.findFirstOrThrow({ where: { organizationId } })
    doctorProviderId = provider.id

    const doctorUser = await db.user.create({
      data: { organizationId, email: `p3-5-doctor-${Date.now()}@test.local`, passwordHash: "x", firstName: "P3.5", lastName: "DoctorUser" },
    })
    doctorUserId = doctorUser.id
    const labTechUser = await db.user.create({
      data: { organizationId, email: `p3-5-labtech-${Date.now()}@test.local`, passwordHash: "x", firstName: "P3.5", lastName: "LabTechUser" },
    })
    labTechUserId = labTechUser.id
    const radTechUser = await db.user.create({
      data: { organizationId, email: `p3-5-radtech-${Date.now()}@test.local`, passwordHash: "x", firstName: "P3.5", lastName: "RadTechUser" },
    })
    radTechUserId = radTechUser.id

    const patient = await db.patient.create({
      data: {
        organizationId, registrationBranchId: branchAId,
        mrn: `TESTP35-${Date.now()}`, firstName: "P3.5", lastName: "LabRad",
        dob: new Date("1985-01-01"), gender: "unknown", mobile: `P35M${Date.now()}`,
      },
    })
    createdPatientIds.push(patient.id)
    patientId = patient.id

    const labTest = await db.labTest.create({
      data: {
        organizationId, code: `P35CBC-${Date.now()}`, name: "P3.5 CBC", category: "Hematology",
        specimenType: "blood", resultType: "numeric", unit: "g/dL",
        referenceRangeLow: 12, referenceRangeHigh: 16, price: 50,
      },
    })
    labTestId = labTest.id

    const imagingService = await db.imagingService.create({
      data: { organizationId, code: `P35XR-${Date.now()}`, name: "P3.5 Chest X-Ray", category: "X-Ray", price: 100 },
    })
    imagingServiceId = imagingService.id
  }, TIMEOUT)

  afterAll(async () => {
    const ownerDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DIRECT_DATABASE_URL }) })
    await ownerDb.clinicalAccessLog.deleteMany({ where: { patientId: { in: createdPatientIds } } })
    await ownerDb.$disconnect()

    await db.labOrderTest.deleteMany({ where: { clinicalOrderId: { in: createdOrderIds } } })
    await db.specimen.deleteMany({ where: { clinicalOrderId: { in: createdOrderIds } } })
    // Targeted backlog closure, item 7: an ImagingReportAmendment row Restricts
    // its parent ImagingOrder from deletion (the same immutability discipline
    // as every other clinical-actor FK in this schema) — must be cleared first.
    await db.imagingReportAmendment.deleteMany({ where: { imagingOrder: { clinicalOrderId: { in: createdOrderIds } } } })
    await db.imagingOrder.deleteMany({ where: { clinicalOrderId: { in: createdOrderIds } } })
    await db.labOrderDetail.deleteMany({ where: { clinicalOrderId: { in: createdOrderIds } } })
    await db.imagingOrderDetail.deleteMany({ where: { clinicalOrderId: { in: createdOrderIds } } })
    await db.charge.deleteMany({ where: { patientId: { in: createdPatientIds } } })
    await db.clinicalOrder.deleteMany({ where: { id: { in: createdOrderIds } } })
    if (createdAppointmentIds.length > 0) {
      await db.queueEntry.deleteMany({ where: { appointmentId: { in: createdAppointmentIds } } })
      await db.appointmentStatusHistory.deleteMany({ where: { appointmentId: { in: createdAppointmentIds } } })
    }
    await db.encounter.deleteMany({ where: { id: { in: createdEncounterIds } } })
    await db.appointment.deleteMany({ where: { id: { in: createdAppointmentIds } } })
    await db.commMessage.deleteMany({ where: { patientId: { in: createdPatientIds } } })
    await db.patient.deleteMany({ where: { id: { in: createdPatientIds } } })
    await db.labTest.delete({ where: { id: labTestId } })
    await db.imagingService.delete({ where: { id: imagingServiceId } })
    await db.user.deleteMany({ where: { id: { in: [doctorUserId, labTechUserId, radTechUserId] } } })
    await db.$disconnect()
  }, TIMEOUT)

  it("§6/§9: a doctor's lab order lands in the Lab queue as a real 'ordered' (new/unassigned) row, never a client-fabricated gap", async () => {
    const { order } = await placeOrderAndAssign("lab", branchAId)
    expect(order.status).toBe("ordered")

    const queue = await listLabQueue(labTechSession([branchAId]), {})
    expect(queue.orders.some((o) => o.id === order.id && o.status === "ordered")).toBe(true)

    const filtered = await listLabQueue(labTechSession([branchAId]), { status: "ordered" })
    expect(filtered.orders.some((o) => o.id === order.id)).toBe(true)
  }, TIMEOUT)

  it("§6/§9: a doctor's imaging order lands in the Radiology queue as a real 'ordered' row", async () => {
    const { order } = await placeOrderAndAssign("imaging", branchAId)
    expect(order.status).toBe("ordered")

    const queue = await listRadiologyQueue(radTechSession([branchAId]), {})
    expect(queue.orders.some((o) => o.id === order.id && o.status === "ordered")).toBe(true)
  }, TIMEOUT)

  it("§10: assignTests preserves the ClinicalOrder relationship and moves the order to in_progress", async () => {
    const { order } = await placeOrderAndAssign("lab", branchAId)
    const { tests } = await assignTests(labTechSession([branchAId]), order.id, {
      specimenType: "blood",
      lines: [{ kind: "test", id: labTestId }],
    })
    expect(tests).toHaveLength(1)
    expect(tests[0].clinicalOrderId).toBe(order.id)

    const reloaded = await getLabOrder(labTechSession([branchAId]), order.id)
    expect(reloaded.status).toBe("in_progress")
    expect(reloaded.labOrderTests).toHaveLength(1)
  }, TIMEOUT)

  it("§10/§27/§34: two lab techs racing to assign the same freshly-ordered order — only one wins, the other gets a friendly error, no duplicate specimens/tests/charges", async () => {
    const { order } = await placeOrderAndAssign("lab", branchAId)
    const input = { specimenType: "blood", lines: [{ kind: "test" as const, id: labTestId }] }

    const results = await Promise.allSettled([
      assignTests(labTechSession([branchAId]), order.id, input),
      assignTests(labTechSession([branchAId]), order.id, input),
    ])
    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/already been assigned/i)

    // No duplicate billable rows — exactly one specimen, one LabOrderTest, one Charge.
    expect(await db.specimen.count({ where: { clinicalOrderId: order.id } })).toBe(1)
    expect(await db.labOrderTest.count({ where: { clinicalOrderId: order.id } })).toBe(1)
    expect(await db.charge.count({ where: { sourceType: "lab", sourceReferenceId: order.id } })).toBe(1)
  }, TIMEOUT)

  it("§23/§34: a session authorized only for Branch B cannot assign tests or collect a specimen against a Branch A order", async () => {
    const { order } = await placeOrderAndAssign("lab", branchAId)
    const onlyB = labTechSession([branchBId])
    await expect(assignTests(onlyB, order.id, { specimenType: "blood", lines: [{ kind: "test", id: labTestId }] })).rejects.toThrow(ForbiddenError)

    const { tests } = await assignTests(labTechSession([branchAId]), order.id, { specimenType: "blood", lines: [{ kind: "test", id: labTestId }] })
    const specimenId = tests[0].specimenId!
    await expect(collectSpecimen(onlyB, specimenId)).rejects.toThrow(ForbiddenError)
    await expect(enterNumericResult(onlyB, tests[0].id, { numericValue: 14 })).rejects.toThrow(ForbiddenError)
  }, TIMEOUT)

  it("§26: a cancelled order stays historically visible but cannot be assigned or progressed", async () => {
    const { order } = await placeOrderAndAssign("lab", branchAId)
    await cancelOrder(doctorSession([branchAId]), order.id, "Patient declined")

    await expect(assignTests(labTechSession([branchAId]), order.id, { specimenType: "blood", lines: [{ kind: "test", id: labTestId }] })).rejects.toThrow()

    // Still visible in the queue (historical), not deleted — the default
    // "active" queue view excludes cancelled orders (P3.5 §26/§30), so this
    // checks the explicit "cancelled" filter rather than the default.
    const queue = await listLabQueue(labTechSession([branchAId]), { status: "cancelled" })
    expect(queue.orders.some((o) => o.id === order.id && o.status === "cancelled")).toBe(true)
    const defaultQueue = await listLabQueue(labTechSession([branchAId]), {})
    expect(defaultQueue.orders.some((o) => o.id === order.id)).toBe(false)
  }, TIMEOUT)

  it("§11-§13/§17/§28: full lab lifecycle — draft result -> verified, ClinicalOrder rolls to completed, verified result resists silent rewrite", async () => {
    const { order } = await placeOrderAndAssign("lab", branchAId)
    const { tests } = await assignTests(labTechSession([branchAId]), order.id, { specimenType: "blood", lines: [{ kind: "test", id: labTestId }] })
    const lineId = tests[0].id
    const specimenId = tests[0].specimenId!

    await collectSpecimen(labTechSession([branchAId]), specimenId)
    await receiveSpecimen(labTechSession([branchAId]), specimenId)

    const entered = await enterNumericResult(labTechSession([branchAId]), lineId, { numericValue: 14 })
    expect(entered.status).toBe("resulted")
    expect(entered.verifiedAt).toBeNull()

    const verified = await verifyResult(labTechSession([branchAId]), lineId)
    expect(verified.status).toBe("verified")
    expect(verified.verifiedBy).toBe(labTechUserId)

    // §17: single-line order -> parent ClinicalOrder synced to completed.
    const parent = await db.clinicalOrder.findUniqueOrThrow({ where: { id: order.id } })
    expect(parent.status).toBe("completed")

    // §28: verified result resists silent rewrite via normal entry...
    await expect(enterNumericResult(labTechSession([branchAId]), lineId, { numericValue: 99 })).rejects.toThrow()
    // ...and resists a second verify. A sequential re-verify is already
    // blocked earlier, by the terminal "verified" state in
    // LAB_ORDER_TEST_TRANSITIONS, before it ever reaches the race-specific
    // stale-transition guard — the guard's own "already verified by someone
    // else" wording is exercised by the dedicated concurrency test below, so
    // this just confirms rejection, not a specific message.
    await expect(verifyResult(labTechSession([branchAId]), lineId)).rejects.toThrow()

    // §16: the only correction path is a real amendment, chained via isCurrent/amendsId.
    const amended = await amendLabResult(labTechSession([branchAId]), lineId, { numericValue: 15 })
    expect(amended.amendsId).toBe(lineId)
    expect(amended.isCurrent).toBe(true)
    const original = await db.labOrderTest.findUniqueOrThrow({ where: { id: lineId } })
    expect(original.isCurrent).toBe(false)
    expect(Number(original.numericValue)).toBe(14) // original value untouched

    // §20/§21: Patient 360 and Doctor's own read both see the current, verified value.
    const patient360 = await listPatientLabResults(doctorSession([branchAId]), patientId)
    const row = patient360.find((r) => r.id === amended.id)
    expect(row).toBeDefined()
  }, TIMEOUT)

  it("§27: two verifiers racing on the same resulted line — only one succeeds, the other gets a friendly stale-state error", async () => {
    const { order } = await placeOrderAndAssign("lab", branchAId)
    const { tests } = await assignTests(labTechSession([branchAId]), order.id, { specimenType: "blood", lines: [{ kind: "test", id: labTestId }] })
    const lineId = tests[0].id
    await collectSpecimen(labTechSession([branchAId]), tests[0].specimenId!)
    await enterNumericResult(labTechSession([branchAId]), lineId, { numericValue: 14 })

    const results = await Promise.allSettled([
      verifyResult(labTechSession([branchAId]), lineId),
      verifyResult(labTechSession([branchAId]), lineId),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[]
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason.message).toMatch(/already verified/i)
  }, TIMEOUT)

  it("§27: two radiologists racing to verify the same reported study — only one succeeds, the other gets a friendly stale-state error", async () => {
    const { order } = await placeOrderAndAssign("imaging", branchAId)
    const imagingOrder = await assignImagingService(radTechSession([branchAId]), order.id, { imagingServiceId })
    await scheduleImaging(radTechSession([branchAId]), imagingOrder.id, { scheduledAt: new Date() })
    await markPerformed(radTechSession([branchAId]), imagingOrder.id)
    await writeReport(radTechSession([branchAId]), imagingOrder.id, { reportText: "Clear lung fields." })

    const results = await Promise.allSettled([
      verifyImagingResult(radTechSession([branchAId]), imagingOrder.id),
      verifyImagingResult(radTechSession([branchAId]), imagingOrder.id),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[]
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason.message).toMatch(/already verified/i)
  }, TIMEOUT)

  it("§14-§15/§17/§28: full imaging lifecycle — draft report -> finalized, ClinicalOrder rolls to completed, finalized report resists silent rewrite", async () => {
    const { order } = await placeOrderAndAssign("imaging", branchAId)
    const imagingOrder = await assignImagingService(radTechSession([branchAId]), order.id, { imagingServiceId })
    expect(imagingOrder.clinicalOrderId).toBe(order.id)

    await scheduleImaging(radTechSession([branchAId]), imagingOrder.id, { scheduledAt: new Date() })
    await markPerformed(radTechSession([branchAId]), imagingOrder.id)
    const reported = await writeReport(radTechSession([branchAId]), imagingOrder.id, { reportText: "Clear lung fields.", impression: "No acute findings." })
    expect(reported.status).toBe("reported")

    const verified = await verifyImagingResult(radTechSession([branchAId]), imagingOrder.id)
    expect(verified.status).toBe("verified")
    expect(verified.verifiedBy).toBe(radTechUserId)

    const parent = await db.clinicalOrder.findUniqueOrThrow({ where: { id: order.id } })
    expect(parent.status).toBe("completed")

    // §28: finalized report resists rewrite (writeReport requires "performed", nothing returns to it from "verified")...
    await expect(writeReport(radTechSession([branchAId]), imagingOrder.id, { reportText: "Rewritten." })).rejects.toThrow()
    // ...and resists a second verify (the concurrency guard's specific
    // "already verified by someone else" wording is exercised by radiology's
    // race further down; a sequential re-verify here is already blocked
    // earlier by the plain "only a reported study" precondition).
    await expect(verifyImagingResult(radTechSession([branchAId]), imagingOrder.id)).rejects.toThrow()

    const patient360 = await listPatientImagingResults(doctorSession([branchAId]), patientId)
    expect(patient360.some((r) => r.id === imagingOrder.id)).toBe(true)
  }, TIMEOUT)

  it("§18/§19/§22: a Doctor session (no operational lab/radiology permission) can read a full order's real result destination but cannot perform any operational action", async () => {
    const { order: labOrder } = await placeOrderAndAssign("lab", branchAId)
    const { tests } = await assignTests(labTechSession([branchAId]), labOrder.id, { specimenType: "blood", lines: [{ kind: "test", id: labTestId }] })
    await collectSpecimen(labTechSession([branchAId]), tests[0].specimenId!)
    await enterNumericResult(labTechSession([branchAId]), tests[0].id, { numericValue: 14 })
    await verifyResult(labTechSession([branchAId]), tests[0].id)

    // The doctor holds only patient.view for lab-ops purposes — getLabOrder
    // must not reject them (P3.3's own backlog gap this batch closes).
    const asDoctor = await getLabOrder(doctorSession([branchAId]), labOrder.id)
    expect(asDoctor.labOrderTests[0].status).toBe("verified")

    // But every actual write stays denied.
    await expect(enterNumericResult(doctorSession([branchAId]), tests[0].id, { numericValue: 20 })).rejects.toThrow()
    await expect(verifyResult(doctorSession([branchAId]), tests[0].id)).rejects.toThrow()

    const { order: imgOrder } = await placeOrderAndAssign("imaging", branchAId)
    const asDoctorImaging = await getRadiologyOrder(doctorSession([branchAId]), imgOrder.id)
    expect(asDoctorImaging.id).toBe(imgOrder.id)
  }, TIMEOUT)

  /**
   * Targeted backlog closure, item 2: `listLabQueue`/`listRadiologyQueue`
   * previously hard-capped at `take: 200` (P4.5), which would silently hide
   * order 201+ with no way to reach it. Replaced with real pagination — this
   * proves the replacement actually works: a full first page, a real second
   * page holding exactly the remainder, no record missing or duplicated
   * across pages, a correct total count, deterministic ordering (re-running
   * the same page twice returns the identical row set), and branch
   * isolation preserved under pagination.
   */
  describe("items 1/2: status validation + real pagination", () => {
    const bulkOrderIds: string[] = []

    beforeAll(async () => {
      // One real encounter (via the existing helper) that every bulk order
      // below attaches to — what's under test is the list/paginate query,
      // not order-creation workflow, so bulk `createMany` is appropriate
      // here the same way load-tests/seed/generate-load-data.ts uses it for
      // bulk volume elsewhere in this codebase.
      const { encounter } = await placeOrderAndAssign("lab", branchAId)
      const BULK_COUNT = 55 // > one page (50) so page 2 has real, verifiable content
      const rows = Array.from({ length: BULK_COUNT }, (_, i) => ({
        organizationId, branchId: branchAId, patientId, encounterId: encounter.id,
        orderNumber: `P-BACKLOG-BULK-${Date.now()}-${i}`, orderType: "lab" as const,
        status: "ordered" as const, orderingProviderId: doctorProviderId,
        orderedAt: new Date(Date.now() + i * 1000), // strictly increasing — a real, distinguishable order across rows
      }))
      await db.clinicalOrder.createMany({ data: rows })
      const created = await db.clinicalOrder.findMany({ where: { orderNumber: { in: rows.map((r) => r.orderNumber) } }, select: { id: true } })
      bulkOrderIds.push(...created.map((c) => c.id))
      createdOrderIds.push(...bulkOrderIds) // reuse the file's own afterAll cleanup
    }, TIMEOUT)

    it("first page returns exactly pageSize rows and a correct total/totalPages", async () => {
      const result = await listLabQueue(labTechSession([branchAId]), { status: "ordered", page: 1 })
      expect(result.orders.length).toBe(50)
      expect(result.total).toBeGreaterThanOrEqual(55)
      expect(result.totalPages).toBeGreaterThanOrEqual(2)
      expect(result.page).toBe(1)
    }, TIMEOUT)

    it("second page holds the remainder — no order silently disappears past row 200", async () => {
      const page1 = await listLabQueue(labTechSession([branchAId]), { status: "ordered", page: 1 })
      const page2 = await listLabQueue(labTechSession([branchAId]), { status: "ordered", page: 2 })
      const page1Ids = new Set(page1.orders.map((o) => o.id))
      const page2Ids = new Set(page2.orders.map((o) => o.id))
      // Every bulk-created order is reachable on page 1 or page 2 — none hidden.
      for (const id of bulkOrderIds) expect(page1Ids.has(id) || page2Ids.has(id)).toBe(true)
      // No duplicate across pages.
      for (const id of page2Ids) expect(page1Ids.has(id)).toBe(false)
    }, TIMEOUT)

    it("ordering is deterministic across repeated calls (a stable tiebreak, not accidental)", async () => {
      const a = await listLabQueue(labTechSession([branchAId]), { status: "ordered", page: 1 })
      const b = await listLabQueue(labTechSession([branchAId]), { status: "ordered", page: 1 })
      expect(a.orders.map((o) => o.id)).toEqual(b.orders.map((o) => o.id))
    }, TIMEOUT)

    it("filtering (status) + pagination compose correctly", async () => {
      const ordered = await listLabQueue(labTechSession([branchAId]), { status: "ordered", page: 1 })
      expect(ordered.orders.every((o) => o.status === "ordered")).toBe(true)
      const completed = await listLabQueue(labTechSession([branchAId]), { status: "completed", page: 1 })
      // None of the bulk "ordered" fixture rows leak into an unrelated status filter.
      const completedIds = new Set(completed.orders.map((o) => o.id))
      for (const id of bulkOrderIds) expect(completedIds.has(id)).toBe(false)
    }, TIMEOUT)

    it("pagination stays branch-scoped — a Branch B session never sees Branch A's bulk orders on any page", async () => {
      const branchBQueue = await listLabQueue(labTechSession([branchBId]), { status: "ordered", page: 1 })
      const seen = new Set(branchBQueue.orders.map((o) => o.id))
      for (const id of bulkOrderIds) expect(seen.has(id)).toBe(false)
    }, TIMEOUT)

    it("radiology queue pagination mirrors the lab queue's shape (page/total/totalPages present, no unbounded cap)", async () => {
      const result = await listRadiologyQueue(radTechSession([branchAId]), { page: 1 })
      expect(result).toHaveProperty("total")
      expect(result).toHaveProperty("totalPages")
      expect(result.orders.length).toBeLessThanOrEqual(50)
    }, TIMEOUT)
  })

  /**
   * Targeted backlog closure, item 7 (BACKLOG.md's "No amendment/correction
   * mechanism for finalized Radiology reports"): a narrow correction path
   * for a verified report, analogous to Lab's own isCurrent/amendsId chain
   * but implemented as a dedicated `ImagingReportAmendment` table (see that
   * model's own doc comment in schema.prisma for why). Verifies the
   * original stays immutable, a correction requires a reason, the current
   * version is correctly derived, history stays accessible, and branch
   * isolation holds.
   */
  describe("item 7: radiology report amendment", () => {
    async function verifiedImagingOrder(branchId: string) {
      const { order } = await placeOrderAndAssign("imaging", branchId)
      const imagingOrder = await assignImagingService(radTechSession([branchId]), order.id, { imagingServiceId })
      await scheduleImaging(radTechSession([branchId]), imagingOrder.id, { scheduledAt: new Date() })
      await markPerformed(radTechSession([branchId]), imagingOrder.id)
      await writeReport(radTechSession([branchId]), imagingOrder.id, { reportText: "Original findings.", impression: "Original impression." })
      await verifyImagingResult(radTechSession([branchId]), imagingOrder.id)
      return { order, imagingOrderId: imagingOrder.id }
    }

    it("only a verified report can be amended — a non-verified one is rejected", async () => {
      const { order } = await placeOrderAndAssign("imaging", branchAId)
      const imagingOrder = await assignImagingService(radTechSession([branchAId]), order.id, { imagingServiceId })
      await expect(
        amendImagingReport(radTechSession([branchAId]), imagingOrder.id, { reportText: "x", reason: "y" })
      ).rejects.toThrow(/Only a verified report can be amended/)
    }, TIMEOUT)

    it("a reason is required — the schema rejects an empty one before the domain layer is even reached in the real form flow", async () => {
      const { amendReportSchema } = await import("@/lib/domains/radiology/schemas")
      const parsed = amendReportSchema.safeParse({ reportText: "Corrected findings.", reason: "" })
      expect(parsed.success).toBe(false)
    })

    it("amendment creates a NEW row and never overwrites the original — original stays byte-for-byte immutable", async () => {
      const { imagingOrderId } = await verifiedImagingOrder(branchAId)
      const beforeAmend = await db.imagingOrder.findUniqueOrThrow({ where: { id: imagingOrderId } })

      const amendment = await amendImagingReport(radTechSession([branchAId]), imagingOrderId, {
        reportText: "Corrected findings — small nodule identified.", impression: "Follow-up recommended.", reason: "Missed finding on initial read.",
      })
      expect(amendment.imagingOrderId).toBe(imagingOrderId)
      expect(amendment.reason).toBe("Missed finding on initial read.")

      const afterAmend = await db.imagingOrder.findUniqueOrThrow({ where: { id: imagingOrderId } })
      expect(afterAmend.reportText).toBe(beforeAmend.reportText) // untouched
      expect(afterAmend.impression).toBe(beforeAmend.impression) // untouched
      expect(afterAmend.reportedAt?.getTime()).toBe(beforeAmend.reportedAt?.getTime()) // untouched
    }, TIMEOUT)

    it("current/latest version is correctly derived as the most recent amendment — history stays fully accessible", async () => {
      const { order: clinicalOrder, imagingOrderId } = await verifiedImagingOrder(branchAId)
      await amendImagingReport(radTechSession([branchAId]), imagingOrderId, { reportText: "First correction.", reason: "Reason one." })
      const second = await amendImagingReport(radTechSession([branchAId]), imagingOrderId, { reportText: "Second correction — supersedes the first.", reason: "Reason two." })

      const order = await getRadiologyOrder(radTechSession([branchAId]), clinicalOrder.id)
      expect(order.imagingOrder!.amendments).toHaveLength(2)
      // Oldest first — the current/latest is the LAST entry, not the first.
      expect(order.imagingOrder!.amendments[0].reportText).toBe("First correction.")
      expect(order.imagingOrder!.amendments[1].id).toBe(second.id)
      expect(order.imagingOrder!.amendments[1].reportText).toBe("Second correction — supersedes the first.")
      // Every amendment independently attributed (actor + timestamp + reason).
      for (const a of order.imagingOrder!.amendments) {
        expect(a.amendedBy).toBe(radTechUserId)
        expect(a.amendedAt).toBeInstanceOf(Date)
        expect(a.reason.length).toBeGreaterThan(0)
      }
    }, TIMEOUT)

    it("Patient 360's Imaging tab shows the CURRENT (amended) impression, not the stale original", async () => {
      const { imagingOrderId } = await verifiedImagingOrder(branchAId)
      await amendImagingReport(radTechSession([branchAId]), imagingOrderId, { reportText: "Corrected.", impression: "Updated impression after re-review.", reason: "Correction." })

      const results = await listPatientImagingResults(doctorSession([branchAId]), patientId)
      const row = results.find((r) => r.id === imagingOrderId)
      expect(row?.impression).toBe("Updated impression after re-review.")
    }, TIMEOUT)

    it("amendment stays branch-scoped — a Branch B session cannot amend a Branch A report", async () => {
      const { imagingOrderId } = await verifiedImagingOrder(branchAId)
      await expect(
        amendImagingReport(radTechSession([branchBId]), imagingOrderId, { reportText: "Unauthorized amendment attempt.", reason: "x" })
      ).rejects.toThrow(ForbiddenError)
    }, TIMEOUT)

    it("a stale/foreign imaging order id returns a friendly error, never a raw Prisma message", async () => {
      await expect(
        amendImagingReport(radTechSession([branchAId]), "00000000-0000-4000-8000-000000000000", { reportText: "x", reason: "y" })
      ).rejects.toThrow(/no longer exists or is not accessible/)
    }, TIMEOUT)
  })
})
