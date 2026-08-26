"use client"

import { useEffect, useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  fetchBranchesAction,
  fetchSpecialtiesAction,
  fetchProvidersAction,
  fetchServicesAction,
  fetchSlotsAction,
  submitBookingAction,
  type SubmitBookingState,
} from "@/app/book/actions"

type Branch = { id: string; name: string }
type Provider = { id: string; firstName: string; lastName: string; specialty: string | null }
type Service = { id: string; name: string; durationMinutes: number; price: number }

const STEPS = ["Branch", "Specialty", "Provider", "Service", "Date & Time", "Your Details", "Confirmation"] as const

export function BookingWizard() {
  const [step, setStep] = useState(0)
  const [pending, startTransition] = useTransition()

  const [branches, setBranches] = useState<Branch[]>([])
  const [branchId, setBranchId] = useState("")

  const [specialties, setSpecialties] = useState<string[]>([])
  const [specialty, setSpecialty] = useState<string | undefined>(undefined)

  const [providers, setProviders] = useState<Provider[]>([])
  const [providerId, setProviderId] = useState("")

  const [services, setServices] = useState<Service[]>([])
  const [serviceId, setServiceId] = useState("")

  const [date, setDate] = useState("")
  const [slots, setSlots] = useState<string[]>([])
  const [startTime, setStartTime] = useState("")

  const [submitState, setSubmitState] = useState<SubmitBookingState>({})

  useEffect(() => {
    startTransition(async () => setBranches(await fetchBranchesAction()))
  }, [])

  function selectBranch(id: string) {
    setBranchId(id)
    setSpecialty(undefined)
    setProviderId("")
    startTransition(async () => setSpecialties(await fetchSpecialtiesAction(id)))
    setStep(1)
  }

  function selectSpecialty(value: string | undefined) {
    setSpecialty(value)
    startTransition(async () => setProviders(await fetchProvidersAction(branchId, value)))
    setStep(2)
  }

  function selectProvider(id: string) {
    setProviderId(id)
    startTransition(async () => setServices(await fetchServicesAction(id)))
    setStep(3)
  }

  function selectService(id: string) {
    setServiceId(id)
    setStep(4)
  }

  const selectedService = services.find((s) => s.id === serviceId)

  function loadSlots(newDate: string) {
    setDate(newDate)
    setStartTime("")
    if (!newDate || !selectedService) return
    startTransition(async () => {
      const iso = await fetchSlotsAction(providerId, branchId, new Date(`${newDate}T00:00:00`).toISOString(), selectedService.durationMinutes)
      setSlots(iso)
    })
  }

  function handleSubmit(formData: FormData) {
    formData.set("branchId", branchId)
    formData.set("providerId", providerId)
    formData.set("serviceId", serviceId)
    formData.set("startTime", startTime)
    startTransition(async () => {
      const result = await submitBookingAction({}, formData)
      setSubmitState(result)
      if (result.success) setStep(6)
    })
  }

  const selectedBranch = branches.find((b) => b.id === branchId)
  const selectedProvider = providers.find((p) => p.id === providerId)

  return (
    <Card className="w-full max-w-lg">
      <CardContent className="grid gap-6 pt-6">
        <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
          {STEPS.map((label, i) => (
            <span key={label} className={i === step ? "font-medium text-foreground" : ""}>
              {label}
              {i < STEPS.length - 1 ? " → " : ""}
            </span>
          ))}
        </div>

        {step === 0 && (
          <div className="grid gap-3">
            <Label>Select a branch</Label>
            {branches.map((b) => (
              <Button key={b.id} variant="outline" className="justify-start" disabled={pending} onClick={() => selectBranch(b.id)}>
                {b.name}
              </Button>
            ))}
          </div>
        )}

        {step === 1 && (
          <div className="grid gap-3">
            <Label>Select a specialty (optional)</Label>
            <Button variant="outline" className="justify-start" disabled={pending} onClick={() => selectSpecialty(undefined)}>
              Any specialty
            </Button>
            {specialties.map((s) => (
              <Button key={s} variant="outline" className="justify-start" disabled={pending} onClick={() => selectSpecialty(s)}>
                {s}
              </Button>
            ))}
          </div>
        )}

        {step === 2 && (
          <div className="grid gap-3">
            <Label>Select a provider</Label>
            {providers.length === 0 && !pending && <p className="text-sm text-muted-foreground">No providers available.</p>}
            {providers.map((p) => (
              <Button key={p.id} variant="outline" className="justify-start" disabled={pending} onClick={() => selectProvider(p.id)}>
                {p.firstName} {p.lastName} {p.specialty ? `· ${p.specialty}` : ""}
              </Button>
            ))}
          </div>
        )}

        {step === 3 && (
          <div className="grid gap-3">
            <Label>Select a service</Label>
            {services.length === 0 && !pending && <p className="text-sm text-muted-foreground">No services available for this provider.</p>}
            {services.map((s) => (
              <Button key={s.id} variant="outline" className="justify-between" disabled={pending} onClick={() => selectService(s.id)}>
                <span>{s.name}</span>
                <span className="text-muted-foreground">{s.price.toFixed(2)}</span>
              </Button>
            ))}
          </div>
        )}

        {step === 4 && (
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="date">Select a date</Label>
              <Input id="date" type="date" value={date} min={new Date().toISOString().slice(0, 10)} onChange={(e) => loadSlots(e.target.value)} />
            </div>
            {date && (
              <div className="grid gap-2">
                <Label>Available times</Label>
                {pending && <p className="text-sm text-muted-foreground">Loading...</p>}
                {!pending && slots.length === 0 && <p className="text-sm text-muted-foreground">No available slots this day.</p>}
                <div className="flex flex-wrap gap-2">
                  {slots.map((iso) => (
                    <Button
                      key={iso}
                      size="sm"
                      variant={startTime === iso ? "default" : "outline"}
                      onClick={() => setStartTime(iso)}
                    >
                      {new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            <Button disabled={!startTime} onClick={() => setStep(5)}>
              Continue
            </Button>
          </div>
        )}

        {step === 5 && (
          <form action={handleSubmit} className="grid gap-4">
            {submitState.error && (
              <Alert variant="destructive">
                <AlertDescription>{submitState.error}</AlertDescription>
              </Alert>
            )}
            <div className="grid gap-1 rounded-md border border-border p-3 text-sm text-muted-foreground">
              <p>{selectedBranch?.name}</p>
              <p>
                {selectedProvider?.firstName} {selectedProvider?.lastName}
                {specialty ? ` (${specialty})` : ""} · {selectedService?.name}
              </p>
              <p>{new Date(startTime).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</p>
            </div>
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
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="dob">Date of birth</Label>
                <Input id="dob" name="dob" type="date" required />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="gender">Gender</Label>
                <Select name="gender" required>
                  <SelectTrigger id="gender" className="w-full">
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="male">Male</SelectItem>
                    <SelectItem value="female">Female</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="mobile">Mobile</Label>
                <Input id="mobile" name="mobile" required />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="email">Email (optional)</Label>
                <Input id="email" name="email" type="email" />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="notes">Notes (optional)</Label>
              <Input id="notes" name="notes" />
            </div>
            <Button type="submit" disabled={pending}>
              {pending ? "Booking..." : "Confirm booking"}
            </Button>
          </form>
        )}

        {step === 6 && submitState.success && (
          <div className="grid gap-2 text-center">
            <p className="text-lg font-medium">Booking confirmed</p>
            <p className="text-sm text-muted-foreground">Appointment {submitState.appointmentNumber} has been booked.</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
