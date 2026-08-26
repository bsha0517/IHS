"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
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

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Follow-up</CardTitle>
        {canEdit && <AddFollowUpDialog encounterId={encounterId} />}
      </CardHeader>
      <CardContent className="grid gap-2">
        {followUps.length === 0 && <p className="text-sm text-muted-foreground">No follow-up recommended.</p>}
        {followUps.map((f) => (
          <div key={f.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
            <div>
              <p className="font-medium">{formatDate(f.recommendedDate)}</p>
              {f.reason && <p className="text-muted-foreground">{f.reason}</p>}
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={f.status === "open" ? "outline" : "secondary"}>{f.status}</Badge>
              {canEdit && f.status === "open" && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      await dismissFollowUpAction(encounterId, f.id)
                      router.refresh()
                    })
                  }
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
