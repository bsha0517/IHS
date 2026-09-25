import type { LucideIcon } from "lucide-react"
import { TrendingDown, TrendingUp } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * P4.7A §22 — the one KPI-tile design used by Dashboard, Reception,
 * Finance, Inventory, and Reports, replacing however many bespoke card
 * layouts those screens had accumulated independently. `trend` is only
 * ever a real computed delta (e.g. this month vs. last) — never rendered
 * unless the caller actually has one; this component never fabricates a
 * trend arrow.
 *
 * P4.10 §24 — visual refresh only, same props/behavior: an icon container
 * tinted to the card's own tone (instead of a flat gray icon with no
 * container) and a left accent stripe that only appears for a *meaningful*
 * tone (success/warning/destructive) — a plain "neutral" tile (most tiles
 * on Dashboard) stays quiet with no stripe, so the stripe reads as a real
 * signal ("this number needs attention") rather than decoration repeated
 * on every tile.
 */
export function MetricCard({
  label,
  value,
  helper,
  icon: Icon,
  trend,
  tone = "neutral",
  className,
}: {
  label: string
  value: string | number
  helper?: string
  icon?: LucideIcon
  trend?: { direction: "up" | "down"; label: string }
  tone?: "neutral" | "success" | "warning" | "destructive"
  className?: string
}) {
  const toneStyles = {
    neutral: { value: "text-foreground", iconBg: "bg-muted", iconText: "text-muted-foreground", stripe: "" },
    success: { value: "text-success", iconBg: "bg-success-surface", iconText: "text-success", stripe: "bg-success" },
    warning: { value: "text-warning", iconBg: "bg-warning-surface", iconText: "text-warning", stripe: "bg-warning" },
    destructive: { value: "text-destructive", iconBg: "bg-destructive-surface", iconText: "text-destructive", stripe: "bg-destructive" },
  }[tone]

  return (
    <div className={cn("relative overflow-hidden rounded-lg border border-border bg-card p-4 shadow-sm", className)}>
      {toneStyles.stripe && <div className={cn("absolute inset-y-0 left-0 w-1", toneStyles.stripe)} aria-hidden="true" />}
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {Icon && (
          <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-md", toneStyles.iconBg)}>
            <Icon className={cn("size-4", toneStyles.iconText)} aria-hidden="true" />
          </span>
        )}
      </div>
      <p className={cn("mt-1.5 text-2xl font-semibold tabular-nums tracking-tight", toneStyles.value)}>{value}</p>
      {(helper || trend) && (
        <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          {trend && (
            <span className={cn("inline-flex items-center gap-0.5 font-medium", trend.direction === "up" ? "text-success" : "text-destructive")}>
              {trend.direction === "up" ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
              {trend.label}
            </span>
          )}
          {helper && <span>{helper}</span>}
        </div>
      )}
    </div>
  )
}
