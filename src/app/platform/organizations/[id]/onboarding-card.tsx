"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { updateOnboardingStatusAction, updateUatStatusAction } from "@/app/platform/organizations/[id]/actions"
import type { $Enums } from "@/generated/prisma/client"

const ONBOARDING_STATUSES: $Enums.CommercialOnboardingStatus[] = ["not_started", "in_progress", "ready_for_uat", "uat", "ready_for_go_live", "live"]
const UAT_STATUSES: $Enums.UatStatus[] = ["not_started", "in_progress", "passed", "failed"]

/**
 * P5.1 §30/§31: this is the human implementation-workflow state — never a
 * substitute for readiness.ts's own derived technical readiness. Nothing
 * here can mark a missing accounting mapping "done"; it only records where
 * the project itself stands.
 */
export function OnboardingCard({
  organizationId,
  onboardingStatus,
  uatStatus,
  uatNote,
}: {
  organizationId: string
  onboardingStatus: $Enums.CommercialOnboardingStatus
  uatStatus: $Enums.UatStatus
  uatNote: string | null
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [note, setNote] = useState(uatNote ?? "")
  const [error, setError] = useState<string | null>(null)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Onboarding &amp; UAT</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="grid gap-1.5">
          <Label>Onboarding status</Label>
          <Select
            defaultValue={onboardingStatus}
            disabled={pending}
            onValueChange={(value) =>
              startTransition(async () => {
                setError(null)
                const result = await updateOnboardingStatusAction(organizationId, value as $Enums.CommercialOnboardingStatus)
                if (result.error) setError(result.error)
                else router.refresh()
              })
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ONBOARDING_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s.replace(/_/g, " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label>UAT status</Label>
          <Select
            defaultValue={uatStatus}
            disabled={pending}
            onValueChange={(value) =>
              startTransition(async () => {
                setError(null)
                const result = await updateUatStatusAction(organizationId, value as $Enums.UatStatus, note)
                if (result.error) setError(result.error)
                else router.refresh()
              })
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {UAT_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s.replace(/_/g, " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="uatNote">UAT note (non-sensitive reference only)</Label>
          <Textarea id="uatNote" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          <Button
            size="sm"
            variant="outline"
            className="justify-self-start"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                setError(null)
                const result = await updateUatStatusAction(organizationId, uatStatus, note)
                if (result.error) setError(result.error)
                else router.refresh()
              })
            }
          >
            Save note
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
