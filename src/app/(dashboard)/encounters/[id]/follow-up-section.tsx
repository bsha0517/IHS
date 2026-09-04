"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { StatusBadge } from "@/components/ui/status-badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { EmptyState } from "@/components/ui/empty-state"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { formatDate } from "@/lib/utils/dates"
import { recommendFollowUpAction, dismissFollowUpAction, type ActionState } from "@/app/(dashboard)/encounters/actions"
import type { FollowUpRecommendation } from "@/generated/prisma/client"

const initialState: ActionState = {}

export function FollowUpSection({
  encounterId,
  followUps,
  canEdit,
}: {
  encounterId: string
  followUps: FollowUpRecommendation[]
  canEdit: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  // Targeted backlog closure, item 5 — same pattern as diagnoses-section.tsx.
  const [actionError, setActionError] = useState<string | null>(null)

  function run(fn: () => Promise<ActionState>) {
    setActionError(null)
    startTransition(async () => {
      try {
        const result = await fn()
        if (result?.error) setActionError(result.error)
        else router.refresh()
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "That action couldn't be completed.")
      }
    })
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Follow-up</CardTitle>
        {canEdit && <AddFollowUpDialog encounterId={encounterId} />}
      </CardHeader>
      <CardContent className="grid gap-2">
        {actionError && (
          <Alert variant="destructive">
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        )}
        {followUps.length === 0 && <EmptyState title="No follow-up recommended" />}
        {followUps.map((f) => (
          <div key={f.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
            <div>
              <p className="font-medium">{formatDate(f.recommendedDate)}</p>
              {f.reason && <p className="text-muted-foreground">{f.reason}</p>}
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge status={f.status} />
              {canEdit && f.status === "open" && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => run(() => dismissFollowUpAction(encounterId, f.id))}
                >
                  Dismiss
                </Button>
              )}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function AddFollowUpDialog({ encounterId }: { encounterId: string }) {
  const { open, setOpen, state, pending, submit } = useActionDialog(recommendFollowUpAction, initialState)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus /> Add
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Recommend follow-up</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="encounterId" value={encounterId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="recommendedDate">Recommended date</Label>
            <Input id="recommendedDate" name="recommendedDate" type="date" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="reason">Reason</Label>
            <Input id="reason" name="reason" />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Add follow-up"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
