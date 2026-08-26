"use client"

import { Plus, Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { createServiceAction, updateServiceAction, type ActionState } from "@/app/(dashboard)/services/actions"

const initialState: ActionState = {}

type Option = { id: string; name: string }

type ExistingService = {
  id: string
  code: string
  name: string
  category: string
  departmentId: string | null
  description: string | null
  durationMinutes: number
  price: number
  billable: boolean
  isActive: boolean
  requiredRoomType: string | null
  providers: { providerId: string }[]
}

export function ServiceDialog({
  departments,
  providers,
  existing,
}: {
  departments: Option[]
  providers: { id: string; firstName: string; lastName: string }[]
  existing?: ExistingService
}) {
  const action = existing ? updateServiceAction : createServiceAction
  const { open, setOpen, state, pending, submit } = useActionDialog(action, initialState)
  const providerIds = new Set(existing?.providers.map((p) => p.providerId) ?? [])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {existing ? (
          <Button size="icon-sm" variant="ghost" aria-label="Edit">
            <Pencil className="size-3.5" />
          </Button>
        ) : (
          <Button size="sm">
            <Plus /> New service
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit service" : "New service"}</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          {existing && <input type="hidden" name="serviceId" value={existing.id} />}
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="code">Code</Label>
              <Input id="code" name="code" defaultValue={existing?.code} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="category">Category</Label>
              <Input id="category" name="category" defaultValue={existing?.category} required />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" defaultValue={existing?.name} required />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="description">Description</Label>
            <Textarea id="description" name="description" defaultValue={existing?.description ?? ""} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="durationMinutes">Duration (min)</Label>
              <Input
                id="durationMinutes"
                name="durationMinutes"
                type="number"
                min="1"
                defaultValue={existing?.durationMinutes ?? 30}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="price">Price</Label>
              <Input
                id="price"
                name="price"
                type="number"
                step="0.01"
                min="0"
                defaultValue={existing ? existing.price : 0}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="departmentId">Department</Label>
              <Select name="departmentId" defaultValue={existing?.departmentId ?? undefined}>
                <SelectTrigger id="departmentId" className="w-full">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  {departments.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="requiredRoomType">Required room type</Label>
              <Input id="requiredRoomType" name="requiredRoomType" defaultValue={existing?.requiredRoomType ?? ""} />
            </div>
          </div>

          <div className="flex gap-6">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox name="billable" defaultChecked={existing?.billable ?? true} /> Billable
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox name="isActive" defaultChecked={existing?.isActive ?? true} /> Active
            </label>
          </div>

          <div className="grid gap-2">
            <Label>Eligible providers</Label>
            <div className="grid gap-2 rounded-md border border-border p-3">
              {providers.map((p) => (
                <label key={p.id} className="flex items-center gap-2 text-sm">
                  <Checkbox name="providerIds" value={p.id} defaultChecked={providerIds.has(p.id)} />
                  {p.firstName} {p.lastName}
                </label>
              ))}
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : existing ? "Save changes" : "Create service"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
