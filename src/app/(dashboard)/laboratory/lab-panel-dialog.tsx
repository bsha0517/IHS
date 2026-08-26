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
import { createLabPanelAction, type ActionState } from "@/app/(dashboard)/laboratory/actions"

const initialState: ActionState = {}

export function LabPanelDialog({ tests }: { tests: { id: string; code: string; name: string }[] }) {
  const { open, setOpen, state, pending, submit } = useActionDialog(createLabPanelAction, initialState)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus /> New panel
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New lab panel</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="code">Code</Label>
              <Input id="code" name="code" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" required />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="price">Panel price</Label>
            <Input id="price" name="price" type="number" min="0" step="0.01" required />
          </div>
          <div className="grid gap-2">
            <Label className="text-xs">Member tests</Label>
            <div className="grid max-h-60 gap-2 overflow-y-auto rounded-md border border-border p-2">
              {tests.map((t) => (
                <label key={t.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={selected.has(t.id)}
                    onCheckedChange={() => {
                      toggle(t.id)
                    }}
                  />
                  {selected.has(t.id) && <input type="hidden" name="testIds" value={t.id} />}
                  {t.code} — {t.name}
                </label>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Create panel"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
