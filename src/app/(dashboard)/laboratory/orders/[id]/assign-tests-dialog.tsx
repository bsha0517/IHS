"use client"

import { useState } from "react"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { assignTestsAction, type ActionState } from "@/app/(dashboard)/laboratory/actions"

const initialState: ActionState = {}

type Line = { kind: "test" | "panel"; id: string }

export function AssignTestsDialog({
  clinicalOrderId,
  tests,
  panels,
}: {
  clinicalOrderId: string
  tests: { id: string; code: string; name: string; price: number }[]
  panels: { id: string; code: string; name: string; price: number }[]
}) {
  const { open, setOpen, state, pending, submit } = useActionDialog(assignTestsAction, initialState)
  const [lines, setLines] = useState<Line[]>([])

  function toggle(kind: "test" | "panel", id: string) {
    setLines((prev) => {
      const exists = prev.some((l) => l.kind === kind && l.id === id)
      if (exists) return prev.filter((l) => !(l.kind === kind && l.id === id))
      return [...prev, { kind, id }]
    })
  }

  function isChecked(kind: "test" | "panel", id: string) {
    return lines.some((l) => l.kind === kind && l.id === id)
  }

  function handleSubmit(formData: FormData) {
    formData.set("lines", JSON.stringify(lines))
    submit(formData)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus /> Assign tests
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Assign tests</DialogTitle>
        </DialogHeader>
        <form action={handleSubmit} className="grid gap-4">
          <input type="hidden" name="clinicalOrderId" value={clinicalOrderId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="specimenType">Specimen type</Label>
            <Input id="specimenType" name="specimenType" placeholder="blood" required />
          </div>

          <div className="grid gap-2">
            <Label className="text-xs">Individual tests</Label>
            <div className="grid max-h-40 gap-2 overflow-y-auto rounded-md border border-border p-2">
              {tests.map((t) => (
                <label key={t.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex items-center gap-2">
                    <Checkbox checked={isChecked("test", t.id)} onCheckedChange={() => toggle("test", t.id)} />
                    {t.code} — {t.name}
                  </span>
                  <span className="text-muted-foreground">{t.price.toFixed(2)}</span>
                </label>
              ))}
            </div>
          </div>

          {panels.length > 0 && (
            <div className="grid gap-2">
              <Label className="text-xs">Panels</Label>
              <div className="grid max-h-40 gap-2 overflow-y-auto rounded-md border border-border p-2">
                {panels.map((p) => (
                  <label key={p.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="flex items-center gap-2">
                      <Checkbox checked={isChecked("panel", p.id)} onCheckedChange={() => toggle("panel", p.id)} />
                      {p.code} — {p.name}
                    </span>
                    <span className="text-muted-foreground">{p.price.toFixed(2)}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button type="submit" disabled={pending || lines.length === 0}>
              {pending ? "Assigning..." : "Assign & generate charges"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
