"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { ReasonDialog } from "@/app/(dashboard)/invoices/[id]/reason-dialog"
import { approveLeaveAction, rejectLeaveAction } from "@/app/(dashboard)/leave/actions"

// P1 §25: a plain "Approve" first tries the entitlement-checked path; if it
// fails specifically because approving would exceed the employee's leave
// balance, this offers an explicit "Approve anyway" override rather than
// silently blocking or silently allowing it — the same "explicit
// authorization, not a blanket block" pattern Batch 4's over-receipt
// checkbox already established.
export function LeaveRequestActions({ leaveRequestId }: { leaveRequestId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [entitlementError, setEntitlementError] = useState<string | null>(null)

  function approve(allowOverride: boolean) {
    startTransition(async () => {
      const result = await approveLeaveAction(leaveRequestId, allowOverride)
      if (result?.error) {
        setEntitlementError(result.error)
        return
      }
      setEntitlementError(null)
      router.refresh()
    })
  }

  return (
    <div className="flex flex-col items-end gap-2">
      {entitlementError && (
        <Alert variant="destructive" className="max-w-xs text-xs">
          <AlertDescription>{entitlementError}</AlertDescription>
        </Alert>
      )}
      <div className="flex gap-2">
        {entitlementError ? (
          <Button size="sm" variant="destructive" disabled={pending} onClick={() => approve(true)}>
            Approve anyway
          </Button>
        ) : (
          <Button size="sm" disabled={pending} onClick={() => approve(false)}>
            Approve
          </Button>
        )}
        <ReasonDialog triggerLabel="Reject" title="Reject leave request" variant="destructive" action={rejectLeaveAction} args={[leaveRequestId]} />
      </div>
    </div>
  )
}
