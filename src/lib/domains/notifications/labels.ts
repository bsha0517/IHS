// Deliberately NOT "server-only" — pure, DB-free display helpers that the
// client-side filter component (notification-filters.tsx) also needs. Kept
// separate from service.ts (which is "server-only") for exactly that
// reason; service.ts re-exports these for every server-side caller.

const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  leave_appointment_conflict: "Leave / Appointment Conflict",
  lab_result_ready: "Lab Result Ready",
  critical_lab_result: "Critical Lab Result",
  imaging_result_ready: "Imaging Result Ready",
  patient_waiting: "Patient Waiting",
  system_event_dead_letter: "Background Task Failed",
  leave_request_submitted: "Leave Approval Needed",
  leave_decision: "Leave Decision",
  purchase_request_submitted: "Purchase Request Approval Needed",
  purchase_request_decision: "Purchase Request Decision",
}

export function notificationTypeLabel(type: string): string {
  return NOTIFICATION_TYPE_LABELS[type] ?? type.replace(/_/g, " ")
}
