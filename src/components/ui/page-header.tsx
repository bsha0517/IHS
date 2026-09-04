import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * P4.7A §19 — the one page-title pattern every route should use instead of
 * each page hand-rolling its own `<h1>` size/weight/spacing/action-button
 * placement. Deliberately small: title, an optional one-line description,
 * and two action slots (primary — the single most important action on this
 * screen, secondary — everything else). Not a "put anything anywhere"
 * component; §62's own "do not have multiple primary actions competing on
 * one screen" is enforced structurally by there being exactly one
 * `primaryAction` slot.
 */
export function PageHeader({
  title,
  description,
  primaryAction,
  secondaryActions,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  primaryAction?: ReactNode
  secondaryActions?: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between", className)}>
      <div className="grid gap-1">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {(primaryAction || secondaryActions) && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {secondaryActions}
          {primaryAction}
        </div>
      )}
    </div>
  )
}

/**
 * §20 — a denser variant for operational/queue workspaces (Reception,
 * Doctor queue, Lab queue, Pharmacy, POS) where vertical space matters more
 * than a page's identity does — smaller title, tighter gap, no description
 * row by default.
 */
export function WorkspaceHeader({
  title,
  meta,
  actions,
  className,
}: {
  title: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-2", className)}>
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold tracking-tight text-foreground">{title}</h1>
        {meta && <div className="text-sm text-muted-foreground">{meta}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

/** §21 — a section heading inside a page (not the page's own title) — one consistent size/weight/spacing instead of each section inventing its own. */
export function SectionHeader({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex items-center justify-between gap-2", className)}>
      <div className="grid gap-0.5">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  )
}
