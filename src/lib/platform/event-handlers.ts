import "server-only"
import { db } from "@/lib/db"
import { registerOutboxHandler } from "@/lib/platform/outbox"
import { generateSystemCharge } from "@/lib/domains/billing/charges"
import {
  postInvoiceIssued,
  postPaymentReceived,
  postRefundCompleted,
  postGoodsReceiptCompleted,
  postSupplierPaymentRecorded,
  postPackageSessionConsumed,
} from "@/lib/domains/accounting/posting-service"
import { accrueInvoiceBasisCommissions, accruePaymentBasisCommissions } from "@/lib/domains/payroll/commissions"
import { sendMessage } from "@/lib/domains/communications/service"
import { formatDate, formatTime } from "@/lib/utils/dates"

/**
 * Registrations for the Phase 2 domain events named in ARCHITECTURE.md §9.
 * Imported for its side effects wherever dispatchPendingOutboxEvents is
 * called (Node module caching means these `register` calls only ever run
 * once). Kept deliberately thin — per BLUEPRINT.md's caution against
 * over-applying the event architecture, a handler here does only what's
 * already a real, spec-named feature (spec.md §64's "Patient waiting"
 * notification), not speculative side effects.
 */

registerOutboxHandler("PatientRegistered", async () => {
  // No consumer yet — communications (Phase 12) is the eventual subscriber
  // for a welcome message. Intentionally a no-op rather than a fabricated one.
})

/**
 * "Appointment confirmation" (spec.md §56's template list) — the real
 * subscriber for the `AppointmentBooked` event, reserved in this file's
 * table since Phase 2 but never fired until now, the same "dormant
 * reservation wired for real several phases later" precedent as
 * `LabResultFinalized`/`EmployeeLeaveApproved`. `sendMessage()` never throws
 * on a missing/unconfigured provider (it records the attempt as `failed`
 * instead) — see `communications/service.ts` — so this handler doesn't need
 * its own try/catch beyond the outbox dispatcher's own at-least-once retry.
 */
registerOutboxHandler("AppointmentBooked", async (payload, organizationId) => {
  const appointment = await db.appointment.findUnique({
    where: { id: payload.appointmentId as string },
    include: { patient: true, provider: true, branch: true },
  })
  if (!appointment) return

  await sendMessage({
    organizationId,
    patientId: appointment.patientId,
    templateKey: "appointment_confirmation",
    variables: {
      patientName: `${appointment.patient.firstName} ${appointment.patient.lastName}`,
      appointmentDate: formatDate(appointment.startTime),
      appointmentTime: formatTime(appointment.startTime),
      providerName: `${appointment.provider.firstName} ${appointment.provider.lastName}`,
      branchName: appointment.branch.name,
    },
    referenceType: "appointment",
    referenceId: appointment.id,
  })
})

/** "Cancellation" (spec.md §56's template list) — see `appointments/service.ts`'s `cancelAppointment()` for why this is its own event rather than reusing `AppointmentBooked`'s handler shape. */
registerOutboxHandler("AppointmentCancelled", async (payload, organizationId) => {
  const appointment = await db.appointment.findUnique({
    where: { id: payload.appointmentId as string },
    include: { patient: true },
  })
  if (!appointment) return

  await sendMessage({
    organizationId,
    patientId: appointment.patientId,
    templateKey: "appointment_cancellation",
    variables: {
      patientName: `${appointment.patient.firstName} ${appointment.patient.lastName}`,
      appointmentDate: formatDate(appointment.startTime),
      appointmentTime: formatTime(appointment.startTime),
    },
    referenceType: "appointment",
    referenceId: appointment.id,
  })
})

registerOutboxHandler("EncounterFinalized", async () => {
  // No real subscriber yet — the patient timeline reads finalized encounters
  // directly rather than off this event. Billing hooks off EncounterCompleted
  // instead (see below), matching spec.md §85's explicit "Consultation
  // Completed -> Charges Generated" ordering, not the later finalize step.
})

/**
 * The billing engine's real trigger for the "Consultation" billable source
 * (spec.md §33/§85). Idempotency-guarded against outbox at-least-once
 * redelivery: skip if a consultation Charge already exists for this
 * encounter rather than risk a double-bill. Falls back to the provider's
 * standard consultationFee when the visit wasn't tied to a priced Service.
 */
registerOutboxHandler("EncounterCompleted", async (payload, organizationId) => {
  const encounterId = payload.encounterId as string
  const existing = await db.charge.findFirst({ where: { encounterId, sourceType: "consultation" } })
  if (existing) return

  const providerId = payload.providerId as string
  let unitPrice = payload.servicePrice as number | null
  if (unitPrice === null) {
    const provider = await db.provider.findUnique({ where: { id: providerId } })
    unitPrice = provider ? Number(provider.consultationFee) : 0
  }
  if (!unitPrice) return // a genuinely free/zero-fee consultation generates no charge

  await db.$transaction((tx) =>
    generateSystemCharge(tx, {
      organizationId,
      branchId: payload.branchId as string,
      patientId: payload.patientId as string,
      encounterId,
      serviceId: (payload.serviceId as string | null) ?? null,
      providerId,
      sourceType: "consultation",
      description: "Consultation",
      quantity: 1,
      unitPrice,
    })
  )
})

registerOutboxHandler("InvoiceIssued", async (payload) => {
  const invoiceId = payload.invoiceId as string
  await postInvoiceIssued(invoiceId)
  await db.$transaction((tx) => accrueInvoiceBasisCommissions(tx, invoiceId))
})

