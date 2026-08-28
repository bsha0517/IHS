import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { updateOrderStatus, cancelOrder } from "@/lib/domains/clinical/orders"
import { enterNumericResult, verifyResult, amendLabResult, listPatientLabResults } from "@/lib/domains/laboratory/results"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P1 §20 (centralized lab/clinical-order state transitions), §21 (result
 * verification distinguishes entered-by/verified-by, amendments keep
 * history), §22 (critical abnormal-flag determination + restricted
 * notification) — real DB integration tests against the transition maps
 * and amendment mechanism added this batch.
 */
const TIMEOUT = 60000

describe("P1 §20-§22: lab order state integrity, critical results, amendment", () => {
  let organizationId: string
  let branchId: string
  let patientId: string
  let providerId: string
  let providerUserId: string
  let encounterId: string
  const clinicalOrderIds: string[] = []
  const labTestIds: string[] = []
  const extraProviderIds: string[] = []
  const extraUserIds: string[] = []

  function session(): SessionContext {
    return {
      sessionId: "test-lab-state-integrity",
      user: { id: providerUserId, organizationId, email: "lab-state-test@test.local", firstName: "Lab", lastName: "Test" },
      activeBranchId: branchId,
      branchIds: [branchId],
      permissions: new Set(["lab_result.enter", "lab_result.verify", "order.create", "lab_order.create", "patient.view"]),
      roleNames: ["Super Admin"],
    }
  }

  async function createLabTest(opts: { low?: number; high?: number; criticalLow?: number; criticalHigh?: number } = {}) {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const test = await db.labTest.create({
      data: {
        organizationId,
        code: `TESTLAB-${suffix}`,
        name: `Test Lab Analyte ${suffix}`,
        category: "Chemistry",
        specimenType: "blood",
        resultType: "numeric",
        unit: "mg/dL",
        referenceRangeLow: opts.low ?? 70,
        referenceRangeHigh: opts.high ?? 100,
        criticalLow: opts.criticalLow ?? null,
        criticalHigh: opts.criticalHigh ?? null,
        price: 40,
      },
    })
    labTestIds.push(test.id)
    return test
  }

  async function createOrderWithLine(labTest: Awaited<ReturnType<typeof createLabTest>>) {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const order = await db.clinicalOrder.create({
      data: {
        organizationId, branchId, patientId, encounterId,
        orderNumber: `TESTORD-${suffix}`,
        orderType: "lab",
        status: "ordered",
        orderingProviderId: providerId,
      },
    })
    clinicalOrderIds.push(order.id)
    const specimen = await db.specimen.create({
      data: { organizationId, branchId, clinicalOrderId: order.id, specimenNumber: `TESTSPC-${suffix}`, specimenType: "blood" },
    })
    const line = await db.labOrderTest.create({
      data: { organizationId, clinicalOrderId: order.id, labTestId: labTest.id, specimenId: specimen.id, resultType: "numeric", status: "ordered" },
    })
    return { order, line }
  }

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchId = branch.id
    const adminUser = await db.user.findFirstOrThrow({ where: { organizationId } })
    providerUserId = adminUser.id

    const provider = await db.provider.create({
      data: { organizationId, providerType: "doctor", firstName: "Lab", lastName: `StateTestProvider-${Date.now()}`, userId: null },
    })
    providerId = provider.id

    const patient = await db.patient.create({
      data: {
        organizationId, registrationBranchId: branchId,
        mrn: `TESTLABSTATE-${Date.now()}`, firstName: "LabState", lastName: "Integrity",
        dob: new Date("1990-01-01"), gender: "unknown", mobile: `LS${Date.now()}`,
      },
    })
    patientId = patient.id

    const encounter = await db.encounter.create({
      data: {
        organizationId, branchId, patientId, providerId,
        encounterNumber: `TESTLABSTATE-ENC-${Date.now()}`,
        encounterType: "consultation", status: "active",
      },
    })
    encounterId = encounter.id
  }, TIMEOUT)

  afterAll(async () => {
    await db.notification.deleteMany({ where: { organizationId, referenceType: { in: ["lab_order_test", "clinical_order"] } } }).catch(() => {})
    await db.labOrderTest.deleteMany({ where: { clinicalOrderId: { in: clinicalOrderIds } } })
    await db.specimen.deleteMany({ where: { clinicalOrderId: { in: clinicalOrderIds } } })
    await db.clinicalOrder.deleteMany({ where: { id: { in: clinicalOrderIds } } })
    await db.labTest.deleteMany({ where: { id: { in: labTestIds } } })
    await db.encounter.delete({ where: { id: encounterId } })
    // The P0-06 restricted runtime role (avant_app_runtime, `db`'s own
    // connection) has DELETE revoked on clinical_access_log — the same
    // deliberate hardening audit-log-immutability.test.ts verifies for
    // audit_log. listPatientLabResults (§21 tests above) wrote real rows
    // there for `patientId`, so that patient can never be deleted through
    // this connection either (Restrict FK) — left in place on purpose,
    // identifiable by its `TESTLABSTATE-` mrn prefix, the same "immutable
    // trail wins over full test cleanup" tradeoff every other test that
    // exercises a clinical-access-logged read already accepts.
    await db.provider.delete({ where: { id: providerId } })
    await db.provider.deleteMany({ where: { id: { in: extraProviderIds } } })
    await db.user.deleteMany({ where: { id: { in: extraUserIds } } })
    await db.$disconnect()
  }, TIMEOUT)

  describe("§20: centralized ClinicalOrder transitions", () => {
    it("blocks the arbitrary skip ordered -> completed directly", async () => {
      const labTest = await createLabTest()
      const { order } = await createOrderWithLine(labTest)
      await expect(updateOrderStatus(session(), order.id, "completed")).rejects.toThrow(/Cannot move a clinical order from "ordered" to "completed"/)
    }, TIMEOUT)

    it("allows the valid chain ordered -> acknowledged -> in_progress -> completed", async () => {
      const labTest = await createLabTest()
      const { order } = await createOrderWithLine(labTest)
      await updateOrderStatus(session(), order.id, "acknowledged")
      await updateOrderStatus(session(), order.id, "in_progress")
      const final = await updateOrderStatus(session(), order.id, "completed")
      expect(final.status).toBe("completed")
    }, TIMEOUT)

    it("cancelOrder requires a reason and is blocked once the order is already completed", async () => {
      const labTest = await createLabTest()
      const { order } = await createOrderWithLine(labTest)
      const cancelled = await cancelOrder(session(), order.id, "ordered by mistake")
      expect(cancelled.status).toBe("cancelled")
      expect(cancelled.cancelReason).toBe("ordered by mistake")

      const labTest2 = await createLabTest()
      const { order: order2 } = await createOrderWithLine(labTest2)
      await updateOrderStatus(session(), order2.id, "acknowledged")
      await updateOrderStatus(session(), order2.id, "in_progress")
      await updateOrderStatus(session(), order2.id, "completed")
      await expect(cancelOrder(session(), order2.id, "too late")).rejects.toThrow(/Cannot move a clinical order from "completed" to "cancelled"/)
    }, TIMEOUT)
  })

  describe("§20: centralized LabOrderTest transitions", () => {
    it("blocks entering a result on a line that was never collected (ordered -> resulted directly)", async () => {
      const labTest = await createLabTest()
      const { line } = await createOrderWithLine(labTest)
      await expect(enterNumericResult(session(), line.id, { numericValue: 85, notes: null })).rejects.toThrow(/Cannot move a lab result from "ordered" to "resulted"/)
    }, TIMEOUT)

    it("allows entering a result once collected, and allows correcting it again before verification", async () => {
      const labTest = await createLabTest()
      const { line } = await createOrderWithLine(labTest)
      await db.labOrderTest.update({ where: { id: line.id }, data: { status: "collected" } })

      await enterNumericResult(session(), line.id, { numericValue: 85, notes: null })
      const corrected = await enterNumericResult(session(), line.id, { numericValue: 90, notes: "corrected transcription error" })
      expect(Number(corrected.numericValue)).toBe(90)
      expect(corrected.status).toBe("resulted")
    }, TIMEOUT)

    it("blocks verifying a line that was never resulted", async () => {
      const labTest = await createLabTest()
      const { line } = await createOrderWithLine(labTest)
      await db.labOrderTest.update({ where: { id: line.id }, data: { status: "collected" } })
      await expect(verifyResult(session(), line.id)).rejects.toThrow(/Cannot move a lab result from "collected" to "verified"/)
    }, TIMEOUT)
  })

  describe("§21: entered-by/verified-by distinction, unverified never shows as final", () => {
    it("tracks enteredBy/enteredAt and verifiedBy/verifiedAt as genuinely separate events", async () => {
      const labTest = await createLabTest()
      const { line } = await createOrderWithLine(labTest)
      await db.labOrderTest.update({ where: { id: line.id }, data: { status: "collected" } })

      const entered = await enterNumericResult(session(), line.id, { numericValue: 85, notes: null })
      expect(entered.enteredBy).toBe(providerUserId)
      expect(entered.verifiedBy).toBeNull()
      expect(entered.status).toBe("resulted")

      const verified = await verifyResult(session(), line.id)
      expect(verified.verifiedBy).toBe(providerUserId)
      expect(verified.verifiedAt).not.toBeNull()
      expect(verified.status).toBe("verified")
    }, TIMEOUT)

    it("a resulted-but-not-yet-verified line never appears in listPatientLabResults", async () => {
      const labTest = await createLabTest()
      const { line } = await createOrderWithLine(labTest)
      await db.labOrderTest.update({ where: { id: line.id }, data: { status: "collected" } })
      await enterNumericResult(session(), line.id, { numericValue: 85, notes: null })

      const results = await listPatientLabResults(session(), patientId)
      expect(results.find((r) => r.id === line.id)).toBeUndefined()

      await verifyResult(session(), line.id)
      const afterVerify = await listPatientLabResults(session(), patientId)
      expect(afterVerify.find((r) => r.id === line.id)).toBeDefined()
    }, TIMEOUT)
  })

  describe("§21: amendment keeps history, never edits a verified result in place", () => {
    it("amendLabResult creates a new current row, marks the original isCurrent:false, and only the amendment shows in patient results", async () => {
      const labTest = await createLabTest()
      const { line } = await createOrderWithLine(labTest)
      await db.labOrderTest.update({ where: { id: line.id }, data: { status: "collected" } })
      await enterNumericResult(session(), line.id, { numericValue: 85, notes: null })
      await verifyResult(session(), line.id)

      const amendment = await amendLabResult(session(), line.id, { numericValue: 95, notes: "corrected after re-review" })
      expect(amendment.amendsId).toBe(line.id)
      expect(amendment.isCurrent).toBe(true)
      expect(amendment.status).toBe("verified")

      const original = await db.labOrderTest.findUniqueOrThrow({ where: { id: line.id } })
      expect(original.isCurrent).toBe(false)
      expect(Number(original.numericValue)).toBe(85) // never overwritten in place

      const results = await listPatientLabResults(session(), patientId)
      const matching = results.filter((r) => r.id === line.id || r.id === amendment.id)
      expect(matching.length).toBe(1) // only the current version shows, never both
      expect(matching[0].id).toBe(amendment.id)
      expect(Number(matching[0].numericValue)).toBe(95)
    }, TIMEOUT)

    it("rejects amending a non-current (already-superseded) version", async () => {
      const labTest = await createLabTest()
      const { line } = await createOrderWithLine(labTest)
      await db.labOrderTest.update({ where: { id: line.id }, data: { status: "collected" } })
      await enterNumericResult(session(), line.id, { numericValue: 85, notes: null })
      await verifyResult(session(), line.id)
      await amendLabResult(session(), line.id, { numericValue: 95, notes: "first amendment" })

      await expect(amendLabResult(session(), line.id, { numericValue: 100, notes: "second attempt on the stale original" })).rejects.toThrow(
        /Only the current version of a lab result can be amended/
      )
    }, TIMEOUT)
  })

  describe("§22: critical abnormal-flag determination and restricted notification", () => {
    it("computes critical_high and notifies the ordering provider once verified", async () => {
      const labTest = await createLabTest({ low: 70, high: 100, criticalLow: 40, criticalHigh: 400 })
      // A dedicated user (not the shared admin fixture) so Provider.userId's
      // uniqueness can't collide with any other test or seeded provider.
      const alertUser = await db.user.create({
        data: {
          organizationId, email: `critical-alert-${Date.now()}@test.local`, passwordHash: "not-a-real-hash",
          firstName: "Critical", lastName: "AlertRecipient",
        },
      })
      const providerWithLogin = await db.provider.create({
        data: { organizationId, providerType: "doctor", firstName: "Critical", lastName: `AlertProvider-${Date.now()}`, userId: alertUser.id },
      })
      extraProviderIds.push(providerWithLogin.id)
      extraUserIds.push(alertUser.id)
      const order = await db.clinicalOrder.create({
        data: {
          organizationId, branchId, patientId, encounterId,
          orderNumber: `TESTORD-CRIT-${Date.now()}`, orderType: "lab", status: "ordered", orderingProviderId: providerWithLogin.id,
        },
      })
      clinicalOrderIds.push(order.id)
      const specimen = await db.specimen.create({
        data: { organizationId, branchId, clinicalOrderId: order.id, specimenNumber: `TESTSPC-CRIT-${Date.now()}`, specimenType: "blood" },
      })
      const line = await db.labOrderTest.create({
        data: { organizationId, clinicalOrderId: order.id, labTestId: labTest.id, specimenId: specimen.id, resultType: "numeric", status: "collected" },
      })

      const entered = await enterNumericResult(session(), line.id, { numericValue: 450, notes: null }) // above criticalHigh (400)
      expect(entered.abnormalFlag).toBe("critical_high")

      await verifyResult(session(), line.id)

      const notification = await db.notification.findFirstOrThrow({ where: { referenceType: "lab_order_test", referenceId: line.id } })
      expect(notification.recipientUserId).toBe(alertUser.id)
      expect(notification.type).toBe("critical_lab_result")
      expect(notification.title).toMatch(/CRITICAL/)
      // providerWithLogin/alertUser are cleaned up in afterAll, once every
      // ClinicalOrder referencing them (via clinicalOrderIds) is gone —
      // deleting them here, mid-test, would race the parent afterAll's own
      // FK-ordered cleanup.
    }, TIMEOUT)

    it("a normal (non-critical) verified result never creates a critical notification", async () => {
      const labTest = await createLabTest({ low: 70, high: 100, criticalLow: 40, criticalHigh: 400 })
      const { line } = await createOrderWithLine(labTest)
      await db.labOrderTest.update({ where: { id: line.id }, data: { status: "collected" } })
      await enterNumericResult(session(), line.id, { numericValue: 85, notes: null }) // well within range
      await verifyResult(session(), line.id)

      const notification = await db.notification.findFirst({ where: { referenceType: "lab_order_test", referenceId: line.id } })
      expect(notification).toBeNull()
    }, TIMEOUT)
  })
})
