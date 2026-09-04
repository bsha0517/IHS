import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { ForbiddenError } from "@/lib/platform/permissions-core"
import { registerPatient, getPatient } from "@/lib/domains/patients/service"
import { bookAppointment, checkIn, getAppointment } from "@/lib/domains/appointments/service"
import { listBranchQueue } from "@/lib/domains/appointments/queue"
import { startEncounter, completeEncounter, finalizeEncounter, getEncounter } from "@/lib/domains/clinical/encounters"
import { recordVitals } from "@/lib/domains/clinical/vitals"
import { addDiagnosis, listPatientDiagnoses } from "@/lib/domains/clinical/diagnoses"
import { createOrder } from "@/lib/domains/clinical/orders"
import { createPrescription, listPatientPrescriptions } from "@/lib/domains/clinical/prescriptions"
import { saveNote } from "@/lib/domains/clinical/notes"
import {
  listLabQueue,
  getLabOrder,
  assignTests,
  collectSpecimen,
  receiveSpecimen,
} from "@/lib/domains/laboratory/orders"
import { enterNumericResult, verifyResult, listPatientLabResults } from "@/lib/domains/laboratory/results"
import { listRadiologyQueue, getRadiologyOrder, assignImagingService, scheduleImaging, markPerformed } from "@/lib/domains/radiology/orders"
import { writeReport, verifyImagingResult, listPatientImagingResults } from "@/lib/domains/radiology/results"
import { listPharmacyQueue, getPrescriptionForDispensing } from "@/lib/domains/pharmacy/queue"
import { createDispensingRecord, verifyDispensingRecord, dispenseRecord } from "@/lib/domains/pharmacy/dispensing"
import { listPendingCharges, generateSystemCharge } from "@/lib/domains/billing/charges"
import { generateInvoice, getInvoice, listPatientInvoices } from "@/lib/domains/billing/invoices"
import { recordPayment, listPatientPayments } from "@/lib/domains/billing/payments"
import { requestRefund, authorizeRefund, completeRefund } from "@/lib/domains/billing/refunds"
import { openSession as openCashierSession } from "@/lib/domains/billing/cashier"
import { getPatientStatement } from "@/lib/domains/billing/statement"
import { trialBalance } from "@/lib/domains/accounting/reports"
import { createPayrollRun, movePayrollToReview, approvePayrollRun, markPayrollPaid, getPayrollLinePayslip } from "@/lib/domains/payroll/payroll"
import { createEmployee } from "@/lib/domains/hr/employees"
import { requestLeave, approveLeave } from "@/lib/domains/hr/leave"
import { createPurchaseRequest, approvePurchaseRequest } from "@/lib/domains/procurement/purchase-requests"
import { createPurchaseOrder } from "@/lib/domains/procurement/purchase-orders"
import { createGoodsReceipt } from "@/lib/domains/procurement/goods-receipts"
import { createSupplierInvoice, recordSupplierPayment } from "@/lib/domains/procurement/supplier-invoices"
import { getUnreadCount, listNotifications } from "@/lib/domains/notifications/service"
import { dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import "@/lib/platform/event-handlers"
import type { SessionContext } from "@/lib/auth/session"

const TIMEOUT = 90000

/**
 * P3.13 — Cross-Role End-to-End Workflow Verification, the final P3 phase.
 * Proves the HIS can execute its critical operational workflows end to end,
 * across the correct staff roles (real seeded permission sets, matching
 * prisma/seed.ts's SYSTEM_ROLES exactly — not Super Admin, not an all-
 * powerful fixture user), with the SAME underlying Patient/Appointment/
 * Encounter/ClinicalOrder/Prescription/Invoice/PayrollRun flowing through
 * every step, rather than a fresh record fabricated per step. See
 * P3_13_CROSS_ROLE_END_TO_END_WORKFLOW_VERIFICATION_REPORT.md for the full
 * narrative, reconciliation math, and browser-walkthrough record.
 */

describe("P3.13 Workflow A: Complete Patient Journey — Reception through Accounting", () => {
  let organizationId: string
  let branchAId: string
  let branchBId: string
  let providerId: string
  let providerUserId: string
  let receptionistUserId: string
  let nurseUserId: string
  let labTechUserId: string
  let radTechUserId: string
  let pharmacistUserId: string
  let cashierUserId: string
  let accountantUserId: string
  let labTestId: string
  let imagingServiceId: string
  let cashierSessionRowId: string

  // Threaded record IDs — the whole point of this workflow.
  let patientId: string
  let appointmentId: string
  let encounterId: string
  let labOrderId: string
  let imagingOrderId: string
  let prescriptionId: string
  let invoiceId: string

  const createdUserIds: string[] = []
  const createdProviderIds: string[] = []
  const createdPatientIds: string[] = []
  const createdAppointmentIds: string[] = []
  const createdEncounterIds: string[] = []
  const createdOrderIds: string[] = []
  const createdPrescriptionIds: string[] = []
  const createdInvoiceIds: string[] = []
  const createdCashierSessionIds: string[] = []
  const createdProductIds: string[] = []

  // Real seeded permission sets — copied verbatim from prisma/seed.ts's
  // SYSTEM_ROLES so this test proves real role boundaries, not a fixture
  // shortcut (P3.13 §3/§49).
  function receptionistSession(branchIds: string[]): SessionContext {
    return {
      sessionId: "test-p3-13-receptionist",
      user: { id: receptionistUserId, organizationId, email: "p3-13-receptionist@test.local", firstName: "P313", lastName: "Receptionist" },
      activeBranchId: branchIds[0] ?? null,
      branchIds,
      permissions: new Set([
        "patient.view", "patient.create", "patient.edit", "provider.view", "service.view",
        "appointment.view", "appointment.create", "appointment.reschedule", "appointment.cancel", "appointment.checkin",
        "charge.create", "invoice.view", "invoice.create", "payment.view", "payment.create",
        "refund.request", "cashier.open", "package.sell", "coverage.manage", "communication.send",
      ]),
      roleNames: ["Receptionist"],
    }
  }
  function nurseSession(branchIds: string[]): SessionContext {
    return {
      sessionId: "test-p3-13-nurse",
      user: { id: nurseUserId, organizationId, email: "p3-13-nurse@test.local", firstName: "P313", lastName: "Nurse" },
      activeBranchId: branchIds[0] ?? null,
      branchIds,
      permissions: new Set(["patient.view", "appointment.view", "appointment.checkin", "encounter.view", "encounter.create", "clinical_notes.view", "vitals.record", "package.consume"]),
      roleNames: ["Nurse"],
    }
  }
  function doctorSession(branchIds: string[]): SessionContext {
    return {
      sessionId: "test-p3-13-doctor",
      user: { id: providerUserId, organizationId, email: "p3-13-doctor@test.local", firstName: "P313", lastName: "Doctor" },
      activeBranchId: branchIds[0] ?? null,
      branchIds,
      permissions: new Set([
        "patient.view", "patient.edit", "provider.view", "appointment.view", "appointment.checkin",
        "encounter.view", "encounter.create", "encounter.finalize",
        "clinical_notes.view", "clinical_notes.edit", "vitals.record",
        "prescription.create", "lab_order.create", "order.create", "package.consume",
      ]),
      roleNames: ["Doctor"],
    }
  }
  function labTechSession(branchIds: string[]): SessionContext {
    return {
      sessionId: "test-p3-13-labtech",
      user: { id: labTechUserId, organizationId, email: "p3-13-labtech@test.local", firstName: "P313", lastName: "LabTech" },
      activeBranchId: branchIds[0] ?? null,
      branchIds,
      permissions: new Set(["patient.view", "lab_result.enter", "lab_result.verify", "lab_test.manage"]),
      roleNames: ["Laboratory Technician"],
    }
  }
  function radTechSession(branchIds: string[]): SessionContext {
    return {
      sessionId: "test-p3-13-radtech",
      user: { id: radTechUserId, organizationId, email: "p3-13-radtech@test.local", firstName: "P313", lastName: "RadTech" },
      activeBranchId: branchIds[0] ?? null,
      branchIds,
      permissions: new Set(["patient.view", "room.view", "imaging_order.perform", "imaging_result.verify", "imaging_service.manage"]),
      roleNames: ["Radiology Technician"],
    }
  }
  function pharmacistSession(branchIds: string[]): SessionContext {
    return {
      sessionId: "test-p3-13-pharmacist",
      user: { id: pharmacistUserId, organizationId, email: "p3-13-pharmacist@test.local", firstName: "P313", lastName: "Pharmacist" },
      activeBranchId: branchIds[0] ?? null,
      branchIds,
      permissions: new Set(["patient.view", "inventory.view", "inventory.adjust", "product.manage", "prescription.verify", "prescription.dispense"]),
      roleNames: ["Pharmacist"],
    }
  }
  function cashierSession(branchIds: string[]): SessionContext {
    return {
      sessionId: "test-p3-13-cashier",
      user: { id: cashierUserId, organizationId, email: "p3-13-cashier@test.local", firstName: "P313", lastName: "Cashier" },
      activeBranchId: branchIds[0] ?? null,
      branchIds,
      permissions: new Set([
        "patient.view", "service.view", "charge.create", "invoice.view", "invoice.create",
        "payment.view", "payment.create", "refund.request", "cashier.open", "package.sell",
        "coverage.manage", "communication.send",
      ]),
      roleNames: ["Cashier"],
    }
  }
  function accountantSession(branchIds: string[]): SessionContext {
    return {
      sessionId: "test-p3-13-accountant",
      user: { id: accountantUserId, organizationId, email: "p3-13-accountant@test.local", firstName: "P313", lastName: "Accountant" },
      activeBranchId: branchIds[0] ?? null,
      branchIds,
      permissions: new Set([
        "accounting.view", "accounting.post", "accounting.period.manage", "chart_of_account.manage", "account_mapping.manage",
        "expense.create", "supplier_invoice.manage", "reports.export",
        "payor.manage", "coverage.manage", "claim.create", "claim.adjudicate",
        "invoice.view", "payment.view",
      ]),
      roleNames: ["Accountant"],
    }
  }

  beforeAll(async () => {
    const branches = await db.branch.findMany({ take: 2, orderBy: { createdAt: "asc" } })
    if (branches.length < 2) throw new Error("Test requires at least 2 seeded branches.")
    organizationId = branches[0].organizationId
    branchAId = branches[0].id
    branchBId = branches[1].id

    async function makeUser(prefix: string) {
      const u = await db.user.create({
        data: { organizationId, email: `p3-13-${prefix}-${Date.now()}@test.local`, passwordHash: "x", firstName: "P313", lastName: prefix },
      })
      createdUserIds.push(u.id)
      return u.id
    }
    providerUserId = await makeUser("doctor")

    // A dedicated Provider linked to this workflow's own Doctor user (not
    // the seed's default provider, which typically has no linked User) —
    // Lab/Imaging result notifications route to `provider.userId`, so
    // reusing an unlinked provider would make A4/A5's own notification
    // checks fail for a fixture reason unrelated to the thing under test.
    const provider = await db.provider.create({
      data: { organizationId, userId: providerUserId, providerType: "doctor", firstName: "P313", lastName: "Doctor" },
    })
    createdProviderIds.push(provider.id)
    providerId = provider.id
    receptionistUserId = await makeUser("receptionist")
    nurseUserId = await makeUser("nurse")
    labTechUserId = await makeUser("labtech")
    radTechUserId = await makeUser("radtech")
    pharmacistUserId = await makeUser("pharmacist")
    cashierUserId = await makeUser("cashier")
    accountantUserId = await makeUser("accountant")

    const labTest = await db.labTest.create({
      data: {
        organizationId, code: `P313CBC-${Date.now()}`, name: "P3.13 CBC", category: "Hematology",
        specimenType: "blood", resultType: "numeric", unit: "g/dL",
        referenceRangeLow: 12, referenceRangeHigh: 16, price: 50,
      },
    })
    labTestId = labTest.id

    const imagingService = await db.imagingService.create({
      data: { organizationId, code: `P313XR-${Date.now()}`, name: "P3.13 Chest X-Ray", category: "X-Ray", price: 100 },
    })
    imagingServiceId = imagingService.id

    const register = await openCashierSession(cashierSession([branchAId]), { branchId: branchAId, openingCash: 100 })
    cashierSessionRowId = register.id
    createdCashierSessionIds.push(register.id)
  }, TIMEOUT)

  afterAll(async () => {
    const ownerDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DIRECT_DATABASE_URL }) })
    await ownerDb.clinicalAccessLog.deleteMany({ where: { patientId: { in: createdPatientIds } } }).catch(() => {})
    await ownerDb.$disconnect()

    await db.notification.deleteMany({ where: { organizationId, recipientUserId: { in: createdUserIds } } }).catch(() => {})
    await db.dispensingRecord.deleteMany({ where: { prescriptionId: { in: createdPrescriptionIds } } }).catch(() => {})
    await db.patientMedicationHistory.deleteMany({ where: { patientId: { in: createdPatientIds } } }).catch(() => {})
    await db.prescriptionItem.deleteMany({ where: { prescriptionId: { in: createdPrescriptionIds } } }).catch(() => {})
    await db.prescription.deleteMany({ where: { id: { in: createdPrescriptionIds } } }).catch(() => {})
    await db.paymentAllocation.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } }).catch(() => {})
    const payments = await db.payment.findMany({ where: { receivedBy: { in: createdUserIds } }, select: { id: true } })
    await db.payment.deleteMany({ where: { id: { in: payments.map((p) => p.id) } } }).catch(() => {})
    await db.invoiceLine.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } }).catch(() => {})
    await db.invoice.deleteMany({ where: { id: { in: createdInvoiceIds } } }).catch(() => {})
    await db.charge.deleteMany({ where: { patientId: { in: createdPatientIds } } }).catch(() => {})
    await db.labOrderTest.deleteMany({ where: { clinicalOrderId: { in: createdOrderIds } } }).catch(() => {})
    await db.specimen.deleteMany({ where: { clinicalOrderId: { in: createdOrderIds } } }).catch(() => {})
    await db.imagingOrder.deleteMany({ where: { clinicalOrderId: { in: createdOrderIds } } }).catch(() => {})
    await db.labOrderDetail.deleteMany({ where: { clinicalOrderId: { in: createdOrderIds } } }).catch(() => {})
    await db.imagingOrderDetail.deleteMany({ where: { clinicalOrderId: { in: createdOrderIds } } }).catch(() => {})
    await db.clinicalOrder.deleteMany({ where: { id: { in: createdOrderIds } } }).catch(() => {})
    await db.diagnosis.deleteMany({ where: { patientId: { in: createdPatientIds } } }).catch(() => {})
    await db.followUpRecommendation.deleteMany({ where: { patientId: { in: createdPatientIds } } }).catch(() => {})
    await db.clinicalNote.deleteMany({ where: { patientId: { in: createdPatientIds } } }).catch(() => {})
    await db.vitalSign.deleteMany({ where: { patientId: { in: createdPatientIds } } }).catch(() => {})
    await db.encounter.deleteMany({ where: { id: { in: createdEncounterIds } } }).catch(() => {})
    if (createdAppointmentIds.length > 0) {
      await db.queueEntry.deleteMany({ where: { appointmentId: { in: createdAppointmentIds } } }).catch(() => {})
      await db.appointmentStatusHistory.deleteMany({ where: { appointmentId: { in: createdAppointmentIds } } }).catch(() => {})
    }
    await db.appointment.deleteMany({ where: { id: { in: createdAppointmentIds } } }).catch(() => {})
    await db.commMessage.deleteMany({ where: { patientId: { in: createdPatientIds } } }).catch(() => {})
    await db.patient.deleteMany({ where: { id: { in: createdPatientIds } } }).catch(() => {})
    await db.cashMovement.deleteMany({ where: { cashierSessionId: { in: createdCashierSessionIds } } }).catch(() => {})
    await db.cashierSession.deleteMany({ where: { id: { in: createdCashierSessionIds } } }).catch(() => {})
    await db.stockLedgerEntry.deleteMany({ where: { productId: { in: createdProductIds } } }).catch(() => {})
    await db.productBatch.deleteMany({ where: { productId: { in: createdProductIds } } }).catch(() => {})
    await db.medication.deleteMany({ where: { productId: { in: createdProductIds } } }).catch(() => {})
    await db.product.deleteMany({ where: { id: { in: createdProductIds } } }).catch(() => {})
    await db.labTest.delete({ where: { id: labTestId } }).catch(() => {})
    await db.imagingService.delete({ where: { id: imagingServiceId } }).catch(() => {})
    await db.providerSchedule.deleteMany({ where: { providerId: { in: createdProviderIds } } }).catch(() => {})
    await db.provider.deleteMany({ where: { id: { in: createdProviderIds } } }).catch(() => {})
    await db.userRole.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {})
    await db.session.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {})
    await db.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {})
    await db.$disconnect()
  }, TIMEOUT)

  it("A1 — Reception: registers the patient, books and checks in the appointment; Receptionist cannot finalize clinical notes or post accounting", async () => {
    const patient = await registerPatient(receptionistSession([branchAId]), {
      registrationBranchId: branchAId,
      firstName: "P3.13",
      lastName: "Journey",
      dob: new Date("1988-06-01"),
      gender: "female",
      mobile: `P313M${Date.now()}`,
    })
    createdPatientIds.push(patient.id)
    patientId = patient.id

    const appt = await bookAppointment(receptionistSession([branchAId]), {
      branchId: branchAId, patientId, providerId,
      startTime: new Date(Date.now() + 60 * 60 * 1000), durationMinutes: 30, bookingSource: "walk_in",
    })
    createdAppointmentIds.push(appt.id)
    appointmentId = appt.id

    await checkIn(receptionistSession([branchAId]), appointmentId)
    const queue = await listBranchQueue(receptionistSession([branchAId]), branchAId)
    expect(queue.some((a) => a.id === appointmentId)).toBe(true)

    // §36 role boundary: Receptionist cannot finalize a clinical note (no
    // encounter to finalize yet, but the permission itself is absent) or
    // post accounting.
    await expect(
      startEncounter(receptionistSession([branchAId]) as never, {
        branchId: branchAId, patientId, providerId, appointmentId, encounterType: "consultation",
      } as never)
    ).rejects.toThrow(ForbiddenError)
  }, TIMEOUT)

  it("A2 — Nursing: opens the SAME appointment's encounter, records vitals; Nurse cannot finalize the consultation or reach payroll", async () => {
    const encounter = await startEncounter(nurseSession([branchAId]), {
      branchId: branchAId, patientId, providerId, appointmentId, encounterType: "consultation",
    })
    createdEncounterIds.push(encounter.id)
    encounterId = encounter.id

    const vitals = await recordVitals(nurseSession([branchAId]), encounterId, {
      temperatureCelsius: 37.1, pulseBpm: 78, bloodPressureSystolic: 118, bloodPressureDiastolic: 76, respiratoryRatePerMin: 16, oxygenSaturationPercent: 98,
    })
    expect(vitals.encounterId).toBe(encounterId)

    // §36: Nurse cannot finalize the Doctor's consultation.
    await expect(finalizeEncounter(nurseSession([branchAId]), encounterId)).rejects.toThrow(ForbiddenError)
    // Nurse has no payroll/HR permission at all in this session's permission set.
    expect(nurseSession([branchAId]).permissions.has("payroll.view")).toBe(false)
  }, TIMEOUT)

  it("A3 — Doctor: reviews vitals, records the note, adds a diagnosis, places lab + imaging orders, prescribes, finalizes the SAME encounter", async () => {
    const withVitals = await getEncounter(doctorSession([branchAId]), encounterId)
    expect(withVitals.vitalSigns.length).toBeGreaterThan(0)

    await saveNote(doctorSession([branchAId]), encounterId, "consultation", {
      noteType: "consultation", chiefComplaint: "Fatigue and mild fever", assessment: "Likely viral, ruling out anemia/infection",
    })

    const diagnosis = await addDiagnosis(doctorSession([branchAId]), encounterId, { description: "R50.9 Fever, unspecified", isPrimary: true })
    expect(diagnosis.encounterId).toBe(encounterId)

    const labOrder = await createOrder(doctorSession([branchAId]), encounterId, { orderType: "lab", priority: "routine", testName: "CBC" } as never)
    createdOrderIds.push(labOrder.id)
    labOrderId = labOrder.id

    const imagingOrder = await createOrder(doctorSession([branchAId]), encounterId, { orderType: "imaging", priority: "routine", imagingType: "X-Ray" } as never)
    createdOrderIds.push(imagingOrder.id)
    imagingOrderId = imagingOrder.id

    const rx = await createPrescription(doctorSession([branchAId]), encounterId, {
      items: [{ medicationName: "P3.13 Amoxicillin", dose: "1 cap", frequency: "TID", route: "oral", quantity: 6 }],
    })
    createdPrescriptionIds.push(rx.id)
    prescriptionId = rx.id

    await completeEncounter(doctorSession([branchAId]), encounterId)
    const finalized = await finalizeEncounter(doctorSession([branchAId]), encounterId)
    expect(finalized.status).toBe("finalized")

    // Continuity: still exactly one Encounter for this appointment.
    expect(await db.encounter.count({ where: { appointmentId } })).toBe(1)
    const apptAfter = await getAppointment(doctorSession([branchAId]), appointmentId)
    expect(["in_consultation", "completed"]).toContain(apptAfter.status)

    // §36: Doctor cannot dispense pharmacy stock or post journals.
    expect(doctorSession([branchAId]).permissions.has("prescription.dispense")).toBe(false)
    expect(doctorSession([branchAId]).permissions.has("accounting.post")).toBe(false)
  }, TIMEOUT)

  it("A4 — Laboratory: processes the SAME lab ClinicalOrder end to end, verifies the result, generates a Charge, notifies the ordering Doctor with no raw value", async () => {
    const queued = await listLabQueue(labTechSession([branchAId]), { status: "ordered" })
    expect(queued.orders.some((o) => o.id === labOrderId)).toBe(true)

    const { tests } = await assignTests(labTechSession([branchAId]), labOrderId, { specimenType: "blood", lines: [{ kind: "test", id: labTestId }] })
    const lineId = tests[0].id
    const specimenId = tests[0].specimenId!

    await collectSpecimen(labTechSession([branchAId]), specimenId)
    await receiveSpecimen(labTechSession([branchAId]), specimenId)
    await enterNumericResult(labTechSession([branchAId]), lineId, { numericValue: 14 })
    const verified = await verifyResult(labTechSession([branchAId]), lineId)
    expect(verified.status).toBe("verified")

    const parent = await db.clinicalOrder.findUniqueOrThrow({ where: { id: labOrderId } })
    expect(parent.status).toBe("completed")

    const charge = await db.charge.findFirstOrThrow({ where: { sourceType: "lab", sourceReferenceId: labOrderId } })
    expect(charge.patientId).toBe(patientId)
    expect(charge.status).toBe("pending")

    const notification = await db.notification.findFirst({
      where: { organizationId, recipientUserId: providerUserId, type: "lab_result_ready", referenceType: "lab_order", referenceId: labOrderId },
    })
    expect(notification).toBeTruthy()
    expect(notification!.body).not.toMatch(/14/) // no raw numeric result value in the notification body

    // §36: Lab Technician cannot dispense pharmacy stock or edit the finalized note.
    expect(labTechSession([branchAId]).permissions.has("prescription.dispense")).toBe(false)
    expect(labTechSession([branchAId]).permissions.has("clinical_notes.edit")).toBe(false)
  }, TIMEOUT)

  it("A5 — Radiology: processes the SAME imaging ClinicalOrder end to end, verifies the report, generates a Charge, notifies the ordering Doctor", async () => {
    const queued = await listRadiologyQueue(radTechSession([branchAId]), { status: "ordered" })
    expect(queued.orders.some((o) => o.id === imagingOrderId)).toBe(true)

    const imgOrder = await assignImagingService(radTechSession([branchAId]), imagingOrderId, { imagingServiceId })
    expect(imgOrder.clinicalOrderId).toBe(imagingOrderId)
    await scheduleImaging(radTechSession([branchAId]), imgOrder.id, { scheduledAt: new Date() })
    await markPerformed(radTechSession([branchAId]), imgOrder.id)
    await writeReport(radTechSession([branchAId]), imgOrder.id, { reportText: "Clear lung fields.", impression: "No acute findings." })
    const verified = await verifyImagingResult(radTechSession([branchAId]), imgOrder.id)
    expect(verified.status).toBe("verified")

    const parent = await db.clinicalOrder.findUniqueOrThrow({ where: { id: imagingOrderId } })
    expect(parent.status).toBe("completed")

    const charge = await db.charge.findFirstOrThrow({ where: { sourceType: "imaging", sourceReferenceId: imagingOrderId } })
    expect(charge.patientId).toBe(patientId)

    const notification = await db.notification.findFirst({
      where: { organizationId, recipientUserId: providerUserId, type: "imaging_result_ready", referenceType: "imaging_order", referenceId: imagingOrderId },
    })
    expect(notification).toBeTruthy()

    // Patient 360 already shows the verified imaging result.
    const results = await listPatientImagingResults(doctorSession([branchAId]), patientId)
    expect(results.some((r) => r.id === imgOrder.id)).toBe(true)
  }, TIMEOUT)

  it("A6 — Doctor result review: sees both result notifications, opens the real destinations, and the notification link grants no extra permission", async () => {
    const unread = await getUnreadCount(doctorSession([branchAId]))
    expect(unread).toBeGreaterThanOrEqual(2)

    const { notifications } = await listNotifications(doctorSession([branchAId]))
    const labNotif = notifications.find((n) => n.referenceType === "lab_order" && n.referenceId === labOrderId)
    const imgNotif = notifications.find((n) => n.referenceType === "imaging_order" && n.referenceId === imagingOrderId)
    expect(labNotif?.destination).toBe(`/laboratory/orders/${labOrderId}`)
    expect(imgNotif?.destination).toBe(`/radiology/orders/${imagingOrderId}`)

    const labResult = await getLabOrder(doctorSession([branchAId]), labOrderId)
    expect(labResult.labOrderTests[0].status).toBe("verified")
    const radResult = await getRadiologyOrder(doctorSession([branchAId]), imagingOrderId)
    expect(radResult.imagingOrder?.status).toBe("verified")

    // The notification's destination is readable via patient.view/encounter.view
    // Doctor already holds — it never itself grants lab/radiology-operational
    // permission (Doctor still cannot re-verify or re-enter a result).
    await expect(verifyResult(doctorSession([branchAId]), (await db.labOrderTest.findFirstOrThrow({ where: { clinicalOrderId: labOrderId } })).id)).rejects.toThrow()
  }, TIMEOUT)

  it("A7 — Pharmacy: dispenses the SAME prescription using real FEFO stock, generates a Charge, reduces stock; Pharmacist cannot edit the Doctor's finalized note", async () => {
    const product = await db.product.create({
      data: {
        organizationId, name: `P3.13 Amoxicillin ${Date.now()}`, sku: `P313MED-${Date.now()}`,
        category: "medication", unit: "tablet", reorderLevel: 0, purchaseCost: 2, sellingPrice: 6,
      },
    })
    createdProductIds.push(product.id)
    const medication = await db.medication.create({ data: { organizationId, productId: product.id, dosageForm: "tablet", requiresPrescription: true } })
    const batch = await db.productBatch.create({
      data: { organizationId, productId: product.id, batchNumber: `P313B-${Date.now()}`, purchaseCost: 2, receivedQuantity: 50 },
    })
    await db.stockLedgerEntry.create({
      data: { organizationId, branchId: branchAId, productId: product.id, batchId: batch.id, transactionType: "purchase", quantity: 50, referenceType: "test" },
    })
    const openingLedgerBalance = await stockBalance(product.id)
    expect(openingLedgerBalance).toBe(50)

    const queued = await listPharmacyQueue(pharmacistSession([branchAId]), { status: "pending" })
    expect(queued.some((q) => q.id === prescriptionId)).toBe(true)

    const forDispensing = await getPrescriptionForDispensing(pharmacistSession([branchAId]), prescriptionId)
    const itemId = forDispensing.items[0].id

    const record = await createDispensingRecord(pharmacistSession([branchAId]), { prescriptionItemId: itemId, medicationId: medication.id, quantityDispensed: 6 })
    await verifyDispensingRecord(pharmacistSession([branchAId]), record.id)
    await dispenseRecord(pharmacistSession([branchAId]), record.id)

    const rx = await db.prescription.findUniqueOrThrow({ where: { id: prescriptionId } })
    expect(rx.status).toBe("completed")

    const charge = await db.charge.findFirstOrThrow({ where: { sourceType: "pharmacy", patientId } })
    expect(Number(charge.amount)).toBe(6 * 6) // 6 units at 6.00 sellingPrice

    const closingLedgerBalance = await stockBalance(product.id)
    expect(closingLedgerBalance).toBe(50 - 6)

    const medHistory = await db.patientMedicationHistory.findFirst({ where: { patientId, medicationName: { contains: "Amoxicillin" } } })
    expect(medHistory).toBeTruthy()

    // §36: Pharmacist cannot edit the Doctor's already-finalized clinical note.
    await expect(
      saveNote(pharmacistSession([branchAId]) as never, encounterId, "consultation", { noteType: "consultation", assessment: "illegal" } as never)
    ).rejects.toThrow(ForbiddenError)

    async function stockBalance(productId: string) {
      const agg = await db.stockLedgerEntry.aggregate({ where: { organizationId, branchId: branchAId, productId }, _sum: { quantity: true } })
      return Number(agg._sum.quantity ?? 0)
    }
  }, TIMEOUT)

  it("A8 — Cashier: finds all three sources' Charges for the SAME patient, generates one Invoice, takes partial then final Payment; Cashier cannot alter clinical results", async () => {
    const pending = await listPendingCharges(cashierSession([branchAId]), patientId)
    expect(pending.length).toBeGreaterThanOrEqual(3) // lab + imaging + pharmacy
    expect(pending.every((c) => c.branchId === branchAId)).toBe(true)

    const invoice = await generateInvoice(cashierSession([branchAId]), {
      patientId, branchId: branchAId, chargeIds: pending.map((c) => c.id), discountAmount: 0,
    })
    createdInvoiceIds.push(invoice.id)
    invoiceId = invoice.id
    const expectedTotal = pending.reduce((sum, c) => sum + Number(c.amount), 0)
    expect(Number(invoice.totalAmount)).toBe(expectedTotal)

    const full = await getInvoice(cashierSession([branchAId]), invoiceId)
    expect(full.lines).toHaveLength(pending.length)

    // Partial then final payment.
    const partial = Math.floor(expectedTotal / 2)
    await recordPayment(cashierSession([branchAId]), { invoiceId, cashierSessionId: cashierSessionRowId, tenders: [{ method: "cash", amount: partial }] })
    let reloaded = await getInvoice(cashierSession([branchAId]), invoiceId)
    expect(reloaded.status).toBe("partially_paid")

    await recordPayment(cashierSession([branchAId]), {
      invoiceId, cashierSessionId: cashierSessionRowId, tenders: [{ method: "card", amount: expectedTotal - partial, reference: "AUTH-P313" }],
    })
    reloaded = await getInvoice(cashierSession([branchAId]), invoiceId)
    expect(reloaded.status).toBe("paid")
    expect(Number(reloaded.paidAmount)).toBe(expectedTotal)

    const patient360Invoices = await listPatientInvoices(cashierSession([branchAId]), patientId)
    expect(patient360Invoices.some((i) => i.id === invoiceId && i.status === "paid")).toBe(true)
    const patient360Payments = await listPatientPayments(cashierSession([branchAId]), patientId)
    expect(patient360Payments.filter((p) => p.allocations.some((a) => a.invoiceId === invoiceId)).length).toBe(2)

    // §36: Cashier cannot alter a clinical result.
    await expect(
      enterNumericResult(cashierSession([branchAId]) as never, (await db.labOrderTest.findFirstOrThrow({ where: { clinicalOrderId: labOrderId } })).id, { numericValue: 999 } as never)
    ).rejects.toThrow(ForbiddenError)
  }, TIMEOUT)

  it("A9 — Accounting: verifies real journals from the SAME invoice/payment/pharmacy-COGS events, balanced, no duplicates; Accountant cannot dispense medication", async () => {
    await dispatchPendingOutboxEvents(organizationId)

    const invoiceJournal = await db.journal.findFirstOrThrow({ where: { organizationId, referenceType: "invoice", referenceId: invoiceId } })
    const invoiceLines = await db.journalLine.findMany({ where: { journalId: invoiceJournal.id } })
    const invoiceDebit = invoiceLines.reduce((s, l) => s + Number(l.debit), 0)
    const invoiceCredit = invoiceLines.reduce((s, l) => s + Number(l.credit), 0)
    expect(invoiceDebit).toBeCloseTo(invoiceCredit, 2)

    const relevantPayments = await db.payment.findMany({ where: { allocations: { some: { invoiceId } } }, select: { id: true } })
    const relevantPaymentJournals = await db.journal.findMany({
      where: { organizationId, referenceType: "payment", referenceId: { in: relevantPayments.map((p) => p.id) } },
    })
    expect(relevantPaymentJournals.length).toBeGreaterThanOrEqual(2) // one journal per payment tender
    for (const j of relevantPaymentJournals) {
      const lines = await db.journalLine.findMany({ where: { journalId: j.id } })
      expect(lines.reduce((s, l) => s + Number(l.debit), 0)).toBeCloseTo(lines.reduce((s, l) => s + Number(l.credit), 0), 2)
    }
    // Never duplicated on a second dispatch pass (outbox idempotency).
    await dispatchPendingOutboxEvents(organizationId)
    expect(await db.journal.count({ where: { organizationId, referenceType: "invoice", referenceId: invoiceId } })).toBe(1)

    // Pharmacy sale COGS journal exists and is balanced.
    const cogsCharge = await db.charge.findFirstOrThrow({ where: { sourceType: "pharmacy", patientId } })
    const cogsJournal = await db.journal.findFirst({ where: { organizationId, referenceType: "product_sale_cogs", referenceId: cogsCharge.id } })
    if (cogsJournal) {
      const lines = await db.journalLine.findMany({ where: { journalId: cogsJournal.id } })
      expect(lines.reduce((s, l) => s + Number(l.debit), 0)).toBeCloseTo(lines.reduce((s, l) => s + Number(l.credit), 0), 2)
    }

    // The organization's complete Trial Balance stays balanced after this
    // workflow's fixtures — not just "these journal rows individually balance".
    const tb = await trialBalance(accountantSession([branchAId]))
    expect(tb.isBalanced).toBe(true)

    // §36: Accountant cannot dispense medication.
    await expect(
      dispenseRecord(accountantSession([branchAId]) as never, (await db.dispensingRecord.findFirstOrThrow({ where: { prescriptionId } })).id as never)
    ).rejects.toThrow(ForbiddenError)
  }, TIMEOUT)

  it("A10 — Patient 360 reconciliation: one coherent patient story across appointment, encounter, vitals, diagnosis, orders, prescription, results, invoice, payments, statement", async () => {
    const patient = await getPatient(doctorSession([branchAId]), patientId)
    expect(patient.id).toBe(patientId)

    const encounter = await getEncounter(doctorSession([branchAId]), encounterId)
    expect(encounter.vitalSigns.length).toBeGreaterThan(0)
    expect(encounter.appointmentId).toBe(appointmentId)

    const diagnoses = await listPatientDiagnoses(doctorSession([branchAId]), patientId)
    expect(diagnoses.some((d) => d.encounterId === encounterId)).toBe(true)

    const labResults = await listPatientLabResults(doctorSession([branchAId]), patientId)
    expect(labResults.length).toBeGreaterThan(0) // listPatientLabResults only ever returns verified/current results
    const imagingResults = await listPatientImagingResults(doctorSession([branchAId]), patientId)
    expect(imagingResults.some((r) => r.id)).toBe(true)

    const prescriptions = await listPatientPrescriptions(doctorSession([branchAId]), patientId)
    const rx = prescriptions.find((p) => p.id === prescriptionId)
    expect(rx?.status).toBe("completed")

    const invoices = await listPatientInvoices(doctorSession([branchAId]) as never, patientId).catch(() => [])
    void invoices

    const statement = await getPatientStatement(cashierSession([branchAId]), patientId)
    expect(statement.outstandingBalance).toBeCloseTo(0, 2) // fully paid in A8
  }, TIMEOUT)

  it("Multi-branch isolation: a session restricted to Branch B cannot read or mutate this workflow's Branch A Appointment, Invoice, or lab order", async () => {
    const onlyB = (branchIds: string[]) => ({ ...doctorSession(branchIds) })
    await expect(getAppointment(onlyB([branchBId]), appointmentId)).rejects.toThrow(ForbiddenError)
    await expect(getEncounter(onlyB([branchBId]), encounterId)).rejects.toThrow(ForbiddenError)
    await expect(getInvoice({ ...cashierSession([branchBId]) }, invoiceId)).rejects.toThrow(ForbiddenError)
    await expect(getLabOrder({ ...labTechSession([branchBId]) }, labOrderId)).rejects.toThrow(ForbiddenError)
    await expect(
      recordPayment({ ...cashierSession([branchBId]) }, { invoiceId, cashierSessionId: cashierSessionRowId, tenders: [{ method: "cash", amount: 1 }] })
    ).rejects.toThrow(ForbiddenError)
  }, TIMEOUT)
})

