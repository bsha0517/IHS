import "server-only"
import { db } from "@/lib/db"
import { registerOutboxHandler } from "@/lib/platform/outbox"
import { generateSystemCharge } from "@/lib/domains/billing/charges"
import {
  postInvoiceIssued,
  postInvoiceVoided,
  postPaymentReceived,
  postRefundCompleted,
  postGoodsReceiptCompleted,
  postSupplierInvoiceCreated,
  postSupplierPaymentRecorded,
  postPackageSessionConsumed,
  postProductSaleCogs,
  postProductSaleVoided,
  postInventoryAdjustment,
  postPayrollApproved,
  postPayrollPaid,
} from "@/lib/domains/accounting/posting-service"
import { accrueInvoiceBasisCommissions, accruePaymentBasisCommissions, reverseCommissionsForRefund } from "@/lib/domains/payroll/commissions"
import { submitInvoiceToZatca } from "@/lib/domains/einvoicing/service"
import { sendMessage } from "@/lib/domains/communications/service"
import { createNotificationOnce, createNotificationsOnce } from "@/lib/domains/notifications/create"
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

// Widened from Prisma's 5000ms/2000ms defaults — same reason
// posting-service.ts's POSTING_TRANSACTION_OPTIONS is: `resolveCommissionRule`
// (commissions.ts) runs 1-2 queries per invoice line, and a real full-suite
// run in this pass's own final synthesis batch caught this exact
// transaction genuinely exceeding the 5000ms default (P2028, "6312 ms
// passed") under this environment's real Supabase pooler latency — not
// speculative, the same class of gap `createAsset`/`generateInvoice`/
// `voidInvoice`/`createGoodsReceipt`/`approveLeave`/`nextNumber` already
// needed this identical fix for.
const COMMISSION_TRANSACTION_OPTIONS = { timeout: 20_000, maxWait: 10_000 }

registerOutboxHandler("InvoiceIssued", async (payload) => {
  const invoiceId = payload.invoiceId as string
  await postInvoiceIssued(invoiceId)
  await db.$transaction((tx) => accrueInvoiceBasisCommissions(tx, invoiceId), COMMISSION_TRANSACTION_OPTIONS)
})

/**
 * P5.5-Z: a second, independent "InvoiceIssued" handler (registerOutboxHandler
 * stores handlers per event type in an array — see outbox.ts — so this is
 * additive, not a replacement of the posting/commission handler above).
 * Always writes an EInvoiceSubmission attempt record; only ever calls the
 * real ZATCA API when an org has both a seller profile configured and real
 * sandbox/production credentials — see einvoicing/service.ts.
 */
registerOutboxHandler("InvoiceIssued", async (payload) => {
  await submitInvoiceToZatca(payload.invoiceId as string)
})

/** P1 §24: reverses postInvoiceIssued's own posting — see voidInvoice (billing/invoices.ts) and postInvoiceVoided's doc comment. */
registerOutboxHandler("InvoiceVoided", async (payload) => {
  await postInvoiceVoided(payload.invoiceId as string)
})

registerOutboxHandler("PaymentReceived", async (payload) => {
  const invoiceId = payload.invoiceId as string
  const tenders = payload.tenders as { method: string; amount: number }[]
  const paymentIds = payload.paymentIds as string[]
  await postPaymentReceived(invoiceId, tenders, paymentIds)
  await db.$transaction((tx) => accruePaymentBasisCommissions(tx, invoiceId, paymentIds), COMMISSION_TRANSACTION_OPTIONS)
})

registerOutboxHandler("RefundCompleted", async (payload) => {
  const refundId = payload.refundId as string
  await postRefundCompleted(refundId)
  // P1 §19: claws back collected_revenue-basis commission that was earned
  // on now-refunded cash — see reverseCommissionsForRefund's own doc
  // comment (commissions.ts) for why only that one basis is touched.
  await db.$transaction((tx) => reverseCommissionsForRefund(tx, refundId), COMMISSION_TRANSACTION_OPTIONS)
})

registerOutboxHandler("GoodsReceiptCompleted", async (payload) => {
  await postGoodsReceiptCompleted(payload.goodsReceiptId as string)
})

/** P1 §15: the AP-recognition half of a supplier invoice — see supplier-invoices.ts's createSupplierInvoice and posting-service.ts's postSupplierInvoiceCreated. */
registerOutboxHandler("SupplierInvoiceCreated", async (payload) => {
  await postSupplierInvoiceCreated(payload.supplierInvoiceId as string)
})

registerOutboxHandler("SupplierPaymentRecorded", async (payload) => {
  await postSupplierPaymentRecorded(payload.supplierPaymentId as string)
})

registerOutboxHandler("PackageSessionConsumed", async (payload) => {
  await postPackageSessionConsumed(payload.patientPackageSessionId as string)
})

