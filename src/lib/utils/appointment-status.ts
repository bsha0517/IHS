import type { $Enums } from "@/generated/prisma/client"

type AppointmentStatus = $Enums.AppointmentStatus

/**
 * P3.1 §6: one shared status→label/variant mapping, used everywhere an
 * appointment status renders (Reception, Appointments list, Queue, the
 * appointment detail page) — previously each page inlined its own ad hoc
 * `.replace("_", " ")` and its own `STATUS_VARIANT` record (only
 * `appointments/page.tsx` had one; Reception/Queue had none at all, so a
 * cancelled/no-show appointment rendered with the exact same neutral
 * "outline" badge as a routine scheduled one). No new colors invented —
 * reuses the same badge variants already in use across this app
 * (default/secondary/destructive/outline), just applied consistently.
 * Pure/no "server-only" — safe to import from both Server and Client Components.
 */
export const APPOINTMENT_STATUS_LABEL: Readonly<Record<AppointmentStatus, string>> = {
  scheduled: "Scheduled",
  confirmed: "Confirmed",
  arrived: "Arrived",
  checked_in: "Checked in",
  waiting: "Waiting",
  in_consultation: "In consultation",
  completed: "Completed",
  cancelled: "Cancelled",
  rescheduled: "Rescheduled",
  no_show: "No-show",
}

export const APPOINTMENT_STATUS_VARIANT: Readonly<Record<AppointmentStatus, "default" | "secondary" | "destructive" | "outline">> = {
  scheduled: "outline",
  confirmed: "outline",
  arrived: "secondary",
  checked_in: "secondary",
  waiting: "secondary",
  in_consultation: "default",
  completed: "default",
  cancelled: "destructive",
  rescheduled: "destructive",
  no_show: "destructive",
}