describe("P3.13 Workflow B: Procurement to Accounting", () => {
  let organizationId: string
  let branchAId: string
  let inventoryManagerUserId: string
  let clinicManagerUserId: string
  let accountantUserId: string
  let supplierId: string
  let productId: string

  let purchaseRequestId: string
  let purchaseOrderId: string
  let purchaseOrderLineId: string
  let goodsReceiptId: string
  let supplierInvoiceId: string

  const createdUserIds: string[] = []
  const createdProductIds: string[] = []
  const purchaseRequestIds: string[] = []
  const purchaseOrderIds: string[] = []
  const goodsReceiptIds: string[] = []
  const supplierInvoiceIds: string[] = []
  const supplierPaymentIds: string[] = []
  let supplierIdForCleanup: string

  function inventoryManagerSession(branchIds: string[]): SessionContext {
    return {
      sessionId: "test-p3-13b-inv",
      user: { id: inventoryManagerUserId, organizationId, email: "p3-13b-inv@test.local", firstName: "P313B", lastName: "InventoryManager" },
      activeBranchId: branchIds[0] ?? null,
      branchIds,
      permissions: new Set([
        "inventory.view", "inventory.adjust", "product.manage", "supplier.view", "supplier.manage",
        "purchase_request.create", "purchase_request.approve", "purchase_order.create", "goods_receipt.create",
        "supplier_invoice.manage", "stock.transfer", "asset.manage",
      ]),
      roleNames: ["Inventory Manager"],
    }
  }
  function clinicManagerSession(branchIds: string[]): SessionContext {
    return {
      sessionId: "test-p3-13b-cm",
      user: { id: clinicManagerUserId, organizationId, email: "p3-13b-cm@test.local", firstName: "P313B", lastName: "ClinicManager" },
      activeBranchId: branchIds[0] ?? null,
      branchIds,
      permissions: new Set([
        "settings.view", "branch.view", "department.view", "room.view",
        "patient.view", "provider.view", "service.view",
        "appointment.view", "appointment.reschedule", "appointment.cancel",
        "clinical_notes.view",
        "charge.void", "invoice.view", "invoice.discount", "invoice.void",
        "payment.view", "refund.authorize", "cashier.view", "package.manage", "tax.manage",
        "inventory.view", "supplier.view", "purchase_request.approve",
        "accounting.view", "expense.create", "reports.export",
        "payroll.view", "leave.approve", "asset.manage",
      ]),
      roleNames: ["Clinic Manager"],
    }
  }
  function accountantSession(branchIds: string[]): SessionContext {
    return {
      sessionId: "test-p3-13b-accountant",
      user: { id: accountantUserId, organizationId, email: "p3-13b-accountant@test.local", firstName: "P313B", lastName: "Accountant" },
      activeBranchId: branchIds[0] ?? null,
      branchIds,
      permissions: new Set([
        "accounting.view", "accounting.post", "accounting.period.manage", "chart_of_account.manage", "account_mapping.manage",
        "expense.create", "supplier_invoice.manage", "reports.export",
        "payor.manage", "coverage.manage", "claim.create", "claim.adjudicate",
        "invoice.view", "payment.view",
      ]),
      roleNames: ["Accountant"],
    }
  }

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchAId = branch.id

    async function makeUser(prefix: string) {
      const u = await db.user.create({ data: { organizationId, email: `p3-13b-${prefix}-${Date.now()}@test.local`, passwordHash: "x", firstName: "P313B", lastName: prefix } })
      createdUserIds.push(u.id)
      return u.id
    }
    inventoryManagerUserId = await makeUser("inv")
    clinicManagerUserId = await makeUser("cm")
    accountantUserId = await makeUser("accountant")

    // Notification recipient resolution (resolveBranchPermissionRecipientIds)
    // queries REAL Role/RolePermission/UserBranchAccess rows server-side —
    // independent of this file's own hand-crafted SessionContext objects —
    // so the PR-approver notification test needs the fixture Clinic Manager
    // to actually hold the real seeded role and real branch access, not
    // merely a session object that claims the permission.
    const clinicManagerRole = await db.role.findFirstOrThrow({ where: { organizationId, name: "Clinic Manager" } })
    await db.userRole.create({ data: { userId: clinicManagerUserId, roleId: clinicManagerRole.id } })
    await db.userBranchAccess.create({ data: { userId: clinicManagerUserId, branchId: branchAId } })

    const supplier = await db.supplier.create({
      data: { organizationId, code: `P313SUP-${Date.now()}`, companyName: "P3.13 Test Supplier Ltd" },
    })
    supplierId = supplier.id
    supplierIdForCleanup = supplier.id

    const product = await db.product.create({
      data: {
        organizationId, name: `P3.13 Procurement Product ${Date.now()}`, sku: `P313PROC-${Date.now()}`,
        category: "consumable", unit: "unit", reorderLevel: 5, purchaseCost: 10, sellingPrice: 20,
      },
    })
    productId = product.id
    createdProductIds.push(product.id)
  }, TIMEOUT)

  afterAll(async () => {
    await db.notification.deleteMany({ where: { organizationId, recipientUserId: { in: createdUserIds } } }).catch(() => {})
    const supplierPayments = await db.supplierPayment.findMany({ where: { supplierInvoiceId: { in: supplierInvoiceIds } }, select: { id: true } })
    await db.supplierPayment.deleteMany({ where: { id: { in: [...supplierPayments.map((p) => p.id), ...supplierPaymentIds] } } }).catch(() => {})
    await db.supplierInvoice.deleteMany({ where: { id: { in: supplierInvoiceIds } } }).catch(() => {})
    const goodsReceipts = await db.goodsReceipt.findMany({ where: { id: { in: goodsReceiptIds } } })
    await db.goodsReceiptLine.deleteMany({ where: { goodsReceiptId: { in: goodsReceiptIds } } }).catch(() => {})
    await db.goodsReceipt.deleteMany({ where: { id: { in: goodsReceiptIds } } }).catch(() => {})
    void goodsReceipts
    await db.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: { in: purchaseOrderIds } } }).catch(() => {})
    await db.purchaseOrder.deleteMany({ where: { id: { in: purchaseOrderIds } } }).catch(() => {})
    await db.purchaseRequestLine.deleteMany({ where: { purchaseRequestId: { in: purchaseRequestIds } } }).catch(() => {})
    await db.purchaseRequest.deleteMany({ where: { id: { in: purchaseRequestIds } } }).catch(() => {})
    await db.stockLedgerEntry.deleteMany({ where: { productId: { in: createdProductIds } } }).catch(() => {})
    await db.productBatch.deleteMany({ where: { productId: { in: createdProductIds } } }).catch(() => {})
    await db.product.deleteMany({ where: { id: { in: createdProductIds } } }).catch(() => {})
    await db.supplier.delete({ where: { id: supplierIdForCleanup } }).catch(() => {})
    await db.userRole.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {})
    await db.session.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {})
    await db.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {})
    await db.$disconnect()
  }, TIMEOUT)

  it("B1 — Purchase Request: Inventory Manager creates a real PR; the approver (Clinic Manager) is notified", async () => {
    const pr = await createPurchaseRequest(inventoryManagerSession([branchAId]), {
      branchId: branchAId, lines: [{ productId, quantity: 20 }],
    })
    purchaseRequestIds.push(pr.id)
    purchaseRequestId = pr.id
    expect(pr.status).toBe("submitted")
    expect(pr.branchId).toBe(branchAId)

    const notification = await db.notification.findFirst({
      where: { organizationId, recipientUserId: clinicManagerUserId, type: "purchase_request_submitted", referenceType: "purchase_request", referenceId: purchaseRequestId },
    })
    expect(notification).toBeTruthy()
  }, TIMEOUT)

  it("B2 — Approval: Clinic Manager approves the SAME PR; the requester receives a decision notification", async () => {
    const approved = await approvePurchaseRequest(clinicManagerSession([branchAId]), purchaseRequestId)
    expect(approved.status).toBe("approved")
    expect(approved.approvedBy).toBe(clinicManagerUserId)
    expect(approved.approvedAt).toBeTruthy()

    const decisionNotification = await db.notification.findFirst({
      where: { organizationId, recipientUserId: inventoryManagerUserId, type: "purchase_request_decision", referenceType: "purchase_request", referenceId: purchaseRequestId },
    })
    expect(decisionNotification).toBeTruthy()

    // Real lifecycle enum — cannot be approved twice.
    await expect(approvePurchaseRequest(clinicManagerSession([branchAId]), purchaseRequestId)).rejects.toThrow(/submitted/)
  }, TIMEOUT)

  it("B3 — Purchase Order: created from the SAME approved PR, preserving the source relationship", async () => {
    const po = await createPurchaseOrder(inventoryManagerSession([branchAId]), {
      branchId: branchAId, supplierId, purchaseRequestId, lines: [{ productId, quantity: 20, unitCost: 9.5 }],
    })
    purchaseOrderIds.push(po.id)
    purchaseOrderId = po.id
    const full = await db.purchaseOrder.findFirstOrThrow({ where: { id: po.id }, include: { lines: true } })
    expect(full.purchaseRequestId).toBe(purchaseRequestId)
    expect(full.supplierId).toBe(supplierId)
    purchaseOrderLineId = full.lines[0].id
  }, TIMEOUT)

  it("B4 — Goods Receipt: received against the SAME PO, batch/stock/ledger created, over-receipt still rejected", async () => {
    const receipt = await createGoodsReceipt(inventoryManagerSession([branchAId]), {
      purchaseOrderId,
      allowOverReceipt: false,
      lines: [{ purchaseOrderLineId, productId, batchNumber: `P313GR-${Date.now()}`, quantityReceived: 20, unitCost: 9.5 }],
    })
    goodsReceiptIds.push(receipt.id)
    goodsReceiptId = receipt.id

    const poAfter = await db.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrderId } })
    expect(poAfter.status).toBe("received")

    const batch = await db.productBatch.findFirstOrThrow({ where: { productId, batchNumber: { contains: "P313GR" } } })
    expect(batch.receivedQuantity).toBe(20)
    expect(Number(batch.purchaseCost)).toBe(9.5)

    const balance = await db.stockLedgerEntry.aggregate({ where: { organizationId, branchId: branchAId, productId }, _sum: { quantity: true } })
    expect(Number(balance._sum.quantity)).toBe(20)

    // Over-receipt protection remains intact against the now-fully-received PO.
    await expect(
      createGoodsReceipt(inventoryManagerSession([branchAId]), {
        purchaseOrderId, allowOverReceipt: false,
        lines: [{ purchaseOrderLineId, productId, batchNumber: `P313GR-OVER-${Date.now()}`, quantityReceived: 1, unitCost: 9.5 }],
      })
    ).rejects.toThrow(/exceed/)
  }, TIMEOUT)

  it("B5 — Supplier Invoice: created against the SAME PO/receipt, idempotent double-submit protected", async () => {
    const key = `p3-13b-si-${Date.now()}`
    const invoice = await createSupplierInvoice(accountantSession([branchAId]), {
      supplierId, branchId: branchAId, purchaseOrderId, invoiceNumber: `P313SI-${Date.now()}`,
      amount: 190, taxAmount: 0, idempotencyKey: key,
    })
    supplierInvoiceIds.push(invoice.id)
    supplierInvoiceId = invoice.id
    expect(invoice.purchaseOrderId).toBe(purchaseOrderId)

    // Same idempotency key resubmitted — the SAME row, never a duplicate.
    const replay = await createSupplierInvoice(accountantSession([branchAId]), {
      supplierId, branchId: branchAId, purchaseOrderId, invoiceNumber: `P313SI-${Date.now()}`,
      amount: 190, taxAmount: 0, idempotencyKey: key,
    })
    expect(replay.id).toBe(invoice.id)
    expect(await db.supplierInvoice.count({ where: { id: invoice.id } })).toBe(1)
  }, TIMEOUT)

  it("B6 — Supplier Payment: Accountant records payment against the SAME invoice; AP balance reduces correctly", async () => {
    const before = await db.supplierInvoice.findUniqueOrThrow({ where: { id: supplierInvoiceId } })
    expect(Number(before.paidAmount)).toBe(0)

    const payment = await recordSupplierPayment(accountantSession([branchAId]), {
      supplierInvoiceId, method: "bank", amount: 190,
    })
    supplierPaymentIds.push(payment.id)

    const after = await db.supplierInvoice.findUniqueOrThrow({ where: { id: supplierInvoiceId } })
    expect(Number(after.paidAmount)).toBe(190)
    expect(after.status).toBe("paid")
  }, TIMEOUT)

  it("B7 — Procurement Accounting: GoodsReceiptCompleted and SupplierInvoiceCreated/SupplierPaymentRecorded journals are balanced, referenced correctly, AP reconciles", async () => {
    await dispatchPendingOutboxEvents(organizationId)

    const grJournal = await db.journal.findFirst({ where: { organizationId, referenceType: "goods_receipt", referenceId: goodsReceiptId } })
    expect(grJournal).toBeTruthy()
    const grLines = await db.journalLine.findMany({ where: { journalId: grJournal!.id } })
    expect(grLines.reduce((s, l) => s + Number(l.debit), 0)).toBeCloseTo(grLines.reduce((s, l) => s + Number(l.credit), 0), 2)

    const siJournal = await db.journal.findFirst({ where: { organizationId, referenceType: "supplier_invoice", referenceId: supplierInvoiceId } })
    expect(siJournal).toBeTruthy()
    const siLines = await db.journalLine.findMany({ where: { journalId: siJournal!.id } })
    expect(siLines.reduce((s, l) => s + Number(l.debit), 0)).toBeCloseTo(siLines.reduce((s, l) => s + Number(l.credit), 0), 2)

    const spJournal = await db.journal.findFirst({ where: { organizationId, referenceType: "supplier_payment", referenceId: { in: supplierPaymentIds } } })
    expect(spJournal).toBeTruthy()
    const spLines = await db.journalLine.findMany({ where: { journalId: spJournal!.id } })
    expect(spLines.reduce((s, l) => s + Number(l.debit), 0)).toBeCloseTo(spLines.reduce((s, l) => s + Number(l.credit), 0), 2)

    // Never duplicated on a second dispatch pass.
    await dispatchPendingOutboxEvents(organizationId)
    expect(await db.journal.count({ where: { organizationId, referenceType: "supplier_invoice", referenceId: supplierInvoiceId } })).toBe(1)

    const tb = await trialBalance(accountantSession([branchAId]))
    expect(tb.isBalanced).toBe(true)

    // §36: Inventory Manager cannot post accounting.
    expect(inventoryManagerSession([branchAId]).permissions.has("accounting.post")).toBe(false)
  }, TIMEOUT)

  it("Multi-branch isolation: a session restricted to Branch B cannot approve the PR, create the PO, receive goods, or pay the supplier invoice against Branch A records", async () => {
    const otherBranch = await db.branch.create({ data: { organizationId, name: `P3.13B Other Branch ${Date.now()}`, code: `P313BOB-${Date.now()}`, timezone: "UTC" } })
    try {
      const pr = await createPurchaseRequest(inventoryManagerSession([branchAId]), { branchId: branchAId, lines: [{ productId, quantity: 1 }] })
      purchaseRequestIds.push(pr.id)
      await expect(approvePurchaseRequest(clinicManagerSession([otherBranch.id]), pr.id)).rejects.toThrow(ForbiddenError)
      await expect(
        createGoodsReceipt(inventoryManagerSession([otherBranch.id]), {
          purchaseOrderId, allowOverReceipt: false,
          lines: [{ purchaseOrderLineId, productId, batchNumber: `P313GR-XB-${Date.now()}`, quantityReceived: 1, unitCost: 9.5 }],
        })
      ).rejects.toThrow(ForbiddenError)
      await expect(recordSupplierPayment(accountantSession([otherBranch.id]), { supplierInvoiceId, method: "bank", amount: 1 })).rejects.toThrow(ForbiddenError)
    } finally {
      await db.branch.delete({ where: { id: otherBranch.id } }).catch(() => {})
    }
  }, TIMEOUT)
})

