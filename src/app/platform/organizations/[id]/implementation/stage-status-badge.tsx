import { Badge, type badgeVariants } from "@/components/ui/badge"
import type { VariantProps } from "class-variance-authority"
import type { ImplementationStageStatus, ImplementationBlockerSeverity } from "@/lib/domains/commercial/implementation"

/**
 * P5.8 §8: the 5-value stage-status vocabulary is a derived TS union, not a
 * DB enum `StatusBadge` already has tone mappings for — "blocked" in
 * particular needs to read as destructive, not the neutral gray the shared
 * component's own keyword fallback would give it. Kept local to this route
 * rather than added to the global status-tone map, since this vocabulary
 * only exists here.
 */
const STAGE_VARIANT: Record<ImplementationStageStatus, VariantProps<typeof badgeVariants>["variant"]> = {
  not_started: "neutral",
  in_progress: "info",
  blocked: "destructive",
  ready: "warning",
  complete: "success",
}
const STAGE_LABEL: Record<ImplementationStageStatus, string> = {
  not_started: "Not Started",
  in_progress: "In Progress",
  blocked: "Blocked",
  ready: "Ready",
  complete: "Complete",
}

export function StageStatusBadge({ status }: { status: ImplementationStageStatus }) {
  return <Badge variant={STAGE_VARIANT[status]}>{STAGE_LABEL[status]}</Badge>
}

const SEVERITY_VARIANT: Record<ImplementationBlockerSeverity, VariantProps<typeof badgeVariants>["variant"]> = {
  blocking: "destructive",
  warning: "warning",
  information: "info",
}
const SEVERITY_LABEL: Record<ImplementationBlockerSeverity, string> = {
  blocking: "Blocking",
  warning: "Warning",
  information: "Information",
}

export function SeverityBadge({ severity }: { severity: ImplementationBlockerSeverity }) {
  return <Badge variant={SEVERITY_VARIANT[severity]}>{SEVERITY_LABEL[severity]}</Badge>
}
