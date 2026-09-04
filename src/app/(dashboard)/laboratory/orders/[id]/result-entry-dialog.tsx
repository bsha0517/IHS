"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import {
  enterNumericResultAction,
  enterTextResultAction,
  amendNumericResultAction,
  amendTextResultAction,
  verifyResultAction,
  type ActionState,
} from "@/app/(dashboard)/laboratory/actions"

const initialState: ActionState = {}

export function ResultEntryDialog({
  labOrderTestId,
  clinicalOrderId,
  resultType,
  testName,
  unit,
  mode = "enter",
}: {
  labOrderTestId: string
  clinicalOrderId: string
  resultType: "numeric" | "text"
  testName: string
  unit: string | null
  /** P1 §21: "amend" targets a verified result, creating a new isCurrent row rather than editing it in place. */
  mode?: "enter" | "amend"
}) {
  const action =
    mode === "amend"
      ? resultType === "numeric"
        ? amendNumericResultAction
        : amendTextResultAction
      : resultType === "numeric"
        ? enterNumericResultAction
        : enterTextResultAction
  const { open, setOpen, state, pending, submit } = useActionDialog(action, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          {mode === "amend" ? "Amend result" : "Enter result"}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {mode === "amend" ? "Amend " : ""}
            {testName}
          </DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="labOrderTestId" value={labOrderTestId} />
          <input type="hidden" name="clinicalOrderId" value={clinicalOrderId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          {resultType === "numeric" ? (
            <div className="grid gap-2">
              <Label htmlFor="numericValue">Value {unit ? `(${unit})` : ""}</Label>
              <Input id="numericValue" name="numericValue" type="number" step="0.001" required />
            </div>
          ) : (
            <div className="grid gap-2">
              <Label htmlFor="textValue">Result</Label>
              <Textarea id="textValue" name="textValue" required />
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" name="notes" />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : mode === "amend" ? "Save amendment" : "Save result"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function VerifyButton({ labOrderTestId, clinicalOrderId }: { labOrderTestId: string; clinicalOrderId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  // P3.5 §27/§34: this had no error handling — a stale-state race (e.g. a
  // second technician verifying the same line first) or this batch's own
  // new branch-access check would have surfaced only the generic error
  // boundary instead of the domain layer's real message.
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        disabled={pending}
        onClick={() => {
          setError(null)
          startTransition(async () => {
            try {
              await verifyResultAction(labOrderTestId, clinicalOrderId)
              router.refresh()
            } catch (e) {
              setError(e instanceof Error ? e.message : "Couldn't verify this result.")
            }
          })
        }}
      >
        <Pencil className="size-3.5" /> Verify
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
