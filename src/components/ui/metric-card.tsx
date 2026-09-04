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
  const toneClass = {
    neutral: "text-foreground",
    success: "text-success",
    warning: "text-warning",
    destructive: "text-destructive",
  }[tone]

  return (
    <div className={cn("rounded-lg border border-border bg-card p-4", className)}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {Icon && <Icon className="size-4 shrink-0 text-muted-foreground/70" aria-hidden="true" />}
      </div>
      <p className={cn("mt-1.5 text-2xl font-semibold tabular-nums tracking-tight", toneClass)}>{value}</p>
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
