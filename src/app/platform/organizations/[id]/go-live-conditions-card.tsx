"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { StatusBadge } from "@/components/ui/status-badge"
import { updateGoLiveConditionAction } from "@/app/platform/organizations/[id]/actions"
import { formatDateTime } from "@/lib/utils/dates"
import type { $Enums } from "@/generated/prisma/client"

const CONDITION_LABELS: Record<$Enums.GoLiveConditionCode, string> = {
  backup_restore_rehearsal: "Hosted backup + isolated restore rehearsal",
  error_monitoring: "External production error monitoring",
  clinic_uat_signoff: "Clinic-specific UAT / signoff",
  transactional_email: "Transactional email (conditional — required for self-service reset/activation)",
}

type Condition = {
  code: $Enums.GoLiveConditionCode
  status: $Enums.GoLiveConditionStatus
  note: string | null
  completedAt: Date | null
  completedByOperatorId: string | null
}

/**
 * P5.1 §33/§34/§36: these four remain the authoritative external
 * prerequisites for a real first-clinic go-live established by P4.9.1 —
 * this card is evidence tracking, never the external system itself. A
 * condition here is never auto-completed by anything in this codebase.
 * P5.2 §3 adds `blocked` (actively obstructed, distinct from merely not yet
 * attempted) and "who/when verified" — `operatorEmails` resolves the raw
 * `completedByOperatorId` into something readable.
 */
export function GoLiveConditionsCard({
  organizationId,
  conditions,
  operatorEmails,
}: {
  organizationId: string
  conditions: Condition[]
  operatorEmails: Record<string, string>
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>(Object.fromEntries(conditions.map((c) => [c.code, c.note ?? ""])))

  function setStatus(code: $Enums.GoLiveConditionCode, status: $Enums.GoLiveConditionStatus) {
    startTransition(async () => {
      setError(null)
      const result = await updateGoLiveConditionAction(organizationId, code, status, notes[code] ?? "")
      if (result.error) setError(result.error)
      else router.refresh()
    })
  }

  const allComplete = conditions.every((c) => c.status === "complete" || c.status === "not_applicable")

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">External go-live conditions</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {!allComplete && (
          <Alert variant="destructive">
            <AlertDescription>Not every external condition is complete or marked not applicable — this clinic is not yet cleared for a real go-live per P4.9.1&apos;s own checklist.</AlertDescription>
          </Alert>
        )}
        {conditions.map((c) => (
          <div key={c.code} className="grid gap-2 rounded-md border border-border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{CONDITION_LABELS[c.code]}</span>
              <StatusBadge status={c.status} />
            </div>
            {c.completedAt && (
              <p className="text-xs text-muted-foreground">
                Verified {formatDateTime(c.completedAt)}
                {c.completedByOperatorId && ` by ${operatorEmails[c.completedByOperatorId] ?? c.completedByOperatorId}`}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Input
                placeholder="Non-sensitive reference/note only — no credentials, tokens, or backup files"
                value={notes[c.code] ?? ""}
                onChange={(e) => setNotes((prev) => ({ ...prev, [c.code]: e.target.value }))}
                className="max-w-sm"
              />
              <Button size="sm" variant="outline" disabled={pending} onClick={() => setStatus(c.code, "pending")}>
                Pending
              </Button>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => setStatus(c.code, "blocked")}>
                Blocked
              </Button>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => setStatus(c.code, "not_applicable")}>
                N/A
              </Button>
              <Button size="sm" disabled={pending} onClick={() => setStatus(c.code, "complete")}>
                Mark verified
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
