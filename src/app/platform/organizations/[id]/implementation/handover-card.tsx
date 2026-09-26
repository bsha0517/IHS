"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { formatDateTime } from "@/lib/utils/dates"
import { completeHandoverAction } from "@/app/platform/organizations/[id]/implementation/actions"

/**
 * P5.8 §30: mirrors `GoLiveApprovalCard`'s own shape exactly — the button is
 * enabled purely as a UI convenience; `completeHandover()` re-checks
 * `commercialLifecycle === "live"` and re-runs `getGoLiveBlockers()`
 * server-side regardless of what this component renders.
 */
export function HandoverCard({
  organizationId,
  alreadyLive,
  alreadyCompleted,
  completedAt,
  completedByEmail,
  canComplete,
}: {
  organizationId: string
  alreadyLive: boolean
  alreadyCompleted: boolean
  completedAt: Date | null
  completedByEmail: string | null
  canComplete: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  if (alreadyCompleted) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Handover</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert>
            <AlertDescription>
              Handover completed{completedAt ? ` on ${formatDateTime(completedAt)}` : ""}
              {completedByEmail ? ` by ${completedByEmail}` : ""}.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    )
  }

  function submit() {
    startTransition(async () => {
      setError(null)
      const result = await completeHandoverAction(organizationId)
      if (result.error) setError(result.error)
      else {
        setOpen(false)
        router.refresh()
      }
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Handover</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {!alreadyLive ? (
          <Alert>
            <AlertTitle>Not yet ready</AlertTitle>
            <AlertDescription>This organization must be approved for go-live before handover can be completed.</AlertDescription>
          </Alert>
        ) : !canComplete ? (
          <Alert variant="destructive">
            <AlertTitle>Blockers remain</AlertTitle>
            <AlertDescription>Resolve the current go-live blockers above before completing handover.</AlertDescription>
          </Alert>
        ) : (
          <Alert>
            <AlertDescription>This organization is live with no outstanding go-live blockers — implementation handover can be completed.</AlertDescription>
          </Alert>
        )}
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" disabled={!alreadyLive || !canComplete} className="justify-self-start">
              Complete handover
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Complete implementation handover</DialogTitle>
            </DialogHeader>
            <div className="grid gap-3">
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <p className="text-sm text-muted-foreground">
                This records that the implementation project is finished and the clinic has been handed over — the server re-checks go-live status and
                blockers before applying this, regardless of what this page currently shows.
              </p>
            </div>
            <DialogFooter>
              <Button disabled={pending} onClick={submit}>
                {pending ? "Completing..." : "Confirm handover"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  )
}
