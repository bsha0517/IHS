import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import type { SessionContext } from "@/lib/auth/session"

/**
 * Real, data-driven candidate lists for three of the eight named templates
 * (spec.md §56) — staff pick a row and click "Send," server-resolved
 * variables, no manual re-typing. The other five (Cancellation, Appointment
 * confirmation — both fire automatically off existing events; Follow-up,
 * Package expiry, Lab result ready — seeded and fully sendable via
 * `sendMessage()`, verified in the integration script, but without a
 * dedicated hub section this phase) are a deliberate, documented scope cut
 * — see PROJECT_STATUS.md's Phase 12 Known Issues. None of these are a fake
 * scheduler: every send here is a real, one-click, staff-initiated action —
 * this build has no background job runner (ARCHITECTURE.md §14), so nothing
 * here claims to fire on its own.
 */

export async function listUpcomingAppointmentsForReminder(session: SessionContext) {
  assertCan(session, "communication.send")
  const now = new Date()
  const in48h = new Date(now.getTime() + 48 * 60 * 60 * 1000)
  return db.appointment.findMany({
    where: {
      organizationId: session.user.organizationId,
      startTime: { gte: now, lte: in48h },
      status: { in: ["scheduled", "confirmed"] },
    },
    include: { patient: true, provider: true },
    orderBy: { startTime: "asc" },
  })
}

export async function listOutstandingInvoicesForReminder(session: SessionContext) {
  assertCan(session, "communication.send")
  const invoices = await db.invoice.findMany({
    where: { organizationId: session.user.organizationId, status: { in: ["issued", "partially_paid"] } },
    include: { patient: true },
    orderBy: { issuedAt: "asc" },
    take: 100,
  })
  return invoices.filter((inv) => Number(inv.totalAmount) - Number(inv.paidAmount) > 0)
}

export async function listPatientsWithBirthdayToday(session: SessionContext) {
  assertCan(session, "communication.send")
  const now = new Date()
  const month = now.getMonth() + 1
  const day = now.getDate()
  const patients = await db.patient.findMany({
    where: { organizationId: session.user.organizationId, status: "active" },
  })
  return patients.filter((p) => p.dob.getUTCMonth() + 1 === month && p.dob.getUTCDate() === day)
}
