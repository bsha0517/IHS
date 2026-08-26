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
import { createPackageAction, type ActionState } from "@/app/(dashboard)/packages/actions"

const initialState: ActionState = {}

type ServiceLine = { serviceId: string; sessionsAllocated: string }

export function NewPackageDialog({ services }: { services: { id: string; name: string }[] }) {
  const { open, setOpen, state, pending, submit } = useActionDialog(createPackageAction, initialState)
  const [lines, setLines] = useState<ServiceLine[]>([{ serviceId: "", sessionsAllocated: "1" }])

  function update(index: number, field: keyof ServiceLine, value: string) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, [field]: value } : l)))
  }

  function handleSubmit(formData: FormData) {
    formData.set(
      "services",
      JSON.stringify(
        lines.filter((l) => l.serviceId).map((l) => ({ serviceId: l.serviceId, sessionsAllocated: Number(l.sessionsAllocated) }))
      )
    )
    submit(formData)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus /> New package
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New package</DialogTitle>
        </DialogHeader>
        <form action={handleSubmit} className="grid gap-4">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid grid-cols-2 gap-3">
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
            <Label htmlFor="description">Description</Label>
            <Textarea id="description" name="description" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="price">Price</Label>
              <Input id="price" name="price" type="number" step="0.01" min="0" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="discountAmount">Discount</Label>
              <Input id="discountAmount" name="discountAmount" type="number" step="0.01" min="0" defaultValue="0" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="validityDays">Validity (days)</Label>
              <Input id="validityDays" name="validityDays" type="number" min="1" placeholder="No expiry" />
            </div>
          </div>

          <div className="grid gap-2">
            <Label className="text-xs">Included services</Label>
            {lines.map((line, index) => (
              <div key={index} className="grid grid-cols-[1fr_100px_auto] items-end gap-2">
                <Select value={line.serviceId} onValueChange={(v) => update(index, "serviceId", v)}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Service" />
                  </SelectTrigger>
                  <SelectContent>
                    {services.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  min="1"
                  placeholder="Sessions"
                  value={line.sessionsAllocated}
                  onChange={(e) => update(index, "sessionsAllocated", e.target.value)}
                />
                {lines.length > 1 && (
                  <Button type="button" size="icon-sm" variant="ghost" onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}>
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setLines((prev) => [...prev, { serviceId: "", sessionsAllocated: "1" }])}
            >
              <Plus /> Add service
            </Button>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating..." : "Create package"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
