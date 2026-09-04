import { Badge, type badgeVariants } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { VariantProps } from "class-variance-authority"

/**
 * P4.7A §35 — one semantic status system for the whole app. Before this,
 * each page invented its own `Record<string, "default"|"secondary"|...>`
 * map, so the same word ("cancelled", "completed") could render a
 * different color in different modules with no real reason. Every status
 * badge should resolve through `statusTone`/`StatusBadge` here instead —
 * covers the actual status vocabulary already in this schema (appointment,
 * invoice, payment, refund, lab/imaging order, stock, employee/patient,
 * import job, accounting exception, ...) via a small explicit map, with a
 * keyword fallback for anything not explicitly listed so a new status
 * value never silently renders unstyled.
 */
export type StatusTone = "success" | "warning" | "info" | "destructive" | "neutral"

const EXPLICIT_TONE: Record<string, StatusTone> = {
  // Financial
  paid: "success",
  partially_paid: "warning",
  outstanding: "warning",
  void: "destructive",
  refunded: "info",
  reversed: "info",
  issued: "info",
  completed: "success",
  // Appointments / queue
  checked_in: "info",
  waiting: "info",
  in_consultation: "info",
  arrived: "info",
  scheduled: "info",
  confirmed: "info",
  no_show: "destructive",
  cancelled: "destructive",
  rescheduled: "neutral",
  // Clinical / lab / imaging orders
  verified: "success",
  resulted: "info",
  reported: "success",
  collected: "info",
  ordered: "neutral",
  acknowledged: "info",
  in_progress: "info",
  performed: "info",
  draft: "neutral",
  // Lab abnormal-flag vocabulary (LabOrderTest.abnormalFlag) — "critical_low"/
  // "critical_high" already resolve via the "critical" keyword below.
  normal: "success",
  low: "warning",
  high: "warning",
  // Encounter / clinical note lifecycle (P4.7A.1)
  finalized: "success",
  entered_in_error: "destructive",
  superseded: "neutral",
  resolved: "success",
  open: "info",
  current: "success",
  // Inventory
  low_stock: "warning",
  near_expiry: "warning",
  expired: "destructive",
  // Generic lifecycle
  active: "success",
  inactive: "neutral",
  pending: "warning",
  approved: "success",
  rejected: "destructive",
  failed: "destructive",
  processing: "info",
  dead_letter: "destructive",
  // Onboarding / import (P4.6)
  not_started: "neutral",
  ready: "success",
  optional: "neutral",
  attention_required: "warning",
  validated: "info",
  // Refund/authorization lifecycle
  requested: "warning",
  authorized: "info",
}

const KEYWORD_TONE: [RegExp, StatusTone][] = [
  [/cancel|void|reject|expired|fail|dead_letter|overdue|critical/i, "destructive"],
  [/pending|partial|waiting|attention|low.?stock|near.?expiry|draft|requested/i, "warning"],
  [/complet|paid|verified|active|approv|success|confirm|resolved|ready|dispatch/i, "success"],
  [/progress|processing|scheduled|checked.?in|consultation|acknowledg|order|authoriz/i, "info"],
]

export function statusTone(status: string): StatusTone {
  const key = status.toLowerCase().trim()
  if (key in EXPLICIT_TONE) return EXPLICIT_TONE[key]
  for (const [pattern, tone] of KEYWORD_TONE) {
    if (pattern.test(key)) return tone
  }
  return "neutral"
}

const TONE_TO_VARIANT: Record<StatusTone, VariantProps<typeof badgeVariants>["variant"]> = {
  success: "success",
  warning: "warning",
  info: "info",
  destructive: "destructive",
  neutral: "neutral",
}

/** Renders `status` (a raw enum value like `"partially_paid"`) as a consistently-toned, human-readable badge. Pass `label` to override the displayed text while keeping tone derived from `status`. */
export function StatusBadge({ status, label, className }: { status: string; label?: string; className?: string }) {
  const tone = statusTone(status)
  return (
    <Badge variant={TONE_TO_VARIANT[tone]} className={cn("capitalize font-normal", className)}>
      {(label ?? status).replace(/_/g, " ")}
    </Badge>
  )
}
