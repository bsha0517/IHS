"use client"

import { useState } from "react"
import { Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { recordPaymentAction, type ActionState } from "@/app/(dashboard)/pos/actions"

const initialState: ActionState = {}

const METHODS = ["cash", "card", "bank", "online", "insurance", "credit", "other"] as const

type Tender = { method: (typeof METHODS)[number]; amount: string; reference: string }

export function RecordPaymentDialog({
  invoiceId,
  cashierSessionId,
  outstanding,
}: {
  invoiceId: string
  cashierSessionId: string
  outstanding: number
}) {
  const { open, setOpen, state, pending, submit } = useActionDialog(recordPaymentAction, initialState)
  const [tenders, setTenders] = useState<Tender[]>([{ method: "cash", amount: outstanding.toFixed(2), reference: "" }])

  function update(index: number, field: keyof Tender, value: string) {
    setTenders((prev) => prev.map((t, i) => (i === index ? { ...t, [field]: value } : t)))
  }

  function handleSubmit(formData: FormData) {
    formData.set(
      "tenders",
      JSON.stringify(tenders.filter((t) => Number(t.amount) > 0).map((t) => ({ ...t, reference: t.reference || undefined })))
    )
    submit(formData)
  }

  const totalTendered = tenders.reduce((sum, t) => sum + (Number(t.amount) || 0), 0)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">Record payment</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record payment</DialogTitle>
        </DialogHeader>
        <form action={handleSubmit} className="grid gap-4">
          <input type="hidden" name="invoiceId" value={invoiceId} />
          <input type="hidden" name="cashierSessionId" value={cashierSessionId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <p className="text-sm text-muted-foreground">Outstanding balance: {outstanding.toFixed(2)}</p>

          <div className="grid gap-2">
            {tenders.map((tender, index) => (
              <div key={index} className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-2">
                <div className="grid gap-1">
                  <Label className="text-xs">Method</Label>
                  <Select value={tender.method} onValueChange={(v) => update(index, "method", v)}>
                    <SelectTrigger className="w-full">
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
                <div className="grid gap-1">
                  <Label className="text-xs">Amount</Label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={tender.amount}
                    onChange={(e) => update(index, "amount", e.target.value)}
                  />
                </div>
                <div className="grid gap-1">
                  <Label className="text-xs">Reference</Label>
                  <Input value={tender.reference} onChange={(e) => update(index, "reference", e.target.value)} />
                </div>
                {tenders.length > 1 && (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => setTenders((prev) => prev.filter((_, i) => i !== index))}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
              </div>
            ))}
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setTenders((prev) => [...prev, { method: "cash", amount: "", reference: "" }])}
          >
            <Plus /> Add tender
          </Button>

          <p className="text-sm font-medium">Total tendered: {totalTendered.toFixed(2)}</p>

          <DialogFooter>
            <Button type="submit" disabled={pending || totalTendered <= 0}>
              {pending ? "Recording..." : "Record payment"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
