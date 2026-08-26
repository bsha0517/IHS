"use client"

import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { createProviderAction, type ActionState } from "@/app/(dashboard)/providers/actions"

const initialState: ActionState = {}

const PROVIDER_TYPES = ["doctor", "dentist", "physiotherapist", "nurse", "therapist", "other"] as const

export function NewProviderDialog({
  branches,
  departments,
  users,
}: {
  branches: { id: string; name: string }[]
  departments: { id: string; name: string }[]
  users: { id: string; firstName: string; lastName: string; email: string }[]
}) {
  const { open, setOpen, state, pending, submit } = useActionDialog(createProviderAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus /> New provider
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New provider</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="firstName">First name</Label>
              <Input id="firstName" name="firstName" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="lastName">Last name</Label>
              <Input id="lastName" name="lastName" required />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="providerType">Type</Label>
            <Select name="providerType" required defaultValue="doctor">
              <SelectTrigger id="providerType" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="specialty">Specialty</Label>
              <Input id="specialty" name="specialty" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="qualification">Qualification</Label>
              <Input id="qualification" name="qualification" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="licenseNumber">License number</Label>
              <Input id="licenseNumber" name="licenseNumber" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="licenseAuthority">License authority</Label>
              <Input id="licenseAuthority" name="licenseAuthority" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="licenseExpiryDate">License expiry</Label>
              <Input id="licenseExpiryDate" name="licenseExpiryDate" type="date" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="consultationFee">Consultation fee</Label>
              <Input id="consultationFee" name="consultationFee" type="number" step="0.01" min="0" defaultValue="0" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="defaultAppointmentDurationMinutes">Default duration (min)</Label>
              <Input
                id="defaultAppointmentDurationMinutes"
                name="defaultAppointmentDurationMinutes"
                type="number"
                min="5"
                defaultValue="30"
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="userId">Linked login (optional)</Label>
              <Select name="userId">
                <SelectTrigger id="userId" className="w-full">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  {users.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.firstName} {u.lastName} ({u.email})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-2">
            <Label>Branches</Label>
            <div className="grid gap-2 rounded-md border border-border p-3">
              {branches.map((b) => (
                <label key={b.id} className="flex items-center gap-2 text-sm">
                  <Checkbox name="branchIds" value={b.id} />
                  {b.name}
                </label>
              ))}
            </div>
          </div>

          <div className="grid gap-2">
            <Label>Departments</Label>
            <div className="grid gap-2 rounded-md border border-border p-3">
              {departments.map((d) => (
                <label key={d.id} className="flex items-center gap-2 text-sm">
                  <Checkbox name="departmentIds" value={d.id} />
                  {d.name}
                </label>
              ))}
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating..." : "Create provider"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
