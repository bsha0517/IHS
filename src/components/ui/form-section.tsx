import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * P4.7A §31/§32 — groups a large form (Patient registration, Employee,
 * Provider, Product, Organization settings, ...) into labeled sections
 * instead of one long unbroken field list. `grid` defaults to a
 * responsive 2-column layout on desktop, 1 column on mobile (§32) — pass
 * `grid={false}` for a section whose fields should stack full-width
 * regardless (e.g. a single long narrative textarea).
 */
export function FormSection({
  title,
  description,
  children,
  grid = true,
  className,
}: {
  title: string
  description?: string
  children: ReactNode
  grid?: boolean
  className?: string
}) {
  return (
    <fieldset className={cn("grid gap-4 rounded-lg border border-border p-4", className)}>
      <legend className="-ml-1 px-1 text-sm font-semibold text-foreground">{title}</legend>
      {description && <p className="-mt-2 text-xs text-muted-foreground">{description}</p>}
      <div className={grid ? "grid gap-4 sm:grid-cols-2" : "grid gap-4"}>{children}</div>
    </fieldset>
  )
}

/** A field wide enough to always span the full row, even inside a 2-column FormSection grid — for a long narrative field (clinical notes, address) or anything else that shouldn't share a row. */
export function FormFieldFull({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("sm:col-span-2", className)}>{children}</div>
}
