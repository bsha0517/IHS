import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * P4.7A §28/§29 — the one filter-form shell (Reports, Inventory ledger,
 * Accounting journals, Clinical Access Log, Purchasing, ... already each
 * had their own near-identical `<form method="get" className="flex
 * flex-wrap items-end gap-4">` — this formalizes that exact shape as a
 * shared component instead of copy-pasted markup). Wraps naturally on
 * narrow viewports (§29's "smaller screens: wrap intelligently") — no
 * separate mobile filter sheet was built; a wrapped filter row stays fully
 * usable at 768px and below without hiding any control.
 */
export function FilterBar({ children, className, ...props }: { children: ReactNode; className?: string } & React.ComponentProps<"form">) {
  return (
    <form className={cn("flex flex-wrap items-end gap-3 rounded-md border border-border bg-card p-3", className)} {...props}>
      {children}
    </form>
  )
}

/** One label+control pair, sized consistently — the unit `FilterBar` is built from. */
export function FilterField({ label, htmlFor, children, className }: { label: string; htmlFor?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid gap-1", className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  )
}
