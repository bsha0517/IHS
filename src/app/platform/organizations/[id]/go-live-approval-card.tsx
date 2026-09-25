"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { approveGoLiveAction } from "@/app/platform/organizations/[id]/actions"

/**
 * P5.2 §4: `blockers` is computed server-side by `getGoLiveBlockers()` — the
 * EXACT list `approveGoLive()` itself would reject on, never a separately
 * maintained UI copy of the readiness rules. This card can only ever be
 * wrong in the safe direction (showing a blocker that's since been
 * resolved, stale until the next page load) — it can never let an
 * unqualified organization through, since the server re-validates on submit
 * regardless of what this component renders.
 */
export function GoLiveApprovalCard({ organizationId, blockers, alreadyLive }: { organizationId: string; blockers: string[]; alreadyLive: boolean }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [notes, setNotes] = useState("")
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  if (alreadyLive) return null

  function submit() {
    startTransition(async () => {
      setError(null)
      const result = await approveGoLiveAction(organizationId, notes)
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
        <CardTitle className="text-base">Go-live approval</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {blockers.length > 0 ? (
          <Alert variant="destructive">
            <AlertTitle>Not ready for go-live</AlertTitle>
            <AlertDescription>
              <ul className="list-inside list-disc">
                {blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : (
          <Alert>
            <AlertDescription>Every required condition is satisfied — this organization can be approved for go-live.</AlertDescription>
          </Alert>
        )}
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" disabled={blockers.length > 0} className="justify-self-start">
              Approve go-live
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Approve this organization for go-live</DialogTitle>
            </DialogHeader>
            <div className="grid gap-3">
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <p className="text-sm text-muted-foreground">
                This moves the organization&apos;s commercial lifecycle and onboarding status to LIVE. The server re-validates every go-live
                condition, subscription state, and required onboarding item before applying this — it will reject the change if anything has
                regressed since this page loaded.
              </p>
              <Textarea placeholder="Approval notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
            </div>
            <DialogFooter>
              <Button disabled={pending} onClick={submit}>
                {pending ? "Approving..." : "Confirm approval"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  )
}