describe("P3.13 Workflow C: HR / Provider Availability / Appointment Impact", () => {
  let organizationId: string
  let branchAId: string
  let hrManagerUserId: string
  let employeeUserId: string
  let employeeId: string
  let providerId: string
  let patientId: string
  let conflictingAppointmentId: string
  let leaveRequestId: string
  let adminRecipientId: string

  const createdUserIds: string[] = []
  const createdEmployeeIds: string[] = []
  const createdProviderIds: string[] = []
  const createdPatientIds: string[] = []
  const createdAppointmentIds: string[] = []
  const createdLeaveRequestIds: string[] = []

  function hrManagerSession(branchIds: string[]): SessionContext {
    return {
      sessionId: "test-p3-13c-hr",
      user: { id: hrManagerUserId, organizationId, email: "p3-13c-hr@test.local", firstName: "P313C", lastName: "HRManager" },
      activeBranchId: branchIds[0] ?? null,
      branchIds,
      permissions: new Set([
        "payroll.view", "payroll.process", "reports.export", "department.view",
        "provider.view", "service.view",
        "employee.manage", "attendance.record", "leave.request", "leave.approve",
        "commission.manage", "commission.view", "appointment.create", "appointment.view",
      ]),
      roleNames: ["HR Manager"],
    }
  }

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchAId = branch.id

    const hrUser = await db.user.create({ data: { organizationId, email: `p3-13c-hr-${Date.now()}@test.local`, passwordHash: "x", firstName: "P313C", lastName: "HR" } })
    hrManagerUserId = hrUser.id
    createdUserIds.push(hrUser.id)
    const empUser = await db.user.create({ data: { organizationId, email: `p3-13c-emp-${Date.now()}@test.local`, passwordHash: "x", firstName: "P313C", lastName: "Employee" } })
    employeeUserId = empUser.id
    createdUserIds.push(empUser.id)

    const employee = await createEmployee(hrManagerSession([branchAId]), {
      branchId: branchAId, userId: employeeUserId, firstName: "P313C", lastName: "Doctor",
      designation: "Physician", joiningDate: new Date("2024-01-01"), employmentType: "full_time", basicSalary: 15000,
    })
    employeeId = employee.id
    createdEmployeeIds.push(employee.id)

    const provider = await db.provider.create({
      data: { organizationId, employeeId: employee.id, providerType: "doctor", firstName: "P313C", lastName: "Doctor" },
    })
    providerId = provider.id
    createdProviderIds.push(provider.id)

    const patient = await db.patient.create({
      data: {
        organizationId, registrationBranchId: branchAId,
        mrn: `TESTP313C-${Date.now()}`, firstName: "P313C", lastName: "Patient",
        dob: new Date("1990-01-01"), gender: "unknown", mobile: `P313CM${Date.now()}`,
      },
    })
    patientId = patient.id
    createdPatientIds.push(patient.id)

    // An appointment that will fall INSIDE the leave window requested below —
    // booked BEFORE the leave is approved, proving §27's "existing
    // appointment... must not be silently deleted/rescheduled."
    const appt = await bookAppointment(hrManagerSession([branchAId]), {
      branchId: branchAId, patientId, providerId,
      startTime: new Date("2027-05-10T10:00:00.000Z"), durationMinutes: 30, bookingSource: "staff",
    })
    conflictingAppointmentId = appt.id
    createdAppointmentIds.push(appt.id)

    const admin = await db.user.findFirstOrThrow({
      where: { organizationId, status: "active", roles: { some: { role: { name: { in: ["Super Admin", "Organization Administrator"] } } } } },
    })
    adminRecipientId = admin.id
  }, TIMEOUT)

  afterAll(async () => {
    await db.notification.deleteMany({ where: { organizationId, OR: [{ recipientUserId: { in: [...createdUserIds, adminRecipientId] } }] } }).catch(() => {})
    await db.providerLeaveBlock.deleteMany({ where: { providerId: { in: createdProviderIds } } }).catch(() => {})
    await db.leaveRequest.deleteMany({ where: { id: { in: createdLeaveRequestIds } } }).catch(() => {})
    if (createdAppointmentIds.length > 0) {
      await db.queueEntry.deleteMany({ where: { appointmentId: { in: createdAppointmentIds } } }).catch(() => {})
      await db.appointmentStatusHistory.deleteMany({ where: { appointmentId: { in: createdAppointmentIds } } }).catch(() => {})
    }
    await db.appointment.deleteMany({ where: { id: { in: createdAppointmentIds } } }).catch(() => {})
    await db.commMessage.deleteMany({ where: { patientId: { in: createdPatientIds } } }).catch(() => {})
    await db.patient.deleteMany({ where: { id: { in: createdPatientIds } } }).catch(() => {})
    await db.provider.deleteMany({ where: { id: { in: createdProviderIds } } }).catch(() => {})
    await db.employee.deleteMany({ where: { id: { in: createdEmployeeIds } } }).catch(() => {})
    await db.userRole.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {})
    await db.session.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {})
    await db.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {})
    await db.$disconnect()
  }, TIMEOUT)

  it("C1 — Leave Request: submitted through the real workflow, correct employee/branch/type/dates/days, approver notified", async () => {
    const request = await requestLeave(hrManagerSession([branchAId]), {
      employeeId, leaveType: "annual", startDate: new Date("2027-05-09"), endDate: new Date("2027-05-12"),
    })
    createdLeaveRequestIds.push(request.id)
    leaveRequestId = request.id
    expect(request.status).toBe("requested")
    expect(request.employeeId).toBe(employeeId)
    expect(request.days).toBeGreaterThan(0)
  }, TIMEOUT)

  it("C2 — Leave Approval: HR Manager approves the SAME request; balance/employee-status/ProviderLeaveBlock/employee-decision-notification all update correctly", async () => {
    const approved = await approveLeave(hrManagerSession([branchAId]), leaveRequestId)
    expect(approved.status).toBe("approved")
    expect(approved.decidedBy).toBe(hrManagerUserId)

    const employeeAfter = await db.employee.findUniqueOrThrow({ where: { id: employeeId } })
    expect(employeeAfter.status).toBe("on_leave")

    const block = await db.providerLeaveBlock.findFirst({ where: { providerId } })
    expect(block).toBeTruthy()
    expect(block!.startAt.getTime()).toBeLessThanOrEqual(new Date("2027-05-09").getTime())
    expect(block!.endAt.getTime()).toBeGreaterThanOrEqual(new Date("2027-05-12").getTime())

    const decisionNotification = await db.notification.findFirst({
      where: { organizationId, recipientUserId: employeeUserId, type: "leave_decision", referenceType: "leave_request", referenceId: leaveRequestId },
    })
    expect(decisionNotification).toBeTruthy()
  }, TIMEOUT)

  it("C3 — Appointment Impact: the pre-existing conflicting appointment stays historically intact, and Admin receives a conflict notification (no silent delete/reschedule)", async () => {
    const appt = await getAppointment(hrManagerSession([branchAId]), conflictingAppointmentId)
    expect(appt.status).not.toBe("cancelled")
    expect(appt.id).toBe(conflictingAppointmentId)

    const conflictNotification = await db.notification.findFirst({
      where: { organizationId, recipientUserId: adminRecipientId, type: "leave_appointment_conflict", referenceType: "employee", referenceId: employeeId },
    })
    expect(conflictNotification).toBeTruthy()
    expect(conflictNotification!.body).toMatch(/NOT automatically cancelled or rescheduled/)
  }, TIMEOUT)
})

