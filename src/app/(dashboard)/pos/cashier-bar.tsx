"use client"

import { useState } from "react"
import { useActionState } from "react"
import { Plus, Lock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { formatDateTime } from "@/lib/utils/dates"
import { recordCashMovementAction, closeCashierSessionAction, type ActionState } from "@/app/(dashboard)/pos/actions"

const initialState: ActionState = {}

export function CashierBar({ cashierSession }: { cashierSession: { id: string; branchName: string; openingCash: number; openedAt: Date } }) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
        <div className="text-sm">
          <p className="font-medium">Register open — {cashierSession.branchName}</p>
          <p className="text-muted-foreground">
            Opened {formatDateTime(cashierSession.openedAt)} · Opening cash {cashierSession.openingCash.toFixed(2)}
          </p>
        </div>
        <div className="flex gap-2">
          <CashMovementDialog cashierSessionId={cashierSession.id} />
          <CloseRegisterDialog cashierSessionId={cashierSession.id} />
        </div>
      </CardContent>
    </Card>
  )
}

function CashMovementDialog({ cashierSessionId }: { cashierSessionId: string }) {
  const { open, setOpen, state, pending, submit } = useActionDialog(recordCashMovementAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus /> Cash movement
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record cash movement</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="cashierSessionId" value={cashierSessionId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="direction">Direction</Label>
            <Select name="direction" defaultValue="out">
              <SelectTrigger id="direction" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="in">Cash in (float top-up)</SelectItem>
                <SelectItem value="out">Cash out (drop / petty cash)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="amount">Amount</Label>
            <Input id="amount" name="amount" type="number" step="0.01" min="0.01" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="reason">Reason</Label>
            <Textarea id="reason" name="reason" required />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Record movement"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function CloseRegisterDialog({ cashierSessionId }: { cashierSessionId: string }) {
  const [open, setOpen] = useState(false)
  const [state, formAction, pending] = useActionState(closeCashierSessionAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="destructive">
          <Lock /> Close register
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Close register</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="grid gap-4">
          <input type="hidden" name="cashierSessionId" value={cashierSessionId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <p className="text-sm text-muted-foreground">
            Count the physical cash drawer and enter the total. Expected cash and variance are computed automatically.
          </p>
          <div className="grid gap-2">
            <Label htmlFor="actualCash">Actual cash counted</Label>
            <Input id="actualCash" name="actualCash" type="number" step="0.01" min="0" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="notes">Notes (optional)</Label>
            <Textarea id="notes" name="notes" />
          </div>
          <DialogFooter>
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending ? "Closing..." : "Close register"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
