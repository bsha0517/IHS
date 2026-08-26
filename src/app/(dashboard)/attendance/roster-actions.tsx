"use client"

import { useTransition, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { checkInSimpleAction, checkOutSimpleAction } from "@/app/(dashboard)/attendance/actions"

export function CheckInButton({ employeeId, branchId, shiftId }: { employeeId: string; branchId: string; shiftId: string | null }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="flex flex-col gap-1">
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null)
            try {
              await checkInSimpleAction(employeeId, branchId, shiftId)
              router.refresh()
            } catch (e) {
              setError(e instanceof Error ? e.message : "Failed to check in.")
            }
          })
        }
      >
        Check in
      </Button>
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
