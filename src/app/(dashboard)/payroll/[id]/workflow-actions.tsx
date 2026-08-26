"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { movePayrollToReviewAction, approvePayrollRunAction, markPayrollPaidAction, type ActionState } from "@/app/(dashboard)/payroll/actions"

const initialState: ActionState = {}
const METHODS = ["cash", "card", "bank", "online", "insurance", "credit", "other"] as const

export function MoveToReviewButton({ payrollRunId }: { payrollRunId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await movePayrollToReviewAction(payrollRunId)
          router.refresh()
        })
      }
    >
      Move to review
    </Button>
  )
}

export function ApproveRunButton({ payrollRunId }: { payrollRunId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return (
    <Button
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await approvePayrollRunAction(payrollRunId)
          router.refresh()
        })
      }
    >
      Approve run
    </Button>
  )
}

export function MarkPaidDialog({ payrollRunId }: { payrollRunId: string }) {
  const { open, setOpen, state, pending, submit } = useActionDialog(markPayrollPaidAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">Mark paid</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Mark payroll paid</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="payrollRunId" value={payrollRunId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="paidVia">Paid via</Label>
            <Select name="paidVia" defaultValue="bank" required>
              <SelectTrigger id="paidVia" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Mark paid"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
