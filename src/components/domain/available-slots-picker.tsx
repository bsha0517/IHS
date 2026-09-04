"use client"

import { useEffect, useState, useTransition } from "react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { listAvailableSlotsAction } from "@/app/(dashboard)/appointments/actions"

/** Local YYYY-MM-DDTHH:mm — matches the `datetime-local` input's own value
 * format and this app's established "never derive a wall-clock value via
 * toISOString, which converts to UTC first" convention (see dates.ts's
 * `toDateParam`). The server returns real moments in time (ISO strings);
 * this renders them in the browser's local time, the same time the
 * provider's own working-hours schedule is expressed in. */
function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function todayDateValue(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

/**
 * P3.1 §12/§13: real, non-fake slot availability, presented as a click-to-fill
 * quick-pick — not a replacement for the actual date/time input this sits
 * next to. Clicking a slot fills that input; the field itself stays
 * editable, since the DB exclusion constraint (not this component) is what's
 * actually authoritative — a receptionist can still type an exact time this
 * picker didn't happen to offer (e.g., squeezing in an urgent case) and the
 * booking will simply succeed or fail on the real constraint either way.
 */
export function AvailableSlotsPicker({
  providerId,
  branchId,
  durationMinutes,
  selectedValue,
  onPick,
}: {
  providerId?: string
  branchId?: string
  durationMinutes: number
  /** Current datetime-local value of the field this picker fills, so the matching slot can render as selected. */
  selectedValue?: string
  onPick: (datetimeLocalValue: string) => void
}) {
  const [date, setDate] = useState(todayDateValue)
  const [slots, setSlots] = useState<string[]>([])
  const [loaded, setLoaded] = useState(false)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    // Nothing to fetch yet — the JSX below never renders the slots grid
    // without providerId/branchId anyway, so leaving any previously-loaded
    // `slots` in state here is harmless (never shown), and avoids calling
    // setState synchronously in the effect body itself.
    if (!providerId || !branchId || !date) return
    startTransition(async () => {
      const found = await listAvailableSlotsAction(providerId, branchId, `${date}T00:00:00`, durationMinutes)
      setSlots(found)
      setLoaded(true)
    })
  }, [providerId, branchId, date, durationMinutes])

  if (!providerId || !branchId) {
    return <p className="text-xs text-muted-foreground">Select a branch and provider to see real availability.</p>
  }

  return (
    <div className="grid gap-2">
      <Label htmlFor="slot-picker-date">Available slots</Label>
      <Input
        id="slot-picker-date"
        type="date"
        value={date}
        min={todayDateValue()}
        onChange={(e) => setDate(e.target.value)}
        className="w-full sm:w-48"
      />
      {pending && <p className="text-xs text-muted-foreground">Checking availability...</p>}
      {!pending && loaded && slots.length === 0 && (
        <p className="text-xs text-muted-foreground">No available slots for this provider on this day.</p>
      )}
      {!pending && slots.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Available appointment slots">
          {slots.map((iso) => {
            const local = toDatetimeLocalValue(new Date(iso))
            return (
              <Button
                key={iso}
                type="button"
                size="sm"
                variant={selectedValue === local ? "default" : "outline"}
                onClick={() => onPick(local)}
              >
                {new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
              </Button>
            )
          })}
        </div>
      )}
    </div>
  )
}