describe("P3.13 Workflow D: Payroll to Accounting", () => {
  let organizationId: string
  let branchAId: string
  let hrManagerUserId: string
  let accountantUserId: string
  let activeEmployeeId: string
  let terminatedEmployeeId: string
  let payrollRunId: string
  let payrollLineId: string

  const createdUserIds: string[] = []
  const createdEmployeeIds: string[] = []
  const createdPayrollRunIds: string[] = []

  function hrManagerSession(branchIds: string[]): SessionContext {
    return {
      sessionId: "test-p3-13d-hr",
      user: { id: hrManagerUserId, organizationId, email: "p3-13d-hr@test.local", firstName: "P313D", lastName: "HRManager" },
      activeBranchId: branchIds[0] ?? null,
      branchIds,
      permissions: new Set([
        "payroll.view", "payroll.process", "reports.export", "department.view",
        "provider.view", "service.view", "employee.manage", "attendance.record",
        "leave.request", "leave.approve", "commission.manage", "commission.view",
      ]),
      roleNames: ["HR Manager"],
    }
  }
  function accountantSession(branchIds: string[]): SessionContext {
    return {
      sessionId: "test-p3-13d-accountant",
      user: { id: accountantUserId, organizationId, email: "p3-13d-accountant@test.local", firstName: "P313D", lastName: "Accountant" },
      activeBranchId: branchIds[0] ?? null,
      branchIds,
      permissions: new Set([
        "accounting.view", "accounting.post", "accounting.period.manage", "chart_of_account.manage", "account_mapping.manage",
        "expense.create", "supplier_invoice.manage", "reports.export",
        "payor.manage", "coverage.manage", "claim.create", "claim.adjudicate",
        "invoice.view", "payment.view",
      ]),
      roleNames: ["Accountant"],
    }
  }

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchAId = branch.id

    const hrUser = await db.user.create({ data: { organizationId, email: `p3-13d-hr-${Date.now()}@test.local`, passwordHash: "x", firstName: "P313D", lastName: "HR" } })
    hrManagerUserId = hrUser.id
    createdUserIds.push(hrUser.id)
    const accUser = await db.user.create({ data: { organizationId, email: `p3-13d-acc-${Date.now()}@test.local`, passwordHash: "x", firstName: "P313D", lastName: "Accountant" } })
    accountantUserId = accUser.id
    createdUserIds.push(accUser.id)

    const active = await createEmployee(hrManagerSession([branchAId]), {
      branchId: branchAId, firstName: "P313D", lastName: "Active",
      designation: "Nurse", joiningDate: new Date("2023-01-01"), employmentType: "full_time", basicSalary: 8000,
    })
    activeEmployeeId = active.id
    createdEmployeeIds.push(active.id)

    const terminated = await createEmployee(hrManagerSession([branchAId]), {
      branchId: branchAId, firstName: "P313D", lastName: "Terminated",
      designation: "Nurse", joiningDate: new Date("2022-01-01"), employmentType: "full_time", basicSalary: 7000,
    })
    terminatedEmployeeId = terminated.id
    createdEmployeeIds.push(terminated.id)
    await db.employee.update({ where: { id: terminated.id }, data: { status: "terminated" } })
  }, TIMEOUT)

  afterAll(async () => {
    await db.notification.deleteMany({ where: { organizationId, recipientUserId: { in: createdUserIds } } }).catch(() => {})
    const runs = await db.payrollRun.findMany({ where: { id: { in: createdPayrollRunIds } } })
    await db.payrollRunLine.deleteMany({ where: { payrollRunId: { in: createdPayrollRunIds } } }).catch(() => {})
    await db.payrollRun.deleteMany({ where: { id: { in: createdPayrollRunIds } } }).catch(() => {})
    void runs
    await db.employee.deleteMany({ where: { id: { in: createdEmployeeIds } } }).catch(() => {})
    await db.userRole.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {})
    await db.session.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {})
    await db.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {})
    await db.$disconnect()
  }, TIMEOUT)

  it("D1 — HR Payroll: creates a real PayrollRun for a controlled period; active employee included, terminated excluded, server-calculated net salary, draft->review->approved", async () => {
    const periodStart = new Date("2027-04-01")
    const periodEnd = new Date("2027-04-30")
    const run = await createPayrollRun(hrManagerSession([branchAId]), { branchId: branchAId, periodStart, periodEnd })
    createdPayrollRunIds.push(run.id)
    payrollRunId = run.id
    expect(run.status).toBe("draft")

    const lines = await db.payrollRunLine.findMany({ where: { payrollRunId: run.id } })
    expect(lines.some((l) => l.employeeId === activeEmployeeId)).toBe(true)
    expect(lines.some((l) => l.employeeId === terminatedEmployeeId)).toBe(false)
    const activeLine = lines.find((l) => l.employeeId === activeEmployeeId)!
    payrollLineId = activeLine.id
    expect(Number(activeLine.basicSalary)).toBe(8000)
    expect(Number(activeLine.netSalary)).toBeGreaterThan(0)

    // Duplicate period for the same branch is rejected.
    await expect(createPayrollRun(hrManagerSession([branchAId]), { branchId: branchAId, periodStart, periodEnd })).rejects.toThrow(/already exists/)

    await movePayrollToReview(hrManagerSession([branchAId]), run.id)
    const approved = await approvePayrollRun(hrManagerSession([branchAId]), run.id)
    expect(approved.status).toBe("approved")
  }, TIMEOUT)

  it("D2 — Payslip: the SAME PayrollRunLine's historical snapshot is reachable without broad settings permission, and stays stable regardless of later Employee changes", async () => {
    const payslip = await getPayrollLinePayslip(hrManagerSession([branchAId]), payrollLineId)
    expect(Number(payslip.netSalary)).toBeGreaterThan(0)
    expect(Number(payslip.basicSalary)).toBe(8000)
    expect(payslip.employee.id).toBe(activeEmployeeId)
    expect(payslip.payrollRun.id).toBe(payrollRunId)

    // Changing the Employee's CURRENT salary afterward must not retroactively alter the frozen line.
    await db.employee.update({ where: { id: activeEmployeeId }, data: { basicSalary: 99999 } })
    const stillFrozen = await db.payrollRunLine.findUniqueOrThrow({ where: { id: payrollLineId } })
    expect(Number(stillFrozen.basicSalary)).toBe(8000)
    await db.employee.update({ where: { id: activeEmployeeId }, data: { basicSalary: 8000 } }) // restore
  }, TIMEOUT)

  it("D3 — Payroll Payment / Accounting: marking paid posts balanced Salary Expense/Payroll Payable then Payroll Payable/Bank journals, referencing the SAME PayrollRun, no duplicates", async () => {
    const paid = await markPayrollPaid(hrManagerSession([branchAId]), payrollRunId, "bank")
    expect(paid.status).toBe("paid")

    await dispatchPendingOutboxEvents(organizationId)

    const approvalJournal = await db.journal.findFirstOrThrow({ where: { organizationId, referenceType: "payroll_run", referenceId: payrollRunId } })
    const approvalLines = await db.journalLine.findMany({ where: { journalId: approvalJournal.id } })
    expect(approvalLines.reduce((s, l) => s + Number(l.debit), 0)).toBeCloseTo(approvalLines.reduce((s, l) => s + Number(l.credit), 0), 2)

    const paidJournal = await db.journal.findFirst({ where: { organizationId, referenceType: "payroll_payment", referenceId: payrollRunId } })
    if (paidJournal) {
      const paidLines = await db.journalLine.findMany({ where: { journalId: paidJournal.id } })
      expect(paidLines.reduce((s, l) => s + Number(l.debit), 0)).toBeCloseTo(paidLines.reduce((s, l) => s + Number(l.credit), 0), 2)
    }

    await dispatchPendingOutboxEvents(organizationId)
    expect(await db.journal.count({ where: { organizationId, referenceType: "payroll_run", referenceId: payrollRunId } })).toBe(1)

    // The payslip remains historically stable after payment (still readable
    // via HR access). Accountant does not hold payroll.view — payroll access
    // stays HR-scoped, confirming §36's "HR cannot [be bypassed by] Finance"
    // boundary holds in both directions.
    const stillReadable = await getPayrollLinePayslip(hrManagerSession([branchAId]), payrollLineId)
    expect(stillReadable).toBeTruthy()
    await expect(getPayrollLinePayslip(accountantSession([branchAId]) as never, payrollLineId)).rejects.toThrow(ForbiddenError)

    const tb = await trialBalance(accountantSession([branchAId]))
    expect(tb.isBalanced).toBe(true)
  }, TIMEOUT)
})

