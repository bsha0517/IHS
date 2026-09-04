"use client"

import { useState } from "react"
import { Plus, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { createDispensingRecordAction, type ActionState } from "@/app/(dashboard)/pharmacy/actions"
import { looksLikeSameMedication } from "@/lib/utils/medication-match"

const initialState: ActionState = {}

export function DispenseItemDialog({
  prescriptionId,
  prescriptionItemId,
  medications,
  prescribed,
}: {
  prescriptionId: string
  prescriptionItemId: string
  medications: { id: string; name: string; label: string; balance: number }[]
  /** P3.6 §9/§11: what the doctor actually prescribed — shown alongside the
   * medication picker so a pharmacist can visually cross-check the selection
   * against it. Targeted backlog closure, item 8: a real, server-enforced
   * cross-check now backs this — see medication-match.ts's own doc comment
   * for the deliberately simple, non-clinical trigger it uses. */
  prescribed: { medicationName: string; strength: string | null; dose: string; route: string; frequency: string }
}) {
  const { open, setOpen, state, pending, submit } = useActionDialog(createDispensingRecordAction, initialState)
  const [selectedMedicationId, setSelectedMedicationId] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)

  const selected = medications.find((m) => m.id === selectedMedicationId) ?? null
  const isMismatch = selected != null && !looksLikeSameMedication(prescribed.medicationName, selected.name)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus /> Dispense
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Dispense medication</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="prescriptionId" value={prescriptionId} />
          <input type="hidden" name="prescriptionItemId" value={prescriptionItemId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="rounded-md border border-border bg-muted/40 p-2 text-sm">
            <p className="font-medium">
              Prescribed: {prescribed.medicationName} {prescribed.strength ?? ""}
            </p>
            <p className="text-muted-foreground">
              {prescribed.dose} · {prescribed.frequency} · {prescribed.route}
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="medicationId">Medication to dispense</Label>
            <Select
              name="medicationId"
              required
              onValueChange={(v) => {
                setSelectedMedicationId(v)
                setConfirmed(false) // re-selecting always requires a fresh confirmation
              }}
            >
              <SelectTrigger id="medicationId" className="w-full">
                <SelectValue placeholder="Select a medication" />
              </SelectTrigger>
              <SelectContent>
                {medications.map((m) => (
                  <SelectItem key={m.id} value={m.id} disabled={m.balance <= 0}>
                    {m.label} — {m.balance > 0 ? `${m.balance} in stock` : "out of stock"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Stock is consumed oldest-expiry-first (FEFO) automatically — no manual batch selection.</p>
          </div>
          {isMismatch && (
            <Alert variant="destructive">
              <TriangleAlert className="size-4" />
              <AlertDescription>
                <p className="mb-1 font-semibold uppercase tracking-wide text-[11px]">Substitution warning</p>
                <p>
                  Selected medication (&quot;{selected!.name}&quot;) differs from the prescribed medication (&quot;
                  {prescribed.medicationName}&quot;). Confirm that this is an intended substitution — a valid brand/generic
                  swap is not blocked, but must be explicitly confirmed by you.
                </p>
                <label className="mt-2 flex items-center gap-2 font-medium">
                  <Checkbox
                    checked={confirmed}
                    onCheckedChange={(c) => setConfirmed(c === true)}
                    // Not `name="substitutionConfirmed"` directly — a hidden
                    // input below carries the actual submitted value so an
                    // unchecked-then-removed Checkbox can't silently omit
                    // the field the server-side check expects.
                  />
                  I confirm this substitution is intentional
                </label>
              </AlertDescription>
            </Alert>
          )}
          <input type="hidden" name="substitutionConfirmed" value={isMismatch && confirmed ? "on" : ""} />
          <div className="grid gap-2">
            <Label htmlFor="quantityDispensed">Quantity</Label>
            <Input id="quantityDispensed" name="quantityDispensed" type="number" min="1" step="1" required />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending || (isMismatch && !confirmed)}>
              {pending ? "Saving..." : "Create dispensing record"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
