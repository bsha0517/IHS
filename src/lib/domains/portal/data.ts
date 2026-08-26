import "server-only"
import { db } from "@/lib/db"
import { isPortalClinicalReleaseEnabled } from "@/lib/platform/settings"
import type { PortalSessionContext } from "@/lib/auth/portal-session"

/**
 * Every query here scopes to `portalSession.patient.id` directly — there is
 * no RBAC permission check the way staff services use `assertCan()`, since
 * a portal session's entire authorization model is "this session may only
 * ever see this one patient's data" (enforced by every `where` clause
 * below, not by a separate permission lookup).
 */

export async function getPortalProfile(portalSession: PortalSessionContext) {
  return db.patient.findUniqueOrThrow({ where: { id: portalSession.patient.id } })
}

export async function updatePortalProfile(
  portalSession: PortalSessionContext,
  input: { mobile?: string; email?: string; addressLine?: string; city?: string }
) {
  return db.patient.update({
    where: { id: portalSession.patient.id },
    data: {
      mobile: input.mobile,
      email: input.email,
      addressLine: input.addressLine,
      city: input.city,
    },
  })
}

export async function listPortalAppointments(portalSession: PortalSessionContext) {
  return db.appointment.findMany({
    where: { patientId: portalSession.patient.id },
    include: { provider: true, service: true, branch: true },
    orderBy: { startTime: "desc" },
  })
}

export async function listPortalPrescriptions(portalSession: PortalSessionContext) {
  const released = await isPortalClinicalReleaseEnabled(portalSession.patient.organizationId)
  if (!released) return []
  return db.prescription.findMany({
    where: { patientId: portalSession.patient.id, status: "active" },
    include: { items: true, provider: true },
    orderBy: { issuedAt: "desc" },
  })
}

export async function listPortalLabResults(portalSession: PortalSessionContext) {
  const released = await isPortalClinicalReleaseEnabled(portalSession.patient.organizationId)
  if (!released) return []
  return db.labOrderTest.findMany({
    where: { status: "verified", clinicalOrder: { patientId: portalSession.patient.id } },
    include: { labTest: true, labPanel: true },
    orderBy: { verifiedAt: "desc" },
  })
}

export async function listPortalImagingResults(portalSession: PortalSessionContext) {
  const released = await isPortalClinicalReleaseEnabled(portalSession.patient.organizationId)
  if (!released) return []
  return db.imagingOrder.findMany({
    where: { status: "verified", clinicalOrder: { patientId: portalSession.patient.id } },
    include: { imagingService: true },
    orderBy: { verifiedAt: "desc" },
  })
}

export async function listPortalInvoices(portalSession: PortalSessionContext) {
  return db.invoice.findMany({
    where: { patientId: portalSession.patient.id },
    orderBy: { issuedAt: "desc" },
  })
}

export async function listPortalPayments(portalSession: PortalSessionContext) {
  return db.payment.findMany({
    where: { allocations: { some: { invoice: { patientId: portalSession.patient.id } } } },
    include: { allocations: { include: { invoice: true } } },
    orderBy: { receivedAt: "desc" },
  })
}

export async function listPortalPackages(portalSession: PortalSessionContext) {
  const patientPackages = await db.patientPackage.findMany({
    where: { patientId: portalSession.patient.id },
    include: {
      package: { include: { services: { include: { service: true } } } },
      sessions: true,
    },
    orderBy: { purchasedAt: "desc" },
  })
  return patientPackages.map((pp) => ({
    ...pp,
    remaining: pp.package.services.map((ps) => ({
      packageServiceId: ps.id,
      serviceName: ps.service.name,
      allocated: ps.sessionsAllocated,
      used: pp.sessions.filter((s) => s.packageServiceId === ps.id).length,
    })),
  }))
}
