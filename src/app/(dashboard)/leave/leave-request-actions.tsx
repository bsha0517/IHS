"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { ReasonDialog } from "@/app/(dashboard)/invoices/[id]/reason-dialog"
import { approveLeaveAction, rejectLeaveAction } from "@/app/(dashboard)/leave/actions"

export function LeaveRequestActions({ leaveRequestId }: { leaveRequestId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  return (
    <div className="flex gap-2">
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            await approveLeaveAction(leaveRequestId)
            router.refresh()
          })
        }
      >
        Approve
      </Button>
      <ReasonDialog triggerLabel="Reject" title="Reject leave request" variant="destructive" action={rejectLeaveAction} args={[leaveRequestId]} />
    </div>
  )
}
