"use client"

import { useState } from "react"
import { Plus, UserRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { PatientPicker } from "@/components/domain/patient-picker"
import { AvailableSlotsPicker } from "@/components/domain/available-slots-picker"
import { bookAppointmentAction, type ActionState } from "@/app/(dashboard)/appointments/actions"

const initialState: ActionState = {}

type Option = { id: string; name: string }

/** Local YYYY-MM-DDTHH:mm, rounded up to the next 5 minutes — used to prefill
 * "now" for the walk-in flow (P3.1 §9). Matches available-slots-picker.tsx's
 * own local-time formatting convention. */
function nowRoundedLocal(): string {
  const d = new Date()
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * P3.1 §9/§12/§13: the same booking flow used for a normally-scheduled
 * appointment also serves the walk-in flow — no separate model, per §9's
 * own instruction. `walkIn` only changes three things: the trigger
 * label/icon, `bookingSource` defaulting to `walk_in` instead of `staff`,
 * and `startTime` defaulting to "now" instead of blank — everything else
 * (patient search, provider/service selection, the real
 * schedule/leave/conflict-aware slot picker, server-side validation) is
 * identical, and a walk-in can still be booked for a specific later slot if
 * the receptionist picks one instead of keeping "now".
 */
export function NewAppointmentDialog({
  branches,
  providers,
  services,
  defaultBranchId,
  defaultPatientId,
  defaultPatientLabel,
  walkIn = false,
}: {
  branches: Option[]
  providers: { id: string; firstName: string; lastName: string; defaultAppointmentDurationMinutes: number }[]
  services: { id: string; name: string; durationMinutes: number }[]
  defaultBranchId?: string | null
  defaultPatientId?: string
  defaultPatientLabel?: string
  walkIn?: boolean
}) {
  const { open, setOpen, state, pending, submit } = useActionDialog(bookAppointmentAction, initialState)
  const [duration, setDuration] = useState(30)
  const [branchId, setBranchId] = useState(defaultBranchId ?? "")
  const [providerId, setProviderId] = useState("")
  // P4.9 §41 (carried from BACKLOG.md, noticed during P4.7A.1): both selects
  // were previously uncontrolled — only branchId had a `value` prop — so a
  // rejected submission's `setState(result)` re-render visually cleared
  // Provider/Service back to their placeholders even though the underlying
  // form fields (and every plain Input) kept what the user entered. Made
  // controlled the same way branchId already was, plus serviceId now has
  // its own state at all (it previously had none).
  const [serviceId, setServiceId] = useState("")
  const [startTime, setStartTime] = useState(walkIn ? nowRoundedLocal() : "")

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant={walkIn ? "outline" : "default"}>
          {walkIn ? <UserRound /> : <Plus />}
          {walkIn ? "Walk-in" : "Book appointment"}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{walkIn ? "Register walk-in visit" : "Book appointment"}</DialogTitle>
          <DialogDescription>
            {walkIn
              ? "Creates a normal appointment for right now (or a slot you pick below) so the patient can move straight into the queue."
              : "Select a patient, provider, and time. Availability shown below is real — computed from the provider's schedule, approved leave, and existing appointments."}
          </DialogDescription>
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
            <Select name="branchId" required value={branchId || undefined} onValueChange={setBranchId}>
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
              value={providerId || undefined}
              onValueChange={(id) => {
                setProviderId(id)
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
              value={serviceId || undefined}
              onValueChange={(id) => {
                setServiceId(id)
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

          <AvailableSlotsPicker
            providerId={providerId}
            branchId={branchId}
            durationMinutes={duration}
            selectedValue={startTime}
            onPick={setStartTime}
          />

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="startTime">Date &amp; time</Label>
              <Input
                id="startTime"
                name="startTime"
                type="datetime-local"
                required
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
              />
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
            <Select name="bookingSource" defaultValue={walkIn ? "walk_in" : "staff"}>
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
              {pending ? "Booking..." : walkIn ? "Register visit" : "Book appointment"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
