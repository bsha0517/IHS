"use client"

import { useState } from "react"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { PatientPicker } from "@/components/domain/patient-picker"
import { bookAppointmentAction, type ActionState } from "@/app/(dashboard)/appointments/actions"

const initialState: ActionState = {}

type Option = { id: string; name: string }

export function NewAppointmentDialog({
  branches,
  providers,
  services,
  defaultBranchId,
  defaultPatientId,
  defaultPatientLabel,
}: {
  branches: Option[]
  providers: { id: string; firstName: string; lastName: string; defaultAppointmentDurationMinutes: number }[]
  services: { id: string; name: string; durationMinutes: number }[]
  defaultBranchId?: string | null
  defaultPatientId?: string
  defaultPatientLabel?: string
}) {
  const { open, setOpen, state, pending, submit } = useActionDialog(bookAppointmentAction, initialState)
  const [duration, setDuration] = useState(30)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus /> Book appointment
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Book appointment</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}

          <div className="grid gap-2">
            <Label>Patient</Label>
            <PatientPicker
              name="patientId"
              defaultPatient={
                defaultPatientId && defaultPatientLabel
                  ? { id: defaultPatientId, mrn: "", firstName: defaultPatientLabel, lastName: "", mobile: "" }
                  : undefined
              }
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="branchId">Branch</Label>
            <Select name="branchId" required defaultValue={defaultBranchId ?? undefined}>
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
            <Label htmlFor="providerId">Provider</Label>
            <Select
              name="providerId"
              required
              onValueChange={(id) => {
                const provider = providers.find((p) => p.id === id)
                if (provider) setDuration(provider.defaultAppointmentDurationMinutes)
              }}
            >
              <SelectTrigger id="providerId" className="w-full">
                <SelectValue placeholder="Select a provider" />
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.firstName} {p.lastName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="serviceId">Service</Label>
            <Select
              name="serviceId"
              onValueChange={(id) => {
                const service = services.find((s) => s.id === id)
                if (service) setDuration(service.durationMinutes)
              }}
            >
              <SelectTrigger id="serviceId" className="w-full">
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                {services.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="startTime">Date &amp; time</Label>
              <Input id="startTime" name="startTime" type="datetime-local" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="durationMinutes">Duration (min)</Label>
              <Input
                id="durationMinutes"
                name="durationMinutes"
                type="number"
                min="5"
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
                required
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="bookingSource">Booking source</Label>
            <Select name="bookingSource" defaultValue="staff">
              <SelectTrigger id="bookingSource" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="staff">Staff</SelectItem>
                <SelectItem value="walk_in">Walk-in</SelectItem>
                <SelectItem value="phone">Phone</SelectItem>
                <SelectItem value="online">Online</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" name="notes" />
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Booking..." : "Book appointment"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
