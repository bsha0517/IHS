import { UserPlus, CalendarDays, ArrowRightCircle } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { formatDateTime } from "@/lib/utils/dates"
import type { Patient } from "@/generated/prisma/client"
import type { listPatientAppointments } from "@/lib/domains/appointments/service"

type Appointments = Awaited<ReturnType<typeof listPatientAppointments>>

type TimelineEntry = {
  date: Date
  icon: typeof UserPlus
  label: string
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
 * Built entirely from existing structured records (patient.createdAt +
 * appointment status history) rather than a hand-maintained timeline table,
 * per spec.md §11.
 */
export function PatientTimeline({ patient, appointments }: { patient: Patient; appointments: Appointments }) {
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
      })
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
                <p className="text-sm">{entry.label}</p>
                <p className="text-xs text-muted-foreground">{formatDateTime(entry.date)}</p>
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  )
}
