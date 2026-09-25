import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { Card, CardContent } from "@/components/ui/card"
import { MODULE_VISUAL, type ModuleKey } from "@/components/layout/module-visual"

/** P4.10 Stage 2 §8 — the small icon container every header variant below
 * renders when a `module` is passed, sized to match its context (a
 * PageHeader's is a touch larger than a WorkspaceHeader's denser one). */
function ModuleIcon({ module, size = "default" }: { module: ModuleKey; size?: "default" | "sm" }) {
  const { icon: Icon, accent, surface } = MODULE_VISUAL[module]
  return (
    <span className={cn("flex shrink-0 items-center justify-center rounded-md", surface, size === "sm" ? "size-6" : "size-8")}>
      <Icon className={cn(accent, size === "sm" ? "size-3.5" : "size-4")} aria-hidden="true" />
    </span>
  )
}

/**
 * P4.7A §19 — the one page-title pattern every route should use instead of
 * each page hand-rolling its own `<h1>` size/weight/spacing/action-button
 * placement. Deliberately small: title, an optional one-line description,
 * and two action slots (primary — the single most important action on this
 * screen, secondary — everything else). Not a "put anything anywhere"
 * component; §62's own "do not have multiple primary actions competing on
 * one screen" is enforced structurally by there being exactly one
 * `primaryAction` slot.
 *
 * P4.10 Stage 2 §8 — optional `module` renders a small module-identity icon
 * next to the title (§6's central config) — never required, so every
 * existing caller keeps compiling unchanged.
 */
export function PageHeader({
  title,
  description,
  module,
  primaryAction,
  secondaryActions,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  module?: ModuleKey
  primaryAction?: ReactNode
  secondaryActions?: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between", className)}>
      <div className="flex items-start gap-3">
        {module && <ModuleIcon module={module} />}
        <div className="grid gap-1">
          {/* P4.10 §19/§20 — a real size step up from a page's section
              headings (SectionHeader below stays text-sm) instead of both
              reading as "medium bold text" at a glance. */}
          <h1 className="font-heading text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
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
 *
 * P4.10 Stage 2 §8 — same optional `module` icon, sized down to match.
 */
export function WorkspaceHeader({
  title,
  meta,
  module,
  actions,
  className,
}: {
  title: ReactNode
  meta?: ReactNode
  module?: ModuleKey
  actions?: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-2", className)}>
      <div className="flex items-center gap-3">
        {module && <ModuleIcon module={module} size="sm" />}
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

/**
 * P4.10 Stage 2 §9/§19/§44 — the one detail-record header treatment: a
 * module-colored left accent border card that answers "what record am I
 * working on" before anything else on the page. This is the exact structure
 * Patient 360 and the Encounter workspace already established in Stage 1
 * (`<Card className="border-l-4 border-l-primary">`) — generalized so the
 * ~10 secondary detail routes P4.7A left visually basic (§44) get the same
 * treatment instead of a bare `<h1>`, with the border tinted to the
 * record's own module instead of always primary.
 */
export function DetailHeader({
  module,
  title,
  meta,
  badge,
  actions,
  alert,
  className,
}: {
  module: ModuleKey
  title: ReactNode
  meta?: ReactNode
  /** A StatusBadge or similar — rendered inline next to the title. */
  badge?: ReactNode
  actions?: ReactNode
  /** A destructive-toned alert block (icon + text), same convention as Patient 360/Encounter — never color alone. */
  alert?: ReactNode
  className?: string
}) {
  const { border } = MODULE_VISUAL[module]
  return (
    <Card className={cn("border-l-4", border, className)}>
      <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
            {badge}
          </div>
          {meta && <div className="text-sm text-muted-foreground">{meta}</div>}
          {alert}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2 sm:items-end">{actions}</div>}
      </CardContent>
    </Card>
  )
}