registerOutboxHandler("PaymentReceived", async (payload) => {
  const invoiceId = payload.invoiceId as string
  const tenders = payload.tenders as { method: string; amount: number }[]
  const paymentIds = payload.paymentIds as string[]
  await postPaymentReceived(invoiceId, tenders)
  await db.$transaction((tx) => accruePaymentBasisCommissions(tx, invoiceId, paymentIds))
})

registerOutboxHandler("RefundCompleted", async (payload) => {
  await postRefundCompleted(payload.refundId as string)
})

registerOutboxHandler("GoodsReceiptCompleted", async (payload) => {
  await postGoodsReceiptCompleted(payload.goodsReceiptId as string)
})

registerOutboxHandler("SupplierPaymentRecorded", async (payload) => {
  await postSupplierPaymentRecorded(payload.supplierPaymentId as string)
})

registerOutboxHandler("PackageSessionConsumed", async (payload) => {
  await postPackageSessionConsumed(payload.patientPackageSessionId as string)
})

/**
 * "Doctor leave must affect scheduling" (spec.md §51) — an approved leave
 * request for an employee linked to a Provider creates a ProviderLeaveBlock
 * spanning the leave's full date range, the exact mechanism the appointment
 * service already checks at booking time (spec.md §16). Idempotency-guarded
 * against outbox at-least-once redelivery: skip if a block already exists
 * for this exact leave request (matched by reason text, since there's no
 * direct FK from ProviderLeaveBlock back to LeaveRequest).
 */
registerOutboxHandler("EmployeeLeaveApproved", async (payload) => {
  const employeeId = payload.employeeId as string
  const leaveRequestId = payload.leaveRequestId as string
  const employee = await db.employee.findUnique({ where: { id: employeeId }, include: { providerProfile: true } })
  if (!employee?.providerProfile) return // not a clinical provider — nothing to block on the schedule

  const reason = `Approved leave (request ${leaveRequestId})`
  const existing = await db.providerLeaveBlock.findFirst({ where: { providerId: employee.providerProfile.id, reason } })
  if (existing) return

  const startAt = new Date(payload.startDate as string)
  startAt.setUTCHours(0, 0, 0, 0)
  const endAt = new Date(payload.endDate as string)
  endAt.setUTCHours(23, 59, 59, 999)

  await db.providerLeaveBlock.create({
    data: { providerId: employee.providerProfile.id, startAt, endAt, reason },
  })
})

/**
 * "Result Appears in EMR" (spec.md §85) — Patient 360's Lab Results tab
 * already reads verified LabOrderTest rows live (same "no separately-
 * maintained timeline table" discipline as every Patient 360 tab since
 * Phase 2), so the only real side effect this event needs is the
 * notification spec.md §64 names — mirroring AppointmentCheckedIn's
 * "Patient waiting" notification exactly.
 */
registerOutboxHandler("LabResultFinalized", async (payload) => {
  const clinicalOrderId = payload.clinicalOrderId as string
  const order = await db.clinicalOrder.findUnique({
    where: { id: clinicalOrderId },
    include: { orderingProvider: true, patient: true },
  })
  if (!order?.orderingProvider.userId) return // ordering provider has no login — nobody to notify

  await db.notification.create({
    data: {
      organizationId: order.organizationId,
      recipientUserId: order.orderingProvider.userId,
      type: "lab_result_ready",
      title: "Lab results ready",
      body: `${order.orderNumber} for ${order.patient.firstName} ${order.patient.lastName} (${order.patient.mrn}) is verified.`,
      referenceType: "clinical_order",
      referenceId: order.id,
    },
  })
})

/**
 * "Final Result" -> "Patient EMR" (spec.md §30/§85) — the identical shape as
 * LabResultFinalized above (Patient 360's Imaging tab already reads verified
 * ImagingOrder rows live; the only real side effect is the spec.md §64
 * notification), reused a third time rather than reinvented, mirroring how
 * Phase 9 reused the doctor-intent-vs-execution split instead of inventing a
 * new one.
 */
registerOutboxHandler("ImagingResultFinalized", async (payload) => {
  const clinicalOrderId = payload.clinicalOrderId as string
  const order = await db.clinicalOrder.findUnique({
    where: { id: clinicalOrderId },
    include: { orderingProvider: true, patient: true },
  })
  if (!order?.orderingProvider.userId) return // ordering provider has no login — nobody to notify

  await db.notification.create({
    data: {
      organizationId: order.organizationId,
      recipientUserId: order.orderingProvider.userId,
      type: "imaging_result_ready",
      title: "Imaging results ready",
      body: `${order.orderNumber} for ${order.patient.firstName} ${order.patient.lastName} (${order.patient.mrn}) is verified.`,
      referenceType: "clinical_order",
      referenceId: order.id,
    },
  })
})

registerOutboxHandler("AppointmentCheckedIn", async (payload) => {
  const providerId = payload.providerId as string | undefined
  if (!providerId) return

  const provider = await db.provider.findUnique({ where: { id: providerId } })
  if (!provider?.userId) return // provider has no login — nobody to notify

  const patient = await db.patient.findUnique({ where: { id: payload.patientId as string } })
  if (!patient) return

  await db.notification.create({
    data: {
      organizationId: provider.organizationId,
      recipientUserId: provider.userId,
      type: "patient_waiting",
      title: "Patient waiting",
      body: `${patient.firstName} ${patient.lastName} (${patient.mrn}) is waiting.`,
      referenceType: "appointment",
      referenceId: payload.appointmentId as string,
    },
  })
})
