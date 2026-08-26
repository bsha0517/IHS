"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { enterNumericResultAction, enterTextResultAction, verifyResultAction, type ActionState } from "@/app/(dashboard)/laboratory/actions"

const initialState: ActionState = {}

export function ResultEntryDialog({
  labOrderTestId,
  clinicalOrderId,
  resultType,
  testName,
  unit,
}: {
  labOrderTestId: string
  clinicalOrderId: string
  resultType: "numeric" | "text"
  testName: string
  unit: string | null
}) {
  const action = resultType === "numeric" ? enterNumericResultAction : enterTextResultAction
  const { open, setOpen, state, pending, submit } = useActionDialog(action, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Enter result
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{testName}</DialogTitle>
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
              {pending ? "Saving..." : "Save result"}
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
  return (
    <Button
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await verifyResultAction(labOrderTestId, clinicalOrderId)
          router.refresh()
        })
      }
    >
      <Pencil className="size-3.5" /> Verify
    </Button>
  )
}