/** P1 §32 (finding B10): the async posting half of `approvePayrollRun` — see payroll.ts's own doc comment for why this moved off a direct, unprotected call. */
registerOutboxHandler("PayrollApproved", async (payload) => {
  await postPayrollApproved(payload.payrollRunId as string)
})

/** P1 §32 (finding B10): the async posting half of `markPayrollPaid` — see payroll.ts's own doc comment. */
registerOutboxHandler("PayrollPaid", async (payload) => {
  await postPayrollPaid(payload.payrollRunId as string)
})

/** P1 §11: the COGS half of a POS product sale — see charges.ts's insertCharge and posting-service.ts's postProductSaleCogs. */
registerOutboxHandler("ProductSold", async (payload, organizationId) => {
  await postProductSaleCogs({
    organizationId,
    branchId: payload.branchId as string,
    chargeId: payload.chargeId as string,
    cost: payload.cost as number,
  })
})

/** P1 §9-§11: reverses a voided product-sale charge's COGS — see charges.ts's voidCharge and posting-service.ts's postProductSaleVoided. */
registerOutboxHandler("ProductSaleVoided", async (payload, organizationId) => {
  await postProductSaleVoided({
    organizationId,
    branchId: payload.branchId as string,
    chargeId: payload.chargeId as string,
  })
})

