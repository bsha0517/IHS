import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import type { SessionContext } from "@/lib/auth/session"

export type MonthlyKpiPoint = {
  monthLabel: string
  monthStart: Date
  monthEnd: Date
  revenue: number
  collections: number
  newPatients: number
  appointments: number
  completedAppointments: number
  noShows: number
}

const MONTH_LABEL = new Intl.DateTimeFormat("en-GB", { month: "short", year: "2-digit" })

/**
 * spec.md §65's "KPIs" — trend lines over the trailing N months (default 6),
 * every point computed live from the same tables the Reports/Dashboards
 * queries already use (Invoice/Payment/Patient/Appointment), never a
 * separately-maintained rollup table that could drift from the source rows.
 * Rendered as plain CSS bars on /analytics rather than pulling in a charting
 * library — the same "no unnecessary complexity" call already made for the
 * outbox dispatcher (ARCHITECTURE.md §15) and the communication engine's
 * scheduler (ARCHITECTURE.md §13): six bars don't need a new dependency.
 */
export async function getKpiTrends(session: SessionContext, months = 6): Promise<MonthlyKpiPoint[]> {
  assertCan(session, "reports.export")
  const organizationId = session.user.organizationId
  const now = new Date()
  const ranges: { start: Date; end: Date }[] = []
  for (let i = months - 1; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1)
    ranges.push({ start, end })
  }

  return Promise.all(
    ranges.map(async ({ start, end }) => {
      const [revenue, collections, newPatients, appointmentsByStatus] = await Promise.all([
        db.invoice.aggregate({ where: { organizationId, status: { not: "void" }, issuedAt: { gte: start, lt: end } }, _sum: { totalAmount: true } }),
        db.payment.aggregate({ where: { organizationId, status: "completed", receivedAt: { gte: start, lt: end } }, _sum: { amount: true } }),
        db.patient.count({ where: { organizationId, createdAt: { gte: start, lt: end } } }),
        db.appointment.groupBy({ by: ["status"], where: { organizationId, startTime: { gte: start, lt: end } }, _count: { _all: true } }),
      ])

      const totalAppointments = appointmentsByStatus.reduce((sum, s) => sum + s._count._all, 0)
      const completed = appointmentsByStatus.find((s) => s.status === "completed")?._count._all ?? 0
      const noShows = appointmentsByStatus.find((s) => s.status === "no_show")?._count._all ?? 0

      return {
        monthLabel: MONTH_LABEL.format(start),
        monthStart: start,
        monthEnd: end,
        revenue: Number(revenue._sum.totalAmount ?? 0),
        collections: Number(collections._sum.amount ?? 0),
        newPatients,
        appointments: totalAppointments,
        completedAppointments: completed,
        noShows,
      }
    })
  )
}