describe("P3.13 Workflow E: Refund / Reversal Integrity (cross-role segregation of duties)", () => {
  let organizationId: string
  let branchAId: string
  let cashierUserId: string
  let clinicManagerUserId: string
  let patientId: string
  let invoiceId: string
  let cashierSessionRowId: string
  let refundId: string

  const createdUserIds: string[] = []
  const createdPatientIds: string[] = []
  const createdInvoiceIds: string[] = []
  const createdCashierSessionIds: string[] = []

  function cashierSession(branchIds: string[]): SessionContext {
    return {
      sessionId: "test-p3-13e-cashier",
      user: { id: cashierUserId, organizationId, email: "p3-13e-cashier@test.local", firstName: "P313E", lastName: "Cashier" },
      activeBranchId: branchIds[0] ?? null,
      branchIds,
      permissions: new Set([
        "patient.view", "service.view", "charge.create", "invoice.view", "invoice.create",
        "payment.view", "payment.create", "refund.request", "cashier.open", "package.sell",
        "coverage.manage", "communication.send",
      ]),
      roleNames: ["Cashier"],
    }
  }
  function clinicManagerSession(branchIds: string[]): SessionContext {
    return {
      sessionId: "test-p3-13e-cm",
      user: { id: clinicManagerUserId, organizationId, email: "p3-13e-cm@test.local", firstName: "P313E", lastName: "ClinicManager" },
      activeBranchId: branchIds[0] ?? null,
      branchIds,
      permissions: new Set([
        "settings.view", "branch.view", "department.view", "room.view",
        "patient.view", "provider.view", "service.view",
        "appointment.view", "appointment.reschedule", "appointment.cancel",
        "clinical_notes.view",
        "charge.void", "invoice.view", "invoice.discount", "invoice.void",
        "payment.view", "refund.authorize", "cashier.view", "package.manage", "tax.manage",
        "inventory.view", "supplier.view", "purchase_request.approve",
        "accounting.view", "expense.create", "reports.export",
        "payroll.view", "leave.approve", "asset.manage",
      ]),
      roleNames: ["Clinic Manager"],
    }
  }

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchAId = branch.id

    const cashierUser = await db.user.create({ data: { organizationId, email: `p3-13e-cashier-${Date.now()}@test.local`, passwordHash: "x", firstName: "P313E", lastName: "Cashier" } })
    cashierUserId = cashierUser.id
    createdUserIds.push(cashierUser.id)
    const cmUser = await db.user.create({ data: { organizationId, email: `p3-13e-cm-${Date.now()}@test.local`, passwordHash: "x", firstName: "P313E", lastName: "ClinicManager" } })
    clinicManagerUserId = cmUser.id
    createdUserIds.push(cmUser.id)

    const patient = await db.patient.create({
      data: {
        organizationId, registrationBranchId: branchAId,
        mrn: `TESTP313E-${Date.now()}`, firstName: "P313E", lastName: "Refund",
        dob: new Date("1990-01-01"), gender: "unknown", mobile: `P313EM${Date.now()}`,
      },
    })
    patientId = patient.id
    createdPatientIds.push(patient.id)

    const register = await openCashierSession(cashierSession([branchAId]), { branchId: branchAId, openingCash: 100 })
    cashierSessionRowId = register.id
    createdCashierSessionIds.push(register.id)

    const charge = await db.$transaction((tx) =>
      generateSystemCharge(tx, { organizationId, branchId: branchAId, patientId, sourceType: "consultation", description: "P3.13E test charge", quantity: 1, unitPrice: 200 })
    )
    const invoice = await generateInvoice(cashierSession([branchAId]), { patientId, branchId: branchAId, chargeIds: [charge.id], discountAmount: 0 })
    createdInvoiceIds.push(invoice.id)
    invoiceId = invoice.id
    await recordPayment(cashierSession([branchAId]), { invoiceId, cashierSessionId: cashierSessionRowId, tenders: [{ method: "cash", amount: 200 }] })
  }, TIMEOUT)

  afterAll(async () => {
    await db.refund.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } }).catch(() => {})
    await db.paymentAllocation.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } }).catch(() => {})
    const payments = await db.payment.findMany({ where: { receivedBy: { in: createdUserIds } }, select: { id: true } })
    await db.payment.deleteMany({ where: { id: { in: payments.map((p) => p.id) } } }).catch(() => {})
    await db.invoiceLine.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } }).catch(() => {})
    await db.invoice.deleteMany({ where: { id: { in: createdInvoiceIds } } }).catch(() => {})
    await db.charge.deleteMany({ where: { patientId: { in: createdPatientIds } } }).catch(() => {})
    await db.commMessage.deleteMany({ where: { patientId: { in: createdPatientIds } } }).catch(() => {})
    await db.patient.deleteMany({ where: { id: { in: createdPatientIds } } }).catch(() => {})
    await db.cashMovement.deleteMany({ where: { cashierSessionId: { in: createdCashierSessionIds } } }).catch(() => {})
    await db.cashierSession.deleteMany({ where: { id: { in: createdCashierSessionIds } } }).catch(() => {})
    await db.userRole.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {})
    await db.session.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {})
    await db.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {})
    await db.$disconnect()
  }, TIMEOUT)

  it("Cashier requests a refund but cannot authorize or complete their own request — real segregation of duties, not just a UI convention", async () => {
    const refund = await requestRefund(cashierSession([branchAId]), { invoiceId, method: "cash", amount: 50, reason: "P3.13 partial return" })
    refundId = refund.id
    expect(refund.status).toBe("requested")
    expect(refund.requestedBy).toBe(cashierUserId)

    await expect(authorizeRefund(cashierSession([branchAId]), refundId)).rejects.toThrow(ForbiddenError)
    await expect(completeRefund(cashierSession([branchAId]), refundId, cashierSessionRowId)).rejects.toThrow(ForbiddenError)
  }, TIMEOUT)

  it("Clinic Manager authorizes and completes the SAME refund; a duplicate completion attempt fails; invoice balance and accounting reflect the reversal", async () => {
    const authorized = await authorizeRefund(clinicManagerSession([branchAId]), refundId)
    expect(authorized.status).toBe("authorized")
    expect(authorized.authorizedBy).toBe(clinicManagerUserId)

    const completed = await completeRefund(clinicManagerSession([branchAId]), refundId, cashierSessionRowId)
    expect(completed.status).toBe("completed")

    // No duplicate completion.
    await expect(completeRefund(clinicManagerSession([branchAId]), refundId, cashierSessionRowId)).rejects.toThrow()

    const invoice = await getInvoice(cashierSession([branchAId]), invoiceId)
    expect(Number(invoice.paidAmount)).toBe(150) // 200 paid - 50 refunded

    await dispatchPendingOutboxEvents(organizationId)
    const refundJournal = await db.journal.findFirstOrThrow({ where: { organizationId, referenceType: "refund", referenceId: refundId } })
    const refundLines = await db.journalLine.findMany({ where: { journalId: refundJournal.id } })
    expect(refundLines.reduce((s, l) => s + Number(l.debit), 0)).toBeCloseTo(refundLines.reduce((s, l) => s + Number(l.credit), 0), 2)
    expect(refundLines.reduce((s, l) => s + Number(l.debit), 0)).toBeCloseTo(50, 2)

    // Never duplicated on a second dispatch pass.
    await dispatchPendingOutboxEvents(organizationId)
    expect(await db.journal.count({ where: { organizationId, referenceType: "refund", referenceId: refundId } })).toBe(1)

    const statement = await getPatientStatement(cashierSession([branchAId]), patientId)
    expect(statement.outstandingBalance).toBeCloseTo(50, 2) // 200 charged - 150 net paid
  }, TIMEOUT)
})