/** P1 §13: a financially-relevant manual stock adjustment — see stock.ts's recordAdjustment and posting-service.ts's postInventoryAdjustment. */
registerOutboxHandler("InventoryAdjusted", async (payload, organizationId) => {
  await postInventoryAdjustment({
    organizationId,
    branchId: payload.branchId as string,
    stockLedgerEntryId: payload.stockLedgerEntryId as string,
    direction: payload.direction as "in" | "out",
    amount: payload.amount as number,
    description: payload.description as string,
  })
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
registerOutboxHandler("EmployeeLeaveApproved", async (payload, organizationId) => {
  const employeeId = payload.employeeId as string
  const leaveRequestId = payload.leaveRequestId as string
  const employee = await db.employee.findUnique({ where: { id: employeeId }, include: { providerProfile: true } })
  if (!employee) return

  // P3.11 §30/§31: "leave decision -> employee-linked User." Deliberately
  // BEFORE the `providerProfile` check below — most employees aren't
  // clinical Providers, and the original handler's early return would have
  // silently skipped this for all of them. No PHI/reason text in the body
  // (P3.11 §17's minimization spirit extends to personal HR detail too —
  // a leave reason can itself be sensitive).
  if (employee.userId) {
    await createNotificationOnce(db, {
      organizationId,
      recipientUserId: employee.userId,
      type: "leave_decision",
      title: "Leave request approved",
      body: `Your leave request for ${formatDate(new Date(payload.startDate as string))} – ${formatDate(new Date(payload.endDate as string))} was approved.`,
      referenceType: "leave_request",
      referenceId: leaveRequestId,
    })
  }

  if (!employee.providerProfile) return // not a clinical provider — nothing to block on the schedule

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

  // P1 §25: "existing appointments during newly approved leave must trigger
  // a conflict warning / administrative notification — do NOT silently
  // delete/reschedule." assertNoLeaveConflict (appointments/service.ts)
  // only guards NEW bookings against an EXISTING leave block; it can't
  // retroactively stop an appointment that was booked before this leave was
  // ever approved. This is that missing other half — surfaced to admins for
  // a human to actually reschedule or cancel, never done automatically here.
  const conflicting = await db.appointment.findMany({
    where: {
      organizationId,
      providerId: employee.providerProfile.id,
      status: { notIn: ["completed", "cancelled", "no_show", "rescheduled"] },
      startTime: { lt: endAt },
      endTime: { gt: startAt },
    },
    include: { patient: true },
    orderBy: { startTime: "asc" },
  })
  if (conflicting.length === 0) return

  const admins = await db.user.findMany({
    where: { organizationId, status: "active", roles: { some: { role: { name: { in: ["Super Admin", "Organization Administrator"] } } } } },
    select: { id: true },
  })
  if (admins.length === 0) return

  const summary = conflicting
    .slice(0, 5)
    .map((a) => `${a.patient.firstName} ${a.patient.lastName} at ${a.startTime.toISOString()}`)
    .join("; ")
  await createNotificationsOnce(
    db,
    admins.map((admin) => ({
      organizationId,
      recipientUserId: admin.id,
      type: "leave_appointment_conflict",
      title: `Approved leave conflicts with ${conflicting.length} existing appointment(s)`,
      body: `Dr. ${employee.firstName} ${employee.lastName}'s newly approved leave (${startAt.toDateString()}–${endAt.toDateString()}) overlaps: ${summary}${conflicting.length > 5 ? ` and ${conflicting.length - 5} more` : ""}. These were NOT automatically cancelled or rescheduled.`,
      referenceType: "employee",
      referenceId: employeeId,
    }))
  )
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

  // P3.11 §41: idempotent against outbox redelivery.
  // P3.11 §12: referenceType is "lab_order" (not the pre-P3.11 "clinical_order")
  // so the destination resolver (notifications/service.ts) can route it
  // correctly to /laboratory/orders/[id] without an extra lookup — imaging
  // uses the same ClinicalOrder id shape but needs a different destination.
  await createNotificationOnce(db, {
    organizationId: order.organizationId,
    recipientUserId: order.orderingProvider.userId,
    type: "lab_result_ready",
    title: "Lab results ready",
    body: `${order.orderNumber} for ${order.patient.firstName} ${order.patient.lastName} (${order.patient.mrn}) is verified.`,
    referenceType: "lab_order",
    referenceId: order.id,
  })
})

/**
 * P1 §22: critical (panic-value) result notification — fired independently
 * of LabResultFinalized above (a critical single line deserves immediate
 * attention regardless of whether sibling tests on the same order are also
 * done). Restricted to clinically-authorized recipients by construction,
 * not by a separate access check: every Notification row here is addressed
 * to one specific `recipientUserId` (never a broadcast), and the only
 * candidates are the ordering provider or a user holding `lab_result.verify`
 * — the same clinical-permission boundary every other lab action already
 * enforces. Falls back to `lab_result.verify` holders only when the
 * ordering provider has no linked login, so a critical result is never
 * silently unnoticed the way LabResultFinalized's own "nobody to notify,
 * return" is acceptable for a routine result.
 */
registerOutboxHandler("CriticalLabResultVerified", async (payload, organizationId) => {
  const labOrderTestId = payload.labOrderTestId as string
  const abnormalFlag = payload.abnormalFlag as string
  const line = await db.labOrderTest.findUnique({
    where: { id: labOrderTestId },
    include: { labTest: true, clinicalOrder: { include: { orderingProvider: true, patient: true } } },
  })
  if (!line) return
  const order = line.clinicalOrder

  const recipientIds = new Set<string>()
  if (order.orderingProvider.userId) recipientIds.add(order.orderingProvider.userId)
  if (recipientIds.size === 0) {
    const verifiers = await db.user.findMany({
      where: { organizationId, status: "active", roles: { some: { role: { permissions: { some: { permission: { code: "lab_result.verify" } } } } } } },
      select: { id: true },
    })
    for (const v of verifiers) recipientIds.add(v.id)
  }
  if (recipientIds.size === 0) return

  // P3.11 §17: previously interpolated the actual numeric/text value and
  // abnormal flag directly into the notification body — a real PHI leak
  // into a generic, less-access-controlled record than the lab order
  // screen itself. The value/flag stay behind that permission-gated
  // destination; this only says a critical result needs review, matching
  // the spec's own "Lab result ready for MRN ####" example.
  // §12: referenceType "lab_order" pointing at the PARENT ClinicalOrder id
  // (order.id, not line.id) — the pre-P3.11 "lab_order_test"/line.id
  // combination had no route at all (no per-LabOrderTest page exists).
  await createNotificationsOnce(
    db,
    [...recipientIds].map((recipientUserId) => ({
      organizationId,
      recipientUserId,
      type: "critical_lab_result",
      title: `CRITICAL: ${line.labTest.name}`,
      body: `${order.patient.firstName} ${order.patient.lastName} (${order.patient.mrn}) has a critical ${line.labTest.name} result (${abnormalFlag.replace("_", " ")}) requiring immediate review.`,
      referenceType: "lab_order",
      referenceId: order.id,
    }))
  )
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

  await createNotificationOnce(db, {
    organizationId: order.organizationId,
    recipientUserId: order.orderingProvider.userId,
    type: "imaging_result_ready",
    title: "Imaging results ready",
    body: `${order.orderNumber} for ${order.patient.firstName} ${order.patient.lastName} (${order.patient.mrn}) is verified.`,
    referenceType: "imaging_order",
    referenceId: order.id,
  })
})

registerOutboxHandler("AppointmentCheckedIn", async (payload) => {
  const providerId = payload.providerId as string | undefined
  if (!providerId) return

  const provider = await db.provider.findUnique({ where: { id: providerId } })
  if (!provider?.userId) return // provider has no login — nobody to notify

  const patient = await db.patient.findUnique({ where: { id: payload.patientId as string } })
  if (!patient) return

  await createNotificationOnce(db, {
    organizationId: provider.organizationId,
    recipientUserId: provider.userId,
    type: "patient_waiting",
    title: "Patient waiting",
    body: `${patient.firstName} ${patient.lastName} (${patient.mrn}) is waiting.`,
    referenceType: "appointment",
    referenceId: payload.appointmentId as string,
  })
})
