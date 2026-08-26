"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { FilePlus2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { createClaimAction, type ActionState } from "@/app/(dashboard)/claims/actions"

const initialState: ActionState = {}

export function CreateClaimDialog({
  invoiceId,
  coverages,
  lines,
}: {
  invoiceId: string
  coverages: { id: string; label: string }[]
  lines: { id: string; description: string; lineTotal: number }[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<ActionState>(initialState)
  const [pending, startTransition] = useTransition()
  const [selected, setSelected] = useState<Set<string>>(new Set(lines.map((l) => l.id)))

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function handleSubmit(formData: FormData) {
    const items = lines.filter((l) => selected.has(l.id)).map((l) => ({ invoiceLineId: l.id }))
    formData.set("items", JSON.stringify(items))
    startTransition(async () => {
      const result = await createClaimAction(initialState, formData)
      if (result.success && result.claimId) {
        setOpen(false)
        router.push(`/claims/${result.claimId}`)
      } else {
        setState(result)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <FilePlus2 className="size-3.5" /> Create claim
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create insurance claim</DialogTitle>
        </DialogHeader>
        <form action={handleSubmit} className="grid gap-4">
          <input type="hidden" name="invoiceId" value={invoiceId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="patientCoverageId">Bill to coverage</Label>
            <Select name="patientCoverageId" required>
              <SelectTrigger id="patientCoverageId" className="w-full">
                <SelectValue placeholder="Select coverage" />
              </SelectTrigger>
              <SelectContent>
                {coverages.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label className="text-xs">Invoice lines to claim</Label>
            <div className="grid max-h-48 gap-2 overflow-y-auto rounded-md border border-border p-2">
              {lines.map((l) => (
                <label key={l.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex items-center gap-2">
                    <Checkbox checked={selected.has(l.id)} onCheckedChange={() => toggle(l.id)} />
                    {l.description}
                  </span>
                  <span className="text-muted-foreground">{l.lineTotal.toFixed(2)}</span>
                </label>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending || selected.size === 0}>
              {pending ? "Creating..." : "Create claim"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
