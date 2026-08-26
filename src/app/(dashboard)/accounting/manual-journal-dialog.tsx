"use client"

import { useState } from "react"
import { Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { createManualJournalAction, type ActionState } from "@/app/(dashboard)/accounting/actions"

const initialState: ActionState = {}

type Line = { accountId: string; debit: string; credit: string }

export function ManualJournalDialog({
  accounts,
  branches,
}: {
  accounts: { id: string; code: string; name: string }[]
  branches: { id: string; name: string }[]
}) {
  const { open, setOpen, state, pending, submit } = useActionDialog(createManualJournalAction, initialState)
  const [lines, setLines] = useState<Line[]>([
    { accountId: "", debit: "", credit: "" },
    { accountId: "", debit: "", credit: "" },
  ])

  function update(index: number, field: keyof Line, value: string) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, [field]: value } : l)))
  }

  const totalDebit = lines.reduce((sum, l) => sum + (Number(l.debit) || 0), 0)
  const totalCredit = lines.reduce((sum, l) => sum + (Number(l.credit) || 0), 0)
  const balanced = Math.abs(totalDebit - totalCredit) < 0.01 && totalDebit > 0

  function handleSubmit(formData: FormData) {
    formData.set(
      "lines",
      JSON.stringify(
        lines
          .filter((l) => l.accountId)
          .map((l) => ({ accountId: l.accountId, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0 }))
      )
    )
    submit(formData)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus /> Manual journal
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New manual journal entry</DialogTitle>
        </DialogHeader>
        <form action={handleSubmit} className="grid gap-4">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="branchId">Branch</Label>
              <Select name="branchId" required>
                <SelectTrigger id="branchId" className="w-full">
                  <SelectValue placeholder="Select a branch" />
                </SelectTrigger>
                <SelectContent>
                  {branches.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="journalDate">Date</Label>
              <Input id="journalDate" name="journalDate" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="description">Description</Label>
            <Textarea id="description" name="description" required />
          </div>

          <div className="grid gap-2">
            <Label className="text-xs">Lines</Label>
            {lines.map((line, index) => (
              <div key={index} className="grid grid-cols-[1fr_100px_100px_auto] items-end gap-2">
                <Select value={line.accountId} onValueChange={(v) => update(index, "accountId", v)}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Account" />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.code} — {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Debit"
                  value={line.debit}
                  onChange={(e) => update(index, "debit", e.target.value)}
                />
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Credit"
                  value={line.credit}
                  onChange={(e) => update(index, "credit", e.target.value)}
                />
                {lines.length > 2 && (
                  <Button type="button" size="icon-sm" variant="ghost" onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}>
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => setLines((prev) => [...prev, { accountId: "", debit: "", credit: "" }])}>
              <Plus /> Add line
            </Button>
            <p className={`text-xs ${balanced ? "text-muted-foreground" : "text-destructive"}`}>
              Debit {totalDebit.toFixed(2)} — Credit {totalCredit.toFixed(2)} {balanced ? "(balanced)" : "(must balance before posting)"}
            </p>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending || !balanced}>
              {pending ? "Posting..." : "Post journal"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
