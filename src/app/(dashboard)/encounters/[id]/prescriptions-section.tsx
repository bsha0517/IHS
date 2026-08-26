"use client"

import { useState } from "react"
import Link from "next/link"
import { Plus, Trash2, Printer } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { createPrescriptionAction, cancelPrescriptionAction, type ActionState } from "@/app/(dashboard)/encounters/actions"
import { useRouter } from "next/navigation"
import { useTransition } from "react"
import type { Prescription, PrescriptionItem } from "@/generated/prisma/client"

const initialState: ActionState = {}

type PrescriptionWithItems = Prescription & { items: PrescriptionItem[] }

type DraftItem = {
  medicationName: string
  genericName: string
  strength: string
  dose: string
  frequency: string
  route: string
  durationDays: string
  quantity: string
  instructions: string
}

const emptyItem: DraftItem = {
  medicationName: "",
  genericName: "",
  strength: "",
  dose: "",
  frequency: "",
  route: "oral",
  durationDays: "",
  quantity: "",
  instructions: "",
}

export function PrescriptionsSection({
  encounterId,
  prescriptions,
  canEdit,
}: {
  encounterId: string
  prescriptions: PrescriptionWithItems[]
  canEdit: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Prescriptions</CardTitle>
        {canEdit && <NewPrescriptionDialog encounterId={encounterId} />}
      </CardHeader>
      <CardContent className="grid gap-3">
        {prescriptions.length === 0 && <p className="text-sm text-muted-foreground">No prescriptions issued.</p>}
        {prescriptions.map((rx) => (
          <div key={rx.id} className="rounded-md border border-border p-3 text-sm">
            <div className="mb-2 flex items-center justify-between">
              <p className="font-medium">{rx.prescriptionNumber}</p>
              <div className="flex items-center gap-2">
                <Badge variant={rx.status === "active" ? "default" : "secondary"}>{rx.status}</Badge>
                <Button size="icon-sm" variant="ghost" asChild aria-label="Print">
                  <Link href={`/prescriptions/${rx.id}/print`} target="_blank">
                    <Printer className="size-3.5" />
                  </Link>
                </Button>
                {canEdit && rx.status === "active" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        await cancelPrescriptionAction(encounterId, rx.id)
                        router.refresh()
                      })
                    }
                  >
                    Cancel
                  </Button>
                )}
              </div>
            </div>
            <ul className="grid gap-1">
              {rx.items.map((item) => (
                <li key={item.id}>
                  {item.medicationName} {item.strength && `${item.strength} `}— {item.dose}, {item.frequency}, {item.route}
                  {item.durationDays ? ` for ${item.durationDays}d` : ""}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function NewPrescriptionDialog({ encounterId }: { encounterId: string }) {
  const { open, setOpen, state, pending, submit } = useActionDialog(createPrescriptionAction, initialState)
  const [items, setItems] = useState<DraftItem[]>([{ ...emptyItem }])

  function updateItem(index: number, field: keyof DraftItem, value: string) {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, [field]: value } : item)))
  }

  function handleSubmit(formData: FormData) {
    const payload = items
      .filter((item) => item.medicationName.trim())
      .map((item) => ({
        medicationName: item.medicationName,
        genericName: item.genericName || undefined,
        strength: item.strength || undefined,
        dose: item.dose,
        frequency: item.frequency,
        route: item.route,
        durationDays: item.durationDays ? Number(item.durationDays) : undefined,
        quantity: item.quantity ? Number(item.quantity) : undefined,
        instructions: item.instructions || undefined,
      }))
    formData.set("items", JSON.stringify(payload))
    submit(formData)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus /> New prescription
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New prescription</DialogTitle>
        </DialogHeader>
        <form action={handleSubmit} className="grid gap-4">
          <input type="hidden" name="encounterId" value={encounterId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}

          <div className="grid gap-4">
            {items.map((item, index) => (
              <div key={index} className="grid gap-2 rounded-md border border-border p-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-muted-foreground">Medication {index + 1}</p>
                  {items.length > 1 && (
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => setItems((prev) => prev.filter((_, i) => i !== index))}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <div className="grid gap-1">
                    <Label className="text-xs">Medication *</Label>
                    <Input value={item.medicationName} onChange={(e) => updateItem(index, "medicationName", e.target.value)} required />
                  </div>
                  <div className="grid gap-1">
                    <Label className="text-xs">Generic name</Label>
                    <Input value={item.genericName} onChange={(e) => updateItem(index, "genericName", e.target.value)} />
                  </div>
                  <div className="grid gap-1">
                    <Label className="text-xs">Strength</Label>
                    <Input value={item.strength} onChange={(e) => updateItem(index, "strength", e.target.value)} placeholder="500mg" />
                  </div>
                  <div className="grid gap-1">
                    <Label className="text-xs">Dose *</Label>
                    <Input value={item.dose} onChange={(e) => updateItem(index, "dose", e.target.value)} placeholder="1 tablet" required />
                  </div>
                  <div className="grid gap-1">
                    <Label className="text-xs">Frequency *</Label>
                    <Input value={item.frequency} onChange={(e) => updateItem(index, "frequency", e.target.value)} placeholder="Twice daily" required />
                  </div>
                  <div className="grid gap-1">
                    <Label className="text-xs">Route *</Label>
                    <Input value={item.route} onChange={(e) => updateItem(index, "route", e.target.value)} required />
                  </div>
                  <div className="grid gap-1">
                    <Label className="text-xs">Duration (days)</Label>
                    <Input type="number" value={item.durationDays} onChange={(e) => updateItem(index, "durationDays", e.target.value)} />
                  </div>
                  <div className="grid gap-1">
                    <Label className="text-xs">Quantity</Label>
                    <Input type="number" value={item.quantity} onChange={(e) => updateItem(index, "quantity", e.target.value)} />
                  </div>
                  <div className="col-span-2 grid gap-1 sm:col-span-3">
                    <Label className="text-xs">Instructions</Label>
                    <Input value={item.instructions} onChange={(e) => updateItem(index, "instructions", e.target.value)} />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <Button type="button" variant="outline" size="sm" onClick={() => setItems((prev) => [...prev, { ...emptyItem }])}>
            <Plus /> Add another medication
          </Button>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Issue prescription"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
