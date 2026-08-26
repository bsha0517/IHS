import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import type { SessionContext } from "@/lib/auth/session"
import type { ReportFilters } from "@/lib/domains/analytics/schemas"

function timeToMinutes(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number)
  return h * 60 + m
}

/** How many times a given weekday (0=Sun..6=Sat) falls within [from, to] inclusive. */
function weekdayOccurrences(from: Date, to: Date, dayOfWeek: number) {
  let count = 0
  const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate())
  while (cursor <= end) {
    if (cursor.getDay() === dayOfWeek) count++
    cursor.setDate(cursor.getDate() + 1)
  }
  return count
}

/**
 * spec.md §65's "Practice" report bullets: Appointments, No-shows, Waiting
 * times, Provider utilization, Room utilization, Patient visits. Provider
 * utilization is a deliberately simplified real metric — booked minutes
 * (from actual Appointment rows) over available minutes derived from
 * ProviderSchedule's recurring weekly pattern, not netted against approved
 * leave (ProviderLeaveBlock) — a documented simplification, not a fake number.
 * Room utilization has no equivalent "available hours" concept in the schema
 * (rooms don't carry their own operating hours the way providers do via
 * ProviderSchedule), so it's reported as booked minutes/appointment counts
 * per room rather than a manufactured percentage.
 */
export async function getPracticeReport(session: SessionContext, filters: ReportFilters) {
  assertCan(session, "appointment.view")
  const organizationId = session.user.organizationId
  const where = {
    organizationId,
    startTime: { gte: filters.from, lte: filters.to },
    ...(filters.branchId ? { branchId: filters.branchId } : {}),
    ...(filters.providerId ? { providerId: filters.providerId } : {}),
  }

  const [statusCounts, appointments, patientVisitCount] = await Promise.all([
    db.appointment.groupBy({ by: ["status"], where, _count: { _all: true } }),
    db.appointment.findMany({ where, include: { provider: true, room: true, queueEntry: true, service: true }, orderBy: { startTime: "asc" } }),
    db.appointment.findMany({ where: { ...where, status: "completed" }, distinct: ["patientId"], select: { patientId: true } }),
  ])

  const totalAppointments = appointments.length
  const noShowCount = statusCounts.find((s) => s.status === "no_show")?._count._all ?? 0

  const waitTimes = appointments
    .filter((a) => a.queueEntry?.checkedInAt && a.queueEntry?.consultationStartAt)
    .map((a) => (a.queueEntry!.consultationStartAt!.getTime() - a.queueEntry!.checkedInAt!.getTime()) / 60000)
  const avgWaitingMinutes = waitTimes.length > 0 ? waitTimes.reduce((s, v) => s + v, 0) / waitTimes.length : null

  // Provider utilization
  const providerIds = filters.providerId ? [filters.providerId] : [...new Set(appointments.map((a) => a.providerId))]
  const [providers, schedules] = await Promise.all([
    db.provider.findMany({ where: { id: { in: providerIds } } }),
    db.providerSchedule.findMany({ where: { providerId: { in: providerIds }, isActive: true, ...(filters.branchId ? { branchId: filters.branchId } : {}) } }),
  ])
  const providerUtilization = providers.map((provider) => {
    const providerAppointments = appointments.filter((a) => a.providerId === provider.id && a.status !== "cancelled" && a.status !== "no_show" && a.status !== "rescheduled")
    const bookedMinutes = providerAppointments.reduce((sum, a) => sum + (a.endTime.getTime() - a.startTime.getTime()) / 60000, 0)
    const providerSchedules = schedules.filter((s) => s.providerId === provider.id)
    const availableMinutes = providerSchedules.reduce((sum, s) => {
      const dailyMinutes = timeToMinutes(s.endTime) - timeToMinutes(s.startTime)
      return sum + dailyMinutes * weekdayOccurrences(filters.from, filters.to, s.dayOfWeek)
    }, 0)
    return {
      providerId: provider.id,
      providerName: `${provider.firstName} ${provider.lastName}`,
      appointmentCount: providerAppointments.length,
      bookedMinutes: Math.round(bookedMinutes),
      availableMinutes: Math.round(availableMinutes),
      utilizationPercent: availableMinutes > 0 ? Math.round((bookedMinutes / availableMinutes) * 1000) / 10 : null,
    }
  })

  // Room utilization — booked minutes/appointment counts only (no available-hours baseline exists for rooms).
  const roomTotals = new Map<string, { roomName: string; appointmentCount: number; bookedMinutes: number }>()
  for (const a of appointments) {
    if (!a.roomId || !a.room) continue
    if (a.status === "cancelled" || a.status === "no_show" || a.status === "rescheduled") continue
    const entry = roomTotals.get(a.roomId) ?? { roomName: a.room.name, appointmentCount: 0, bookedMinutes: 0 }
    entry.appointmentCount += 1
    entry.bookedMinutes += (a.endTime.getTime() - a.startTime.getTime()) / 60000
    roomTotals.set(a.roomId, entry)
  }
  const roomUtilization = [...roomTotals.entries()].map(([roomId, v]) => ({ roomId, ...v, bookedMinutes: Math.round(v.bookedMinutes) }))

  return {
    totalAppointments,
    statusBreakdown: statusCounts.map((s) => ({ status: s.status, count: s._count._all })),
    noShowCount,
    noShowRate: totalAppointments > 0 ? Math.round((noShowCount / totalAppointments) * 1000) / 10 : 0,
    avgWaitingMinutes: avgWaitingMinutes !== null ? Math.round(avgWaitingMinutes) : null,
    providerUtilization,
    roomUtilization,
    patientVisits: patientVisitCount.length,
  }
}
