import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * P4.7A §36 — one consistent "nothing here" pattern instead of a blank
 * table or an ad hoc line of muted text per page. `action` is only ever
 * rendered when the caller has already checked the viewer is authorized
 * for it (this component has no permission awareness of its own).
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon
  title: string
  description?: string
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border px-6 py-10 text-center", className)}>
      {Icon && <Icon className="size-8 text-muted-foreground/60" aria-hidden="true" />}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
