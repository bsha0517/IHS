"use client"

import { useTransition, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { checkInSimpleAction, checkOutSimpleAction } from "@/app/(dashboard)/attendance/actions"

/**
 * P3.10 §16: this used to always pass `shifts[0]?.id` — the alphabetically
 * first configured shift, regardless of which shift the employee is
 * actually working — silently mis-assigning every check-in once a second
 * shift existed, which then corrupted checkOut's late/overtime calculation
 * (computed against the WRONG shift's start/end times). With one shift
 * configured this happened to look correct by coincidence; with two or
 * more it was simply wrong. Now: a single shift still auto-assigns (no
 * pointless picker for the common case); two or more shows a real
 * selector, defaulting to unselected so a missed choice can't silently
 * pick the wrong one.
 */
export function CheckInButton({ employeeId, branchId, shifts }: { employeeId: string; branchId: string; shifts: { id: string; name: string }[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [shiftId, setShiftId] = useState<string>(shifts.length === 1 ? shifts[0].id : "")

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {shifts.length > 1 && (
          <Select value={shiftId} onValueChange={setShiftId}>
            <SelectTrigger className="h-8 w-32">
              <SelectValue placeholder="Shift" />
            </SelectTrigger>
            <SelectContent>
              {shifts.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setError(null)
              try {
                await checkInSimpleAction(employeeId, branchId, shiftId || null)
                router.refresh()
              } catch (e) {
                setError(e instanceof Error ? e.message : "Failed to check in.")
              }
            })
          }
        >
          Check in
        </Button>
      </div>
      {error && (
        <Alert variant="destructive" className="py-1">
          <AlertDescription className="text-xs">{error}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}

export function CheckOutButton({ attendanceRecordId }: { attendanceRecordId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="flex flex-col gap-1">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null)
            try {
              await checkOutSimpleAction(attendanceRecordId)
              router.refresh()
            } catch (e) {
              setError(e instanceof Error ? e.message : "Failed to check out.")
            }
          })
        }
      >
        Check out
      </Button>
      {error && (
        <Alert variant="destructive" className="py-1">
          <AlertDescription className="text-xs">{error}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
