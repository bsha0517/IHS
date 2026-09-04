import Link from "next/link"
import { UserPlus, CalendarDays, ArrowRightCircle, Receipt, Banknote } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { formatDateTime } from "@/lib/utils/dates"
import type { Patient } from "@/generated/prisma/client"
import type { listPatientAppointments } from "@/lib/domains/appointments/service"
import type { getPatientStatement } from "@/lib/domains/billing/statement"

type Appointments = Awaited<ReturnType<typeof listPatientAppointments>>
type StatementLines = Awaited<ReturnType<typeof getPatientStatement>>["lines"]

type TimelineEntry = {
  date: Date
  icon: typeof UserPlus
  label: string
  href?: string
}

const STATUS_LABEL: Record<string, string> = {
  scheduled: "Appointment scheduled",
  confirmed: "Appointment confirmed",
  arrived: "Patient arrived",
  checked_in: "Checked in",
  waiting: "In queue",
  in_consultation: "Consultation started",
  completed: "Consultation completed",
  cancelled: "Appointment cancelled",
  rescheduled: "Appointment rescheduled",
  no_show: "Marked as no-show",
}

/**
 * Built entirely from existing structured records (patient.createdAt,
 * appointment status history, and — where the viewer has financial
 * permission — the same billing statement lines the Statement tab already
 * shows) rather than a hand-maintained timeline table, per p3.2.md §10.
 *
 * P3.2 §11: appointment-derived entries now link to `/appointments/[id]`
 * and invoice-derived entries to `/invoices/[id]` — real destinations that
 * already exist. Patient registration has no destination beyond the page
 * already open, so it stays unlinked rather than becoming a dead/self link.
 * Payment/refund lines aren't linked — there's no standalone payment detail
 * screen in this app (payments are viewed via the Statement/Payments tabs,
 * or via their invoice) — linking them would be a dead link per §11.
 */
export function PatientTimeline({
  patient,
  appointments,
  statementLines,
}: {
  patient: Patient
  appointments: Appointments
  statementLines: StatementLines
}) {
  const entries: TimelineEntry[] = [
    { date: patient.createdAt, icon: UserPlus, label: `Patient registered (${patient.mrn})` },
  ]

  for (const appointment of appointments) {
    for (const history of appointment.statusHistory) {
      const label = STATUS_LABEL[history.toStatus] ?? history.toStatus
      entries.push({
        date: history.changedAt,
        icon: history.toStatus === "scheduled" ? CalendarDays : ArrowRightCircle,
        label: `${label} — ${appointment.appointmentNumber} with ${appointment.provider.firstName} ${appointment.provider.lastName}`,
        href: `/appointments/${appointment.id}`,
      })
    }
  }

  for (const line of statementLines) {
    if (line.type === "invoice") {
      entries.push({ date: line.date, icon: Receipt, label: `Invoice ${line.referenceNumber} — ${line.description}`, href: `/invoices/${line.referenceId}` })
    } else if (line.type === "payment") {
      entries.push({ date: line.date, icon: Banknote, label: `Payment received — ${line.description}` })
    }
  }

  entries.sort((a, b) => b.date.getTime() - a.date.getTime())

  return (
    <Card>
      <CardContent className="pt-6">
        <ol className="grid gap-4">
          {entries.map((entry, i) => (
            <li key={i} className="flex items-start gap-3">
              <entry.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div>
                {entry.href ? (
                  <Link href={entry.href} className="text-sm hover:underline">
                    {entry.label}
                  </Link>
                ) : (
                  <p className="text-sm">{entry.label}</p>
                )}
                <p className="text-xs text-muted-foreground">{formatDateTime(entry.date)}</p>
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  )
}
