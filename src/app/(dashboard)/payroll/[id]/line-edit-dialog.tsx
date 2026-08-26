"use client"

import { Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { updatePayrollLineAction, type ActionState } from "@/app/(dashboard)/payroll/actions"

const initialState: ActionState = {}

type Line = {
  id: string
  payrollRunId: string
  allowances: number
  overtime: number
  bonus: number
  advances: number
  unpaidLeaveDeduction: number
  otherDeductions: number
}

export function LineEditDialog({ line }: { line: Line }) {
  const { open, setOpen, state, pending, submit } = useActionDialog(updatePayrollLineAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label="Edit line">
          <Pencil className="size-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit payroll line</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="lineId" value={line.id} />
          <input type="hidden" name="payrollRunId" value={line.payrollRunId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="allowances">Allowances</Label>
              <Input id="allowances" name="allowances" type="number" min="0" step="0.01" defaultValue={line.allowances} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="overtime">Overtime</Label>
              <Input id="overtime" name="overtime" type="number" min="0" step="0.01" defaultValue={line.overtime} />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="bonus">Bonus</Label>
            <Input id="bonus" name="bonus" type="number" min="0" step="0.01" defaultValue={line.bonus} />
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="advances">Advances</Label>
              <Input id="advances" name="advances" type="number" min="0" step="0.01" defaultValue={line.advances} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="unpaidLeaveDeduction">Unpaid leave</Label>
              <Input id="unpaidLeaveDeduction" name="unpaidLeaveDeduction" type="number" min="0" step="0.01" defaultValue={line.unpaidLeaveDeduction} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="otherDeductions">Other deductions</Label>
              <Input id="otherDeductions" name="otherDeductions" type="number" min="0" step="0.01" defaultValue={line.otherDeductions} />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
